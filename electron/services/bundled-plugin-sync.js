const fs = require('fs')
const path = require('path')
const { ensureDir, readJson, writeJsonAtomic } = require('./file-store')

function resolveRequiredPluginFiles(pluginDir) {
  return [
    path.join(pluginDir, 'openclaw.plugin.json'),
    path.join(pluginDir, 'index.ts')
  ]
}

function isPluginDirectoryReady(pluginDir) {
  if (!pluginDir) return false
  return resolveRequiredPluginFiles(pluginDir).every((filePath) => fs.existsSync(filePath))
}

function readPluginManifest(pluginDir) {
  const manifestPath = path.join(pluginDir, 'package.json')
  if (!fs.existsSync(manifestPath)) {
    return {
      name: '',
      version: ''
    }
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    return {
      name: manifest.name || '',
      version: manifest.version || ''
    }
  } catch {
    return {
      name: '',
      version: ''
    }
  }
}

function needsBundledPluginSync({ sourceDir, targetDir }) {
  if (!isPluginDirectoryReady(sourceDir)) {
    return !isPluginDirectoryReady(targetDir)
  }

  if (!isPluginDirectoryReady(targetDir)) {
    return true
  }

  const sourceManifest = readPluginManifest(sourceDir)
  const targetManifest = readPluginManifest(targetDir)

  if (sourceManifest.name && targetManifest.name && sourceManifest.name !== targetManifest.name) {
    return true
  }

  if (sourceManifest.version && targetManifest.version && sourceManifest.version !== targetManifest.version) {
    return true
  }

  if (fs.existsSync(path.join(sourceDir, 'node_modules')) && !fs.existsSync(path.join(targetDir, 'node_modules'))) {
    return true
  }

  return false
}

function syncBundledPluginToState({ sourceDir, statePaths, pluginId }) {
  const targetDir = path.join(statePaths.stateDir, 'extensions', pluginId)
  const manifest = readPluginManifest(sourceDir)

  if (!isPluginDirectoryReady(sourceDir)) {
    return {
      success: false,
      synced: false,
      sourceDir,
      targetDir,
      manifest,
      message: 'App 内置的微信插件资源缺失，无法完成预装。'
    }
  }

  if (!needsBundledPluginSync({ sourceDir, targetDir })) {
    return {
      success: true,
      synced: false,
      sourceDir,
      targetDir,
      manifest
    }
  }

  ensureDir(path.dirname(targetDir))
  const tempDir = `${targetDir}.tmp-${process.pid}-${Date.now()}`
  fs.rmSync(tempDir, { recursive: true, force: true })
  fs.cpSync(sourceDir, tempDir, { recursive: true })
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.renameSync(tempDir, targetDir)

  return {
    success: true,
    synced: true,
    sourceDir,
    targetDir,
    manifest
  }
}

function ensureBundledPluginEnabled({ openclawConfigPath, pluginId, sourceDir, targetDir, manifest }) {
  const currentConfig = readJson(openclawConfigPath) || {}
  const currentPlugins = currentConfig.plugins || {}
  const currentEntries = currentPlugins.entries || {}
  const currentInstalls = currentPlugins.installs || {}
  const existingEntry = currentEntries[pluginId] || {}
  const existingInstall = currentInstalls[pluginId] || {}
  const resolvedName = manifest?.name || existingInstall.resolvedName || pluginId
  const resolvedVersion = manifest?.version || existingInstall.resolvedVersion || existingInstall.version || ''
  const fallbackSpec = typeof sourceDir === 'string' && sourceDir.trim()
    ? sourceDir
    : (existingInstall.spec || resolvedName)
  const now = new Date().toISOString()

  const nextInstall = {
    ...existingInstall,
    source: 'path',
    spec: fallbackSpec,
    sourcePath: typeof sourceDir === 'string' && sourceDir.trim()
      ? sourceDir
      : (existingInstall.sourcePath || targetDir),
    installPath: targetDir,
    resolvedName,
    resolvedSpec: resolvedVersion ? `${resolvedName}@${resolvedVersion}` : (existingInstall.resolvedSpec || fallbackSpec),
    resolvedAt: existingInstall.resolvedAt || now,
    installedAt: existingInstall.installedAt || now
  }

  if (resolvedVersion) {
    nextInstall.version = resolvedVersion
    nextInstall.resolvedVersion = resolvedVersion
  }

  const nextConfig = {
    ...currentConfig,
    plugins: {
      ...currentPlugins,
      entries: {
        ...currentEntries,
        [pluginId]: {
          ...existingEntry,
          enabled: true
        }
      },
      installs: {
        ...currentInstalls,
        [pluginId]: nextInstall
      }
    }
  }

  if (JSON.stringify(currentConfig) === JSON.stringify(nextConfig)) {
    return {
      success: true,
      changed: false,
      config: currentConfig
    }
  }

  writeJsonAtomic(openclawConfigPath, nextConfig)
  return {
    success: true,
    changed: true,
    config: nextConfig
  }
}

module.exports = {
  isPluginDirectoryReady,
  readPluginManifest,
  needsBundledPluginSync,
  syncBundledPluginToState,
  ensureBundledPluginEnabled
}
