import { I18n, type SupportedLanguage } from '../i18n'
import { truncate } from '../utils'
import assistantLogoUrl from './assets/assistant-logo.png'
import { createCard, createReflectionLines, createResultCard, createStepCard } from './cards'
import type { AgentActivity, PanelAgentAdapter, PanelHandoff } from './types'

import styles from './Panel.module.css'

/**
 * Panel configuration
 */
export interface PanelConfig {
	language?: SupportedLanguage
	/**
	 * Whether to prompt for next task after task completion
	 * @default true
	 */
	promptForNextTask?: boolean
	/**
	 * Panel placement on screen
	 * - `bottom-center`: floating bar centered at the bottom of the page (default)
	 * - `bottom-right`: drawer-style panel anchored to the bottom-right corner
	 * @default 'bottom-center'
	 */
	position?: 'bottom-center' | 'bottom-right'
}

/** A completed or active task snapshot rendered in the panel session. */
interface PanelHistorySession {
	task: string
	history: PanelAgentAdapter['history']
}

/**
 * Agent control panel
 *
 * Architecture:
 * - History list: renders directly from agent.history (historical events)
 * - Activity section: shows transient activity below the persisted history
 * - Header bar: shows the agent status and controls
 *
 * This separation ensures data consistency - history is the single source of truth
 * for what has been done, while activity shows what is happening now.
 */
export class Panel {
	#wrapper: HTMLElement
	#indicator: HTMLElement
	#statusText: HTMLElement
	#historySection: HTMLElement
	#activitySection: HTMLElement
	#expandButton: HTMLElement
	#actionButton: HTMLElement
	#inputSection: HTMLElement
	#taskInput: HTMLInputElement
	#sendButton: HTMLButtonElement
	#launcher: HTMLElement
	#handoffSection: HTMLElement | null = null

	#agent: PanelAgentAdapter
	#config: PanelConfig
	#isExpanded = false
	#i18n: I18n
	#userAnswerResolver: ((input: string) => void) | null = null
	#isWaitingForUserAnswer: boolean = false
	#showResultCard = false
	/** Reference used to distinguish a new core task from incremental history updates. */
	#activeCoreHistory: PanelAgentAdapter['history'] | null = null
	/**
	 * UI-only session history. PageAgentCore resets its history for every task so
	 * the model receives only the active task context; the Panel keeps snapshots
	 * here until the user closes it.
	 */
	#historySessions: PanelHistorySession[] = []

	// Event handlers (bound for removal)
	#onStatusChange = () => this.#handleStatusChange()
	#onHistoryChange = () => this.#handleHistoryChange()
	#onActivity = (e: Event) => this.#handleActivity((e as CustomEvent<AgentActivity>).detail)
	#onHandoffChange = () => this.#renderHandoffCard()
	#onAgentDispose = () => this.dispose()
	#onExpandableTextClick = (e: Event) => this.#handleExpandableTextEvent(e)
	#onExpandableTextKeydown = (e: KeyboardEvent) => this.#handleExpandableTextEvent(e)

	get wrapper(): HTMLElement {
		return this.#wrapper
	}

	/**
	 * Create a Panel bound to an agent
	 * @param agent - Agent instance that implements PanelAgentAdapter
	 * @param config - Optional panel configuration
	 */
	constructor(agent: PanelAgentAdapter, config: PanelConfig = {}) {
		this.#agent = agent
		this.#config = config
		this.#i18n = new I18n(config.language ?? 'en-US')

		// Set up askUser callback on agent
		this.#agent.onAskUser = (question, options) => this.#askUser(question, options?.signal)

		// Create UI elements
		this.#wrapper = this.#createWrapper()
		if (config.position === 'bottom-right') {
			this.#wrapper.classList.add(styles.bottomRight)
		}
		this.#indicator = this.#wrapper.querySelector(`.${styles.indicator}`)!
		this.#statusText = this.#wrapper.querySelector(`.${styles.statusText}`)!
		this.#historySection = this.#wrapper.querySelector(`.${styles.historySection}`)!
		this.#activitySection = this.#wrapper.querySelector(`.${styles.activitySection}`)!
		this.#expandButton = this.#wrapper.querySelector(`.${styles.expandButton}`)!
		this.#actionButton = this.#wrapper.querySelector(`.${styles.stopButton}`)!
		this.#inputSection = this.#wrapper.querySelector(`.${styles.inputSectionWrapper}`)!
		this.#taskInput = this.#wrapper.querySelector(`.${styles.taskInput}`)!
		this.#sendButton = this.#wrapper.querySelector(`.${styles.sendButton}`)!
		this.#launcher = this.#createLauncher()
		this.#handoffSection = this.#wrapper.querySelector(`.${styles.handoffSection}`)
		if (config.position === 'bottom-right') {
			this.#launcher.classList.add(styles.bottomRight)
		}

		// Listen to agent events
		this.#agent.addEventListener('statuschange', this.#onStatusChange)
		this.#agent.addEventListener('historychange', this.#onHistoryChange)
		this.#agent.addEventListener('activity', this.#onActivity)
		this.#agent.addEventListener('handoffchange', this.#onHandoffChange)
		this.#agent.addEventListener('dispose', this.#onAgentDispose)
		this.#historySection.addEventListener('click', this.#onExpandableTextClick)
		this.#historySection.addEventListener('keydown', this.#onExpandableTextKeydown)

		this.#setupEventListeners()

		this.#showInputArea()

		this.hide() // Start hidden
	}

	// ========== Agent event handlers ==========

	/** Handle agent status change */
	#handleStatusChange(): void {
		const status = this.#agent.status
		if (status === 'running') this.#showResultCard = false
		if (status === 'completed' || status === 'error') this.#showResultCard = true

		// Map agent status to UI indicator. A `completed` run whose result reports
		// failure shows as error; other statuses map to their own indicator.
		const failed = status === 'completed' && this.#agent.lastResult?.success === false
		this.#updateStatusIndicator(failed ? 'error' : status)
		if (status === 'completed') {
			this.#statusText.textContent = failed
				? this.#i18n.t('ui.errors.executionFailed')
				: this.#i18n.t('ui.panel.taskCompleted')
		} else if (status === 'stopped') {
			this.#statusText.textContent = this.#i18n.t('ui.panel.taskTerminated')
		} else if (status === 'error') {
			this.#statusText.textContent = this.#i18n.t('ui.errors.executionFailed')
		}

		// The header control always closes the panel; pause lives in the composer.
		this.#actionButton.innerHTML =
			'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>'
		this.#actionButton.title = this.#i18n.t('ui.panel.close')
		this.#actionButton.setAttribute('aria-label', this.#i18n.t('ui.panel.close'))

		// Show/hide based on status
		if (status === 'running') {
			this.show()
			this.#inputSection.classList.remove(styles.hidden)
			this.#taskInput.disabled = true
			this.#updateSendButton(true)
		}

		// Handle completion
		if (
			status === 'completed' ||
			status === 'error' ||
			status === 'stopped' ||
			status === 'migrated'
		) {
			if (status === 'completed' || status === 'stopped' || status === 'migrated') {
				this.#renderActivity(null)
			}
			if (!this.#isExpanded) {
				this.#expand()
			}
			if (this.#shouldShowInputArea()) {
				this.#showInputArea()
			}
			this.#renderHistory()
		}

		// Migration status is informational: show the handoff message and a hint.
		if (status === 'migrated') {
			this.#statusText.textContent = this.#i18n.t('ui.panel.migrated')
			this.#updateStatusIndicator('migrated')
		}
	}

	/** Synchronize the active task history into the UI-only session history. */
	#handleHistoryChange(): void {
		this.#syncHistorySession()
		this.#renderHistory()
	}

	/** Render transient activity below the persisted history cards. */
	#handleActivity(activity: AgentActivity): void {
		this.#renderActivity(activity)
		switch (activity.type) {
			case 'thinking':
				this.#updateStatusIndicator('thinking')
				break

			case 'executing':
				this.#updateStatusIndicator('executing')
				break

			case 'executed':
				this.#updateStatusIndicator('executed')
				break

			case 'retrying':
				this.#updateStatusIndicator('retrying')
				break

			case 'error':
				this.#updateStatusIndicator('error')
				break

			case 'awaiting_navigation':
				this.#updateStatusIndicator('executing')
				// Re-render the handoff card so the clickable link stays in sync.
				this.#renderHandoffCard()
				break
		}
	}

	/**
	 * Ask for user input (internal, called by agent via onAskUser).
	 * Rejects when `signal` aborts (task stopped or disposed), cleaning up the
	 * question card and pending state so the agent loop can settle.
	 */
	#askUser(question: string, signal?: AbortSignal): Promise<string> {
		return new Promise((resolve, reject) => {
			// Set `waiting for user answer` state
			this.#isWaitingForUserAnswer = true
			this.#userAnswerResolver = resolve

			// Expand history panel
			if (!this.#isExpanded) {
				this.#expand()
			}

			// Add temporary question card so user can see the full question
			const tempCard = document.createElement('div')
			// Question text is escaped by `escapeHtml` in `createCard`.
			// pi-lens-ignore: no-inner-html, ts-xss-dom-sink
			tempCard.innerHTML = createCard({
				icon: '❓',
				content: `Question: ${question}`,
				type: 'question',
			})
			const cardElement = tempCard.firstElementChild as HTMLElement
			cardElement.setAttribute('data-temp-card', 'true')
			this.#historySection.appendChild(cardElement)
			this.#scrollToBottom()

			this.#showInputArea(this.#i18n.t('ui.panel.userAnswerPrompt'))

			signal?.addEventListener(
				'abort',
				() => {
					this.#removeTempCards()
					this.#isWaitingForUserAnswer = false
					this.#userAnswerResolver = null
					// reason is a DOMException AbortError (abort() takes no args).
					reject(signal.reason as DOMException)
				},
				{ once: true }
			)
		})
	}

	/** Remove temporary question cards (only direct children for safety) */
	#removeTempCards(): void {
		Array.from(this.#historySection.children).forEach((child) => {
			if (child.getAttribute('data-temp-card') === 'true') {
				child.remove()
			}
		})
	}

	// ========== Public control methods ==========

	show(): void {
		// Reopening the panel (from the launcher or a running task) hides the launcher again
		this.#hideLauncher()

		// Both placements use the same stacked layout for the header, history and composer.
		this.wrapper.style.display = 'flex'
		void this.wrapper.offsetHeight
		this.wrapper.style.opacity = '1'
		this.wrapper.style.transform =
			this.#config.position === 'bottom-right' ? 'translateY(0)' : 'translateX(-50%) translateY(0)'
	}

	hide(): void {
		this.wrapper.style.opacity = '0'
		this.wrapper.style.transform =
			this.#config.position === 'bottom-right'
				? 'translateY(100%)' // drawer closes by sliding below its own height
				: 'translateX(-50%) translateY(20px)'
		this.wrapper.style.display = 'none'
	}

	/**
	 * Close the panel: clear the displayed conversation, hide the UI, and show
	 * the floating launcher. The agent remains reusable after reopening.
	 */
	close(): void {
		this.#close()
	}

	reset(): void {
		this.#statusText.textContent = this.#i18n.t('ui.panel.ready')
		this.#updateStatusIndicator('thinking')
		this.#historySessions = []
		this.#showResultCard = false
		this.#renderHistory()
		this.#renderActivity(null)
		this.#collapse()
		// Reset user input state
		this.#isWaitingForUserAnswer = false
		this.#userAnswerResolver = null
		// Show input area
		this.#showInputArea()
	}

	expand(): void {
		this.#expand()
	}

	collapse(): void {
		this.#collapse()
	}

	/**
	 * Dispose panel and clean up event listeners
	 */
	dispose(): void {
		// Remove agent event listeners
		this.#agent.removeEventListener('statuschange', this.#onStatusChange)
		this.#agent.removeEventListener('historychange', this.#onHistoryChange)
		this.#agent.removeEventListener('activity', this.#onActivity)
		this.#agent.removeEventListener('handoffchange', this.#onHandoffChange)
		this.#agent.removeEventListener('dispose', this.#onAgentDispose)
		this.#historySection.removeEventListener('click', this.#onExpandableTextClick)
		this.#historySection.removeEventListener('keydown', this.#onExpandableTextKeydown)

		// Clean up UI
		this.#isWaitingForUserAnswer = false
		this.#launcher.remove()
		this.wrapper.remove()
	}

	// ========== Private methods ==========

	#getToolExecutingText(toolName: string, args: unknown): string {
		const a = args as Record<string, string | number>
		switch (toolName) {
			case 'click_element_by_index':
				return this.#i18n.t('ui.tools.clicking', { index: a.index })
			case 'input_text':
				return this.#i18n.t('ui.tools.inputting', { index: a.index })
			case 'select_dropdown_option':
				return this.#i18n.t('ui.tools.selecting', { text: a.text })
			case 'scroll':
				return this.#i18n.t('ui.tools.scrolling')
			case 'wait':
				return this.#i18n.t('ui.tools.waiting', { seconds: a.seconds })
			case 'ask_user':
				return this.#i18n.t('ui.tools.askingUser')
			case 'done':
				return this.#i18n.t('ui.tools.done')
			default:
				return this.#i18n.t('ui.tools.executing', { toolName })
		}
	}

	/** Close the panel regardless of whether the agent is currently running. */
	#handleActionButton(): void {
		this.#close()
	}

	/**
	 * Close the panel: hide the UI, clear its session history, and keep the
	 * reusable agent alive. A floating launcher remains for reopening it.
	 */
	#close(): void {
		// Closing starts a fresh UI session so a completed/error status is not
		// carried into the next conversation.
		this.reset()
		this.hide()
		this.#showLauncher()
	}

	/**
	 * Create the floating launcher button used to reopen a closed panel.
	 * It is appended to the document body and hidden until the panel is closed.
	 */
	#createLauncher(): HTMLElement {
		const launcher = document.createElement('button')
		launcher.id = 'page-agent-runtime_agent-panel-launcher'
		launcher.type = 'button'
		launcher.className = styles.launcher
		launcher.title = this.#i18n.t('ui.panel.reopen')
		launcher.setAttribute('aria-label', this.#i18n.t('ui.panel.reopen'))
		launcher.setAttribute('data-page-agent-ignore', 'true')
		// Static asset URL only, no user content.
		// pi-lens-ignore: no-inner-html
		launcher.innerHTML = `<img src="${assistantLogoUrl}" alt="AI助手" />`
		launcher.classList.add(styles.hidden)

		document.body.appendChild(launcher)
		return launcher
	}

	/** Show the floating launcher button */
	#showLauncher(): void {
		this.#launcher.classList.remove(styles.hidden)
	}

	/** Hide the floating launcher button */
	#hideLauncher(): void {
		this.#launcher.classList.add(styles.hidden)
	}

	/**
	 * Submit task
	 */
	#submitTask() {
		const input = this.#taskInput.value.trim()
		if (!input) return

		// Hide input area
		this.#hideInputArea()

		if (this.#isWaitingForUserAnswer) {
			// Handle user input mode
			this.#handleUserAnswer(input)
		} else {
			// Allow the host to run inside the submit user gesture (e.g. reserve
			// a placeholder tab for the `placeholder` handoff strategy).
			this.#agent.onSubmitGesture?.()
			// Execute task via agent
			this.#agent.execute(input)
		}
	}

	/**
	 * Handle user answer
	 */
	#handleUserAnswer(input: string): void {
		this.#removeTempCards()

		// Reset state
		this.#isWaitingForUserAnswer = false

		// Call resolver to return user input
		if (this.#userAnswerResolver) {
			this.#userAnswerResolver(input)
			this.#userAnswerResolver = null
		}
	}

	/**
	 * Show input area
	 */
	#showInputArea(placeholder?: string): void {
		// Clear input field
		this.#taskInput.value = ''
		this.#taskInput.placeholder = placeholder || this.#i18n.t('ui.panel.taskInput')
		this.#inputSection.classList.remove(styles.hidden)
		this.#taskInput.disabled = false
		this.#updateSendButton(false)
		// Focus on input field
		setTimeout(() => {
			this.#taskInput.focus()
		}, 100)
	}

	/**
	 * Hide input area
	 */
	#hideInputArea(): void {
		this.#inputSection.classList.add(styles.hidden)
	}

	/** Update the composer control between submit and pause modes. */
	#updateSendButton(isRunning: boolean): void {
		if (isRunning) {
			this.#sendButton.innerHTML =
				'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>'
			this.#sendButton.title = this.#i18n.t('ui.panel.pause')
			this.#sendButton.setAttribute('aria-label', this.#i18n.t('ui.panel.pause'))
			return
		}

		this.#sendButton.innerHTML =
			'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 12 16-8-5 16-3-6-8-2Z"/><path d="m12 14 4-4"/></svg>'
		this.#sendButton.title = '发送'
		this.#sendButton.setAttribute('aria-label', '发送')
	}

	/**
	 * Check if input area should be shown
	 */
	#shouldShowInputArea(): boolean {
		// Always show input area if waiting for user input
		if (this.#isWaitingForUserAnswer) return true

		const history = this.#agent.history
		if (history.length === 0) {
			return true // Initial state
		}

		const status = this.#agent.status
		const isTaskEnded =
			status === 'completed' || status === 'error' || status === 'stopped' || status === 'migrated'

		// Only show input area after task completion if configured to do so
		if (isTaskEnded) {
			return this.#config.promptForNextTask ?? true
		}

		return false
	}

	// Static template: i18n strings, CSS class names and asset URLs only; user
	// content is never interpolated here (it flows through `escapeHtml` in
	// `createCard` into #historySection).
	// pi-lens-ignore: no-inner-html
	#createWrapper(): HTMLElement {
		const taskInputMaxLength = 1000
		const wrapper = document.createElement('div')
		wrapper.id = 'page-agent-runtime_agent-panel'
		wrapper.className = styles.wrapper
		wrapper.setAttribute('data-browser-use-ignore', 'true')
		wrapper.setAttribute('data-page-agent-ignore', 'true')

		// Static template: i18n strings, CSS class names and asset URLs only;
		// user content is never interpolated here (it flows through `escapeHtml`
		// in `createCard` into #historySection).
		// pi-lens-ignore: no-inner-html
		wrapper.innerHTML = `
			<div class="${styles.background}"></div>
			<div class="${styles.historySectionWrapper}">
				<div class="${styles.historySection}"></div>
				<div class="${styles.activitySection} ${styles.hidden}"></div>
			</div>
			<div class="${styles.header}">
				<div class="${styles.statusSection}">
					<img class="${styles.assistantLogo}" src="${assistantLogoUrl}" alt="AI助手" />
					<div class="${styles.indicator} ${styles.thinking}"></div>
					<div class="${styles.statusText}">${this.#i18n.t('ui.panel.ready')}</div>
				</div>
				<div class="${styles.controls}">
					<button type="button" class="${styles.controlButton} ${styles.historyButton}" title="查看执行记录" aria-label="查看执行记录">
						<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg>
					</button>
					<button type="button" class="${styles.controlButton} ${styles.expandButton}" title="${this.#i18n.t('ui.panel.expand')}" aria-label="${this.#i18n.t('ui.panel.expand')}">
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H4v4M16 4h4v4M20 16v4h-4M4 16v4h4"/></svg>
					</button>
					<button type="button" class="${styles.controlButton} ${styles.externalButton}" title="聚焦助手" aria-label="聚焦助手">
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/></svg>
					</button>
					<button type="button" class="${styles.controlButton} ${styles.stopButton}" title="${this.#i18n.t('ui.panel.close')}" aria-label="${this.#i18n.t('ui.panel.close')}">
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
					</button>
				</div>
			</div>
			<div class="${styles.handoffSection} ${styles.hidden}"></div>
			<div class="${styles.inputSectionWrapper} ${styles.hidden}">
				<div class="${styles.inputSection}">
					<input
						type="text" 
						class="${styles.taskInput}" 
						maxlength="${taskInputMaxLength}"
					/>
					<div class="${styles.inputHint}">支持连续追问 · Enter 发送</div>
					<button type="button" class="${styles.sendButton}" title="发送" aria-label="发送">
						<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 12 16-8-5 16-3-6-8-2Z"/><path d="m12 14 4-4"/></svg>
					</button>
				</div>
			</div>
		`

		document.body.appendChild(wrapper)
		return wrapper
	}

	#setupEventListeners(): void {
		// Click header area to expand/collapse
		const header = this.wrapper.querySelector(`.${styles.header}`)!
		header.addEventListener('click', (e) => {
			// Don't trigger expand/collapse if clicking on buttons
			if ((e.target as HTMLElement).closest(`.${styles.controlButton}`)) {
				return
			}
			this.#toggle()
		})

		// Expand button
		this.#expandButton.addEventListener('click', (e) => {
			e.stopPropagation()
			this.#toggle()
		})

		this.wrapper.querySelector(`.${styles.historyButton}`)?.addEventListener('click', (e) => {
			e.stopPropagation()
			this.#expand()
			this.#scrollToBottom()
		})

		this.wrapper.querySelector(`.${styles.externalButton}`)?.addEventListener('click', (e) => {
			e.stopPropagation()
			this.#expand()
			this.#taskInput.focus()
		})

		// Action button (stop / close)
		this.#actionButton.addEventListener('click', (e) => {
			e.stopPropagation()
			this.#handleActionButton()
		})

		// Launcher button (reopen a closed panel)
		this.#launcher.addEventListener('click', (e) => {
			e.stopPropagation()
			this.show()
			this.expand()
		})

		// Submit on Enter key in input field
		this.#taskInput.addEventListener('keydown', (e) => {
			if (e.isComposing) return // Ignore IME composition keys
			if (e.key === 'Enter') {
				e.preventDefault()
				this.#submitTask()
			}
		})

		this.#sendButton.addEventListener('click', (e) => {
			e.stopPropagation()
			if (this.#agent.status === 'running' && !this.#isWaitingForUserAnswer) {
				void this.#agent.stop()
				return
			}
			this.#submitTask()
		})
		// Prevent input area click event bubbling
		this.#inputSection.addEventListener('click', (e) => {
			e.stopPropagation()
		})
	}

	#toggle(): void {
		if (this.#isExpanded) {
			this.#collapse()
		} else {
			this.#expand()
		}
	}

	#expand(): void {
		this.#isExpanded = true
		this.wrapper.classList.add(styles.expanded)
		this.#expandButton.textContent = '▲'
	}

	#collapse(): void {
		this.#isExpanded = false
		this.wrapper.classList.remove(styles.expanded)
		this.#expandButton.textContent = '▼'
	}

	#updateStatusIndicator(
		type:
			| 'idle'
			| 'running'
			| 'thinking'
			| 'executing'
			| 'executed'
			| 'retrying'
			| 'completed'
			| 'error'
			| 'stopped'
			| 'migrated'
	): void {
		// `running` animates like thinking; `idle`/`stopped` use the neutral base.
		const variant = type === 'running' ? 'thinking' : type
		this.#indicator.className = styles.indicator
		if (variant !== 'idle' && variant !== 'stopped') {
			this.#indicator.classList.add(styles[variant])
		}
	}

	#scrollToBottom(): void {
		// Execute in next event loop to ensure DOM update completion
		setTimeout(() => {
			this.#historySection.scrollTop = this.#historySection.scrollHeight
		}, 0)
	}

	/** Toggle a truncated card row when it is clicked or activated by keyboard. */
	#handleExpandableTextEvent(event: Event): void {
		if (event.type === 'keydown') {
			const keyboardEvent = event as KeyboardEvent
			if (keyboardEvent.key !== 'Enter' && keyboardEvent.key !== ' ') return
			keyboardEvent.preventDefault()
		}

		const target = (event.target as HTMLElement).closest<HTMLElement>('[data-expandable="true"]')
		if (!target || !this.#historySection.contains(target)) return

		const expanded = target.classList.toggle(styles.expandedText)
		target.setAttribute('aria-expanded', expanded.toString())
	}

	/** Render the current transient activity without persisting it as history. */
	#renderActivity(activity: AgentActivity | null): void {
		if (!activity) {
			this.#activitySection.replaceChildren()
			this.#activitySection.classList.add(styles.hidden)
			return
		}

		let icon = '✦'
		let text = this.#i18n.t('ui.panel.thinking')
		let type: 'activity' | 'error' = 'activity'
		if (activity.type === 'executing') {
			icon = '◉'
			text = this.#getToolExecutingText(activity.tool, activity.input)
		} else if (activity.type === 'executed') {
			icon = '✓'
			text = truncate(activity.output, 180)
		} else if (activity.type === 'retrying') {
			icon = '↻'
			text = `Retrying (${activity.attempt}/${activity.maxAttempts})`
		} else if (activity.type === 'error') {
			icon = '⚠'
			text = truncate(activity.message, 180)
			type = 'error'
		} else if (activity.type === 'awaiting_navigation') {
			icon = '↗'
			text = this.#i18n.t('ui.panel.openingNewTab')
		}

		const tempCard = document.createElement('div')
		// Activity text is escaped by createCard before insertion.
		// pi-lens-ignore: no-inner-html, ts-xss-dom-sink
		tempCard.innerHTML = createCard({ icon, content: text, type })
		this.#activitySection.replaceChildren(tempCard.firstElementChild!)
		this.#activitySection.classList.remove(styles.hidden)
	}

	/**
	 * Copy the core's active task history into the Panel's display session.
	 * The core intentionally resets its history between tasks, while the Panel
	 * retains previous task snapshots until it is closed.
	 */
	#syncHistorySession(): void {
		const task = this.#agent.task
		if (!task) return

		const latestSession = this.#historySessions.at(-1)
		const coreHistory = this.#agent.history
		if (!latestSession || latestSession.task !== task || this.#activeCoreHistory !== coreHistory) {
			this.#historySessions.push({ task, history: [...coreHistory] })
			this.#activeCoreHistory = coreHistory
			return
		}

		latestSession.history = [...coreHistory]
	}

	/**
	 * Render the multi-page handoff card (awaiting navigation / resume / reclaim).
	 * Reads `agent.handoff` (set via the `handoffchange` event) and rebuilds the
	 * dedicated section with DOM APIs (no innerHTML) so URL/task text stays safe.
	 */
	#renderHandoffCard(): void {
		const section = this.#handoffSection
		if (!section) return
		const handoff: PanelHandoff | undefined = (
			this.#agent as PanelAgentAdapter & { handoff?: PanelHandoff }
		).handoff

		// Clear the section when there is nothing to show.
		if (!handoff || handoff.kind === null) {
			section.replaceChildren()
			section.classList.add(styles.hidden)
			return
		}

		// A handoff card must be seen and acted on (e.g. the new tab's
		// "continue task?" card, or the old tab's reclaim button). Auto-open the
		// panel so the user does not have to find the launcher first.
		this.show()
		this.#expand()

		section.classList.remove(styles.hidden)
		section.replaceChildren(this.#createHandoffCard(handoff))
	}

	/** Build one handoff card element from the current handoff state. */
	#createHandoffCard(handoff: PanelHandoff): HTMLElement {
		const card = document.createElement('div')
		card.className = styles.handoffCard

		const title = document.createElement('div')
		title.className = styles.handoffCardTitle

		const actions = document.createElement('div')
		actions.className = styles.handoffCardActions

		switch (handoff.kind) {
			case 'awaiting': {
				title.textContent = this.#i18n.t('ui.panel.handoffAwaiting')

				const link = document.createElement('a')
				link.className = styles.handoffLink
				link.href = handoff.url ?? '#'
				link.target = '_blank'
				link.rel = 'noopener'
				link.textContent = this.#i18n.t('ui.panel.handoffOpen')
				actions.appendChild(link)

				const cancel = document.createElement('button')
				cancel.type = 'button'
				cancel.className = styles.handoffButton
				cancel.textContent = this.#i18n.t('ui.panel.handoffCancel')
				cancel.addEventListener('click', () => handoff.cancelAwaitingNavigation?.())
				actions.appendChild(cancel)
				break
			}

			case 'resume': {
				title.textContent = this.#i18n.t('ui.panel.handoffResumeTitle')
				const taskText = document.createElement('div')
				taskText.textContent = handoff.task ?? ''
				card.appendChild(taskText)

				const resume = document.createElement('button')
				resume.type = 'button'
				resume.className = styles.handoffButton
				resume.textContent = this.#i18n.t('ui.panel.handoffResume')
				resume.addEventListener('click', () => handoff.resume?.())
				actions.appendChild(resume)
				break
			}

			case 'reclaimable': {
				title.textContent = this.#i18n.t('ui.panel.handoffReclaimTitle')

				const reclaim = document.createElement('button')
				reclaim.type = 'button'
				reclaim.className = styles.handoffButton
				reclaim.textContent = this.#i18n.t('ui.panel.handoffReclaim')
				reclaim.addEventListener('click', () => handoff.reclaim?.())
				actions.appendChild(reclaim)
				break
			}

			default:
				return card
		}

		card.appendChild(title)
		card.appendChild(actions)
		return card
	}

	/**
	 * Render the Panel's UI-only session history.
	 *
	 * Renders:
	 * 1. Each submitted task
	 * 2. Grouped step cards with reflection and tool execution
	 * 3. Observations
	 */
	#renderHistory(): void {
		const items: string[] = []

		for (const session of this.#historySessions) {
			items.push(this.#createTaskCard(session.task))
			for (const event of session.history) {
				items.push(...this.#createHistoryCards(event))
			}
		}

		const resultCard = this.#createResultCard()
		if (resultCard) items.push(resultCard)

		// Card HTML is escaped by `escapeHtml` in `createCard`; task/history
		// content never reaches innerHTML unescaped.
		// pi-lens-ignore: no-inner-html, ts-xss-dom-sink
		this.#historySection.innerHTML = items.join('')
		this.#scrollToBottom()
	}

	#createTaskCard(task: string): string {
		return createCard({ icon: '🎯', content: task, type: 'input' })
	}

	/** Build the final result card from the latest completed agent result. */
	#createResultCard(): string | null {
		if (!this.#showResultCard) return null
		if (this.#agent.status !== 'completed' && this.#agent.status !== 'error') return null
		const result = this.#agent.lastResult
		if (!result) return null

		const latestSession = this.#historySessions.at(-1)
		const doneEvent = latestSession?.history
			.slice()
			.reverse()
			.find((event) => event.type === 'step' && event.action?.name === 'done')
		const doneInput =
			doneEvent?.type === 'step' ? (doneEvent.action?.input as { text?: string }) : null
		const content =
			result.data || doneInput?.text || (result.success ? 'Task completed' : 'Task failed')

		return createResultCard({ success: result.success, content })
	}

	/** Create cards for a history event */
	#createHistoryCards(event: PanelAgentAdapter['history'][number]): string[] {
		const cards: string[] = []
		const meta =
			event.type === 'step' && event.stepIndex !== undefined
				? this.#i18n.t('ui.panel.step', {
						number: (event.stepIndex + 1).toString(),
					})
				: undefined

		if (event.type === 'step') {
			const action = event.action
			if (action && event.stepIndex !== undefined) {
				cards.push(
					createStepCard({
						number: (event.stepIndex + 1).toString(),
						reflection: event.reflection ? createReflectionLines(event.reflection) : [],
						actionName: action.name,
						actionInput: this.#formatActionInput(action.input),
						actionOutput: action.output,
					})
				)
			}
		} else if (event.type === 'observation') {
			cards.push(
				createCard({ icon: '👁️', content: event.content || '', meta, type: 'observation' })
			)
		} else if (event.type === 'user_takeover') {
			cards.push(createCard({ icon: '👤', content: 'User takeover', meta, type: 'input' }))
		} else if (event.type === 'retry') {
			const retryInfo = `${event.message || 'Retrying'} (${event.attempt}/${event.maxAttempts})`
			cards.push(createCard({ icon: '🔄', content: retryInfo, meta, type: 'observation' }))
		} else if (event.type === 'error') {
			cards.push(
				createCard({ icon: '❌', content: event.message || 'Error', meta, type: 'observation' })
			)
		}

		return cards
	}

	/** Format action arguments for the compact action row. */
	#formatActionInput(input: unknown): string {
		try {
			return JSON.stringify(input) ?? '{}'
		} catch {
			return String(input)
		}
	}
}
