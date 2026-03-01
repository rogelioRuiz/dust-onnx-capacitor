import type { ModelDescriptor, SessionPriority } from '@dust/capacitor-core'

export type TensorDtype =
  | 'float16'
  | 'float32'
  | 'float64'
  | 'int8'
  | 'int16'
  | 'int32'
  | 'int64'
  | 'uint8'
  | 'bool'
  | 'string'
  | 'unknown'

export interface TensorMetadata {
  name: string
  shape: number[]
  dtype: TensorDtype
}

export type Accelerator = 'auto' | 'cpu' | 'nnapi' | 'coreml' | 'xnnpack' | 'metal'

export type GraphOptimizationLevel = 'disable' | 'basic' | 'extended' | 'all'

export interface ONNXModelMetadata {
  inputs: TensorMetadata[]
  outputs: TensorMetadata[]
  accelerator: Accelerator
  opset?: number
}

export interface ONNXConfig {
  accelerator?: Accelerator
  threads?: number | { interOp?: number; intraOp?: number }
  graphOptLevel?: GraphOptimizationLevel
  memoryPattern?: boolean
}

export interface LoadModelResult {
  modelId: string
  metadata: ONNXModelMetadata
}

export interface TensorValue {
  name: string
  data: number[]
  shape: number[]
  dtype?: TensorDtype
}

export interface InferenceTensorValue {
  name: string
  data: number[]
  shape: number[]
  dtype: TensorDtype
}

export type ResizeMode = 'stretch' | 'letterbox' | 'crop_center'

export type NormalizationMode = 'imagenet' | 'minus1_plus1' | 'zero_to_1' | 'none'

export interface PreprocessConfig {
  resize?: ResizeMode
  normalization?: NormalizationMode
  mean?: [number, number, number]
  std?: [number, number, number]
}

export interface PreprocessResult {
  tensor: InferenceTensorValue
}

export interface RunInferenceResult {
  outputs: InferenceTensorValue[]
}

export interface TensorReference {
  fromStep: number
  outputName: string
}

export interface PipelineStepInput {
  name: string
  shape?: number[]
  dtype?: TensorDtype
  data: number[] | 'previous_output' | TensorReference
}

export interface PipelineStep {
  inputs: PipelineStepInput[]
  outputNames?: string[]
}

export interface RunPipelineResult {
  results: RunInferenceResult[]
}

export interface ONNXPlugin {
  loadModel(options: {
    descriptor: ModelDescriptor
    config?: ONNXConfig
    priority?: SessionPriority
  }): Promise<LoadModelResult>
  unloadModel(options: { modelId: string }): Promise<void>
  listLoadedModels(): Promise<{ modelIds: string[] }>
  getModelMetadata(options: { modelId: string }): Promise<ONNXModelMetadata>
  runInference(options: {
    modelId: string
    inputs: TensorValue[]
    outputNames?: string[]
  }): Promise<RunInferenceResult>
  runPipeline(options: {
    modelId: string
    steps: PipelineStep[]
  }): Promise<RunPipelineResult>
  preprocessImage(options: {
    data: string
    width: number
    height: number
    config?: PreprocessConfig
  }): Promise<PreprocessResult>
}
