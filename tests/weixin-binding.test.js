const test = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { WeixinBindingService, extractScanUrl, stripAnsi } = require('../electron/services/weixin-binding')
const { resolveStatePaths } = require('../electron/utils/runtime-paths')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eil-claw-weixin-'))
}

function createFakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.pid = 43210
  return child
}

function writePluginFixture(pluginDir, version = '1.0.3') {
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.mkdirSync(path.join(pluginDir, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'openclaw.plugin.json'), '{}', 'utf8')
  fs.writeFileSync(path.join(pluginDir, 'index.ts'), 'export default {}', 'utf8')
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
    name: '@tencent-weixin/openclaw-weixin',
    version
  }), 'utf8')
}

function installPluginFixture(statePaths, version = '1.0.3') {
  const pluginDir = path.join(statePaths.stateDir, 'extensions', 'openclaw-weixin')
  writePluginFixture(pluginDir, version)
}

function createBundledPluginFixture(rootDir, version = '1.0.3') {
  const pluginDir = path.join(rootDir, 'bundled-plugins', 'openclaw-weixin')
  writePluginFixture(pluginDir, version)
  return pluginDir
}

function writePluginEnabledConfig(statePaths) {
  fs.writeFileSync(statePaths.openclawConfigPath, JSON.stringify({
    gateway: { port: 38789 },
    plugins: {
      entries: {
        'openclaw-weixin': {
          enabled: true
        }
      }
    }
  }), 'utf8')
}

test('stripAnsi removes terminal color sequences', () => {
  assert.equal(stripAnsi('\u001b[31mhello\u001b[0m'), 'hello')
})

test('extractScanUrl prefers WeChat liteapp links', () => {
  const line = 'open https://example.com/test https://liteapp.weixin.qq.com/q/abcdef?qrcode=1'
  assert.equal(extractScanUrl(line), 'https://liteapp.weixin.qq.com/q/abcdef?qrcode=1')
})

test('weixin service logs in with bundled openclaw and launcher state paths once plugin is installed', async () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  fs.mkdirSync(statePaths.workspaceDir, { recursive: true })
  const bundledPluginDir = createBundledPluginFixture(userDataDir)
  writePluginEnabledConfig(statePaths)
  installPluginFixture(statePaths)

  let spawnArgs = null
  const child = createFakeChild()
  const service = new WeixinBindingService({
    app: {
      getAppPath: () => path.resolve(__dirname, '..'),
      isPackaged: false
    },
    shell: {
      openExternal: async () => {}
    },
    statePaths,
    bundledPluginDir,
    qrcodeLib: {
      toDataURL: async (value) => `data:${value}`
    },
    spawnFn: (command, args, options) => {
      spawnArgs = { command, args, options }
      return child
    }
  })

  const result = await service.start()
  assert.equal(result.success, true)
  assert.match(spawnArgs.command, /node-runtime\/(npm_global\/(?:\.bin|bin)\/openclaw|nodejs\/bin\/node)$/)
  assert.deepEqual(spawnArgs.args.slice(-4), ['channels', 'login', '--channel', 'openclaw-weixin'])
  assert.equal(spawnArgs.options.env.OPENCLAW_STATE_DIR, statePaths.stateDir)
  assert.equal(spawnArgs.options.env.OPENCLAW_CONFIG_PATH, statePaths.openclawConfigPath)
  assert.match(spawnArgs.options.env.PATH, /node-runtime\/nodejs\/bin/)
  assert.match(spawnArgs.options.env.PATH, /npm_global\/bin/)
})

test('weixin service prepares plugin from bundled runtime resources when missing', async () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  fs.mkdirSync(statePaths.workspaceDir, { recursive: true })
  const bundledPluginDir = createBundledPluginFixture(userDataDir, '1.0.4')
  fs.writeFileSync(statePaths.openclawConfigPath, JSON.stringify({ gateway: { port: 38789 } }), 'utf8')

  let pluginReadyCount = 0
  const service = new WeixinBindingService({
    app: {
      getAppPath: () => path.resolve(__dirname, '..'),
      isPackaged: false
    },
    shell: {
      openExternal: async () => {}
    },
    statePaths,
    bundledPluginDir,
    qrcodeLib: {
      toDataURL: async (value) => `data:${value}`
    },
    onPluginReady: async () => {
      pluginReadyCount += 1
    },
    spawnFn: () => {
      throw new Error('preparePluginIfNeeded should not invoke external install commands')
    }
  })

  const result = await service.preparePluginIfNeeded({ logToSnapshot: true })
  const pluginDir = path.join(statePaths.stateDir, 'extensions', 'openclaw-weixin')
  const config = JSON.parse(fs.readFileSync(statePaths.openclawConfigPath, 'utf8'))

  assert.equal(result.success, true)
  assert.equal(pluginReadyCount, 1)
  assert.equal(fs.existsSync(path.join(pluginDir, 'openclaw.plugin.json')), true)
  assert.equal(fs.existsSync(path.join(pluginDir, 'node_modules')), true)
  assert.equal(config.plugins.entries['openclaw-weixin'].enabled, true)
  assert.equal(config.plugins.installs['openclaw-weixin'].source, 'path')
  assert.equal(config.plugins.installs['openclaw-weixin'].sourcePath, bundledPluginDir)
  assert.equal(config.plugins.installs['openclaw-weixin'].installPath, pluginDir)
  assert.equal(config.plugins.installs['openclaw-weixin'].version, '1.0.4')
  assert.match(service.getSnapshot().logs.join('\n'), /App 内置 runtime 同步微信插件/)
})

test('weixin service repairs a legacy invalid bundled install record before login', async () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  fs.mkdirSync(statePaths.workspaceDir, { recursive: true })
  const bundledPluginDir = createBundledPluginFixture(userDataDir, '1.0.4')
  installPluginFixture(statePaths, '1.0.4')
  fs.writeFileSync(statePaths.openclawConfigPath, JSON.stringify({
    gateway: { port: 38789 },
    plugins: {
      entries: {
        'openclaw-weixin': { enabled: true }
      },
      installs: {
        'openclaw-weixin': {
          source: 'bundled',
          installPath: path.join(statePaths.stateDir, 'extensions', 'openclaw-weixin'),
          version: '1.0.4'
        }
      }
    }
  }), 'utf8')

  const child = createFakeChild()
  const service = new WeixinBindingService({
    app: {
      getAppPath: () => path.resolve(__dirname, '..'),
      isPackaged: false
    },
    shell: {
      openExternal: async () => {}
    },
    statePaths,
    bundledPluginDir,
    qrcodeLib: {
      toDataURL: async (value) => `data:${value}`
    },
    spawnFn: () => child
  })

  const result = await service.start()
  const config = JSON.parse(fs.readFileSync(statePaths.openclawConfigPath, 'utf8'))

  assert.equal(result.success, true)
  assert.equal(config.plugins.installs['openclaw-weixin'].source, 'path')
  assert.equal(config.plugins.installs['openclaw-weixin'].sourcePath, bundledPluginDir)
  assert.equal(config.plugins.installs['openclaw-weixin'].installPath, path.join(statePaths.stateDir, 'extensions', 'openclaw-weixin'))
})

test('weixin service extracts scan URL and generates QR data URL', async () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  fs.mkdirSync(statePaths.workspaceDir, { recursive: true })
  const bundledPluginDir = createBundledPluginFixture(userDataDir)
  writePluginEnabledConfig(statePaths)
  installPluginFixture(statePaths)

  const child = createFakeChild()
  const service = new WeixinBindingService({
    app: {
      getAppPath: () => path.resolve(__dirname, '..'),
      isPackaged: false
    },
    shell: {
      openExternal: async () => {}
    },
    statePaths,
    bundledPluginDir,
    qrcodeLib: {
      toDataURL: async (value) => `data:${value}`
    },
    spawnFn: () => child
  })

  await service.start()
  child.stdout.emit('data', '请扫码 https://liteapp.weixin.qq.com/q/abc?qrcode=123\n')
  await new Promise((resolve) => setImmediate(resolve))
  const snapshot = service.getSnapshot()

  assert.equal(snapshot.state, 'waiting_scan')
  assert.equal(snapshot.scanUrl, 'https://liteapp.weixin.qq.com/q/abc?qrcode=123')
  assert.equal(snapshot.qrDataUrl, 'data:https://liteapp.weixin.qq.com/q/abc?qrcode=123')
})

test('weixin service restarts launcher-managed gateway after successful bind even if plugin restart fails', async () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  fs.mkdirSync(statePaths.workspaceDir, { recursive: true })
  const bundledPluginDir = createBundledPluginFixture(userDataDir)
  writePluginEnabledConfig(statePaths)
  installPluginFixture(statePaths)

  const child = createFakeChild()
  let restartCount = 0
  const service = new WeixinBindingService({
    app: {
      getAppPath: () => path.resolve(__dirname, '..'),
      isPackaged: false
    },
    shell: {
      openExternal: async () => {}
    },
    statePaths,
    bundledPluginDir,
    qrcodeLib: {
      toDataURL: async (value) => `data:${value}`
    },
    onBindingSuccess: async () => {
      restartCount += 1
      return {
        message: 'EIL Claw Gateway 已重启，微信绑定现在应该已经生效。'
      }
    },
    spawnFn: () => child
  })

  await service.start()
  child.stdout.emit('data', '✅ 与微信连接成功！\n')
  child.stdout.emit('data', 'Gateway service not loaded.\n')
  child.emit('exit', 1)
  await new Promise((resolve) => setImmediate(resolve))

  const snapshot = service.getSnapshot()
  assert.equal(restartCount, 1)
  assert.equal(snapshot.state, 'succeeded')
  assert.match(snapshot.logs.join('\n'), /正在重启 EIL Claw Gateway/)
  assert.match(snapshot.logs.join('\n'), /微信绑定现在应该已经生效/)
})

test('weixin service surfaces launcher restart failure after successful bind', async () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  fs.mkdirSync(statePaths.workspaceDir, { recursive: true })
  const bundledPluginDir = createBundledPluginFixture(userDataDir)
  writePluginEnabledConfig(statePaths)
  installPluginFixture(statePaths)

  const child = createFakeChild()
  const service = new WeixinBindingService({
    app: {
      getAppPath: () => path.resolve(__dirname, '..'),
      isPackaged: false
    },
    shell: {
      openExternal: async () => {}
    },
    statePaths,
    bundledPluginDir,
    qrcodeLib: {
      toDataURL: async (value) => `data:${value}`
    },
    onBindingSuccess: async () => {
      throw new Error('EIL Claw Gateway 重启失败')
    },
    spawnFn: () => child
  })

  await service.start()
  child.stdout.emit('data', '✅ 与微信连接成功！\n')
  child.emit('exit', 1)
  await new Promise((resolve) => setImmediate(resolve))

  const snapshot = service.getSnapshot()
  assert.equal(snapshot.state, 'failed')
  assert.equal(snapshot.lastError, 'EIL Claw Gateway 重启失败')
  assert.match(snapshot.logs.join('\n'), /EIL Claw Gateway 重启失败/)
})

test('weixin service does not start a second login while one is running', async () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  fs.mkdirSync(statePaths.workspaceDir, { recursive: true })
  const bundledPluginDir = createBundledPluginFixture(userDataDir)
  writePluginEnabledConfig(statePaths)
  installPluginFixture(statePaths)

  let spawnCount = 0
  const child = createFakeChild()
  const service = new WeixinBindingService({
    app: {
      getAppPath: () => path.resolve(__dirname, '..'),
      isPackaged: false
    },
    shell: {
      openExternal: async () => {}
    },
    statePaths,
    bundledPluginDir,
    qrcodeLib: {
      toDataURL: async (value) => `data:${value}`
    },
    spawnFn: () => {
      spawnCount += 1
      return child
    }
  })

  await service.start()
  await service.start()

  assert.equal(spawnCount, 1)
})
