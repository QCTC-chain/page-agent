// @vitest-environment happy-dom
import type { PageAgentCore } from '@page-agent/core'
import type { HistoricalEvent } from '@page-agent/core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type PerfTelemetryDetail, attachPerfTelemetry, parseEmbedPerfParams } from './embed-perf'

afterEach(() => {
	vi.restoreAllMocks()
})

describe('parseEmbedPerfParams', () => {
	it('returns safe defaults when no script URL is available', () => {
		const params = parseEmbedPerfParams(null)
		expect(params).toEqual({
			viewportExpansion: 300,
			historyView: { maxStepEvents: 5 },
			dedupeUnchangedBrowserState: false,
			telemetryEnabled: true,
		})
	})

	it('parses all supported performance query parameters', () => {
		const url = new URL(
			'https://cdn.test/embeding-assistant.js?viewportExpansion=150&keepSteps=8&dedupeBrowserState=true&telemetry=false'
		)
		expect(parseEmbedPerfParams(url)).toEqual({
			viewportExpansion: 150,
			historyView: { maxStepEvents: 8 },
			dedupeUnchangedBrowserState: true,
			telemetryEnabled: false,
		})
	})

	it('falls back to defaults on invalid values (with a warning, never throws)', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const url = new URL(
			'https://cdn.test/embeding-assistant.js?viewportExpansion=-99&keepSteps=abc'
		)
		expect(parseEmbedPerfParams(url)).toEqual({
			viewportExpansion: 300,
			historyView: { maxStepEvents: 5 },
			dedupeUnchangedBrowserState: false,
			telemetryEnabled: true,
		})
		expect(warn).toHaveBeenCalledTimes(2)
	})

	it('accepts viewportExpansion=-1 (whole page, upstream default) explicitly', () => {
		const url = new URL('https://cdn.test/embeding-assistant.js?viewportExpansion=-1')
		expect(parseEmbedPerfParams(url).viewportExpansion).toBe(-1)
	})
})

/** Minimal EventTarget-based PageAgentCore double for telemetry tests. */
function createFakeAgent(history: HistoricalEvent[]): PageAgentCore {
	const target = new EventTarget()
	// EventTarget already provides add/removeEventListener with correct `this`.
	return Object.assign(target, { history }) as unknown as PageAgentCore
}

function makeStepEvent(stepIndex: number): HistoricalEvent {
	return {
		type: 'step',
		stepIndex,
		reflection: {
			evaluation_previous_goal: 'ok',
			memory: 'mem',
			next_goal: 'next',
		},
		action: { action_name: 'wait', input: {}, output: 'done' },
		usage: {
			promptTokens: 1000,
			completionTokens: 100,
			totalTokens: 1100,
			cachedTokens: 800,
		},
	} as unknown as HistoricalEvent
}

describe('attachPerfTelemetry', () => {
	it('publishes step_usage once per new step event and step durations', () => {
		vi.spyOn(console, 'info').mockImplementation(() => {})
		const events: PerfTelemetryDetail[] = []
		vi.spyOn(window, 'dispatchEvent').mockImplementation((event: Event) => {
			events.push((event as CustomEvent<PerfTelemetryDetail>).detail)
			return true
		})

		const history: HistoricalEvent[] = []
		const agent = createFakeAgent(history)
		const detach = attachPerfTelemetry(agent)

		const first = makeStepEvent(0)
		history.push(first)
		agent.dispatchEvent(new Event('historychange'))

		const second = makeStepEvent(1)
		history.push(second)
		agent.dispatchEvent(new Event('historychange'))

		// Same event object re-delivered (e.g. repeated historychange) is not double-reported.
		agent.dispatchEvent(new Event('historychange'))

		const usage = events.filter((e) => e.type === 'step_usage')
		expect(usage).toHaveLength(2)
		const secondUsage = usage[1] as Extract<PerfTelemetryDetail, { type: 'step_usage' }>
		expect(secondUsage.step).toBe(2)
		expect(secondUsage.promptTokens).toBe(1000)
		expect(secondUsage.cachedTokens).toBe(800)

		detach()
		history.push(makeStepEvent(2))
		agent.dispatchEvent(new Event('historychange'))
		expect(events.filter((e) => e.type === 'step_usage')).toHaveLength(2)
	})

	it('maps activity retries, executed tools and errors to bounded payloads', () => {
		vi.spyOn(console, 'info').mockImplementation(() => {})
		const events: PerfTelemetryDetail[] = []
		vi.spyOn(window, 'dispatchEvent').mockImplementation((event: Event) => {
			events.push((event as CustomEvent<PerfTelemetryDetail>).detail)
			return true
		})

		const agent = createFakeAgent([])
		attachPerfTelemetry(agent)

		agent.dispatchEvent(
			new CustomEvent('activity', { detail: { type: 'retrying', attempt: 2, maxAttempts: 3 } })
		)
		agent.dispatchEvent(
			new CustomEvent('activity', { detail: { type: 'executed', tool: 'click', duration: 42 } })
		)
		agent.dispatchEvent(
			new CustomEvent('activity', {
				detail: { type: 'error', message: 'x'.repeat(1000) },
			})
		)

		expect(events.map((e) => e.type)).toEqual(['step_retry', 'action_executed', 'step_error'])
		const errorEvent = events[2] as Extract<PerfTelemetryDetail, { type: 'step_error' }>
		expect(errorEvent.message.length).toBeLessThanOrEqual(301) // 300 + ellipsis
	})
})
