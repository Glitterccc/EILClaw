const path = require('path')
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, dialog } = require('electron')
const { resolveStatePaths } = require('./utils/runtime-paths')
const { LauncherStore } = require('./services/launcher-store')
const { resolveUserConfig } = require('./services/config-modes')
const { resolveBundledDefaultConfig } = require('./services/bundled-default-config')
const { validateResolvedConfig } = require('./services/connection-validator')
const { OpenClawRuntime } = require('./services/openclaw-runtime')
const { WeixinBindingService } = require('./services/weixin-binding')
const { applyWeixinCompatPatch } = require('./services/weixin-plugin-compat')
const { UninstallService } = require('./services/uninstall-service')

const APP_DISPLAY_NAME = 'EIL Claw'
const LEGACY_USER_DATA_DIR = 'openclaw-launcher'

app.setPath('userData', path.join(app.getPath('appData'), LEGACY_USER_DATA_DIR))
app.setName(APP_DISPLAY_NAME)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

const statePaths = resolveStatePaths(app.getPath('userData'))
const launcherStore = new LauncherStore(statePaths)
const runtime = new OpenClawRuntime({ app, shell, statePaths })

function ensureWeixinPluginCompatibility() {
  const result = applyWeixinCompatPatch(statePaths)
  if (!result.success) {
    throw new Error(result.message || 'Failed to patch openclaw-weixin compatibility')
  }
  return result
}

const weixinBinding = new WeixinBindingService({
  app,
  shell,
  statePaths,
  onPluginReady: async () => {
    ensureWeixinPluginCompatibility()
  },
  onBindingSuccess: async () => {
    ensureWeixinPluginCompatibility()
    const result = await runtime.restart({ openChat: false })
    refreshTrayMenu()
    if (!result.success) {
      showConfigWindow('error')
      throw new Error(result.message || 'EIL Claw Gateway 重启失败')
    }
    return {
      message: 'EIL Claw Gateway 已重启，微信绑定现在应该已经生效。'
    }
  }
})
const uninstallService = new UninstallService({ app })

const appState = {
  window: null,
  tray: null,
  windowReason: 'setup',
  pendingWindowAction: null,
  isQuitting: false,
  isShuttingDown: false
}

function dismissUiForExit() {
  if (appState.tray) {
    appState.tray.destroy()
    appState.tray = null
  }
  if (appState.window && !appState.window.isDestroyed()) {
    appState.window.hide()
  }
}

function sendWindowContext() {
  if (!appState.window || appState.window.isDestroyed()) return
  appState.window.webContents.send('launcher:window-context', {
    reason: appState.windowReason,
    action: appState.pendingWindowAction
  })
}

function getBootstrapState() {
  const currentConfig = launcherStore.loadCurrentConfig()
  const runtimeStatus = runtime.getStatus()
  return {
    hasConfig: Boolean(currentConfig),
    currentConfig,
    runtimeStatus,
    weixinSnapshot: weixinBinding.getSnapshot(),
    windowReason: appState.windowReason
  }
}

function ensureBundledDefaultConfigIfNeeded() {
  if (launcherStore.hasSavedConfig()) {
    return {
      applied: false,
      currentConfig: launcherStore.loadCurrentConfig()
    }
  }

  const normalized = resolveBundledDefaultConfig({ app })
  if (!normalized) {
    return {
      applied: false,
      currentConfig: null
    }
  }

  launcherStore.saveResolvedConfig(normalized)
  return {
    applied: true,
    currentConfig: launcherStore.loadCurrentConfig()
  }
}

function createWindow() {
  if (appState.window && !appState.window.isDestroyed()) return appState.window

  appState.window = new BrowserWindow({
    width: 1260,
    height: 900,
    minWidth: 1080,
    minHeight: 760,
    resizable: true,
    show: false,
    title: APP_DISPLAY_NAME,
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : undefined,
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 20 } : undefined,
    backgroundColor: '#07111d',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'eil-claw-logo-square.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  appState.window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  appState.window.on('close', (event) => {
    if (appState.isQuitting || appState.isShuttingDown) return
    event.preventDefault()
    appState.window.hide()
  })
  appState.window.on('closed', () => {
    if (weixinBinding.isRunning()) {
      weixinBinding.cancel().catch(() => {})
    }
    appState.window = null
  })
  appState.window.webContents.on('did-finish-load', () => {
    sendWindowContext()
    appState.pendingWindowAction = null
  })
  return appState.window
}

function showConfigWindow(reason = 'setup') {
  if (reason === 'weixin') {
    appState.pendingWindowAction = 'weixin'
    appState.windowReason = launcherStore.hasSavedConfig() ? 'reconfigure' : 'setup'
  } else {
    appState.pendingWindowAction = null
    appState.windowReason = reason
  }
  const window = createWindow()
  window.show()
  window.focus()
  if (!window.webContents.isLoadingMainFrame()) {
    sendWindowContext()
    appState.pendingWindowAction = null
  }
}

async function shutdownAndExit(code = 0) {
  if (appState.isShuttingDown) return
  appState.isShuttingDown = true
  dismissUiForExit()

  try {
    if (weixinBinding.isRunning()) {
      await weixinBinding.cancel()
    }
    await runtime.stop()
  } finally {
    if (appState.tray) {
      appState.tray.destroy()
      appState.tray = null
    }
    if (appState.window && !appState.window.isDestroyed()) {
      appState.window.destroy()
      appState.window = null
    }
    appState.isQuitting = true
    app.exit(code)
  }
}

async function requestUninstall() {
  if (appState.isShuttingDown) {
    return {
      success: false,
      message: 'EIL Claw 正在退出，请稍候。'
    }
  }

  const uninstallAppBundlePath = uninstallService.getAppBundlePath()

  const confirmation = await dialog.showMessageBox(appState.window || undefined, {
    type: 'warning',
    title: '卸载 EIL Claw',
    message: '卸载并清除 EIL Claw 的本地数据？',
    detail: uninstallAppBundlePath
      ? '这会停止 Gateway，删除 EIL Claw 的本地配置、日志、插件、微信绑定数据、工作区与缓存，并在退出后删除当前安装的 EIL Claw.app 本体。\n\n不会删除你下载的 DMG，也不会清理 ClawLite 或其他 OpenClaw 安装。'
      : '这会停止 Gateway，删除 EIL Claw 的本地配置、日志、插件、微信绑定数据、工作区与缓存，然后退出应用。\n\n如果当前是从磁盘映像运行，则不会删除 DMG 里的 App 本体，也不会清理 ClawLite 或其他 OpenClaw 安装。',
    buttons: ['取消', '卸载并退出'],
    defaultId: 1,
    cancelId: 0,
    noLink: true
  })

  if (confirmation.response !== 1) {
    return {
      success: false,
      cancelled: true
    }
  }

  appState.isShuttingDown = true

  try {
    const cleanupPlan = uninstallService.scheduleCleanup({
      targetPids: [
        ...runtime.getKnownProcessPids(),
        weixinBinding.getTrackedPid()
      ]
    })

    dismissUiForExit()

    if (weixinBinding.isRunning()) {
      weixinBinding.cancel().catch(() => {})
    }
    runtime.stop().catch(() => {})

    const finalizeExit = () => {
      if (appState.window && !appState.window.isDestroyed()) {
        appState.window.destroy()
        appState.window = null
      }
      appState.isQuitting = true
      app.exit(0)
    }

    setTimeout(finalizeExit, 80)

    return {
      success: true,
      cleanupTargets: cleanupPlan.cleanupTargets,
      message: cleanupPlan.appBundlePath
        ? 'EIL Claw 正在退出、清除本地数据，并卸载当前 .app 本体。'
        : 'EIL Claw 正在退出并清除本地数据。'
    }
  } catch (error) {
    appState.isShuttingDown = false
    return {
      success: false,
      message: error.message || '卸载失败'
    }
  }
}

function createTray() {
  if (appState.tray) return appState.tray
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon-template.png')
  const image = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 })
  image.setTemplateImage(true)
  appState.tray = new Tray(image)
  appState.tray.setToolTip(APP_DISPLAY_NAME)
  appState.tray.on('click', () => {
    showConfigWindow(launcherStore.hasSavedConfig() ? 'configured' : 'setup')
  })
  refreshTrayMenu()
  return appState.tray
}

function refreshTrayMenu() {
  if (!appState.tray) return
  const status = runtime.getStatus()
  appState.tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Open EIL Claw',
      click: () => showConfigWindow(launcherStore.hasSavedConfig() ? 'configured' : 'setup')
    },
    {
      label: 'Open Chat',
      click: async () => {
        if (!launcherStore.hasSavedConfig()) {
          showConfigWindow('setup')
          return
        }
        const result = await runtime.start({ openChat: true })
        if (!result.success) showConfigWindow('error')
      }
    },
    {
      label: '微信绑定',
      click: () => showConfigWindow('weixin')
    },
    {
      label: 'Reconfigure LLM',
      click: () => showConfigWindow('reconfigure')
    },
    {
      label: 'Stop OpenClaw',
      click: async () => {
        await runtime.stop()
        refreshTrayMenu()
      }
    },
    {
      label: '卸载并清除数据…',
      click: () => {
        requestUninstall().catch(() => {})
      }
    },
    {
      label: 'Restart OpenClaw',
      click: async () => {
        if (!launcherStore.hasSavedConfig()) {
          showConfigWindow('setup')
          return
        }
        const result = await runtime.restart({ openChat: true })
        if (!result.success) showConfigWindow('error')
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => shutdownAndExit(0)
    }
  ]))
}

ipcMain.handle('bootstrap:getState', async () => getBootstrapState())
ipcMain.handle('config:loadCurrent', async () => launcherStore.loadCurrentConfig())
ipcMain.handle('runtime:getStatus', async () => runtime.getStatus())
ipcMain.handle('weixin:getState', async () => weixinBinding.getSnapshot())
ipcMain.handle('app:uninstall', async () => requestUninstall())

ipcMain.handle('runtime:start', async () => {
  if (!launcherStore.hasSavedConfig()) {
    showConfigWindow('setup')
    return { success: false, message: 'LLM is not configured yet' }
  }
  const result = await runtime.start({ openChat: true })
  if (!result.success) showConfigWindow('error')
  refreshTrayMenu()
  return result
})

ipcMain.handle('runtime:restart', async () => {
  if (!launcherStore.hasSavedConfig()) {
    showConfigWindow('setup')
    return { success: false, message: 'LLM is not configured yet' }
  }
  const result = await runtime.restart({ openChat: true })
  if (!result.success) showConfigWindow('error')
  refreshTrayMenu()
  return result
})

ipcMain.handle('runtime:stop', async () => {
  const result = await runtime.stop()
  refreshTrayMenu()
  return result
})

ipcMain.handle('runtime:openChat', async () => {
  if (!launcherStore.hasSavedConfig()) {
    showConfigWindow('setup')
    return { success: false, message: 'LLM is not configured yet' }
  }
  const result = await runtime.start({ openChat: true })
  if (!result.success) showConfigWindow('error')
  refreshTrayMenu()
  return result
})

ipcMain.handle('weixin:start', async () => {
  if (!launcherStore.hasSavedConfig()) {
    showConfigWindow('setup')
    return {
      success: false,
      message: 'LLM is not configured yet'
    }
  }
  return weixinBinding.start()
})

ipcMain.handle('weixin:cancel', async () => weixinBinding.cancel())
ipcMain.handle('weixin:openScanUrl', async () => weixinBinding.openScanUrl())

ipcMain.handle('config:validateAndSave', async (_, payload) => {
  try {
    const normalized = resolveUserConfig(payload)
    const validation = await validateResolvedConfig(normalized.resolved)
    if (!validation.success) return validation

    if (runtime.getStatus().status === 'running' || runtime.getStatus().status === 'starting') {
      await runtime.stop()
    }

    launcherStore.saveResolvedConfig(normalized)
    weixinBinding.preparePluginIfNeeded().catch(() => {})
    const startResult = await runtime.start({ openChat: false })
    if (!startResult.success) {
      showConfigWindow('error')
      refreshTrayMenu()
      return startResult
    }

    await runtime.openChat()
    showConfigWindow('configured')
    refreshTrayMenu()
    return {
      success: true,
      currentConfig: launcherStore.loadCurrentConfig(),
      url: runtime.getStatus().url
    }
  } catch (error) {
    return {
      success: false,
      message: error.message || 'Failed to save configuration'
    }
  }
})

app.on('second-instance', async () => {
  showConfigWindow(launcherStore.hasSavedConfig() ? 'configured' : 'setup')
})

app.on('activate', async () => {
  showConfigWindow(launcherStore.hasSavedConfig() ? 'configured' : 'setup')
})

runtime.on('status-changed', () => {
  refreshTrayMenu()
  sendWindowContext()
})

weixinBinding.on('update', (snapshot) => {
  if (appState.window && !appState.window.isDestroyed()) {
    appState.window.webContents.send('weixin:update', snapshot)
  }
})

app.whenReady().then(async () => {
  if (app.dock?.show) app.dock.show()
  createTray()
  ensureWeixinPluginCompatibility()

  let bundledDefaultApplied = false
  try {
    const ensuredConfig = ensureBundledDefaultConfigIfNeeded()
    bundledDefaultApplied = ensuredConfig.applied
  } catch (error) {
    appState.windowReason = 'error'
  }

  showConfigWindow(launcherStore.hasSavedConfig() ? 'configured' : 'setup')

  if (!launcherStore.hasSavedConfig()) {
    return
  }

  weixinBinding.preparePluginIfNeeded().catch(() => {})
  const result = await runtime.start({ openChat: false })
  if (!result.success) {
    showConfigWindow('error')
    return
  }

  if (bundledDefaultApplied) {
    runtime.openChat().catch(() => {})
  }
})

app.on('window-all-closed', (event) => {
  if (appState.isQuitting) return
  event.preventDefault()
})

app.on('before-quit', (event) => {
  if (appState.isQuitting) return
  event.preventDefault()
  shutdownAndExit(0).catch(() => {
    appState.isQuitting = true
    app.exit(1)
  })
})
