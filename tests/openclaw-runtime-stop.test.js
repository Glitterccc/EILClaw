const test = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const http = require('node:http')

const { OpenClawRuntime } = require('../electron/services/openclaw-runtime')
const { resolveStatePaths } = require('../electron/utils/runtime-paths')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-launcher-runtime-'))
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function waitForExit(pid, timeoutMs = 6000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!processExists(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return !processExists(pid)
}

function makeRuntime(statePaths, shell = { openExternal: async () => {} }, overrides = {}) {
  return new OpenClawRuntime({
    app: {
      getAppPath: () => path.resolve(__dirname, '..'),
      isPackaged: false
    },
    shell,
    statePaths,
    ...overrides
  })
}

function writeConfiguredState(statePaths, port = 38789) {
  fs.mkdirSync(statePaths.stateDir, { recursive: true })
  fs.mkdirSync(path.dirname(statePaths.authProfilesPath), { recursive: true })
  fs.mkdirSync(statePaths.workspaceDir, { recursive: true })
  fs.writeFileSync(
    statePaths.openclawConfigPath,
    JSON.stringify({
      gateway: {
        port
      }
    }),
    'utf8'
  )
  fs.writeFileSync(
    statePaths.authProfilesPath,
    JSON.stringify({
      version: 1,
      profiles: {}
    }),
    'utf8'
  )
}

test('runtime.stop can clean a lingering detached gateway from the pid file', { timeout: 15000 }, async () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  fs.mkdirSync(statePaths.stateDir, { recursive: true })

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore'
  })
  child.unref()

  fs.writeFileSync(statePaths.gatewayPidPath, `${child.pid}\n`, 'utf8')

  const runtime = makeRuntime(statePaths)

  const result = await runtime.stop()
  assert.equal(result.success, true)
  assert.equal(fs.existsSync(statePaths.gatewayPidPath), false)
  assert.equal(await waitForExit(child.pid), true)
})

test('runtime.stop can clean an owned gateway that is still listening even without gateway.pid', { timeout: 15000 }, async () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  writeConfiguredState(statePaths, 38789)

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore'
  })
  child.unref()

  const runtime = makeRuntime(statePaths, { openExternal: async () => {} }, {
    findListeningPidsFn: () => [child.pid],
    isOwnedPidFn: (pid) => pid === child.pid
  })

  const result = await runtime.stop()
  assert.equal(result.success, true)
  assert.equal(await waitForExit(child.pid), true)
})

test('openChat uses the current gateway token as a one-time query param', async () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  fs.mkdirSync(statePaths.stateDir, { recursive: true })
  fs.writeFileSync(
    statePaths.openclawConfigPath,
    JSON.stringify({
      gateway: {
        port: 38789,
        auth: {
          mode: 'token',
          token: 'persist-me'
        }
      }
    }),
    'utf8'
  )

  let openedUrl = ''
  const runtime = makeRuntime(statePaths, {
    openExternal: async (url) => {
      openedUrl = url
    }
  })
  runtime.port = runtime.getGatewayPort()

  await runtime.openChat()

  const parsed = new URL(openedUrl)
  assert.equal(parsed.origin, 'http://127.0.0.1:38789')
  assert.equal(parsed.searchParams.get('token'), 'persist-me')
})

test('runtime.start fails fast when another gateway already owns the configured port', async () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  const server = http.createServer((_, res) => {
    res.writeHead(200)
    res.end('ok')
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  writeConfiguredState(statePaths, port)

  const runtime = makeRuntime(statePaths)
  const result = await runtime.start()

  assert.equal(result.success, false)
  assert.match(result.message, /already in use by another OpenClaw\/ClawLite gateway/)
  assert.equal(runtime.getStatus().status, 'error')

  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

test('runtime.start adopts an already-running owned gateway on the configured port', async () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  const server = http.createServer((_, res) => {
    res.writeHead(200)
    res.end('ok')
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  writeConfiguredState(statePaths, port)

  const runtime = makeRuntime(statePaths, { openExternal: async () => {} }, {
    findListeningPidsFn: () => [65432],
    isOwnedPidFn: (pid) => pid === 65432
  })
  const result = await runtime.start()

  assert.equal(result.success, true)
  assert.equal(result.alreadyRunning, true)
  assert.equal(Number(fs.readFileSync(statePaths.gatewayPidPath, 'utf8').trim()), 65432)
  assert.equal(runtime.getStatus().status, 'running')

  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

test('runtime.start does not disable channels when launching its own gateway', async () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  writeConfiguredState(statePaths, 29876)

  const fakeChild = new EventEmitter()
  fakeChild.stdout = new EventEmitter()
  fakeChild.stderr = new EventEmitter()
  fakeChild.pid = 45678

  let spawnCall = null
  const runtime = new OpenClawRuntime({
    app: {
      getAppPath: () => path.resolve(__dirname, '..'),
      isPackaged: false
    },
    shell: {
      openExternal: async () => {}
    },
    statePaths,
    spawnFn: (command, args, options) => {
      spawnCall = { command, args, options }
      process.nextTick(() => fakeChild.emit('spawn'))
      return fakeChild
    }
  })

  runtime.validateRuntimeResources = () => {}
  runtime.waitForGatewayReady = async () => true

  const result = await runtime.start()

  assert.equal(result.success, true)
  assert.equal(spawnCall.options.env.OPENCLAW_SKIP_CHANNELS, undefined)
  assert.equal(spawnCall.options.env.CLAWDBOT_SKIP_CHANNELS, undefined)

  fakeChild.emit('exit', 0, null)
})

test('runtime keeps running after launcher shell exits if it can adopt the actual gateway pid', async () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  writeConfiguredState(statePaths, 29877)

  const fakeChild = new EventEmitter()
  fakeChild.stdout = new EventEmitter()
  fakeChild.stderr = new EventEmitter()
  fakeChild.pid = 45678

  let spawnCall = null
  const runtime = new OpenClawRuntime({
    app: {
      getAppPath: () => path.resolve(__dirname, '..'),
      isPackaged: false
    },
    shell: {
      openExternal: async () => {}
    },
    statePaths,
    findListeningPidsFn: () => [56789],
    isOwnedPidFn: (pid) => pid === 56789,
    spawnFn: (command, args, options) => {
      spawnCall = { command, args, options }
      process.nextTick(() => fakeChild.emit('spawn'))
      return fakeChild
    }
  })

  runtime.validateRuntimeResources = () => {}
  runtime.waitForGatewayReady = async () => true

  const result = await runtime.start()
  assert.equal(result.success, true)
  assert.equal(Number(fs.readFileSync(statePaths.gatewayPidPath, 'utf8').trim()), 56789)

  fakeChild.emit('exit', 0, null)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(runtime.getStatus().status, 'running')
  assert.equal(Number(fs.readFileSync(statePaths.gatewayPidPath, 'utf8').trim()), 56789)
  assert.equal(spawnCall.options.env.OPENCLAW_SKIP_CHANNELS, undefined)
})

test('runtime.start surfaces config validation stderr when gateway exits before ready', async () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  writeConfiguredState(statePaths, 29878)

  const fakeChild = new EventEmitter()
  fakeChild.stdout = new EventEmitter()
  fakeChild.stderr = new EventEmitter()
  fakeChild.pid = 45679

  const runtime = new OpenClawRuntime({
    app: {
      getAppPath: () => path.resolve(__dirname, '..'),
      isPackaged: false
    },
    shell: {
      openExternal: async () => {}
    },
    statePaths,
    spawnFn: () => {
      process.nextTick(() => {
        fakeChild.emit('spawn')
        fakeChild.stderr.emit('data', 'Config invalid\n')
        fakeChild.stderr.emit('data', '  - plugins.installs.openclaw-weixin.source: Invalid input\n')
        fakeChild.emit('exit', 1, null)
      })
      return fakeChild
    }
  })

  runtime.validateRuntimeResources = () => {}

  const result = await runtime.start()

  assert.equal(result.success, false)
  assert.match(result.message, /OpenClaw config invalid: .*plugins\.installs\.openclaw-weixin\.source: Invalid input/)
  assert.equal(runtime.getStatus().status, 'error')
})
