/**
 * Tool definitions for multi-page handoff.
 *
 * `open_new_tab` lets the model ask for a new tab. Because popup blockers
 * forbid programmatic `window.open` from an async LLM callback, the tool
 * hands control to `HandoffController`, which either navigates a pre-reserved
 * placeholder window (strategy `placeholder`) or shows a clickable card the
 * user opens (strategy `confirm` — the user click is the real gesture).
 */
import { type PageAgentCore, type ToolContext, tool } from '@page-agent/core'
import * as z from 'zod/v4'

import type { HandoffController } from './HandoffController'

/** Lazily-resolved controller reference (set by the host after construction). */
export interface HandoffControllerRef {
	current: HandoffController | null
}

/**
 * Create the `open_new_tab` tool bound to a controller reference.
 *
 * The reference is resolved at execution time so the tool can be registered in
 * the agent config before the controller itself is constructed.
 *
 * @param getController - Returns the live `HandoffController` (or null).
 */
export function createOpenNewTabTool(
	getController: () => HandoffController | null
): ReturnType<typeof tool<{ url: string }>> {
	return tool({
		description:
			'Open a new browser tab for the given URL so the task can continue on that page. ' +
			'Use this only when the next step requires a different page that must open in a new tab ' +
			'(in-tab navigation is always preferred). Browsers block popups opened without a user ' +
			'gesture, so the user will be asked to confirm (click a card); after the new tab is ' +
			'opened, the task continues there automatically.',
		inputSchema: z.object({
			url: z
				.string()
				.describe('The URL to open in a new tab (same origin, or an allowlisted host)'),
		}),
		execute: async function (
			this: PageAgentCore,
			input: { url: string },
			ctx: ToolContext
		): Promise<string> {
			const controller = getController()
			if (!controller) {
				throw new Error('Multi-page handoff is not initialized (enableMultiPage not enabled?)')
			}
			return controller.openNewTab(input.url, ctx.signal)
		},
	})
}
