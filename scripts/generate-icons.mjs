#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_DIR = path.join(ROOT_DIR, 'assets')
const SOURCE_PATH = process.argv[2] || path.join(ASSETS_DIR, 'eil-claw-logo.png')
const SQUARE_PATH = path.join(ASSETS_DIR, 'eil-claw-logo-square.png')
const TRAY_PATH = path.join(ASSETS_DIR, 'tray-icon-template.png')
const ICNS_PATH = path.join(ASSETS_DIR, 'eil-claw.icns')
const UPSCALED_PATH = path.join(os.tmpdir(), `eil-claw-upscaled-${process.pid}-${Date.now()}.png`)
const ICONSET_DIR = path.join(os.tmpdir(), `eil-claw-iconset-${process.pid}-${Date.now()}.iconset`)
const ICON_CANVAS_SIZE = 1024
const ICON_ART_SIZE = 900

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

async function makeSizedPng(size, filename) {
  await run('sips', ['-z', String(size), String(size), SQUARE_PATH, '--out', path.join(ICONSET_DIR, filename)])
}

async function main() {
  await fs.mkdir(ASSETS_DIR, { recursive: true })
  await fs.rm(ICONSET_DIR, { recursive: true, force: true })
  await fs.mkdir(ICONSET_DIR, { recursive: true })

  await fs.rm(UPSCALED_PATH, { force: true })
  await run('sips', ['-Z', String(ICON_ART_SIZE), SOURCE_PATH, '--out', UPSCALED_PATH])
  await run('sips', ['--padToHeightWidth', String(ICON_CANVAS_SIZE), String(ICON_CANVAS_SIZE), UPSCALED_PATH, '--out', SQUARE_PATH])
  await run('sips', ['-z', '64', '64', SQUARE_PATH, '--out', TRAY_PATH])

  await makeSizedPng(16, 'icon_16x16.png')
  await makeSizedPng(32, 'icon_16x16@2x.png')
  await makeSizedPng(32, 'icon_32x32.png')
  await makeSizedPng(64, 'icon_32x32@2x.png')
  await makeSizedPng(128, 'icon_128x128.png')
  await makeSizedPng(256, 'icon_128x128@2x.png')
  await makeSizedPng(256, 'icon_256x256.png')
  await makeSizedPng(512, 'icon_256x256@2x.png')
  await makeSizedPng(512, 'icon_512x512.png')
  await makeSizedPng(1024, 'icon_512x512@2x.png')

  try {
    await run('iconutil', ['-c', 'icns', ICONSET_DIR, '-o', ICNS_PATH])
  } catch (error) {
    console.warn(`Skipping icns export: ${error.message}`)
  } finally {
    await fs.rm(ICONSET_DIR, { recursive: true, force: true })
    await fs.rm(UPSCALED_PATH, { force: true })
  }

  console.log(`Generated icon assets in ${ASSETS_DIR}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
