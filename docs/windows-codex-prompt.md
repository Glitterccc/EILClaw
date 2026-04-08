# Prompt for Windows Codex

Use this prompt when handing the repo to the Windows-side Codex:

---

You are continuing development on `EIL Claw` from the macOS branch of the project.

Start by reading these files first:

- `docs/windows-codex-handoff.md`
- `electron/main.js`
- `electron/services/openclaw-runtime.js`
- `electron/services/weixin-binding.js`
- `electron/services/bundled-plugin-sync.js`
- `electron/services/config-modes.js`
- `renderer/index.html`
- `renderer/styles.css`
- `renderer/app.js`

Your job is to build the Windows version of EIL Claw without regressing the UX and runtime fixes that were already discovered on macOS.

Non-negotiable product behavior:

- EIL Claw is a desktop launcher, not a web landing page.
- First launch opens configuration UI, not JSON files.
- Runtime is bundled.
- WeChat plugin is bundled.
- Gateway port default is `38789`.
- Chat opens in the system browser.
- Launcher owns gateway lifecycle.

Do not regress these macOS lessons:

- Preserve `gateway.auth` when rewriting `openclaw.json`
- Keep NewAPI model editable
- Keep validation as a real `chat/completions` request
- Do not reinstall the WeChat plugin on every bind
- Plugin install metadata must use `source: "path"`
- Do not rely on the plugin to restart the gateway
- Do not use Unix-only process discovery on Windows

UI direction:

- Build a compact desktop control console
- Keep copy short and operational
- Avoid marketing hero sections and long explanatory paragraphs
- Avoid oversized “recent activity” panes unless they are clearly useful
- Use a darker, more technical visual style with strong hierarchy
- The app should feel like a real tool, not a concept page

Suggested work order:

1. Replace Unix-specific runtime/process logic with Windows-safe equivalents.
2. Make bundled runtime resolution work on Windows.
3. Add Windows packaging target and installer flow.
4. Bring up the main window and configuration flow.
5. Verify browser auth sync and gateway ownership behavior.
6. Verify bundled WeChat plugin sync and login.
7. Polish Windows window chrome, tray behavior, and uninstall behavior.

While working:

- Prefer code changes over long planning unless blocked.
- Keep the main window concise.
- If you change the UI, keep it denser and more product-like than the earlier macOS draft.
- Add or update tests for every bug you fix.

Before claiming success, run the Windows smoke checklist from `docs/windows-codex-handoff.md`.

---
