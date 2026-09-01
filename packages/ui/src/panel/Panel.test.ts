// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Panel, type PanelConfig } from './Panel'
import type { PanelAgentAdapter, PanelHandoff } from './types'

import styles from './Panel.module.css'

const PANEL_ID = 'page-agent-runtime_agent-panel'
const LAUNCHER_ID = 'page-agent-runtime_agent-panel-launcher'

/** Minimal agent implementing PanelAgentAdapter for UI tests */
class FakeAgent extends EventTarget implements PanelAgentAdapter {
	status: PanelAgentAdapter['status'] = 'idle'
	lastResult: { success: boolean; data?: string } | null = null
	history: PanelAgentAdapter['history'] = []
	task = ''
	onAskUser = undefined

	/** Simulate the core clearing only its active-task history at task start. */
	execute = vi.fn(async (task: string) => {
		this.task = task
		this.history = []
		this.dispatchEvent(new Event('historychange'))
	})
	stop = vi.fn(async () => {})
	dispose = vi.fn()

	setStatus(status: PanelAgentAdapter['status']): void {
		this.status = status
		this.dispatchEvent(new Event('statuschange'))
	}
}

describe('Panel close / reopen', () => {
	const panels: Panel[] = []

	function createPanel(status: PanelAgentAdapter['status'] = 'idle'): {
		agent: FakeAgent
		panel: Panel
	} {
		const agent = new FakeAgent()
		const panel = new Panel(agent)
		panel.show()
		if (status !== 'idle') {
			agent.setStatus(status)
		}
		panels.push(panel)
		return { agent, panel }
	}

	afterEach(() => {
		panels.splice(0).forEach((panel) => panel.dispose())
		document.body.innerHTML = ''
		vi.restoreAllMocks()
	})

	it('starts with an empty history instead of a waiting placeholder', () => {
		createPanel()
		const wrapper = document.getElementById(PANEL_ID)!

		expect(wrapper.textContent).not.toContain('Waiting for task to start...')
	})

	it('hides the panel and shows a launcher instead of disposing the agent when closed while idle', () => {
		const { agent } = createPanel()
		const wrapper = document.getElementById(PANEL_ID)!
		const launcher = document.getElementById(LAUNCHER_ID)!
		const closeButton = wrapper.querySelector<HTMLButtonElement>('button[title="Close"]')!

		closeButton.click()

		expect(wrapper.style.display).toBe('none')
		expect(launcher.classList.contains(styles.hidden)).toBe(false)
		expect(agent.dispose).not.toHaveBeenCalled()
	})

	it('exposes close() to hide the panel and show the launcher without disposing the agent', () => {
		const { agent, panel } = createPanel()
		const wrapper = document.getElementById(PANEL_ID)!
		const launcher = document.getElementById(LAUNCHER_ID)!

		panel.close()

		expect(wrapper.style.display).toBe('none')
		expect(launcher.classList.contains(styles.hidden)).toBe(false)
		expect(agent.dispose).not.toHaveBeenCalled()
	})

	it('restores the panel when the launcher is clicked', () => {
		createPanel()
		const wrapper = document.getElementById(PANEL_ID)!
		const launcher = document.getElementById(LAUNCHER_ID)!
		wrapper.querySelector<HTMLButtonElement>('button[title="Close"]')!.click()
		expect(wrapper.style.display).toBe('none')

		launcher.click()

		expect(wrapper.style.display).not.toBe('none')
		expect(launcher.classList.contains(styles.hidden)).toBe(true)
	})

	it('keeps prior task cards when a new task resets the core history', async () => {
		const { agent } = createPanel()
		const wrapper = document.getElementById(PANEL_ID)!
		const input = wrapper.querySelector<HTMLInputElement>('input')!

		agent.task = 'first task'
		agent.history = [
			{
				type: 'step',
				stepIndex: 0,
				reflection: { memory: 'first task memory' },
				action: { name: 'done', input: { text: 'first result' }, output: 'first result' },
			},
		]
		agent.dispatchEvent(new Event('historychange'))

		input.value = 'second task'
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
		await vi.waitFor(() => expect(agent.execute).toHaveBeenCalledWith('second task'))

		expect(wrapper.textContent).toContain('first task')
		expect(wrapper.textContent).toContain('first result')
		expect(wrapper.textContent).toContain('second task')
	})

	it('clears the UI session history when the panel is closed', () => {
		const { agent } = createPanel()
		const wrapper = document.getElementById(PANEL_ID)!

		agent.task = 'completed task'
		agent.history = [
			{
				type: 'step',
				stepIndex: 0,
				action: { name: 'done', input: { text: 'completed result' }, output: 'completed result' },
			},
		]
		agent.dispatchEvent(new Event('historychange'))
		wrapper.querySelector<HTMLButtonElement>('button[title="Close"]')!.click()

		expect(wrapper.textContent).not.toContain('completed task')
		expect(wrapper.textContent).not.toContain('completed result')
	})

	it('resets the header to ready after closing and reopening a completed task', () => {
		createPanel()
		const wrapper = document.getElementById(PANEL_ID)!
		const launcher = document.getElementById(LAUNCHER_ID)!
		const statusText = wrapper.querySelector(`.${styles.statusText}`)!

		statusText.textContent = 'Task completed'
		wrapper.querySelector<HTMLButtonElement>('button[title="Close"]')!.click()
		launcher.click()

		expect(statusText.textContent).toBe('Ready')
	})

	it('opens the expanded conversation panel when the launcher is clicked', () => {
		createPanel()
		const wrapper = document.getElementById(PANEL_ID)!
		const launcher = document.getElementById(LAUNCHER_ID)!
		wrapper.querySelector<HTMLButtonElement>('button[title="Close"]')!.click()

		launcher.click()

		expect(wrapper.classList.contains(styles.expanded)).toBe(true)
		expect(wrapper.style.display).not.toBe('none')
		expect(launcher.classList.contains(styles.hidden)).toBe(true)
	})

	it('closes the panel while running without stopping the agent', () => {
		const { agent } = createPanel('running')
		const wrapper = document.getElementById(PANEL_ID)!
		const closeButton = wrapper.querySelector<HTMLButtonElement>('button[title="Close"]')!

		closeButton.click()

		expect(agent.stop).not.toHaveBeenCalled()
		expect(agent.dispose).not.toHaveBeenCalled()
		expect(wrapper.style.display).toBe('none')
	})

	it('uses the composer button to pause a running task', () => {
		const { agent } = createPanel('running')
		const wrapper = document.getElementById(PANEL_ID)!
		const sendButton = wrapper.querySelector<HTMLButtonElement>('button[title="Pause"]')!
		const input = wrapper.querySelector<HTMLInputElement>('input')!

		expect(input.disabled).toBe(true)
		sendButton.click()

		expect(agent.stop).toHaveBeenCalledTimes(1)
		agent.setStatus('stopped')
		expect(wrapper.querySelector<HTMLButtonElement>('button[title="发送"]')).not.toBeNull()
		expect(input.disabled).toBe(false)
	})

	it('removes the panel and the launcher when the agent is disposed externally', () => {
		const { agent } = createPanel()
		wrapperHiddenState()

		agent.dispatchEvent(new Event('dispose'))

		expect(document.getElementById(PANEL_ID)).toBeNull()
		expect(document.getElementById(LAUNCHER_ID)).toBeNull()
	})
})

describe('Panel handoff cards (multi-page)', () => {
	const panels: Panel[] = []

	function createHandoffPanel(handoff: PanelHandoff): { agent: FakeAgent; panel: Panel } {
		const agent = new FakeAgent()
		const panel = new Panel(agent)
		panel.show()
		;(agent as unknown as { handoff: PanelHandoff | undefined }).handoff = handoff
		agent.dispatchEvent(new Event('handoffchange'))
		panels.push(panel)
		return { agent, panel }
	}

	afterEach(() => {
		panels.splice(0).forEach((panel) => panel.dispose())
		document.body.innerHTML = ''
		vi.restoreAllMocks()
	})

	it('renders a clickable awaiting-navigation card with cancel', () => {
		const cancel = vi.fn()
		const { panel } = createHandoffPanel({
			kind: 'awaiting',
			url: 'https://example.test/next?pa_handoff=task-1:nonce',
			cancelAwaitingNavigation: cancel,
		})
		const wrapper = document.getElementById(PANEL_ID)!
		const link = wrapper.querySelector<HTMLAnchorElement>('a[href^="https://example.test/next"]')!
		const cancelButton = Array.from(wrapper.querySelectorAll<HTMLButtonElement>('button')).find(
			(b) => b.textContent === 'Cancel'
		)!

		expect(link).not.toBeNull()
		expect(link.target).toBe('_blank')
		cancelButton.click()
		expect(cancel).toHaveBeenCalledTimes(1)
		void panel
	})

	it('renders a resume card and triggers resume on click', () => {
		const resume = vi.fn()
		createHandoffPanel({ kind: 'resume', task: 'find the order', resume })
		const wrapper = document.getElementById(PANEL_ID)!

		const resumeButton = Array.from(wrapper.querySelectorAll<HTMLButtonElement>('button')).find(
			(b) => b.textContent === 'Continue task'
		)!

		expect(wrapper.textContent).toContain('find the order')
		resumeButton.click()
		expect(resume).toHaveBeenCalledTimes(1)
	})

	it('renders a reclaim card and triggers reclaim on click', () => {
		const reclaim = vi.fn()
		createHandoffPanel({ kind: 'reclaimable', reclaim })
		const wrapper = document.getElementById(PANEL_ID)!

		const reclaimButton = Array.from(wrapper.querySelectorAll<HTMLButtonElement>('button')).find(
			(b) => b.textContent === 'Continue here'
		)!

		reclaimButton.click()
		expect(reclaim).toHaveBeenCalledTimes(1)
	})

	it('hides the handoff section when handoff is null', () => {
		const { panel } = createHandoffPanel({ kind: null })
		const section = panel.wrapper.querySelector(`.${styles.handoffSection}`)!

		expect(section.classList.contains(styles.hidden)).toBe(true)
	})

	it('auto-opens the panel when a handoff card appears (e.g. new-tab resume)', () => {
		// The panel starts hidden (launcher state) on a freshly loaded tab; a
		// handoff card must bring it up automatically so the user sees it.
		const agent = new FakeAgent()
		const panel = new Panel(agent)
		const wrapper = document.getElementById(PANEL_ID)!
		expect(wrapper.style.display).toBe('none') // starts hidden

		;(agent as unknown as { handoff: PanelHandoff | undefined }).handoff = {
			kind: 'resume',
			task: 'find the order',
			resume: () => {},
		}
		agent.dispatchEvent(new Event('handoffchange'))

		expect(wrapper.style.display).not.toBe('none')
		expect(wrapper.classList.contains(styles.expanded)).toBe(true)
		panels.push(panel)
	})
})

describe('Panel conversation cards', () => {
	const panels: Panel[] = []

	afterEach(() => {
		panels.splice(0).forEach((panel) => panel.dispose())
		document.body.innerHTML = ''
	})

	it('groups reflection and action output into one step card', () => {
		const agent = new FakeAgent()
		const panel = new Panel(agent)
		panels.push(panel)
		agent.task = 'inspect profile'
		agent.history = [
			{
				type: 'step',
				stepIndex: 0,
				reflection: { memory: 'Open the account menu', next_goal: 'Click profile' },
				action: {
					name: 'click_element_by_index',
					input: { index: 20 },
					output: 'Clicked element [20]',
				},
			},
		]
		agent.dispatchEvent(new Event('historychange'))

		const wrapper = panel.wrapper
		expect(wrapper.querySelectorAll(`.${styles.step}`)).toHaveLength(1)
		expect(wrapper.textContent).toContain('Step #1')
		expect(wrapper.textContent).toContain('Actions')
		expect(wrapper.textContent).toContain('click_element_by_index')
		expect(wrapper.textContent).toContain('Clicked element [20]')
	})

	it('expands a truncated step row on click and keyboard activation', () => {
		const agent = new FakeAgent()
		const panel = new Panel(agent)
		panels.push(panel)
		agent.task = 'inspect profile'
		agent.history = [
			{
				type: 'step',
				stepIndex: 0,
				reflection: {
					memory:
						'当前页面已经加载完成，这是一段足够长的思考过程文本，用于验证点击后能够展开完整内容。',
				},
				action: {
					name: 'hover_element_by_index',
					input: { index: 20 },
					output: 'Hovered element [20]. Any revealed menu or popup content is now available.',
				},
			},
		]
		agent.dispatchEvent(new Event('historychange'))

		const line = panel.wrapper.querySelector<HTMLElement>(`.${styles.stepReflectionLine}`)!
		expect(line.getAttribute('aria-expanded')).toBe('false')
		line.click()
		expect(line.classList.contains(styles.expandedText)).toBe(true)
		expect(line.getAttribute('aria-expanded')).toBe('true')
		line.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
		expect(line.classList.contains(styles.expandedText)).toBe(false)
	})

	it('renders transient thinking as a bottom activity card instead of header text', () => {
		const agent = new FakeAgent()
		const panel = new Panel(agent)
		panels.push(panel)
		agent.dispatchEvent(new CustomEvent('activity', { detail: { type: 'thinking' } }))

		const wrapper = panel.wrapper
		const activity = wrapper.querySelector(`.${styles.activitySection}`)!
		expect(activity.classList.contains(styles.hidden)).toBe(false)
		expect(activity.textContent).toContain('Thinking...')
		expect(wrapper.querySelector(`.${styles.statusText}`)?.textContent).toBe('Ready')
	})

	it('renders a separate result card after a completed done action', () => {
		const agent = new FakeAgent()
		const panel = new Panel(agent)
		panels.push(panel)
		agent.task = 'inspect profile'
		agent.history = [
			{
				type: 'step',
				stepIndex: 2,
				action: {
					name: 'done',
					input: { text: '当前登录用户如下：\n- **用户名**: admin', success: true },
					output: 'Task completed',
				},
			},
		]
		agent.lastResult = { success: true, data: '当前登录用户如下：\n- **用户名**: admin' }
		agent.dispatchEvent(new Event('historychange'))
		agent.setStatus('completed')

		const result = panel.wrapper.querySelector(`.${styles.doneSuccess}`)!
		expect(result.textContent).toContain('Result: Success')
		expect(result.textContent).toContain('当前登录用户如下：')
		expect(result.querySelector(`.${styles.resultContent} strong`)?.textContent).toBe('用户名')
	})

	it('does not carry a completed result card into a reset session', () => {
		const agent = new FakeAgent()
		const panel = new Panel(agent)
		panels.push(panel)
		agent.task = 'inspect profile'
		agent.history = [
			{
				type: 'step',
				stepIndex: 0,
				action: {
					name: 'done',
					input: { text: 'finished', success: true },
					output: 'Task completed',
				},
			},
		]
		agent.lastResult = { success: true, data: 'finished' }
		agent.setStatus('completed')
		expect(panel.wrapper.querySelector(`.${styles.doneSuccess}`)).not.toBeNull()

		panel.close()
		panel.wrapper.querySelector(`.${styles.launcher}`)?.dispatchEvent(new Event('click'))
		expect(panel.wrapper.querySelector(`.${styles.doneSuccess}`)).toBeNull()
	})
})

describe('Panel launcher drag (repositionable icon)', () => {
	const LAUNCHER_STORAGE_KEY = 'page-agent:launcher-position'
	const VIEW_W = 1280
	const VIEW_H = 800
	const LAUNCHER_SIZE = 76
	const panels: Panel[] = []

	beforeEach(() => {
		window.localStorage.clear()
		Object.defineProperty(window, 'innerWidth', { value: VIEW_W, configurable: true })
		Object.defineProperty(window, 'innerHeight', { value: VIEW_H, configurable: true })
	})

	afterEach(() => {
		panels.splice(0).forEach((panel) => panel.dispose())
		document.body.innerHTML = ''
		vi.restoreAllMocks()
		window.localStorage.clear()
	})

	/** Build a panel, close it so the launcher is visible, and return the launcher. */
	function createWithLauncher(config: PanelConfig = {}): {
		agent: FakeAgent
		panel: Panel
		launcher: HTMLElement
	} {
		const agent = new FakeAgent()
		const panel = new Panel(agent, config)
		panel.close()
		const launcher = document.getElementById(LAUNCHER_ID)!
		panels.push(panel)
		return { agent, panel, launcher }
	}

	/**
	 * Mock the launcher's measured layout. getBoundingClientRect reflects the
	 * inline left/top set by the drag (happy-dom has no layout engine), so the
	 * value saved at drag end matches where the icon actually landed.
	 */
	function mockLayout(launcher: HTMLElement, left: number, top: number): void {
		vi.spyOn(launcher, 'getBoundingClientRect').mockImplementation(() => {
			const l = Number.parseFloat(launcher.style.left) || left
			const t = Number.parseFloat(launcher.style.top) || top
			return {
				left: l,
				top: t,
				right: l + LAUNCHER_SIZE,
				bottom: t + LAUNCHER_SIZE,
				width: LAUNCHER_SIZE,
				height: LAUNCHER_SIZE,
				x: l,
				y: t,
				toJSON: () => ({}),
			}
		})
	}

	/** Simulate a primary-button pointer drag across the launcher. */
	function drag(launcher: HTMLElement, from: [number, number], to: [number, number]): void {
		const opts = { pointerId: 1, bubbles: true }
		launcher.dispatchEvent(
			new PointerEvent('pointerdown', { ...opts, button: 0, clientX: from[0], clientY: from[1] })
		)
		launcher.dispatchEvent(
			new PointerEvent('pointermove', { ...opts, clientX: to[0], clientY: to[1] })
		)
		launcher.dispatchEvent(
			new PointerEvent('pointerup', { ...opts, clientX: to[0], clientY: to[1] })
		)
	}

	it('drags the launcher to a new viewport position', () => {
		const { launcher } = createWithLauncher()
		mockLayout(launcher, 100, 200)
		drag(launcher, [100, 200], [240, 320])

		expect(launcher.style.left).toBe('240px')
		expect(launcher.style.top).toBe('320px')
		expect(launcher.style.right).toBe('auto')
		expect(launcher.style.bottom).toBe('auto')
		expect(launcher.classList.contains(styles.dragging)).toBe(false)
	})

	it('clamps the launcher inside the viewport while dragging', () => {
		const { launcher } = createWithLauncher()
		mockLayout(launcher, 100, 200)
		// Drag far beyond the top-right corner; the icon must stay on screen.
		drag(launcher, [100, 200], [-5000, 5000])

		expect(launcher.style.left).toBe('0px')
		expect(launcher.style.top).toBe(`${VIEW_H - LAUNCHER_SIZE}px`)
	})

	it('does not open the panel when the launcher is dragged', () => {
		const { panel, launcher } = createWithLauncher()
		mockLayout(launcher, 100, 200)
		drag(launcher, [100, 200], [200, 200])
		// Browsers fire a click after a drag (pointer capture retargets it); it
		// must be swallowed so moving the icon never opens the panel.
		launcher.dispatchEvent(new MouseEvent('click', { bubbles: true }))

		expect(panel.wrapper.style.display).toBe('none')
		expect(launcher.classList.contains(styles.hidden)).toBe(false)
	})

	it('opens the panel on a plain click (no drag)', () => {
		const { panel, launcher } = createWithLauncher()
		mockLayout(launcher, 100, 200)

		launcher.click()

		expect(panel.wrapper.style.display).not.toBe('none')
		expect(launcher.classList.contains(styles.hidden)).toBe(true)
	})

	it('keeps the dragged position after closing and reopening the panel', () => {
		const { panel, launcher } = createWithLauncher()
		mockLayout(launcher, 100, 200)
		drag(launcher, [100, 200], [240, 320])

		panel.show()
		panel.close()

		expect(launcher.style.left).toBe('240px')
		expect(launcher.style.top).toBe('320px')
	})

	it('persists the dragged position to localStorage', () => {
		const { launcher } = createWithLauncher()
		mockLayout(launcher, 100, 200)
		drag(launcher, [100, 200], [240, 320])

		const saved = JSON.parse(window.localStorage.getItem(LAUNCHER_STORAGE_KEY)!)
		expect(saved).toEqual({ left: 240, top: 320 })
	})

	it('restores a previously saved position on a new panel', () => {
		window.localStorage.setItem(LAUNCHER_STORAGE_KEY, JSON.stringify({ left: 60, top: 500 }))
		// The restore measures the launcher size via offsetWidth/Height before the
		// panel is constructed, so mock the prototype getters up front.
		vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(LAUNCHER_SIZE)
		vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(LAUNCHER_SIZE)
		const agent = new FakeAgent()
		const panel = new Panel(agent)
		panels.push(panel)
		const launcher = document.getElementById(LAUNCHER_ID)!

		expect(launcher.style.left).toBe('60px')
		expect(launcher.style.top).toBe('500px')
		expect(launcher.style.right).toBe('auto')
		expect(launcher.style.bottom).toBe('auto')
	})

	it('clamps a restored position to the current viewport', () => {
		window.localStorage.setItem(LAUNCHER_STORAGE_KEY, JSON.stringify({ left: 5000, top: -50 }))
		vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(LAUNCHER_SIZE)
		vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(LAUNCHER_SIZE)
		const agent = new FakeAgent()
		const panel = new Panel(agent)
		panels.push(panel)
		const launcher = document.getElementById(LAUNCHER_ID)!

		expect(launcher.style.left).toBe(`${VIEW_W - LAUNCHER_SIZE}px`)
		expect(launcher.style.top).toBe('0px')
	})

	it('leaves the launcher fixed when launcherDraggable is false', () => {
		const { launcher } = createWithLauncher({ launcherDraggable: false })
		mockLayout(launcher, 100, 200)
		drag(launcher, [100, 200], [240, 320])

		expect(launcher.style.left).toBe('')
		expect(launcher.style.top).toBe('')
		expect(window.localStorage.getItem(LAUNCHER_STORAGE_KEY)).toBeNull()
	})
})

describe('Panel position follows the launcher drag', () => {
	const VIEW_W = 1280
	const VIEW_H = 800
	const LAUNCHER_SIZE = 76
	const PANEL_W = 456
	const panels: Panel[] = []

	beforeEach(() => {
		window.localStorage.clear()
		Object.defineProperty(window, 'innerWidth', { value: VIEW_W, configurable: true })
		Object.defineProperty(window, 'innerHeight', { value: VIEW_H, configurable: true })
	})

	afterEach(() => {
		panels.splice(0).forEach((panel) => panel.dispose())
		document.body.innerHTML = ''
		vi.restoreAllMocks()
		window.localStorage.clear()
	})

	function createWithLauncher(): { agent: FakeAgent; panel: Panel; launcher: HTMLElement } {
		const agent = new FakeAgent()
		const panel = new Panel(agent)
		panel.close()
		const launcher = document.getElementById(LAUNCHER_ID)!
		panels.push(panel)
		return { agent, panel, launcher }
	}

	function mockLauncherLayout(launcher: HTMLElement, left: number, top: number): void {
		vi.spyOn(launcher, 'getBoundingClientRect').mockImplementation(() => {
			const l = Number.parseFloat(launcher.style.left) || left
			const t = Number.parseFloat(launcher.style.top) || top
			return {
				left: l,
				top: t,
				right: l + LAUNCHER_SIZE,
				bottom: t + LAUNCHER_SIZE,
				width: LAUNCHER_SIZE,
				height: LAUNCHER_SIZE,
				x: l,
				y: t,
				toJSON: () => ({}),
			}
		})
	}

	function dragLauncher(launcher: HTMLElement, from: [number, number], to: [number, number]): void {
		const opts = { pointerId: 1, bubbles: true }
		launcher.dispatchEvent(
			new PointerEvent('pointerdown', {
				...opts,
				button: 0,
				clientX: from[0],
				clientY: from[1],
			})
		)
		launcher.dispatchEvent(
			new PointerEvent('pointermove', { ...opts, clientX: to[0], clientY: to[1] })
		)
		launcher.dispatchEvent(
			new PointerEvent('pointerup', { ...opts, clientX: to[0], clientY: to[1] })
		)
	}

	it('opens the minimized panel anchored to the dragged launcher position', () => {
		const { panel, launcher } = createWithLauncher()
		mockLauncherLayout(launcher, 20, 100)
		dragLauncher(launcher, [20, 100], [120, 300])
		// Provide the wrapper's measured width so the anchor can be clamped.
		vi.spyOn(panel.wrapper, 'offsetWidth', 'get').mockReturnValue(PANEL_W)

		panel.show()

		// Collapsed height is 39px, so the minimized bar sits exactly at the anchor.
		expect(panel.wrapper.style.left).toBe('120px')
		expect(panel.wrapper.style.top).toBe('300px')
		expect(panel.wrapper.style.right).toBe('auto')
		expect(panel.wrapper.style.bottom).toBe('auto')
	})

	it('clamps an expanded panel on-screen when the anchor is near the bottom', () => {
		const { panel, launcher } = createWithLauncher()
		mockLauncherLayout(launcher, 20, VIEW_H - LAUNCHER_SIZE) // bottom-left icon
		dragLauncher(launcher, [20, VIEW_H - LAUNCHER_SIZE], [40, VIEW_H - LAUNCHER_SIZE])
		vi.spyOn(panel.wrapper, 'offsetWidth', 'get').mockReturnValue(PANEL_W)

		panel.show()
		panel.expand()

		const expandedHeight = Math.min(780, VIEW_H - 32) // 768
		expect(panel.wrapper.style.left).toBe('40px')
		expect(panel.wrapper.style.top).toBe(`${VIEW_H - expandedHeight}px`)
	})

	it('reopens the launcher at the shared anchor after the panel was moved', () => {
		const { panel, launcher } = createWithLauncher()
		mockLauncherLayout(launcher, 20, 100)
		dragLauncher(launcher, [20, 100], [120, 300])

		// Without a wrapper size the panel stays unclamped, but the anchor is kept.
		panel.show()
		panel.close()

		expect(launcher.style.left).toBe('120px')
		expect(launcher.style.top).toBe('300px')
	})
})

describe('Panel header drag (move the panel window)', () => {
	const VIEW_W = 1280
	const VIEW_H = 800
	const PANEL_W = 456
	const PANEL_H = 39
	const panels: Panel[] = []

	beforeEach(() => {
		window.localStorage.clear()
		Object.defineProperty(window, 'innerWidth', { value: VIEW_W, configurable: true })
		Object.defineProperty(window, 'innerHeight', { value: VIEW_H, configurable: true })
	})

	afterEach(() => {
		panels.splice(0).forEach((panel) => panel.dispose())
		document.body.innerHTML = ''
		vi.restoreAllMocks()
		window.localStorage.clear()
	})

	function createVisiblePanel(): { agent: FakeAgent; panel: Panel } {
		const agent = new FakeAgent()
		const panel = new Panel(agent)
		panel.show()
		panels.push(panel)
		return { agent, panel }
	}

	function mockPanelLayout(wrapper: HTMLElement, left: number, top: number): void {
		vi.spyOn(wrapper, 'getBoundingClientRect').mockImplementation(() => {
			const l = Number.parseFloat(wrapper.style.left) || left
			const t = Number.parseFloat(wrapper.style.top) || top
			return {
				left: l,
				top: t,
				right: l + PANEL_W,
				bottom: t + PANEL_H,
				width: PANEL_W,
				height: PANEL_H,
				x: l,
				y: t,
				toJSON: () => ({}),
			}
		})
	}

	function dragHeader(panel: Panel, from: [number, number], to: [number, number]): void {
		const header = panel.wrapper.querySelector(`.${styles.header}`)!
		const opts = { pointerId: 1, bubbles: true }
		header.dispatchEvent(
			new PointerEvent('pointerdown', {
				...opts,
				button: 0,
				clientX: from[0],
				clientY: from[1],
			})
		)
		header.dispatchEvent(
			new PointerEvent('pointermove', { ...opts, clientX: to[0], clientY: to[1] })
		)
		header.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: to[0], clientY: to[1] }))
	}

	it('drags the minimized panel to a new viewport position', () => {
		const { panel } = createVisiblePanel()
		mockPanelLayout(panel.wrapper, 300, 400)
		dragHeader(panel, [300, 400], [520, 640])

		expect(panel.wrapper.style.left).toBe('520px')
		expect(panel.wrapper.style.top).toBe('640px')
		expect(panel.wrapper.style.right).toBe('auto')
		expect(panel.wrapper.style.bottom).toBe('auto')
		expect(panel.wrapper.classList.contains(styles.panelDragging)).toBe(false)
	})

	it('clamps the panel inside the viewport while dragging', () => {
		const { panel } = createVisiblePanel()
		mockPanelLayout(panel.wrapper, 300, 400)
		dragHeader(panel, [300, 400], [-5000, 5000])

		expect(panel.wrapper.style.left).toBe('0px')
		expect(panel.wrapper.style.top).toBe(`${VIEW_H - PANEL_H}px`)
	})

	it('moves the expanded panel as well (whole window drag)', () => {
		const { panel } = createVisiblePanel()
		panel.expand()
		mockPanelLayout(panel.wrapper, 300, 400)
		dragHeader(panel, [300, 400], [500, 200])

		expect(panel.wrapper.style.left).toBe('500px')
		expect(panel.wrapper.style.top).toBe('200px')
		expect(panel.wrapper.classList.contains(styles.expanded)).toBe(true)
	})

	it('does not toggle expand/collapse when the panel is dragged', () => {
		const { panel } = createVisiblePanel()
		mockPanelLayout(panel.wrapper, 300, 400)
		dragHeader(panel, [300, 400], [350, 400])
		// Browsers fire a click after a drag (pointer capture retargets it); it
		// must be swallowed so moving the window never toggles it.
		panel.wrapper
			.querySelector(`.${styles.header}`)!
			.dispatchEvent(new MouseEvent('click', { bubbles: true }))

		expect(panel.wrapper.classList.contains(styles.expanded)).toBe(false)
	})

	it('toggles expand/collapse on a plain header click (no drag)', () => {
		const { panel } = createVisiblePanel()
		const header = panel.wrapper.querySelector<HTMLElement>(`.${styles.header}`)!

		header.click()
		expect(panel.wrapper.classList.contains(styles.expanded)).toBe(true)
		header.click()
		expect(panel.wrapper.classList.contains(styles.expanded)).toBe(false)
	})

	it('persists the dragged panel position and repositions the launcher on close', () => {
		const { panel } = createVisiblePanel()
		mockPanelLayout(panel.wrapper, 300, 400)
		dragHeader(panel, [300, 400], [520, 640])

		expect(JSON.parse(window.localStorage.getItem('page-agent:launcher-position')!)).toEqual({
			left: 520,
			top: 640,
		})

		panel.close()
		const launcher = document.getElementById(LAUNCHER_ID)!
		expect(launcher.style.left).toBe('520px')
		expect(launcher.style.top).toBe('640px')
	})
})

/** Close the panel first so the launcher exists in the DOM before external dispose */
function wrapperHiddenState(): void {
	const wrapper = document.getElementById(PANEL_ID)!
	wrapper.querySelector<HTMLButtonElement>('button[title="Close"]')!.click()
}
