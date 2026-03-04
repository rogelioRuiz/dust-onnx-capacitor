#!/usr/bin/env node
/**
 * YOLO Object Detection E2E Test — iOS Simulator
 *
 * Protocol:
 *   1. This script copies the test image to the simulator
 *   2. Starts an HTTP server on :8098
 *   3. The app's bootYoloE2E() polls GET /__yolo_task to receive {imagePath}
 *   4. App downloads the YOLO model via dust-serve, runs inference, POSTs results
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
const TIMEOUT_MS     = 300_000   // allow time for first-run model download (~38 MB)
const IMAGE_NAME     = 'test_yolo.jpg'
const MIN_DETECTIONS = 1
const DEVICE_ID      = process.env.IOS_DEVICE_ID || (() => {
  try {
    const json = execSync('xcrun simctl list devices booted -j', { encoding: 'utf8' })
    const data = JSON.parse(json)
    for (const devices of Object.values(data.devices)) {
      for (const d of devices) {
        if (d.state === 'Booted') {
          try {
            execSync(`xcrun simctl get_app_container ${d.udid} ${BUNDLE_ID} data`, { encoding: 'utf8' })
            return d.udid
          } catch {}
        }
      }
    }
  } catch {}
  return 'booted'
})()

const IMAGE_PATH_LOCAL = path.join(__dirname, IMAGE_NAME)
const SCREENSHOT_LOCAL = path.join(__dirname, 'yolo-e2e-ios.png')

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sim(cmd) {
  return execSync(`xcrun simctl ${cmd}`, { encoding: 'utf8' }).trim()
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
    server.on('error', reject)
  })
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log('\n╔══════════════════════════════════════════════════════════════╗')
console.log('║        YOLO Object Detection — iOS Simulator E2E            ║')
console.log('╚══════════════════════════════════════════════════════════════╝\n')

if (!fs.existsSync(IMAGE_PATH_LOCAL)) {
  console.error(`\n  ✗ Test image not found: ${IMAGE_PATH_LOCAL}`)
  process.exit(1)
}

console.log(`  Device:    ${DEVICE_ID}`)
console.log(`  Bundle:    ${BUNDLE_ID}`)
console.log(`  Image:     ✓ ${IMAGE_NAME} (${(fs.statSync(IMAGE_PATH_LOCAL).size / 1e3).toFixed(0)} KB)`)
console.log(`  Model:     downloaded by app via dust-serve`)

// Verify app is installed
let dataContainer
try {
  dataContainer = sim(`get_app_container ${DEVICE_ID} ${BUNDLE_ID} data`)
} catch (_) {
  console.error(`\n  ✗ App not installed on simulator ${DEVICE_ID}`)
  console.error(`  → Run 'npm run test:ios' first to build and install the app.\n`)
  process.exit(1)
}
const docsDir = path.join(dataContainer, 'Documents')
fs.mkdirSync(docsDir, { recursive: true })

const imagePath = path.join(docsDir, IMAGE_NAME)
if (!fs.existsSync(imagePath)) {
  console.log('  → Copying image to simulator...')
  fs.copyFileSync(IMAGE_PATH_LOCAL, imagePath)
}
console.log(`  Docs:      ${docsDir}\n`)

const task = { imagePath }

// Start server (serves the task + waits for result)
const resultPromise = startServer(task)

const timer = setTimeout(() => {
  console.error('\n  ✗ Timed out waiting for detection result')
  process.exit(1)
}, TIMEOUT_MS)

// Launch / foreground the app so bootYoloE2E() starts polling
try { sim(`terminate ${DEVICE_ID} ${BUNDLE_ID}`) } catch (_) {}
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

// ─── Screenshot ──────────────────────────────────────────────────────────────
try {
  sim(`io ${DEVICE_ID} screenshot "${SCREENSHOT_LOCAL}"`)
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
