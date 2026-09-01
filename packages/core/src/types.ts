import type { LLMConfig } from '@page-agent/llms'

// @note circular dependency but okay
import type { PageAgentCore } from './PageAgentCore'
import type { PageAgentTool } from './tools'

/** Supported UI languages */
export type SupportedLanguage = 'en-US' | 'zh-CN'

export interface AgentConfig extends LLMConfig {
	language?: SupportedLanguage

	/**
	 * Maximum number of steps the agent can take per task.
	 * @default 40
	 */
	maxSteps?: number

	/**
	 * Custom tools to extend PageAgent capabilities
	 * @experimental
	 * @note You can also override or remove internal tools by using the same name.
	 * @see PageAgentTool
	 *
	 * @example
	 * // override internal tool
	 * import { z } from 'zod/v4'
	 * import { tool } from 'page-agent'
	 * const customTools = {
	 * ask_user: tool({
	 * 	description:
	 * 		'Ask the user or parent model a question and wait for their answer. Use this if you need more information or clarification.',
	 * 	inputSchema: z.object({
	 * 		question: z.string(),
	 * 	}),
	 * 	execute: async function (this: PageAgent, input) {
	 * 		const answer = await do_some_thing(input.question)
	 * 		return "✅ Received user answer: " + answer
	 * 	},
	 * })
	 * }
	 *
	 * @example
	 * // remove internal tool
	 * const customTools = {
	 * 	ask_user: null // never ask user questions
	 * }
	 */
	customTools?: Record<string, PageAgentTool | null>

	/**
	 * Instructions to guide the agent's behavior
	 */
	instructions?: {
		/**
		 * Global system-level instructions, applied to all tasks
		 */
		system?: string

		/**
		 * Dynamic page-level instructions callback
		 * Called before each step to get instructions for the current page
		 * @param url - Current page URL (window.location.href)
		 * @returns Instructions string, or undefined/null to skip
		 */
		getPageInstructions?: (url: string) => string | undefined | null
	}

	/**
	 * Lifecycle hooks for task execution.
	 * @experimental API may change in future versions.
	 *
	 * All hooks receive the agent instance as first parameter.
	 */

	/**
	 * Called before each step execution.
	 * @experimental
	 * @param agent - The PageAgentCore instance
	 * @param stepCount - Current step number (0-indexed)
	 */
	onBeforeStep?: (agent: PageAgentCore, stepCount: number) => Promise<void> | void

	/**
	 * Called after each step execution.
	 * @experimental
	 * @param agent - The PageAgentCore instance
	 * @param history - Current history of events
	 */
	onAfterStep?: (agent: PageAgentCore, history: HistoricalEvent[]) => Promise<void> | void

	/**
	 * Called before task execution starts.
	 * @experimental
	 * @param agent - The PageAgentCore instance
	 */
	onBeforeTask?: (agent: PageAgentCore) => Promise<void> | void

	/**
	 * Called after task execution completes (success or failure).
	 * @experimental
	 * @param agent - The PageAgentCore instance
	 * @param result - The execution result
	 */
	onAfterTask?: (agent: PageAgentCore, result: ExecutionResult) => Promise<void> | void

	/**
	 * Called when the agent is disposed.
	 * @experimental
	 * @note This hook can block the disposal process if it's async.
	 * @param agent - The PageAgentCore instance
	 * @param reason - Optional reason for disposal
	 */
	onDispose?: (agent: PageAgentCore, reason?: string) => void

	// page behavior hooks

	/**
	 * Enable the multi-page system prompt variant: the agent may open new tabs
	 * via the `open_new_tab` handoff tool instead of being restricted to the
	 * current page. Wire the tool + HandoffController yourself (see
	 * `@page-agent/handoff` and the `PageAgent` entry).
	 */
	multiPage?: boolean

	/**
	 * @experimental
	 * Enable the experimental script execution tool that allows executing generated JavaScript code on the page.
	 * @note Can cause unpredictable side effects.
	 * @note May bypass some safe guards and data-masking mechanisms.
	 */
	experimentalScriptExecutionTool?: boolean

	/**
	 * @experimental
	 * Fetch /llms.txt from current site origin and include as context.
	 * Only fetched once per origin per task.
	 * @default false
	 */
	experimentalLlmsTxt?: boolean

	/**
	 * Transform page content before sending to LLM.
	 * Called after DOM extraction and simplification, before LLM invocation.
	 * Use cases: inspect extraction results, modify page info, mask sensitive data.
	 *
	 * @param content - Simplified page content that will be sent to LLM
	 * @returns Transformed content
	 *
	 * @example
	 * // Mask phone numbers
	 * transformPageContent: async (content) => {
	 *   return content.replace(/1[3-9]\d{9}/g, '***********')
	 * }
	 */
	transformPageContent?: (content: string) => Promise<string> | string

	/**
	 * Completely override the default system prompt.
	 * @experimental Use with caution - incorrect prompts may break agent behavior.
	 */
	customSystemPrompt?: string

	/**
	 * Delay between steps in seconds.
	 * @default 0.4
	 */
	stepDelay?: number

	/**
	 * LLM-view history windowing (LLM/UI view separation).
	 *
	 * When set, `<agent_history>` in the LLM prompt only contains the most recent
	 * `maxStepEvents` step events; older steps are replaced by a one-line compaction
	 * marker. The full history is still kept on `agent.history` for UI rendering,
	 * debugging, and multi-page migration — only what the model sees is windowed.
	 *
	 * The model is expected to track long-range progress through the `memory`
	 * reflection field, which is repeated on every kept step.
	 *
	 * @example
	 * historyView: { maxStepEvents: 5 }
	 */
	historyView?: { maxStepEvents?: number }

	/**
	 * Replace `<browser_state>` content with a short placeholder when the page
	 * did not change since the previous step (e.g. after a failed click or a wait).
	 *
	 * The DOM snapshot is usually the largest block in the prompt; skipping it for
	 * unchanged pages saves a full re-prefill of those tokens. Element indexes from
	 * the last full snapshot remain valid because the page is unchanged.
	 *
	 * @default false (opt-in: tasks that re-read page text every step should keep this off)
	 */
	dedupeUnchangedBrowserState?: boolean
}

/**
 * Agent reflection state - the reflection-before-action model
 *
 * Every tool call must first reflect on:
 * - evaluation_previous_goal: How well did the previous action achieve its goal?
 * - memory: Key information to remember for future steps
 * - next_goal: What should be accomplished in the next action?
 */
export interface AgentReflection {
	evaluation_previous_goal: string
	memory: string
	next_goal: string
}

/**
 * MacroTool input structure
 *
 * This is the core abstraction that enforces the "reflection-before-action" mental model.
 * Before executing any action, the LLM must output its reasoning state.
 */
export interface MacroToolInput extends Partial<AgentReflection> {
	/** Tool-name → parsed tool input. Validated at runtime by each tool's Zod schema. */
	action: Record<string, unknown>
}

/**
 * MacroTool output structure
 */
export interface MacroToolResult {
	input: MacroToolInput
	output: string
}

/**
 * A single agent step with reflection and action
 */
export interface AgentStepEvent {
	type: 'step'
	stepIndex: number
	reflection: Partial<AgentReflection>
	action: {
		name: string
		input: any
		output: string
	}
	usage: {
		promptTokens: number
		completionTokens: number
		totalTokens: number
		cachedTokens?: number
		reasoningTokens?: number
	}
	/** Raw LLM response for debugging */
	rawResponse?: unknown
	/** Raw LLM request for debugging */
	rawRequest?: unknown
}

/**
 * Persistent observation event (stays in memory)
 */
export interface ObservationEvent {
	type: 'observation'
	content: string
}

/**
 * User takeover event
 */
export interface UserTakeoverEvent {
	type: 'user_takeover'
}

/**
 * Retry event - LLM call is being retried
 */
export interface RetryEvent {
	type: 'retry'
	message: string
	attempt: number
	maxAttempts: number
}

/**
 * Error event - fatal error from LLM or execution
 */
export interface AgentErrorEvent {
	type: 'error'
	message: string
	rawResponse?: unknown
}

/**
 * Union type for all history events
 */
export type HistoricalEvent =
	AgentStepEvent | ObservationEvent | UserTakeoverEvent | RetryEvent | AgentErrorEvent

/**
 * Agent lifecycle status.
 * `migrated` means the task was handed off to another tab/page and the agent
 * ended its run here (see `MigrationError`).
 */
export type AgentStatus = 'idle' | 'running' | 'completed' | 'error' | 'stopped' | 'migrated'

/**
 * Agent activity - transient state for immediate UI feedback.
 *
 * Unlike historical events (which are persisted), activities are ephemeral
 * and represent "what the agent is doing right now". UI components should
 * listen to 'activity' events to show real-time feedback.
 *
 * Note: There is no 'idle' activity - absence of activity events means idle.
 */
export type AgentActivity =
	| { type: 'thinking' }
	| { type: 'executing'; tool: string; input: unknown }
	| { type: 'executed'; tool: string; input: unknown; output: string; duration: number }
	| { type: 'retrying'; attempt: number; maxAttempts: number }
	| { type: 'error'; message: string }
	| {
			/**
			 * The agent needs the user to open a new tab (popup blockers forbid
			 * programmatic `window.open` without a user gesture). The UI should show
			 * a clickable card for `url`; the user click is the real gesture.
			 */
			type: 'awaiting_navigation'
			url: string
	  }

export interface ExecutionResult {
	success: boolean
	data: string
	history: HistoricalEvent[]
}
