const fs = require('fs')
const path = require('path')

const DEFAULT_GATEWAY_PORT = 38789

function pathExists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

function resolveRuntimeDir({ app, isPackaged, processRef = process }) {
  if (!isPackaged) {
    return path.join(app.getAppPath(), 'node-runtime')
  }
  return path.join(processRef.resourcesPath, 'node-runtime')
}

function resolveBundledPluginDir({ app, isPackaged, processRef = process }, pluginId) {
  if (!pluginId) {
    throw new Error('pluginId is required')
  }

  if (!isPackaged) {
    return path.join(app.getAppPath(), 'bundled-plugins', pluginId)
  }
  return path.join(processRef.resourcesPath, 'bundled-plugins', pluginId)
}

function resolveBundledDefaultConfigPath({ app, isPackaged, processRef = process }) {
  if (!isPackaged) {
    return path.join(app.getAppPath(), 'local-defaults', 'default-provider.json')
  }
  return path.join(processRef.resourcesPath, 'defaults', 'default-provider.json')
}

function resolveNodeExecutable(runtimeDir, platform = process.platform) {
  const candidates = platform === 'win32'
    ? [path.join(runtimeDir, 'nodejs', 'node.exe')]
    : [
        path.join(runtimeDir, 'nodejs', 'bin', 'node'),
        path.join(runtimeDir, 'nodejs', 'node')
      ]
  return candidates.find(pathExists) || candidates[0]
}

function resolveNpxExecutable(runtimeDir, platform = process.platform) {
  const candidates = platform === 'win32'
    ? [path.join(runtimeDir, 'nodejs', 'npx.cmd')]
    : [
        path.join(runtimeDir, 'nodejs', 'bin', 'npx'),
        path.join(runtimeDir, 'nodejs', 'npx')
      ]
  return candidates.find(pathExists) || candidates[0]
}

function resolveOpenClawEntry(runtimeDir) {
  const directEntry = path.join(runtimeDir, 'npm_global', 'node_modules', 'openclaw', 'openclaw.mjs')
  if (pathExists(directEntry)) return directEntry

  const shimCandidates = process.platform === 'win32'
    ? [
        path.join(runtimeDir, 'npm_global', '.bin', 'openclaw.cmd'),
        path.join(runtimeDir, 'npm_global', 'openclaw.cmd')
      ]
    : [
        path.join(runtimeDir, 'npm_global', '.bin', 'openclaw'),
        path.join(runtimeDir, 'npm_global', 'bin', 'openclaw'),
        path.join(runtimeDir, 'npm_global', 'openclaw')
      ]
  return shimCandidates.find(pathExists) || directEntry
}

function resolveOpenClawLaunchSpec(runtimeDir) {
  const nodePath = resolveNodeExecutable(runtimeDir)
  const entryPath = resolveOpenClawEntry(runtimeDir)
  const isShim = entryPath !== path.join(runtimeDir, 'npm_global', 'node_modules', 'openclaw', 'openclaw.mjs')

  if (isShim) {
    return {
      command: entryPath,
      args: [],
      shell: process.platform === 'win32' && entryPath.endsWith('.cmd'),
      requiredPaths: [entryPath]
    }
  }

  return {
    command: nodePath,
    args: [entryPath],
    shell: false,
    requiredPaths: [nodePath, entryPath]
  }
}

function resolveStatePaths(userDataDir) {
  const stateDir = path.join(userDataDir, 'openclaw-state')
  const agentDir = path.join(stateDir, 'agents', 'main', 'agent')
  return {
    stateDir,
    agentDir,
    workspaceDir: path.join(stateDir, 'workspace'),
    openclawConfigPath: path.join(stateDir, 'openclaw.json'),
    authProfilesPath: path.join(agentDir, 'auth-profiles.json'),
    launcherConfigPath: path.join(userDataDir, 'launcher-config.json'),
    gatewayPidPath: path.join(stateDir, 'gateway.pid')
  }
}

module.exports = {
  DEFAULT_GATEWAY_PORT,
  pathExists,
  resolveNodeExecutable,
  resolveNpxExecutable,
  resolveOpenClawEntry,
  resolveOpenClawLaunchSpec,
  resolveBundledPluginDir,
  resolveBundledDefaultConfigPath,
  resolveRuntimeDir,
  resolveStatePaths
}
