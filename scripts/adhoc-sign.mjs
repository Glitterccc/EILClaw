#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(
  await fs.readFile(path.join(ROOT_DIR, 'package.json'), 'utf8')
)

const APP_NAME = packageJson.build?.productName || packageJson.productName || 'EIL Claw'
const APP_PATH = path.join(ROOT_DIR, 'release', 'mac-arm64', `${APP_NAME}.app`)

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

async function main() {
  const stat = await fs.stat(APP_PATH).catch(() => null)
  if (!stat?.isDirectory()) {
    throw new Error(`Missing app bundle: ${APP_PATH}`)
  }

  await run('codesign', ['--force', '--deep', '--sign', '-', APP_PATH])
  await run('codesign', ['--verify', '--deep', '--strict', '--verbose=4', APP_PATH])
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
