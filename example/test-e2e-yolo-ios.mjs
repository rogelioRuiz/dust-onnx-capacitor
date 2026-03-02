#!/usr/bin/env node
/**
 * YOLO Object Detection E2E Test — iOS Simulator
 *
 * Protocol:
 *   1. This script starts an HTTP server on :8098
 *   2. The app's bootYoloE2E() polls GET /__yolo_task to receive {modelPath, imagePath}
 *   3. App runs loadModel → preprocessImage → runInference, then POSTs results to /__yolo_result
 *   4. Script prints a report and exits 0 (pass) / 1 (fail)
 */

import { execSync } from 'child_process'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── Config ───────────────────────────────────────────────────────────────────
const BUNDLE_ID      = 'io.t6x.onnx.test'
const RUNNER_PORT    = 8098
const TIMEOUT_MS     = 120_000
const MODEL_NAME     = 'yolo26s.onnx'
const IMAGE_NAME     = 'test_yolo.jpg'
const MIN_DETECTIONS = 1
const DEVICE_ID      = process.env.IOS_DEVICE_ID || 'booted'

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sim(cmd) {
  return execSync(`xcrun simctl ${cmd}`, { encoding: 'utf8' }).trim()
}

function resolveDataContainer() {
  return sim(`get_app_container ${DEVICE_ID} ${BUNDLE_ID} data`)
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
function startServer(task) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

      if (req.method === 'GET' && req.url === '/__yolo_task') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(task))
        return
      }

      if (req.method === 'POST' && req.url === '/__yolo_result') {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => {
          res.writeHead(200); res.end('ok')
          server.close()
          try { resolve(JSON.parse(body)) }
          catch (e) { reject(new Error('Bad JSON result: ' + body)) }
        })
        return
      }

      res.writeHead(404); res.end()
    })

    server.listen(RUNNER_PORT, '127.0.0.1', () => {
      console.log(`  Server:    http://127.0.0.1:${RUNNER_PORT}`)
    })
  })
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log('\n╔══════════════════════════════════════════════════════════════╗')
console.log('║        YOLO Object Detection — iOS Simulator E2E            ║')
console.log('╚══════════════════════════════════════════════════════════════╝\n')

const dataContainer = resolveDataContainer()
const docsDir       = path.join(dataContainer, 'Documents')
const modelPath     = path.join(docsDir, MODEL_NAME)
const imagePath     = path.join(docsDir, IMAGE_NAME)

console.log(`  Device:    ${DEVICE_ID}`)
console.log(`  Bundle:    ${BUNDLE_ID}`)
console.log(`  Docs:      ${docsDir}`)

if (!fs.existsSync(modelPath)) {
  console.error(`\n  ✗ Model not found: ${modelPath}`)
  process.exit(1)
}
if (!fs.existsSync(imagePath)) {
  console.error(`\n  ✗ Test image not found: ${imagePath}`)
  process.exit(1)
}
console.log(`  Model:     ✓ ${MODEL_NAME} (${(fs.statSync(modelPath).size / 1e6).toFixed(1)} MB)`)
console.log(`  Image:     ✓ ${IMAGE_NAME} (${(fs.statSync(imagePath).size / 1e3).toFixed(0)} KB)\n`)

const task = { modelPath, imagePath }

// Start server (serves the task + waits for result)
const resultPromise = startServer(task)

const timer = setTimeout(() => {
  console.error('\n  ✗ Timed out waiting for detection result')
  process.exit(1)
}, TIMEOUT_MS)

// Launch / foreground the app so bootYoloE2E() starts polling
try { sim(`launch ${DEVICE_ID} ${BUNDLE_ID}`) } catch (_) {}

console.log('  ⏳ Waiting for app to pick up task and run detection...\n')

let result
try {
  result = await resultPromise
} catch (e) {
  clearTimeout(timer)
  console.error('  ✗ ' + e.message)
  process.exit(1)
}
clearTimeout(timer)

// ─── Report ───────────────────────────────────────────────────────────────────
if (result.error) {
  console.error(`  ✗ Detection error: ${result.error}`)
  process.exit(1)
}

const COCO_CLASSES = [
  'person','bicycle','car','motorcycle','airplane','bus','train','truck','boat',
  'traffic light','fire hydrant','stop sign','parking meter','bench','bird','cat',
  'dog','horse','sheep','cow','elephant','bear','zebra','giraffe','backpack',
  'umbrella','handbag','tie','suitcase','frisbee','skis','snowboard','sports ball',
  'kite','baseball bat','baseball glove','skateboard','surfboard','tennis racket',
  'bottle','wine glass','cup','fork','knife','spoon','bowl','banana','apple',
  'sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake','chair',
  'couch','potted plant','bed','dining table','toilet','tv','laptop','mouse',
  'remote','keyboard','cell phone','microwave','oven','toaster','sink','refrigerator',
  'book','clock','vase','scissors','teddy bear','hair drier','toothbrush'
]

const { outputShape, detectionCount, inferenceMs, imageSize, detections } = result

console.log('╔══════════════════════════════════════════════════════════════╗')
console.log('║                     Detection Results                       ║')
console.log('╚══════════════════════════════════════════════════════════════╝\n')
console.log(`  Image size:      ${imageSize[0]} × ${imageSize[1]} px`)
console.log(`  Output shape:    [${outputShape.join(', ')}]`)
console.log(`  Inference time:  ${inferenceMs} ms`)
console.log(`  Detections:      ${detectionCount}\n`)

if (detections.length === 0) {
  console.log('  (no objects above threshold)')
} else {
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence)
  console.log('  Conf    Class             BBox')
  console.log('  ─────────────────────────────────────────────')
  for (const d of sorted) {
    const label = COCO_CLASSES[d.classId] || `class_${d.classId}`
    const pct   = (d.confidence * 100).toFixed(1).padStart(5)
    const box   = `[${d.x1},${d.y1} → ${d.x2},${d.y2}]`
    console.log(`  ${pct}%  ${label.padEnd(16)}  ${box}`)
  }
}

console.log()
const passed = detectionCount >= MIN_DETECTIONS && inferenceMs > 0
if (passed) {
  console.log(`  ✅ PASS — ${detectionCount} detection(s) in ${inferenceMs}ms`)
} else {
  console.log(`  ✗ FAIL — expected ≥${MIN_DETECTIONS} detection(s), got ${detectionCount}`)
}
console.log()
process.exit(passed ? 0 : 1)
