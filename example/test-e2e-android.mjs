#!/usr/bin/env node
/**
 * capacitor-onnx Android E2E Test Suite
 *
 * Runs the 22-test in-app suite (8 serve lifecycle + 14 ONNX API)
 * on an Android device/emulator via HTTP result collection.
 *
 * Auto-setup: cap add android, gradle patches, cap sync, build,
 * fixture push, emulator auto-start.
 *
 * Prerequisites:
 *   - Android SDK with ADB (device/emulator auto-started if available)
 *
 * Usage:
 *   node test-e2e-android.mjs
 */

import { execSync, spawn } from 'child_process'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VERBOSE = process.argv.includes('--verbose')

// ─── Config ──────────────────────────────────────────────────────────────────
const BUNDLE_ID = 'io.t6x.onnx.test'
const RUNNER_PORT = 8099
const TOTAL_TESTS = 22
const TIMEOUT_MS = 120_000
const ADB = findAdbBinary()
const FIXTURE_PATH = path.join(__dirname, '..', 'test', 'fixtures', 'tiny-test.onnx')

// ─── Test runner state ───────────────────────────────────────────────────────
let passedTests = 0
let failedTests = 0
const testResults = []

function logSection(title) {
  console.log(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}`)
}

function pass(name, detail) {
  passedTests++
  testResults.push({ name, status: 'PASS' })
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
}

function fail(name, error) {
  failedTests++
  testResults.push({ name, status: 'FAIL', error })
  console.log(`  ❌ ${name} — ${error}`)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ─── Shell / ADB helpers ────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  const nodeBin = path.dirname(process.execPath)
  const result = execSync(cmd, {
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${nodeBin}:${process.env.PATH}` },
    ...opts,
  })
  return (result || '').trim()
}

function adb(args, opts = {}) {
  const serial = process.env.ANDROID_SERIAL ? `-s ${process.env.ANDROID_SERIAL}` : ''
  return run(`${ADB} ${serial} ${args}`, { timeout: 60_000, ...opts })
}

function getConnectedDevice() {
  const out = execSync(`${ADB} devices`, { encoding: 'utf8' }).trim()
  const lines = out.split('\n').slice(1).filter(l => l.includes('\tdevice'))
  if (lines.length === 0) return null
  return lines[0].split('\t')[0].trim()
}

function findAndroidSdkRoot() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(process.env.HOME, 'Library/Android/sdk'),   // macOS default
    path.join(process.env.HOME, 'Android/Sdk'),           // Linux default
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(path.join(p, 'platform-tools'))) return p
  }
  return null
}

function findAdbBinary() {
  if (process.env.ADB_PATH && fs.existsSync(process.env.ADB_PATH)) return process.env.ADB_PATH
  const sdk = findAndroidSdkRoot()
  if (sdk) {
    const p = path.join(sdk, 'platform-tools/adb')
    if (fs.existsSync(p)) return p
  }
  try { return execSync('which adb', { encoding: 'utf8' }).trim() } catch {}
  return 'adb'
}

function findEmulatorBinary() {
  const candidates = [
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'emulator/emulator'),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'emulator/emulator'),
    path.join(process.env.HOME, 'Library/Android/sdk/emulator/emulator'),
    path.join(process.env.HOME, 'Android/Sdk/emulator/emulator'),
  ].filter(Boolean)
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  try { return execSync('which emulator', { encoding: 'utf8' }).trim() } catch {}
  return null
}

function getAvailableAVDs(emulatorBin) {
  try {
    const out = execSync(`${emulatorBin} -list-avds`, { encoding: 'utf8' }).trim()
    return out.split('\n').filter(l => l.length > 0)
  } catch { return [] }
}

function bootEmulator(emulatorBin, avdName) {
  console.log(`  → Starting emulator (${avdName})...`)
  const child = spawn(emulatorBin, ['-avd', avdName, '-no-window', '-no-audio', '-no-boot-anim'], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  for (let i = 0; i < 60; i++) {
    execSync('sleep 2')
    const serial = getConnectedDevice()
    if (serial) {
      try {
        const bootComplete = execSync(`${ADB} -s ${serial} shell getprop sys.boot_completed 2>/dev/null`, { encoding: 'utf8' }).trim()
        if (bootComplete === '1') return serial
      } catch {}
    }
  }
  throw new Error('Emulator failed to boot within 120s')
}

function npx(args, opts = {}) {
  const npxPath = path.join(path.dirname(process.execPath), 'npx')
  return run(`${npxPath} ${args}`, opts)
}

// ─── Project setup (idempotent) ─────────────────────────────────────────────
function ensureAndroidProject() {
  const androidDir = path.join(__dirname, 'android')
  if (fs.existsSync(androidDir)) return
  console.log('  → cap add android...')
  npx('cap add android', { cwd: __dirname, stdio: VERBOSE ? [0, 1, 2] : ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
}

function patchAndroidBuildGradle() {
  const buildGradle = path.join(__dirname, 'android/build.gradle')
  if (!fs.existsSync(buildGradle)) return
  let content = fs.readFileSync(buildGradle, 'utf8')
  if (content.includes('kotlin-gradle-plugin')) return
  content = content.replace(
    /classpath 'com\.android\.tools\.build:gradle:[^']+'/,
    match => `${match}\n        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.0'`
  )
  fs.writeFileSync(buildGradle, content)
}

function patchMinSdkVersion() {
  const varsGradle = path.join(__dirname, 'android/variables.gradle')
  if (!fs.existsSync(varsGradle)) return
  let content = fs.readFileSync(varsGradle, 'utf8')
  content = content.replace(/minSdkVersion = \d+/, 'minSdkVersion = 26')
  fs.writeFileSync(varsGradle, content)
}

function patchAndroidManifest() {
  const manifest = path.join(__dirname, 'android/app/src/main/AndroidManifest.xml')
  if (!fs.existsSync(manifest)) return
  let content = fs.readFileSync(manifest, 'utf8')
  if (content.includes('usesCleartextTraffic')) return
  content = content.replace(
    '<application',
    '<application\n        android:usesCleartextTraffic="true"'
  )
  fs.writeFileSync(manifest, content)
}

// ─── HTTP result collector + fixture server ─────────────────────────────────
const FIXTURES_DIR = path.join(__dirname, '..', 'test', 'fixtures')

function startResultServer() {
  const received = new Map()

  const serverReady = new Promise((resolveServer, rejectServer) => {
    const allDonePromise = new Promise((resolveDone, rejectDone) => {
      const server = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

        if (req.method === 'OPTIONS') {
          res.writeHead(204)
          res.end()
          return
        }

        // Serve fixture files for dust-serve to download
        if (req.method === 'GET' && req.url.startsWith('/__fixture/')) {
          const fileName = req.url.slice('/__fixture/'.length)
          const filePath = path.join(FIXTURES_DIR, fileName)
          try {
            const data = fs.readFileSync(filePath)
            res.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Length': data.length,
            })
            res.end(data)
          } catch (_) {
            res.writeHead(404)
            res.end('not found')
          }
          return
        }

        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          try {
            const payload = JSON.parse(body)
            if (req.url === '/__onnx_result') {
              received.set(payload.id, payload)
              const icon = payload.status === 'pass' ? '✅' : '❌'
              console.log(`  [app] ${icon} ${payload.id}${payload.error ? ' — ' + payload.error : ''}`)
              res.writeHead(200)
              res.end('ok')
            } else if (req.url === '/__onnx_done') {
              res.writeHead(200)
              res.end('ok')
              server.close()
              resolveDone({ results: received, summary: payload })
            } else {
              res.writeHead(404)
              res.end()
            }
          } catch (_) {
            res.writeHead(400)
            res.end()
          }
        })
      })

      server.listen(RUNNER_PORT, '0.0.0.0', () => {
        resolveServer({ server, allDonePromise })
      })
      server.on('error', rejectServer)

      setTimeout(() => {
        server.close()
        rejectDone(new Error(`Timeout after ${TIMEOUT_MS / 1000}s — ${received.size}/${TOTAL_TESTS} results`))
      }, TIMEOUT_MS)
    })
  })

  return serverReady
}

// ─── Test name map ──────────────────────────────────────────────────────────
const TEST_NAMES = {
  // Phase 1: Serve lifecycle
  'S.1-register': 'registerModel() — succeeds',
  'S.2-list': 'listModels() — returns descriptor + status',
  'S.3-status': 'getModelStatus() — returns status.kind',
  'S.4-download': 'downloadModel() — starts and completes',
  'S.5-sizeDisclosure': 'sizeDisclosure — emits modelId + sizeBytes',
  'S.6-progress': 'modelProgress — emits download counters',
  'S.7-ready': 'modelReady — emits modelId + path',
  'S.8-readyStatus': 'getModelStatus() — after ready returns path',
  // Phase 2: ONNX API
  'O.1-load-valid': 'loadModel() — valid ONNX file returns metadata',
  'O.2-load-missing': 'loadModel() — missing file rejects inferenceFailed',
  'O.3-load-corrupt': 'loadModel() — corrupt file rejects inferenceFailed',
  'O.4-wrong-format': 'loadModel() — wrong format rejects formatUnsupported',
  'O.5-unload-clears': 'unloadModel() — clears session cache',
  'O.6-unload-unknown': 'unloadModel() — unknown ID rejects modelNotFound',
  'O.7-load-twice': 'loadModel() — same ID twice stores once',
  'O.8-load-two': 'loadModel() — two IDs both present',
  'O.9-inference': 'runInference() — float32 inputs produce [5, 7, 9]',
  'O.10-shape-rank': 'runInference() — wrong rank rejects shapeError',
  'O.11-shape-dim': 'runInference() — wrong static dim rejects shapeError',
  'O.12-dtype': 'runInference() — wrong dtype rejects dtypeError',
  'O.13-output-filter': 'runInference() — outputNames filters outputs',
  'O.14-inference-unloaded': 'runInference() — unloaded model rejects modelNotFound',
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n🟢 capacitor-onnx Android E2E Test Suite\n')

  // ─── Section 1: Android Setup ─────────────────────────────────────────
  logSection('1 — Android Setup')

  // 1.1 Find or start device/emulator
  let deviceSerial
  try {
    deviceSerial = process.env.ANDROID_SERIAL || getConnectedDevice()
    if (!deviceSerial) {
      const emulatorBin = findEmulatorBinary()
      if (!emulatorBin) throw new Error('No device connected and emulator binary not found — install Android SDK or connect a device')
      const avds = getAvailableAVDs(emulatorBin)
      if (avds.length === 0) throw new Error('No device connected and no AVDs found — create one via Android Studio or `avdmanager`')
      deviceSerial = bootEmulator(emulatorBin, avds[0])
    }
    process.env.ANDROID_SERIAL = deviceSerial
    pass('1.1 Android device ready', `serial ${deviceSerial}`)
  } catch (err) {
    fail('1.1 Android device ready', err.message)
    console.error('\nFatal: no Android device.\n')
    process.exit(1)
  }

  // 1.2 Ensure Android project + sync + build
  const apkPath = path.join(__dirname, 'android/app/build/outputs/apk/debug/app-debug.apk')

  try {
    ensureAndroidProject()
    patchAndroidBuildGradle()
    patchMinSdkVersion()
    patchAndroidManifest()

    console.log('  → cap sync android...')
    npx('cap sync android', {
      cwd: __dirname,
      timeout: 300_000,
      stdio: VERBOSE ? [0, 1, 2] : ['ignore', 'pipe', 'pipe'],
    })
    pass('1.2 Android project synced')

    const sdkRoot = findAndroidSdkRoot()
    if (sdkRoot) {
      fs.writeFileSync(path.join(__dirname, 'android/local.properties'), `sdk.dir=${sdkRoot}\n`)
    }
    console.log('  → Building APK (./gradlew assembleDebug)...')
    run('./gradlew assembleDebug', { cwd: path.join(__dirname, 'android'), ...(VERBOSE && { stdio: [0, 1, 2] }) })
    if (!fs.existsSync(apkPath)) throw new Error('APK not found after build')
    const apkSize = Math.round(fs.statSync(apkPath).size / 1024 / 1024)
    pass('1.3 APK built', `${apkSize} MB`)
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || '').split('\n').filter(l => l.toLowerCase().includes('error')).slice(0, 3).join(' | ') || err.message?.slice(0, 200)
    fail('1.2 Build pipeline', msg)
    process.exit(1)
  }

  // 1.4 Install APK + ADB reverse port-forward + push fixtures
  try {
    adb(`reverse tcp:${RUNNER_PORT} tcp:${RUNNER_PORT}`)

    adb(`push "${FIXTURE_PATH}" /data/local/tmp/tiny-test.onnx`)
    adb(`shell "echo -n 'not a valid onnx file' > /data/local/tmp/corrupt-test.onnx"`)

    try { adb(`uninstall ${BUNDLE_ID}`) } catch {}
    adb(`install -r "${apkPath}"`)
    pass('1.4 APK installed + fixtures pushed')
  } catch (err) {
    fail('1.4 APK installed', err.message?.slice(0, 200))
    process.exit(1)
  }

  // ─── Section 2: HTTP E2E Test ─────────────────────────────────────────
  logSection('2 — ONNX E2E')

  const { server, allDonePromise } = await startResultServer()
  pass('2.0 HTTP result server started', `port ${RUNNER_PORT}`)

  try {
    adb(`shell am force-stop ${BUNDLE_ID}`)
    await sleep(500)
    adb(`shell am start -n "${BUNDLE_ID}/.MainActivity"`)
    console.log('  → App launched, waiting for test results...')
  } catch (err) {
    fail('2.0 App launch', err.message?.slice(0, 200))
    server.close()
    process.exit(1)
  }

  let appResults
  try {
    appResults = await allDonePromise
  } catch (err) {
    fail('2.0 Test completion', err.message)
    printSummary()
    process.exit(1)
  }

  // ─── Section 3: App Test Results ────────────────────────────────────────
  logSection('3 — Serve Lifecycle + ONNX API Results')

  const ORDER = [
    'S.1-register', 'S.2-list', 'S.3-status', 'S.4-download',
    'S.5-sizeDisclosure', 'S.6-progress', 'S.7-ready', 'S.8-readyStatus',
    'O.1-load-valid', 'O.2-load-missing', 'O.3-load-corrupt', 'O.4-wrong-format',
    'O.5-unload-clears', 'O.6-unload-unknown', 'O.7-load-twice', 'O.8-load-two',
    'O.9-inference', 'O.10-shape-rank', 'O.11-shape-dim',
    'O.12-dtype', 'O.13-output-filter', 'O.14-inference-unloaded',
  ]
  let num = 1

  for (const id of ORDER) {
    const name = `3.${num++} ${TEST_NAMES[id] || id}`
    const r = appResults.results.get(id)
    if (!r) {
      fail(name, 'no result received (test did not run)')
    } else if (r.status === 'pass') {
      pass(name, r.detail || '')
    } else {
      fail(name, r.error || 'failed')
    }
  }

  printSummary(appResults.summary)

  try { adb(`shell am force-stop ${BUNDLE_ID}`) } catch {}
  process.exit(failedTests > 0 ? 1 : 0)
}

function printSummary(appSummary) {
  const total = passedTests + failedTests
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  Results: ${passedTests}/${total} passed, ${failedTests} failed`)
  if (appSummary) {
    console.log(`  App reported: ${appSummary.passed}/${appSummary.total} passed`)
  }
  if (failedTests > 0) {
    console.log('\n  Failed tests:')
    testResults.filter(r => r.status === 'FAIL').forEach(r => console.log(`    ❌ ${r.name} — ${r.error}`))
  } else {
    console.log('  ✅ ALL PASS')
  }
  console.log(`${'═'.repeat(60)}\n`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
