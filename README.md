# OpenClaw Launcher

A lean macOS menu bar launcher for OpenClaw.

## Handoff docs

- Windows development handoff: `docs/windows-codex-handoff.md`

## What it does

- Opens a first-run configuration wizard instead of asking users to edit JSON.
- Writes the OpenClaw files needed for API-key-based providers.
- Starts or restarts the local OpenClaw gateway.
- Opens the chat UI in the default browser.

## Local development

1. Install app dependencies:

   ```bash
   npm install
   ```

2. Sync a local bundled runtime:

   ```bash
   npm run sync:runtime
   ```

3. Start the launcher:

   ```bash
   npm run dev
   ```

## Runtime sync

`npm run sync:runtime` copies a local `node-runtime` directory into this repo.

Default source:

`/Users/glitterc/Desktop/CodeX_codes/ClawLite-feat-macos-installer-plan/node-runtime`

Override it with:

```bash
OPENCLAW_RUNTIME_SOURCE=/absolute/path/to/node-runtime npm run sync:runtime
```
