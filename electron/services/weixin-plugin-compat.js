const fs = require('fs')
const path = require('path')

const PROCESS_MESSAGE_RELATIVE_PATH = path.join('extensions', 'openclaw-weixin', 'src', 'messaging', 'process-message.ts')

const AUTH_BLOCK_PATTERN =
  /  const \{ senderAllowedForCommands, commandAuthorized \} =[\s\S]*?  ctx\.CommandAuthorized = commandAuthorized;?/m

const COMPAT_AUTH_BLOCK = `  const { senderAllowedForCommands, commandAuthorized } =
    await resolveSenderCommandAuthorization({
      cfg: deps.config,
      rawBody,
      isGroup: false,
      dmPolicy: "pairing",
      configuredAllowFrom: [],
      configuredGroupAllowFrom: [],
      senderId,
      isSenderAllowed: (id: string, list: string[]) => list.length === 0 || list.includes(id),
      /** Pairing: framework credentials \`*-allowFrom.json\`, with account \`userId\` fallback for legacy installs. */
      readAllowFromStore: async () => {
        const fromStore = readFrameworkAllowFromList(deps.accountId);
        if (fromStore.length > 0) return fromStore;
        const uid = loadWeixinAccount(deps.accountId)?.userId?.trim();
        return uid ? [uid] : [];
      },
      shouldComputeCommandAuthorized: (body, cfg) =>
        deps.channelRuntime.commands.shouldComputeCommandAuthorized(body, cfg),
      resolveCommandAuthorizedFromAuthorizers: (params) =>
        deps.channelRuntime.commands.resolveCommandAuthorizedFromAuthorizers(params),
    });

  if (!senderAllowedForCommands) {
    logger.info(
      \`authorization: dropping message from=\${senderId} outcome=unauthorized\`,
    );
    return;
  }

  ctx.CommandAuthorized = commandAuthorized;`

function resolveWeixinProcessMessagePath(statePaths) {
  return path.join(statePaths.stateDir, PROCESS_MESSAGE_RELATIVE_PATH)
}

function needsWeixinCompatPatch(source) {
  const text = String(source || '')
  return text.includes('resolveSenderCommandAuthorizationWithRuntime') ||
    text.includes('resolveDirectDmAuthorizationOutcome')
}

function patchImportBlock(source) {
  let nextSource = source
  nextSource = nextSource.replace(
    /(\s*)resolveSenderCommandAuthorizationWithRuntime,/,
    '$1resolveSenderCommandAuthorization,'
  )
  nextSource = nextSource.replace(/\n\s*resolveDirectDmAuthorizationOutcome,/, '')
  return nextSource
}

function patchAuthorizationBlock(source) {
  if (!AUTH_BLOCK_PATTERN.test(source)) {
    return source
  }

  return source.replace(AUTH_BLOCK_PATTERN, COMPAT_AUTH_BLOCK)
}

function applyWeixinCompatPatch(statePaths) {
  const filePath = resolveWeixinProcessMessagePath(statePaths)
  if (!fs.existsSync(filePath)) {
    return {
      success: true,
      applied: false,
      reason: 'missing',
      filePath
    }
  }

  const source = fs.readFileSync(filePath, 'utf8')
  if (!needsWeixinCompatPatch(source)) {
    return {
      success: true,
      applied: false,
      reason: 'not-needed',
      filePath
    }
  }

  let nextSource = source
  nextSource = patchImportBlock(nextSource)
  nextSource = patchAuthorizationBlock(nextSource)

  if (nextSource === source) {
    return {
      success: false,
      applied: false,
      reason: 'pattern-mismatch',
      filePath,
      message: 'Failed to patch openclaw-weixin compatibility block'
    }
  }

  fs.writeFileSync(filePath, nextSource, 'utf8')
  return {
    success: true,
    applied: true,
    reason: 'patched',
    filePath
  }
}

module.exports = {
  PROCESS_MESSAGE_RELATIVE_PATH,
  resolveWeixinProcessMessagePath,
  needsWeixinCompatPatch,
  applyWeixinCompatPatch
}
