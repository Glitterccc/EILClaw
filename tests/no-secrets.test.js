const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')
const forbidden = [
  ['sk-hFT6zMPROQSOUpyq', '2sRVIO0lkJMoTnke', 'YVrbgiIVajZbCoyJ'].join('')
]

function scanFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  const results = []
  for (const entry of entries) {
    if (['node_modules', 'node-runtime', 'release', '.git'].includes(entry.name)) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...scanFiles(fullPath))
      continue
    }
    results.push(fullPath)
  }
  return results
}

test('repo sources do not embed the provided real API key', () => {
  const files = scanFiles(repoRoot)
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8')
    for (const secret of forbidden) {
      assert.equal(
        content.includes(secret),
        false,
        `${filePath} unexpectedly contains a real API key`
      )
    }
  }
})
