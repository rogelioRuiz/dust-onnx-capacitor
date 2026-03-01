import { registerPlugin, WebPlugin } from '@capacitor/core'

import type {
  LoadModelResult,
  ONNXModelMetadata,
  ONNXPlugin,
  PipelineStep,
  PreprocessResult,
  RunPipelineResult,
  RunInferenceResult,
  TensorDtype,
} from './definitions'

class ONNXWeb extends WebPlugin implements ONNXPlugin {
  async loadModel(_options: { descriptor: unknown; config?: unknown; priority?: unknown }): Promise<LoadModelResult> {
    throw this.unimplemented('loadModel is not supported on web')
  }

  async unloadModel(_options: { modelId: string }): Promise<void> {
    throw this.unimplemented('unloadModel is not supported on web')
  }

  async listLoadedModels(): Promise<{ modelIds: string[] }> {
    throw this.unimplemented('listLoadedModels is not supported on web')
  }

  async getModelMetadata(_options: { modelId: string }): Promise<ONNXModelMetadata> {
    throw this.unimplemented('getModelMetadata is not supported on web')
  }

  async runInference(_options: {
    modelId: string
    inputs: { name: string; data: number[]; shape: number[]; dtype?: TensorDtype }[]
    outputNames?: string[]
  }): Promise<RunInferenceResult> {
    throw this.unimplemented('runInference is not supported on web')
  }

  async runPipeline(_options: {
    modelId: string
    steps: PipelineStep[]
  }): Promise<RunPipelineResult> {
    throw this.unimplemented('runPipeline is not supported on web')
  }

  async preprocessImage(_options: {
    data: string
    width: number
    height: number
    config?: unknown
  }): Promise<PreprocessResult> {
    throw this.unimplemented('preprocessImage is not supported on web')
  }
}

export const ONNX = registerPlugin<ONNXPlugin>('ONNX', {
  web: () => Promise.resolve(new ONNXWeb()),
})
