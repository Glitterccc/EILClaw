const MODES = {
  openai_compatible: {
    label: '通用 OpenAI 兼容',
    description: '自定义 Base URL、API Key 和模型名。'
  },
  minimax_bailian: {
    label: 'MiniMax / 阿里云百炼',
    description: '固定百炼地址，适配 MiniMax。'
  },
  minimax_newapi: {
    label: 'NewAPI (api2.aigcbest.top)',
    description: '固定 NewAPI 地址，可自定义模型。'
  },
  advanced: {
    label: '高级自定义',
    description: '手动填写 provider、地址和模型。'
  }
}

const stateValue = document.getElementById('stateValue')
const gatewayValue = document.getElementById('gatewayValue')
const currentModelValue = document.getElementById('currentModelValue')
const configModeValue = document.getElementById('configModeValue')
const providerValue = document.getElementById('providerValue')
const baseUrlValue = document.getElementById('baseUrlValue')
const savedAtValue = document.getElementById('savedAtValue')
const chatUrlValue = document.getElementById('chatUrlValue')
const heroStateBadge = document.getElementById('heroStateBadge')
const banner = document.getElementById('banner')

const modeSelect = document.getElementById('modeSelect')
const modeDescription = document.getElementById('modeDescription')
const configForm = document.getElementById('configForm')
const saveButton = document.getElementById('saveButton')
const openChatButton = document.getElementById('openChatButton')
const weixinButton = document.getElementById('weixinButton')
const stopButton = document.getElementById('stopButton')
const restartButton = document.getElementById('restartButton')
const uninstallButton = document.getElementById('uninstallButton')
const modeSections = [...document.querySelectorAll('.mode-fields')]

const weixinSummaryState = document.getElementById('weixinSummaryState')
const weixinSummaryHint = document.getElementById('weixinSummaryHint')
const weixinSummaryError = document.getElementById('weixinSummaryError')

const weixinModal = document.getElementById('weixinModal')
const weixinCloseButton = document.getElementById('weixinCloseButton')
const weixinStateValue = document.getElementById('weixinStateValue')
const weixinErrorValue = document.getElementById('weixinErrorValue')
const weixinQrImage = document.getElementById('weixinQrImage')
const weixinQrPlaceholder = document.getElementById('weixinQrPlaceholder')
const weixinLogs = document.getElementById('weixinLogs')
const weixinStartButton = document.getElementById('weixinStartButton')
const weixinOpenBrowserButton = document.getElementById('weixinOpenBrowserButton')
const weixinCancelButton = document.getElementById('weixinCancelButton')

let bootstrapState = null
let weixinSnapshot = null

const DISPLAY_TEXT = {
  '--': '--',
  idle: '空闲',
  setup: '首次配置',
  reconfigure: '重新配置',
  error: '启动异常',
  unconfigured: '未配置',
  configured: '已配置',
  starting: '启动中',
  running: '运行中',
  stopped: '已停止',
  stopping: '停止中',
  failed: '失败',
  installing_plugin: '安装插件',
  waiting_scan: '等待扫码',
  restarting_gateway: '重启 Gateway',
  succeeded: '已完成',
  cancelled: '已取消',
  validating: '验证中'
}

function toDisplayText(value) {
  return DISPLAY_TEXT[value] || value || '--'
}

function getTone(value) {
  if (['error', 'failed'].includes(value)) return 'danger'
  if (['starting', 'stopping', 'validating', 'installing_plugin', 'waiting_scan', 'restarting_gateway'].includes(value)) return 'warning'
  if (['stopped', 'unconfigured', 'cancelled', 'idle', '--'].includes(value)) return 'muted'
  return ''
}

function applyTone(element, value) {
  const tone = getTone(value)
  if (!element) return
  if (!tone) {
    element.removeAttribute('data-tone')
    return
  }
  element.setAttribute('data-tone', tone)
}

function formatDate(value) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--'
  return date.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function deriveLauncherState(nextState) {
  if (!nextState?.hasConfig) return 'unconfigured'
  if (nextState.runtimeStatus?.status === 'error') return 'error'
  return 'configured'
}

function populateModes() {
  for (const [mode, meta] of Object.entries(MODES)) {
    const option = document.createElement('option')
    option.value = mode
    option.textContent = meta.label
    modeSelect.appendChild(option)
  }
}

function showBanner(message, tone = 'info') {
  if (!message) {
    banner.classList.add('hidden')
    banner.textContent = ''
    banner.classList.remove('error')
    return
  }
  banner.classList.remove('hidden')
  banner.textContent = message
  banner.classList.toggle('error', tone === 'error')
}

function setBusy(isBusy, label) {
  saveButton.disabled = isBusy
  openChatButton.disabled = isBusy
  weixinButton.disabled = isBusy || !Boolean(bootstrapState?.hasConfig)
  stopButton.disabled = isBusy
  restartButton.disabled = isBusy
  uninstallButton.disabled = isBusy
  saveButton.textContent = isBusy ? label : '保存并启动'
}

function getCurrentConfigSummary(config) {
  const currentConfig = config || {}
  const values = currentConfig.values || {}
  const resolved = currentConfig.resolved || {}
  return {
    modeLabel: MODES[currentConfig.mode]?.label || '--',
    model: resolved.modelId || values.model || values.modelId || '--',
    provider: resolved.providerId || values.providerId || '--',
    baseUrl: resolved.baseUrl || values.baseUrl || '--',
    savedAt: formatDate(currentConfig.savedAt)
  }
}

function renderOverview(nextState) {
  const runtimeStatus = nextState.runtimeStatus || {}
  const summary = getCurrentConfigSummary(nextState.currentConfig)
  const launcherState = deriveLauncherState(nextState)

  stateValue.textContent = toDisplayText(launcherState)
  gatewayValue.textContent = toDisplayText(runtimeStatus.status || '--')
  currentModelValue.textContent = summary.model
  configModeValue.textContent = summary.modeLabel
  providerValue.textContent = summary.provider
  baseUrlValue.textContent = summary.baseUrl
  savedAtValue.textContent = summary.savedAt
  chatUrlValue.textContent = runtimeStatus.url || '--'

  heroStateBadge.textContent = nextState.hasConfig
    ? `Gateway ${toDisplayText(runtimeStatus.status || 'configured')}`
    : '未配置'
  applyTone(heroStateBadge, nextState.hasConfig ? (runtimeStatus.status || 'configured') : 'unconfigured')
}

function getWeixinSummaryText(snapshot) {
  const state = snapshot?.state || 'idle'
  if (state === 'waiting_scan' && snapshot.scanUrl) {
    return '二维码已生成。'
  }
  if (state === 'starting' || state === 'installing_plugin') {
    return '正在准备绑定环境。'
  }
  if (state === 'restarting_gateway') {
    return '绑定完成，正在重载 Gateway。'
  }
  if (state === 'succeeded') {
    return '绑定已完成。'
  }
  if (state === 'failed') {
    return '绑定失败，请重试。'
  }
  if (state === 'cancelled') {
    return '绑定已取消。'
  }
  return '未开始绑定。'
}

function renderWeixinSummary(snapshot) {
  weixinSummaryState.textContent = toDisplayText(snapshot.state || 'idle')
  applyTone(weixinSummaryState, snapshot.state || 'idle')
  weixinSummaryHint.textContent = getWeixinSummaryText(snapshot)
  weixinSummaryError.textContent = snapshot.lastError || ''
}

function openWeixinModal() {
  weixinModal.classList.remove('hidden')
}

async function closeWeixinModal() {
  if (weixinSnapshot && (
    weixinSnapshot.state === 'installing_plugin' ||
    weixinSnapshot.state === 'starting' ||
    weixinSnapshot.state === 'waiting_scan'
  )) {
    await window.launcherAPI.weixin.cancel()
  }
  weixinModal.classList.add('hidden')
}

function renderWeixinSnapshot(snapshot) {
  weixinSnapshot = snapshot || {
    state: 'idle',
    logs: [],
    scanUrl: '',
    qrDataUrl: '',
    lastError: ''
  }

  renderWeixinSummary(weixinSnapshot)

  weixinStateValue.textContent = toDisplayText(weixinSnapshot.state || 'idle')
  weixinErrorValue.textContent = weixinSnapshot.lastError || '--'
  weixinLogs.textContent = (weixinSnapshot.logs || []).join('\n')
  weixinOpenBrowserButton.disabled = !Boolean(weixinSnapshot.scanUrl)

  const installRunning = (
    weixinSnapshot.state === 'installing_plugin' ||
    weixinSnapshot.state === 'starting' ||
    weixinSnapshot.state === 'waiting_scan'
  )
  const cancellable = installRunning
  const busy = installRunning || weixinSnapshot.state === 'restarting_gateway'

  weixinStartButton.disabled = busy || !Boolean(bootstrapState?.hasConfig)
  weixinCancelButton.disabled = !cancellable

  if (weixinSnapshot.qrDataUrl) {
    weixinQrImage.src = weixinSnapshot.qrDataUrl
    weixinQrImage.classList.remove('hidden')
    weixinQrPlaceholder.classList.add('hidden')
  } else {
    weixinQrImage.removeAttribute('src')
    weixinQrImage.classList.add('hidden')
    weixinQrPlaceholder.classList.remove('hidden')
    if (weixinSnapshot.state === 'restarting_gateway') {
      weixinQrPlaceholder.textContent = '已绑定，正在重载 Gateway。'
    } else if (busy) {
      weixinQrPlaceholder.textContent = '正在等待二维码...'
    } else {
      weixinQrPlaceholder.textContent = '开始绑定后，这里会显示二维码。'
    }
  }
}

function getSelectedMode() {
  return modeSelect.value
}

function updateModeUI() {
  const selectedMode = getSelectedMode()
  modeDescription.textContent = MODES[selectedMode]?.description || ''
  for (const section of modeSections) {
    section.classList.toggle('hidden', section.dataset.mode !== selectedMode)
  }
}

function fillValues(currentConfig) {
  const config = currentConfig || {}
  const values = config.values || {}
  modeSelect.value = config.mode || 'openai_compatible'
  document.getElementById('openaiBaseUrl').value = values.baseUrl || ''
  document.getElementById('openaiApiKey').value = values.apiKey || ''
  document.getElementById('openaiModel').value = values.model || ''
  document.getElementById('bailianApiKey').value = values.apiKey || ''
  document.getElementById('bailianModel').value = values.model || 'MiniMax-M2.5'
  document.getElementById('newapiApiKey').value = values.apiKey || ''
  document.getElementById('newapiModel').value = values.model || config.resolved?.modelId || 'MiniMax-M2.5'
  document.getElementById('advancedProviderId').value = values.providerId || ''
  document.getElementById('advancedBaseUrl').value = values.baseUrl || ''
  document.getElementById('advancedApiKey').value = values.apiKey || ''
  document.getElementById('advancedModelId').value = values.modelId || ''
  updateModeUI()
}

function collectValues() {
  const mode = getSelectedMode()
  if (mode === 'openai_compatible') {
    return {
      baseUrl: document.getElementById('openaiBaseUrl').value,
      apiKey: document.getElementById('openaiApiKey').value,
      model: document.getElementById('openaiModel').value
    }
  }
  if (mode === 'minimax_bailian') {
    return {
      apiKey: document.getElementById('bailianApiKey').value,
      model: document.getElementById('bailianModel').value
    }
  }
  if (mode === 'minimax_newapi') {
    return {
      apiKey: document.getElementById('newapiApiKey').value,
      model: document.getElementById('newapiModel').value
    }
  }
  return {
    providerId: document.getElementById('advancedProviderId').value,
    baseUrl: document.getElementById('advancedBaseUrl').value,
    apiKey: document.getElementById('advancedApiKey').value,
    modelId: document.getElementById('advancedModelId').value
  }
}

function renderBootstrapState(nextState) {
  bootstrapState = nextState
  const runtimeStatus = nextState.runtimeStatus || {}

  fillValues(nextState.currentConfig)
  renderOverview(nextState)
  renderWeixinSnapshot(nextState.weixinSnapshot)
  setBusy(false, '保存并启动')

  if (runtimeStatus.lastError) {
    showBanner(runtimeStatus.lastError, 'error')
  } else if (!nextState.hasConfig) {
    showBanner('尚未配置模型。')
  } else {
    showBanner('')
  }
}

async function refreshState() {
  const nextState = await window.launcherAPI.bootstrap.getState()
  renderBootstrapState(nextState)
}

configForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  showBanner('')
  setBusy(true, '正在验证...')
  const result = await window.launcherAPI.config.validateAndSave({
    mode: getSelectedMode(),
    values: collectValues()
  })
  if (!result.success) {
    setBusy(false, '保存并启动')
    showBanner(result.message || '保存配置失败', 'error')
    await refreshState()
    return
  }
  showBanner('配置已更新。')
  setBusy(false, '保存并启动')
  await refreshState()
})

openChatButton.addEventListener('click', async () => {
  setBusy(true, '正在打开...')
  const result = await window.launcherAPI.runtime.openChat()
  setBusy(false, '保存并启动')
  if (!result.success) {
    showBanner(result.message || '打开聊天页失败', 'error')
    return
  }
  showBanner('聊天页已打开。')
})

weixinButton.addEventListener('click', async () => {
  openWeixinModal()
  renderWeixinSnapshot(await window.launcherAPI.weixin.getState())
})

weixinStartButton.addEventListener('click', async () => {
  openWeixinModal()
  const result = await window.launcherAPI.weixin.start()
  if (!result.success) {
    showBanner(result.message || '启动微信绑定失败', 'error')
    renderWeixinSnapshot(await window.launcherAPI.weixin.getState())
    return
  }
  renderWeixinSnapshot(result.snapshot)
})

weixinOpenBrowserButton.addEventListener('click', async () => {
  const result = await window.launcherAPI.weixin.openScanUrl()
  if (!result.success) {
    showBanner(result.message || '打开扫码链接失败', 'error')
    return
  }
})

weixinCancelButton.addEventListener('click', async () => {
  const result = await window.launcherAPI.weixin.cancel()
  renderWeixinSnapshot(result.snapshot)
})

weixinCloseButton.addEventListener('click', () => {
  closeWeixinModal().catch((error) => {
    showBanner(error.message || '关闭微信绑定弹窗失败', 'error')
  })
})

weixinModal.addEventListener('click', (event) => {
  if (event.target === weixinModal) {
    closeWeixinModal().catch((error) => {
      showBanner(error.message || '关闭微信绑定弹窗失败', 'error')
    })
  }
})

stopButton.addEventListener('click', async () => {
  setBusy(true, '正在停止...')
  const result = await window.launcherAPI.runtime.stop()
  setBusy(false, '保存并启动')
  if (!result.success) {
    showBanner(result.message || '停止 Gateway 失败', 'error')
    return
  }
  showBanner('Gateway 已停止。')
  await refreshState()
})

restartButton.addEventListener('click', async () => {
  setBusy(true, '正在重启...')
  const result = await window.launcherAPI.runtime.restart()
  setBusy(false, '保存并启动')
  if (!result.success) {
    showBanner(result.message || '重启 Gateway 失败', 'error')
    return
  }
  showBanner('Gateway 已重启。')
  await refreshState()
})

uninstallButton.addEventListener('click', async () => {
  showBanner('正在准备卸载...')
  const result = await window.launcherAPI.app.uninstall()
  if (result?.cancelled) {
    showBanner('')
    return
  }
  if (!result?.success) {
    showBanner(result?.message || '卸载失败', 'error')
    return
  }
  showBanner(result.message || 'EIL Claw 正在退出并清除本地数据。')
})

modeSelect.addEventListener('change', updateModeUI)

window.launcherAPI.bootstrap.onWindowContext((payload) => {
  if (payload?.action === 'weixin') {
    openWeixinModal()
  }
  refreshState().catch((error) => {
    showBanner(error.message || '刷新窗口状态失败', 'error')
  })
})

window.launcherAPI.weixin.onUpdate((snapshot) => {
  renderWeixinSnapshot(snapshot)
})

window.addEventListener('beforeunload', () => {
  window.launcherAPI.removeAllListeners()
})

populateModes()
refreshState().catch((error) => {
  showBanner(error.message || '加载启动器状态失败', 'error')
})
