async function extractErrorMessage(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase()
  try {
    if (contentType.includes('application/json')) {
      const payload = await response.json()
      return payload?.error?.message || payload?.message || JSON.stringify(payload)
    }
    const text = await response.text()
    return text || `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

async function validateResolvedConfig(resolvedConfig) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 12000)
  const endpoint = `${resolvedConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${resolvedConfig.apiKey}`
      },
      body: JSON.stringify({
        model: resolvedConfig.modelId,
        messages: [
          {
            role: 'user',
            content: 'ping'
          }
        ],
        max_tokens: 1,
        temperature: 0
      }),
      signal: controller.signal
    })
    clearTimeout(timeoutId)

    if (!response.ok) {
      return {
        success: false,
        message: await extractErrorMessage(response),
        status: response.status
      }
    }

    return {
      success: true
    }
  } catch (error) {
    clearTimeout(timeoutId)
    if (error?.name === 'AbortError') {
      return {
        success: false,
        message: 'Timed out while validating the provider connection'
      }
    }
    return {
      success: false,
      message: error?.message || 'Failed to validate provider connection'
    }
  }
}

module.exports = {
  validateResolvedConfig
}
