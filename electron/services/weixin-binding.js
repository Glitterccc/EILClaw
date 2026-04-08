const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const QRCode = require('qrcode')
const { resolveRuntimeDir, resolveOpenClawLaunchSpec, resolveBundledPluginDir } = require('../utils/runtime-paths')
const {
  needsBundledPluginSync,
  syncBundledPluginToState,
  ensureBundledPluginEnabled,
  readPluginManifest
} = require('./bundled-plugin-sync')

const MAX_LOG_ENTRIES = 400
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g
const WEIXIN_CONNECTED_PATTERN = /(与微信连接成功|微信连接成功|wechat connected)/i
const WEIXIN_PLUGIN_ID = 'openclaw-weixin'
const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:' +
    '(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]' +
    '|(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007' +
    ')',
  'g'
)

function stripAnsi(value) {
  return String(value || '').replace(ANSI_PATTERN, '')
}

function extractScanUrl(value) {
  const urls = String(value || '').match(URL_PATTERN) || []
  const preferred = urls.find((candidate) => candidate.includes('liteapp.weixin.qq.com'))
  if (preferred) return preferred
  return urls.find((candidate) => candidate.includes('qrcode=')) || urls[0] || ''
}

async function killProcessTree(pid, signal = 'SIGTERM') {
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

class WeixinBindingService extends EventEmitter {
  constructor({
    app,
    shell,
    statePaths,
    spawnFn = spawn,
    qrcodeLib = QRCode,
    onBindingSuccess = null,
    onPluginReady = null,
    bundledPluginDir = null
  }) {
    super()
    this.app = app
    this.shell = shell
    this.statePaths = statePaths
    this.spawnFn = spawnFn
    this.qrcodeLib = qrcodeLib
    this.onBindingSuccess = onBindingSuccess
    this.onPluginReady = onPluginReady
    this.runtimeDir = resolveRuntimeDir({ app, isPackaged: app.isPackaged })
    this.openclawLaunchSpec = resolveOpenClawLaunchSpec(this.runtimeDir)
    this.bundledPluginDir = bundledPluginDir || resolveBundledPluginDir({ app, isPackaged: app.isPackaged }, WEIXIN_PLUGIN_ID)
    this.child = null
    this.cancelling = false
    this.bindingConnected = false
    this.preparePromise = null
    this.snapshot = this.createSnapshot()
  }

  createSnapshot() {
    return {
      state: 'idle',
      startedAt: null,
      exitCode: null,
      logs: [],
      scanUrl: '',
      qrDataUrl: '',
      lastError: ''
    }
  }

  getSnapshot() {
    return {
      ...this.snapshot,
      logs: [...this.snapshot.logs]
    }
  }

  emitUpdate() {
    this.emit('update', this.getSnapshot())
  }

  isRunning() {
    return Boolean(this.child)
  }

  getTrackedPid() {
    return this.child?.pid || null
  }

  resetSnapshot() {
    this.snapshot = this.createSnapshot()
    this.bindingConnected = false
  }

  setState(nextState, updates = {}) {
    this.snapshot = {
      ...this.snapshot,
      ...updates,
      state: nextState
    }
    this.emitUpdate()
  }

  appendLog(source, chunk) {
    const cleaned = stripAnsi(chunk)
    if (!cleaned.trim()) return

    for (const line of cleaned.split(/\r?\n/)) {
      const nextLine = line.trimEnd()
      if (!nextLine) continue
      if (WEIXIN_CONNECTED_PATTERN.test(nextLine)) {
        this.bindingConnected = true
      }
      this.snapshot.logs.push(`[${source}] ${nextLine}`)
    }
    this.snapshot.logs = this.snapshot.logs.slice(-MAX_LOG_ENTRIES)
    this.emitUpdate()

    const scanUrl = extractScanUrl(cleaned)
    if (scanUrl && scanUrl !== this.snapshot.scanUrl) {
      this.updateScanUrl(scanUrl).catch((error) => {
        this.snapshot.lastError = error.message || 'Failed to generate QR code'
        this.emitUpdate()
      })
    }
  }

  async updateScanUrl(scanUrl) {
    const qrDataUrl = await this.qrcodeLib.toDataURL(scanUrl, {
      margin: 1,
      width: 280
    })
    this.snapshot.scanUrl = scanUrl
    this.snapshot.qrDataUrl = qrDataUrl
    if (this.snapshot.state === 'starting') {
      this.snapshot.state = 'waiting_scan'
    }
    this.emitUpdate()
  }

  buildSpawnOptions() {
    const runtimeBinDir = path.join(this.runtimeDir, 'nodejs', 'bin')
    const npmGlobalBinDir = path.join(this.runtimeDir, 'npm_global', 'bin')
    const npmGlobalNodeBinDir = path.join(this.runtimeDir, 'npm_global', 'node_modules', '.bin')
    const nextPath = [
      runtimeBinDir,
      npmGlobalBinDir,
      npmGlobalNodeBinDir,
      process.env.PATH || ''
    ].filter(Boolean).join(path.delimiter)

    return {
      cwd: this.statePaths.workspaceDir,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: nextPath,
        OPENCLAW_STATE_DIR: this.statePaths.stateDir,
        CLAWDBOT_STATE_DIR: this.statePaths.stateDir,
        OPENCLAW_CONFIG_PATH: this.statePaths.openclawConfigPath,
        CLAWDBOT_CONFIG_PATH: this.statePaths.openclawConfigPath,
        npm_config_cache: path.join(this.statePaths.stateDir, 'npm-cache')
      }
    }
  }

  getPluginInstallPath() {
    return path.join(this.statePaths.stateDir, 'extensions', WEIXIN_PLUGIN_ID)
  }

  isPluginInstalled() {
    const pluginPath = this.getPluginInstallPath()
    return fs.existsSync(path.join(pluginPath, 'openclaw.plugin.json')) &&
      fs.existsSync(path.join(pluginPath, 'index.ts'))
  }

  isPluginEnabled() {
    if (!fs.existsSync(this.statePaths.openclawConfigPath)) {
      return false
    }

    try {
      const config = JSON.parse(fs.readFileSync(this.statePaths.openclawConfigPath, 'utf8'))
      return config?.plugins?.entries?.[WEIXIN_PLUGIN_ID]?.enabled === true
    } catch {
      return false
    }
  }

  needsPluginPreparation() {
    return needsBundledPluginSync({
      sourceDir: this.bundledPluginDir,
      targetDir: this.getPluginInstallPath()
    }) || !this.isPluginEnabled()
  }

  buildOpenClawSpawnPlan(extraArgs) {
    return {
      command: this.openclawLaunchSpec.command,
      args: [...(this.openclawLaunchSpec.args || []), ...extraArgs],
      options: {
        ...this.buildSpawnOptions(),
        shell: Boolean(this.openclawLaunchSpec.shell)
      }
    }
  }

  spawnTrackedProcess(plan, onExit) {
    const child = this.spawnFn(plan.command, plan.args, plan.options)
    this.child = child
    this.cancelling = false

    child.stdout?.on('data', (chunk) => {
      this.appendLog('stdout', chunk)
    })
    child.stderr?.on('data', (chunk) => {
      this.appendLog('stderr', chunk)
    })
    child.on('error', (error) => {
      this.child = null
      this.setState('failed', {
        lastError: error.message || 'Failed to start WeChat binding'
      })
    })
    child.on('exit', (code) => {
      this.child = null
      Promise.resolve(onExit(code ?? null)).catch((error) => {
        const message = error.message || 'WeChat binding exited unexpectedly'
        this.appendLog('launcher', message)
        this.setState('failed', {
          exitCode: code ?? null,
          lastError: message
        })
      })
    })

    return child
  }

  async ensurePluginReady() {
    if (!this.onPluginReady) {
      return { success: true }
    }

    await this.onPluginReady()
    return { success: true }
  }

  async preparePluginIfNeeded({ logToSnapshot = false } = {}) {
    if (!this.needsPluginPreparation()) {
      const enableResult = ensureBundledPluginEnabled({
        openclawConfigPath: this.statePaths.openclawConfigPath,
        pluginId: WEIXIN_PLUGIN_ID,
        sourceDir: this.bundledPluginDir,
        targetDir: this.getPluginInstallPath(),
        manifest: readPluginManifest(this.bundledPluginDir)
      })

      if (!enableResult.success) {
        return {
          success: false,
          message: enableResult.message || '启用微信插件失败'
        }
      }

      await this.ensurePluginReady()
      return {
        success: true,
        installed: enableResult.changed
      }
    }

    if (this.preparePromise) {
      return this.preparePromise
    }

    const appendInstallLog = logToSnapshot
      ? (source, chunk) => this.appendLog(source, chunk)
      : () => {}

    this.preparePromise = (async () => {
      const syncResult = syncBundledPluginToState({
        sourceDir: this.bundledPluginDir,
        statePaths: this.statePaths,
        pluginId: WEIXIN_PLUGIN_ID
      })

      if (!syncResult.success) {
        return {
          success: false,
          message: syncResult.message || '微信插件同步失败'
        }
      }

      if (syncResult.synced) {
        appendInstallLog('launcher', '已从 App 内置 runtime 同步微信插件。')
      } else if (!this.isPluginInstalled()) {
        return {
          success: false,
          message: '微信插件未能同步到本地状态目录。'
        }
      }

      const enableResult = ensureBundledPluginEnabled({
        openclawConfigPath: this.statePaths.openclawConfigPath,
        pluginId: WEIXIN_PLUGIN_ID,
        sourceDir: this.bundledPluginDir,
        targetDir: this.getPluginInstallPath(),
        manifest: syncResult.manifest
      })

      if (!enableResult.success) {
        return {
          success: false,
          message: enableResult.message || '启用微信插件失败'
        }
      }

      if (enableResult.changed) {
        appendInstallLog('launcher', '已为当前 OpenClaw 配置启用微信插件。')
      }

      await this.ensurePluginReady()
      appendInstallLog('launcher', '微信插件已准备完成。')
      return {
        success: true,
        installed: syncResult.synced || enableResult.changed
      }
    })()

    try {
      return await this.preparePromise
    } finally {
      this.preparePromise = null
    }
  }

  async start() {
    if (this.child) return { success: true, alreadyRunning: true, snapshot: this.getSnapshot() }

    this.resetSnapshot()
    this.setState('installing_plugin', {
      startedAt: new Date().toISOString()
    })

    const prepareResult = await this.preparePluginIfNeeded({ logToSnapshot: true })
    if (!prepareResult.success) {
      this.setState('failed', {
        lastError: prepareResult.message || '微信插件准备失败'
      })
      return {
        success: false,
        message: prepareResult.message || '微信插件准备失败',
        snapshot: this.getSnapshot()
      }
    }

    this.appendLog('launcher', '微信插件已准备，正在启动扫码登录...')
    this.setState('starting', {
      lastError: ''
    })

    this.spawnTrackedProcess(
      this.buildOpenClawSpawnPlan(['channels', 'login', '--channel', WEIXIN_PLUGIN_ID]),
      async (exitCode) => {
        if (this.cancelling) {
          this.cancelling = false
          this.setState('cancelled', {
            exitCode
          })
          return
        }

        if (this.bindingConnected || exitCode === 0) {
          await this.finalizeSuccessfulBinding(exitCode)
          return
        }

        this.setState('failed', {
          exitCode,
          lastError: this.snapshot.lastError || 'WeChat binding exited unexpectedly'
        })
      }
    )

    return { success: true, snapshot: this.getSnapshot() }
  }

  async cancel() {
    if (!this.child?.pid) {
      if (this.snapshot.state === 'installing_plugin' || this.snapshot.state === 'starting' || this.snapshot.state === 'waiting_scan') {
        this.setState('cancelled')
      }
      return { success: true, snapshot: this.getSnapshot() }
    }

    this.cancelling = true
    await killProcessTree(this.child.pid, 'SIGTERM')
    return { success: true, snapshot: this.getSnapshot() }
  }

  async openScanUrl() {
    if (!this.snapshot.scanUrl) {
      return {
        success: false,
        message: 'No scan URL is available yet'
      }
    }
    await this.shell.openExternal(this.snapshot.scanUrl)
    return {
      success: true,
      url: this.snapshot.scanUrl
    }
  }

  async finalizeSuccessfulBinding(exitCode) {
    if (!this.onBindingSuccess) {
      this.setState('succeeded', {
        exitCode
      })
      return
    }

    this.appendLog('launcher', '微信绑定完成，正在重启 EIL Claw Gateway...')
    this.setState('restarting_gateway', {
      exitCode,
      lastError: ''
    })

    try {
      const result = await this.onBindingSuccess({
        exitCode,
        snapshot: this.getSnapshot()
      })
      this.appendLog('launcher', result?.message || 'EIL Claw Gateway 已重启，新绑定已生效。')
      this.setState('succeeded', {
        exitCode,
        lastError: ''
      })
    } catch (error) {
      const message = error.message || '微信绑定成功，但重启 EIL Claw Gateway 失败'
      this.appendLog('launcher', message)
      this.setState('failed', {
        exitCode,
        lastError: message
      })
    }
  }
}

module.exports = {
  WeixinBindingService,
  extractScanUrl,
  stripAnsi
}
