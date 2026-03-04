#!/usr/bin/env node
/**
 * capacitor-onnx iOS Simulator E2E Test Suite
 *
 * Approach: HTTP server on localhost:8099.
 *   - index.html POSTs __onnx_result and __onnx_done to this server
 *   - iOS Simulator shares the Mac's loopback, so fetch('http://127.0.0.1:8099') works
 *
 * Sections:
 *   1  Simulator Setup          (4 tests)
 *   2  Fixture + HTTP Handshake (1 test)
 *   3  Serve Lifecycle + ONNX API (22 tests: S.1–S.8 + O.1–O.14)
 */

import { execSync } from 'child_process'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VERBOSE = process.argv.includes('--verbose')

// ─── Config ──────────────────────────────────────────────────────────────────
const BUNDLE_ID = 'io.t6x.onnx.test'
const RUNNER_PORT = 8099
const TOTAL_TESTS = 22
const TIMEOUT_MS = 120_000
const IOS_MIN_VERSION = '16'

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  'test',
  'fixtures',
  'tiny-test.onnx',
)

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

// ─── Xcode version helper ────────────────────────────────────────────────────
function getXcodeMajorVersion() {
  try {
    const out = execSync('xcodebuild -version', { encoding: 'utf8' })
    const m = out.match(/Xcode (\d+)/)
    return m ? parseInt(m[1], 10) : 0
  } catch { return 0 }
}

// ─── simctl helpers ──────────────────────────────────────────────────────────
function simctl(args, opts = {}) {
  return execSync(`xcrun simctl ${args}`, { encoding: 'utf8', timeout: 30000, ...opts }).trim()
}

function getBootedUDID() {
  const json = simctl('list devices booted -j')
  const data = JSON.parse(json)
  for (const devices of Object.values(data.devices)) {
    for (const d of devices) {
      if (d.state === 'Booted') return d.udid
    }
  }
  return null
}

function findAvailableIPhone() {
  const json = simctl('list devices available -j')
  const data = JSON.parse(json)
  for (const [runtime, devices] of Object.entries(data.devices)) {
    if (!runtime.includes('iOS')) continue
    for (const d of devices) {
      if (d.name.includes('iPhone') && d.isAvailable) return d.udid
    }
  }
  return null
}

function bootSimulator(udid) {
  console.log(`  → Booting simulator ${udid}...`)
  simctl(`boot ${udid}`)
  for (let i = 0; i < 30; i++) {
    const booted = getBootedUDID()
    if (booted) return booted
    execSync('sleep 1')
  }
  throw new Error('Simulator failed to boot within 30s')
}

// ─── Shell helper ────────────────────────────────────────────────────────────
function run(cmd, opts = {}) {
  const nodeBin = path.dirname(process.execPath)
  const result = execSync(cmd, {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${nodeBin}:${process.env.PATH}` },
    ...opts,
  })
  return (result || '').trim()
}

function npx(args, opts = {}) {
  const npxPath = path.join(path.dirname(process.execPath), 'npx')
  return run(`${npxPath} ${args}`, opts)
}

// ─── Project setup (idempotent) ──────────────────────────────────────────────
function ensureIosPlatform() {
  const iosDir = path.join(__dirname, 'ios')
  if (fs.existsSync(iosDir)) return
  console.log('  → cap add ios...')
  npx('cap add ios', { cwd: __dirname, stdio: VERBOSE ? [0, 1, 2] : ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
}

function fixDeploymentTarget() {
  const pbxproj = path.join(__dirname, 'ios/App/App.xcodeproj/project.pbxproj')
  if (fs.existsSync(pbxproj)) {
    let content = fs.readFileSync(pbxproj, 'utf8')
    const re = /IPHONEOS_DEPLOYMENT_TARGET = \d+\.\d+/g
    if (content.match(re)?.[0]?.includes(`= ${IOS_MIN_VERSION}.0`)) return
    content = content.replace(re, `IPHONEOS_DEPLOYMENT_TARGET = ${IOS_MIN_VERSION}.0`)
    fs.writeFileSync(pbxproj, content)
  }
  const capSpm = path.join(__dirname, 'ios/App/CapApp-SPM/Package.swift')
  if (fs.existsSync(capSpm)) {
    let content = fs.readFileSync(capSpm, 'utf8')
    content = content.replace(/\.iOS\(\.v\d+\)/, `.iOS(.v${IOS_MIN_VERSION})`)
    fs.writeFileSync(capSpm, content)
  }
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
              console.log(`  [app] ${payload.id}: ${payload.status}${payload.error ? ' — ' + payload.error : ''}`)
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

// ─── Test name map ───────────────────────────────────────────────────────────
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
  console.log('\n🔵 capacitor-onnx iOS Simulator E2E Test Suite\n')

  // ─── Section 0: Project Setup ──────────────────────────────────────────
  logSection('0 — Project Setup')

  try {
    ensureIosPlatform()
    fixDeploymentTarget()
    pass('0.1 iOS platform ready')
  } catch (err) {
    fail('0.1 iOS platform ready', err.message?.slice(0, 200) || 'cap add ios failed')
    process.exit(1)
  }

  // ─── Section 1: Simulator Setup ────────────────────────────────────────
  logSection('1 — Simulator Setup')

  // 1.1 Find or boot simulator
  let udid
  try {
    udid = getBootedUDID()
    if (!udid) {
      const available = findAvailableIPhone()
      if (!available) throw new Error('No available iPhone simulator — install one via Xcode')
      udid = bootSimulator(available)
    }
    pass('1.1 Simulator ready', `UDID ${udid}`)
  } catch (err) {
    fail('1.1 Simulator ready', err.message)
    console.error('\nFatal: no simulator available.\n')
    process.exit(1)
  }

  // 1.2 cap sync ios
  try {
    console.log('  → cap sync ios...')
    npx('cap sync ios', {
      cwd: __dirname,
      timeout: 120_000,
      stdio: VERBOSE ? [0, 1, 2] : ['ignore', 'pipe', 'pipe'],
    })
    fixDeploymentTarget()
    pass('1.2 cap sync ios')
  } catch (err) {
    // Manually copy web assets as fallback
    try {
      const publicDir = path.join(__dirname, 'ios', 'App', 'App', 'public')
      fs.mkdirSync(publicDir, { recursive: true })
      execSync(`cp -r "${path.join(__dirname, 'www')}/." "${publicDir}"`, { encoding: 'utf8' })
      pass('1.2 web assets copied (manual fallback)')
    } catch (e2) {
      fail('1.2 web assets', e2.message?.slice(0, 200) || 'failed')
      process.exit(1)
    }
  }

  // 1.3 Build for simulator
  try {
    console.log('  → Building (xcodebuild)...')
    const xcodeMajor = getXcodeMajorVersion()
    const explicitModulesFlag = xcodeMajor >= 26 ? ' SWIFT_ENABLE_EXPLICIT_MODULES=NO' : ''
    const derivedDataPath = path.join(__dirname, 'ios', 'App', 'DerivedData')
    execSync(
      `xcodebuild -scheme App -sdk iphonesimulator ` +
      `-destination "platform=iOS Simulator,id=${udid}" ` +
      `-derivedDataPath "${derivedDataPath}" -configuration Debug build` +
      explicitModulesFlag,
      {
        cwd: path.join(__dirname, 'ios', 'App'),
        encoding: 'utf8',
        timeout: 300_000,
        stdio: VERBOSE ? [0, 1, 2] : ['ignore', 'pipe', 'pipe'],
      },
    )
    pass('1.3 xcodebuild succeeded')
  } catch (err) {
    const lines = (err.stderr || err.stdout || err.message || '').split('\n')
    const errorLines = lines.filter((l) => l.includes('error:')).slice(0, 3).join(' | ')
    fail('1.3 xcodebuild succeeded', errorLines || 'build failed')
    process.exit(1)
  }

  // 1.4 Install app
  let appPath
  try {
    // Find App.app in our scoped DerivedData path
    const derivedDataPath = path.join(__dirname, 'ios', 'App', 'DerivedData')
    const candidates = execSync(
      `find "${derivedDataPath}" -name "App.app" -path "*/Debug-iphonesimulator/*" -not -path "*PlugIns*" 2>/dev/null`,
      { encoding: 'utf8', shell: true, timeout: 15000 },
    ).trim().split('\n').filter(Boolean)
    appPath = candidates[0] || null
    if (!appPath) throw new Error(`App.app not found in scoped DerivedData`)

    simctl(`install ${udid} "${appPath}"`)
    try { simctl(`terminate ${udid} ${BUNDLE_ID}`) } catch {}
    pass('1.4 App installed')
  } catch (err) {
    fail('1.4 App installed', err.message)
    process.exit(1)
  }

  // ─── Section 2: Fixture Provisioning + HTTP Handshake ──────────────────
  logSection('2 — Fixture + HTTP Handshake')

  // iOS sandbox: apps can only access their own container directories.
  // We copy fixtures into the app's private tmp/ dir (inside data container),
  // and inject test-config.json into the installed app bundle's public/ dir
  // (writable on simulator) so the WebView can fetch() it.
  try {
    if (!fs.existsSync(FIXTURE_PATH)) throw new Error('Fixture not found: ' + FIXTURE_PATH)

    // Get the app's data container (Documents, tmp, Caches, etc.)
    const dataContainer = simctl(`get_app_container ${udid} ${BUNDLE_ID} data`)
    const tmpDir = path.join(dataContainer, 'tmp')
    fs.mkdirSync(tmpDir, { recursive: true })

    // Copy valid model
    fs.copyFileSync(FIXTURE_PATH, path.join(tmpDir, 'tiny-test.onnx'))

    // Create corrupt model (garbage bytes)
    fs.writeFileSync(path.join(tmpDir, 'corrupt-test.onnx'), 'not a valid onnx file\x00\xff\xfe')

    console.log(`  → Fixtures copied to ${tmpDir}`)

    // Get the installed app bundle path and inject test-config.json
    // so the WebView can fetch() it and discover the fixture path.
    const bundleContainer = simctl(`get_app_container ${udid} ${BUNDLE_ID}`)
    const bundlePublicDir = path.join(bundleContainer, 'public')
    fs.writeFileSync(
      path.join(bundlePublicDir, 'test-config.json'),
      JSON.stringify({
        basePath: tmpDir,
        fixtureBaseUrl: `http://127.0.0.1:${RUNNER_PORT}/__fixture`,
      }),
    )

    console.log(`  → test-config.json injected into ${bundlePublicDir}`)
  } catch (err) {
    fail('2.0 Fixture provisioning', err.message)
    process.exit(1)
  }

  // Start HTTP server BEFORE launching app
  console.log(`  → HTTP result server listening on :${RUNNER_PORT}...`)
  const { allDonePromise } = await startResultServer()

  // Launch app
  try {
    simctl(`launch ${udid} ${BUNDLE_ID}`)
    console.log('  → App launched. Waiting for test results (up to 120s)...\n')
  } catch (err) {
    fail('2.0 App launch', err.message)
    process.exit(1)
  }

  let captureResult
  try {
    captureResult = await allDonePromise
    pass('2.1 All test results received via HTTP', `${captureResult.results.size}/${TOTAL_TESTS} results`)
  } catch (err) {
    fail('2.1 All test results received via HTTP', err.message)
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
    const r = captureResult.results.get(id)
    if (!r) {
      fail(name, 'no result received (test did not run)')
    } else if (r.status === 'pass') {
      pass(name, r.detail || '')
    } else {
      fail(name, r.error || 'failed')
    }
  }

  printSummary(captureResult.summary)
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
    testResults.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`    ❌ ${r.name} — ${r.error}`))
  } else {
    console.log('  ✅ ALL PASS')
  }
  console.log(`${'═'.repeat(60)}\n`)
}

main().catch((err) => {
  console.error('\n  Fatal error:', err.message)
  process.exit(1)
})
