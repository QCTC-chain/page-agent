import { describe, expect, it } from 'vitest'

import { normalizeResponse } from './autoFixer'

/** Build a minimal OpenAI-shaped response carrying the given message content. */
function responseWithContent(content: string): any {
	return {
		choices: [
			{
				index: 0,
				finish_reason: 'stop',
				message: { role: 'assistant', content },
			},
		],
	}
}

/** Parse the AgentOutput arguments packed back by normalizeResponse. */
function normalizedArguments(content: string): any {
	const normalized = normalizeResponse(responseWithContent(content))
	return JSON.parse(normalized.choices[0].message.tool_calls[0].function.arguments)
}

describe('normalizeResponse content fallback', () => {
	it('recovers a complete JSON object followed by trailing garbage containing braces', () => {
		// Regression: the old greedy "first `{` to last `}`" regex swallowed the
		// stray "`}" emitted after the object and failed to parse it. This is a
		// real-world degenerated model response (backtick + over-closed brace).
		const content = '{"next_goal":"done","action":{"done":{"text":"ok","success":true}}}`}'
		const args = normalizedArguments(content)
		expect(args.action.done.text).toBe('ok')
		expect(args.action.done.success).toBe(true)
	})

	it('ignores braces inside JSON string values while scanning', () => {
		const content = '{"action":{"done":{"text":"结果 {a:1} 与 } 字符混合","success":true}}}'
		const args = normalizedArguments(content)
		expect(args.action.done.text).toBe('结果 {a:1} 与 } 字符混合')
	})

	it('handles escaped quotes inside JSON string values', () => {
		const content = '{"action":{"done":{"text":"he said \\"hi\\" } ok","success":true}}}`}'
		const args = normalizedArguments(content)
		expect(args.action.done.text).toBe('he said "hi" } ok')
	})

	it('extracts the first balanced object when the model echoes a second one', () => {
		const content =
			'{"action":{"done":{"text":"first","success":true}}}' +
			'{"action":{"done":{"text":"second","success":true}}}'
		const args = normalizedArguments(content)
		expect(args.action.done.text).toBe('first')
	})

	it('still recovers JSON inside a markdown code fence', () => {
		const content = '```json\n{"action":{"wait":{"seconds":1}}}\n```'
		const args = normalizedArguments(content)
		expect(args.action.wait.seconds).toBe(1)
	})

	it('recovers JSON with prose before it', () => {
		const content = '好的，这是结果：{"action":{"done":{"text":"ok","success":true}}}'
		const args = normalizedArguments(content)
		expect(args.action.done.text).toBe('ok')
	})

	it('throws with the raw content appended when no JSON object is present', () => {
		const content = '抱歉，我无法完成该任务'
		expect(() => normalizeResponse(responseWithContent(content))).toThrow(
			/does not contain valid JSON: 抱歉，我无法完成该任务/
		)
	})

	it('throws when the JSON object is never closed', () => {
		const content = '{"action":{"done":{"text":"truncated"'
		expect(() => normalizeResponse(responseWithContent(content))).toThrow(
			/does not contain valid JSON/
		)
	})
})
