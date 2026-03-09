import Capacitor
import Foundation
import DustCore
@_exported import DustOnnx
#if canImport(ServePlugin)
import ServePlugin
#endif
#if canImport(UIKit)
import UIKit
#endif

@objc(ONNXPlugin)
public class ONNXPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ONNXPlugin"
    public let jsName = "ONNX"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "loadModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unloadModel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listLoadedModels", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getModelMetadata", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "runInference", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "runPipeline", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "preprocessImage", returnType: CAPPluginReturnPromise),
    ]

    private let sessionManager = ONNXSessionManager()

    public override func load() {
        super.load()
        #if canImport(ServePlugin)
        if let servePlugin = bridge?.plugin(withName: "Serve") as? ServePlugin {
            servePlugin.setSessionFactory(sessionManager, for: DustModelFormat.onnx.rawValue)
        }
        #endif
        #if canImport(UIKit)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleMemoryWarning),
            name: UIApplication.didReceiveMemoryWarningNotification,
            object: nil
        )
        #endif
    }

    @objc func loadModel(_ call: CAPPluginCall) {
        guard let descriptor = call.getObject("descriptor"),
              let modelId = descriptor["id"] as? String,
              let format = descriptor["format"] as? String else {
            call.reject("descriptor.id and descriptor.format are required", "invalidInput", nil)
            return
        }

        guard format == DustModelFormat.onnx.rawValue else {
            reject(call: call, for: ONNXError.formatUnsupported(format: format))
            return
        }

        guard let path = Self.resolveModelPath(from: descriptor) else {
            call.reject("descriptor.url or descriptor.metadata.localPath is required", "invalidInput", nil)
            return
        }

        let config = ONNXConfig(jsObject: call.getObject("config"))
        let priority = DustSessionPriority(rawValue: call.getInt("priority") ?? DustSessionPriority.interactive.rawValue)
            ?? .interactive

        ONNXSessionManager.inferenceQueue.async { [weak self] in
            guard let self else {
                call.reject("Plugin unavailable", "unknownError", nil)
                return
            }

            do {
                let session = try self.sessionManager.loadModel(
                    path: path,
                    modelId: modelId,
                    config: config,
                    priority: priority
                )
                call.resolve([
                    "modelId": session.sessionId,
                    "metadata": session.metadata.toJSObject(),
                ])
            } catch let error as DustCoreError {
                call.reject(Self.errorMessage(for: error), Self.errorCode(for: error), error)
            } catch let error as ONNXError {
                self.reject(call: call, for: error)
            } catch {
                call.reject(error.localizedDescription, "inferenceFailed", error)
            }
        }
    }

    @objc func unloadModel(_ call: CAPPluginCall) {
        guard let modelId = call.getString("modelId") else {
            call.reject("modelId is required", "invalidInput", nil)
            return
        }

        Task {
            do {
                try await sessionManager.forceUnloadModel(id: modelId)
                call.resolve()
            } catch let error as DustCoreError {
                call.reject(Self.errorMessage(for: error), Self.errorCode(for: error), error)
            } catch {
                call.reject(error.localizedDescription, "unknownError", error)
            }
        }
    }

    @objc func listLoadedModels(_ call: CAPPluginCall) {
        call.resolve([
            "modelIds": sessionManager.allModelIds(),
        ])
    }

    @objc func getModelMetadata(_ call: CAPPluginCall) {
        guard let modelId = call.getString("modelId") else {
            call.reject("modelId is required", "invalidInput", nil)
            return
        }

        guard let session = sessionManager.session(for: modelId) else {
            call.reject("Model session not found", "modelNotFound", nil)
            return
        }

        call.resolve(session.metadata.toJSObject())
    }

    @objc func runInference(_ call: CAPPluginCall) {
        guard let modelId = call.getString("modelId") else {
            call.reject("modelId is required", "invalidInput", nil)
            return
        }

        guard let inputObjects = call.getArray("inputs") as? [[String: Any]] else {
            call.reject("inputs is required", "invalidInput", nil)
            return
        }

        let outputNames = call.getArray("outputNames") as? [String]

        let parsedInputs: [TensorData]
        do {
            parsedInputs = try inputObjects.map { try Self.parseTensorData(from: $0) }
        } catch let error as DustCoreError {
            call.reject(Self.errorMessage(for: error), Self.errorCode(for: error), error)
            return
        } catch {
            call.reject(error.localizedDescription, "invalidInput", error)
            return
        }

        ONNXSessionManager.inferenceQueue.async { [weak self] in
            guard let self else {
                call.reject("Plugin unavailable", "unknownError", nil)
                return
            }

            guard let session = self.sessionManager.session(for: modelId) else {
                call.reject("Model session not found", "modelNotFound", nil)
                return
            }

            do {
                let outputs = try session.runInference(
                    inputs: Dictionary(uniqueKeysWithValues: parsedInputs.map { ($0.name, $0) }),
                    outputNames: outputNames
                )
                call.resolve([
                    "outputs": Self.serializeOutputs(outputs, outputNames: outputNames, session: session),
                ])
            } catch let error as DustCoreError {
                call.reject(Self.errorMessage(for: error), Self.errorCode(for: error), error)
            } catch let error as ONNXError {
                self.reject(call: call, for: error)
            } catch {
                call.reject(error.localizedDescription, "inferenceFailed", error)
            }
        }
    }

    @objc func runPipeline(_ call: CAPPluginCall) {
        guard let modelId = call.getString("modelId") else {
            call.reject("modelId is required", "invalidInput", nil)
            return
        }

        guard let stepObjects = call.getArray("steps") as? [[String: Any]] else {
            call.reject("steps is required", "invalidInput", nil)
            return
        }

        let steps: [PipelineStep]
        do {
            steps = try stepObjects.enumerated().map { stepIndex, object in
                try Self.parsePipelineStep(from: object, stepIndex: stepIndex)
            }
        } catch let error as DustCoreError {
            call.reject(Self.errorMessage(for: error), Self.errorCode(for: error), error)
            return
        } catch {
            call.reject(error.localizedDescription, "invalidInput", error)
            return
        }

        ONNXSessionManager.inferenceQueue.async { [weak self] in
            guard let self else {
                call.reject("Plugin unavailable", "unknownError", nil)
                return
            }

            guard let session = self.sessionManager.session(for: modelId) else {
                call.reject("Model session not found", "modelNotFound", nil)
                return
            }

            do {
                let results = try session.runPipeline(steps: steps)
                call.resolve([
                    "results": results.enumerated().map { stepIndex, outputs in
                        [
                            "outputs": Self.serializeOutputs(
                                outputs,
                                outputNames: steps[stepIndex].outputNames,
                                session: session
                            ),
                        ]
                    },
                ])
            } catch let error as DustCoreError {
                call.reject(Self.errorMessage(for: error), Self.errorCode(for: error), error)
            } catch let error as ONNXError {
                self.reject(call: call, for: error)
            } catch {
                call.reject(error.localizedDescription, "inferenceFailed", error)
            }
        }
    }

    @objc func preprocessImage(_ call: CAPPluginCall) {
        guard let encodedData = call.getString("data"), !encodedData.isEmpty else {
            call.reject("data is required", "invalidInput", nil)
            return
        }

        guard let width = call.getInt("width"), width > 0 else {
            call.reject("width must be a positive integer", "invalidInput", nil)
            return
        }

        guard let height = call.getInt("height"), height > 0 else {
            call.reject("height must be a positive integer", "invalidInput", nil)
            return
        }

        guard let imageData = Data(base64Encoded: encodedData) else {
            call.reject("data must be a valid base64 string", "invalidInput", nil)
            return
        }

        let options: ParsedPreprocessOptions
        do {
            options = try Self.parsePreprocessOptions(from: call.getObject("config"))
        } catch let error as DustCoreError {
            call.reject(Self.errorMessage(for: error), Self.errorCode(for: error), error)
            return
        } catch {
            call.reject(error.localizedDescription, "invalidInput", error)
            return
        }

        ONNXSessionManager.inferenceQueue.async { [weak self] in
            guard let self else {
                call.reject("Plugin unavailable", "unknownError", nil)
                return
            }

            do {
                let tensor = try ImagePreprocessor.preprocess(
                    imageData: imageData,
                    targetWidth: width,
                    targetHeight: height,
                    resize: options.resize,
                    normalization: options.normalization,
                    customMean: options.mean,
                    customStd: options.std
                )
                call.resolve([
                    "tensor": tensor.toJSObject(),
                ])
            } catch let error as ONNXError {
                self.reject(call: call, for: error)
            } catch {
                call.reject(error.localizedDescription, "preprocessError", error)
            }
        }
    }

    private func reject(call: CAPPluginCall, for error: ONNXError) {
        call.reject(Self.errorMessage(for: error), Self.errorCode(for: error), error)
    }

    @objc private func handleMemoryWarning() {
        Task {
            await sessionManager.evictUnderPressure(level: .critical)
        }
    }

    private static func resolveModelPath(from descriptor: [String: Any]) -> String? {
        if let url = descriptor["url"] as? String, !url.isEmpty {
            return url
        }

        if let metadata = descriptor["metadata"] as? [String: Any],
           let localPath = metadata["localPath"] as? String,
           !localPath.isEmpty {
            return localPath
        }

        return nil
    }

    private static func errorCode(for error: ONNXError) -> String {
        switch error {
        case .formatUnsupported:
            return "formatUnsupported"
        case .sessionClosed:
            return "sessionClosed"
        case .modelEvicted:
            return "modelEvicted"
        case .shapeError:
            return "shapeError"
        case .dtypeError:
            return "dtypeError"
        case .preprocessError:
            return "preprocessError"
        case .fileNotFound, .loadFailed, .inferenceError:
            return "inferenceFailed"
        }
    }

    private static func errorMessage(for error: ONNXError) -> String {
        switch error {
        case .fileNotFound(let path):
            return "Model file not found: \(path)"
        case .loadFailed(let path, let detail):
            if let detail, !detail.isEmpty {
                return "Failed to load ONNX model at \(path): \(detail)"
            }
            return "Failed to load ONNX model at \(path)"
        case .formatUnsupported(let format):
            return "Unsupported model format: \(format)"
        case .sessionClosed:
            return "Model session is closed"
        case .modelEvicted:
            return "Model was evicted from memory"
        case .shapeError(let name, let expected, let got):
            return "Shape mismatch for \(name): expected \(expected), got \(got)"
        case .dtypeError(let name, let expected, let got):
            return "Dtype mismatch for \(name): expected \(expected), got \(got)"
        case .preprocessError(let detail):
            return "Preprocessing failed: \(detail)"
        case .inferenceError(let detail):
            return detail
        }
    }

    private static func errorCode(for error: DustCoreError) -> String {
        switch error {
        case .modelNotFound:
            return "modelNotFound"
        case .modelNotReady:
            return "modelNotReady"
        case .formatUnsupported:
            return "formatUnsupported"
        case .sessionClosed:
            return "sessionClosed"
        case .invalidInput:
            return "invalidInput"
        case .inferenceFailed:
            return "inferenceFailed"
        default:
            return "unknownError"
        }
    }

    private static func errorMessage(for error: DustCoreError) -> String {
        switch error {
        case .modelNotFound:
            return "Model session not found"
        case .modelNotReady:
            return "Model session is busy"
        case .sessionClosed:
            return "Model session is closed"
        case .formatUnsupported:
            return "Model format not supported"
        case .invalidInput(let detail):
            return detail ?? "Invalid input"
        case .inferenceFailed(let detail):
            return detail ?? "Inference failed"
        default:
            return "Unknown error"
        }
    }

    private static func parseTensorData(from object: [String: Any]) throws -> TensorData {
        guard let name = object["name"] as? String, !name.isEmpty else {
            throw DustCoreError.invalidInput(detail: "inputs[].name is required")
        }

        guard let dataValues = object["data"] as? [NSNumber] else {
            throw DustCoreError.invalidInput(detail: "inputs[].data must be a number[]")
        }

        guard let shapeValues = object["shape"] as? [NSNumber] else {
            throw DustCoreError.invalidInput(detail: "inputs[].shape must be a number[]")
        }

        let dtype = (object["dtype"] as? String)?.lowercased() ?? "float32"

        return TensorData(
            name: name,
            dtype: dtype,
            shape: shapeValues.map(\.intValue),
            data: dataValues.map(\.doubleValue)
        )
    }

    private static func parsePipelineStep(from object: [String: Any], stepIndex: Int) throws -> PipelineStep {
        guard let inputObjects = object["inputs"] as? [[String: Any]] else {
            throw DustCoreError.invalidInput(detail: "steps[\(stepIndex)].inputs must be an array")
        }

        return PipelineStep(
            inputs: try inputObjects.enumerated().map { inputIndex, inputObject in
                try parsePipelineInput(from: inputObject, stepIndex: stepIndex, inputIndex: inputIndex)
            },
            outputNames: object["outputNames"] as? [String]
        )
    }

    private static func parsePipelineInput(
        from object: [String: Any],
        stepIndex: Int,
        inputIndex: Int
    ) throws -> PipelineInputValue {
        let prefix = "steps[\(stepIndex)].inputs[\(inputIndex)]"

        guard let name = object["name"] as? String, !name.isEmpty else {
            throw DustCoreError.invalidInput(detail: "\(prefix).name is required")
        }

        let dtype = ((object["dtype"] as? String)?.lowercased()).flatMap { $0.isEmpty ? nil : $0 } ?? "float32"

        guard let data = object["data"] else {
            throw DustCoreError.invalidInput(detail: "\(prefix).data is required")
        }

        if let marker = data as? String {
            guard marker == "previous_output" else {
                throw DustCoreError.invalidInput(
                    detail: "\(prefix).data must be a number[], \"previous_output\", or { fromStep, outputName }"
                )
            }
            return .previousOutput(name: name)
        }

        if let reference = data as? [String: Any] {
            guard let fromStep = (reference["fromStep"] as? NSNumber)?.intValue,
                  let outputName = reference["outputName"] as? String,
                  !outputName.isEmpty else {
                throw DustCoreError.invalidInput(detail: "\(prefix).data must include fromStep and outputName")
            }
            return .stepReference(name: name, fromStep: fromStep, outputName: outputName)
        }

        if let dataValues = data as? [NSNumber] {
            guard let shapeValues = object["shape"] as? [NSNumber] else {
                throw DustCoreError.invalidInput(detail: "\(prefix).shape must be a number[] for literal inputs")
            }

            return .literal(
                TensorData(
                    name: name,
                    dtype: dtype,
                    shape: shapeValues.map(\.intValue),
                    data: dataValues.map(\.doubleValue)
                )
            )
        }

        throw DustCoreError.invalidInput(
            detail: "\(prefix).data must be a number[], \"previous_output\", or { fromStep, outputName }"
        )
    }

    private static func serializeOutputs(
        _ outputs: [String: TensorData],
        outputNames: [String]?,
        session: ONNXSession
    ) -> [[String: Any]] {
        let orderedOutputs: [TensorData]
        if let outputNames {
            orderedOutputs = outputNames.compactMap { outputs[$0] }
        } else {
            let metadataOrdered = session.metadata.outputs.compactMap { outputs[$0.name] }
            orderedOutputs = metadataOrdered.isEmpty ? Array(outputs.values) : metadataOrdered
        }

        return orderedOutputs.map { $0.toJSObject() }
    }

    private static func parsePreprocessOptions(from config: [String: Any]?) throws -> ParsedPreprocessOptions {
        let resize = (config?["resize"] as? String)?.lowercased() ?? "stretch"
        let normalization = (config?["normalization"] as? String)?.lowercased() ?? "imagenet"

        let validResizeModes = ["stretch", "letterbox", "crop_center"]
        guard validResizeModes.contains(resize) else {
            throw DustCoreError.invalidInput(detail: "config.resize must be one of \(validResizeModes)")
        }

        let validNormalizationModes = ["imagenet", "minus1_plus1", "zero_to_1", "none"]
        guard validNormalizationModes.contains(normalization) else {
            throw DustCoreError.invalidInput(detail: "config.normalization must be one of \(validNormalizationModes)")
        }

        return ParsedPreprocessOptions(
            resize: resize,
            normalization: normalization,
            mean: try parseTriple(config?["mean"], field: "config.mean"),
            std: try parseTriple(config?["std"], field: "config.std")
        )
    }

    private static func parseTriple(_ value: Any?, field: String) throws -> [Double]? {
        guard let value else {
            return nil
        }

        guard let rawValues = value as? [Any], rawValues.count == 3 else {
            throw DustCoreError.invalidInput(detail: "\(field) must be a [number, number, number]")
        }

        let parsedValues = rawValues.compactMap { ($0 as? NSNumber)?.doubleValue }
        guard parsedValues.count == 3 else {
            throw DustCoreError.invalidInput(detail: "\(field) must be a [number, number, number]")
        }

        return parsedValues
    }
}

private struct ParsedPreprocessOptions {
    let resize: String
    let normalization: String
    let mean: [Double]?
    let std: [Double]?
}
