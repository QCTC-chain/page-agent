/**
 * Core types for LLM integration
 */
import type * as z from 'zod/v4'

/**
 * Message format - OpenAI standard (industry standard)
 */
export interface Message {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content?: string | null
	tool_calls?: {
		id: string
		type: 'function'
		function: {
			name: string
			arguments: string // JSON string
		}
	}[]
	tool_call_id?: string
	name?: string
}

/**
 * Tool definition - uses Zod schema (LLM-agnostic)
 * Supports generics for type-safe parameters and return values
 */
export interface Tool<TParams = any, TResult = any> {
	// name: string
	description?: string
	inputSchema: z.ZodType<TParams>
	execute: (args: TParams) => Promise<TResult>
}

/**
 * Invoke options for LLM call
 */
export interface InvokeOptions {
	/**
	 * Force LLM to call a specific tool by name.
	 * If provided: tool_choice = { type: 'function', function: { name: toolChoiceName } }
	 * If not provided: tool_choice = 'required' (must call some tool, but model chooses which)
	 */
	toolChoiceName?: string
	/**
	 * Response normalization function.
	 * Called before parsing the response.
	 * Used to fix various response format errors from the model.
	 */
	normalizeResponse?: (response: any) => any
	/**
	 * Non-standard top-level request-body extension (OpenAI-compatible upstreams
	 * that ignore unknown fields accept it; e.g. guidance-api reads
	 * `metadata.intent_context` for intent routing and forwards it untouched).
	 * Merged into the request body as-is when provided.
	 */
	metadata?: Record<string, unknown>
}

/**
 * LLM Client interface
 * Note: Does not use generics because each tool in the tools array has different types
 */
export interface LLMClient {
	invoke(
		messages: Message[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		options?: InvokeOptions
	): Promise<InvokeResult>
}

/**
 * Invoke result (strict typing, supports generics)
 */
export interface InvokeResult<TResult = unknown> {
	toolCall: {
		// id?: string // OpenAI's tool_call_id
		name: string
		args: any
	}
	toolResult: TResult // Supports generics, but defaults to unknown
	usage: {
		promptTokens: number
		completionTokens: number
		totalTokens: number
		cachedTokens?: number // Prompt cache hits
		reasoningTokens?: number // OpenAI o1 series reasoning tokens
	}
	rawResponse?: unknown // Raw response for debugging
	rawRequest?: unknown // Raw request for debugging
}

/**
 * Sanitized upstream tool-progress notification (guidance-api qa stream).
 * Only the whitelist fields survive: phase/tool/isError — arguments and
 * results are never forwarded (they may contain file contents).
 */
export interface LLMStreamProgress {
	phase: 'start' | 'end'
	tool: string
	isError?: boolean
}

/**
 * LLM configuration
 */
export interface LLMConfig {
	baseURL: string
	model: string
	apiKey?: string

	/**
	 * @deprecated No longer a standard parameter; many models reject it outright.
	 * Use `transformRequestBody` to set it only for models you've verified.
	 */
	temperature?: number

	maxRetries?: number

	/**
	 * Transform the final request body before sending it to the provider.
	 * Use this to implement provider-specific request tweaks such as caching hints or custom flags.
	 *
	 * Return a new object, or mutate the input object and return undefined.
	 */
	transformRequestBody?: (
		requestBody: Record<string, unknown>
	) => Record<string, unknown> | undefined

	/**
	 * remove the tool_choice field from the request.
	 * @note fix "Invalid tool_choice type: 'object'" for some LLMs.
	 */
	disableNamedToolChoice?: boolean

	/**
	 * Custom fetch function for LLM API requests.
	 * Use this to customize headers, credentials, proxy, etc.
	 * The response should follow OpenAI API format.
	 */
	customFetch?: typeof globalThis.fetch

	/**
	 * Request streaming (`"stream": true`) from OpenAI-compatible upstreams.
	 * When the response is an SSE stream (`text/event-stream`), the client
	 * consumes it incrementally (invoking the `onStream*` callbacks), then
	 * reassembles a complete `chat.completion` object so downstream parsing
	 * (normalizeResponse / tool-call validation) is unchanged. Non-SSE
	 * responses fall back to buffered JSON parsing.
	 */
	stream?: boolean

	/** Incremental answer-text callback (fired per SSE content delta). */
	onStreamDelta?: (text: string) => void

	/** Incremental tool-progress callback (guidance-api qa streams only). */
	onStreamProgress?: (progress: LLMStreamProgress) => void
}

export type ResolvedLLMConfig = Required<
	Omit<LLMConfig, 'temperature' | 'onStreamDelta' | 'onStreamProgress'>
> & {
	temperature?: number
	onStreamDelta?: (text: string) => void
	onStreamProgress?: (progress: LLMStreamProgress) => void
}
