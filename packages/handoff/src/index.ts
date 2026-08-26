/**
 * @page-agent/handoff — same-tab and cross-tab task continuity for page-agent
 * without a browser extension.
 *
 * Provides `HandoffController` (storage + BroadcastChannel coordination, leader
 * claim, heartbeat, reclaim) and the `open_new_tab` tool factory.
 */
export {
	HandoffController,
	buildHandoffUrl,
	parseHandoffMarker,
	type HandoffAgentLike,
	type HandoffChannel,
	type HandoffConfig,
	type HandoffControllerOptions,
	type HandoffMessage,
	type HandoffState,
	type HandoffStorage,
	type PendingHandoff,
	type ResolvedHandoffConfig,
} from './HandoffController'
export { createOpenNewTabTool, type HandoffControllerRef } from './tools'
