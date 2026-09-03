/**
 * Copyright (C) 2025 Alibaba Group Holding Limited
 * Copyright (C) 2026 SimonLuvRamen
 * All rights reserved.
 */
import { type InvokeError, LLM, MigrationError, type Tool } from '@page-agent/llms'
import type { BrowserState, PageController } from '@page-agent/page-controller'
import chalk from 'chalk'
import * as z from 'zod/v4'

import SYSTEM_PROMPT from './prompts/system_prompt.md?raw'
import MULTIPAGE_SYSTEM_PROMPT from './prompts/system_prompt_multipage.md?raw'
import { tools } from './tools'
import type {
	AgentActivity,
	AgentConfig,
	AgentReflection,
	AgentStatus,
	AgentStepEvent,
	ExecutionResult,
	HistoricalEvent,
	MacroToolInput,
	MacroToolResult,
} from './types'
import { assert, fetchLlmsTxt, normalizeResponse, suppress, uid, waitFor } from './utils'

export { tool, type PageAgentTool, type ToolContext } from './tools'
export {
	serializeAgentState,
	restoreAgentState,
	parseAgentSnapshot,
	type AgentSnapshot,
} from './state'
export { MigrationError } from '@page-agent/llms'
export type * from './types'

export type PageAgentCoreConfig = AgentConfig & { pageController: PageController }

/**
 * AI agent for browser automation.
 *
 * @remarks
 * ## Re-act Agent Loop
 * - step
 *    - observe (gather information about current environment and context)
 *    - think (LLM calling)
 *      - reflection (evaluate history, generate memory, short-term planning)
 *      - action (give the action to approach the next goal)
 *    - act (execute the action)
 * - loop
 *
 * ## Event System
 * - `statuschange` - Agent status transitions (idle → running → completed/error/stopped)
 * - `historychange` - History events updated (persistent, part of agent memory)
 * - `activity` - Real-time activity feedback (transient, for UI only)
 * - `dispose` - Agent cleanup triggered
 *
 * ## Information Streams
 * 1. **History Events** (`history` array)
 *    - Persistent event stream that forms agent's memory
 *    - Included in LLM context across steps
 *    - Types: steps, observations, user takeovers, llm errors
 *
 * 2. **Activity Events** (via `activity` event)
 *    - Transient UI feedback during task execution
 *    - NOT included in LLM context
 *    - Types: thinking, executing, executed, retrying, error
 */
export class PageAgentCore extends EventTarget {
	readonly id = uid()
	readonly config: PageAgentCoreConfig & { maxSteps: number }
	readonly tools: typeof tools
	/** PageController for DOM operations */
	readonly pageController: PageController

	task = ''
	taskId = ''
	/** History events */
	history: HistoricalEvent[] = []
	/** Whether this agent has been disposed */
	disposed = false

	/**
	 * Called when the agent needs to ask the user questions.
	 * If unset, the `ask_user` tool will be disabled.
	 * Implementations should reject the promise when `signal` aborts.
	 * @example onAskUser: (q) => window.prompt(q) || ''
	 */
	onAskUser?: (question: string, options?: { signal: AbortSignal }) => Promise<string>

	#status: AgentStatus = 'idle'
	#llm: LLM
	/**
	 * Task cancellation primitive: its signal reaches the LLM fetch, tools
	 * (via `ctx.signal`) and async callbacks. Aborted only by `stop`/`dispose`
	 * (during a task) or task setup, always WITHOUT a reason so `signal.reason`
	 * stays a standard `AbortError`.
	 */
	#abortController = new AbortController()
	#observations: string[] = []

	/** Resolves when the current run has fully settled. Awaited by `stop()`. */
	#running: Promise<void> = Promise.resolve()
	#lastResult: ExecutionResult | null = null

	/** internal states during a single task execution */
	#states: {
		/** Accumulated wait time in seconds */
		totalWaitTime: number
		/** For detecting in-tab URL navigation */
		lastURL: string
		/**
		 * Last observed page context id (e.g. browser tab id in extension mode).
		 * Undefined in single-document embed mode. Used to tell a tab switch apart
		 * from a URL navigation within the same tab.
		 */
		lastTabId: number | undefined
		/** Browser state */
		browserState: BrowserState | null
		/** Simplified content of the last FULL snapshot sent to the LLM (dedupe baseline) */
		lastBrowserContent: string | null
		/** Whether the current snapshot is identical to the last full one (dedupe) */
		browserStateUnchanged: boolean
		/** 0-based step index whose prompt last carried the full snapshot (dedupe) */
		lastFullBrowserStateStep: number
	} = {
		totalWaitTime: 0,
		lastURL: '',
		lastTabId: undefined,
		browserState: null,
		lastBrowserContent: null,
		browserStateUnchanged: false,
		lastFullBrowserStateStep: 0,
	}

	constructor(config: PageAgentCoreConfig) {
		super()

		this.config = { ...config, maxSteps: config.maxSteps ?? 40 }

		this.#llm = new LLM(this.config)
		this.tools = new Map(tools)
		this.pageController = config.pageController

		this.#llm.addEventListener('retry', (e) => {
			const { attempt, maxAttempts, lastError } = (e as CustomEvent).detail
			this.#emitActivity({ type: 'retrying', attempt, maxAttempts })
			this.history.push({
				type: 'error',
				message: String(lastError),
				rawResponse: (lastError as InvokeError).rawResponse,
			})
			this.history.push({
				type: 'retry',
				message: `LLM retry attempt ${attempt} of ${maxAttempts}`,
				attempt,
				maxAttempts,
			})
			this.#emitHistoryChange()
		})

		if (this.config.customTools) {
			for (const [name, tool] of Object.entries(this.config.customTools)) {
				if (tool === null) {
					this.tools.delete(name)
					continue
				}
				this.tools.set(name, tool)
			}
		}

		if (!this.config.experimentalScriptExecutionTool) {
			this.tools.delete('execute_javascript')
		}
	}

	/** Get current agent status */
	get status(): AgentStatus {
		return this.#status
	}

	/** Result of the most recent run, or `null` before the first run completes. */
	get lastResult(): ExecutionResult | null {
		return this.#lastResult
	}

	/** Emit statuschange event */
	#emitStatusChange(): void {
		this.dispatchEvent(new Event('statuschange'))
	}

	/** Emit historychange event */
	#emitHistoryChange(pushHistoricalEvent?: HistoricalEvent): void {
		if (pushHistoricalEvent) this.history.push(pushHistoricalEvent)
		this.dispatchEvent(new Event('historychange'))
	}

	/**
	 * Emit activity event - for transient UI feedback
	 * @param activity - Current agent activity
	 */
	#emitActivity(activity: AgentActivity): void {
		this.dispatchEvent(new CustomEvent('activity', { detail: activity }))
	}

	/** Update status and emit event */
	#setStatus(status: AgentStatus): void {
		if (this.#status !== status) {
			this.#status = status
			this.#emitStatusChange()
		}
	}

	/**
	 * Push an observation message to the history event stream.
	 * This will be visible in <agent_history> and remain persistent in memory across steps.
	 * @experimental @internal
	 * @note history change will be emitted before next step starts
	 */
	pushObservation(content: string): void {
		this.#observations.push(content)
	}

	/**
	 * Stop the current task and wait until the run has fully settled (including lifecycle hooks).
	 * @note never await .stop() in a lifecycle hook.
	 */
	async stop(): Promise<void> {
		if (this.#status !== 'running') return
		this.#abortController.abort()
		await this.#running
	}

	/**
	 * external errors (pre-checks/config/hooks) will threw;
	 * agent errors will be caught and added to history, and return a failed result
	 */
	/**
	 * Execute a task. When `options.initialHistory` is provided the agent resumes
	 * from a previously serialized state (see `serializeAgentState`) instead of
	 * starting a fresh conversation — used by multi-page continuity to continue
	 * a task in another page/tab.
	 *
	 * @param task - The task description (always the source of truth).
	 * @param options - Optional resume payload: `initialHistory` seeds the agent
	 *   memory and the step counter, `initialTaskId` keeps the audit/session id
	 *   stable across the migration.
	 */
	async execute(
		task: string,
		options: { initialHistory?: HistoricalEvent[]; initialTaskId?: string } = {}
	): Promise<ExecutionResult> {
		// pre-checks
		if (this.disposed) throw new Error('PageAgent has been disposed. Create a new instance.')
		if (this.#status === 'running') throw new Error('A task is already running.')
		if (!task) throw new Error('Task is required')

		this.task = task
		this.taskId = options.initialTaskId || uid()

		this.history = options.initialHistory ? [...options.initialHistory] : []
		this.#observations = []
		this.#states = {
			totalWaitTime: 0,
			lastURL: '',
			lastTabId: undefined,
			browserState: null,
			lastBrowserContent: null,
			browserStateUnchanged: false,
			lastFullBrowserStateStep: 0,
		}
		this.#abortController = new AbortController()
		const signal = this.#abortController.signal

		let resolveRunning!: () => void
		this.#running = new Promise<void>((r) => (resolveRunning = r))

		this.#setStatus('running')
		this.#emitHistoryChange()

		// Disable ask_user tool if onAskUser is not set
		if (!this.onAskUser) this.tools.delete('ask_user')

		const onBeforeStep = this.config.onBeforeStep
		const onAfterStep = this.config.onAfterStep
		const onBeforeTask = this.config.onBeforeTask
		const onAfterTask = this.config.onAfterTask
		const stepDelay = this.config.stepDelay ?? 0.4
		const maxSteps = this.config.maxSteps

		let step = this.history.filter((e) => e.type === 'step').length
		let taskResult: ExecutionResult
		let finalStatus: AgentStatus = 'error'

		await suppress(() => this.pageController.showMask())

		// graceful exit
		try {
			await onBeforeTask?.(this)

			while (true) {
				await onBeforeStep?.(this, step)

				// handle internal agent errors
				try {
					console.group(`step: ${step}`)

					// @note It's convenient to treat stepDelay as part of the next step.
					// Maybe move it to a dedicated try block for better semantics?
					if (step > 0) await waitFor(stepDelay, signal)

					signal.throwIfAborted()

					// observe

					console.log(chalk.blue.bold('👀 Observing...'))

					this.#states.browserState = await this.pageController.getBrowserState()

					// Detect an unchanged snapshot so the prompt can use a short placeholder
					// instead of re-sending the full DOM (see `dedupeUnchangedBrowserState`).
					// NOTE: `#states.lastURL` still holds the PREVIOUS step's URL here —
					// `#handleObservations` updates it afterwards.
					if (this.config.dedupeUnchangedBrowserState) {
						const content = this.#states.browserState.content
						const unchanged =
							this.#states.lastBrowserContent !== null &&
							content === this.#states.lastBrowserContent &&
							this.#states.lastURL === (this.#states.browserState.url || '')
						this.#states.browserStateUnchanged = unchanged
						if (!unchanged) {
							this.#states.lastBrowserContent = content
							this.#states.lastFullBrowserStateStep = step
						}
					}

					await this.#handleObservations(step)

					// assemble prompts

					const messages = [
						{ role: 'system' as const, content: this.#getSystemPrompt() },
						{ role: 'user' as const, content: await this.#assembleUserPrompt() },
					]

					const macroTool = { AgentOutput: this.#packMacroTool() }

					// invoke LLM

					console.log(chalk.blue.bold('🧠 Thinking...'))
					this.#emitActivity({ type: 'thinking' })

					const result = await this.#llm.invoke(messages, macroTool, signal, {
						toolChoiceName: 'AgentOutput',
						normalizeResponse: (res) => normalizeResponse(res, this.tools),
						// guidance-api intent routing context (checklist §2.2/§3):
						// additive metadata; upstreams that ignore unknown fields are
						// unaffected, and old guidance-api versions simply ignore it.
						metadata: {
							intent_context: {
								user_question: this.task,
								current_url: this.#states.browserState?.url || '',
								// The host-provided route is not known here; kept empty
								// unless a host integration extends it.
								current_route: '',
								page_title: this.#states.browserState?.title || '',
							},
						},
					})

					// assemble history

					const macroResult = result.toolResult as MacroToolResult
					const input = macroResult.input
					const output = macroResult.output
					const reflection: Partial<AgentReflection> = {
						evaluation_previous_goal: input.evaluation_previous_goal,
						memory: input.memory,
						next_goal: input.next_goal,
					}
					const actionName = Object.keys(input.action)[0]
					const action: AgentStepEvent['action'] = {
						name: actionName,
						input: input.action[actionName],
						output: output,
					}

					this.#emitHistoryChange({
						type: 'step',
						stepIndex: step,
						reflection,
						action,
						usage: result.usage,
						rawResponse: result.rawResponse,
						rawRequest: result.rawRequest,
					})

					if (actionName === 'done') {
						const success = action.input?.success ?? false
						const data = action.input?.text || 'no text provided'
						console.log(chalk.green.bold('Task completed'), success, data)
						taskResult = { success, data, history: this.history }
						this.#lastResult = taskResult
						finalStatus = 'completed'
						break
					}
				} catch (error: unknown) {
					// catch block must not throw error. otherwise the error may be overridden if finally block also throws error.

					const isAbortError = (error as any)?.name === 'AbortError'
					const isMigration = error instanceof MigrationError
					if (!isAbortError && !isMigration) console.error('Task failed', error)
					const message = isAbortError ? 'Task aborted' : String(error)
					if (!isMigration) {
						this.#emitActivity({ type: 'error', message: message })
						this.#emitHistoryChange({ type: 'error', message: message, rawResponse: error })
					}
					// On migration no history event is recorded: the old tab's history stays
					// clean so it can be reclaimed and resumed without a stray "migrated" note.
					taskResult = { success: false, data: message, history: this.history }
					this.#lastResult = taskResult
					finalStatus = isAbortError ? 'stopped' : isMigration ? 'migrated' : 'error'
					break
				} finally {
					// finally block runs before the break above.

					console.groupEnd()
					// @note hook may throw error.
					// which will override the `break` above and be handled as an external error.
					// as expected.
					await onAfterStep?.(this, this.history)
				}

				step++
				if (step > maxSteps) {
					const message = 'Step count exceeded maximum limit'
					console.error(message)
					this.#emitActivity({ type: 'error', message: message })
					this.#emitHistoryChange({ type: 'error', message: message })
					taskResult = { success: false, data: message, history: this.history }
					this.#lastResult = taskResult
					finalStatus = 'error'
					break
				}
			} // while

			await onAfterTask?.(this, taskResult)

			return taskResult
		} catch (error) {
			this.#emitActivity({ type: 'error', message: String(error) })
			finalStatus = 'error'
			throw error
		} finally {
			await suppress(() => this.pageController.cleanUpHighlights())
			await suppress(() => this.pageController.hideMask())
			this.#abortController.abort()
			resolveRunning()
			this.#setStatus(finalStatus)
		}
	}

	/**
	 * Merge all tools into a single MacroTool with the following input:
	 * - thinking: string
	 * - evaluation_previous_goal: string
	 * - memory: string
	 * - next_goal: string
	 * - action: { toolName: toolInput }
	 * where action must be selected from tools defined in this.tools
	 */
	#packMacroTool(): Tool<MacroToolInput, MacroToolResult> {
		const tools = this.tools

		const actionSchemas = Array.from(tools.entries()).map(([toolName, tool]) => {
			return z.object({ [toolName]: tool.inputSchema }).describe(tool.description)
		})

		const actionSchema = z.union(
			// SAFETY: `this.tools` is always non-empty — the built-in `done` tool is
			// registered at module init, so `actionSchemas` has at least one element and
			// a union of an empty tuple can never be constructed here. The double cast
			// is required because Array.from yields `ZodType[]`, which zod's `z.union`
			// does not accept (it needs a non-empty tuple type).
			actionSchemas as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]
		)

		const macroToolSchema = z.object({
			// thinking: z.string().optional(),
			evaluation_previous_goal: z.string().optional(),
			memory: z.string().optional(),
			next_goal: z.string().optional(),
			action: actionSchema,
		})

		return {
			description: 'You MUST call this tool every step!',
			inputSchema: macroToolSchema as z.ZodType<MacroToolInput>,
			execute: async (input: MacroToolInput): Promise<MacroToolResult> => {
				const signal = this.#abortController.signal
				signal.throwIfAborted()

				console.log(chalk.blue.bold('MacroTool input'), input)
				const action = input.action

				const toolName = Object.keys(action)[0]
				const toolInput = action[toolName]

				// Build reflection text, only include non-empty fields
				const reflectionLines: string[] = []
				if (input.evaluation_previous_goal)
					reflectionLines.push(`✅: ${input.evaluation_previous_goal}`)
				if (input.memory) reflectionLines.push(`💾: ${input.memory}`)
				if (input.next_goal) reflectionLines.push(`🎯: ${input.next_goal}`)

				const reflectionText = reflectionLines.length > 0 ? reflectionLines.join('\n') : ''

				if (reflectionText) {
					console.log(reflectionText)
				}

				// Find the corresponding tool
				const tool = tools.get(toolName)
				assert(tool, `Tool ${toolName} not found`)

				console.log(chalk.blue.bold(`Executing tool: ${toolName}`), toolInput)

				// Emit executing activity
				this.#emitActivity({ type: 'executing', tool: toolName, input: toolInput })

				const startTime = Date.now()

				const result = await tool.execute.bind(this)(toolInput, { signal })
				// Enforce abort even if the tool ignored the signal and resolved normally.
				signal.throwIfAborted()

				const duration = Date.now() - startTime
				console.log(chalk.green.bold(`Tool (${toolName}) executed for ${duration}ms`), result)

				// Emit executed activity
				this.#emitActivity({
					type: 'executed',
					tool: toolName,
					input: toolInput,
					output: result,
					duration,
				})

				// counting wait time
				if (toolName === 'wait') {
					const waitInput = action[toolName] as { seconds?: number } | undefined
					this.#states.totalWaitTime += waitInput?.seconds || 0
				} else {
					this.#states.totalWaitTime = 0
				}

				// Return structured result
				return {
					input,
					output: result,
				}
			},
		}
	}

	/**
	 * Get system prompt, dynamically replace language settings based on configured language
	 */
	#getSystemPrompt(): string {
		if (this.config.customSystemPrompt) {
			return this.config.customSystemPrompt
		}

		const targetLanguage = this.config.language === 'zh-CN' ? '中文' : 'English'
		const promptTemplate = this.config.multiPage ? MULTIPAGE_SYSTEM_PROMPT : SYSTEM_PROMPT
		const systemPrompt = promptTemplate.replace(
			/Default working language: \*\*.*?\*\*/,
			`Default working language: **${targetLanguage}**`
		)

		return systemPrompt
	}

	/**
	 * Get instructions from config
	 */
	async #getInstructions(): Promise<string> {
		const { instructions, experimentalLlmsTxt } = this.config

		const systemInstructions = instructions?.system?.trim()
		let pageInstructions: string | undefined

		const url = this.#states.browserState?.url || ''
		if (instructions?.getPageInstructions && url) {
			try {
				pageInstructions = instructions.getPageInstructions(url)?.trim()
			} catch (error) {
				console.error(
					chalk.red('[PageAgent] Failed to execute getPageInstructions callback:'),
					error
				)
			}
		}

		const llmsTxt = experimentalLlmsTxt && url ? await fetchLlmsTxt(url) : undefined

		if (!systemInstructions && !pageInstructions && !llmsTxt) return ''

		let result = '<instructions>\n'

		if (systemInstructions) {
			result += `<system_instructions>\n${systemInstructions}\n</system_instructions>\n`
		}

		if (pageInstructions) {
			result += `<page_instructions>\n${pageInstructions}\n</page_instructions>\n`
		}

		if (llmsTxt) {
			result += `<llms_txt>\n${llmsTxt}\n</llms_txt>\n`
		}

		result += '</instructions>\n\n'

		return result
	}

	/**
	 * Generate system observations before each step
	 * @todo loop detection
	 * @todo console error
	 */
	async #handleObservations(step: number): Promise<void> {
		// Accumulated wait time warning
		if (this.#states.totalWaitTime >= 3) {
			this.pushObservation(
				`You have waited ${this.#states.totalWaitTime} seconds accumulatively. ` +
					`DO NOT wait any longer unless you have a good reason.`
			)
		}

		// Detect page context change: a tab switch (extension/multi-tab mode) or an
		// in-tab URL navigation. Tab switches get their own observation so the model
		// does not misread them as navigation (and can anchor where it came from).
		const browserState = this.#states.browserState
		const currentURL = browserState?.url || ''
		const currentTabId = browserState?.tabId
		const tabSwitched =
			currentTabId !== undefined &&
			this.#states.lastTabId !== undefined &&
			currentTabId !== this.#states.lastTabId

		if (tabSwitched) {
			this.pushObservation(
				`Switched to tab ${currentTabId} (from tab ${this.#states.lastTabId}): ` +
					`[${browserState?.title ?? ''}](${currentURL})`
			)
			await waitFor(0.5) // wait for the newly visible tab to stabilize
		} else if (currentURL !== this.#states.lastURL) {
			this.pushObservation(`Page navigated to → ${currentURL}`)
			await waitFor(0.5) // wait for page to stabilize
		}

		this.#states.lastTabId = currentTabId
		this.#states.lastURL = currentURL

		// Remaining steps warning
		const remaining = this.config.maxSteps - step
		if (remaining === 5) {
			this.pushObservation(
				`⚠️ Only ${remaining} steps remaining. ` +
					`Consider wrapping up or calling done with partial results.`
			)
		} else if (remaining === 2) {
			this.pushObservation(
				`⚠️ Critical: Only ${remaining} steps left! You must finish the task or call done immediately.`
			)
		}

		// Push observations to history and emit
		if (this.#observations.length > 0) {
			for (const content of this.#observations) {
				this.history.push({ type: 'observation', content })
				console.log(chalk.cyan('Observation:'), content)
			}
			this.#observations = []
			this.#emitHistoryChange()
		}
	}

	async #assembleUserPrompt(): Promise<string> {
		const browserState = this.#states.browserState!

		let prompt = ''

		// <instructions> (optional)

		prompt += await this.#getInstructions()

		// <agent_state>
		//  - <user_request>
		// NOTE: <step_info> (step number + current time) is intentionally emitted
		// AFTER <agent_history>, not inside <agent_state>. Both fields change on
		// every step; keeping them before the append-only history would invalidate
		// the prompt prefix cache at that point and force a full re-prefill of the
		// growing history on every step.
		// <agent_state> / <step_info> / <agent_history>

		const stepCount = this.history.filter((e) => e.type === 'step').length

		prompt += '<agent_state>\n'
		prompt += '<user_request>\n'
		prompt += `${this.task}\n`
		prompt += '</user_request>\n'
		prompt += '</agent_state>\n\n'

		// <agent_history>
		//  - <step_N> for steps
		//  - <sys> for observations and system messages

		prompt += '<agent_history>\n'

		// LLM-view windowing (LLM/UI view separation): only the most recent
		// `maxStepEvents` step events are rendered; earlier steps are replaced by a
		// one-line compaction marker. `this.history` itself stays complete for the
		// UI — windowing affects only what the model sees.
		const maxStepEvents = this.config.historyView?.maxStepEvents
		const totalStepEvents = maxStepEvents ? this.history.filter((e) => e.type === 'step').length : 0
		const skipStepEvents = maxStepEvents ? Math.max(0, totalStepEvents - maxStepEvents) : 0
		let skippedEmitted = false

		let stepIndex = 0
		for (const event of this.history) {
			if (event.type === 'step') {
				stepIndex++
				if (stepIndex <= skipStepEvents) continue
				if (skipStepEvents > 0 && !skippedEmitted) {
					skippedEmitted = true
					prompt +=
						`<sys>History compacted: the earliest ${skipStepEvents} step(s) are not shown. ` +
						`Their progress is summarized in the Memory fields below.</sys>\n`
				}
				prompt += `<step_${stepIndex}>\n`
				prompt += `Evaluation of Previous Step: ${event.reflection.evaluation_previous_goal}\n`
				prompt += `Memory: ${event.reflection.memory}\n`
				prompt += `Next Goal: ${event.reflection.next_goal}\n`
				prompt += `Action Results: ${event.action.output}\n`
				prompt += `</step_${stepIndex}>\n`
			} else if (event.type === 'observation') {
				prompt += `<sys>${event.content}</sys>\n`
			} else if (event.type === 'user_takeover') {
				prompt += `<sys>User took over control and made changes to the page</sys>\n`
			} else if (event.type === 'error') {
				// Error events are mainly for panel rendering, not included in LLM context
				// to avoid polluting the agent's reasoning with transient errors
			}
		}

		prompt += '</agent_history>\n\n'

		// <step_info> — volatile per-step fields, placed after the append-only
		// <agent_history> so upstream prefix caches can cover system + instructions
		// + agent_state + history across steps.
		prompt += '<step_info>\n'
		prompt += `Step ${stepCount + 1} of ${this.config.maxSteps} max possible steps\n`
		prompt += `Current time: ${new Date().toLocaleString()}\n`
		prompt += '</step_info>\n\n'

		// <browser_state>

		let pageContent = browserState.content
		if (this.config.transformPageContent) {
			pageContent = await this.config.transformPageContent(pageContent)
		}

		// Unchanged-page placeholder: the snapshot is byte-identical to the one the
		// model already saw (same URL), so re-sending it would only cost tokens.
		// Element indexes from that snapshot remain valid because the page is unchanged.
		if (this.#states.browserStateUnchanged) {
			pageContent =
				`[browser_state unchanged since step ${this.#states.lastFullBrowserStateStep + 1}: ` +
				`identical to the previously observed snapshot. ` +
				`All listed elements and their indexes remain valid.]`
		}

		prompt += '<browser_state>\n'
		prompt += browserState.header + '\n'
		prompt += pageContent + '\n'
		prompt += browserState.footer + '\n\n'
		prompt += '</browser_state>\n\n'

		return prompt
	}

	dispose() {
		console.log('Disposing PageAgent...')
		this.disposed = true
		this.pageController.dispose()
		// this.history = []
		this.#abortController.abort()

		// Emit dispose event for UI cleanup
		this.dispatchEvent(new Event('dispose'))

		this.config.onDispose?.(this)
	}
}
