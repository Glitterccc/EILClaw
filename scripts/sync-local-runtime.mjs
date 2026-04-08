import fs from 'node:fs'
import path from 'node:path'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const sourceDir = process.env.OPENCLAW_RUNTIME_SOURCE
  ? path.resolve(process.env.OPENCLAW_RUNTIME_SOURCE)
  : '/Users/glitterc/Desktop/CodeX_codes/ClawLite-feat-macos-installer-plan/node-runtime'
const targetDir = path.join(projectRoot, 'node-runtime')

if (!fs.existsSync(sourceDir)) {
  console.error(`Runtime source not found: ${sourceDir}`)
  process.exit(1)
}

fs.rmSync(targetDir, { recursive: true, force: true })
fs.cpSync(sourceDir, targetDir, {
  recursive: true,
  dereference: true
})

console.log(`Copied runtime from ${sourceDir}`)
console.log(`Runtime ready at ${targetDir}`)
