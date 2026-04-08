const { DEFAULT_GATEWAY_PORT } = require('../utils/runtime-paths')
const { readJson, writeJsonAtomic, ensureDir } = require('./file-store')
const { createAuthProfiles, createLauncherConfig, createOpenClawConfig, inferCurrentConfig } = require('./config-modes')

const LEGACY_DEFAULT_GATEWAY_PORT = 28789

class LauncherStore {
  constructor(paths) {
    this.paths = paths
  }

  migrateLegacyGatewayPort(openclawConfig) {
    const currentPort = Number(openclawConfig?.gateway?.port)
    if (!openclawConfig || !Number.isFinite(currentPort) || currentPort !== LEGACY_DEFAULT_GATEWAY_PORT) {
      return openclawConfig
    }

    const migratedConfig = {
      ...openclawConfig,
      gateway: {
        ...(openclawConfig.gateway || {}),
        port: DEFAULT_GATEWAY_PORT
      }
    }
    writeJsonAtomic(this.paths.openclawConfigPath, migratedConfig)
    return migratedConfig
  }

  hasSavedConfig() {
    return Boolean(this.loadCurrentConfig())
  }

  loadCurrentConfig() {
    const launcherConfig = readJson(this.paths.launcherConfigPath)
    const openclawConfig = this.migrateLegacyGatewayPort(readJson(this.paths.openclawConfigPath))
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
