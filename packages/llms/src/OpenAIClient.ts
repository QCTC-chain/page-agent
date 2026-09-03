/**
 * OpenAI Client implementation
 */
import * as z from 'zod/v4'

import { InvokeError, InvokeErrorTypes, MigrationError } from './errors'
import type {
	InvokeOptions,
	InvokeResult,
	LLMClient,
	LLMStreamProgress,
	Message,
	ResolvedLLMConfig,
	Tool,
} from './types'
import { modelPatch, zodToOpenAITool } from './utils'

/**
 * Sanitize a raw `progress` field from an SSE chunk down to the whitelist
 * (phase/tool/isError/detail). Arguments and results are dropped: they may contain
 * upstream file contents and must never reach the browser UI.
 */
function sanitizeStreamProgress(raw: unknown): LLMStreamProgress | null {
	if (!raw || typeof raw !== 'object') return null
	const record = raw as Record<string, unknown>
	const phase = record.phase === 'start' ? 'start' : 'end'
	const tool = typeof record.tool === 'string' ? record.tool : ''
	if (!tool) return null
	// detail is the server-controlled summary (path tail / grep pattern);
	// non-string or oversized values are dropped as browser-side defense.
	const detail = typeof record.detail === 'string' ? record.detail.slice(0, 80) : ''
	const base = record.isError === true ? { phase, tool, isError: true } : { phase, tool }
	return detail ? { ...base, detail } : base
}

/**
 * Client for OpenAI compatible APIs
 */
export class OpenAIClient implements LLMClient {
	config: ResolvedLLMConfig
	private fetch: typeof globalThis.fetch

	constructor(config: ResolvedLLMConfig) {
		this.config = config
		this.fetch = config.customFetch
	}

	async invoke(
		messages: Message[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		options?: InvokeOptions
	): Promise<InvokeResult> {
		abortSignal?.throwIfAborted()

		// 1. Convert tools to OpenAI format
		const openaiTools = Object.entries(tools).map(([name, t]) => zodToOpenAITool(name, t))

		// Build request body

		let toolChoice: unknown = 'required'
		if (options?.toolChoiceName && !this.config.disableNamedToolChoice) {
			toolChoice = { type: 'function', function: { name: options.toolChoiceName } }
		}

		const requestBody: Record<string, unknown> = {
			model: this.config.model,
			messages,
			tools: openaiTools,
			parallel_tool_calls: false,
			tool_choice: toolChoice,
		}
		// Only sent if the caller explicitly set it. Most new models throw if this is set.
		if (this.config.temperature !== undefined) {
			requestBody.temperature = this.config.temperature
		}
		// Native streaming: opt in to SSE and let #consumeSseStream reassemble a
		// complete completion below (config.stream defaults to false).
		if (this.config.stream) {
			requestBody.stream = true
		}

		// Merge the caller's non-standard metadata extension (e.g. guidance-api's
		// `metadata.intent_context` for intent routing). Additive: upstreams that
		// ignore unknown fields are unaffected.
		if (options?.metadata) {
			requestBody.metadata = {
				...(requestBody.metadata as Record<string, unknown> | undefined),
				...options.metadata,
			}
		}

		modelPatch(requestBody, this.config.baseURL)

		let transformedBody: Record<string, unknown> | undefined
		try {
			transformedBody = this.config.transformRequestBody(requestBody)
		} catch (error) {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				`transformRequestBody failed: ${(error as Error).message}`,
				error
			)
		}
		const finalRequestBody = transformedBody ?? requestBody

		// 2. Call API
		let response: Response
		try {
			response = await this.fetch(`${this.config.baseURL}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(this.config.apiKey && { Authorization: `Bearer ${this.config.apiKey}` }),
				},
				body: JSON.stringify(finalRequestBody),
				signal: abortSignal,
			})
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			console.error(error)
			throw new InvokeError(InvokeErrorTypes.NETWORK_ERROR, 'Network request failed', error)
		}

		// 3. Handle HTTP errors
		if (!response.ok) {
			let errorData: any
			try {
				errorData = await response.json()
			} catch (error) {
				if ((error as any)?.name === 'AbortError') throw error
			}
			const errorMessage = errorData?.error?.message || response.statusText

			if (response.status === 401 || response.status === 403) {
				throw new InvokeError(
					InvokeErrorTypes.AUTH_ERROR,
					`Authentication failed: ${errorMessage}`,
					errorData
				)
			}
			if (response.status === 429) {
				throw new InvokeError(
					InvokeErrorTypes.RATE_LIMIT,
					`Rate limit exceeded: ${errorMessage}`,
					errorData
				)
			}
			if (response.status >= 500) {
				throw new InvokeError(
					InvokeErrorTypes.SERVER_ERROR,
					`Server error: ${errorMessage}`,
					errorData
				)
			}
			throw new InvokeError(
				InvokeErrorTypes.UNKNOWN,
				`HTTP ${response.status}: ${errorMessage}`,
				errorData
			)
		}

		// 4. Parse and validate response
		let data: any
		// (headers may be absent on fakes/stubs — stay defensive)
		const contentType = response.headers?.get('content-type') || ''
		if (contentType.includes('text/event-stream')) {
			// SSE upstream: consume incrementally (onStream* callbacks fire as
			// chunks arrive) and reassemble a buffered-equivalent completion.
			data = await this.#consumeSseStream(response)
		} else {
			try {
				data = await response.json()
			} catch (error) {
				if ((error as any)?.name === 'AbortError') throw error
				throw new InvokeError(
					InvokeErrorTypes.INVALID_RESPONSE,
					'Response body is not valid JSON',
					error
				)
			}
		}

		const choice = data.choices?.[0]
		if (!choice) {
			throw new InvokeError(InvokeErrorTypes.INVALID_SCHEMA, 'No choices in response', data)
		}

		// Check finish_reason
		switch (choice.finish_reason) {
			case 'tool_calls':
			case 'function_call': // gemini
			case 'stop': // some models use this even with tool calls
				break
			case 'length':
				throw new InvokeError(
					InvokeErrorTypes.CONTEXT_LENGTH,
					'Response truncated: max tokens reached',
					undefined,
					data
				)
			case 'content_filter':
				throw new InvokeError(
					InvokeErrorTypes.CONTENT_FILTER,
					'Content filtered by safety system',
					undefined,
					data
				)
			default:
				throw new InvokeError(
					InvokeErrorTypes.INVALID_SCHEMA,
					`Unexpected finish_reason: ${choice.finish_reason}`,
					undefined,
					data
				)
		}

		// Apply normalizeResponse if provided (for fixing format issues automatically)
		const normalizedData = options?.normalizeResponse ? options.normalizeResponse(data) : data
		const normalizedChoice = (normalizedData as any).choices?.[0]

		// Get tool name from response
		const toolCallName = normalizedChoice?.message?.tool_calls?.[0]?.function?.name
		if (!toolCallName) {
			throw new InvokeError(
				InvokeErrorTypes.NO_TOOL_CALL,
				'No tool call found in response',
				undefined,
				data
			)
		}

		const tool = tools[toolCallName]
		if (!tool) {
			throw new InvokeError(
				InvokeErrorTypes.UNKNOWN,
				`Tool "${toolCallName}" not found in tools`,
				undefined,
				data
			)
		}

		// Extract and parse tool arguments
		const argString = normalizedChoice.message?.tool_calls?.[0]?.function?.arguments
		if (!argString) {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_TOOL_ARGS,
				'No tool call arguments found',
				undefined,
				data
			)
		}

		let parsedArgs: unknown
		try {
			parsedArgs = JSON.parse(argString)
		} catch (error) {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_TOOL_ARGS,
				'Failed to parse tool arguments as JSON',
				error,
				data
			)
		}

		// Validate with schema
		const validation = tool.inputSchema.safeParse(parsedArgs)
		if (!validation.success) {
			console.error(z.prettifyError(validation.error))
			throw new InvokeError(
				InvokeErrorTypes.INVALID_TOOL_ARGS,
				'Tool arguments validation failed',
				validation.error,
				data
			)
		}
		const toolInput = validation.data

		// 5. Execute tool
		let toolResult: unknown
		try {
			toolResult = await tool.execute(toolInput)
		} catch (error: unknown) {
			// Abort and task-migration signals must propagate as-is: abort stops the
			// whole run, and MigrationError ends the run with a 'migrated' status.
			if ((error as any)?.name === 'AbortError' || error instanceof MigrationError) throw error
			throw new InvokeError(
				InvokeErrorTypes.TOOL_EXECUTION_ERROR,
				`Tool execution failed: ${(error as Error)?.message}`,
				error,
				data
			)
		}

		// Return result
		return {
			toolCall: {
				name: toolCallName,
				args: toolInput,
			},
			toolResult,
			usage: {
				promptTokens: data.usage?.prompt_tokens ?? 0,
				completionTokens: data.usage?.completion_tokens ?? 0,
				totalTokens: data.usage?.total_tokens ?? 0,
				cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens,
				reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
			},
			rawResponse: data,
			rawRequest: finalRequestBody,
		}
	}

	/**
	 * Consume an OpenAI-compatible SSE stream and reassemble a buffered-
	 * equivalent `chat.completion` object.
	 *
	 * Protocol notes (guidance-api extensions are additive and ignorable by
	 * standard OpenAI clients):
	 * - `choices[0].delta.content` chunks are accumulated into the final message
	 *   content; each chunk also fires `config.onStreamDelta`.
	 * - `progress` chunks are sanitized to the phase/tool/isError/detail
	 *   whitelist and forwarded via `config.onStreamProgress`.
	 * - a trailing `guidance_done` marker (knowledge_qa streams) wraps the
	 *   accumulated text as an `AgentOutput{done}` JSON string, matching the
	 *   buffered-mode response shape downstream parsing expects.
	 * - `usage` / `finish_reason` chunks are recorded for the final object.
	 *
	 * Aborts propagate as AbortError; malformed frames are skipped silently.
	 */
	async #consumeSseStream(response: Response): Promise<any> {
		if (!response.body) {
			// No streamable body (should not happen for text/event-stream, but stay
			// defensive): fall back to buffered parsing.
			return await response.json()
		}

		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ''
		let content = ''
		let usage: any
		let finishReason: string | null = null
		let guidanceDone: { success?: boolean } | null = null

		/** Parse one `data:` payload (a JSON chunk or `[DONE]`, which is a no-op). */
		const handleData = (data: string): void => {
			if (!data || data === '[DONE]') return
			let event: any
			try {
				event = JSON.parse(data)
			} catch {
				return // malformed frames are skipped
			}
			if (!event || typeof event !== 'object') return
			if (event.progress) {
				const progress = sanitizeStreamProgress(event.progress)
				if (progress) this.config.onStreamProgress?.(progress)
				return
			}
			if (event.guidance_done) guidanceDone = event.guidance_done
			if (event.usage) usage = event.usage
			const choice = event.choices?.[0]
			if (!choice) return
			if (choice.finish_reason) finishReason = choice.finish_reason
			const text = choice.delta?.content
			if (typeof text === 'string' && text) {
				content += text
				this.config.onStreamDelta?.(text)
			}
		}

		/** Extract every `data:` line from one SSE frame (blank-line delimited). */
		const handleFrame = (frame: string): void => {
			for (const line of frame.split('\n')) {
				if (line.startsWith('data:')) handleData(line.slice(5).trim())
			}
		}

		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (value) {
					buffer += decoder.decode(value, { stream: true })
					let index = buffer.indexOf('\n\n')
					while (index !== -1) {
						handleFrame(buffer.slice(0, index))
						buffer = buffer.slice(index + 2)
						index = buffer.indexOf('\n\n')
					}
				}
				if (done) break
			}
			buffer += decoder.decode() // flush the tail
			if (buffer.trim()) handleFrame(buffer)
		} catch (error) {
			if ((error as any)?.name === 'AbortError') throw error
			throw new InvokeError(InvokeErrorTypes.NETWORK_ERROR, 'SSE stream read failed', error)
		}

		// Re-read through a snapshot: TS control-flow cannot see closure writes.
		const doneMarker = guidanceDone as { success?: boolean } | null
		const finalContent = doneMarker
			? JSON.stringify({
					action: { done: { text: content, success: doneMarker.success !== false } },
				})
			: content

		return {
			id: `chatcmpl-sse-${Date.now().toString(36)}`,
			object: 'chat.completion',
			created: Math.floor(Date.now() / 1000),
			model: this.config.model,
			choices: [
				{
					index: 0,
					message: { role: 'assistant', content: finalContent },
					finish_reason: finishReason || 'stop',
				},
			],
			...(usage ? { usage } : {}),
		}
	}
}
