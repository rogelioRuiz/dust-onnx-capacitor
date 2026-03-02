#!/usr/bin/env node

import { execSync } from 'child_process'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE_ID = 'io.t6x.onnx.test'
const RUNNER_PORT = 8099
const TOTAL_TESTS = 14
const TIMEOUT_MS = 120_000
const ADB = process.env.ADB_PATH || 'adb'
const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  'test',
  'fixtures',
  'tiny-test.onnx',
)

function adb(args) {
  const serial = process.env.ANDROID_SERIAL ? `-s ${process.env.ANDROID_SERIAL}` : ''
  return execSync(`${ADB} ${serial} ${args}`, { encoding: 'utf8', timeout: 60000 }).trim()
}

function getConnectedDevice() {
  const out = execSync(`${ADB} devices`, { encoding: 'utf8' }).trim()
  const lines = out.split('\n').slice(1).filter((line) => line.includes('\tdevice'))
  return lines[0] ? lines[0].split('\t')[0].trim() : null
}

function startResultServer() {
  const received = new Map()

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        try {
          const payload = JSON.parse(body)
          if (req.url === '/__onnx_result') {
            received.set(payload.id, payload)
            console.log(`[app] ${payload.id}: ${payload.status}${payload.error ? ` - ${payload.error}` : ''}`)
            res.writeHead(200)
            res.end('ok')
            return
          }
          if (req.url === '/__onnx_done') {
            res.writeHead(200)
            res.end('ok')
            server.close()
            resolve({ received, summary: payload })
            return
          }
        } catch (_) {
          // Fall through to the generic 400.
        }

        res.writeHead(400)
        res.end()
      })
    })

    server.listen(RUNNER_PORT, '0.0.0.0')
    server.on('error', reject)

    setTimeout(() => {
      server.close()
      reject(new Error(`Timed out after ${TIMEOUT_MS / 1000}s with ${received.size}/${TOTAL_TESTS} results`))
    }, TIMEOUT_MS)
  })
}

function maybeBuildAndLaunch() {
  const androidDir = path.join(__dirname, 'android')
  const gradlew = path.join(androidDir, 'gradlew')
  const apkPath = path.join(androidDir, 'app/build/outputs/apk/debug/app-debug.apk')

  if (!fs.existsSync(gradlew)) {
    console.log('No example/android project found. Waiting for a manually launched app.')
    return
  }

  execSync('./gradlew assembleDebug', {
    cwd: androidDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  })

  adb(`reverse tcp:${RUNNER_PORT} tcp:${RUNNER_PORT}`)

  // Push fixture files to device
  adb(`push "${FIXTURE_PATH}" /data/local/tmp/tiny-test.onnx`)
  adb(`shell "echo -n 'not a valid onnx file' > /data/local/tmp/corrupt-test.onnx"`)

  try {
    adb(`uninstall ${BUNDLE_ID}`)
  } catch (_) {
    // Fresh install path.
  }
  adb(`install -r "${apkPath}"`)
  adb(`shell am start -n "${BUNDLE_ID}/.MainActivity"`)
}

async function main() {
  const device = getConnectedDevice()
  if (!device) {
    throw new Error('No Android device found')
  }
  process.env.ANDROID_SERIAL = device

  const allDonePromise = startResultServer()
  maybeBuildAndLaunch()
  const { received, summary } = await allDonePromise

  console.log(`Received ${received.size}/${TOTAL_TESTS} test results`)
  for (const id of [
    'load-valid',
    'load-missing',
    'load-corrupt',
    'wrong-format',
    'unload-clears-cache',
    'unload-unknown',
    'load-same-model-twice',
    'load-two-models',
    'run-float32',
    'shape-mismatch-rank',
    'shape-mismatch-dim',
    'dtype-mismatch',
    'output-filter',
    'inference-unloaded',
  ]) {
    const result = received.get(id)
    if (!result) {
      console.log(`FAIL ${id}: no result`)
      continue
    }
    console.log(`${result.status === 'pass' ? 'PASS' : 'FAIL'} ${id}${result.error ? `: ${result.error}` : ''}`)
  }

  if (!summary || summary.failed > 0 || received.size !== TOTAL_TESTS) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
