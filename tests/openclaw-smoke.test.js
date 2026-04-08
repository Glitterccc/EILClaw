const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const net = require('node:net')
const http = require('node:http')

const { resolveUserConfig, createAuthProfiles, createOpenClawConfig, CONFIG_MODES } = require('../electron/services/config-modes')
const { writeJsonAtomic } = require('../electron/services/file-store')

const repoRoot = path.resolve(__dirname, '..')
const runtimeDir = path.join(repoRoot, 'node-runtime')
const nodePath = path.join(runtimeDir, 'nodejs', 'bin', 'node')
const openclawEntry = path.join(runtimeDir, 'npm_global', 'node_modules', 'openclaw', 'openclaw.mjs')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-launcher-smoke-'))
}

const READY_PATHS = ['/readyz', '/ready', '/healthz', '/health', '/']

function canGet(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume()
      resolve([200, 204, 301, 302, 401, 403, 404].includes(res.statusCode || 0))
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function waitForHealth(url, timeoutMs = 15000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    for (const readyPath of READY_PATHS) {
      if (await canGet(`${url}${readyPath}`)) return true
    }
    await new Promise((resolve) => setTimeout(resolve, 350))
  }
  return false
}

function canBindLoopback() {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(0, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

test('generated config can boot a local OpenClaw gateway', { timeout: 30000 }, async (t) => {
  if (!fs.existsSync(nodePath) || !fs.existsSync(openclawEntry)) {
    t.skip('Bundled node-runtime is not available')
    return
  }
  if (!(await canBindLoopback())) {
    t.skip('Current environment cannot bind to 127.0.0.1')
    return
  }

  const port = await reserveLoopbackPort()
  const stateDir = tempDir()
  const workspaceDir = path.join(stateDir, 'workspace')
  const authDir = path.join(stateDir, 'agents', 'main', 'agent')
  fs.mkdirSync(workspaceDir, { recursive: true })
  fs.mkdirSync(authDir, { recursive: true })

  const normalized = resolveUserConfig({
    mode: CONFIG_MODES.openai_compatible,
    values: {
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      model: 'gpt-lite'
    }
  })

  writeJsonAtomic(
    path.join(stateDir, 'openclaw.json'),
    createOpenClawConfig({
      resolvedConfig: normalized.resolved,
      workspaceDir,
      gatewayPort: port
    })
  )
  writeJsonAtomic(path.join(authDir, 'auth-profiles.json'), createAuthProfiles(normalized.resolved))

  const child = spawn(nodePath, [openclawEntry, 'gateway', '--port', String(port)], {
    cwd: workspaceDir,
    env: {
      ...process.env,
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_SKIP_CHANNELS: '1',
      CLAWDBOT_SKIP_CHANNELS: '1',
      OPENCLAW_STATE_DIR: stateDir,
      CLAWDBOT_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, 'openclaw.json'),
      CLAWDBOT_CONFIG_PATH: path.join(stateDir, 'openclaw.json')
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  })

  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk || '')
  })

  try {
    const ready = await waitForHealth(`http://127.0.0.1:${port}`)
    assert.equal(ready, true, stderr || 'OpenClaw gateway did not become healthy')
  } finally {
    if (child.pid) {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM')
        else process.kill(child.pid, 'SIGTERM')
      } catch {}
    }
  }
})
