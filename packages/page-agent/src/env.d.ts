/// <reference types="vite/client" />
import type { PageAgentCore } from '@page-agent/core'
import type { PageController } from '@page-agent/page-controller'

import type { PageAgent } from './PageAgent'

declare global {
	interface Window {
		pageAgent?: PageAgent
		PageAgent: typeof PageAgent
		PageAgentCore: typeof PageAgentCore
		PageController: typeof PageController
	}
}
