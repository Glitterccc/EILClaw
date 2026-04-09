const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')

const { resolveStatePaths, resolveBundledPluginDir, resolveBundledDefaultConfigPath } = require('../electron/utils/runtime-paths')

test('resolveStatePaths keeps OpenClaw state under the app userData directory', () => {
  const userDataDir = path.join(os.tmpdir(), 'launcher-userdata')
  const statePaths = resolveStatePaths(userDataDir)

  assert.equal(statePaths.stateDir, path.join(userDataDir, 'openclaw-state'))
  assert.equal(statePaths.workspaceDir, path.join(userDataDir, 'openclaw-state', 'workspace'))
  assert.equal(statePaths.authProfilesPath, path.join(userDataDir, 'openclaw-state', 'agents', 'main', 'agent', 'auth-profiles.json'))
  assert.equal(statePaths.gatewayPidPath, path.join(userDataDir, 'openclaw-state', 'gateway.pid'))
  assert.equal(statePaths.launcherConfigPath, path.join(userDataDir, 'launcher-config.json'))
})

test('resolveBundledPluginDir points at bundled plugin resources in dev and packaged builds', () => {
  const fakeApp = {
    getAppPath: () => '/tmp/eil-claw-app'
  }

  assert.equal(
    resolveBundledPluginDir({ app: fakeApp, isPackaged: false }, 'openclaw-weixin'),
    path.join('/tmp/eil-claw-app', 'bundled-plugins', 'openclaw-weixin')
  )

  assert.equal(
    resolveBundledPluginDir(
      {
        app: fakeApp,
        isPackaged: true,
        processRef: {
          resourcesPath: '/tmp/eil-claw-resources'
        }
      },
      'openclaw-weixin'
    ),
    path.join('/tmp/eil-claw-resources', 'bundled-plugins', 'openclaw-weixin')
  )
})

test('resolveBundledDefaultConfigPath points at local defaults in dev and packaged builds', () => {
  const fakeApp = {
    getAppPath: () => '/tmp/eil-claw-app'
  }

  assert.equal(
    resolveBundledDefaultConfigPath({ app: fakeApp, isPackaged: false }),
    path.join('/tmp/eil-claw-app', 'local-defaults', 'default-provider.json')
  )

  assert.equal(
    resolveBundledDefaultConfigPath({
      app: fakeApp,
      isPackaged: true,
      processRef: {
        resourcesPath: '/tmp/eil-claw-resources'
      }
    }),
    path.join('/tmp/eil-claw-resources', 'defaults', 'default-provider.json')
  )
})
