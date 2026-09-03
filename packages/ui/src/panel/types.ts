/**
 * Agent activity - transient state for immediate UI feedback.
 *
 * Unlike historical events (which are persisted), activities are ephemeral
 * and represent "what the agent is doing right now". UI components should
 * listen to 'activity' events to show real-time feedback.
 *
 * Note: There is no 'idle' activity - absence of activity events means idle.
 *
 * Events dispatched: CustomEvent<AgentActivity>
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
			 * programmatic `window.open` without a user gesture). The Panel should
			 * render a clickable card for `url`; the user click is the real gesture.
			 */
			type: 'awaiting_navigation'
			url: string
	  }

/**
 * Multi-page handoff state rendered by the Panel. Driven by the agent's
 * `handoffchange` event (Panel listens to it when the agent has `handoff`).
 */
export interface PanelHandoff {
	kind: 'awaiting' | 'resume' | 'reclaimable' | null
	/** Card link for `awaiting` (user click opens the new tab). */
	url?: string
	/** Task text for the `resume` card. */
	task?: string
	/** Cancel the awaited navigation; the agent continues in this tab. */
	cancelAwaitingNavigation?: () => void
	/** Resume the handed-off task in this tab (new tab). */
	resume?: () => void
	/** Take the task back in this tab (old tab, new tab closed/unclaimed). */
	reclaim?: () => void
}

/**
 * Sanitized LLM stream tool-progress event (guidance-api knowledge_qa streams).
 * Structurally identical to the llms package's LLMStreamProgress; declared
 * locally so the UI package keeps its dependency-free adapter boundary.
 * Events dispatched: CustomEvent<PanelStreamProgress> on 'streamprogress'.
 */
export interface PanelStreamProgress {
	phase: 'start' | 'end'
	tool: string
	isError?: boolean
	/** Controlled server-side summary: path tail or grep search pattern. */
	detail?: string
}

/**
 * Minimal interface that Panel expects from an agent.
 * Panel does not depend on PageAgent directly - it only requires this interface.
 * This enables decoupling and allows any agent implementation to work with Panel.
 *
 * Events:
 * - 'statuschange': Agent status changed
 * - 'historychange': Historical events updated (persisted)
 * - 'activity': Transient activity for immediate UI feedback (thinking/executing/etc)
 * - 'dispose': Agent is being disposed
 */
export interface PanelAgentAdapter extends EventTarget {
	/** Current agent status */
	readonly status: 'idle' | 'running' | 'completed' | 'error' | 'stopped' | 'migrated'

	/** Result of the most recent run, or `null` before the first run completes */
	readonly lastResult: { success: boolean; data?: string } | null

	/** History of agent events */
	readonly history: readonly {
		type: 'step' | 'observation' | 'user_takeover' | 'retry' | 'error'
		stepIndex?: number
		/** For 'step' type */
		reflection?: {
			evaluation_previous_goal?: string
			memory?: string
			next_goal?: string
		}
		/** For 'step' type */
		action?: {
			name: string
			input: unknown
			output: string
		}
		/** For 'observation' type */
		content?: string
		/** For 'retry' type */
		attempt?: number
		maxAttempts?: number
		/** For 'retry' and 'error' types */
		message?: string
	}[]

	/** Current task being executed */
	readonly task: string

	/**
	 * Optional multi-page handoff hooks rendered by the Panel (awaiting card,
	 * resume card, reclaim button). Undefined when handoff is disabled.
	 */
	readonly handoff?: PanelHandoff

	/**
	 * Called by the Panel inside the task-submit user gesture (e.g. to reserve
	 * a placeholder tab for the `placeholder` handoff strategy).
	 */
	onSubmitGesture?: () => void

	/**
	 * Called when the agent needs to ask the user questions.
	 * If unset, the `ask_user` tool will be disabled.
	 * Panel will set this to handle user questions via its UI.
	 * The optional `signal` aborts when the task is stopped or disposed.
	 */
	onAskUser?: (question: string, options?: { signal: AbortSignal }) => Promise<string>

	/** Execute a task */
	execute(task: string): Promise<unknown>

	/** Stop the current task (agent remains reusable) */
	stop(): Promise<void>

	/** Dispose the agent (terminal, cannot be reused) */
	dispose(): void
}
