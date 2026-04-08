const fs = require('fs')
const path = require('path')

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeTextAtomic(filePath, text, options = {}) {
  const mode = options.mode || 0o600
  const backup = options.backup !== false
  ensureDir(path.dirname(filePath))

  if (backup && fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, `${filePath}.bak`)
  }

  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tempPath, text, { encoding: 'utf8', mode })
  fs.renameSync(tempPath, filePath)
}

function writeJsonAtomic(filePath, data, options = {}) {
  writeTextAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`, options)
}

module.exports = {
  ensureDir,
  readJson,
  writeJsonAtomic,
  writeTextAtomic
}
