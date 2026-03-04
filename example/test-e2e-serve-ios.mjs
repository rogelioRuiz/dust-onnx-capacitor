#!/usr/bin/env node
/**
 * capacitor-onnx iOS Simulator Serve E2E Test Suite
 *
 * Runs the in-app dust-serve lifecycle tests (S.1-S.10) exposed by
 * example/www/index.html when SERVE_TEST_MODE = true.
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
const TOTAL_TESTS = 10
const TIMEOUT_MS = 300_000
const IOS_MIN_VERSION = '16'

const ORDER = [
  'S.1 registerModel() succeeds',
  'S.2 listModels() returns descriptor + status',
  'S.3 getModelStatus() returns status.kind',
  'S.4 downloadModel() starts and completes',
  'S.5 sizeDisclosure emits modelId + sizeBytes',
  'S.6 modelProgress emits download counters',
  'S.7 modelReady emits modelId + path',
  'S.8 getModelStatus() after ready returns path',
  'S.9 ONNX.loadModel() succeeds from serve path',
  'S.10 registerModel() restores ready + path',
]

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
    const match = out.match(/Xcode (\d+)/)
    return match ? parseInt(match[1], 10) : 0
  } catch {
    return 0
  }
}

// ─── simctl helpers ──────────────────────────────────────────────────────────
function simctl(args, opts = {}) {
  return execSync(`xcrun simctl ${args}`, {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim()
}

function getBootedUDID() {
  const json = simctl('list devices booted -j')
  const data = JSON.parse(json)
  for (const devices of Object.values(data.devices)) {
    for (const device of devices) {
      if (device.state === 'Booted') return device.udid
    }
  }
  return null
}

function findBootedAppDevice() {
  try {
    const json = simctl('list devices booted -j')
    const data = JSON.parse(json)
    for (const devices of Object.values(data.devices)) {
      for (const device of devices) {
        if (device.state !== 'Booted') continue
        try {
          simctl(`get_app_container ${device.udid} ${BUNDLE_ID} data`)
          return device.udid
        } catch {}
      }
    }
  } catch {}
  return null
}

function findAvailableIPhone() {
  const json = simctl('list devices available -j')
  const data = JSON.parse(json)
  for (const [runtime, devices] of Object.entries(data.devices)) {
    if (!runtime.includes('iOS')) continue
    for (const device of devices) {
      if (device.name.includes('iPhone') && device.isAvailable) return device.udid
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  const xcodeproj = path.join(__dirname, 'ios/App/App.xcodeproj')
  if (fs.existsSync(iosDir) && !fs.existsSync(xcodeproj)) {
    execSync(`rm -rf "${iosDir}"`, { stdio: 'ignore' })
  }
  if (fs.existsSync(iosDir)) return
  console.log('  → cap add ios...')
  npx('cap add ios', {
    cwd: __dirname,
    stdio: VERBOSE ? [0, 1, 2] : ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  })
}

function fixDeploymentTarget() {
  const pbxproj = path.join(__dirname, 'ios/App/App.xcodeproj/project.pbxproj')
  if (fs.existsSync(pbxproj)) {
    let content = fs.readFileSync(pbxproj, 'utf8')
    content = content.replace(/IPHONEOS_DEPLOYMENT_TARGET = \d+\.\d+/g, `IPHONEOS_DEPLOYMENT_TARGET = ${IOS_MIN_VERSION}.0`)
    fs.writeFileSync(pbxproj, content)
  }

  const capSpm = path.join(__dirname, 'ios/App/CapApp-SPM/Package.swift')
  if (fs.existsSync(capSpm)) {
    let content = fs.readFileSync(capSpm, 'utf8')
    content = content.replace(/\.iOS\(\.v\d+\)/, `.iOS(.v${IOS_MIN_VERSION})`)
    fs.writeFileSync(capSpm, content)
  }
}

// ─── HTTP result collector ───────────────────────────────────────────────────
function startResultServer() {
  const received = new Map()

  const serverReady = new Promise((resolveServer, rejectServer) => {
    const allDonePromise = new Promise((resolveDone, rejectDone) => {
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
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          try {
            const payload = JSON.parse(body)
            if (req.url === '/__serve_result') {
              received.set(payload.id, payload)
              console.log(`  [app] ${payload.status === 'pass' ? '✅' : '❌'} ${payload.id}${payload.error ? ' — ' + payload.error : ''}`)
              res.writeHead(200)
              res.end('ok')
            } else if (req.url === '/__serve_done') {
              res.writeHead(200)
              res.end('ok')
              server.close()
              resolveDone({ results: received, summary: payload })
            } else {
              res.writeHead(404)
              res.end()
            }
          } catch {
            res.writeHead(400)
            res.end()
          }
        })
      })

      try { run(`lsof -ti:${RUNNER_PORT} | xargs kill -9`, { stdio: 'ignore' }) } catch {}

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

function printSummary(appSummary) {
  const total = passedTests + failedTests
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  Results: ${passedTests}/${total} passed, ${failedTests} failed`)
  if (appSummary) {
    console.log(`  App reported: ${appSummary.passed}/${appSummary.total} passed`)
    if (appSummary.fatal) console.log(`  App fatal: ${appSummary.fatal}`)
  }
  if (failedTests > 0) {
    console.log('\n  Failed tests:')
    testResults
      .filter((result) => result.status === 'FAIL')
      .forEach((result) => console.log(`    ❌ ${result.name} — ${result.error}`))
  } else {
    console.log('  ✅ ALL PASS')
  }
  console.log(`${'═'.repeat(60)}\n`)
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n🔵 capacitor-onnx iOS Simulator Serve E2E Test Suite\n')

  // ─── Section 0: Project Setup ──────────────────────────────────────────
  logSection('0 — Project Setup')

  try {
    ensureIosPlatform()
    fixDeploymentTarget()
    pass('0.1 iOS platform ready')
  } catch (err) {
    fail('0.1 iOS platform ready', err.message?.slice(0, 200) || 'failed')
    process.exit(1)
  }

  // ─── Section 1: Simulator Setup ────────────────────────────────────────
  logSection('1 — Simulator Setup')

  let udid
  try {
    udid = process.env.IOS_DEVICE_ID || findBootedAppDevice() || getBootedUDID()
    if (!udid) {
      const available = findAvailableIPhone()
      if (!available) throw new Error('No available iPhone simulator — install one via Xcode')
      udid = bootSimulator(available)
    }
    pass('1.1 Simulator ready', `UDID ${udid}`)
  } catch (err) {
    fail('1.1 Simulator ready', err.message)
    process.exit(1)
  }

  // Patch source HTML before cap sync so the build includes SERVE_TEST_MODE = true
  const srcHtmlPath = path.join(__dirname, 'www', 'index.html')
  const originalHtml = fs.readFileSync(srcHtmlPath, 'utf8')
  fs.writeFileSync(srcHtmlPath, originalHtml.replace(/var SERVE_TEST_MODE = (true|false)/, 'var SERVE_TEST_MODE = true'))

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
    fs.writeFileSync(srcHtmlPath, originalHtml) // restore on failure
    fail('1.2 cap sync ios', err.message?.slice(0, 200) || 'failed')
    process.exit(1)
  }

  // Restore source HTML immediately after sync
  fs.writeFileSync(srcHtmlPath, originalHtml)

  let appPath
  try {
    console.log('  → Building (xcodebuild)...')
    const xcodeMajor = getXcodeMajorVersion()
    const explicitModulesFlag = xcodeMajor >= 26 ? ' SWIFT_ENABLE_EXPLICIT_MODULES=NO' : ''
    execSync(
      `xcodebuild -scheme App -sdk iphonesimulator ` +
      `-destination "platform=iOS Simulator,id=${udid}" ` +
      `-configuration Debug build${explicitModulesFlag}`,
      {
        cwd: path.join(__dirname, 'ios', 'App'),
        encoding: 'utf8',
        timeout: 300_000,
        stdio: VERBOSE ? [0, 1, 2] : ['ignore', 'pipe', 'pipe'],
      },
    )
    pass('1.3 xcodebuild succeeded')

    const found = execSync(
      `find ~/Library/Developer/Xcode/DerivedData -name "App.app" -path "*Debug-iphonesimulator*" -not -path "*PlugIns*" -exec stat -f '%m %N' {} \\; 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-`,
      { encoding: 'utf8', shell: true, timeout: 20_000 },
    ).trim()
    appPath = found
    if (!appPath) throw new Error('App.app not found in DerivedData')

    try { simctl(`terminate ${udid} ${BUNDLE_ID}`) } catch {}
    simctl(`install ${udid} "${appPath}"`)
    pass('1.4 App installed')
  } catch (err) {
    const output = err.stderr || err.stdout || err.message || ''
    const errorLines = output
      .split('\n')
      .filter((line) => line.includes('error:'))
      .slice(0, 4)
      .join(' | ')
    fail(appPath ? '1.4 App installed' : '1.3 xcodebuild succeeded', errorLines || err.message || 'failed')
    process.exit(1)
  }

  pass('1.5 HTML patched', 'SERVE_TEST_MODE = true (baked into build)')

  // ─── Section 2: Serve E2E ─────────────────────────────────────────────
  logSection('2 — Serve E2E')

  const { server, allDonePromise } = await startResultServer()
  pass('2.0 HTTP result server started', `port ${RUNNER_PORT}`)

  try {
    try { simctl(`terminate ${udid} ${BUNDLE_ID}`) } catch {}
    await sleep(500)
    simctl(`launch ${udid} ${BUNDLE_ID}`)
    console.log('  → App launched. Waiting for serve test results...')
  } catch (err) {
    fail('2.1 App launch', err.message?.slice(0, 200) || 'failed')
    server.close()
    process.exit(1)
  }

  let captureResult
  try {
    captureResult = await allDonePromise
    pass('2.2 All serve results received via HTTP', `${captureResult.results.size}/${TOTAL_TESTS} results`)
  } catch (err) {
    fail('2.2 All serve results received via HTTP', err.message)
    printSummary()
    process.exit(1)
  }

  // ─── Section 3: Results ───────────────────────────────────────────────
  logSection('3 — Results')

  for (const id of ORDER) {
    const result = captureResult.results.get(id)
    if (!result) {
      fail(id, 'no result received')
    } else if (result.status === 'pass') {
      pass(id, result.detail || '')
    } else {
      fail(id, result.error || 'failed')
    }
  }

  if (captureResult.summary && captureResult.summary.fatal) {
    fail('App fatal error', captureResult.summary.fatal)
  }

  printSummary(captureResult.summary)
  process.exit(failedTests > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('\nFatal:', err.message)
  process.exit(1)
})
