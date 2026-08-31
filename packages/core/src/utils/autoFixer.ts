import { InvokeError, InvokeErrorTypes } from '@page-agent/llms'
import chalk from 'chalk'
import * as z from 'zod/v4'

import type { PageAgentTool } from '../tools'

const log = console.log.bind(console, chalk.yellow('[autoFixer]'))

/**
 * Normalize LLM response and fix common format issues.
 *
 * Handles:
 * - No tool_calls but JSON in message.content (fallback)
 * - Model returns action name as tool call instead of AgentOutput
 * - Arguments wrapped as double JSON string
 * - Nested function call format
 * - Missing action field (fallback to wait)
 * - Primitive action input for single-field tools (e.g. `{"click_element_by_index": 2}`)
 * - etc.
 */
export function normalizeResponse(response: any, tools?: Map<string, PageAgentTool>): any {
	let resolvedArguments: any

	const choice = (response as { choices?: Choice[] }).choices?.[0]
	if (!choice) throw new Error('No choices in response')

	const message = choice.message
	if (!message) throw new Error('No message in choice')

	const toolCall = message.tool_calls?.[0]

	// fix level and location of arguments

	if (toolCall?.function?.arguments) {
		resolvedArguments = safeJsonParse(toolCall.function.arguments)

		// case: sometimes the model only returns the action level
		if (toolCall.function.name && toolCall.function.name !== 'AgentOutput') {
			log(`#1: fixing tool_call`)
			resolvedArguments = { action: safeJsonParse(resolvedArguments) }
		}
	} else {
		// case: sometimes the model returns json in content instead of tool_calls
		if (message.content) {
			const content = message.content.trim()
			const jsonInContent = retrieveJsonFromString(content)
			if (jsonInContent) {
				resolvedArguments = safeJsonParse(jsonInContent)

				// case: sometimes the content json includes upper level wrapper
				if (resolvedArguments?.name === 'AgentOutput') {
					log(`#2: fixing tool_call`)
					resolvedArguments = safeJsonParse(resolvedArguments.arguments)
				}

				// case: sometimes even 2-levels of wrapping
				if (resolvedArguments?.type === 'function') {
					log(`#3: fixing tool_call`)
					resolvedArguments = safeJsonParse(resolvedArguments.function.arguments)
				}

				// case: and sometimes action level only
				// todo: needs better detection logic
				if (
					!resolvedArguments?.action &&
					!resolvedArguments?.evaluation_previous_goal &&
					!resolvedArguments?.memory &&
					!resolvedArguments?.next_goal &&
					!resolvedArguments?.thinking
				) {
					log(`#4: fixing tool_call`)
					resolvedArguments = { action: safeJsonParse(resolvedArguments) }
				}
			} else {
				throw new Error('No tool_call and the message content does not contain valid JSON')
			}
		} else {
			throw new Error('No tool_call nor message content is present')
		}
	}

	// fix double stringified arguments
	resolvedArguments = safeJsonParse(resolvedArguments)
	if (resolvedArguments.action) {
		resolvedArguments.action = safeJsonParse(resolvedArguments.action)
	}

	// validate and fix action input using tool schemas
	if (resolvedArguments.action && tools) {
		resolvedArguments.action = validateAction(resolvedArguments.action, tools)
	}

	// fix incomplete formats
	if (!resolvedArguments.action) {
		log(`#5: fixing tool_call`)
		resolvedArguments.action = { wait: { seconds: 1 } }
	}

	// pack back to standard format
	return {
		...response,
		choices: [
			{
				...choice,
				message: {
					...message,
					tool_calls: [
						{
							...(toolCall || {}),
							function: {
								...(toolCall?.function || {}),
								name: 'AgentOutput',
								arguments: JSON.stringify(resolvedArguments),
							},
						},
					],
				},
			},
		],
	}
}

/**
 * Validate action against tool schemas. Provides clear error messages
 * instead of letting the union schema produce unreadable errors.
 *
 * Also coerces primitive inputs for single-field tools:
 * e.g. `{"click_element_by_index": 2}` → `{"click_element_by_index": {"index": 2}}`
 */
function validateAction(action: any, tools: Map<string, PageAgentTool>): any {
	if (typeof action !== 'object' || action === null) return action

	const toolName = Object.keys(action)[0]
	if (!toolName) return action

	const tool = tools.get(toolName)
	if (!tool) {
		const available = Array.from(tools.keys()).join(', ')
		throw new InvokeError(
			InvokeErrorTypes.INVALID_TOOL_ARGS,
			`Unknown action "${toolName}". Available: ${available}`
		)
	}

	let value = action[toolName]
	const schema = tool.inputSchema

	// coerce primitive input for single-field tools
	if (schema instanceof z.ZodObject && value !== null && typeof value !== 'object') {
		const requiredKey = Object.keys(schema.shape).find(
			(k) => !(schema.shape as Record<string, z.ZodType>)[k].safeParse(undefined).success
		)
		if (requiredKey) {
			log(`coercing primitive action input for "${toolName}"`)
			value = { [requiredKey]: value }
		}
	}

	const result = schema.safeParse(value)
	if (!result.success) {
		throw new InvokeError(
			InvokeErrorTypes.INVALID_TOOL_ARGS,
			`Invalid input for action "${toolName}": ${z.prettifyError(result.error)}`
		)
	}

	return { [toolName]: result.data }
}

/**
 * Safely parse JSON, return original input if not json.
 */
function safeJsonParse(input: any): any {
	if (typeof input === 'string') {
		try {
			return JSON.parse(input.trim())
		} catch {
			return input
		}
	}
	return input
}

/**
 * Extract and parse the first balanced JSON object from a string.
 *
 * Uses a string-aware brace-depth scan instead of a greedy "first `{` to last
 * `}`" regex, so trailing garbage AFTER the object (e.g. a stray backtick and
 * an over-closed `}` emitted by the model after a complete JSON object) no
 * longer corrupts the extraction: the scan stops at the `}` that balances the
 * opening `{`, ignoring braces inside JSON string literals.
 *
 * @param str - Raw LLM message content, possibly with prose or code fences.
 * @returns The parsed value of the first balanced `{...}` block, or null when
 *          no balanced JSON object is found.
 */
function retrieveJsonFromString(str: string): any {
	const start = str.indexOf('{')
	if (start === -1) return null
	let depth = 0
	let inString = false
	let escaped = false
	for (let i = start; i < str.length; i++) {
		const char = str[i]
		if (inString) {
			if (escaped) escaped = false
			else if (char === '\\') escaped = true
			else if (char === '"') inString = false
			continue
		}
		if (char === '"') {
			inString = true
		} else if (char === '{') {
			depth++
		} else if (char === '}') {
			depth--
			if (depth === 0) {
				try {
					return JSON.parse(str.slice(start, i + 1))
				} catch {
					return null
				}
			}
		}
	}
	return null
}

interface Choice {
	message?: {
		role?: 'assistant'
		content?: string
		tool_calls?: {
			id?: string
			type?: 'function'
			function?: {
				name?: string
				arguments?: string
			}
		}[]
	}
	index?: 0
	finish_reason?: 'tool_calls'
}
