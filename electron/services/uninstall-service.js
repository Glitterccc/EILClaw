const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { resolveNodeExecutable, resolveRuntimeDir } = require('../utils/runtime-paths')

function uniqueCleanupTargets(paths) {
  const normalized = [...new Set(
    paths
      .filter((value) => typeof value === 'string' && value.trim() !== '')
      .map((value) => path.resolve(value))
  )]

  return normalized.filter((candidate) => {
    return !normalized.some((other) => other !== candidate && candidate.startsWith(`${other}${path.sep}`))
  })
}

function createCleanupTargets({ userDataDir, logsDir }) {
  return uniqueCleanupTargets([userDataDir, logsDir])
}

function resolveAppBundlePath(execPath) {
  if (typeof execPath !== 'string' || execPath.trim() === '') return ''
  const normalizedExecPath = path.resolve(execPath)
  const macOsMarker = `${path.sep}Contents${path.sep}MacOS${path.sep}`
  const markerIndex = normalizedExecPath.lastIndexOf(macOsMarker)
  if (markerIndex <= 0) return ''
  const bundlePath = normalizedExecPath.slice(0, markerIndex)
  return bundlePath.endsWith('.app') ? bundlePath : ''
}

function resolveSelfUninstallAppBundle({ execPath, isPackaged, platform }) {
  if (!isPackaged || platform !== 'darwin') return ''
  const bundlePath = resolveAppBundlePath(execPath)
  if (!bundlePath) return ''
  if (bundlePath.startsWith(`${path.sep}Volumes${path.sep}`)) {
    return ''
  }
  return bundlePath
}

function uniqueTargetPids(pids) {
  return [...new Set(
    (Array.isArray(pids) ? pids : [])
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0)
  )]
}

function buildCleanupScript({
  currentPid,
  cleanupTargets,
  appBundlePath = '',
  targetPids = [],
  maxWaitMs = 15000,
  retryDelayMs = 250,
  killWaitMs = 5000
}) {
  return `
const fs = require('fs');
const { spawn } = require('child_process');
const pid = ${JSON.stringify(currentPid)};
const cleanupTargets = ${JSON.stringify(cleanupTargets)};
const appBundlePath = ${JSON.stringify(appBundlePath)};
const targetPids = ${JSON.stringify(uniqueTargetPids(targetPids))};
const maxWaitMs = ${JSON.stringify(maxWaitMs)};
const retryDelayMs = ${JSON.stringify(retryDelayMs)};
const killWaitMs = ${JSON.stringify(killWaitMs)};

function processExists(targetPid) {
  if (!Number.isInteger(targetPid) || targetPid <= 0) return false;
  try {
    process.kill(targetPid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessTree(targetPid, signal) {
  if (!Number.isInteger(targetPid) || targetPid <= 0) return;
  try {
    if (process.platform !== 'win32') {
      process.kill(-targetPid, signal);
      return;
    }
  } catch {}
  try {
    process.kill(targetPid, signal);
  } catch {}
}

async function waitForParentExit() {
  const startedAt = Date.now();
  while (processExists(pid) && Date.now() - startedAt < maxWaitMs) {
    await sleep(retryDelayMs);
  }
}

async function stopTarget(targetPid) {
  if (!processExists(targetPid)) return;
  killProcessTree(targetPid, 'SIGTERM');
  const startedAt = Date.now();
  while (processExists(targetPid) && Date.now() - startedAt < killWaitMs) {
    await sleep(retryDelayMs);
  }
  if (processExists(targetPid)) {
    killProcessTree(targetPid, 'SIGKILL');
    const forceStartedAt = Date.now();
    while (processExists(targetPid) && Date.now() - forceStartedAt < 1500) {
      await sleep(retryDelayMs);
    }
  }
}

async function stopTargets() {
  for (const targetPid of targetPids) {
    await stopTarget(targetPid);
  }
}

function removeTargets() {
  for (const target of cleanupTargets) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: retryDelayMs });
    } catch {}
  }
}

function scheduleAppBundleRemoval() {
  if (!appBundlePath) return;
  try {
    const child = spawn('/bin/sh', ['-c', 'sleep 1; rm -rf "$1"', 'sh', appBundlePath], {
      detached: true,
      stdio: 'ignore'
    });
    if (typeof child.unref === 'function') child.unref();
  } catch {}
}

(async () => {
  await waitForParentExit();
  await stopTargets();
  removeTargets();
  scheduleAppBundleRemoval();
})().catch(() => {
  process.exitCode = 0;
});
`.trim()
}

function spawnCleanupHelper({
  nodePath,
  currentPid,
  cleanupTargets,
  appBundlePath = '',
  targetPids = [],
  spawnFn = spawn,
  platform = process.platform
}) {
  const script = buildCleanupScript({ currentPid, cleanupTargets, appBundlePath, targetPids })
  const args = ['-e', script]
  const child = spawnFn(nodePath, args, {
    detached: platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true
  })
  if (typeof child.unref === 'function') child.unref()
  return {
    nodePath,
    args,
    cleanupTargets,
    appBundlePath,
    targetPids: uniqueTargetPids(targetPids)
  }
}

class UninstallService {
  constructor({ app, processRef = process, spawnFn = spawn }) {
    this.app = app
    this.processRef = processRef
    this.spawnFn = spawnFn
    this.runtimeDir = resolveRuntimeDir({ app, isPackaged: app.isPackaged, processRef })
  }

  resolveCleanupNodePath() {
    const bundledNode = resolveNodeExecutable(this.runtimeDir, this.processRef.platform)
    if (fs.existsSync(bundledNode)) return bundledNode
    if (this.processRef.execPath && fs.existsSync(this.processRef.execPath)) return this.processRef.execPath
    throw new Error('Bundled cleanup runtime is unavailable')
  }

  getCleanupTargets() {
    return createCleanupTargets({
      userDataDir: this.app.getPath('userData'),
      logsDir: this.app.getPath('logs')
    })
  }

  getAppBundlePath() {
    return resolveSelfUninstallAppBundle({
      execPath: this.processRef.execPath,
      isPackaged: this.app.isPackaged,
      platform: this.processRef.platform
    })
  }

  scheduleCleanup(options = {}) {
    const cleanupTargets = this.getCleanupTargets()
    const appBundlePath = this.getAppBundlePath()
    if (cleanupTargets.length === 0 && !appBundlePath) {
      return {
        cleanupTargets: [],
        appBundlePath: '',
        targetPids: []
      }
    }

    const nodePath = this.resolveCleanupNodePath()
    const scheduled = spawnCleanupHelper({
      nodePath,
      currentPid: this.processRef.pid,
      cleanupTargets,
      appBundlePath,
      targetPids: options.targetPids,
      spawnFn: this.spawnFn,
      platform: this.processRef.platform
    })

    return {
      ...scheduled,
      cleanupTargets
    }
  }
}

module.exports = {
  UninstallService,
  buildCleanupScript,
  createCleanupTargets,
  resolveAppBundlePath,
  resolveSelfUninstallAppBundle,
  spawnCleanupHelper,
  uniqueCleanupTargets,
  uniqueTargetPids
}
