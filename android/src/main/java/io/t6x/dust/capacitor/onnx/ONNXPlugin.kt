package io.t6x.dust.capacitor.onnx

import android.content.ComponentCallbacks2
import android.content.res.Configuration
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import io.t6x.dust.onnx.ImagePreprocessor
import io.t6x.dust.onnx.MemoryPressureLevel
import io.t6x.dust.onnx.ONNXConfig
import io.t6x.dust.onnx.ONNXError
import io.t6x.dust.onnx.ONNXSession
import io.t6x.dust.onnx.ONNXSessionManager
import io.t6x.dust.onnx.PipelineInputValue
import io.t6x.dust.onnx.PipelineStep
import io.t6x.dust.onnx.TensorData
import io.t6x.dust.core.DustCoreError
import io.t6x.dust.core.ModelFormat
import io.t6x.dust.core.SessionPriority
import io.t6x.dust.capacitor.serve.ServePlugin
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.android.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

@CapacitorPlugin(name = "ONNX")
class ONNXPlugin : Plugin(), ComponentCallbacks2 {
    private val workerThread = HandlerThread("onnx-inference")
    private lateinit var handler: Handler
    private lateinit var dispatcher: CoroutineDispatcher
    private lateinit var scope: CoroutineScope
    private val sessionManager = ONNXSessionManager()

    override fun load() {
        workerThread.start()
        handler = Handler(workerThread.looper)
        dispatcher = handler.asCoroutineDispatcher()
        scope = CoroutineScope(dispatcher + SupervisorJob())
        (bridge.pluginManager.getPlugin("Serve")?.plugin as? ServePlugin)
            ?.setSessionFactory(sessionManager)
        bridge.context.registerComponentCallbacks(this)
    }

    override fun handleOnDestroy() {
        bridge.context.unregisterComponentCallbacks(this)
        super.handleOnDestroy()
        if (::scope.isInitialized) {
            scope.cancel()
        }
        workerThread.quitSafely()
    }

    @PluginMethod
    fun loadModel(call: PluginCall) {
        val descriptor = call.getObject("descriptor")
        val modelId = descriptor?.getString("id")
        val format = descriptor?.getString("format")

        if (modelId.isNullOrEmpty() || format.isNullOrEmpty()) {
            call.reject("descriptor.id and descriptor.format are required", "invalidInput")
            return
        }

        if (format != ModelFormat.ONNX.value) {
            call.reject("Only onnx models are supported", "formatUnsupported")
            return
        }

        val path = resolveModelPath(descriptor)
        if (path.isNullOrEmpty()) {
            call.reject("descriptor.url or descriptor.metadata.localPath is required", "invalidInput")
            return
        }

        val config = parseConfig(call.getObject("config"))
        val priority = SessionPriority.fromRawValue(call.getInt("priority") ?: SessionPriority.INTERACTIVE.rawValue)
            ?: SessionPriority.INTERACTIVE

        scope.launch {
            try {
                val session = sessionManager.loadModel(path, modelId, config, priority)
                val result = JSObject()
                result.put("modelId", session.sessionId)
                result.put("metadata", session.metadata.toJSONObject())
                call.resolve(result)
            } catch (error: DustCoreError) {
                call.reject(error.message ?: "Inference failed", error.code())
            } catch (error: ONNXError) {
                call.reject(error.message ?: "Inference failed", error.code())
            } catch (error: Throwable) {
                call.reject(error.message ?: "Unknown error", "unknownError")
            }
        }
    }

    @PluginMethod
    fun unloadModel(call: PluginCall) {
        val modelId = call.getString("modelId")
        if (modelId.isNullOrEmpty()) {
            call.reject("modelId is required", "invalidInput")
            return
        }

        scope.launch {
            try {
                sessionManager.forceUnloadModel(modelId)
                call.resolve()
            } catch (error: DustCoreError) {
                call.reject(error.message ?: "Failed to unload", error.code())
            } catch (error: Throwable) {
                call.reject(error.message ?: "Unknown error", "unknownError")
            }
        }
    }

    @PluginMethod
    fun listLoadedModels(call: PluginCall) {
        val result = org.json.JSONArray()
        for (modelId in sessionManager.allModelIds()) {
            result.put(modelId)
        }
        call.resolve(JSObject().put("modelIds", result))
    }

    @PluginMethod
    fun getModelMetadata(call: PluginCall) {
        val modelId = call.getString("modelId")
        if (modelId.isNullOrEmpty()) {
            call.reject("modelId is required", "invalidInput")
            return
        }

        val session = sessionManager.session(modelId)
        if (session == null) {
            call.reject("Model session not found", "modelNotFound")
            return
        }

        call.resolve(JSObject(session.metadata.toJSONObject().toString()))
    }

    @PluginMethod
    fun runInference(call: PluginCall) {
        val modelId = call.getString("modelId")
        if (modelId.isNullOrEmpty()) {
            call.reject("modelId is required", "invalidInput")
            return
        }

        val inputsArray = call.getArray("inputs")
        if (inputsArray == null) {
            call.reject("inputs is required", "invalidInput")
            return
        }

        val outputNames = parseStringArray(call.getArray("outputNames"))

        val parsedInputs = try {
            parseTensorInputs(inputsArray)
        } catch (error: DustCoreError) {
            call.reject(error.message ?: "Invalid input", error.code())
            return
        } catch (error: Throwable) {
            call.reject(error.message ?: "Invalid input", "invalidInput")
            return
        }

        scope.launch {
            val session = sessionManager.session(modelId)
            if (session == null) {
                call.reject("Model session not found", "modelNotFound")
                return@launch
            }

            try {
                val outputs = session.runInference(
                    parsedInputs.associateBy { it.name },
                    outputNames,
                )
                call.resolve(JSObject().put("outputs", serializeOutputs(outputs, outputNames, session)))
            } catch (error: DustCoreError) {
                call.reject(error.message ?: "Inference failed", error.code())
            } catch (error: ONNXError) {
                call.reject(error.message ?: "Inference failed", error.code())
            } catch (error: Throwable) {
                call.reject(error.message ?: "Unknown error", "unknownError")
            }
        }
    }

    @PluginMethod
    fun runPipeline(call: PluginCall) {
        val modelId = call.getString("modelId")
        if (modelId.isNullOrEmpty()) {
            call.reject("modelId is required", "invalidInput")
            return
        }

        val stepsArray = call.getArray("steps")
        if (stepsArray == null) {
            call.reject("steps is required", "invalidInput")
            return
        }

        val steps = try {
            parsePipelineSteps(stepsArray)
        } catch (error: DustCoreError) {
            call.reject(error.message ?: "Invalid input", error.code())
            return
        } catch (error: Throwable) {
            call.reject(error.message ?: "Invalid input", "invalidInput")
            return
        }

        scope.launch {
            val session = sessionManager.session(modelId)
            if (session == null) {
                call.reject("Model session not found", "modelNotFound")
                return@launch
            }

            try {
                val results = session.runPipeline(steps)
                val jsResults = JSArray()
                for ((stepIndex, outputs) in results.withIndex()) {
                    jsResults.put(
                        JSObject().put(
                            "outputs",
                            serializeOutputs(outputs, steps[stepIndex].outputNames, session),
                        ),
                    )
                }
                call.resolve(JSObject().put("results", jsResults))
            } catch (error: DustCoreError) {
                call.reject(error.message ?: "Inference failed", error.code())
            } catch (error: ONNXError) {
                call.reject(error.message ?: "Inference failed", error.code())
            } catch (error: Throwable) {
                call.reject(error.message ?: "Unknown error", "unknownError")
            }
        }
    }

    @PluginMethod
    fun preprocessImage(call: PluginCall) {
        val encodedData = call.getString("data")
        if (encodedData.isNullOrEmpty()) {
            call.reject("data is required", "invalidInput")
            return
        }

        val width = call.getInt("width")
        if (width == null || width <= 0) {
            call.reject("width must be a positive integer", "invalidInput")
            return
        }

        val height = call.getInt("height")
        if (height == null || height <= 0) {
            call.reject("height must be a positive integer", "invalidInput")
            return
        }

        val imageData = try {
            Base64.decode(encodedData, Base64.DEFAULT)
        } catch (_: IllegalArgumentException) {
            call.reject("data must be a valid base64 string", "invalidInput")
            return
        }

        val config = try {
            parsePreprocessConfig(call.getObject("config"))
        } catch (error: DustCoreError) {
            call.reject(error.message ?: "Invalid input", error.code())
            return
        } catch (error: Throwable) {
            call.reject(error.message ?: "Invalid input", "invalidInput")
            return
        }

        scope.launch {
            try {
                val tensor = ImagePreprocessor.preprocess(
                    imageData = imageData,
                    targetWidth = width,
                    targetHeight = height,
                    resize = config.resize,
                    normalization = config.normalization,
                    customMean = config.mean,
                    customStd = config.std,
                )
                call.resolve(JSObject().put("tensor", tensor.toJSONObject()))
            } catch (error: ONNXError) {
                call.reject(error.message ?: "Preprocessing failed", error.code())
            } catch (error: Throwable) {
                call.reject(error.message ?: "Preprocessing failed", "preprocessError")
            }
        }
    }

    private fun parseConfig(configObject: JSObject?): ONNXConfig {
        val defaultIntra = maxOf(1, Runtime.getRuntime().availableProcessors() - 1)
        val threadsValue = configObject?.opt("threads")
        val threadObject = configObject?.optJSONObject("threads")
        val threadCount = when (threadsValue) {
            is Number -> threadsValue.toInt()
            else -> null
        }

        return ONNXConfig(
            accelerator = configObject?.optString("accelerator", "auto") ?: "auto",
            interOpNumThreads = threadObject?.optInt("interOp") ?: threadCount ?: 1,
            intraOpNumThreads = threadObject?.optInt("intraOp") ?: threadCount ?: defaultIntra,
            graphOptimizationLevel = configObject?.optString("graphOptLevel")
                ?.takeIf { it.isNotEmpty() }
                ?: configObject?.optString("graphOptimizationLevel")
                    ?.takeIf { it.isNotEmpty() }
                ?: "all",
            enableMemoryPattern = when {
                configObject?.has("memoryPattern") == true -> configObject.optBoolean("memoryPattern")
                configObject?.has("enableMemoryPattern") == true -> configObject.optBoolean("enableMemoryPattern")
                else -> true
            },
        )
    }

    private fun resolveModelPath(descriptor: JSObject?): String? {
        val url = descriptor?.optString("url")?.takeIf { it.isNotEmpty() }
        if (url != null) {
            return url
        }

        val localPath = descriptor?.optJSONObject("metadata")
            ?.optString("localPath")
            ?.takeIf { it.isNotEmpty() }
        if (localPath != null) {
            return localPath
        }

        return null
    }

    private fun parseTensorInputs(array: JSArray): List<TensorData> {
        return List(array.length()) { index ->
            val item = array.optJSONObject(index)
                ?: throw DustCoreError.InvalidInput("inputs[$index] must be an object")

            val name = item.optString("name").takeIf { it.isNotEmpty() }
                ?: throw DustCoreError.InvalidInput("inputs[$index].name is required")
            val dtype = item.optString("dtype", "float32")
                .takeIf { it.isNotEmpty() }
                ?: "float32"

            val dataArray = item.optJSONArray("data")
                ?: throw DustCoreError.InvalidInput("inputs[$index].data must be a number[]")
            val shapeArray = item.optJSONArray("shape")
                ?: throw DustCoreError.InvalidInput("inputs[$index].shape must be a number[]")

            TensorData(
                name = name,
                dtype = dtype,
                shape = List(shapeArray.length()) { dimIndex -> shapeArray.optInt(dimIndex) },
                data = List(dataArray.length()) { valueIndex -> dataArray.optDouble(valueIndex) },
            )
        }
    }

    private fun parsePipelineSteps(array: JSArray): List<PipelineStep> {
        return List(array.length()) { stepIndex ->
            val item = array.optJSONObject(stepIndex)
                ?: throw DustCoreError.InvalidInput("steps[$stepIndex] must be an object")
            val inputsArray = item.optJSONArray("inputs")
                ?: throw DustCoreError.InvalidInput("steps[$stepIndex].inputs must be an array")

            PipelineStep(
                inputs = List(inputsArray.length()) { inputIndex ->
                    parsePipelineInput(
                        item = inputsArray.optJSONObject(inputIndex)
                            ?: throw DustCoreError.InvalidInput(
                                "steps[$stepIndex].inputs[$inputIndex] must be an object",
                            ),
                        stepIndex = stepIndex,
                        inputIndex = inputIndex,
                    )
                },
                outputNames = parseStringArray(item.optJSONArray("outputNames")),
            )
        }
    }

    private fun parsePipelineInput(
        item: org.json.JSONObject,
        stepIndex: Int,
        inputIndex: Int,
    ): PipelineInputValue {
        val prefix = "steps[$stepIndex].inputs[$inputIndex]"
        val name = item.optString("name").takeIf { it.isNotEmpty() }
            ?: throw DustCoreError.InvalidInput("$prefix.name is required")
        val dtype = item.optString("dtype", "float32")
            .takeIf { it.isNotEmpty() }
            ?: "float32"
        val dataValue = item.opt("data")
            ?: throw DustCoreError.InvalidInput("$prefix.data is required")

        return when (dataValue) {
            is String -> {
                if (dataValue != "previous_output") {
                    throw DustCoreError.InvalidInput(
                        "$prefix.data must be a number[], \"previous_output\", or { fromStep, outputName }",
                    )
                }
                PipelineInputValue.PreviousOutput(name)
            }
            is org.json.JSONObject -> {
                val fromStep = if (dataValue.has("fromStep")) dataValue.optInt("fromStep", Int.MIN_VALUE) else Int.MIN_VALUE
                val outputName = dataValue.optString("outputName").takeIf { it.isNotEmpty() }
                if (fromStep == Int.MIN_VALUE || outputName == null) {
                    throw DustCoreError.InvalidInput("$prefix.data must include fromStep and outputName")
                }
                PipelineInputValue.StepReference(name, fromStep, outputName)
            }
            is org.json.JSONArray -> {
                val shapeArray = item.optJSONArray("shape")
                    ?: throw DustCoreError.InvalidInput("$prefix.shape must be a number[] for literal inputs")
                PipelineInputValue.Literal(
                    TensorData(
                        name = name,
                        dtype = dtype,
                        shape = List(shapeArray.length()) { index -> shapeArray.optInt(index) },
                        data = List(dataValue.length()) { index -> dataValue.optDouble(index) },
                    ),
                )
            }
            else -> throw DustCoreError.InvalidInput(
                "$prefix.data must be a number[], \"previous_output\", or { fromStep, outputName }",
            )
        }
    }

    private fun parseStringArray(array: org.json.JSONArray?): List<String>? {
        if (array == null) {
            return null
        }

        return List(array.length()) { index -> array.optString(index) }
    }

    private fun parsePreprocessConfig(configObject: JSObject?): PreprocessConfigValue {
        val resize = configObject?.optString("resize")
            ?.takeIf { it.isNotEmpty() }
            ?.lowercase()
            ?: "stretch"
        val normalization = configObject?.optString("normalization")
            ?.takeIf { it.isNotEmpty() }
            ?.lowercase()
            ?: "imagenet"

        val validResizeModes = setOf("stretch", "letterbox", "crop_center")
        if (resize !in validResizeModes) {
            throw DustCoreError.InvalidInput("config.resize must be one of $validResizeModes")
        }

        val validNormalizationModes = setOf("imagenet", "minus1_plus1", "zero_to_1", "none")
        if (normalization !in validNormalizationModes) {
            throw DustCoreError.InvalidInput("config.normalization must be one of $validNormalizationModes")
        }

        return PreprocessConfigValue(
            resize = resize,
            normalization = normalization,
            mean = parseTriple(configObject?.optJSONArray("mean"), "config.mean"),
            std = parseTriple(configObject?.optJSONArray("std"), "config.std"),
        )
    }

    private fun parseTriple(array: org.json.JSONArray?, field: String): List<Double>? {
        if (array == null) {
            return null
        }

        if (array.length() != 3) {
            throw DustCoreError.InvalidInput("$field must be a [number, number, number]")
        }

        return List(3) { index ->
            val value = array.optDouble(index, Double.NaN)
            if (value.isNaN()) {
                throw DustCoreError.InvalidInput("$field must be a [number, number, number]")
            }
            value
        }
    }

    private fun serializeOutputs(
        outputs: Map<String, TensorData>,
        outputNames: List<String>?,
        session: ONNXSession,
    ): JSArray {
        val orderedOutputs = when {
            outputNames != null -> outputNames.mapNotNull { outputs[it] }
            else -> {
                val metadataOrdered = session.metadata.outputs.mapNotNull { outputs[it.name] }
                if (metadataOrdered.isNotEmpty()) metadataOrdered else outputs.values.toList()
            }
        }

        val jsOutputs = JSArray()
        for (tensor in orderedOutputs) {
            jsOutputs.put(tensor.toJSONObject())
        }
        return jsOutputs
    }

    @Suppress("DEPRECATION")
    override fun onTrimMemory(level: Int) {
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL) {
            scope.launch {
                sessionManager.evictUnderPressure(MemoryPressureLevel.CRITICAL)
            }
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {}

    @Deprecated("Required legacy fallback for Android low-memory callbacks")
    @Suppress("DEPRECATION")
    override fun onLowMemory() {
        scope.launch {
            sessionManager.evictUnderPressure(MemoryPressureLevel.CRITICAL)
        }
    }
}

private data class PreprocessConfigValue(
    val resize: String,
    val normalization: String,
    val mean: List<Double>?,
    val std: List<Double>?,
)

private fun DustCoreError.code(): String = when (this) {
    is DustCoreError.ModelNotFound -> "modelNotFound"
    is DustCoreError.ModelNotReady -> "modelNotReady"
    is DustCoreError.FormatUnsupported -> "formatUnsupported"
    is DustCoreError.SessionClosed -> "sessionClosed"
    is DustCoreError.InvalidInput -> "invalidInput"
    is DustCoreError.InferenceFailed -> "inferenceFailed"
    else -> "unknownError"
}
