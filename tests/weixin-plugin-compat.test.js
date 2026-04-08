const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  applyWeixinCompatPatch,
  needsWeixinCompatPatch,
  resolveWeixinProcessMessagePath
} = require('../electron/services/weixin-plugin-compat')
const { resolveStatePaths } = require('../electron/utils/runtime-paths')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eil-claw-weixin-compat-'))
}

function writeLegacyPluginSource(statePaths) {
  const filePath = resolveWeixinProcessMessagePath(statePaths)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `import {
  createTypingCallbacks,
  resolveSenderCommandAuthorizationWithRuntime,
  resolveDirectDmAuthorizationOutcome,
  resolvePreferredOpenClawTmpDir,
} from "openclaw/plugin-sdk";

async function demo(deps, ctx, full) {
  const rawBody = ctx.Body?.trim() ?? "";
  const senderId = full.from_user_id ?? "";
  const { senderAllowedForCommands, commandAuthorized } =
    await resolveSenderCommandAuthorizationWithRuntime({
      cfg: deps.config,
      rawBody,
      isGroup: false,
      dmPolicy: "pairing",
      configuredAllowFrom: [],
      configuredGroupAllowFrom: [],
      senderId,
      isSenderAllowed: (id, list) => list.length === 0 || list.includes(id),
      readAllowFromStore: async () => [],
      runtime: deps.channelRuntime.commands,
    });

  const directDmOutcome = resolveDirectDmAuthorizationOutcome({
    isGroup: false,
    dmPolicy: "pairing",
    senderAllowedForCommands,
  });

  if (directDmOutcome === "disabled" || directDmOutcome === "unauthorized") {
    return;
  }

  ctx.CommandAuthorized = commandAuthorized;
}
`, 'utf8')
  return filePath
}

test('needsWeixinCompatPatch detects legacy plugin source', () => {
  assert.equal(needsWeixinCompatPatch('resolveSenderCommandAuthorizationWithRuntime'), true)
  assert.equal(needsWeixinCompatPatch('resolveDirectDmAuthorizationOutcome'), true)
  assert.equal(needsWeixinCompatPatch('resolveSenderCommandAuthorization'), false)
})

test('applyWeixinCompatPatch rewrites legacy weixin plugin auth calls', () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  const filePath = writeLegacyPluginSource(statePaths)

  const result = applyWeixinCompatPatch(statePaths)
  const patched = fs.readFileSync(filePath, 'utf8')

  assert.equal(result.success, true)
  assert.equal(result.applied, true)
  assert.match(patched, /resolveSenderCommandAuthorization\(/)
  assert.match(patched, /shouldComputeCommandAuthorized/)
  assert.match(patched, /resolveCommandAuthorizedFromAuthorizers/)
  assert.doesNotMatch(patched, /resolveSenderCommandAuthorizationWithRuntime/)
  assert.doesNotMatch(patched, /resolveDirectDmAuthorizationOutcome/)
})

test('applyWeixinCompatPatch is a no-op when plugin source is already compatible', () => {
  const userDataDir = tempDir()
  const statePaths = resolveStatePaths(userDataDir)
  const filePath = resolveWeixinProcessMessagePath(statePaths)

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, 'const ok = resolveSenderCommandAuthorization;', 'utf8')

  const result = applyWeixinCompatPatch(statePaths)

  assert.equal(result.success, true)
  assert.equal(result.applied, false)
  assert.equal(result.reason, 'not-needed')
})
