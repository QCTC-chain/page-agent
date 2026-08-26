import { describe, expect, it } from 'vitest'

import { PageController } from './PageController'
import { hoverElement } from './actions'

/**
 * happy-dom has no layout engine: offsetWidth/Height are 0 and
 * elementFromPoint always returns null, so the DOM walker treats every element
 * as invisible/non-top. Patch the layout primitives it relies on, then restore
 * them afterwards (same trick as the hover tests).
 */
async function withLayoutPatched<T>(fn: () => Promise<T>): Promise<T> {
	const original = {
		offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
		offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
		rect: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect'),
		elementFromPoint: Object.getOwnPropertyDescriptor(Document.prototype, 'elementFromPoint'),
	}
	try {
		Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
			configurable: true,
			get: () => 100,
		})
		Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
			configurable: true,
			get: () => 20,
		})
		Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
			configurable: true,
			value: function (this: HTMLElement) {
				const index = Array.from(document.querySelectorAll('a,button')).indexOf(this as HTMLElement)
				const left = index * 100
				return {
					left,
					top: 0,
					right: left + 100,
					bottom: 20,
					width: 100,
					height: 20,
					x: left,
					y: 0,
					toJSON() {},
				}
			},
		})
		Object.defineProperty(Document.prototype, 'elementFromPoint', {
			configurable: true,
			value: function (this: Document, x: number, y: number) {
				return (
					Array.from(this.querySelectorAll('a,button')).find((el) => {
						const rect = el.getBoundingClientRect()
						return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
					}) ?? null
				)
			},
		})
		return await fn()
	} finally {
		for (const [key, descriptor] of Object.entries(original)) {
			const target = key === 'elementFromPoint' ? Document.prototype : HTMLElement.prototype
			if (descriptor) Object.defineProperty(target, key, descriptor)
		}
	}
}

describe('PageController', () => {
	it('constructs and exposes the current url', async () => {
		const controller = new PageController()
		expect(controller).toBeInstanceOf(PageController)
		expect(await controller.getCurrentUrl()).toBe(window.location.href)
	})

	describe('hoverElement', () => {
		it('dispatches the hover event sequence without clicking', async () => {
			document.body.innerHTML = `<button id="menu-trigger">Settings</button>`
			const trigger = document.getElementById('menu-trigger') as HTMLButtonElement

			const fired: string[] = []
			for (const type of [
				'pointermove',
				'mousemove',
				'pointerover',
				'pointerenter',
				'mouseover',
				'mouseenter',
				'click',
			]) {
				trigger.addEventListener(type, () => fired.push(type))
			}

			await hoverElement(trigger)

			expect(fired).toEqual([
				'pointermove',
				'mousemove',
				'pointerover',
				'pointerenter',
				'mouseover',
				'mouseenter',
			])
			expect(fired).not.toContain('click')
		})

		it('exposes hover by index through the controller', async () => {
			// happy-dom has no layout engine: offsetWidth/Height are 0 and
			// elementFromPoint always returns null, so the DOM walker treats
			// every element as invisible/non-top. Patch the layout primitives
			// it relies on, then restore them afterwards.
			const original = {
				offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
				offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
				rect: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect'),
				elementFromPoint: Object.getOwnPropertyDescriptor(Document.prototype, 'elementFromPoint'),
			}
			try {
				Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
					configurable: true,
					get: () => 100,
				})
				Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
					configurable: true,
					get: () => 20,
				})
				Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
					configurable: true,
					value: function (this: HTMLElement) {
						// Place each button side by side so elementFromPoint can pick one.
						const index = Array.from(document.querySelectorAll('button')).indexOf(
							this as HTMLButtonElement
						)
						const left = index * 100
						return {
							left,
							top: 0,
							right: left + 100,
							bottom: 20,
							width: 100,
							height: 20,
							x: left,
							y: 0,
							toJSON() {},
						}
					},
				})
				Object.defineProperty(Document.prototype, 'elementFromPoint', {
					configurable: true,
					value: function (this: Document, x: number, y: number) {
						return (
							Array.from(this.querySelectorAll('button')).find((el) => {
								const rect = el.getBoundingClientRect()
								return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
							}) ?? null
						)
					},
				})

				document.body.innerHTML = `<button>Settings</button><button>Users</button>`
				const controller = new PageController()

				const simplified = await controller.updateTree()
				const match = /\[(\d+)\]<button[^>]*>Users/.exec(simplified)
				expect(match).not.toBeNull()
				const index = Number(match![1])

				const result = await controller.hoverElement(index)

				expect(result).toMatchObject({ success: true })
				expect(result.message).toContain('Hovered')
			} finally {
				for (const [key, descriptor] of Object.entries(original)) {
					const target = key === 'elementFromPoint' ? Document.prototype : HTMLElement.prototype
					if (descriptor) Object.defineProperty(target, key, descriptor)
				}
			}
		})
	})
	describe('clickElement', () => {
		it('refuses target=_blank links and points the model to open_new_tab', async () => {
			await withLayoutPatched(async () => {
				document.body.innerHTML = `<a id="ext" href="/energy" target="_blank">Energy</a>`
				const controller = new PageController()
				await controller.updateTree()

				const result = await controller.clickElement(0)

				expect(result.success).toBe(false)
				expect(result.message).toContain('target="_blank"')
				expect(result.message).toContain('open_new_tab')
				expect(result.message).toContain('/energy')
			})
		})

		it('keeps the full href visible to the model (not truncated to 20 chars)', async () => {
			await withLayoutPatched(async () => {
				document.body.innerHTML = `<a id="ext" href="/monitoring/energy-diagnostics" target="_blank">Energy</a>`
				const controller = new PageController()

				const simplified = await controller.updateTree()

				// The full path must appear in the simplified DOM so the model can
				// pass it to open_new_tab without guessing a truncated URL.
				expect(simplified).toContain('href=/monitoring/energy-diagnostics')
			})
		})

		it('clicks normal links as before', async () => {
			await withLayoutPatched(async () => {
				document.body.innerHTML = `<a id="same" href="/orders">Orders</a>`
				const controller = new PageController()
				await controller.updateTree()

				const result = await controller.clickElement(0)

				expect(result.success).toBe(true)
			})
		})
	})

	describe('executeJavascript', () => {
		it('runs a script and returns its result', async () => {
			const controller = new PageController()
			const result = await controller.executeJavascript('return 1 + 2')
			expect(result).toMatchObject({ success: true })
			expect(result.message).toContain('3')
		})

		it('exposes the abort signal to the script scope', async () => {
			const controller = new PageController()
			const controllerSignal = new AbortController()
			controllerSignal.abort()

			const result = await controller.executeJavascript(
				'return signal.aborted',
				controllerSignal.signal
			)
			expect(result).toMatchObject({ success: true })
			expect(result.message).toContain('true')
		})

		it('reports a syntax error as a failed result', async () => {
			const controller = new PageController()
			const result = await controller.executeJavascript('return (')
			expect(result.success).toBe(false)
			expect(result.message).toContain('❌')
		})
	})
})
