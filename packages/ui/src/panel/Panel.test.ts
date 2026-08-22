import { afterEach, describe, expect, it, vi } from 'vitest'

import { Panel } from './Panel'
import type { PanelAgentAdapter } from './types'

import styles from './Panel.module.css'

const PANEL_ID = 'page-agent-runtime_agent-panel'
const LAUNCHER_ID = 'page-agent-runtime_agent-panel-launcher'

/** Minimal agent implementing PanelAgentAdapter for UI tests */
class FakeAgent extends EventTarget implements PanelAgentAdapter {
	status: PanelAgentAdapter['status'] = 'idle'
	lastResult: { success: boolean } | null = null
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

	it('stops the running agent instead of closing the panel', () => {
		const { agent } = createPanel('running')
		const wrapper = document.getElementById(PANEL_ID)!
		const stopButton = wrapper.querySelector<HTMLButtonElement>('button[title="Stop"]')!

		stopButton.click()

		expect(agent.stop).toHaveBeenCalledTimes(1)
		expect(agent.dispose).not.toHaveBeenCalled()
		expect(wrapper.style.display).not.toBe('none')
	})

	it('removes the panel and the launcher when the agent is disposed externally', () => {
		const { agent } = createPanel()
		wrapperHiddenState()

		agent.dispatchEvent(new Event('dispose'))

		expect(document.getElementById(PANEL_ID)).toBeNull()
		expect(document.getElementById(LAUNCHER_ID)).toBeNull()
	})
})

/** Close the panel first so the launcher exists in the DOM before external dispose */
function wrapperHiddenState(): void {
	const wrapper = document.getElementById(PANEL_ID)!
	wrapper.querySelector<HTMLButtonElement>('button[title="Close"]')!.click()
}
