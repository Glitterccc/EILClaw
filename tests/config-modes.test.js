const test = require('node:test')
const assert = require('node:assert/strict')

const {
  CONFIG_MODES,
  createAuthProfiles,
  createOpenClawConfig,
  inferCurrentConfig,
  migrateImageCapableModelInputs,
  normalizeBaseUrl,
  resolveModelInputs,
  resolveUserConfig
} = require('../electron/services/config-modes')

test('normalizeBaseUrl adds /v1 only for origin roots', () => {
  assert.equal(normalizeBaseUrl('https://api.example.com'), 'https://api.example.com/v1')
  assert.equal(normalizeBaseUrl('https://api.example.com/'), 'https://api.example.com/v1')
  assert.equal(normalizeBaseUrl('https://api.example.com/compatible-mode/v1'), 'https://api.example.com/compatible-mode/v1')
})

test('MiniMax Bailian mode requires exact MiniMax-M2.5 model id', () => {
  assert.throws(
    () => resolveUserConfig({
      mode: CONFIG_MODES.minimax_bailian,
      values: {
        apiKey: 'sk-test',
        model: 'minimax-m2.5'
      }
    }),
    /MiniMax-M2.5/
  )
})

test('resolves NewAPI mode with fixed base URL and editable model', () => {
  const normalized = resolveUserConfig({
    mode: CONFIG_MODES.minimax_newapi,
    values: {
      apiKey: 'sk-test',
      model: 'gpt-4.1-mini'
    }
  })

  assert.equal(normalized.resolved.providerId, 'api-proxy-newapi')
  assert.equal(normalized.resolved.authProfileId, 'api-proxy-newapi:default')
  assert.equal(normalized.resolved.baseUrl, 'https://api2.aigcbest.top/v1')
  assert.equal(normalized.resolved.modelId, 'gpt-4.1-mini')
})

test('marks gpt-5 family as image-capable by default', () => {
  assert.deepEqual(resolveModelInputs('gpt-5.4-2026-03-05'), ['text', 'image'])
  assert.deepEqual(resolveModelInputs('gpt-4.1-mini'), ['text', 'image'])
  assert.deepEqual(resolveModelInputs('MiniMax-M2.5'), ['text'])
})

test('generates OpenClaw config with auth order and primary model', () => {
  const normalized = resolveUserConfig({
    mode: CONFIG_MODES.advanced,
    values: {
      providerId: 'my_proxy',
      baseUrl: 'https://llm.example.com',
      apiKey: 'sk-test',
      modelId: 'model-x'
    }
  })

  const openclawConfig = createOpenClawConfig({
    resolvedConfig: normalized.resolved,
    workspaceDir: '/tmp/workspace'
  })
  const authProfiles = createAuthProfiles(normalized.resolved)

  assert.equal(openclawConfig.auth.order.my_proxy[0], 'my_proxy:default')
  assert.equal(openclawConfig.agents.defaults.model.primary, 'my_proxy/model-x')
  assert.equal(authProfiles.profiles['my_proxy:default'].provider, 'my_proxy')
  assert.equal(authProfiles.profiles['my_proxy:default'].key, 'sk-test')
})

test('generates image-capable model definitions for multimodal models', () => {
  const normalized = resolveUserConfig({
    mode: CONFIG_MODES.minimax_newapi,
    values: {
      apiKey: 'sk-test',
      model: 'gpt-5.4-2026-03-05'
    }
  })

  const openclawConfig = createOpenClawConfig({
    resolvedConfig: normalized.resolved,
    workspaceDir: '/tmp/workspace'
  })

  assert.deepEqual(
    openclawConfig.models.providers['api-proxy-newapi'].models[0].input,
    ['text', 'image']
  )
})

test('can infer a saved OpenAI-compatible launcher config from generated files', () => {
  const normalized = resolveUserConfig({
    mode: CONFIG_MODES.openai_compatible,
    values: {
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test',
      model: 'gpt-lite'
    }
  })

  const openclawConfig = createOpenClawConfig({
    resolvedConfig: normalized.resolved,
    workspaceDir: '/tmp/workspace'
  })
  const authProfiles = createAuthProfiles(normalized.resolved)
  const inferred = inferCurrentConfig({
    openclawConfig,
    authProfiles
  })

  assert.equal(inferred.mode, CONFIG_MODES.openai_compatible)
  assert.equal(inferred.values.baseUrl, 'https://api.example.com/v1')
  assert.equal(inferred.values.model, 'gpt-lite')
})

test('createOpenClawConfig preserves existing gateway auth and runtime metadata', () => {
  const normalized = resolveUserConfig({
    mode: CONFIG_MODES.minimax_newapi,
    values: {
      apiKey: 'sk-test',
      model: 'MiniMax-M2.5'
    }
  })

  const openclawConfig = createOpenClawConfig({
    resolvedConfig: normalized.resolved,
    workspaceDir: '/tmp/workspace',
    existingConfig: {
      gateway: {
        port: 12345,
        auth: {
          mode: 'token',
          token: 'persist-me'
        },
        rateLimit: {
          maxAttempts: 3
        }
      },
      meta: {
        lastTouchedVersion: '2026.3.1'
      }
    }
  })

  assert.equal(openclawConfig.gateway.port, 38789)
  assert.equal(openclawConfig.gateway.auth.token, 'persist-me')
  assert.equal(openclawConfig.gateway.rateLimit.maxAttempts, 3)
  assert.equal(openclawConfig.meta.lastTouchedVersion, '2026.3.1')
})

test('can infer a saved legacy NewAPI launcher config from generated files', () => {
  const inferred = inferCurrentConfig({
    openclawConfig: {
      models: {
        providers: {
          'api-proxy-newapi-minimax': {
            baseUrl: 'https://api2.aigcbest.top/v1',
            api: 'openai-completions',
            models: [
              {
                id: 'claude-3.7-sonnet',
                name: 'claude-3.7-sonnet',
                contextWindow: 200000,
                maxTokens: 8192
              }
            ]
          }
        }
      }
    },
    authProfiles: {
      profiles: {
        'api-proxy-newapi-minimax:default': {
          provider: 'api-proxy-newapi-minimax',
          key: 'sk-test'
        }
      }
    }
  })

  assert.equal(inferred.mode, CONFIG_MODES.minimax_newapi)
  assert.equal(inferred.values.apiKey, 'sk-test')
  assert.equal(inferred.values.model, 'claude-3.7-sonnet')
  assert.equal(inferred.resolved.providerId, 'api-proxy-newapi-minimax')
})

test('migrates saved image-capable models from text-only to multimodal input', () => {
  const migrated = migrateImageCapableModelInputs({
    models: {
      providers: {
        'api-proxy-newapi': {
          baseUrl: 'https://api2.aigcbest.top/v1',
          api: 'openai-completions',
          models: [
            {
              id: 'gpt-5.4',
              name: 'gpt-5.4',
              input: ['text']
            },
            {
              id: 'MiniMax-M2.5',
              name: 'MiniMax-M2.5',
              input: ['text']
            }
          ]
        }
      }
    }
  })

  assert.equal(migrated.changed, true)
  assert.deepEqual(
    migrated.config.models.providers['api-proxy-newapi'].models[0].input,
    ['text', 'image']
  )
  assert.deepEqual(
    migrated.config.models.providers['api-proxy-newapi'].models[1].input,
    ['text']
  )
})
