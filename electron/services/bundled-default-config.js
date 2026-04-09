const { readJson } = require('./file-store')
const { resolveUserConfig } = require('./config-modes')
const { resolveBundledDefaultConfigPath } = require('../utils/runtime-paths')

function loadBundledDefaultConfigInput({ app, isPackaged = app.isPackaged, processRef = process }) {
  const filePath = resolveBundledDefaultConfigPath({ app, isPackaged, processRef })
  const parsed = readJson(filePath)
  if (!parsed) return null
  if (!parsed.mode || !parsed.values || typeof parsed.values !== 'object') {
    throw new Error('Bundled default provider config must include "mode" and "values"')
  }
  return parsed
}

function resolveBundledDefaultConfig(options) {
  const input = loadBundledDefaultConfigInput(options)
  if (!input) return null
  return resolveUserConfig(input)
}

module.exports = {
  loadBundledDefaultConfigInput,
  resolveBundledDefaultConfig
}
