/**
 * IIFE demo entry - auto-initializes with built-in demo API for testing
 *
 * Exposes the following classes on `window` for third-party embedding:
 * - `PageAgent`       - full agent with built-in Panel UI
 * - `PageAgentCore`   - headless core agent (no UI), requires a `pageController`
 * - `PageController`  - DOM interaction controller (mask, clicking, typing, ...)
 *
 * `CustomEvent` is the native browser API and needs no export.
 */
import { PageAgentCore } from '@page-agent/core'
import { PageController } from '@page-agent/page-controller'

import { PageAgent, type PageAgentConfig } from './PageAgent'

const currentScript = document.currentScript as HTMLScriptElement | null
let currentScriptURL: URL | null = null
if (currentScript?.src) {
	try {
		currentScriptURL = new URL(currentScript.src)
	} catch {
		// A malformed script src is not fatal; fall back to defaults below.
		currentScriptURL = null
	}
}
const autoInit = currentScriptURL?.searchParams.get('autoInit') !== 'false'

// Clean up existing instances to prevent multiple injections from bookmarklet
if (autoInit && window.pageAgent) {
	window.pageAgent.dispose()
}

// Mount to global window object
window.PageAgent = PageAgent
window.PageAgentCore = PageAgentCore
window.PageController = PageController

console.log('🚀 page-agent.js loaded!')

const DEMO_MODEL = 'qwen3.5-plus'
const DEMO_BASE_URL = 'https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run'
const DEMO_API_KEY = 'NA'

// in case document.x is not ready yet
if (autoInit) {
	setTimeout(() => {
		let config: PageAgentConfig
		let showPanel = true

		if (currentScriptURL) {
			const url = currentScriptURL
			const model = url.searchParams.get('model') || DEMO_MODEL
			const baseURL = url.searchParams.get('baseURL') || DEMO_BASE_URL
			const apiKey = url.searchParams.get('apiKey') || DEMO_API_KEY
			const language = (url.searchParams.get('lang') as 'zh-CN' | 'en-US') || 'zh-CN'
			const position =
				(url.searchParams.get('position') as 'bottom-center' | 'bottom-right') || 'bottom-center'
			const enableMultiPage = url.searchParams.get('multiPage') === 'true'
			// Mask defaults to enabled (PageAgent behavior); pass enableMask=false to disable.
			const enableMask = url.searchParams.get('enableMask') !== 'false'
			showPanel = ((url.searchParams.get('showPanel') as 'true' | 'false') || 'true') === 'true'
			config = { model, baseURL, apiKey, language, position, enableMultiPage, enableMask }
		} else {
			console.log('🚀 page-agent.js no current script detected, using default demo config')
			config = {
				model: DEMO_MODEL,
				baseURL: DEMO_BASE_URL,
				apiKey: DEMO_API_KEY,
			}
		}

		// Create agent
		window.pageAgent = new PageAgent(config)
		if (showPanel) {
			// Default entry is a floating launcher button; clicking it opens the
			// conversation panel. Call panel.show() instead to open it directly.
			window.pageAgent.panel.close()
		}

		console.log('🚀 page-agent.js initialized with config:', window.pageAgent.config)
	})
}
