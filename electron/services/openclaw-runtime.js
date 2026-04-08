const { EventEmitter } = require('events')
const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')
const { DEFAULT_GATEWAY_PORT, resolveOpenClawLaunchSpec, resolveRuntimeDir } = require('../utils/runtime-paths')
const { readJson } = require('./file-store')

const READY_PATHS = ['/readyz', '/ready', '/healthz', '/health', '/']
const READY_STATUSES = new Set([200, 204, 301, 302, 401, 403, 404])

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function canHttpGet(urlString) {
  return new Promise((resolve) => {
    const url = new URL(urlString)
    const client = url.protocol === 'https:' ? https : http
    const req = client.request(url, { method: 'GET' }, (res) => {
      res.resume()
      resolve(READY_STATUSES.has(res.statusCode || 0))
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1500, () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

async function waitForProcessSpawn(child, label) {
  return new Promise((resolve) => {
    child.once('spawn', () => resolve({ success: true }))
    child.once('error', (error) => resolve({ success: false, message: `${label} failed to spawn: ${error.message}` }))
  })
}

async function killProcess(pid, signal = 'SIGTERM') {
  if (!pid) return
  try {
    if (process.platform !== 'win32') {
      process.kill(-pid, signal)
      return
    }
  } catch {}
  try {
    process.kill(pid, signal)
  } catch {}
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function parsePidList(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => Number.parseInt(String(line || '').trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

function findListeningPids(port) {
  if (!Number.isFinite(port) || port <= 0) return []
  try {
    const output = execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return parsePidList(output)
  } catch {
    return []
  }
}

function isOwnedGatewayPid(pid, statePaths) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    const output = execFileSync('lsof', ['-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    return output.includes(statePaths.openclawConfigPath) || output.includes(statePaths.workspaceDir)
  } catch {
    return false
  }
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!processExists(pid)) return true
    await wait(150)
  }
  return !processExists(pid)
}

class OpenClawRuntime extends EventEmitter {
  constructor({
    app,
    shell,
    statePaths,
    spawnFn = spawn,
    findListeningPidsFn = findListeningPids,
    isOwnedPidFn = isOwnedGatewayPid
  }) {
    super()
    this.app = app
    this.shell = shell
    this.statePaths = statePaths
    this.spawnFn = spawnFn
    this.findListeningPidsFn = findListeningPidsFn
    this.isOwnedPidFn = isOwnedPidFn
    this.runtimeDir = resolveRuntimeDir({ app, isPackaged: app.isPackaged })
    this.launchSpec = resolveOpenClawLaunchSpec(this.runtimeDir)
    this.child = null
    this.status = 'stopped'
    this.startTime = null
    this.port = DEFAULT_GATEWAY_PORT
    this.lastError = ''
    this.logs = []
    this.stopping = false
  }

  readPersistedPid() {
    if (!fs.existsSync(this.statePaths.gatewayPidPath)) return null
    const raw = String(fs.readFileSync(this.statePaths.gatewayPidPath, 'utf8') || '').trim()
    const pid = Number.parseInt(raw, 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  }

  persistPid(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return
    fs.mkdirSync(this.statePaths.stateDir, { recursive: true })
    fs.writeFileSync(this.statePaths.gatewayPidPath, `${pid}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  clearPersistedPid() {
    try {
      fs.rmSync(this.statePaths.gatewayPidPath, { force: true })
    } catch {}
  }

  appendLog(level, message) {
    this.logs.push({
      time: new Date().toISOString(),
      level,
      message
    })
    this.logs = this.logs.slice(-200)
    this.emit('log', this.logs[this.logs.length - 1])
  }

  getStartupFailureMessage() {
    const recentLogs = [...this.logs].reverse()
    const invalidField = recentLogs.find((entry) =>
      typeof entry?.message === 'string' &&
      /plugins\.installs\..*Invalid input/i.test(entry.message)
    )?.message

    if (invalidField) {
      return `OpenClaw config invalid: ${invalidField}`
    }

    const configInvalid = recentLogs.find((entry) =>
      typeof entry?.message === 'string' &&
      /Config invalid/i.test(entry.message)
    )?.message

    if (configInvalid) {
      return configInvalid
    }

    const recentStderr = recentLogs.find((entry) =>
      entry?.level === 'stderr' &&
      typeof entry?.message === 'string' &&
      entry.message.trim()
    )?.message

    if (recentStderr) {
      return recentStderr
    }

    return this.lastError || 'OpenClaw gateway exited before becoming ready'
  }

  emitStatus() {
    this.emit('status-changed', this.getStatus())
  }

  setStatus(status, errorMessage = '') {
    this.status = status
    this.lastError = errorMessage
    if (status === 'running') {
      this.startTime = Date.now()
    }
    if (status === 'stopped') {
      this.startTime = null
      this.lastError = ''
    }
    this.emitStatus()
  }

  getGatewayPort() {
    const config = readJson(this.statePaths.openclawConfigPath)
    const configuredPort = Number(config?.gateway?.port || DEFAULT_GATEWAY_PORT)
    return Number.isFinite(configuredPort) ? configuredPort : DEFAULT_GATEWAY_PORT
  }

  getChatUrl() {
    return `http://127.0.0.1:${this.port}`
  }

  getGatewayAuth() {
    const config = readJson(this.statePaths.openclawConfigPath)
    const gatewayAuth = config?.gateway?.auth
    return gatewayAuth && typeof gatewayAuth === 'object' ? gatewayAuth : {}
  }

  getOpenChatUrl() {
    const url = new URL(this.getChatUrl())
    const gatewayAuth = this.getGatewayAuth()
    const authMode = String(gatewayAuth.mode || '').trim().toLowerCase()
    const token = typeof gatewayAuth.token === 'string' ? gatewayAuth.token.trim() : ''
    const password = typeof gatewayAuth.password === 'string' ? gatewayAuth.password.trim() : ''

    if (authMode === 'token' && token) {
      url.searchParams.set('token', token)
    } else if (authMode === 'password' && password) {
      url.searchParams.set('password', password)
    }

    return url.toString()
  }

  getStatus() {
    return {
      status: this.status,
      pid: this.readPersistedPid() || this.child?.pid || null,
      port: this.port,
      url: this.getChatUrl(),
      lastError: this.lastError,
      runtimeDir: this.runtimeDir,
      uptimeMs: this.startTime ? Date.now() - this.startTime : 0
    }
  }

  getKnownProcessPids() {
    const trackedPid = this.child?.pid || null
    const persistedPid = this.readPersistedPid()
    const ownedPortPid = this.findOwnedGatewayPid(this.getGatewayPort())
    return [...new Set([trackedPid, persistedPid, ownedPortPid].filter((value) => Number.isInteger(value) && value > 0))]
  }

  isConfigured() {
    return fs.existsSync(this.statePaths.openclawConfigPath) && fs.existsSync(this.statePaths.authProfilesPath)
  }

  validateRuntimeResources() {
    const missing = (this.launchSpec.requiredPaths || []).filter((candidate) => !fs.existsSync(candidate))
    if (missing.length > 0) {
      throw new Error(`Bundled runtime is incomplete: ${missing.join(', ')}`)
    }
  }

  bindChildProcess(child) {
    child.stdout?.on('data', (data) => {
      this.appendLog('stdout', String(data || '').trim())
    })
    child.stderr?.on('data', (data) => {
      this.appendLog('stderr', String(data || '').trim())
    })
    child.on('exit', (code, signal) => {
      this.handleChildExit(child, code, signal).catch((error) => {
        this.appendLog('error', error.message || 'Failed to process OpenClaw gateway exit')
        if (this.child === child) this.child = null
        if (this.readPersistedPid() === child.pid) this.clearPersistedPid()
        this.setStatus('error', error.message || 'OpenClaw gateway exited unexpectedly')
      })
    })
  }

  getListeningPids(port = this.port) {
    return [...new Set((this.findListeningPidsFn(port) || []).filter((pid) => Number.isInteger(pid) && pid > 0))]
  }

  findOwnedGatewayPid(port = this.port) {
    return this.getListeningPids(port).find((pid) => this.isOwnedPidFn(pid, this.statePaths)) || null
  }

  adoptOwnedGatewayPid(port = this.port) {
    const pid = this.findOwnedGatewayPid(port)
    if (!pid) return null
    this.persistPid(pid)
    return pid
  }

  async handleChildExit(child, code, signal) {
    this.appendLog('system', `OpenClaw gateway exited (code=${code}, signal=${signal})`)
    if (this.child === child) this.child = null

    if (this.stopping) {
      if (this.readPersistedPid() === child.pid) {
        this.clearPersistedPid()
      }
      this.stopping = false
      this.setStatus('stopped')
      return
    }

    const adoptedPid = this.adoptOwnedGatewayPid(this.port)
    if (adoptedPid && adoptedPid !== child.pid) {
      this.appendLog('system', `Adopted running OpenClaw gateway pid=${adoptedPid}`)
      this.setStatus('running')
      return
    }

    if (this.readPersistedPid() === child.pid) {
      this.clearPersistedPid()
    }
    const message = code === 0 ? '' : 'OpenClaw gateway exited unexpectedly'
    this.setStatus(code === 0 ? 'stopped' : 'error', message)
  }

  async isGatewayReady() {
    for (const readyPath of READY_PATHS) {
      if (await canHttpGet(`${this.getChatUrl()}${readyPath}`)) {
        return true
      }
    }
    return false
  }

  async waitForGatewayReady(timeoutMs = 30000) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      if (!this.child) return false
      if (await this.isGatewayReady()) return true
      await wait(400)
    }
    return false
  }

  async openChat() {
    await this.shell.openExternal(this.getOpenChatUrl())
    return {
      success: true,
      url: this.getChatUrl()
    }
  }

  async start(options = {}) {
    const openChat = options.openChat === true
    if (!this.isConfigured()) {
      return {
        success: false,
        message: 'LLM is not configured yet'
      }
    }

    this.port = this.getGatewayPort()
    const readyOnPort = await this.isGatewayReady()
    const persistedPid = this.readPersistedPid()
    const ownsPersistedGateway = processExists(persistedPid)
    const ownedPortPid = readyOnPort ? this.findOwnedGatewayPid(this.port) : null

    if (this.status === 'running' && readyOnPort) {
      if (ownedPortPid) this.persistPid(ownedPortPid)
      if (openChat) await this.openChat()
      return {
        success: true,
        alreadyRunning: true,
        url: this.getChatUrl()
      }
    }

    if (readyOnPort) {
      if (ownsPersistedGateway) {
        this.setStatus('running')
        if (openChat) await this.openChat()
        return {
          success: true,
          alreadyRunning: true,
          url: this.getChatUrl()
        }
      }

      if (ownedPortPid) {
        this.persistPid(ownedPortPid)
        this.setStatus('running')
        if (openChat) await this.openChat()
        return {
          success: true,
          alreadyRunning: true,
          url: this.getChatUrl()
        }
      }

      const message = `Port ${this.port} is already in use by another OpenClaw/ClawLite gateway. Stop the other app or change the gateway port before retrying.`
      this.setStatus('error', message)
      return {
        success: false,
        message
      }
    }

    if (this.status === 'starting') {
      return {
        success: false,
        message: 'OpenClaw is already starting'
      }
    }

    if (this.child?.pid) {
      await this.stop()
    }
    await this.cleanupStaleRuntime()

    try {
      this.validateRuntimeResources()
    } catch (error) {
      this.appendLog('error', error.message)
      this.setStatus('error', error.message)
      return { success: false, message: error.message }
    }

    this.setStatus('starting')
    this.appendLog('system', `Starting OpenClaw from ${this.runtimeDir}`)

    const child = this.spawnFn(
      this.launchSpec.command,
      [...(this.launchSpec.args || []), 'gateway', '--port', String(this.port)],
      {
        cwd: this.statePaths.workspaceDir,
        shell: this.launchSpec.shell,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: 'production',
          OPENCLAW_GATEWAY_PORT: String(this.port),
          OPENCLAW_STATE_DIR: this.statePaths.stateDir,
          CLAWDBOT_STATE_DIR: this.statePaths.stateDir,
          OPENCLAW_CONFIG_PATH: this.statePaths.openclawConfigPath,
          CLAWDBOT_CONFIG_PATH: this.statePaths.openclawConfigPath
        }
      }
    )

    this.child = child
    this.bindChildProcess(child)

    const spawnResult = await waitForProcessSpawn(child, 'OpenClaw gateway')
    if (!spawnResult.success) {
      this.child = null
      this.setStatus('error', spawnResult.message)
      return spawnResult
    }
    const ready = await this.waitForGatewayReady()
    if (!ready) {
      const exitedEarly = !this.child
      const adoptedPid = this.adoptOwnedGatewayPid(this.port)
      if (adoptedPid) {
        await this.stop()
      }
      await this.stop()
      const message = exitedEarly
        ? this.getStartupFailureMessage()
        : 'OpenClaw gateway did not become ready in time'
      this.setStatus('error', message)
      return {
        success: false,
        message
      }
    }

    const adoptedPid = this.adoptOwnedGatewayPid(this.port)
    if (adoptedPid && adoptedPid !== child.pid) {
      this.appendLog('system', `Adopted running OpenClaw gateway pid=${adoptedPid}`)
    } else {
      this.persistPid(child.pid)
    }
    this.setStatus('running')
    if (openChat) await this.openChat()
    return {
      success: true,
      url: this.getChatUrl()
    }
  }

  async stop() {
    const pids = this.getKnownProcessPids()

    if (pids.length === 0) {
      this.clearPersistedPid()
      this.setStatus('stopped')
      return { success: true }
    }

    this.stopping = true
    for (const pid of pids) {
      await killProcess(pid, 'SIGTERM')
      const exited = await waitForProcessExit(pid, 5000)
      if (!exited) {
        await killProcess(pid, 'SIGKILL')
        await waitForProcessExit(pid, 1500)
      }
    }
    this.child = null
    this.clearPersistedPid()
    this.stopping = false
    this.setStatus('stopped')
    return { success: true }
  }

  async cleanupStaleRuntime() {
    const pid = this.readPersistedPid()
    if (!pid) return { success: true, cleaned: false }
    if (this.child?.pid === pid) return { success: true, cleaned: false }
    if (!processExists(pid)) {
      this.clearPersistedPid()
      return { success: true, cleaned: false }
    }

    this.appendLog('system', `Stopping stale OpenClaw gateway pid=${pid}`)
    await killProcess(pid, 'SIGTERM')
    const exited = await waitForProcessExit(pid, 4000)
    if (!exited) {
      await killProcess(pid, 'SIGKILL')
      await waitForProcessExit(pid, 1500)
    }
    this.clearPersistedPid()
    return { success: true, cleaned: true }
  }

  async restart(options = {}) {
    await this.stop()
    return this.start(options)
  }
}

module.exports = {
  OpenClawRuntime
}
