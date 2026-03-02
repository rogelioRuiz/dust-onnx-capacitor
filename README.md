<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/branding/dust_white.png">
    <source media="(prefers-color-scheme: light)" srcset="../assets/branding/dust_black.png">
    <img alt="dust" src="../assets/branding/dust_black.png" width="200">
  </picture>
</p>

<p align="center">
  <strong>Device Unified Serving Toolkit</strong><br>
  <a href="https://github.com/rogelioRuiz/dust">dust ecosystem</a> · v0.1.0 · Apache 2.0
</p>

<p align="center">
  <a href="https://github.com/rogelioRuiz/dust/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/License-Apache_2.0-blue.svg"></a>
  <img alt="Version" src="https://img.shields.io/badge/version-0.1.0-informational">
  <img alt="npm" src="https://img.shields.io/badge/npm-dust--onnx--capacitor-cb3837">
  <img alt="Capacitor" src="https://img.shields.io/badge/Capacitor-7%20%7C%208-119EFF">
  <img alt="ONNX" src="https://img.shields.io/badge/ONNX_Runtime-1.20-005CED">
  <a href="https://github.com/rogelioRuiz/dust-onnx-capacitor/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/rogelioRuiz/dust-onnx-capacitor/actions/workflows/ci.yml/badge.svg?branch=main"></a>
</p>

---

<p align="center">
<strong>dust ecosystem</strong> —
<a href="../capacitor-core/README.md">capacitor-core</a> ·
<a href="../capacitor-llm/README.md">capacitor-llm</a> ·
<strong>capacitor-onnx</strong> ·
<a href="../capacitor-serve/README.md">capacitor-serve</a> ·
<a href="../capacitor-embeddings/README.md">capacitor-embeddings</a>
<br>
<a href="../dust-core-kotlin/README.md">dust-core-kotlin</a> ·
<a href="../dust-llm-kotlin/README.md">dust-llm-kotlin</a> ·
<a href="../dust-onnx-kotlin/README.md">dust-onnx-kotlin</a> ·
<a href="../dust-embeddings-kotlin/README.md">dust-embeddings-kotlin</a> ·
<a href="../dust-serve-kotlin/README.md">dust-serve-kotlin</a>
<br>
<a href="../dust-core-swift/README.md">dust-core-swift</a> ·
<a href="../dust-llm-swift/README.md">dust-llm-swift</a> ·
<a href="../dust-onnx-swift/README.md">dust-onnx-swift</a> ·
<a href="../dust-embeddings-swift/README.md">dust-embeddings-swift</a> ·
<a href="../dust-serve-swift/README.md">dust-serve-swift</a>
</p>

---

# capacitor-onnx

Capacitor plugin for on-device ONNX Runtime model loading, image preprocessing, and tensor inference over `.onnx` files.

**Stage O1+O2+O3+O4+O5+O6** — model lifecycle management (load, unload, list, metadata), validated tensor I/O and single inference, JPEG/PNG image preprocessing to normalized NCHW tensors, hardware-accelerated execution providers (CoreML on iOS, NNAPI/XNNPACK on Android) with automatic CPU fallback, DustCore registry integration with ref-counted session lifecycle, priority-based eviction, and OS memory pressure handling, and multi-step pipeline inference with output-to-input chaining.

| | Android | iOS | Web |
|---|---|---|---|
| **Runtime** | ONNX Runtime 1.20.0 | onnxruntime-objc ~1.20 | Stub (throws) |
| **Min version** | API 26 | iOS 16.0 | — |
| **Architecture** | arm64-v8a only | arm64 + x86_64 sim | — |

## Install

```bash
npm install dust-onnx-capacitor dust-core-capacitor
npx cap sync
```

`dust-core-capacitor` is a required peer dependency — it provides the shared ML contract types (`DustModelServer`, `DustModelSession`, `DustCoreError`, etc.) that capacitor-onnx implements.

### iOS (CocoaPods)

The iOS build uses CocoaPods for `onnxruntime-objc`. After `cap add ios`, update the Podfile:

```ruby
platform :ios, '16.0'
use_frameworks! :linkage => :static
```

Then run `pod install` inside `ios/App/`.

### Android

Add the Kotlin gradle plugin to `android/build.gradle`:

```groovy
classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.20'
```

Ensure `minSdkVersion` is at least `26` in `android/variables.gradle`.

## API

```typescript
import { ONNX } from 'capacitor-onnx';
```

### loadModel

```typescript
const result = await ONNX.loadModel({
  descriptor: {
    id: 'my-model',
    format: 'onnx',
    url: '/absolute/path/to/model.onnx',
  },
  config: {                          // optional
    accelerator: 'auto',             // 'auto' | 'cpu' | 'nnapi' | 'coreml' | 'xnnpack' | 'metal'
    threads: 4,                      // or { interOp: 2, intraOp: 4 }
    graphOptLevel: 'all',            // 'disable' | 'basic' | 'extended' | 'all'
    memoryPattern: true,
  },
  priority: 0,                      // 0 = interactive, 1 = background
});

// result.modelId   — string
// result.metadata  — { inputs: TensorMetadata[], outputs: TensorMetadata[], accelerator, opset? }
```

### unloadModel

```typescript
await ONNX.unloadModel({ modelId: 'my-model' });
```

### listLoadedModels

```typescript
const { modelIds } = await ONNX.listLoadedModels();
// modelIds: string[]
```

### getModelMetadata

```typescript
const metadata = await ONNX.getModelMetadata({ modelId: 'my-model' });
// metadata.inputs  — [{ name, dtype, shape }]
// metadata.outputs — [{ name, dtype, shape }]
```

### runInference

```typescript
const result = await ONNX.runInference({
  modelId: 'my-model',
  inputs: [
    { name: 'input_a', dtype: 'float32', shape: [1, 3], data: [1, 2, 3] },
    { name: 'input_b', dtype: 'float32', shape: [1, 3], data: [4, 5, 6] },
  ],
  outputNames: ['output'],         // optional — omit to return all outputs
});

// result.outputs — [{ name, dtype, shape, data }]
```

Input validation runs before inference:
- **Shape**: rank and static dimensions must match model metadata (`-1` dimensions are dynamic and accept any size)
- **Dtype**: input dtype must match the model's expected dtype

### runPipeline

```typescript
const { results } = await ONNX.runPipeline({
  modelId: 'my-model',
  steps: [
    {
      inputs: [
        { name: 'input', shape: [1, 3], dtype: 'float32', data: [1, 2, 3] },
      ],
    },
    {
      inputs: [
        { name: 'input', data: 'previous_output' },           // chain from step 0 output named 'input'
      ],
    },
    {
      inputs: [
        { name: 'input', data: { fromStep: 0, outputName: 'output' } },  // explicit step reference
      ],
      outputNames: ['output'],
    },
  ],
});

// results — [{ outputs: [...] }, { outputs: [...] }, { outputs: [...] }]
```

`runPipeline` executes multiple sequential inference steps on the same session within a single bridge call. This eliminates bridge round-trip overhead for multi-step workflows (e.g. PaddleOCR detection → recognition).

Step input types:
- **Literal** — `data: number[]` with `shape` and `dtype` — raw tensor data, same as `runInference`
- **`'previous_output'`** — `data: 'previous_output'` — substitutes the output tensor of the same `name` from the immediately preceding step
- **Step reference** — `data: { fromStep, outputName }` — substitutes a named output from any earlier step

Error behavior: if any step fails, the pipeline halts immediately. The error message includes the failing step index (e.g. `"Pipeline step 2 failed: ..."`).

Memory management: intermediate step results are released as soon as no future step references them.

### preprocessImage

```typescript
const { tensor } = await ONNX.preprocessImage({
  data: base64Image,              // base64 JPEG/PNG payload, no data: prefix
  width: 224,
  height: 224,
  config: {
    resize: 'letterbox',          // 'stretch' | 'letterbox' | 'crop_center'
    normalization: 'imagenet',    // 'imagenet' | 'minus1_plus1' | 'zero_to_1' | 'none'
    // mean: [0.5, 0.5, 0.5],     // optional custom mean overrides normalization preset
    // std: [0.5, 0.5, 0.5],      // optional custom std overrides normalization preset
  },
});

// tensor — { name: 'image', dtype: 'float32', shape: [1, 3, 224, 224], data: [...] }
```

`preprocessImage` decodes JPEG/PNG bytes, resizes to the requested output dimensions, and returns a channel-first tensor ready to pass into `runInference`.

Resize modes:
- `stretch` — scale directly to the target size
- `letterbox` — preserve aspect ratio and pad with RGB `(114, 114, 114)`
- `crop_center` — preserve aspect ratio, fill the target frame, and center-crop overflow

Normalization modes:
- `imagenet` — `(pixel / 255 - mean) / std` using ImageNet RGB statistics
- `minus1_plus1` — `pixel / 127.5 - 1`
- `zero_to_1` — `pixel / 255`
- `none` — raw `0...255` channel values

When `config.mean` and/or `config.std` are provided, the plugin applies `((pixel / 255) - mean) / std` using those custom values instead of a preset normalization mode.

### Accelerator selection

The `config.accelerator` field controls which ONNX Runtime execution provider (EP) is used:

| Value | Android | iOS |
|---|---|---|
| `'auto'` | NNAPI | CoreML |
| `'cpu'` | CPU | CPU |
| `'nnapi'` | NNAPI | CPU (fallback) |
| `'coreml'` | CPU (fallback) | CoreML |
| `'xnnpack'` | XNNPACK | CPU (fallback) |
| `'metal'` | CPU (fallback) | CPU (fallback) |

**Fallback behavior**: If the requested EP fails to initialize (e.g. NNAPI unavailable on emulator, CoreML unsupported model op), the plugin automatically retries with CPU-only options. The `metadata.accelerator` field in the result reflects the EP that was actually used.

**CoreML model cache** (iOS): When CoreML is selected, compiled `.mlmodel` files are cached in `Application Support/onnx-cache/{modelId}/`. ORT handles cache invalidation internally based on the model graph hash — subsequent loads of the same model skip recompilation.

### Error codes

| Code | When |
|---|---|
| `inferenceFailed` | File not found, corrupt model, ORT load/run failure |
| `formatUnsupported` | `descriptor.format` is not `'onnx'` |
| `modelNotFound` | `unloadModel` / `getModelMetadata` / `runInference` with unknown ID |
| `invalidInput` | Missing required fields |
| `shapeError` | `runInference` input shape does not match model metadata |
| `dtypeError` | `runInference` input dtype does not match model metadata |
| `preprocessError` | `preprocessImage` failed to decode or transform the image |

### Types

```typescript
type TensorDtype = 'float16' | 'float32' | 'float64' | 'int8' | 'int16' | 'int32' | 'int64' | 'uint8' | 'bool' | 'string' | 'unknown';

interface TensorMetadata {
  name: string;
  dtype: TensorDtype;
  shape: number[];
}

interface TensorValue {
  name: string;
  data: number[];
  shape: number[];
  dtype?: TensorDtype;   // defaults to 'float32'
}

interface InferenceTensorValue {
  name: string;
  data: number[];
  shape: number[];
  dtype: TensorDtype;    // always present in outputs
}

type ResizeMode = 'stretch' | 'letterbox' | 'crop_center';

type NormalizationMode = 'imagenet' | 'minus1_plus1' | 'zero_to_1' | 'none';

interface PreprocessConfig {
  resize?: ResizeMode;
  normalization?: NormalizationMode;
  mean?: [number, number, number];
  std?: [number, number, number];
}

interface PreprocessResult {
  tensor: InferenceTensorValue;
}

interface ONNXModelMetadata {
  inputs: TensorMetadata[];
  outputs: TensorMetadata[];
  accelerator: string;
  opset?: number;
}

interface TensorReference {
  fromStep: number;
  outputName: string;
}

interface PipelineStepInput {
  name: string;
  shape?: number[];
  dtype?: TensorDtype;
  data: number[] | 'previous_output' | TensorReference;
}

interface PipelineStep {
  inputs: PipelineStepInput[];
  outputNames?: string[];
}

interface RunPipelineResult {
  results: RunInferenceResult[];
}
```

## Architecture

```
┌──────────────────────────────────────────┐
│            TypeScript API                │
│  src/definitions.ts  src/plugin.ts       │
└─────────────┬────────────────────────────┘
              │ Capacitor bridge
   ┌──────────┴──────────┐
   ▼                     ▼
┌──────────────┐  ┌──────────────┐
│   Android    │  │     iOS      │
│  ONNXPlugin  │  │  ONNXPlugin  │
│      .kt     │  │    .swift    │
├──────────────┤  ├──────────────┤
│ONNXSession   │  │ONNXSession   │
│  Manager.kt  │  │  Manager     │
│              │  │    .swift    │
├──────────────┤  ├──────────────┤
│ Accelerator  │  │ Accelerator  │
│ Selector.kt  │  │ Selector     │
│ (NNAPI/      │  │    .swift    │
│  XNNPACK)    │  │ (CoreML)     │
├──────────────┤  ├──────────────┤
│ OrtSession   │  │ORTSession    │
│  Engine.kt   │  │  Engine      │
│  (ONNXEngine)│  │    .swift    │
├──────────────┤  ├──────────────┤
│ onnxruntime  │  │onnxruntime   │
│  -android    │  │   -objc      │
│   1.20.0     │  │   ~1.20      │
└──────────────┘  └──────────────┘
       │                 │
       └────────┬────────┘
                ▼
        dust-core-capacitor
    (shared ML contracts)
```

Both platforms use the same patterns:
- **Dedicated inference thread/queue** — Android: `HandlerThread`, iOS: `DispatchQueue`
- **Thread-safe session cache** — Android: `ReentrantLock`, iOS: `NSLock`
- **Reference counting** — loading the same model ID twice increments the ref count instead of creating a duplicate session
- **ONNXEngine seam** — `ONNXSession` delegates inference to an `ONNXEngine` protocol/interface; production uses `OrtSessionEngine` (real ORT), unit tests inject a `MockONNXEngine`
- **ImagePreprocessor seam** — JPEG/PNG decode, resize, normalization, and NCHW packing live in a pure `ImagePreprocessor` on each platform with no Capacitor or ORT dependency
- **Pre-inference validation** — shape rank/dimensions and dtype checked against model metadata before calling ORT
- **Pipeline execution** — `runPipeline` executes sequential inference steps within a single bridge call, resolving `previous_output` and `{ fromStep, outputName }` references between steps, with automatic release of intermediate tensors
- **AcceleratorSelector** — pure function/struct that maps `accelerator` config to execution provider options; self-contained try/catch fallback to CPU on EP failure
- **DustCore registry** — sessions are registered with `DustCoreRegistry` for cross-plugin discovery; `loadModel(descriptor:priority:)` flows through the shared `DustModelServer` protocol
- **Ref-counted session lifecycle** — `unloadModel` decrements refCount and keeps the session cached; `forceUnloadModel` removes it entirely; `evictUnderPressure` removes zero-ref sessions by priority (`.standard` = background only, `.critical` = all)
- **OS memory pressure** — iOS: `UIApplication.didReceiveMemoryWarningNotification` triggers `.critical` eviction; Android: `ComponentCallbacks2.onTrimMemory(RUNNING_CRITICAL)` and `onLowMemory()` trigger `.critical` eviction

## Project structure

```
capacitor-onnx/
├── src/                          # TypeScript definitions + web stub
│   ├── definitions.ts            # Public API types
│   ├── plugin.ts                 # Plugin registration
│   └── index.ts                  # Exports
├── android/
│   ├── src/main/.../onnx/        # Kotlin plugin implementation
│   │   ├── ONNXPlugin.kt         # Capacitor bridge methods
│   │   ├── ONNXSessionManager.kt # Session cache + lifecycle
│   │   ├── ONNXSession.kt        # Session + validation + TensorData
│   │   ├── ONNXEngine.kt         # Engine interface
│   │   ├── OrtSessionEngine.kt   # Production ORT wrapper
│   │   ├── ImagePreprocessor.kt  # Pure image preprocessing
│   │   ├── AcceleratorSelector.kt # EP selection (NNAPI/XNNPACK/CPU)
│   │   ├── ONNXConfig.kt         # Runtime config
│   │   └── ONNXError.kt          # Error types
│   └── src/test/.../onnx/        # JUnit unit tests
│       ├── ONNXSessionManagerTest.kt  # 9 O1 lifecycle tests
│       ├── ONNXInferenceTest.kt       # 9 O2 inference tests
│       ├── ONNXPreprocessTest.kt      # 8 O3 preprocessing tests
│       ├── ONNXAcceleratorTest.kt     # 9 O4 accelerator tests
│       ├── ONNXRegistryTest.kt        # 9 O5 registry/session lifecycle tests
│       └── ONNXPipelineTest.kt       # 7 O6 pipeline tests
├── ios/
│   ├── Sources/ONNXPlugin/       # Swift plugin implementation
│   │   ├── ONNXPlugin.swift
│   │   ├── ONNXSessionManager.swift
│   │   ├── ONNXSession.swift     # Session + validation + protobuf parser
│   │   ├── ONNXEngine.swift      # Engine protocol
│   │   ├── ORTSessionEngine.swift # Production ORT wrapper
│   │   ├── ImagePreprocessor.swift # Pure image preprocessing
│   │   ├── AcceleratorSelector.swift # EP selection (CoreML/CPU) + cache
│   │   ├── ONNXConfig.swift
│   │   └── ONNXError.swift
│   └── Tests/ONNXPluginTests/    # XCTest unit tests + fixtures
│       ├── ONNXSessionManagerTests.swift  # 9 O1 lifecycle tests
│       ├── ONNXInferenceTests.swift       # 9 O2 inference tests
│       ├── ONNXPreprocessTests.swift      # 8 O3 preprocessing tests
│       ├── ONNXAcceleratorTests.swift     # 9 O4 accelerator tests
│       ├── ONNXRegistryTests.swift        # 9 O5 registry/session lifecycle tests
│       └── ONNXPipelineTests.swift       # 7 O6 pipeline tests
├── example/                      # E2E test app
│   ├── www/index.html            # Test runner UI (14 tests)
│   ├── test-e2e-android.mjs      # Android E2E runner
│   ├── test-e2e-ios.mjs          # iOS E2E runner
│   └── capacitor.config.json
├── scripts/
│   └── generate-test-fixture.py  # Generates tiny-test.onnx
├── package.json
├── DustCapacitorOnnx.podspec
└── tsconfig.json
```

## Testing

### Test fixture

`ios/Tests/ONNXPluginTests/Fixtures/tiny-test.onnx` — a minimal ONNX model:
- **Op**: `Add(input_a, input_b) -> output`
- **Shapes**: `[1, 3]` float32 for all tensors
- **Opset**: 13, IR version 7

Regenerate with:

```bash
pip install onnx
python scripts/generate-test-fixture.py
```

### Unit tests (51 per platform)

All unit tests use mock engines or injected factories — no real ONNX Runtime required.

| ID | Test | What it verifies |
|---|---|---|
| O1-T1 | Load valid path | Session creation with factory |
| O1-T2 | Metadata access | Input/output tensor names |
| O1-T3 | Missing file | `fileNotFound` error |
| O1-T4 | Corrupt file | `loadFailed` error |
| O1-T5 | Wrong format | `formatUnsupported` rejection before load |
| O1-T6 | Unload model | Cache cleared, `listLoadedModels` empty |
| O1-T6b | Unload unknown ID | `modelNotFound` error |
| O1-T7 | Load same ID twice | Ref count incremented, single session |
| O1-T8 | Load two models | Both IDs appear in list |
| O2-T1 | Float32 inference | Returns typed output tensor |
| O2-T2 | Uint8 inference | Preserves non-float tensor dtype |
| O2-T3 | Shape mismatch rank | Rejects with `shapeError` |
| O2-T4 | Shape mismatch dim | Rejects with `shapeError` |
| O2-T5 | Dynamic dimension | Accepts `-1` metadata dims |
| O2-T6 | Dtype mismatch | Rejects with `dtypeError` |
| O2-T7 | Output filtering | Returns requested output subset |
| O2-T8 | Inference after unload | Maps to `modelNotFound` |
| O2-T9 | Engine failure | Maps to `inferenceFailed` |
| O3-T1 | Red image + ImageNet | Produces expected normalized RGB planes |
| O3-T2 | Letterbox resize | Preserves aspect ratio and centers content |
| O3-T3 | Upscale resize | Handles smaller source images safely |
| O3-T4 | `minus1_plus1` | Maps white pixels to `1.0` |
| O3-T5 | `zero_to_1` | Maps black pixels to `0.0` |
| O3-T6 | `none` | Preserves raw 0...255 channel values |
| O3-T7 | Invalid image data | Rejects with `preprocessError` |
| O3-T8 | Custom mean/std | Overrides preset normalization |
| O4-T1 | Auto accelerator | Config reaches factory / selects platform EP |
| O4-T2 | CPU accelerator | Metadata reflects `cpu` |
| O4-T3 | Platform EP explicit | CoreML (iOS) / NNAPI (Android) propagated |
| O4-T4 | Cached session reuse | Second load reuses session, not EP re-init |
| O4-T5 | Resolved accelerator | Metadata uses EP actually selected |
| O4-T6 | EP failure fallback | Falls back to CPU on EP init failure |
| O4-T7 | CPU loads without retry | Single factory call, no fallback path |
| O4-T8 | Both fail → LoadFailed | EP + CPU both fail → `loadFailed` error |
| O4-T9 | Metadata via lookup | `getModelMetadata` returns resolved accelerator |
| O5-T1 | Registry registration | Manager registered in DustCoreRegistry, resolvable |
| O5-T2 | Load ready descriptor | Session created via descriptor, refCount=1 |
| O5-T3 | Load notLoaded descriptor | Throws `modelNotReady` |
| O5-T4 | Load unregistered ID | Throws `modelNotFound` |
| O5-T5 | Unload keeps cached | refCount=0, session still in cache |
| O5-T6 | Load twice reuses | Same instance, refCount=2 |
| O5-T7 | Standard eviction | Background zero-ref removed, interactive kept |
| O5-T8 | Critical eviction | All zero-ref sessions removed |
| O5-T9 | allModelIds after evict | Only live session IDs returned |
| O6-T1 | Two-step pipeline | Both results returned, shapes correct, `callCount == 2` |
| O6-T2 | Previous output chaining | Step 2 input substituted from step 0 output |
| O6-T3 | Explicit fromStep chaining | `StepReference` routes correct tensor |
| O6-T4 | Step 0 failure | Pipeline halts, error contains "step 0" |
| O6-T5 | Step 1 failure | Pipeline halts, error contains "step 1" |
| O6-T6 | Single-step equivalence | Pipeline result matches direct `runInference` |
| O6-T7 | Pipeline on evicted session | `modelEvicted` thrown before any `run()` call |

```bash
# Android (from example/android/)
ANDROID_HOME=/path/to/sdk ./gradlew :capacitor-onnx:test

# iOS (from capacitor-onnx/, on macOS with simulator)
xcodebuild test -scheme DustCapacitorOnnx \
  -destination "platform=iOS Simulator,name=iPhone 16e" \
  -skipPackagePluginValidation
```

### E2E tests (14 plugin tests)

The E2E tests run 14 scenarios (8 O1 lifecycle + 6 O2 inference) on a real device/simulator with the actual ONNX Runtime. Both runners use an HTTP server on port 8099 to collect test results from the WebView.

The `run-float32` test verifies real inference: `input_a=[1,2,3] + input_b=[4,5,6]` produces `output=[5,7,9]`.

**Android** (physical device):

```bash
ADB_PATH=/path/to/adb ANDROID_SERIAL=<device-id> node example/test-e2e-android.mjs
```

The runner builds the APK, pushes fixtures to `/data/local/tmp/`, installs, and launches.

**iOS** (simulator):

```bash
# On macOS with booted simulator
node example/test-e2e-ios.mjs
```

The runner runs `cap sync`, builds with xcodebuild, installs on the booted simulator, copies fixtures to the app's private tmp directory, and injects `test-config.json` into the installed bundle.

**iOS fixture provisioning**: The app sandbox prevents accessing system `/tmp/`. The runner writes fixtures to the app's data container `tmp/` and injects a `test-config.json` into the installed bundle's `public/` directory (writable on simulator) so the WebView can `fetch()` it and discover the absolute path.

### Test results

| Suite | Count | Status |
|---|---|---|
| Android unit tests | 51 (9 O1 + 9 O2 + 8 O3 + 9 O4 + 9 O5 + 7 O6) | PASS |
| iOS unit tests | 51 (9 O1 + 9 O2 + 8 O3 + 9 O4 + 9 O5 + 7 O6) | PASS |
| Android E2E | 14 (8 O1 + 6 O2) | PASS |
| iOS E2E | 19 (5 setup + 14 plugin) | PASS |

## Development

```bash
# Build TypeScript
npm run build

# Lint
npm run lint

# Type check
npm run typecheck
```

## License

Copyright 2026 Rogelio Ruiz Perez. Licensed under the [Apache License 2.0](LICENSE).

---

<p align="center">
  Part of <a href="../README.md"><strong>dust</strong></a> — Device Unified Serving Toolkit
</p>
