/**
 * Embed-mode performance & telemetry helpers (context-governance rollout for
 * the `<script src="embeding-assistant.js?...">` deployment).
 *
 * Parses performance-related query parameters and wires LLM usage telemetry so
 * third-party host pages can observe per-step token consumption and timings.
 *
 * Query parameters (all optional; invalid values fall back to defaults with a
 * loud console warning — an embedded script must never break the host page):
 * - `viewportExpansion=300`  interactive-element collection range in px around
 *   the viewport; `-1` = whole page (upstream default, slow on complex pages).
 * - `keepSteps=5`            how many recent step events stay visible in the
 *   LLM `<agent_history>` (core `historyView`; UI timeline stays complete).
 * - `dedupeBrowserState=true` replace byte-identical consecutive page snapshots
 *   with a short placeholder (opt-in).
 * - `telemetry=false`        disable the built-in perf telemetry (default on).
 *
 * Telemetry events are logged via `console.info('[page-agent:perf]', …)` and
 * dispatched on `window` as `page-agent:perf` CustomEvents so the embedding
 * page can forward them to its own analytics. Payloads are bounded summaries
 * (token counts, durations, tool names) — never page text or user input.
 */
import type { PageAgentCore } from '@page-agent/core'

/** Resolved embed performance configuration (all fields always present). */
export interface EmbedPerfParams {
	viewportExpansion: number
	historyView: { maxStepEvents: number } | undefined
	dedupeUnchangedBrowserState: boolean
	telemetryEnabled: boolean
}

/** Bounded telemetry payloads (safe to forward to analytics). */
export type PerfTelemetryDetail =
	| {
			type: 'step_usage'
			step: number
			promptTokens: number
			completionTokens: number
			totalTokens: number
			cachedTokens?: number
			reasoningTokens?: number
			stepDurationMs: number
	  }
	| { type: 'step_retry'; attempt: number; maxAttempts: number }
	| { type: 'step_error'; message: string }
	| { type: 'action_executed'; tool: string; durationMs: number }

/** Default collection range (px around viewport). `-1` would mean whole page. */
export const DEFAULT_VIEWPORT_EXPANSION = 300
/** Default number of recent step events kept in the LLM history view. */
export const DEFAULT_KEEP_STEPS = 5
/** Max characters for bounded string fields in telemetry payloads. */
const TELEMETRY_TEXT_MAX = 300

/**
 * Parse performance query parameters from the embed script URL.
 *
 * @param url Parsed URL of the embed script (may be null when `document.currentScript`
 *   is unavailable); null returns pure defaults.
 * @returns Fully resolved perf config; invalid values fall back to defaults with
 *   a `console.warn` (never throws — host pages must not break).
 */
export function parseEmbedPerfParams(url: URL | null): EmbedPerfParams {
	const params: EmbedPerfParams = {
		viewportExpansion: DEFAULT_VIEWPORT_EXPANSION,
		historyView: { maxStepEvents: DEFAULT_KEEP_STEPS },
		dedupeUnchangedBrowserState: false,
		telemetryEnabled: true,
	}
	if (!url) return params

	const viewportRaw = url.searchParams.get('viewportExpansion')
	const viewportExpansion = parseOptionalInt(viewportRaw)
	if (viewportExpansion === undefined) {
		// keep default
	} else if (Number.isNaN(viewportExpansion) || viewportExpansion < -1) {
		warnInvalid('viewportExpansion', viewportRaw)
	} else {
		params.viewportExpansion = viewportExpansion
	}

	const keepRaw = url.searchParams.get('keepSteps')
	const keepSteps = parseOptionalInt(keepRaw)
	if (keepSteps === undefined) {
		// keep default
	} else if (Number.isNaN(keepSteps) || keepSteps < 1) {
		warnInvalid('keepSteps', keepRaw)
	} else {
		params.historyView = { maxStepEvents: keepSteps }
	}

	params.dedupeUnchangedBrowserState = url.searchParams.get('dedupeBrowserState') === 'true'
	params.telemetryEnabled = url.searchParams.get('telemetry') !== 'false'

	return params
}

/**
 * Parse an integer query value.
 * @returns undefined when absent/blank, NaN when not numeric, else the integer.
 */
function parseOptionalInt(raw: string | null): number | undefined {
	if (raw === null || raw.trim() === '') return undefined
	return Math.trunc(Number(raw))
}

/** Loudly report an invalid parameter, then fall back to the default. */
function warnInvalid(name: string, raw: string | null): void {
	console.warn(`[page-agent:perf] invalid query param "${name}=${raw}", using default.`)
}

/**
 * Attach per-step usage telemetry to an agent.
 *
 * Listens to `historychange` (step events carry the LLM `usage` record) and
 * `activity` (retries / executed tools / errors), then publishes each payload
 * via `console.info` and a `page-agent:perf` CustomEvent on `window`.
 *
 * @param agent PageAgent / PageAgentCore instance to observe
 * @returns Detach function removing both listeners
 */
export function attachPerfTelemetry(agent: PageAgentCore): () => void {
	/** Events already reported (by reference; folding creates fresh objects). */
	const seen = new Set<object>()
	/** Arrival time of the previous step event, for per-step duration. */
	let lastStepAt: number | null = null

	function publish(detail: PerfTelemetryDetail): void {
		// Bounded summary payloads only — no page text, prompts, or user input.
		console.info('[page-agent:perf]', detail)
		window.dispatchEvent(new CustomEvent<PerfTelemetryDetail>('page-agent:perf', { detail }))
	}

	const onHistoryChange = () => {
		for (const event of agent.history) {
			if (seen.has(event)) continue
			seen.add(event)
			if (event.type !== 'step') continue
			const now = Date.now()
			const stepDurationMs = lastStepAt === null ? 0 : now - lastStepAt
			lastStepAt = now
			publish({
				type: 'step_usage',
				step: (event.stepIndex ?? 0) + 1,
				promptTokens: event.usage?.promptTokens ?? 0,
				completionTokens: event.usage?.completionTokens ?? 0,
				totalTokens: event.usage?.totalTokens ?? 0,
				cachedTokens: event.usage?.cachedTokens,
				reasoningTokens: event.usage?.reasoningTokens,
				stepDurationMs,
			})
		}
	}

	const onActivity = (event: Event) => {
		const detail = (event as CustomEvent).detail as
			{ type: string; [key: string]: unknown } | undefined
		if (!detail) return
		if (detail.type === 'retrying') {
			publish({
				type: 'step_retry',
				attempt: Number(detail.attempt ?? 0),
				maxAttempts: Number(detail.maxAttempts ?? 0),
			})
		} else if (detail.type === 'executed') {
			// Tool names come from the tool map keys (plain strings); guard anyway.
			publish({
				type: 'action_executed',
				tool: typeof detail.tool === 'string' ? detail.tool : String(detail.tool),
				durationMs: Number(detail.duration ?? 0),
			})
		} else if (detail.type === 'error') {
			const message = bound(safeText(detail.message))
			publish({ type: 'step_error', message })
		}
	}

	agent.addEventListener('historychange', onHistoryChange)
	agent.addEventListener('activity', onActivity)
	return () => {
		agent.removeEventListener('historychange', onHistoryChange)
		agent.removeEventListener('activity', onActivity)
	}
}

/** Truncate a string for safe bounded telemetry, dropping control characters. */
function bound(text: string): string {
	// eslint-disable-next-line no-control-regex -- dropping control chars is the point
	const cleaned = text.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ')
	return cleaned.length <= TELEMETRY_TEXT_MAX ? cleaned : `${cleaned.slice(0, TELEMETRY_TEXT_MAX)}…`
}

/** Convert an unknown activity payload to plain text without object stringification. */
function safeText(value: unknown): string {
	if (typeof value === 'string') return value
	if (value instanceof Error) return value.message
	return ''
}
