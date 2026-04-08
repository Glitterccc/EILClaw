# EIL Claw Windows Handoff

Last updated: 2026-04-08

This document is for the Windows-side Codex that will continue EIL Claw development after this repo is pushed to GitHub.

## Product goal

Keep the same UX promise as macOS:

- User downloads an installer and opens the app.
- First launch shows an LLM setup wizard instead of asking users to edit JSON.
- The app writes OpenClaw config, starts the local gateway, and opens chat automatically.
- Users do not need to install Node, OpenClaw, or any plugin manually.

## Current architecture

These files are the main entry points:

- `electron/main.js`
  Main-process orchestration: single-instance lock, tray/menu, config window, uninstall entry, IPC.
- `electron/services/config-modes.js`
  Converts UI form input into `openclaw.json`, `auth-profiles.json`, and launcher config.
- `electron/services/openclaw-runtime.js`
  Starts/stops the bundled OpenClaw gateway, waits for readiness, opens chat, and handles orphaned runtime state.
- `electron/services/weixin-binding.js`
  Syncs the bundled WeChat plugin into the local state dir and runs the login flow.
- `electron/services/bundled-plugin-sync.js`
  Copies the bundled plugin into `openclaw-state/extensions` and writes plugin install metadata into `openclaw.json`.
- `electron/services/uninstall-service.js`
  Schedules post-exit cleanup of local data and the installed app bundle.
- `electron/utils/runtime-paths.js`
  Resolves runtime paths, bundled plugin paths, state paths, and the default gateway port.

## Invariants to keep

These should stay true on Windows unless there is a very strong reason to change them:

- App display name: `EIL Claw`
- Default gateway port: `38789`
- State root: `app.getPath('userData')/openclaw-state`
- Legacy userData directory name: `openclaw-launcher`
  Keep this for upgrade compatibility even though the product name is now `EIL Claw`.
- Runtime is bundled with the app.
- WeChat plugin is bundled with the app.
- Chat opens in the system browser, not in a WebView.
- Gateway restart/stop/start is owned by the launcher, not by system services.

## Important config behaviors

### 1. Preserve `gateway.auth` when rewriting config

Do not overwrite the whole `openclaw.json` blindly.

Why:

- OpenClaw may write `gateway.auth.token` or `gateway.auth.password` into the config.
- If the launcher wipes that block, the browser may keep using an old token from local storage.
- The result is:
  `unauthorized: too many failed authentication attempts (retry later)`

Current fix already implemented:

- `electron/services/config-modes.js` preserves existing `gateway`, `auth`, and other runtime-owned sections when generating new config.
- `electron/services/openclaw-runtime.js` opens chat with a one-time `?token=` or `?password=` query param when present.

Do not regress this behavior on Windows.

### 2. Keep NewAPI model editable

`NewAPI (api2.aigcbest.top)` is no longer hardcoded to MiniMax.

Current behavior:

- Base URL is fixed to `https://api2.aigcbest.top/v1`
- Model is editable in the UI
- New provider id is `api-proxy-newapi`
- Old `api-proxy-newapi-minimax` configs are still readable for compatibility

The relevant logic is in `electron/services/config-modes.js` and `renderer/app.js`.

### 3. Keep the validation flow real

The launcher validates provider settings by sending a real `chat/completions` request before saving.

This logic is in `electron/services/connection-validator.js`.

Do not replace this with a fake ping check, or users will save broken configs.

## WeChat plugin lessons

### 1. Bundle the plugin offline

The WeChat plugin must ship inside the app as a bundled resource.

Current repo layout:

- `bundled-plugins/openclaw-weixin`

Current behavior:

- On bind, the launcher syncs the bundled plugin into:
  `openclaw-state/extensions/openclaw-weixin`
- Then it writes plugin config into `openclaw.json`

Do not go back to runtime `npm install` or `npx ... install` for normal binding flow.

### 2. Do not reinstall the plugin during every bind

This was a real macOS pitfall.

Why it broke:

- Reinstalling the plugin overwrote local compatibility patches.
- Users could bind successfully, but message handling broke afterward.

Current behavior:

- Plugin is prepared from bundled resources
- Binding only runs:
  `openclaw channels login --channel openclaw-weixin`

That behavior lives in `electron/services/weixin-binding.js`.

### 3. Plugin install metadata must use `source: "path"`

This one caused a startup failure that looked like a generic readiness timeout.

Broken config:

- `plugins.installs.openclaw-weixin.source = "bundled"`

Correct config:

- `plugins.installs.openclaw-weixin.source = "path"`
- `sourcePath` must be set
- `installPath` must be set

If this is wrong, OpenClaw fails config validation and exits before ready.

Current working logic is in `electron/services/bundled-plugin-sync.js`.

### 4. Do not trust the plugin to restart the gateway

Another macOS pitfall:

- The plugin tried to run `openclaw gateway restart`
- That assumes OpenClaw was installed as a system service
- EIL Claw does not use that model

Current fix:

- When binding succeeds, the launcher itself calls `runtime.restart()`

That logic is wired from `electron/main.js` into `electron/services/weixin-binding.js`.

### 5. Do not disable channels accidentally

At one point gateway started fine but WeChat messages never got replies because channels were skipped.

If you see gateway working but no WeChat response:

- Verify the launcher is not injecting any environment flag that disables channels.
- Verify the plugin is enabled in `openclaw.json`.

## Runtime and process-management lessons

### 1. Generic “did not become ready in time” often hides a real config error

We hit this on macOS.

The fix was to surface meaningful stderr/config-invalid messages instead of only saying:

- `OpenClaw gateway did not become ready in time`

Current behavior in `electron/services/openclaw-runtime.js`:

- Recent stderr and config-invalid logs are scanned
- If config validation failed, the user gets the real reason

Keep that behavior.

### 2. Port conflicts may be false positives

We saw this after restarts and after WeChat binding.

Problem:

- The gateway was still running
- `gateway.pid` had been lost or gone stale
- The launcher thought another app owned the port

Current fix:

- The runtime can adopt an already-running owned gateway on the configured port
- It persists the adopted pid and treats it as its own process

This logic is in `electron/services/openclaw-runtime.js`.

### 3. Windows-specific warning: current owned-process detection is still Unix-centric

This is the single biggest runtime item for Windows.

Current macOS implementation uses:

- `lsof` to find listeners on the port
- `lsof -p` to infer whether the process is using this launcher's config/workspace

That logic lives in `electron/services/openclaw-runtime.js`.

This will not work on Windows as-is.

Recommended Windows replacement:

- Replace `lsof`-based port discovery with `netstat -ano` or PowerShell `Get-NetTCPConnection`
- Replace open-file inspection with a more Windows-friendly ownership signal

Recommended ownership strategies:

- Best option: rely on a launcher-owned pid file plus process command-line inspection
- Alternative: inject a launcher-specific environment marker and inspect process metadata
- At minimum: persist the pid reliably and kill only processes the launcher started

Do not ship Windows with raw `lsof` assumptions still in place.

### 4. Detached process behavior differs on Windows

The code already has several `process.platform !== 'win32'` branches for:

- negative-pid tree kill
- `detached`

Search for `process.platform !== 'win32'` before changing runtime behavior.

## Packaging lessons

### 1. Do not copy machine-specific symlinks into the packaged runtime

This caused the macOS app to look “damaged” on other machines.

What happened:

- Runtime files were copied with symlinks that still pointed to the source machine
- The packaged app contained broken links

Current fix:

- `scripts/sync-local-runtime.mjs` copies with `dereference: true`

Windows takeaway:

- Make sure the Windows runtime bundle is physically self-contained
- No absolute host-machine paths
- No unresolved symlinks/junctions that break on another PC

### 2. The current repo is still mac-first

Current build scripts are mac-only:

- `npm run build:dir`
- `npm run build:mac`
- `scripts/create-dmg.mjs`
- `scripts/adhoc-sign.mjs`

Windows work will need new build scripts and `electron-builder` config.

Recommended direction:

- Add `build.win`
- Add `npm run build:win`
- Use `nsis` as the first installer target

Why `nsis` is a good first target:

- Cleaner install/uninstall story
- Better fit for self-contained desktop distribution
- Easier to give users a normal Windows installer UX

### 3. The runtime sync script has a hardcoded macOS source path

Current file:

- `scripts/sync-local-runtime.mjs`

Current default:

- `/Users/glitterc/Desktop/CodeX_codes/ClawLite-feat-macos-installer-plan/node-runtime`

Do not rely on that in Windows work.

Before doing anything else on Windows, either:

- provide `OPENCLAW_RUNTIME_SOURCE`, or
- rewrite the script to require an explicit source path, or
- add a Windows-specific runtime-sync script

## UI and platform notes

### 1. Tray behavior is currently mac-first

macOS-specific behavior currently includes:

- `LSUIElement` app style
- template tray icon behavior
- app-bundle deletion in uninstall flow

Windows should keep the same product behavior, but not copy the platform assumptions blindly.

Recommended Windows adaptation:

- use a normal tray icon, not mac template-image semantics
- decide explicitly whether first launch should show a normal window or minimize-to-tray later
- do not reuse `.app` deletion logic

### 2. Browser auth sync matters

Always open chat via the runtime’s computed URL, not a hardcoded `http://127.0.0.1:38789`.

Use:

- `runtime.openChat()`
- `runtime.getOpenChatUrl()`

This keeps browser auth aligned with the current gateway token/password.

## Uninstall lessons

macOS uninstall currently:

- stops the gateway
- cancels WeChat binding if running
- deletes local state and logs
- deletes the installed `.app` bundle after exit
- does not delete the downloaded `.dmg`

This logic is in `electron/services/uninstall-service.js`.

Windows should not copy the mac `.app` deletion path directly.

Recommended Windows uninstall plan:

- use installer-managed uninstall if using NSIS
- keep “clear app data” as a launcher feature
- let the installer own removal of the installed app files

If you insist on self-uninstall:

- use a helper process or installer stub
- exit the main process first
- then delete the install directory

## Recommended Windows work order

1. Add Windows build config and package target.
2. Prepare a valid Windows `node-runtime` layout and make `runtime-paths.js` resolve it correctly.
3. Replace Unix-only process discovery in `openclaw-runtime.js`.
4. Verify first-run configuration and gateway start on Windows.
5. Verify browser open flow with gateway auth token/password.
6. Verify bundled WeChat plugin sync and `channels login`.
7. Implement Windows install/uninstall behavior.
8. Only after the above, polish tray behavior and Windows branding details.

## Smoke-test checklist for Windows

Use this exact checklist before calling the Windows port “working”:

- Fresh machine, no Node installed manually
- Install EIL Claw
- Launch app
- See first-run config wizard
- Save a valid provider config
- Gateway starts on port `38789`
- Browser opens and chat UI is reachable
- Restart app and verify config persists
- Reconfigure model/provider and verify old gateway auth is not broken
- Run WeChat bind
- Verify QR/login flow works
- Send a WeChat message and confirm reply works
- Uninstall app and confirm local state is removed

## Current tests worth reading first

- `tests/config-modes.test.js`
- `tests/openclaw-runtime-stop.test.js`
- `tests/weixin-binding.test.js`
- `tests/bundled-plugin-sync.test.js`
- `tests/uninstall-service.test.js`

These tests encode most of the bugs that were already fixed on macOS.

## Suggested first refactor on Windows

Before adding more features, refactor runtime process ownership into a platform adapter.

Good split:

- `process-discovery.unix.js`
- `process-discovery.windows.js`

Then let `openclaw-runtime.js` depend on that abstraction instead of calling Unix tools directly.

That one refactor will remove a lot of Windows pain early.
