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

	execute = vi.fn(async () => {})
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
