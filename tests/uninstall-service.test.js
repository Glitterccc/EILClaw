const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const {
  UninstallService,
  buildCleanupScript,
  createCleanupTargets,
  resolveAppBundlePath,
  resolveSelfUninstallAppBundle,
  spawnCleanupHelper,
  uniqueTargetPids
} = require('../electron/services/uninstall-service')

test('createCleanupTargets deduplicates nested cleanup paths', () => {
  const targets = createCleanupTargets({
    userDataDir: '/Users/test/Library/Application Support/openclaw-launcher',
    logsDir: '/Users/test/Library/Application Support/openclaw-launcher/logs'
  })

  assert.deepEqual(targets, ['/Users/test/Library/Application Support/openclaw-launcher'])
})

test('buildCleanupScript embeds pid and cleanup targets', () => {
  const script = buildCleanupScript({
    currentPid: 12345,
    cleanupTargets: ['/tmp/eil-claw-data', '/tmp/eil-claw-logs'],
    appBundlePath: '/Applications/EIL Claw.app',
    targetPids: [2222, 3333]
  })

  assert.match(script, /12345/)
  assert.match(script, /eil-claw-data/)
  assert.match(script, /eil-claw-logs/)
  assert.match(script, /Applications\/EIL Claw\.app/)
  assert.match(script, /2222/)
  assert.match(script, /3333/)
  assert.match(script, /fs\.rmSync/)
  assert.match(script, /scheduleAppBundleRemoval/)
  assert.match(script, /SIGTERM/)
})

test('spawnCleanupHelper launches a detached cleanup process', () => {
  let spawnCall = null
  const fakeChild = {
    unrefCalled: false,
    unref() {
      this.unrefCalled = true
    }
  }

  const result = spawnCleanupHelper({
    nodePath: '/tmp/fake-node',
    currentPid: 4321,
    cleanupTargets: ['/tmp/eil-claw-data'],
    appBundlePath: '/Applications/EIL Claw.app',
    targetPids: [1111, 1111, 2222],
    spawnFn: (command, args, options) => {
      spawnCall = { command, args, options }
      return fakeChild
    }
  })

  assert.equal(spawnCall.command, '/tmp/fake-node')
  assert.equal(spawnCall.options.detached, true)
  assert.equal(fakeChild.unrefCalled, true)
  assert.deepEqual(result.cleanupTargets, ['/tmp/eil-claw-data'])
  assert.equal(result.appBundlePath, '/Applications/EIL Claw.app')
  assert.deepEqual(result.targetPids, [1111, 2222])
})

test('UninstallService schedules cleanup for app data and logs with bundled node', () => {
  let spawnCall = null
  const fakeChild = {
    unref() {}
  }

  const service = new UninstallService({
    app: {
      getAppPath: () => path.resolve(__dirname, '..'),
      isPackaged: true,
      getPath: (name) => {
        if (name === 'userData') return '/Users/test/Library/Application Support/openclaw-launcher'
        if (name === 'logs') return '/Users/test/Library/Logs/EIL Claw'
        throw new Error(`Unexpected path lookup: ${name}`)
      }
    },
    processRef: {
      pid: 7654,
      platform: process.platform,
      execPath: '/Applications/EIL Claw.app/Contents/MacOS/EIL Claw',
      resourcesPath: path.resolve(__dirname, '..')
    },
    spawnFn: (command, args, options) => {
      spawnCall = { command, args, options }
      return fakeChild
    }
  })

  const result = service.scheduleCleanup({ targetPids: [9876, 9876] })

  assert.match(spawnCall.command, /node-runtime\/nodejs\/bin\/node$/)
  assert.equal(spawnCall.options.detached, process.platform !== 'win32')
  assert.deepEqual(result.cleanupTargets, [
    '/Users/test/Library/Application Support/openclaw-launcher',
    '/Users/test/Library/Logs/EIL Claw'
  ])
  assert.equal(result.appBundlePath, '/Applications/EIL Claw.app')
  assert.deepEqual(result.targetPids, [9876])
})

test('uniqueTargetPids normalizes and deduplicates pid lists', () => {
  assert.deepEqual(uniqueTargetPids([123, '123', 0, null, '456']), [123, 456])
})

test('resolveAppBundlePath extracts the .app bundle root from a packaged exec path', () => {
  assert.equal(
    resolveAppBundlePath('/Applications/EIL Claw.app/Contents/MacOS/EIL Claw'),
    '/Applications/EIL Claw.app'
  )
  assert.equal(resolveAppBundlePath('/tmp/dev-electron'), '')
})

test('resolveSelfUninstallAppBundle skips non-packaged apps and DMG-mounted apps', () => {
  assert.equal(
    resolveSelfUninstallAppBundle({
      execPath: '/Applications/EIL Claw.app/Contents/MacOS/EIL Claw',
      isPackaged: true,
      platform: 'darwin'
    }),
    '/Applications/EIL Claw.app'
  )
  assert.equal(
    resolveSelfUninstallAppBundle({
      execPath: '/Volumes/EIL Claw/EIL Claw.app/Contents/MacOS/EIL Claw',
      isPackaged: true,
      platform: 'darwin'
    }),
    ''
  )
  assert.equal(
    resolveSelfUninstallAppBundle({
      execPath: '/Applications/EIL Claw.app/Contents/MacOS/EIL Claw',
      isPackaged: false,
      platform: 'darwin'
    }),
    ''
  )
})
