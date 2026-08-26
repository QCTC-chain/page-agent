// @vitest-environment happy-dom
import type { ExecutionResult, HistoricalEvent } from '@page-agent/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	type HandoffAgentLike,
	type HandoffChannel,
	HandoffController,
	type HandoffMessage,
	type HandoffState,
	type HandoffStorage,
	type PendingHandoff,
	buildHandoffUrl,
	parseHandoffMarker,
} from './index'

// ---------- Test doubles ----------

/** In-memory Storage with the full `HandoffStorage` surface. */
function memoryStorage(): HandoffStorage & { dump: () => Map<string, string> } {
	const map = new Map<string, string>()
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => {
			map.set(key, value)
		},
		removeItem: (key) => {
			map.delete(key)
		},
		get length() {
			return map.size
		},
		key: (index) => Array.from(map.keys())[index] ?? null,
		dump: () => new Map(map),
	}
}

/** Cross-tab message bus shared by several channel adapters. */
function memoryBus(): {
	channel: () => HandoffChannel
	emit: (message: HandoffMessage) => void
} {
	const handlers = new Set<(event: { data: HandoffMessage }) => void>()
	return {
		channel: () => ({
			postMessage: (message) => handlers.forEach((handler) => handler({ data: message })),
			addEventListener: (_type, handler) => handlers.add(handler),
			removeEventListener: (_type, handler) => handlers.delete(handler),
			close: () => {},
		}),
		emit: (message) => handlers.forEach((handler) => handler({ data: message })),
	}
}

/** Minimal agent implementing the controller's dependency surface. */
class FakeAgent extends EventTarget implements HandoffAgentLike {
	task = ''
	taskId = ''
	history: HistoricalEvent[] = []
	status: 'idle' | 'running' | 'completed' | 'error' | 'stopped' | 'migrated' = 'idle'
	disposed = false
	executeCalls: { task: string; options?: unknown }[] = []

	async execute(
		task: string,
		options?: { initialHistory?: HistoricalEvent[]; initialTaskId?: string }
	): Promise<ExecutionResult> {
		this.executeCalls.push({ task, options })
		this.task = task
		this.taskId = options?.initialTaskId ?? `id-${this.executeCalls.length}`
		this.history = options?.initialHistory ?? []
		this.setStatus('running')
		this.setStatus('completed')
		return { success: true, data: 'done', history: this.history }
	}

	setStatus(status: FakeAgent['status']): void {
		this.status = status
		this.dispatchEvent(new Event('statuschange'))
	}
}

/** A pair of tabs sharing one "localStorage" map and one message bus. */
interface TabPair {
	oldAgent: FakeAgent
	newAgent: FakeAgent
	oldController: HandoffController
	newController: HandoffController
	shared: ReturnType<typeof memoryStorage>
}

function createTabs(
	config: Parameters<HandoffController['openNewTab']> extends never
		? never
		: Record<string, unknown> = {},
	newTabConfig: Record<string, unknown> = {}
): TabPair {
	const shared = memoryStorage()
	const bus = memoryBus()
	const oldAgent = new FakeAgent()
	const newAgent = new FakeAgent()
	const oldController = new HandoffController({
		agent: oldAgent,
		config: { ...config },
		storage: shared,
		sessionStorage: memoryStorage(),
		channel: bus.channel(),
	})
	const newController = new HandoffController({
		agent: newAgent,
		config: { ...newTabConfig },
		storage: shared,
		sessionStorage: memoryStorage(),
		channel: bus.channel(),
	})
	oldController.start()
	newController.start()
	return { oldAgent, newAgent, oldController, newController, shared }
}

function setLocation(url: string): void {
	window.history.replaceState({}, '', url)
}

function listenState(controller: HandoffController): HandoffState[] {
	const states: HandoffState[] = []
	controller.addEventListener('handoffchange', (event) => {
		states.push((event as CustomEvent<HandoffState>).detail)
	})
	return states
}

function makePending(taskId: string, overrides: Partial<PendingHandoff> = {}): PendingHandoff {
	return {
		version: 1,
		taskId,
		nonce: 'nonce-1',
		snapshot: {
			version: 1,
			task: 'original task',
			taskId,
			history: [],
			createdAt: Date.now() - 1_000,
		},
		createdAt: Date.now() - 1_000,
		expiresAt: Date.now() + 60_000,
		claim: null,
		...overrides,
	}
}

const ORIGIN_URL = `${window.location.origin}/app`
const OTHER_ORIGIN_URL = 'https://other.invalid/x'

// ---------- URL helpers ----------

describe('buildHandoffUrl / parseHandoffMarker', () => {
	it('appends and parses the marker round-trip', () => {
		const url = buildHandoffUrl(`${ORIGIN_URL}/orders`, 'task-1', 'nonce-abc')

		expect(parseHandoffMarker(new URL(url).search)).toEqual({
			taskId: 'task-1',
			nonce: 'nonce-abc',
		})
	})

	it('keeps existing query params', () => {
		const url = buildHandoffUrl(`${ORIGIN_URL}?tab=open`, 't', 'n')
		const parsed = new URL(url)
		expect(parsed.searchParams.get('tab')).toBe('open')
		expect(parseHandoffMarker(parsed.search)).toEqual({ taskId: 't', nonce: 'n' })
	})

	it('returns null for missing or malformed markers', () => {
		expect(parseHandoffMarker('')).toBeNull()
		expect(parseHandoffMarker('?pa_handoff=only-task')).toBeNull()
		expect(parseHandoffMarker('?other=1')).toBeNull()
	})
})

// ---------- URL validation ----------

describe('validateUrl', () => {
	it('allows same-origin http(s) URLs by default', () => {
		setLocation(ORIGIN_URL)
		const { oldController } = createTabs()
		expect(oldController.validateUrl(`${ORIGIN_URL}/orders`)).toBe(`${ORIGIN_URL}/orders`)
	})

	it('blocks cross-origin URLs by default', () => {
		setLocation(ORIGIN_URL)
		const { oldController } = createTabs()
		expect(oldController.validateUrl(OTHER_ORIGIN_URL)).toBeNull()
	})

	it('blocks non-http(s) schemes', () => {
		setLocation(ORIGIN_URL)
		const { oldController } = createTabs()
		expect(oldController.validateUrl('javascript:alert(1)')).toBeNull()
		expect(oldController.validateUrl('file:///etc/passwd')).toBeNull()
	})

	it('allows allowlisted cross-origin hosts and rejects others', () => {
		setLocation(ORIGIN_URL)
		const { oldController } = createTabs({ openTabUrlAllowlist: ['https://other.invalid'] })
		expect(oldController.validateUrl(OTHER_ORIGIN_URL)).toBe(OTHER_ORIGIN_URL)
		expect(oldController.validateUrl('https://third.invalid/x')).toBeNull()
	})

	it('supports RegExp allowlist rules', () => {
		setLocation(ORIGIN_URL)
		const { oldController } = createTabs({ openTabUrlAllowlist: [/^https:\/\/.*\.allow\.test\//] })
		expect(oldController.validateUrl('https://a.allow.test/x')).toBe('https://a.allow.test/x')
		expect(oldController.validateUrl('https://nope.test/x')).toBeNull()
	})
})

// ---------- open_new_tab (old tab side) ----------

describe('openNewTab', () => {
	it('returns an error message for invalid URLs and writes nothing', async () => {
		setLocation(ORIGIN_URL)
		const { oldAgent, oldController, shared } = createTabs()
		oldAgent.taskId = 'task-1'

		const result = await oldController.openNewTab(OTHER_ORIGIN_URL, new AbortController().signal)

		expect(result).toContain('不在允许列表')
		expect(Array.from(shared.dump().keys()).length).toBe(0)
	})

	it('publishes a pending record and emits the awaiting state', async () => {
		setLocation(ORIGIN_URL)
		const { oldAgent, oldController, shared } = createTabs({ claimTimeoutMs: 10_000 })
		oldAgent.taskId = 'task-1'
		oldAgent.history = [{ type: 'observation', content: 'step 1' }]
		const awaiting = waitForState(oldController, 'awaiting')

		const waiting = oldController.openNewTab(ORIGIN_URL, new AbortController().signal)

		const awaitingState = await awaiting
		expect(awaitingState).toMatchObject({ kind: 'awaiting', taskId: 'task-1' })
		const link = (awaitingState as { url: string }).url
		expect(parseHandoffMarker(new URL(link).search)).toMatchObject({ taskId: 'task-1' })

		const pendingKeys = Array.from(shared.dump().keys()).filter((k) => k.includes('pending'))
		expect(pendingKeys).toHaveLength(1)
		// The pending snapshot strips raw fields (empty history here) and carries the task.
		const pending = JSON.parse(shared.getItem(pendingKeys[0])!) as PendingHandoff
		expect(pending.snapshot.taskId).toBe('task-1')

		oldController.cancelAwaitingNavigation()
		expect(await waiting).toContain('已取消跨页跳转')
	})

	it('throws MigrationError when the new tab claims', async () => {
		setLocation(ORIGIN_URL)
		const { oldAgent, oldController, newController, newAgent } = createTabs()
		oldAgent.taskId = 'task-1'
		const states = listenState(oldController)
		const awaiting = waitForState(oldController, 'awaiting')

		const waiting = oldController.openNewTab(ORIGIN_URL, new AbortController().signal)
		const awaitingState = await awaiting

		// Simulate the new tab loading the marked URL and claiming.
		setLocation((awaitingState as { url: string }).url)
		newController.checkHandoffOnLoad()

		await expect(waiting).rejects.toMatchObject({
			name: 'MigrationError',
			message: 'Task migrated to a new tab',
		})
		expect(newAgent.status).toBe('idle') // claim ≠ resume; the new tab waits for user confirmation
		expect(states.at(-1)).toMatchObject({ kind: 'migrated', taskId: 'task-1' })
	})

	it('returns a warning and clears the pending record on claim timeout', async () => {
		setLocation(ORIGIN_URL)
		const { oldAgent, oldController, shared } = createTabs({ claimTimeoutMs: 50 })
		oldAgent.taskId = 'task-1'

		const result = await oldController.openNewTab(ORIGIN_URL, new AbortController().signal)

		expect(result).toContain('已取消跨页跳转')
		expect(Array.from(shared.dump().keys()).length).toBe(0)
	})

	it('throws AbortError when the task is stopped while waiting', async () => {
		setLocation(ORIGIN_URL)
		const { oldAgent, oldController } = createTabs({ claimTimeoutMs: 10_000 })
		oldAgent.taskId = 'task-1'
		const controller = new AbortController()
		const awaiting = waitForState(oldController, 'awaiting')

		const waiting = oldController.openNewTab(ORIGIN_URL, controller.signal)
		await awaiting
		controller.abort()

		await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
	})

	it('returns a message and clears pending when the awaiting card is cancelled', async () => {
		setLocation(ORIGIN_URL)
		const { oldAgent, oldController, shared } = createTabs({ claimTimeoutMs: 10_000 })
		oldAgent.taskId = 'task-1'
		const awaiting = waitForState(oldController, 'awaiting')

		const waiting = oldController.openNewTab(ORIGIN_URL, new AbortController().signal)
		await awaiting
		oldController.cancelAwaitingNavigation()

		const result = await waiting
		expect(result).toContain('已取消跨页跳转')
		expect(Array.from(shared.dump().keys()).length).toBe(0)
	})
})

// ---------- Page-load recovery (new tab side) ----------

describe('checkHandoffOnLoad', () => {
	it('claims a marked pending record and offers to resume', async () => {
		setLocation(ORIGIN_URL)
		const { oldAgent, oldController, newController, newAgent, shared } = createTabs()
		oldAgent.task = 'original task'
		oldAgent.taskId = 'task-1'
		const states = listenState(newController)
		const awaiting = waitForState(oldController, 'awaiting')

		const waiting = oldController.openNewTab(ORIGIN_URL, new AbortController().signal)
		const awaitingState = await awaiting
		setLocation((awaitingState as { url: string }).url)
		newController.checkHandoffOnLoad()

		expect(states.at(-1)).toMatchObject({ kind: 'resume', taskId: 'task-1' })
		expect(newAgent.executeCalls).toHaveLength(0) // confirm-first, no auto-run
		const pending = shared.getItem('page-agent:handoff:pending:task-1')
		expect(pending).toBeTruthy()
		expect((JSON.parse(pending!) as PendingHandoff).claim).not.toBeNull()

		// The old tab migrates once the new tab claims.
		await expect(waiting).rejects.toMatchObject({ name: 'MigrationError' })
	})

	it('auto-resumes a same-tab reload (active snapshot, no live opener)', async () => {
		setLocation(ORIGIN_URL)
		const { oldAgent, oldController, newAgent, newController } = createTabs()
		oldAgent.task = 'original task'
		oldAgent.taskId = 'task-1'
		oldAgent.history = [{ type: 'observation', content: 'halfway' }]
		// A running task persists its snapshot; completed tasks must not.
		oldAgent.setStatus('running')
		oldController.persistNow()

		// Simulate the old page unloading: disposing the old controller cancels
		// its pending startup recovery check (which would otherwise compete for
		// the shared session snapshot).
		oldController.dispose()

		// Same-tab reload shares sessionStorage; the new controller must see it.
		const sharedSession = (oldController as unknown as { tabStorage: HandoffStorage }).tabStorage
		const reloadController = new HandoffController({
			agent: newAgent,
			config: {},
			storage: (newController as unknown as { storage: HandoffStorage }).storage,
			sessionStorage: sharedSession,
			channel: (newController as unknown as { channel: HandoffChannel }).channel,
		})
		reloadController.start()

		await vi.waitFor(() => expect(newAgent.executeCalls).toHaveLength(1))
		expect(newAgent.executeCalls[0]).toMatchObject({
			task: 'original task',
			options: { initialTaskId: 'task-1' },
		})
		// History is seeded plus a "resumed" observation.
		expect(
			(newAgent.executeCalls[0].options as { initialHistory: unknown[] }).initialHistory
		).toHaveLength(2)
	})
	it('shows a resume card instead of auto-resuming when opened from a live tab', async () => {
		setLocation(ORIGIN_URL)
		const { oldAgent, oldController, newAgent, newController } = createTabs()
		oldAgent.taskId = 'task-1'
		oldAgent.setStatus('running')
		oldController.persistNow()

		// New tab got a sessionStorage copy (opener is still alive).
		const sharedSession = (oldController as unknown as { tabStorage: HandoffStorage }).tabStorage
		const copiedController = new HandoffController({
			agent: newAgent,
			config: {},
			storage: (newController as unknown as { storage: HandoffStorage }).storage,
			sessionStorage: sharedSession,
			channel: (newController as unknown as { channel: HandoffChannel }).channel,
		})
		copiedController.start()

		const originalOpener = window.opener
		Object.defineProperty(window, 'opener', { value: { closed: false }, configurable: true })
		try {
			const states = listenState(copiedController)
			copiedController.checkHandoffOnLoad()
			expect(states.at(-1)).toMatchObject({ kind: 'resume' })
			expect(newAgent.executeCalls).toHaveLength(0)
		} finally {
			Object.defineProperty(window, 'opener', { value: originalOpener, configurable: true })
		}
	})

	it('offers the single unclaimed pending record when the marker was stripped', () => {
		setLocation(ORIGIN_URL)
		const { newController, newAgent, shared } = createTabs()
		shared.setItem('page-agent:handoff:pending:task-9', JSON.stringify(makePending('task-9')))
		const states = listenState(newController)

		newController.checkHandoffOnLoad()

		expect(states.at(-1)).toMatchObject({ kind: 'resume', taskId: 'task-9' })
		expect(newAgent.executeCalls).toHaveLength(0)
	})
})

// ---------- Resume / reclaim ----------

describe('resumePending', () => {
	it('executes the handed-off task with the snapshot history and taskId', async () => {
		setLocation(ORIGIN_URL)
		const { oldAgent, oldController, newAgent, newController } = createTabs()
		oldAgent.task = 'original task'
		oldAgent.taskId = 'task-1'
		oldAgent.history = [{ type: 'observation', content: 'before handoff' }]
		const awaiting = waitForState(oldController, 'awaiting')

		const waiting = oldController.openNewTab(ORIGIN_URL, new AbortController().signal)
		const awaitingState = await awaiting
		setLocation((awaitingState as { url: string }).url)
		newController.checkHandoffOnLoad()

		await newController.resumePending()

		expect(newAgent.executeCalls).toHaveLength(1)
		expect(newAgent.executeCalls[0].task).toBe('original task')
		const options = newAgent.executeCalls[0].options as {
			initialHistory: unknown[]
			initialTaskId: string
		}
		expect(options.initialTaskId).toBe('task-1')
		expect(options.initialHistory).toHaveLength(1)
		// The old tab received the claim and migrated.
		await expect(waiting).rejects.toMatchObject({ name: 'MigrationError' })
	})

	it('claims on confirm when the marker path had no claim yet', async () => {
		setLocation(ORIGIN_URL)
		const { newController, newAgent, shared } = createTabs()
		shared.setItem('page-agent:handoff:pending:task-5', JSON.stringify(makePending('task-5')))
		newController.checkHandoffOnLoad()

		await newController.resumePending()

		expect(newAgent.executeCalls).toHaveLength(1)
		expect(newAgent.executeCalls[0].task).toBe('original task')
	})
})

describe('reclaim', () => {
	it('offers reclaim when the claim heartbeat goes stale, then resumes on the old tab', async () => {
		setLocation(ORIGIN_URL)
		const { oldAgent, oldController, shared } = createTabs({ reclaimGraceMs: 0 })
		oldAgent.taskId = 'task-1'
		oldAgent.history = [{ type: 'observation', content: 'before migration' }]
		shared.setItem(
			'page-agent:handoff:pending:task-1',
			JSON.stringify(
				makePending('task-1', {
					claim: {
						tabId: 'dead-tab',
						claimedAt: Date.now() - 10_000,
						heartbeatTs: Date.now() - 10_000,
					},
				})
			)
		)
		const states = listenState(oldController)

		oldAgent.setStatus('migrated') // triggers the reclaim poll

		await vi.waitFor(() => expect(states.some((s) => s.kind === 'reclaimable')).toBe(true))

		await oldController.reclaim()

		expect(oldAgent.executeCalls).toHaveLength(1)
		expect(oldAgent.executeCalls[0].options).toMatchObject({ initialTaskId: 'task-1' })
		expect(shared.getItem('page-agent:handoff:pending:task-1')).toBeNull()
	})

	it('keeps showing migrated (not reclaimable) while the claim is fresh', async () => {
		setLocation(ORIGIN_URL)
		const { oldAgent, oldController, shared } = createTabs({ reclaimGraceMs: 60_000 })
		oldAgent.taskId = 'task-1'
		shared.setItem(
			'page-agent:handoff:pending:task-1',
			JSON.stringify(
				makePending('task-1', {
					claim: { tabId: 'live-tab', claimedAt: Date.now(), heartbeatTs: Date.now() },
				})
			)
		)
		const states = listenState(oldController)

		oldAgent.setStatus('migrated')

		await vi.waitFor(() => expect(states.some((s) => s.kind !== null)).toBe(true))
		expect(states.some((s) => s.kind === 'reclaimable')).toBe(false)
		expect(states.at(-1)).toMatchObject({ kind: 'migrated' })
	})
})

// ---------- Heartbeat & release ----------

describe('lifecycle cleanup', () => {
	it('keeps the claim heartbeat alive while the agent runs', async () => {
		setLocation(ORIGIN_URL)
		const { oldAgent, oldController, newAgent, newController, shared } = createTabs(
			{},
			{ heartbeatIntervalMs: 40 }
		)
		oldAgent.taskId = 'task-1'
		const awaiting = waitForState(oldController, 'awaiting')

		const waiting = oldController.openNewTab(ORIGIN_URL, new AbortController().signal)
		const awaitingState = await awaiting
		setLocation((awaitingState as { url: string }).url)
		newController.checkHandoffOnLoad()

		// The new tab starts running → its heartbeat should update the claim.
		// (A resumed agent carries the taskId, so mirror that here.)
		newAgent.taskId = 'task-1'
		newAgent.setStatus('running')
		// Consume the old tab's migration rejection immediately to avoid an
		// unhandled-rejection warning while we wait for the heartbeat.
		const migration = waiting.catch((error) => error)
		await new Promise((resolve) => setTimeout(resolve, 120))

		const pending = JSON.parse(
			shared.getItem('page-agent:handoff:pending:task-1')!
		) as PendingHandoff
		expect(pending.claim!.heartbeatTs).toBeGreaterThan(pending.claim!.claimedAt)

		// The old tab migrates when the claim lands.
		expect(await migration).toMatchObject({ name: 'MigrationError' })
	})

	it('clears pending and active state when the task ends', () => {
		setLocation(ORIGIN_URL)
		const { newAgent, newController, shared } = createTabs()
		shared.setItem('page-agent:handoff:pending:task-3', JSON.stringify(makePending('task-3')))
		newAgent.taskId = 'task-3'
		const tabStorage = (newController as unknown as { tabStorage: HandoffStorage }).tabStorage
		tabStorage.setItem('page-agent:handoff:active', JSON.stringify(makePending('task-3').snapshot))

		newAgent.setStatus('completed')

		expect(shared.getItem('page-agent:handoff:pending:task-3')).toBeNull()
		expect(tabStorage.getItem('page-agent:handoff:active')).toBeNull()
	})

	it('does not persist a snapshot after the task ended (no spurious reload-resume)', () => {
		setLocation(ORIGIN_URL)
		const { newAgent, newController } = createTabs()
		newAgent.taskId = 'task-1'
		newAgent.history = [{ type: 'observation', content: 'finished work' }]
		const tabStorage = (newController as unknown as { tabStorage: HandoffStorage }).tabStorage

		// Task already finished: the agent keeps its taskId, but persistNow must
		// not write the snapshot (otherwise the pagehide flush on refresh would
		// resurrect it and trigger a spurious "Task resumed after page reload").
		newAgent.setStatus('completed')
		newController.persistNow()

		expect(tabStorage.getItem('page-agent:handoff:active')).toBeNull()
	})

	it('a debounced persist queued before completion cannot resurrect the snapshot', async () => {
		setLocation(ORIGIN_URL)
		const { newAgent, newController } = createTabs()
		newAgent.taskId = 'task-1'
		const tabStorage = (newController as unknown as { tabStorage: HandoffStorage }).tabStorage

		// The last step's historychange schedules a debounced persist (100ms).
		newAgent.setStatus('running')
		newAgent.dispatchEvent(new Event('historychange'))
		// The task completes before the debounce fires: release() clears the
		// snapshot and must cancel the queued write.
		newAgent.setStatus('completed')

		await new Promise((resolve) => setTimeout(resolve, 200))

		expect(tabStorage.getItem('page-agent:handoff:active')).toBeNull()
	})
})

// ---------- Helpers ----------

function waitForState(
	controller: HandoffController,
	kind: HandoffState['kind']
): Promise<HandoffState> {
	return new Promise((resolve) => {
		const onState = (event: Event) => {
			const detail = (event as CustomEvent<HandoffState>).detail
			if (detail.kind === kind) {
				controller.removeEventListener('handoffchange', onState)
				resolve(detail)
			}
		}
		controller.addEventListener('handoffchange', onState)
	})
}

/** Read the latest emitted state synchronously after a started operation. */

afterEach(() => {
	window.history.replaceState({}, '', ORIGIN_URL)
})
