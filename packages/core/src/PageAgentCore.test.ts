import type { BrowserState, PageController } from '@page-agent/page-controller'
import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod/v4'

import { PageAgentCore, tool } from './PageAgentCore'
import type { ExecutionResult } from './types'

type TestFetch = (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>

function agentResponse(args: unknown): Response {
	return new Response(
		JSON.stringify({
			choices: [
				{
					finish_reason: 'tool_calls',
					message: {
						tool_calls: [
							{
								function: {
									name: 'AgentOutput',
									arguments: JSON.stringify(args),
								},
							},
						],
					},
				},
			],
			usage: {},
		})
	)
}

function createPageController(): PageController {
	const browserState: BrowserState = {
		url: 'https://example.test/',
		title: 'Test page',
		header: '',
		content: '',
		footer: '',
	}

	return {
		showMask: vi.fn(async () => {}),
		hideMask: vi.fn(),
		cleanUpHighlights: vi.fn(),
		getLastUpdateTime: vi.fn(() => Date.now()),
		getBrowserState: vi.fn(async () => browserState),
		dispose: vi.fn(),
	} as unknown as PageController
}

function createAgent(
	customFetch: TestFetch,
	options: Partial<ConstructorParameters<typeof PageAgentCore>[0]> = {}
): PageAgentCore {
	return new PageAgentCore({
		baseURL: 'https://llm.test',
		model: 'test-model',
		maxRetries: 0,
		stepDelay: 0,
		customFetch,
		customSystemPrompt: 'test',
		pageController: createPageController(),
		...options,
	})
}

function createFetchMock() {
	return vi.fn<TestFetch>()
}

function onceActivity(
	agent: PageAgentCore,
	predicate: (detail: unknown) => boolean
): Promise<void> {
	return new Promise((resolve) => {
		const onActivity = (event: Event) => {
			if (!predicate((event as CustomEvent).detail)) return
			agent.removeEventListener('activity', onActivity)
			resolve()
		}

		agent.addEventListener('activity', onActivity)
	})
}

function isExecutingTool(detail: unknown, toolName: string): boolean {
	return (
		typeof detail === 'object' &&
		detail !== null &&
		'type' in detail &&
		'tool' in detail &&
		detail.type === 'executing' &&
		detail.tool === toolName
	)
}

function doneResponse(text: string, success = true): Response {
	return agentResponse({ action: { done: { text, success } } })
}

function waitResponse(seconds = 10): Response {
	return agentResponse({ action: { wait: { seconds } } })
}

/**
 * Start a task that blocks on `wait`, returning once the tool is executing.
 * The running promise is wrapped so awaiting this helper does not await the task.
 */
async function startBlockedTask(
	agent: PageAgentCore,
	task = 'first'
): Promise<{ result: Promise<ExecutionResult> }> {
	const waitStarted = onceActivity(agent, (detail) => isExecutingTool(detail, 'wait'))
	const result = agent.execute(task)
	await waitStarted
	return { result }
}

describe.concurrent('PageAgentCore lifecycle', () => {
	describe('normal execution', () => {
		it('runs a task to natural completion', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(doneResponse('all done'))
			const agent = createAgent(fetchMock)

			const result = await agent.execute('do something')

			expect(result).toMatchObject({ success: true, data: 'all done' })
			expect(agent.status).toBe('completed')
			expect(fetchMock).toHaveBeenCalledTimes(1)
		})

		it('completes (not errors) when the LLM reports task failure', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(doneResponse('gave up', false))
			const agent = createAgent(fetchMock)

			const result = await agent.execute('do something')

			expect(result).toMatchObject({ success: false, data: 'gave up' })
			expect(agent.status).toBe('completed')
		})

		it('throws when a task is already running', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(waitResponse())
			const agent = createAgent(fetchMock)
			const { result } = await startBlockedTask(agent)

			await expect(agent.execute('second')).rejects.toThrow('A task is already running.')

			await agent.stop()
			await result
		})
	})

	describe('stop', () => {
		it('aborts the running task and keeps the agent reusable', async () => {
			const fetchMock = createFetchMock()
				.mockResolvedValueOnce(waitResponse())
				.mockResolvedValueOnce(doneResponse('second task'))
			const agent = createAgent(fetchMock)
			const { result: firstTask } = await startBlockedTask(agent)

			await agent.stop()
			expect(agent.status).toBe('stopped')
			await expect(firstTask).resolves.toMatchObject({ success: false, data: 'Task aborted' })

			const secondTask = await agent.execute('second')
			expect(secondTask).toMatchObject({ success: true, data: 'second task' })
			expect(agent.status).toBe('completed')
		})

		it('resolves only after the run has fully settled', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(waitResponse())
			const agent = createAgent(fetchMock)
			const { result } = await startBlockedTask(agent)

			await agent.stop()
			expect(agent.status).toBe('stopped')
			await expect(result).resolves.toMatchObject({ success: false })
		})

		it('is a no-op when no task is running', async () => {
			const agent = createAgent(createFetchMock())

			await expect(agent.stop()).resolves.toBeUndefined()
			await expect(agent.stop()).resolves.toBeUndefined()
			expect(agent.status).toBe('idle')
		})
	})

	describe('dispose', () => {
		it('aborts the running task and blocks further execution', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(waitResponse())
			const agent = createAgent(fetchMock)
			const { result: task } = await startBlockedTask(agent)

			agent.dispose()
			await expect(task).resolves.toMatchObject({ success: false, data: 'Task aborted' })

			expect(agent.disposed).toBe(true)
			await expect(agent.execute('again')).rejects.toThrow('has been disposed')
		})

		it('is idempotent', () => {
			const agent = createAgent(createFetchMock())

			expect(() => {
				agent.dispose()
				agent.dispose()
			}).not.toThrow()
			expect(agent.disposed).toBe(true)
		})
	})

	describe('error handling', () => {
		it('fails the task when the network request rejects', async () => {
			const fetchMock = createFetchMock().mockRejectedValue(new Error('network down'))
			const agent = createAgent(fetchMock)

			const result = await agent.execute('do something')

			expect(result.success).toBe(false)
			expect(agent.status).toBe('error')
		})

		it('fails the task when a tool throws', async () => {
			const fetchMock = createFetchMock().mockResolvedValue(agentResponse({ action: { boom: {} } }))
			const agent = createAgent(fetchMock, {
				customTools: {
					boom: tool({
						description: 'Always throws.',
						inputSchema: z.object({}),
						execute: async () => {
							throw new Error('tool exploded')
						},
					}),
				},
			})

			const result = await agent.execute('trigger tool error')

			expect(result.success).toBe(false)
			expect(agent.status).toBe('error')
		})

		it('re-throws and sets error status when onBeforeTask throws', async () => {
			const agent = createAgent(createFetchMock(), {
				onBeforeTask: async () => {
					throw new Error('setup failed')
				},
			})

			await expect(agent.execute('do something')).rejects.toThrow('setup failed')
			expect(agent.status).toBe('error')
			expect(agent.history.some((e) => e.type === 'error')).toBe(false)
		})

		it('re-throws and sets error status when onAfterTask throws', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(doneResponse('all done'))
			const agent = createAgent(fetchMock, {
				onAfterTask: async () => {
					throw new Error('teardown failed')
				},
			})

			await expect(agent.execute('do something')).rejects.toThrow('teardown failed')
			expect(agent.status).toBe('error')
		})

		it('stays reusable after onBeforeTask throws', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(doneResponse('second'))
			let failOnce = true
			const agent = createAgent(fetchMock, {
				onBeforeTask: async () => {
					if (failOnce) {
						failOnce = false
						throw new Error('setup failed')
					}
				},
			})

			await expect(agent.execute('first')).rejects.toThrow('setup failed')
			const result = await agent.execute('second')
			expect(result).toMatchObject({ success: true, data: 'second' })
		})

		it('re-throws and sets error status when onBeforeStep throws', async () => {
			const agent = createAgent(createFetchMock(), {
				onBeforeStep: async () => {
					throw new Error('before step failed')
				},
			})

			await expect(agent.execute('do something')).rejects.toThrow('before step failed')
			expect(agent.status).toBe('error')
			expect(agent.history.some((e) => e.type === 'error')).toBe(false)
		})

		it('re-throws and sets error status when onAfterStep throws', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(doneResponse('all done'))
			const agent = createAgent(fetchMock, {
				onAfterStep: async () => {
					throw new Error('after step failed')
				},
			})

			await expect(agent.execute('do something')).rejects.toThrow('after step failed')
			expect(agent.status).toBe('error')
			expect(agent.history.some((e) => e.type === 'error')).toBe(false)
		})
	})

	describe('built-in tools', () => {
		it('registers the hover_element_by_index tool', () => {
			const agent = createAgent(createFetchMock())
			expect(agent.tools.has('hover_element_by_index')).toBe(true)
		})

		it('hover_element_by_index delegates to pageController.hoverElement', async () => {
			const pageController = createPageController()
			const hoverElement = vi.fn(async () => ({
				success: true,
				message: '✅ Hovered element (Users).',
			}))
			;(pageController as unknown as { hoverElement: typeof hoverElement }).hoverElement =
				hoverElement

			const agent = createAgent(createFetchMock(), { pageController })
			const tool = agent.tools.get('hover_element_by_index')!
			const result = await tool.execute.call(
				agent,
				{ index: 3 },
				{ signal: new AbortController().signal }
			)

			expect(hoverElement).toHaveBeenCalledWith(3)
			expect(result).toContain('Hovered')
		})
	})
	describe('page context observations', () => {
		it('reports a tab switch with a dedicated observation (not "Page navigated to")', async () => {
			const state: BrowserState = {
				url: 'https://app-a.test/orders',
				title: 'App A',
				header: '',
				content: '',
				footer: '',
				tabId: 1,
			}
			const pageController = createPageController()
			const mockGetBrowserState = vi.fn(async () => state)
			;(
				pageController as unknown as { getBrowserState: typeof mockGetBrowserState }
			).getBrowserState = mockGetBrowserState

			const fetchMock = createFetchMock()
				.mockResolvedValueOnce(waitResponse())
				.mockResolvedValueOnce(doneResponse('all done'))
			const agent = createAgent(fetchMock, {
				pageController,
				customTools: {
					// Simulate switching to another tab while the task runs.
					wait: tool({
						description: 'instant wait for tests',
						inputSchema: z.object({ seconds: z.number() }),
						execute: async () => {
							state.url = 'https://app-b.test/'
							state.title = 'App B'
							state.tabId = 2
							return '✅ Waited.'
						},
					}),
				},
			})

			const result = await agent.execute('switch to app b')

			expect(result.success).toBe(true)
			const observations = agent.history
				.filter((e) => e.type === 'observation')
				.map((e) => e.content)
			const switchObservations = observations.filter((o) => o.includes('Switched to tab 2'))
			expect(switchObservations).toHaveLength(1)
			expect(switchObservations[0]).toContain('from tab 1')
			// Only the initial step-1 URL observation may mention "navigated to"; the
			// switch itself must NOT be reported as a navigation.
			expect(observations.filter((o) => o.includes('Page navigated to'))).toHaveLength(1)
		})

		it('falls back to URL-only detection when tabId is absent (embed mode)', async () => {
			const state: BrowserState = {
				url: 'https://example.test/a',
				title: 'Test page',
				header: '',
				content: '',
				footer: '',
			}
			const pageController = createPageController()
			const mockGetBrowserState = vi.fn(async () => state)
			;(
				pageController as unknown as { getBrowserState: typeof mockGetBrowserState }
			).getBrowserState = mockGetBrowserState

			const fetchMock = createFetchMock()
				.mockResolvedValueOnce(waitResponse())
				.mockResolvedValueOnce(doneResponse('all done'))
			const agent = createAgent(fetchMock, {
				pageController,
				customTools: {
					// Navigate to another URL within the same (tab-less) page.
					wait: tool({
						description: 'instant wait for tests',
						inputSchema: z.object({ seconds: z.number() }),
						execute: async () => {
							state.url = 'https://example.test/b'
							return '✅ Waited.'
						},
					}),
				},
			})

			await agent.execute('navigate')

			const observations = agent.history
				.filter((e) => e.type === 'observation')
				.map((e) => e.content)
			expect(observations.filter((o) => o.includes('Page navigated to'))).toHaveLength(2)
			expect(observations.some((o) => o.includes('Switched to tab'))).toBe(false)
		})
	})
	describe('cancellation edge cases', () => {
		it('rejects a new task while a stop is still settling', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(waitResponse())
			const agent = createAgent(fetchMock)
			const { result: firstTask } = await startBlockedTask(agent)

			const stopped = agent.stop()

			await expect(agent.execute('too early')).rejects.toThrow('A task is already running.')

			await stopped
			await expect(firstTask).resolves.toMatchObject({ success: false, data: 'Task aborted' })
			expect(fetchMock).toHaveBeenCalledTimes(1)
		})

		it('discards a custom tool result that resolves after stop', async () => {
			let resolveTool!: () => void
			let notifyToolStarted!: () => void
			const toolFinished = new Promise<void>((resolve) => {
				resolveTool = resolve
			})
			const toolStarted = new Promise<void>((resolve) => {
				notifyToolStarted = resolve
			})
			const fetchMock = createFetchMock().mockResolvedValue(
				agentResponse({ action: { slow_tool: {} } })
			)
			const agent = createAgent(fetchMock, {
				customTools: {
					slow_tool: tool({
						description: 'A tool that deliberately ignores cancellation.',
						inputSchema: z.object({}),
						execute: async () => {
							notifyToolStarted()
							await toolFinished
							return 'ignored stop'
						},
					}),
				},
			})

			const task = agent.execute('run slow tool')
			await toolStarted

			const stopped = agent.stop()
			resolveTool()
			await stopped

			await expect(task).resolves.toMatchObject({ success: false, data: 'Task aborted' })
			expect(agent.status).toBe('stopped')
		})
	})
})
