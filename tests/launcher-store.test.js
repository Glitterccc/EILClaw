const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { LauncherStore } = require('../electron/services/launcher-store')
const { resolveStatePaths } = require('../electron/utils/runtime-paths')
const { resolveUserConfig } = require('../electron/services/config-modes')
const { writeJsonAtomic, readJson } = require('../electron/services/file-store')

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-launcher-store-'))
}

test('LauncherStore.saveResolvedConfig preserves existing gateway auth token', () => {
  const userDataDir = makeTempDir()
  const paths = resolveStatePaths(userDataDir)
  fs.mkdirSync(paths.stateDir, { recursive: true })

  writeJsonAtomic(paths.openclawConfigPath, {
    gateway: {
      port: 28789,
      mode: 'local',
      bind: 'loopback',
      auth: {
        mode: 'token',
        token: 'persist-me'
      }
    },
    meta: {
      lastTouchedVersion: '2026.3.1'
    }
  })

  const store = new LauncherStore(paths)
  const normalized = resolveUserConfig({
    mode: 'openai_compatible',
    values: {
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      model: 'gpt-lite'
    }
  })

  store.saveResolvedConfig(normalized)

  const openclawConfig = readJson(paths.openclawConfigPath)
  assert.equal(openclawConfig.gateway.port, 38789)
  assert.equal(openclawConfig.gateway.auth.token, 'persist-me')
  assert.equal(openclawConfig.meta.lastTouchedVersion, '2026.3.1')
  assert.equal(openclawConfig.agents.defaults.model.primary, 'openai-compatible/gpt-lite')
})

test('LauncherStore.loadCurrentConfig migrates the legacy default gateway port', () => {
  const userDataDir = makeTempDir()
  const paths = resolveStatePaths(userDataDir)
  fs.mkdirSync(paths.stateDir, { recursive: true })
  fs.mkdirSync(paths.agentDir, { recursive: true })

  writeJsonAtomic(paths.openclawConfigPath, {
    gateway: {
      port: 28789,
      mode: 'local',
      bind: 'loopback'
    }
  })
  writeJsonAtomic(paths.authProfilesPath, {
    version: 1,
    profiles: {}
  })
  writeJsonAtomic(paths.launcherConfigPath, {
    mode: 'openai_compatible',
    values: {
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-lite'
    }
  })

  const store = new LauncherStore(paths)
  store.loadCurrentConfig()

  const openclawConfig = readJson(paths.openclawConfigPath)
  assert.equal(openclawConfig.gateway.port, 38789)
})

test('LauncherStore.loadCurrentConfig migrates saved gpt image support declarations', () => {
  const userDataDir = makeTempDir()
  const paths = resolveStatePaths(userDataDir)
  fs.mkdirSync(paths.stateDir, { recursive: true })
  fs.mkdirSync(paths.agentDir, { recursive: true })

  writeJsonAtomic(paths.openclawConfigPath, {
    gateway: {
      port: 38789,
      mode: 'local',
      bind: 'loopback'
    },
    models: {
      providers: {
        'api-proxy-newapi': {
          baseUrl: 'https://api2.aigcbest.top/v1',
          api: 'openai-completions',
          models: [
            {
              id: 'gpt-5.4-2026-03-05',
              name: 'gpt-5.4-2026-03-05',
              input: ['text']
            }
          ]
        }
      }
    }
  })
  writeJsonAtomic(paths.authProfilesPath, {
    version: 1,
    profiles: {
      'api-proxy-newapi:default': {
        provider: 'api-proxy-newapi',
        key: 'sk-test'
      }
    }
  })
  writeJsonAtomic(paths.launcherConfigPath, {
    mode: 'minimax_newapi',
    values: {
      apiKey: 'sk-test',
      model: 'gpt-5.4-2026-03-05'
    },
    resolved: {
      providerId: 'api-proxy-newapi',
      authProfileId: 'api-proxy-newapi:default',
      baseUrl: 'https://api2.aigcbest.top/v1',
      apiKey: 'sk-test',
      modelId: 'gpt-5.4-2026-03-05',
      modelName: 'gpt-5.4-2026-03-05',
      api: 'openai-completions',
      contextWindow: 128000,
      maxTokens: 8192
    }
  })

  const store = new LauncherStore(paths)
  store.loadCurrentConfig()

  const openclawConfig = readJson(paths.openclawConfigPath)
  assert.deepEqual(
    openclawConfig.models.providers['api-proxy-newapi'].models[0].input,
    ['text', 'image']
  )
})
