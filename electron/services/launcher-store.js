const { DEFAULT_GATEWAY_PORT } = require('../utils/runtime-paths')
const { readJson, writeJsonAtomic, ensureDir } = require('./file-store')
const { createAuthProfiles, createLauncherConfig, createOpenClawConfig, inferCurrentConfig, migrateImageCapableModelInputs } = require('./config-modes')

const LEGACY_DEFAULT_GATEWAY_PORT = 28789

class LauncherStore {
  constructor(paths) {
    this.paths = paths
  }

  migrateStoredOpenClawConfig(openclawConfig) {
    if (!openclawConfig || typeof openclawConfig !== 'object') {
      return openclawConfig
    }

    let nextConfig = openclawConfig
    let changed = false

    const currentPort = Number(nextConfig.gateway?.port)
    if (Number.isFinite(currentPort) && currentPort === LEGACY_DEFAULT_GATEWAY_PORT) {
      nextConfig = {
        ...nextConfig,
        gateway: {
          ...(nextConfig.gateway || {}),
          port: DEFAULT_GATEWAY_PORT
        }
      }
      changed = true
    }

    const inputMigration = migrateImageCapableModelInputs(nextConfig)
    if (inputMigration.changed) {
      nextConfig = inputMigration.config
      changed = true
    }

    if (changed) {
      writeJsonAtomic(this.paths.openclawConfigPath, nextConfig)
    }

    return nextConfig
  }

  hasSavedConfig() {
    return Boolean(this.loadCurrentConfig())
  }

  loadCurrentConfig() {
    const launcherConfig = readJson(this.paths.launcherConfigPath)
    const openclawConfig = this.migrateStoredOpenClawConfig(readJson(this.paths.openclawConfigPath))
    const authProfiles = readJson(this.paths.authProfilesPath)
    return inferCurrentConfig({ launcherConfig, openclawConfig, authProfiles })
  }

  saveResolvedConfig(normalizedConfig, options = {}) {
    ensureDir(this.paths.stateDir)
    ensureDir(this.paths.workspaceDir)
    ensureDir(this.paths.agentDir)
    const existingOpenClawConfig = readJson(this.paths.openclawConfigPath)

    const openclawConfig = createOpenClawConfig({
      resolvedConfig: normalizedConfig.resolved,
      workspaceDir: this.paths.workspaceDir,
      gatewayPort: options.gatewayPort,
      existingConfig: existingOpenClawConfig
    })
    const authProfiles = createAuthProfiles(normalizedConfig.resolved)
    const launcherConfig = createLauncherConfig(normalizedConfig)

    writeJsonAtomic(this.paths.openclawConfigPath, openclawConfig)
    writeJsonAtomic(this.paths.authProfilesPath, authProfiles)
    writeJsonAtomic(this.paths.launcherConfigPath, launcherConfig)

    return {
      launcherConfig,
      openclawConfig,
      authProfiles
    }
  }
}

module.exports = {
  LauncherStore
}
