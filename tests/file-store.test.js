const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { readJson, writeJsonAtomic } = require('../electron/services/file-store')

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-launcher-test-'))
}

test('writeJsonAtomic writes JSON and keeps a backup when overwriting', () => {
  const dir = makeTempDir()
  const filePath = path.join(dir, 'config.json')

  writeJsonAtomic(filePath, { value: 1 })
  writeJsonAtomic(filePath, { value: 2 })

  assert.deepEqual(readJson(filePath), { value: 2 })
  assert.deepEqual(readJson(`${filePath}.bak`), { value: 1 })
})
