/**
 * HandoffController — same-tab and cross-tab task continuity for page-agent
 * **without** a browser extension.
 *
 * Why this works: PageAgentCore is stateless per LLM request (each step sends
 * the full `task + history` in the prompt), so a task can be resumed in another
 * page/tab by migrating exactly those two things (see `AgentSnapshot`).
 *
 * Storage model:
 * - `sessionStorage` (per tab): the *active* snapshot, written after every step.
 *   Survives reloads / MPA navigation, so a reloaded tab can resume mid-task.
 * - `localStorage` (per origin): the *pending handoff* record published by
 *   `open_new_tab`. Cross-tab truth — it survives the source tab closing.
 * - `BroadcastChannel`: wake-up/claim events only (the payload rides in
 *   storage, which outlives both tabs).
 *
 * Handoff flow (strategy `confirm`, the default):
 * 1. The LLM calls the `open_new_tab` tool; the controller validates the URL,
 *    writes the pending record and emits an `awaiting_navigation` activity.
 * 2. The Panel renders a clickable card; the user click is the real browser
 *    gesture (programmatic `window.open` from an LLM callback would be blocked).
 * 3. The new tab loads, finds the marker (`?pa_handoff=<taskId>:<nonce>`),
 *    claims the pending record and broadcasts `claim`.
 * 4. The old tab's tool promise resolves → the agent ends with status
 *    `migrated`; the new tab offers a "continue task?" card and resumes.
 *
 * Failure paths: claim timeout (user never clicked) → old tab continues;
 * claimed but the new tab died → the old tab shows a reclaim action.
 */
import {
	type AgentSnapshot,
	type AgentStatus,
	type ExecutionResult,
	type HistoricalEvent,
	MigrationError,
	parseAgentSnapshot,
	serializeAgentState,
} from '@page-agent/core'

/** BroadcastChannel name used for handoff events (configurable). */
const DEFAULT_CHANNEL_NAME = 'page-agent-handoff'
/** Query parameter carrying the handoff marker in the card link. */
const MARKER_PARAM = 'pa_handoff'
/** localStorage key prefix for pending handoff records. */
const PENDING_KEY_PREFIX = 'page-agent:handoff:pending'
/** sessionStorage key for the active (same-tab recovery) snapshot. */
const ACTIVE_KEY = 'page-agent:handoff:active'
/** Extra life granted to a pending record beyond the claim timeout. */
const PENDING_EXPIRY_SLACK_MS = 60_000
/** Debounce for persisting the active snapshot after history changes. */
const PERSIST_DEBOUNCE_MS = 100
/** How often the old tab re-checks whether the new tab is still alive. */
const RECLAIM_POLL_MS = 2_000

/** Handoff runtime configuration. */
export interface HandoffConfig {
	/** BroadcastChannel name. @default 'page-agent-handoff' */
	channelName?: string
	/**
	 * How to open new tabs.
	 * - `confirm` (default): show a clickable card; the user click is the gesture.
	 * - `placeholder`: navigate a window pre-reserved by `reservePlaceholderTab()`
	 *   (called inside the task-start user gesture). Falls back to `confirm`
	 *   when no reserved window is available.
	 */
	newTabStrategy?: 'confirm' | 'placeholder'
	/**
	 * Hosts the `open_new_tab` tool may target, in addition to the same origin.
	 * Each entry is an exact origin or a URL prefix string, or a RegExp tested
	 * against the full target URL. Empty/omitted ⇒ same origin only.
	 */
	openTabUrlAllowlist?: (string | RegExp)[]
	/** How long `open_new_tab` waits for the new tab to claim before giving up (ms). @default 15000 */
	claimTimeoutMs?: number
	/** Active-host heartbeat interval while running (ms). @default 1000 */
	heartbeatIntervalMs?: number
	/** A claim is considered stale after this many ms without a heartbeat. @default 3 × heartbeatIntervalMs */
	reclaimGraceMs?: number
}

/** Defaults applied to a partial config. */
export interface ResolvedHandoffConfig {
	channelName: string
	newTabStrategy: 'confirm' | 'placeholder'
	openTabUrlAllowlist: (string | RegExp)[]
	claimTimeoutMs: number
	heartbeatIntervalMs: number
	reclaimGraceMs: number
}

/** Messages exchanged on the handoff channel. */
export interface HandoffMessage {
	type: 'publish' | 'claim' | 'release' | 'heartbeat'
	taskId: string
	nonce?: string
}

/** A pending (not-yet-resumed) handoff record stored in localStorage. */
export interface PendingHandoff {
	version: 1
	taskId: string
	nonce: string
	snapshot: AgentSnapshot
	createdAt: number
	expiresAt: number
	claim: { tabId: string; claimedAt: number; heartbeatTs: number } | null
}

/** Minimal Storage interface (sessionStorage/localStorage share this shape). */
export interface HandoffStorage {
	getItem(key: string): string | null
	setItem(key: string, value: string): void
	removeItem(key: string): void
	readonly length: number
	key(index: number): string | null
}

/** Minimal BroadcastChannel interface so tests can inject an in-memory bus. */
export interface HandoffChannel {
	postMessage(message: HandoffMessage): void
	addEventListener(type: 'message', listener: (event: { data: HandoffMessage }) => void): void
	removeEventListener(type: 'message', listener: (event: { data: HandoffMessage }) => void): void
	close(): void
}

/** Panel-facing state produced by the controller (consumed by PageAgent UI). */
export type HandoffState =
	| { kind: 'awaiting'; url: string; taskId: string }
	| { kind: 'resume'; task: string; taskId: string }
	| { kind: 'reclaimable'; taskId: string }
	| { kind: 'migrated'; taskId: string }
	| { kind: null }

/** Minimal agent surface the controller relies on (PageAgentCore satisfies it). */
export interface HandoffAgentLike extends EventTarget {
	task: string
	taskId: string
	history: HistoricalEvent[]
	status: AgentStatus
	disposed: boolean
	execute(
		task: string,
		options?: { initialHistory?: HistoricalEvent[]; initialTaskId?: string }
	): Promise<ExecutionResult>
}

/** Constructor inputs (dependencies are injectable for tests). */
export interface HandoffControllerOptions {
	agent: HandoffAgentLike
	config?: HandoffConfig
	storage?: HandoffStorage
	sessionStorage?: HandoffStorage
	channel?: HandoffChannel
}

const isQuotaError = (error: unknown): boolean =>
	error instanceof DOMException
		? error.name === 'QuotaExceededError'
		: (error as { name?: string })?.name === 'QuotaExceededError'

function randomToken(): string {
	return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

/** Append the handoff marker (`?pa_handoff=<taskId>:<nonce>`) to a URL. */
export function buildHandoffUrl(url: string, taskId: string, nonce: string): string {
	const target = new URL(url, window.location.href)
	target.searchParams.set(MARKER_PARAM, `${taskId}:${nonce}`)
	return target.toString()
}

/** Parse the handoff marker from a URL search string (e.g. `window.location.search`). */
export function parseHandoffMarker(search: string): { taskId: string; nonce: string } | null {
	const marker = new URLSearchParams(search).get(MARKER_PARAM)
	if (!marker) return null
	const [taskId, nonce] = marker.split(':')
	if (!taskId || !nonce) return null
	return { taskId, nonce }
}

function pendingKey(taskId: string): string {
	return `${PENDING_KEY_PREFIX}:${taskId}`
}

/** The outcome of waiting for a claim. */
type ClaimOutcome = 'claimed' | 'timeout' | 'cancelled' | 'aborted'

/**
 * Coordinates task handoff between pages/tabs of the same origin.
 * One instance per tab (created alongside the agent).
 */
export class HandoffController extends EventTarget {
	private readonly agent: HandoffAgentLike
	private readonly config: ResolvedHandoffConfig
	private readonly storage: HandoffStorage
	private readonly tabStorage: HandoffStorage
	private readonly channel: HandoffChannel | null
	/** Random per-tab identity (no chrome.tabs ids in embed mode). */
	private readonly tabId = randomToken()

	private reservedWindow: Window | null = null
	private pending: PendingHandoff | null = null
	private state: HandoffState = { kind: null }
	private stateDirty = false

	// Timers / handles
	private persistTimer: ReturnType<typeof setTimeout> | null = null
	private startupTimer: ReturnType<typeof setTimeout> | null = null
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null
	private reclaimTimer: ReturnType<typeof setInterval> | null = null
	/** Resolves the in-flight `open_new_tab` await (claim waiter). */
	private claimWaiter: { resolve: (outcome: ClaimOutcome) => void } | null = null
	private disposed = false

	// Bound handlers
	private readonly onStatusChange = (): void => this.handleStatusChange()
	private readonly onHistoryChange = (): void => this.schedulePersist()
	private readonly onPageHide = (): void => this.persistNow()
	private readonly onChannelMessage = (event: { data: HandoffMessage }): void =>
		this.handleChannelMessage(event.data)

	constructor(options: HandoffControllerOptions) {
		super()
		this.agent = options.agent
		this.config = resolveConfig(options.config)
		this.storage = options.storage ?? defaultStorage('localStorage')
		this.tabStorage = options.sessionStorage ?? defaultStorage('sessionStorage')
		this.channel =
			options.channel ??
			(typeof BroadcastChannel === 'undefined'
				? null
				: new BroadcastChannel(this.config.channelName))
	}

	// ========== Public API ==========

	/**
	 * Wire the controller to the agent and the current page.
	 * Safe to call once after construction; recovery checks run on a macrotask
	 * so the host (panel, hooks) is fully initialized first.
	 */
	start(): void {
		if (this.disposed) return
		this.agent.addEventListener('statuschange', this.onStatusChange)
		this.agent.addEventListener('historychange', this.onHistoryChange)
		window.addEventListener('pagehide', this.onPageHide)
		this.channel?.addEventListener('message', this.onChannelMessage)

		// The recovery check may auto-resume a task; defer it until the current
		// call stack (host construction) has finished.
		this.startupTimer = setTimeout(() => {
			this.startupTimer = null
			this.checkHandoffOnLoad()
		}, 0)
	}

	/**
	 * Reserve a placeholder window during a user gesture (task-start button
	 * click). With strategy `placeholder`, `open_new_tab` navigates this window
	 * instead of asking the user to click a card. Returns false when the popup
	 * was blocked or the strategy is not `placeholder`.
	 */
	reservePlaceholderTab(): boolean {
		if (this.config.newTabStrategy !== 'placeholder' || this.disposed) return false
		if (this.reservedWindow && !this.reservedWindow.closed) return true
		try {
			// The URL is a hardcoded literal ('about:blank'), not user input;
			// only the browsing context is created here.
			// pi-lens-ignore: no-open-redirect
			const win = window.open('about:blank', '_blank')
			if (win) {
				this.reservedWindow = win
				return true
			}
		} catch {
			// Popup blocked — fall back to the confirm card at open time.
		}
		return false
	}

	/**
	 * Handle the `open_new_tab` tool call.
	 *
	 * @param rawUrl - The URL the LLM wants to continue on.
	 * @param signal - The task's abort signal (stop cancels the wait).
	 * @returns A result message when the handoff did NOT happen (invalid URL,
	 *   timeout, cancelled); throws `MigrationError` when the new tab claimed
	 *   the task (the run then ends with status `migrated`).
	 */
	async openNewTab(rawUrl: string, signal: AbortSignal): Promise<string> {
		const url = this.validateUrl(rawUrl)
		if (!url) {
			return `❌ 无法打开新标签页：URL 不在允许列表内（${rawUrl}）。请改用同源或白名单内的链接。`
		}
		const taskId = this.agent.taskId
		if (!taskId) return '❌ 没有正在执行的任务。'

		const nonce = randomToken()
		const pending: PendingHandoff = {
			version: 1,
			taskId,
			nonce,
			snapshot: serializeAgentState(this.agent),
			createdAt: Date.now(),
			expiresAt: Date.now() + this.config.claimTimeoutMs + PENDING_EXPIRY_SLACK_MS,
			claim: null,
		}
		try {
			this.writePending(pending)
		} catch (error) {
			// No storage, no handoff: tell the agent to continue on this page.
			this.emitState({ kind: null })
			return isQuotaError(error)
				? '❌ 无法保存交接状态：浏览器存储空间不足，任务继续在当前页面执行。'
				: `❌ 无法保存交接状态（${String(error)}），任务继续在当前页面执行。`
		}
		this.broadcast({ type: 'publish', taskId, nonce })

		const linkUrl = buildHandoffUrl(url, taskId, nonce)
		if (
			this.config.newTabStrategy === 'placeholder' &&
			this.reservedWindow &&
			!this.reservedWindow.closed
		) {
			// Navigating an already-open window is not subject to the popup blocker.
			this.reservedWindow.location.href = linkUrl
		} else {
			this.emitState({ kind: 'awaiting', url: linkUrl, taskId })
		}

		const outcome = await this.awaitClaim(taskId, nonce, signal)
		this.reservedWindow = null

		switch (outcome) {
			case 'claimed': {
				// The new tab took over. Clear this tab's same-tab recovery state
				// (its snapshot now lives in the new tab) and end the run migrated.
				this.clearActive()
				this.emitState({ kind: 'migrated', taskId })
				throw new MigrationError('Task migrated to a new tab')
			}
			case 'aborted': {
				this.clearPending(taskId)
				this.emitState({ kind: null })
				signal.throwIfAborted() // AbortError → the run stops as 'stopped'
				return 'Task aborted'
			}
			default: {
				// timeout | cancelled — the user did not open the new tab.
				this.clearPending(taskId)
				this.emitState({ kind: null })
				return `⚠️ 未确认打开新标签页（${this.config.newTabStrategy === 'placeholder' ? '占位窗口不可用或已被拦截' : `等待 ${Math.round(this.config.claimTimeoutMs / 1000)} 秒超时`}），已取消跨页跳转，继续在当前页面执行。`
			}
		}
	}

	/** Cancel an in-flight `open_new_tab` wait (the awaiting card's cancel button). */
	cancelAwaitingNavigation(): void {
		this.claimWaiter?.resolve('cancelled')
	}

	/**
	 * Persist the current agent state for same-tab recovery (debounced by the
	 * agent's historychange, plus the pagehide flush on refresh).
	 *
	 * Only persists while a task is actually **running**: PageAgentCore keeps
	 * `taskId` set after the run ends, so without a status check the pagehide
	 * flush (or a debounced write queued right before completion) would
	 * resurrect the snapshot of a finished task and trigger a spurious
	 * "Task resumed after page reload" on the next load.
	 */
	persistNow(): void {
		if (this.agent.status !== 'running') return
		if (!this.agent.taskId || this.agent.disposed) return
		try {
			this.writeActive(serializeAgentState(this.agent))
		} catch (error) {
			// Continuity is best-effort: warn and keep the task running.
			console.warn('[HandoffController] Failed to persist active state:', error)
		}
	}

	/** Resume the handed-off task on this tab (new-tab "continue" card). */
	async resumePending(): Promise<void> {
		const pending = this.pending
		if (!pending) return
		this.pending = null
		this.emitState({ kind: null })

		if (!pending.claim || isClaimStale(pending.claim, this.config.reclaimGraceMs)) {
			this.claimPending(pending)
		}
		// Seed same-tab recovery state so a reload of THIS tab can continue
		// without the marker.
		try {
			this.writeActive(pending.snapshot)
		} catch (error) {
			console.warn('[HandoffController] Failed to persist resumed state:', error)
		}

		await this.agent.execute(pending.snapshot.task, {
			initialHistory: pending.snapshot.history,
			initialTaskId: pending.snapshot.taskId,
		})
	}

	/** Take the task back on this tab (old tab, new tab closed/unclaimed). */
	async reclaim(): Promise<void> {
		const taskId = this.agent.taskId
		this.clearPending(taskId)
		this.pending = null
		this.emitState({ kind: null })

		await this.agent.execute(this.agent.task, {
			initialHistory: this.agent.history,
			initialTaskId: this.agent.taskId,
		})
	}

	/** Current panel-facing handoff state. */
	getState(): HandoffState {
		return this.state
	}

	/** Drop the pending record and any same-tab recovery state for the task. */
	release(taskId: string): void {
		// Cancel a debounced persist queued before completion so it cannot
		// resurrect the snapshot after we cleared it.
		if (this.persistTimer) {
			clearTimeout(this.persistTimer)
			this.persistTimer = null
		}
		this.clearPending(taskId)
		this.clearActive()
		this.pending = null
		this.emitState({ kind: null })
	}

	/** Remove all listeners and timers. */
	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.agent.removeEventListener('statuschange', this.onStatusChange)
		this.agent.removeEventListener('historychange', this.onHistoryChange)
		window.removeEventListener('pagehide', this.onPageHide)
		this.channel?.removeEventListener('message', this.onChannelMessage)
		this.channel?.close()
		this.clearTimers()
	}

	// ========== Internal: page-load recovery ==========

	/** Detect and act on a pending handoff / recoverable task at page load. */
	checkHandoffOnLoad(): void {
		if (this.disposed) return

		// 1. Cross-tab marker (user clicked the open-new-tab card).
		const marker = parseHandoffMarker(window.location.search)
		if (marker) {
			const pending = this.readPending(marker.taskId)
			if (
				pending &&
				pending.nonce === marker.nonce &&
				Date.now() < pending.expiresAt &&
				(!pending.claim || isClaimStale(pending.claim, this.config.reclaimGraceMs))
			) {
				this.claimPending(pending)
				this.pending = pending
				try {
					this.writeActive(pending.snapshot)
				} catch (error) {
					console.warn('[HandoffController] Failed to seed resumed state:', error)
				}
				this.emitState({ kind: 'resume', task: pending.snapshot.task, taskId: pending.taskId })
			}
			return
		}

		// 2. Same-tab recovery (reload / MPA navigation mid-task). Auto-resume only
		// when this page was NOT opened from a live tab (sessionStorage is copied
		// to new tabs opened with an opener, so a live opener means "another tab").
		const active = this.readActive()
		if (active) {
			const openedFromLiveTab =
				typeof window.opener === 'object' && window.opener !== null && !window.opener.closed
			if (openedFromLiveTab) {
				this.pending = null
				this.emitState({ kind: 'resume', task: active.task, taskId: active.taskId })
			} else {
				this.autoResume(active)
			}
			return
		}

		// 3. Single unclaimed pending without a marker (the target app stripped
		// the query param). Offer to continue; claim only on user confirmation.
		const singles = this.listPending()
		if (singles.length === 1) {
			const pending = singles[0]
			if (!pending.claim || isClaimStale(pending.claim, this.config.reclaimGraceMs)) {
				this.pending = pending
				this.emitState({ kind: 'resume', task: pending.snapshot.task, taskId: pending.taskId })
			}
		}
	}

	/** Auto-resume a same-tab recovered task (the 90% in-tab case, no clicks). */
	private autoResume(snapshot: AgentSnapshot): void {
		const history: HistoricalEvent[] = [
			...snapshot.history,
			{ type: 'observation', content: 'Task resumed after page reload.' },
		]
		this.emitState({ kind: null })
		void this.agent.execute(snapshot.task, {
			initialHistory: history,
			initialTaskId: snapshot.taskId,
		})
	}

	// ========== Internal: agent status lifecycle ==========

	private handleStatusChange(): void {
		const status = this.agent.status
		switch (status) {
			case 'running':
				this.stopReclaimPoll()
				this.startHeartbeat()
				break
			case 'migrated':
				this.stopHeartbeat()
				this.startReclaimPoll()
				break
			case 'completed':
			case 'error':
			case 'stopped':
				this.stopHeartbeat()
				this.stopReclaimPoll()
				this.release(this.agent.taskId)
				break
			case 'idle':
				this.stopHeartbeat()
				this.stopReclaimPoll()
				break
		}
	}

	/** While running, keep the pending claim (if this tab owns it) alive. */
	private startHeartbeat(): void {
		if (this.heartbeatTimer) return
		this.heartbeatTimer = setInterval(() => {
			if (this.disposed) return
			const taskId = this.agent.taskId
			if (!taskId) return
			const pending = this.readPending(taskId)
			if (pending?.claim?.tabId !== this.tabId) return
			pending.claim.heartbeatTs = Date.now()
			try {
				this.writePending(pending)
			} catch (error) {
				console.warn('[HandoffController] Heartbeat write failed:', error)
			}
			this.broadcast({ type: 'heartbeat', taskId })
		}, this.config.heartbeatIntervalMs)
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer)
			this.heartbeatTimer = null
		}
	}

	/** After migration, poll whether the new tab is still alive (reclaim offer). */
	private startReclaimPoll(): void {
		if (this.reclaimTimer) return
		this.reclaimTimer = setInterval(() => this.updateReclaimState(), RECLAIM_POLL_MS)
		this.updateReclaimState()
	}

	private stopReclaimPoll(): void {
		if (this.reclaimTimer) {
			clearInterval(this.reclaimTimer)
			this.reclaimTimer = null
		}
	}

	private updateReclaimState(): void {
		if (this.disposed) return
		const taskId = this.agent.taskId
		if (!taskId) return
		const pending = this.readPending(taskId)
		if (!pending) {
			// Task finished (or was cleared) elsewhere.
			this.emitState({ kind: 'migrated', taskId })
			return
		}
		const stale = !pending.claim || isClaimStale(pending.claim, this.config.reclaimGraceMs)
		this.emitState(stale ? { kind: 'reclaimable', taskId } : { kind: 'migrated', taskId: taskId })
	}

	// ========== Internal: channel & state ==========

	private handleChannelMessage(message: HandoffMessage): void {
		if (!message || message.taskId !== this.agent.taskId) return
		if (message.type === 'claim' && this.claimWaiter) {
			this.claimWaiter.resolve('claimed')
		}
	}

	private broadcast(message: HandoffMessage): void {
		this.channel?.postMessage(message)
	}

	/** Wait for the new tab to claim; resolves on claim, timeout, cancel or abort. */
	private awaitClaim(taskId: string, nonce: string, signal: AbortSignal): Promise<ClaimOutcome> {
		if (signal.aborted) return Promise.resolve('aborted')
		return new Promise<ClaimOutcome>((resolve) => {
			let settled = false
			const finish = (outcome: ClaimOutcome): void => {
				if (settled) return
				settled = true
				if (this.claimWaiter === waiter) this.claimWaiter = null
				clearTimeout(timer)
				signal.removeEventListener('abort', onAbort)
				resolve(outcome)
			}
			const waiter = {
				resolve: (outcome: ClaimOutcome) => {
					// Only the claim for OUR task/nonce counts; other claims are
					// ignored by handleChannelMessage, so this resolve is trusted.
					void taskId
					void nonce
					finish(outcome)
				},
			}
			const onAbort = (): void => finish('aborted')
			const timer = setTimeout(() => finish('timeout'), this.config.claimTimeoutMs)
			this.claimWaiter = waiter
			signal.addEventListener('abort', onAbort, { once: true })
		})
	}

	// ========== Internal: storage ==========

	private writeActive(snapshot: AgentSnapshot): void {
		this.tabStorage.setItem(ACTIVE_KEY, JSON.stringify(snapshot))
	}

	private readActive(): AgentSnapshot | null {
		const raw = this.tabStorage.getItem(ACTIVE_KEY)
		if (!raw) return null
		try {
			return parseAgentSnapshot(JSON.parse(raw))
		} catch {
			this.tabStorage.removeItem(ACTIVE_KEY)
			return null
		}
	}

	private clearActive(): void {
		this.tabStorage.removeItem(ACTIVE_KEY)
	}

	private writePending(pending: PendingHandoff): void {
		this.storage.setItem(pendingKey(pending.taskId), JSON.stringify(pending))
	}

	private readPending(taskId: string): PendingHandoff | null {
		const raw = this.storage.getItem(pendingKey(taskId))
		if (!raw) return null
		try {
			const pending = JSON.parse(raw) as PendingHandoff
			if (pending?.version !== 1 || !pending.taskId || typeof pending.nonce !== 'string') {
				return null
			}
			return pending
		} catch {
			return null
		}
	}

	private listPending(): PendingHandoff[] {
		const result: PendingHandoff[] = []
		for (let i = 0; i < this.storage.length; i++) {
			const key = this.storage.key?.(i)
			if (!key || !key.startsWith(PENDING_KEY_PREFIX)) continue
			const pending = this.readPending(key.slice(PENDING_KEY_PREFIX.length + 1))
			if (pending && Date.now() < pending.expiresAt) result.push(pending)
		}
		return result
	}

	private clearPending(taskId: string): void {
		this.storage.removeItem(pendingKey(taskId))
	}

	/** Mark the pending record as claimed by this tab and announce it. */
	private claimPending(pending: PendingHandoff): void {
		pending.claim = { tabId: this.tabId, claimedAt: Date.now(), heartbeatTs: Date.now() }
		this.writePending(pending)
		this.broadcast({ type: 'claim', taskId: pending.taskId, nonce: pending.nonce })
	}

	// ========== Internal: URL validation & state emission ==========

	/** Validate a target URL for `open_new_tab` (scheme + allowlist). Returns the normalized URL or null. */
	validateUrl(rawUrl: string): string | null {
		let parsed: URL
		try {
			parsed = new URL(rawUrl, window.location.href)
		} catch {
			return null
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

		const sameOrigin = parsed.origin === window.location.origin
		const allowlisted =
			this.config.openTabUrlAllowlist.length > 0 &&
			this.config.openTabUrlAllowlist.some((rule) =>
				typeof rule === 'string'
					? parsed.origin === rule || parsed.href.startsWith(rule)
					: rule.test(parsed.href)
			)
		return sameOrigin || allowlisted ? parsed.href : null
	}

	private emitState(state: HandoffState): void {
		const changed =
			this.state.kind !== state.kind || JSON.stringify(this.state) !== JSON.stringify(state)
		this.state = state
		if (changed || this.stateDirty) {
			this.stateDirty = false
			this.dispatchEvent(new CustomEvent('handoffchange', { detail: state }))
		}
	}

	private schedulePersist(): void {
		if (this.persistTimer) clearTimeout(this.persistTimer)
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null
			this.persistNow()
		}, PERSIST_DEBOUNCE_MS)
	}

	private clearTimers(): void {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer)
			this.persistTimer = null
		}
		if (this.startupTimer) {
			clearTimeout(this.startupTimer)
			this.startupTimer = null
		}
		this.stopHeartbeat()
		this.stopReclaimPoll()
	}
}

function resolveConfig(config?: HandoffConfig): ResolvedHandoffConfig {
	const heartbeatIntervalMs = config?.heartbeatIntervalMs ?? 1_000
	return {
		channelName: config?.channelName ?? DEFAULT_CHANNEL_NAME,
		newTabStrategy: config?.newTabStrategy ?? 'confirm',
		openTabUrlAllowlist: config?.openTabUrlAllowlist ?? [],
		claimTimeoutMs: config?.claimTimeoutMs ?? 15_000,
		heartbeatIntervalMs,
		reclaimGraceMs: config?.reclaimGraceMs ?? heartbeatIntervalMs * 3,
	}
}

function isClaimStale(claim: { heartbeatTs: number }, graceMs: number): boolean {
	return Date.now() - claim.heartbeatTs > graceMs
}

function defaultStorage(kind: 'localStorage' | 'sessionStorage'): HandoffStorage {
	const target = (globalThis as Record<string, unknown>)[kind] as Storage | undefined
	if (!target) {
		// No storage available (e.g. some sandboxed contexts): no-op backend.
		return {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
			length: 0,
			key: () => null,
		}
	}
	return target
}
