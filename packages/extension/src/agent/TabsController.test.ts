import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TabsController } from './TabsController'

describe('TabsController.waitUntilTabLoaded', () => {
	interface TabRow {
		id: number
		isInitial: boolean
		status?: 'loading' | 'unloaded' | 'complete'
	}

	// White-box helper: build a controller with a known tab list and a stubbed `syncTabs`
	// (the only chrome-backed dependency the wait touches), so tab-status transitions can be
	// driven deterministically without the background service worker.
	function makeController(
		tabs: TabRow[],
		onSync: () => void = () => {}
	): { controller: TabsController; syncCount: () => number } {
		const controller = new TabsController()
		;(controller as unknown as { tabs: TabRow[] }).tabs = tabs
		let syncs = 0
		;(controller as unknown as { syncTabs: () => Promise<void> }).syncTabs = async () => {
			syncs += 1
			onSync()
		}
		return { controller, syncCount: () => syncs }
	}

	it('throws for an unknown tab id', async () => {
		const { controller } = makeController([{ id: 1, isInitial: false, status: 'complete' }])
		await expect(controller.waitUntilTabLoaded(999)).rejects.toThrow('not found')
	})

	it('resolves once a loading tab transitions to complete during the wait', async () => {
		const tabs: TabRow[] = [{ id: 1, isInitial: false, status: 'loading' }]
		const { controller, syncCount } = makeController(tabs, () => {
			// The background reports the tab finished loading after a couple of polls.
			if (syncCount() >= 2) tabs[0].status = 'complete'
		})

		await expect(controller.waitUntilTabLoaded(1)).resolves.toBeUndefined()
		expect(syncCount()).toBeGreaterThanOrEqual(2)
	})

	it('throws when the tab ends up unloaded', async () => {
		const tabs: TabRow[] = [{ id: 1, isInitial: false, status: 'loading' }]
		const { controller } = makeController(tabs, () => {
			tabs[0].status = 'unloaded'
		})

		await expect(controller.waitUntilTabLoaded(1)).rejects.toThrow('unloaded')
	})

	it('rejects with an AbortError when aborted while the tab is still loading', async () => {
		// syncTabs never leaves the tab in `loading`, so only the signal can end the wait.
		const tabs: TabRow[] = [{ id: 1, isInitial: false, status: 'loading' }]
		const { controller } = makeController(tabs)
		const ac = new AbortController()

		const promise = controller.waitUntilTabLoaded(1, { signal: ac.signal })
		setTimeout(() => ac.abort(), 20)

		await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
	})

	it('rejects immediately without polling when the signal is already aborted', async () => {
		const tabs: TabRow[] = [{ id: 1, isInitial: false, status: 'loading' }]
		const { controller, syncCount } = makeController(tabs)
		const ac = new AbortController()
		ac.abort()

		await expect(controller.waitUntilTabLoaded(1, { signal: ac.signal })).rejects.toMatchObject({
			name: 'AbortError',
		})
		// The already-aborted signal must short-circuit before the wait polls (no syncTabs).
		expect(syncCount()).toBe(0)
	})
})

describe('TabsController.waitUntilTabLoaded SPA readiness', () => {
	interface ReadinessTab {
		id: number
		isInitial: boolean
		status?: 'loading' | 'unloaded' | 'complete'
		url?: string
	}

	const chromeMock = {
		runtime: {
			sendMessage: vi.fn(),
		},
	}

	beforeEach(() => {
		chromeMock.runtime.sendMessage.mockReset()
		vi.stubGlobal('chrome', chromeMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	// White-box helper: the tab is loading, syncTabs immediately flips it to
	// complete (so the status wait resolves fast), and the readiness probe is
	// answered by the mocked chrome.runtime.sendMessage.
	function makeController(tabs: ReadinessTab[], reportReady: () => boolean) {
		const controller = new TabsController()
		;(controller as unknown as { tabs: ReadinessTab[] }).tabs = tabs
		;(controller as unknown as { syncTabs: () => Promise<void> }).syncTabs = async () => {
			tabs[0].status = 'complete'
		}
		chromeMock.runtime.sendMessage.mockImplementation(async () => ({ ready: reportReady() }))
		return controller
	}

	it('waits until the content script reports interactive elements', async () => {
		let ready = false
		let polls = 0
		const tabs: ReadinessTab[] = [
			{ id: 1, isInitial: true, status: 'loading', url: 'https://example.test' },
		]
		const controller = makeController(tabs, () => {
			polls += 1
			if (polls >= 3) ready = true
			return ready
		})

		await expect(controller.waitUntilTabLoaded(1)).resolves.toBeUndefined()
		expect(polls).toBeGreaterThanOrEqual(3)
		// The readiness probe must have been routed to the tab's content script.
		expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'PAGE_CONTROL', action: 'get_page_readiness' })
		)
	})

	it('skips the readiness wait on pages that cannot run content scripts', async () => {
		const tabs: ReadinessTab[] = [
			{ id: 1, isInitial: true, status: 'loading', url: 'chrome://settings' },
		]
		const controller = makeController(tabs, () => false)

		await expect(controller.waitUntilTabLoaded(1)).resolves.toBeUndefined()
		expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalled()
	})

	it('proceeds (does not throw) when the page never reports readiness', async () => {
		const tabs: ReadinessTab[] = [
			{ id: 1, isInitial: true, status: 'loading', url: 'https://example.test' },
		]
		const controller = makeController(tabs, () => false)

		await expect(
			controller.waitUntilTabLoaded(1, { readinessTimeoutMs: 50 })
		).resolves.toBeUndefined()
	})
})
