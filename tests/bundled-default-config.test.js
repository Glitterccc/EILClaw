const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { loadBundledDefaultConfigInput, resolveBundledDefaultConfig } = require('../electron/services/bundled-default-config')

function makeTempAppRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eil-claw-default-config-'))
}

test('returns null when no bundled default provider config exists', () => {
  const appRoot = makeTempAppRoot()
  const app = {
    isPackaged: false,
    getAppPath: () => appRoot
  }

  assert.equal(loadBundledDefaultConfigInput({ app }), null)
  assert.equal(resolveBundledDefaultConfig({ app }), null)
})

test('loads and resolves bundled default provider config from local-defaults', () => {
  const appRoot = makeTempAppRoot()
  const defaultsDir = path.join(appRoot, 'local-defaults')
  fs.mkdirSync(defaultsDir, { recursive: true })
  fs.writeFileSync(path.join(defaultsDir, 'default-provider.json'), JSON.stringify({
    mode: 'minimax_newapi',
    values: {
      apiKey: 'sk-default',
      model: 'gpt-5.4'
    }
  }, null, 2))

  const app = {
    isPackaged: false,
    getAppPath: () => appRoot
  }

  const input = loadBundledDefaultConfigInput({ app })
  const normalized = resolveBundledDefaultConfig({ app })

  assert.equal(input.mode, 'minimax_newapi')
  assert.equal(input.values.model, 'gpt-5.4')
  assert.equal(normalized.resolved.baseUrl, 'https://api2.aigcbest.top/v1')
  assert.equal(normalized.resolved.modelId, 'gpt-5.4')
  assert.equal(normalized.resolved.apiKey, 'sk-default')
})
