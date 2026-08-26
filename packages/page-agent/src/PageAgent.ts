/**
 * Copyright (C) 2025 Alibaba Group Holding Limited
 * All rights reserved.
 */
import { type AgentConfig, PageAgentCore } from '@page-agent/core'
import {
	type HandoffConfig,
	HandoffController,
	type HandoffControllerRef,
	type HandoffState,
	createOpenNewTabTool,
} from '@page-agent/handoff'
import { PageController, type PageControllerConfig } from '@page-agent/page-controller'
import { Panel, type PanelConfig, type PanelHandoff } from '@page-agent/ui'

export * from '@page-agent/core'

export type PageAgentConfig = AgentConfig &
	PageControllerConfig &
	Omit<PanelConfig, 'language'> & {
		/**
		 * Enable same-tab / cross-tab task continuity without a browser extension:
		 * - a task survives reloads and MPA navigation (sessionStorage snapshot);
		 * - the `open_new_tab` tool lets the model hand the task to a new tab
		 *   (user confirms via a clickable card — browsers block popups without a
		 *   user gesture), and the new tab resumes from the last completed step.
		 * Requires the host pages to be same-origin (see @page-agent/handoff).
		 * @default false
		 */
		enableMultiPage?: boolean
		/** Handoff runtime configuration (see @page-agent/handoff). */
		multiPage?: HandoffConfig
	}

/** Internal agent config with the PageController wired in. */
type PageAgentCoreConfig = AgentConfig & {
	pageController: PageController
}

export class PageAgent extends PageAgentCore {
	panel: Panel

	/** Multi-page handoff controller (only when `enableMultiPage`). */
	readonly handoffController: HandoffController | null

	/**
	 * Called by the Panel inside the task-submit user gesture (reserves a
	 * placeholder tab for the `placeholder` handoff strategy).
	 */
	onSubmitGesture?: () => void

	constructor(config: PageAgentConfig) {
		const pageController = new PageController({
			...config,
			enableMask: config.enableMask ?? true,
		})

		// The tool needs the controller at execution time, but the controller
		// needs the agent (constructed by super()). Resolve the reference lazily.
		const handoffRef: HandoffControllerRef = { current: null }
		const enhancedConfig: PageAgentCoreConfig = { ...config, pageController }
		if (config.enableMultiPage) {
			enhancedConfig.multiPage = true
			enhancedConfig.customTools = {
				...config.customTools,
				open_new_tab: createOpenNewTabTool(() => handoffRef.current),
			}
		}

		super(enhancedConfig)

		if (config.enableMultiPage) {
			handoffRef.current = new HandoffController({ agent: this, config: config.multiPage })
			// Forward controller state changes to the agent so the Panel can
			// render the awaiting/resume/reclaim cards via the `handoffchange`
			// event and the `handoff` getter.
			handoffRef.current.addEventListener('handoffchange', () => {
				this.dispatchEvent(new Event('handoffchange'))
			})
			handoffRef.current.start()
		}
		this.handoffController = handoffRef.current

		// The Panel calls this inside the task-submit user gesture so the
		// `placeholder` handoff strategy can pre-reserve a window.
		if (config.enableMultiPage) {
			this.onSubmitGesture = () => handoffRef.current?.reservePlaceholderTab()
		}

		this.panel = new Panel(this, {
			language: config.language,
			promptForNextTask: config.promptForNextTask,
			position: config.position,
		})
	}

	/** Panel-facing handoff state (undefined when multi-page is disabled). */
	get handoff(): PanelHandoff | undefined {
		const state: HandoffState | null = this.handoffController?.getState() ?? null
		if (!state || state.kind === null) return undefined

		switch (state.kind) {
			case 'awaiting':
				return {
					kind: 'awaiting',
					url: state.url,
					cancelAwaitingNavigation: () => this.handoffController?.cancelAwaitingNavigation(),
				}
			case 'resume':
				return {
					kind: 'resume',
					task: state.task,
					resume: () => void this.handoffController?.resumePending(),
				}
			case 'reclaimable':
				return {
					kind: 'reclaimable',
					reclaim: () => void this.handoffController?.reclaim(),
				}
			default:
				return undefined
		}
	}
}
