#!/usr/bin/env node

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await fs.readFile(path.join(ROOT_DIR, "package.json"), "utf8"),
);

const APP_NAME = packageJson.build?.productName || packageJson.productName || "EIL Claw";
const VERSION = packageJson.version;
const APP_PATH = path.join(ROOT_DIR, "release", "mac-arm64", `${APP_NAME}.app`);
const OUT_DMG = path.join(ROOT_DIR, "release", `${APP_NAME}-${VERSION}-mac-arm64.dmg`);
const TMP_DMG = path.join("/tmp", `eil-claw-${process.pid}-${Date.now()}.dmg`);
const VOL_NAME = `${APP_NAME} ${VERSION}-arm64`;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function runWithRetry(attempts, command, args) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await run(command, args);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        throw error;
      }

      console.warn(
        `Retrying ${command} (${attempt}/${attempts}) after failure: ${error.message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  throw lastError;
}

async function main() {
  const appStat = await fs.stat(APP_PATH).catch(() => null);
  if (!appStat?.isDirectory()) {
    throw new Error(`Missing app bundle: ${APP_PATH}`);
  }

  await fs.rm(OUT_DMG, { force: true });
  await fs.rm(TMP_DMG, { force: true });

  try {
    await runWithRetry(5, "hdiutil", [
      "create",
      "-srcfolder",
      APP_PATH,
      "-volname",
      VOL_NAME,
      "-anyowners",
      "-nospotlight",
      "-format",
      "UDRW",
      "-fs",
      "APFS",
      TMP_DMG,
    ]);

    await runWithRetry(5, "hdiutil", [
      "convert",
      TMP_DMG,
      "-format",
      "UDZO",
      "-imagekey",
      "zlib-level=9",
      "-o",
      OUT_DMG,
    ]);
  } finally {
    await fs.rm(TMP_DMG, { force: true });
  }

  console.log(`Created DMG: ${OUT_DMG}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
