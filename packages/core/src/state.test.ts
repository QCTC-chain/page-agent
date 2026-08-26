import { describe, expect, it } from 'vitest'

import type { PageAgentCore } from './PageAgentCore'
import {
	AGENT_SNAPSHOT_VERSION,
	type AgentSnapshot,
	restoreAgentState,
	serializeAgentState,
} from './state'
import type { AgentStepEvent, HistoricalEvent } from './types'

/** Minimal agent-shaped object for (de)serialization tests. */
function fakeAgent(overrides: Partial<Pick<PageAgentCore, 'task' | 'taskId' | 'history'>> = {}) {
	return {
		task: 'original task',
		taskId: 'task-1',
		history: [] as HistoricalEvent[],
		...overrides,
	}
}

/** Build a fully-typed step history event. */
function stepEvent(overrides: Partial<AgentStepEvent> = {}): AgentStepEvent {
	return {
		type: 'step',
		stepIndex: 0,
		reflection: { memory: 'remembered' },
		action: { name: 'click_element_by_index', input: { index: 3 }, output: '✅ Clicked.' },
		usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
		rawResponse: { choices: [{ big: 'raw' }] },
		rawRequest: { messages: [{ role: 'user', content: 'full prompt with DOM' }] },
		...overrides,
	}
}

describe('serializeAgentState', () => {
	it('produces a versioned snapshot with task, taskId and history', () => {
		const agent = fakeAgent({ history: [stepEvent()] })

		const snapshot = serializeAgentState(agent)

		expect(snapshot.version).toBe(AGENT_SNAPSHOT_VERSION)
		expect(snapshot.task).toBe('original task')
		expect(snapshot.taskId).toBe('task-1')
		expect(snapshot.createdAt).toBeGreaterThan(0)
		expect(snapshot.history).toHaveLength(1)
	})

	it('strips raw LLM payloads from step events', () => {
		const agent = fakeAgent({ history: [stepEvent()] })

		const snapshot = serializeAgentState(agent)

		const event = snapshot.history[0] as unknown as Record<string, unknown>
		expect(event.rawResponse).toBeUndefined()
		expect(event.rawRequest).toBeUndefined()
		expect(event.type).toBe('step')
		expect(event.action).toBeDefined()
	})

	it('strips rawResponse from error events', () => {
		const errorEvent: HistoricalEvent = {
			type: 'error',
			message: 'boom',
			rawResponse: { detail: 'secret' },
		}
		const agent = fakeAgent({ history: [errorEvent] })

		const snapshot = serializeAgentState(agent)

		const event = snapshot.history[0] as unknown as Record<string, unknown>
		expect(event.rawResponse).toBeUndefined()
		expect(event.message).toBe('boom')
	})

	it('keeps observation/retry/user_takeover events untouched', () => {
		const events: HistoricalEvent[] = [
			{ type: 'observation', content: 'Page navigated to → /a' },
			{ type: 'retry', message: 'retrying', attempt: 1, maxAttempts: 2 },
			{ type: 'user_takeover' },
		]
		const snapshot = serializeAgentState(fakeAgent({ history: events }))

		expect(snapshot.history).toEqual(events)
	})

	it('does not mutate the original history (raw fields stay on the agent)', () => {
		const history = [stepEvent()]
		const agent = fakeAgent({ history })

		serializeAgentState(agent)

		expect(history[0]).toHaveProperty('rawResponse')
		expect(history[0]).toHaveProperty('rawRequest')
	})
})

describe('restoreAgentState', () => {
	it('round-trips a snapshot back into an agent without running it', () => {
		const agent = fakeAgent({ history: [stepEvent()] })
		const snapshot = serializeAgentState(agent)

		const target = fakeAgent({ history: [] })
		restoreAgentState(target, snapshot)

		expect(target.task).toBe('original task')
		expect(target.taskId).toBe('task-1')
		expect(target.history).toHaveLength(1)
	})

	it('shallow-copies events so later mutation cannot alias into the snapshot', () => {
		const agent = fakeAgent({ history: [stepEvent()] })
		const snapshot = serializeAgentState(agent)
		const target = fakeAgent({ history: [] })

		restoreAgentState(target, snapshot)
		target.history[0] = { type: 'user_takeover' }

		expect(snapshot.history[0].type).toBe('step')
	})

	it('rejects null/non-object snapshots', () => {
		const agent = fakeAgent()
		expect(() => restoreAgentState(agent, null as unknown as AgentSnapshot)).toThrow(
			'Invalid agent snapshot'
		)
	})

	it('rejects unsupported versions', () => {
		const agent = fakeAgent()
		const snapshot = serializeAgentState(agent)
		expect(() =>
			restoreAgentState(agent, { ...snapshot, version: 999 } as unknown as AgentSnapshot)
		).toThrow('Unsupported agent snapshot version')
	})

	it('rejects history entries with an unknown event type', () => {
		const agent = fakeAgent()
		const snapshot = serializeAgentState(agent)
		expect(() =>
			restoreAgentState(agent, {
				...snapshot,
				history: [{ type: 'not-an-event', foo: 1 }] as unknown as HistoricalEvent[],
			})
		).toThrow('malformed history')
	})
})
