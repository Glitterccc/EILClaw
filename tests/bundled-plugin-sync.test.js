const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  needsBundledPluginSync,
  syncBundledPluginToState,
  ensureBundledPluginEnabled
} = require('../electron/services/bundled-plugin-sync')
const { resolveStatePaths } = require('../electron/utils/runtime-paths')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eil-claw-bundled-plugin-'))
}

function writePluginFixture(pluginDir, version = '1.0.3') {
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.mkdirSync(path.join(pluginDir, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'openclaw.plugin.json'), '{}', 'utf8')
  fs.writeFileSync(path.join(pluginDir, 'index.ts'), 'export default {}', 'utf8')
  fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
    name: '@tencent-weixin/openclaw-weixin',
    version
  }), 'utf8')
}

test('needsBundledPluginSync detects missing or outdated target plugin copies', () => {
  const rootDir = tempDir()
  const sourceDir = path.join(rootDir, 'bundled', 'openclaw-weixin')
  const targetDir = path.join(rootDir, 'state', 'extensions', 'openclaw-weixin')

  writePluginFixture(sourceDir, '1.0.4')
  assert.equal(needsBundledPluginSync({ sourceDir, targetDir }), true)

  writePluginFixture(targetDir, '1.0.3')
  assert.equal(needsBundledPluginSync({ sourceDir, targetDir }), true)

  writePluginFixture(targetDir, '1.0.4')
  assert.equal(needsBundledPluginSync({ sourceDir, targetDir }), false)
})

test('syncBundledPluginToState copies plugin assets and ensureBundledPluginEnabled writes bundled metadata', () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  const sourceDir = path.join(userDataDir, 'bundled', 'openclaw-weixin')

  fs.mkdirSync(statePaths.workspaceDir, { recursive: true })
  fs.writeFileSync(statePaths.openclawConfigPath, JSON.stringify({ gateway: { port: 38789 } }), 'utf8')
  writePluginFixture(sourceDir, '1.0.5')

  const syncResult = syncBundledPluginToState({
    sourceDir,
    statePaths,
    pluginId: 'openclaw-weixin'
  })

  assert.equal(syncResult.success, true)
  assert.equal(syncResult.synced, true)
  assert.equal(fs.existsSync(path.join(syncResult.targetDir, 'node_modules')), true)

  const enableResult = ensureBundledPluginEnabled({
    openclawConfigPath: statePaths.openclawConfigPath,
    pluginId: 'openclaw-weixin',
    sourceDir,
    targetDir: syncResult.targetDir,
    manifest: syncResult.manifest
  })

  assert.equal(enableResult.success, true)
  assert.equal(enableResult.changed, true)
  assert.equal(enableResult.config.plugins.entries['openclaw-weixin'].enabled, true)
  assert.equal(enableResult.config.plugins.installs['openclaw-weixin'].source, 'path')
  assert.equal(enableResult.config.plugins.installs['openclaw-weixin'].sourcePath, sourceDir)
  assert.equal(enableResult.config.plugins.installs['openclaw-weixin'].version, '1.0.5')
  assert.equal(enableResult.config.plugins.installs['openclaw-weixin'].installPath, syncResult.targetDir)
})
