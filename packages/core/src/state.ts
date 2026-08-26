/**
 * Agent state serialization for multi-page (no-extension) continuity.
 *
 * A running agent can be resumed in another page/tab by migrating its task and
 * history (the LLM is stateless per request — each step sends the full history
 * in the prompt, so `task + history` is the complete resumable state).
 *
 * The snapshot deliberately strips `rawResponse` / `rawRequest` from history
 * events: they hold full LLM requests/responses (including the whole simplified
 * DOM) and are debug-only — neither the LLM context nor the Panel reads them.
 * Stripping keeps snapshots small enough for sessionStorage/localStorage
 * (≈0.2–1KB per step instead of tens of KB).
 */
import type { PageAgentCore } from './PageAgentCore'
import type { HistoricalEvent } from './types'

/** Current snapshot schema version. Bump on breaking changes. */
export const AGENT_SNAPSHOT_VERSION = 1 as const

/** Event `type` values that a valid history event may carry. */
const EVENT_TYPES = new Set(['step', 'observation', 'user_takeover', 'retry', 'error'] as const)

/**
 * Serializable agent state that survives page reloads and can be resumed in
 * another tab. Carries everything the agent loop needs to continue: the task
 * text, the stable task id (audit/session linkage) and the step history.
 */
export interface AgentSnapshot {
	version: typeof AGENT_SNAPSHOT_VERSION
	task: string
	taskId: string
	history: HistoricalEvent[]
	createdAt: number
}

/** The minimal agent surface needed to (de)serialize state. */
type AgentStateHost = Pick<PageAgentCore, 'task' | 'taskId' | 'history'>

/** Strip debug-only raw LLM payloads from a history event. */
function stripRawEventFields(event: HistoricalEvent): HistoricalEvent {
	if (event.type === 'step') {
		const { rawResponse, rawRequest, ...rest } = event
		void rawResponse
		void rawRequest
		return rest
	}
	if (event.type === 'error') {
		const { rawResponse, ...rest } = event
		void rawResponse
		return rest
	}
	return event
}

/**
 * Serialize an agent's resumable state.
 *
 * @param agent - The agent whose `task`/`taskId`/`history` to snapshot.
 * @returns A versioned, JSON-safe snapshot (raw LLM payloads stripped).
 */
export function serializeAgentState(agent: AgentStateHost): AgentSnapshot {
	return {
		version: AGENT_SNAPSHOT_VERSION,
		task: agent.task,
		taskId: agent.taskId,
		history: agent.history.map(stripRawEventFields),
		createdAt: Date.now(),
	}
}

/** Validate the shape of one history event without trusting its payload. */
function isHistoricalEvent(value: unknown): value is HistoricalEvent {
	if (typeof value !== 'object' || value === null) return false
	const type = (value as { type?: unknown }).type
	return typeof type === 'string' && (EVENT_TYPES as Set<string>).has(type)
}

/**
 * Validate an unknown value as an `AgentSnapshot`, throwing on any mismatch.
 * Used when parsing snapshots recovered from browser storage.
 *
 * @param value - Untrusted candidate (e.g. parsed JSON from localStorage).
 * @returns The validated snapshot.
 * @throws Error when the value is missing, versioned differently or malformed.
 */
export function parseAgentSnapshot(value: unknown): AgentSnapshot {
	if (typeof value !== 'object' || value === null) {
		throw new Error('Invalid agent snapshot: expected an object')
	}
	const snapshot = value as Record<string, unknown>
	if (snapshot.version !== AGENT_SNAPSHOT_VERSION) {
		throw new Error(`Unsupported agent snapshot version: ${String(snapshot.version)}`)
	}
	if (typeof snapshot.task !== 'string' || typeof snapshot.taskId !== 'string') {
		throw new Error('Invalid agent snapshot: task/taskId must be strings')
	}
	if (
		!Array.isArray(snapshot.history) ||
		!snapshot.history.every((event) => isHistoricalEvent(event))
	) {
		throw new Error('Invalid agent snapshot: malformed history array')
	}
	// SAFETY: `isHistoricalEvent` and the field checks above have verified the
	// shape (version, task/taskId strings, history entries with known event
	// types). The cast is only widening the literal check to the interface type.
	return snapshot as unknown as AgentSnapshot
}

/**
 * Restore a snapshot into an agent (task/taskId/history) without running it.
 *
 * The caller still calls `execute(task, { initialHistory, initialTaskId })` to
 * actually resume — this helper is for hosts that want to display or inspect
 * the handed-off state first (e.g. show a "continue?" card).
 *
 * @param agent - The target agent (must be idle/not disposed).
 * @param snapshot - A snapshot previously produced by `serializeAgentState`.
 * @throws Error when the snapshot is missing, versioned differently or malformed.
 */
export function restoreAgentState(agent: AgentStateHost, snapshot: AgentSnapshot): void {
	parseAgentSnapshot(snapshot)

	agent.task = snapshot.task
	agent.taskId = snapshot.taskId
	// Shallow-copy each event so later in-place history mutations cannot alias
	// into the snapshot (or the storage it was parsed from).
	agent.history = snapshot.history.map((event) => ({ ...event }))
}
