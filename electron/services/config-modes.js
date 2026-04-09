const { DEFAULT_GATEWAY_PORT } = require('../utils/runtime-paths')

const DEFAULT_CONTEXT_WINDOW = 128000
const DEFAULT_MAX_TOKENS = 8192
const NEWAPI_PROVIDER_ID = 'api-proxy-newapi'
const LEGACY_NEWAPI_PROVIDER_ID = 'api-proxy-newapi-minimax'
const TEXT_ONLY_INPUTS = ['text']
const TEXT_AND_IMAGE_INPUTS = ['text', 'image']
const IMAGE_CAPABLE_MODEL_PATTERNS = [
  /^gpt-5(?:[.-]|$)/,
  /^gpt-4o(?:[.-]|$)/,
  /^gpt-4\.1(?:[.-]|$)/,
  /^gpt-4\.5(?:[.-]|$)/,
  /^claude-3(?:[.-]|$)/,
  /^claude-sonnet-4(?:[.-]|$)/,
  /^claude-opus-4(?:[.-]|$)/,
  /^gemini(?:[.-]|$)/,
  /^glm-4(?:v|\.5v)(?:[.-]|$)/,
  /(?:^|[-_/])vision(?:[-_/]|$)/,
  /(?:^|[-_/])vl(?:[-_/]|$)/
]
const ZERO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0
}

const CONFIG_MODES = {
  openai_compatible: 'openai_compatible',
  minimax_bailian: 'minimax_bailian',
  minimax_newapi: 'minimax_newapi',
  advanced: 'advanced'
}

function assertNonEmpty(value, label) {
  const normalized = String(value || '').trim()
  if (!normalized) {
    throw new Error(`${label} is required`)
  }
  return normalized
}

function normalizeBaseUrl(value) {
  const raw = assertNonEmpty(value, 'Base URL').replace(/\/+$/, '')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('Base URL must be a valid absolute URL')
  }
  const pathname = parsed.pathname.replace(/\/+$/, '')
  if (!pathname || pathname === '/') {
    parsed.pathname = '/v1'
    return parsed.toString().replace(/\/+$/, '')
  }
  return raw
}

function normalizeProviderId(value) {
  const normalized = assertNonEmpty(value, 'Provider ID').toLowerCase()
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(normalized)) {
    throw new Error('Provider ID can only contain letters, numbers, hyphens, and underscores')
  }
  return normalized
}

function normalizeModelRef(value) {
  return String(value || '').trim().toLowerCase()
}

function supportsImageInput(modelId) {
  const normalized = normalizeModelRef(modelId)
  if (!normalized) return false
  return IMAGE_CAPABLE_MODEL_PATTERNS.some((pattern) => pattern.test(normalized))
}

function resolveModelInputs(modelId) {
  return supportsImageInput(modelId) ? [...TEXT_AND_IMAGE_INPUTS] : [...TEXT_ONLY_INPUTS]
}

function createModelDefinition({ modelId, modelName, contextWindow = DEFAULT_CONTEXT_WINDOW, maxTokens = DEFAULT_MAX_TOKENS }) {
  return {
    id: modelId,
    name: modelName,
    reasoning: false,
    input: resolveModelInputs(modelId),
    cost: { ...ZERO_COST },
    contextWindow,
    maxTokens
  }
}

function migrateImageCapableModelInputs(openclawConfig) {
  if (!openclawConfig || typeof openclawConfig !== 'object') {
    return {
      config: openclawConfig,
      changed: false
    }
  }

  const providers = openclawConfig.models?.providers
  if (!providers || typeof providers !== 'object') {
    return {
      config: openclawConfig,
      changed: false
    }
  }

  let changed = false
  const nextProviders = Object.fromEntries(Object.entries(providers).map(([providerId, providerConfig]) => {
    if (!Array.isArray(providerConfig?.models)) {
      return [providerId, providerConfig]
    }

    let providerChanged = false
    const nextModels = providerConfig.models.map((model) => {
      if (!model || typeof model !== 'object') {
        return model
      }

      const modelRef = model.id || model.name
      if (!supportsImageInput(modelRef)) {
        return model
      }

      const expectedInputs = resolveModelInputs(modelRef)
      const currentInputs = Array.isArray(model.input) ? model.input.map((input) => String(input)) : []
      const matches = currentInputs.length === expectedInputs.length && currentInputs.every((input, index) => input === expectedInputs[index])
      if (matches) {
        return model
      }

      providerChanged = true
      changed = true
      return {
        ...model,
        input: expectedInputs
      }
    })

    if (!providerChanged) {
      return [providerId, providerConfig]
    }

    return [
      providerId,
      {
        ...providerConfig,
        models: nextModels
      }
    ]
  }))

  if (!changed) {
    return {
      config: openclawConfig,
      changed: false
    }
  }

  return {
    config: {
      ...openclawConfig,
      models: {
        ...(openclawConfig.models || {}),
        providers: nextProviders
      }
    },
    changed: true
  }
}

function resolveUserConfig(input) {
  const mode = input?.mode
  const values = input?.values || {}
  if (!Object.values(CONFIG_MODES).includes(mode)) {
    throw new Error('Unknown config mode')
  }

  if (mode === CONFIG_MODES.openai_compatible) {
    const modelId = assertNonEmpty(values.model, 'Model')
    const baseUrl = normalizeBaseUrl(values.baseUrl)
    const apiKey = assertNonEmpty(values.apiKey, 'API Key')
    return {
      mode,
      values: {
        baseUrl,
        apiKey,
        model: modelId
      },
      resolved: {
        providerId: 'openai-compatible',
        authProfileId: 'openai-compatible:default',
        baseUrl,
        apiKey,
        modelId,
        modelName: modelId,
        api: 'openai-completions',
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS
      }
    }
  }

  if (mode === CONFIG_MODES.minimax_bailian) {
    const modelId = assertNonEmpty(values.model || 'MiniMax-M2.5', 'Model')
    if (modelId !== 'MiniMax-M2.5') {
      throw new Error('MiniMax / 阿里云百炼 mode requires model "MiniMax-M2.5"')
    }
    const apiKey = assertNonEmpty(values.apiKey, 'API Key')
    const baseUrl = normalizeBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1')
    return {
      mode,
      values: {
        apiKey,
        model: modelId
      },
      resolved: {
        providerId: 'api-proxy-minimax',
        authProfileId: 'api-proxy-minimax:default',
        baseUrl,
        apiKey,
        modelId,
        modelName: 'MiniMax M2.5',
        api: 'openai-completions',
        contextWindow: 128000,
        maxTokens: 8192
      }
    }
  }

  if (mode === CONFIG_MODES.minimax_newapi) {
    const modelId = assertNonEmpty(values.model || 'MiniMax-M2.5', 'Model')
    const apiKey = assertNonEmpty(values.apiKey, 'API Key')
    const baseUrl = normalizeBaseUrl('https://api2.aigcbest.top')
    return {
      mode,
      values: {
        apiKey,
        model: modelId
      },
      resolved: {
        providerId: NEWAPI_PROVIDER_ID,
        authProfileId: `${NEWAPI_PROVIDER_ID}:default`,
        baseUrl,
        apiKey,
        modelId,
        modelName: modelId,
        api: 'openai-completions',
        contextWindow: 128000,
        maxTokens: 8192
      }
    }
  }

  const providerId = normalizeProviderId(values.providerId)
  const baseUrl = normalizeBaseUrl(values.baseUrl)
  const apiKey = assertNonEmpty(values.apiKey, 'API Key')
  const modelId = assertNonEmpty(values.modelId, 'Model ID')
  return {
    mode,
    values: {
      providerId,
      baseUrl,
      apiKey,
      modelId
    },
    resolved: {
      providerId,
      authProfileId: `${providerId}:default`,
      baseUrl,
      apiKey,
      modelId,
      modelName: modelId,
      api: 'openai-completions',
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS
    }
  }
}

function createAuthProfiles(resolvedConfig) {
  return {
    version: 1,
    profiles: {
      [resolvedConfig.authProfileId]: {
        type: 'api_key',
        provider: resolvedConfig.providerId,
        key: resolvedConfig.apiKey
      }
    }
  }
}

function createOpenClawConfig({
  resolvedConfig,
  workspaceDir,
  gatewayPort = DEFAULT_GATEWAY_PORT,
  existingConfig = null
}) {
  const modelKey = `${resolvedConfig.providerId}/${resolvedConfig.modelId}`
  const previous = existingConfig && typeof existingConfig === 'object' ? existingConfig : {}
  const previousAuth = previous.auth && typeof previous.auth === 'object' ? previous.auth : {}
  const previousModels = previous.models && typeof previous.models === 'object' ? previous.models : {}
  const previousAgents = previous.agents && typeof previous.agents === 'object' ? previous.agents : {}
  const previousGateway = previous.gateway && typeof previous.gateway === 'object' ? previous.gateway : {}

  return {
    ...previous,
    wizard: {
      ...(previous.wizard || {}),
      lastRunCommand: 'gateway',
      lastRunMode: 'local'
    },
    auth: {
      ...previousAuth,
      profiles: {
        ...(previousAuth.profiles || {}),
        [resolvedConfig.authProfileId]: {
          ...(previousAuth.profiles?.[resolvedConfig.authProfileId] || {}),
          provider: resolvedConfig.providerId,
          mode: 'api_key'
        }
      },
      order: {
        ...(previousAuth.order || {}),
        [resolvedConfig.providerId]: [resolvedConfig.authProfileId]
      }
    },
    models: {
      ...previousModels,
      mode: 'merge',
      providers: {
        ...(previousModels.providers || {}),
        [resolvedConfig.providerId]: {
          ...(previousModels.providers?.[resolvedConfig.providerId] || {}),
          baseUrl: resolvedConfig.baseUrl,
          api: resolvedConfig.api,
          models: [
            createModelDefinition({
              modelId: resolvedConfig.modelId,
              modelName: resolvedConfig.modelName,
              contextWindow: resolvedConfig.contextWindow,
              maxTokens: resolvedConfig.maxTokens
            })
          ]
        }
      }
    },
    agents: {
      ...previousAgents,
      defaults: {
        ...(previousAgents.defaults || {}),
        model: {
          ...(previousAgents.defaults?.model || {}),
          primary: modelKey
        },
        models: {
          ...(previousAgents.defaults?.models || {}),
          [modelKey]: {}
        },
        workspace: workspaceDir
      }
    },
    tools: {
      ...(previous.tools || {}),
      profile: 'coding'
    },
    commands: {
      ...(previous.commands || {}),
      native: 'auto',
      nativeSkills: 'auto',
      restart: true,
      ownerDisplay: 'raw'
    },
    session: {
      ...(previous.session || {}),
      dmScope: 'per-channel-peer'
    },
    gateway: {
      ...previousGateway,
      port: gatewayPort,
      mode: 'local',
      bind: 'loopback'
    }
  }
}

function createLauncherConfig(normalizedConfig) {
  return {
    version: 1,
    mode: normalizedConfig.mode,
    values: { ...normalizedConfig.values },
    resolved: {
      ...normalizedConfig.resolved,
      apiKey: normalizedConfig.resolved.apiKey
    },
    savedAt: new Date().toISOString()
  }
}

function inferModeFromResolved(resolved) {
  if (!resolved?.providerId) return CONFIG_MODES.openai_compatible
  if (resolved.providerId === 'api-proxy-minimax') return CONFIG_MODES.minimax_bailian
  if (resolved.providerId === NEWAPI_PROVIDER_ID || resolved.providerId === LEGACY_NEWAPI_PROVIDER_ID) {
    return CONFIG_MODES.minimax_newapi
  }
  if (resolved.providerId === 'openai-compatible') return CONFIG_MODES.openai_compatible
  return CONFIG_MODES.advanced
}

function inferCurrentConfig({ launcherConfig, openclawConfig, authProfiles }) {
  if (launcherConfig?.mode && launcherConfig?.values && launcherConfig?.resolved) {
    return launcherConfig
  }

  const providerEntries = Object.entries(openclawConfig?.models?.providers || {})
  if (providerEntries.length === 0) return null

  const [providerId, providerConfig] = providerEntries[0]
  const firstModel = Array.isArray(providerConfig?.models) ? providerConfig.models[0] : null
  const authProfileEntries = Object.entries(authProfiles?.profiles || {})
  const authEntry = authProfileEntries.find(([, profile]) => String(profile?.provider || '').trim() === providerId)

  if (!firstModel || !authEntry) return null
  const [authProfileId, profile] = authEntry
  const resolved = {
    providerId,
    authProfileId,
    baseUrl: String(providerConfig.baseUrl || ''),
    apiKey: String(profile.key || ''),
    modelId: String(firstModel.id || ''),
    modelName: String(firstModel.name || firstModel.id || ''),
    api: String(providerConfig.api || 'openai-completions'),
    contextWindow: Number(firstModel.contextWindow || DEFAULT_CONTEXT_WINDOW),
    maxTokens: Number(firstModel.maxTokens || DEFAULT_MAX_TOKENS)
  }
  const mode = inferModeFromResolved(resolved)

  if (mode === CONFIG_MODES.minimax_bailian) {
    return createLauncherConfig({
      mode,
      values: {
        apiKey: resolved.apiKey,
        model: resolved.modelId
      },
      resolved
    })
  }

  if (mode === CONFIG_MODES.minimax_newapi) {
    return createLauncherConfig({
      mode,
      values: {
        apiKey: resolved.apiKey,
        model: resolved.modelId
      },
      resolved
    })
  }

  if (mode === CONFIG_MODES.openai_compatible) {
    return createLauncherConfig({
      mode,
      values: {
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        model: resolved.modelId
      },
      resolved
    })
  }

  return createLauncherConfig({
    mode,
    values: {
      providerId: resolved.providerId,
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      modelId: resolved.modelId
    },
    resolved
  })
}

module.exports = {
  CONFIG_MODES,
  createAuthProfiles,
  createLauncherConfig,
  createOpenClawConfig,
  inferCurrentConfig,
  inferModeFromResolved,
  migrateImageCapableModelInputs,
  normalizeBaseUrl,
  resolveModelInputs,
  normalizeProviderId,
  resolveUserConfig
}
