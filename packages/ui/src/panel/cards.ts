/**
 * Card HTML generation utilities for Panel
 */
import { escapeHtml } from '../utils'

import styles from './Panel.module.css'

type CardType =
	| 'default'
	| 'input'
	| 'output'
	| 'question'
	| 'observation'
	| 'activity'
	| 'error'
	| 'step'
	| 'doneSuccess'
	| 'doneError'

interface CardOptions {
	icon: string
	content: string | string[]
	meta?: string
	type?: CardType
}

/** Create a single history card */
export function createCard({ icon, content, meta, type }: CardOptions): string {
	const typeClass = type ? styles[type] : ''
	const contentHtml = Array.isArray(content)
		? `<div class="${styles.reflectionLines}">${content.map((line) => `<span>${escapeHtml(line)}</span>`).join('')}</div>`
		: `<span>${escapeHtml(content)}</span>`

	return `
		<div class="${styles.historyItem} ${typeClass}">
			<div class="${styles.historyContent}">
				<span class="${styles.statusIcon}">${icon}</span>
				${contentHtml}
			</div>
			${meta ? `<div class="${styles.historyMeta}">${meta}</div>` : ''}
		</div>
	`
}

interface StepCardOptions {
	number: string
	reflection: string[]
	actionName: string
	actionInput: string
	actionOutput?: string
}

/** Create one grouped step card with reflection and action execution details. */
export function createStepCard({
	number,
	reflection,
	actionName,
	actionInput,
	actionOutput,
}: StepCardOptions): string {
	const reflectionHtml = reflection
		.map(
			(line) =>
				`<div class="${styles.stepReflectionLine} ${styles.expandableText}" data-expandable="true" role="button" tabindex="0" aria-expanded="false">${escapeHtml(line)}</div>`
		)
		.join('')
	const outputHtml = actionOutput
		? `<div class="${styles.stepActionOutput}"><span class="${styles.stepActionOutputIcon}">↳</span><span class="${styles.stepActionOutputText} ${styles.expandableText}" data-expandable="true" role="button" tabindex="0" aria-expanded="false">${escapeHtml(actionOutput)}</span></div>`
		: ''

	return `
		<div class="${styles.historyItem} ${styles.step}">
			<div class="${styles.stepTitle}">Step #${escapeHtml(number)}</div>
			${reflectionHtml ? `<div class="${styles.stepReflections}">${reflectionHtml}</div>` : ''}
			<div class="${styles.stepActionsTitle}">Actions</div>
			<div class="${styles.stepActionName}"><span class="${styles.stepActionIcon}">◉</span><strong>${escapeHtml(actionName)}</strong><span class="${styles.stepActionInput} ${styles.expandableText}" data-expandable="true" role="button" tabindex="0" aria-expanded="false">${escapeHtml(actionInput)}</span></div>
			${outputHtml}
		</div>
	`
}

interface ResultCardOptions {
	success: boolean
	content: string
}

/** Create the final result card shown after a done action. */
export function createResultCard({ success, content }: ResultCardOptions): string {
	const safeContent = escapeHtml(content).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
	const type = success ? styles.doneSuccess : styles.doneError
	const icon = success ? '✓' : '⚠'
	const label = success ? 'Result: Success' : 'Result: Failed'

	return `
		<div class="${styles.historyItem} ${type}">
			<div class="${styles.resultHeader}">
				<span class="${styles.resultIcon}">${icon}</span>
				<strong>${label}</strong>
			</div>
			<div class="${styles.resultContent}">${safeContent}</div>
		</div>
	`
}

/** Create reflection lines from reflection object */
export function createReflectionLines(reflection: {
	evaluation_previous_goal?: string
	memory?: string
	next_goal?: string
}): string[] {
	const lines: string[] = []
	if (reflection.evaluation_previous_goal) {
		lines.push(`🔍 ${reflection.evaluation_previous_goal}`)
	}
	if (reflection.memory) {
		lines.push(`💾 ${reflection.memory}`)
	}
	if (reflection.next_goal) {
		lines.push(`🎯 ${reflection.next_goal}`)
	}
	return lines
}
