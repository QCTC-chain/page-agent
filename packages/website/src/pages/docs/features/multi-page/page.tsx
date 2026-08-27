import CodeEditor from '@/components/CodeEditor'
import { Heading } from '@/components/Heading'
import { useLanguage } from '@/i18n/context'

const EMBED_SCRIPT = `<script
  src="https://cdn.example.com/embeding-assistant.js?multiPage=true"
  crossorigin="anonymous"
></script>`

const CONFIG_TS = `import { PageAgent } from 'page-agent'

const agent = new PageAgent({
  model: 'qwen3.5-plus',
  baseURL: 'https://your-guidance-api.example.com/v1/pa',
  apiKey: 'your-client-key',
  enableMultiPage: true,
  // Optional handoff tuning (defaults shown):
  multiPage: {
    newTabStrategy: 'confirm', // 'confirm' | 'placeholder'
    openTabUrlAllowlist: [], // extra hosts beyond same-origin
    claimTimeoutMs: 15000,
    heartbeatIntervalMs: 1000,
  },
})`

/**
 * Multi-page tasks without a browser extension.
 *
 * Same-origin pages can continue a running task across reloads, MPA navigation
 * and new tabs — no Chrome extension needed. See `@page-agent/handoff` for the
 * full protocol details.
 */
export default function MultiPage() {
	const { isZh } = useLanguage()

	return (
		<div>
			<h1 className="text-4xl font-bold mb-6">
				{isZh ? '多页面任务（无需扩展）' : 'Multi-Page Tasks (No Extension)'}
			</h1>

			<p className="text-xl text-gray-600 dark:text-gray-300 mb-8 leading-relaxed">
				{isZh
					? '在同一源（同域名）的多个页面之间连续执行任务：任务在页面重载后自动恢复，也可以通过新标签页继续，全程不需要安装浏览器扩展。'
					: 'Continue a running task across same-origin pages: the task survives reloads automatically and can keep going in a new tab — no browser extension required.'}
			</p>

			<div className="space-y-8 mt-8">
				<section>
					<Heading id="how-it-works" className="text-2xl font-bold mb-4">
						{isZh ? '工作原理' : 'How It Works'}
					</Heading>
					<p className="text-gray-700 dark:text-gray-300 leading-relaxed">
						{isZh
							? 'PageAgent 每一步都会把完整的历史与任务文本发送给模型（无状态请求），所以一个任务只要迁移 task + history 就能在另一个页面继续。本功能在每步完成后把快照写入浏览器存储，并在需要开新标签页时通过 BroadcastChannel 协商交接：'
							: 'PageAgent sends the full history plus task text to the model on every step (stateless requests), so a task can resume on another page by migrating exactly task + history. This feature persists a snapshot after every step and negotiates handoff over BroadcastChannel when a new tab is needed:'}
					</p>
					<ul className="list-disc pl-6 mt-4 space-y-2 text-gray-700 dark:text-gray-300">
						<li>
							{isZh
								? '同标签页：SPA 路由不重载；MPA 导航 / F5 后自动从快照恢复（sessionStorage）。'
								: 'Same tab: SPA routing needs nothing; MPA navigation / F5 auto-resumes from the snapshot (sessionStorage).'}
						</li>
						<li>
							{isZh
								? '新标签页：模型调用 open_new_tab 工具，面板显示可点击卡片（用户点击是浏览器允许的“真实手势”）；新页面加载后认领任务并从最后一步继续（localStorage + BroadcastChannel）。'
								: 'New tab: the model calls the open_new_tab tool and the panel shows a clickable card (the user click is the real gesture browsers require); the new page claims the task and continues from the last completed step (localStorage + BroadcastChannel).'}
						</li>
						<li>
							{isZh
								? '失败兜底：用户未点击或新标签页被关闭时，原页面提示可收回任务继续执行。'
								: 'Failure paths: if the user never clicks or the new tab is closed, the original tab offers to take the task back.'}
						</li>
					</ul>
				</section>

				<section>
					<Heading id="requirements" className="text-2xl font-bold mb-4">
						{isZh ? '前提条件' : 'Requirements'}
					</Heading>
					<ul className="list-disc pl-6 space-y-2 text-gray-700 dark:text-gray-300">
						<li>
							{isZh
								? '所有涉及页面必须同源（同一域名/端口）。多子域场景请用反向代理收敛到同一域名。'
								: 'All involved pages must be same-origin (same host/port). Use a reverse proxy to converge multiple subdomains onto one domain.'}
						</li>
						<li>
							{isZh
								? '每个页面都嵌入同一个 SDK 脚本（服务端全站注入或统一模板）。'
								: 'Every page embeds the same SDK script (server-side injection or a shared template).'}
						</li>
						<li>
							{isZh
								? '浏览器存储可用（sessionStorage / localStorage）。默认策略下新标签页由用户点击卡片打开，无弹窗拦截问题。'
								: 'Browser storage must be available (sessionStorage / localStorage). With the default strategy the new tab is opened by the user clicking the card, so there is no popup-blocker issue.'}
						</li>
					</ul>
				</section>

				<section>
					<Heading id="usage" className="text-2xl font-bold mb-4">
						{isZh ? '接入方式' : 'Usage'}
					</Heading>

					<h3 className="text-lg font-semibold mb-2">
						{isZh ? '脚本标签（演示/快速接入）' : 'Script tag (demo / quick start)'}
					</h3>
					<CodeEditor code={EMBED_SCRIPT} language="markup" />

					<h3 className="text-lg font-semibold mt-6 mb-2">
						{isZh ? 'npm 接入（自定义 UI）' : 'npm (custom UI)'}
					</h3>
					<CodeEditor code={CONFIG_TS} language="typescript" />
				</section>

				<section>
					<Heading id="limitations" className="text-2xl font-bold mb-4">
						{isZh ? '边界与限制' : 'Limitations'}
					</Heading>
					<ul className="list-disc pl-6 space-y-2 text-gray-700 dark:text-gray-300">
						<li>
							{isZh
								? '只覆盖自己域内的页面，出域即停；无 chrome.tabs 级别能力（关闭任意标签页、标签分组等）。'
								: 'Only same-origin pages are covered; leaving the domain stops the task. There are no chrome.tabs-level powers (closing arbitrary tabs, tab groups, etc.).'}
						</li>
						<li>
							{isZh
								? '交接最多丢失一个在途步骤（LLM 请求未完成），从最后一个已完成步骤续接。'
								: 'At most one in-flight LLM step is lost on handoff; the task resumes from the last completed step.'}
						</li>
						<li>
							{isZh
								? '必须开新标签页时默认由用户点击确认（浏览器弹窗拦截）；placeholder 策略为实验性开关，需要宿主在任务开始手势中预留窗口。'
								: 'Opening a new tab requires the user to confirm by clicking (popup blocker); the placeholder strategy is experimental and requires the host to reserve a window in the task-start gesture.'}
						</li>
						<li>
							{isZh
								? '点击触发的新标签页行为（window.open、target=_blank 链接/表单）会被执行器确定性拦截，并向模型反馈尝试的 URL：浏览器能否真弹出取决于残留的用户手势，跨页跳转统一走 open_new_tab 交接流程。'
								: 'New-tab side effects of clicks (window.open, target=_blank links/forms) are intercepted deterministically by the executor and reported to the model with the attempted URL; whether the browser would actually allow them depends on leftover transient user activation, so all cross-tab movement goes through the open_new_tab handoff flow.'}
						</li>
						<li>
							{isZh
								? '同一任务同时只应有一个活跃宿主；手动打开第二个同源页面会显示“继续任务”卡片而不会自动抢占运行中的任务。'
								: 'Only one active host per task; manually opening a second same-origin page shows a "continue task?" card and never auto-steals a running task.'}
						</li>
					</ul>
				</section>
			</div>
		</div>
	)
}
