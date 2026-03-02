#!/usr/bin/env node
/**
 * YOLO Object Detection E2E Test — Android
 *
 * Protocol:
 *   1. This script pushes model + image to the device, then starts an HTTP server on :8098
 *   2. adb reverse forwards device port 8098 → host 8098
 *   3. The app's bootYoloE2E() polls GET /__yolo_task to receive {modelPath, imageUrl}
 *   4. App runs loadModel → preprocessImage → runInference, then POSTs results to /__yolo_result
 *   5. Script takes a screenshot, prints a report, and exits 0 (pass) / 1 (fail)
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
const TIMEOUT_MS     = 180_000
const MODEL_NAME     = 'yolo26s.onnx'
const IMAGE_NAME     = 'test_yolo.jpg'
const MIN_DETECTIONS = 1
const ADB            = process.env.ADB_PATH || 'adb'
const DEVICE_SERIAL  = process.env.ANDROID_SERIAL || ''

// Local paths — model is in the working directory (same as iOS), image is in example/
const MODEL_PATH_LOCAL = path.join(process.cwd(), MODEL_NAME)
const IMAGE_PATH_LOCAL = path.join(__dirname, IMAGE_NAME)

// Device paths
const DEVICE_MODEL_PATH = '/data/local/tmp/' + MODEL_NAME
const SCREENSHOT_DEVICE = '/sdcard/yolo-e2e-result.png'
const SCREENSHOT_LOCAL  = path.join(__dirname, 'yolo-e2e-android.png')

// ─── Helpers ──────────────────────────────────────────────────────────────────
function adb(args, opts = {}) {
  const serial = DEVICE_SERIAL ? `-s ${DEVICE_SERIAL}` : ''
  return execSync(`${ADB} ${serial} ${args}`, { encoding: 'utf8', timeout: 60000, ...opts }).trim()
}

function getConnectedDevice() {
  const out = execSync(`${ADB} devices`, { encoding: 'utf8' }).trim()
  const lines = out.split('\n').slice(1).filter(l => l.includes('\tdevice'))
  return lines[0] ? lines[0].split('\t')[0].trim() : null
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
function startServer(task, imageBuffer) {
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

      if (req.method === 'GET' && req.url === '/__yolo_image') {
        res.writeHead(200, { 'Content-Type': 'image/jpeg' })
        res.end(imageBuffer)
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

    server.listen(RUNNER_PORT, '0.0.0.0', () => {
      console.log(`  Server:    http://0.0.0.0:${RUNNER_PORT}`)
    })
    server.on('error', reject)
  })
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log('\n╔══════════════════════════════════════════════════════════════╗')
console.log('║       YOLO Object Detection — Android E2E                   ║')
console.log('╚══════════════════════════════════════════════════════════════╝\n')

// Verify device
const device = getConnectedDevice()
if (!device) {
  console.error('  ✗ No Android device found. Connect a device or start an emulator.')
  process.exit(1)
}
if (!DEVICE_SERIAL) process.env.ANDROID_SERIAL = device
console.log(`  Device:    ${device}`)
console.log(`  Bundle:    ${BUNDLE_ID}`)

// Verify local assets
if (!fs.existsSync(MODEL_PATH_LOCAL)) {
  console.error(`\n  ✗ Model not found: ${MODEL_PATH_LOCAL}`)
  console.error('    Run this script from the directory containing yolo26s.onnx')
  process.exit(1)
}
if (!fs.existsSync(IMAGE_PATH_LOCAL)) {
  console.error(`\n  ✗ Test image not found: ${IMAGE_PATH_LOCAL}`)
  process.exit(1)
}
console.log(`  Model:     ✓ ${MODEL_NAME} (${(fs.statSync(MODEL_PATH_LOCAL).size / 1e6).toFixed(1)} MB)`)
console.log(`  Image:     ✓ ${IMAGE_NAME} (${(fs.statSync(IMAGE_PATH_LOCAL).size / 1e3).toFixed(0)} KB)\n`)

// Push model to device (image is served by HTTP server, not pushed)
console.log('  Pushing model to device...')
adb(`push "${MODEL_PATH_LOCAL}" ${DEVICE_MODEL_PATH}`)
console.log(`  Model:     → ${DEVICE_MODEL_PATH}`)

// adb reverse so device can reach our HTTP server
adb(`reverse tcp:${RUNNER_PORT} tcp:${RUNNER_PORT}`)
console.log(`  Reverse:   tcp:${RUNNER_PORT} → tcp:${RUNNER_PORT}\n`)

// Task descriptor — image served directly by this script
const task = {
  modelPath: DEVICE_MODEL_PATH,
  imageUrl:  `http://127.0.0.1:${RUNNER_PORT}/__yolo_image`
}

const imageBuffer = fs.readFileSync(IMAGE_PATH_LOCAL)
const resultPromise = startServer(task, imageBuffer)

const timer = setTimeout(() => {
  console.error('\n  ✗ Timed out waiting for detection result')
  process.exit(1)
}, TIMEOUT_MS)

// Force-stop then launch fresh so bootYoloE2E() runs from startup
try { adb(`shell am force-stop ${BUNDLE_ID}`) } catch (_) {}
await new Promise(r => setTimeout(r, 500))
try { adb(`shell am start -n "${BUNDLE_ID}/.MainActivity"`) } catch (_) {}

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

// ─── Screenshot ───────────────────────────────────────────────────────────────
try {
  adb(`shell screencap -p ${SCREENSHOT_DEVICE}`)
  adb(`pull ${SCREENSHOT_DEVICE} "${SCREENSHOT_LOCAL}"`)
  adb(`shell rm ${SCREENSHOT_DEVICE}`)
  console.log(`  Screenshot: ${SCREENSHOT_LOCAL}\n`)
} catch (_) {}

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
