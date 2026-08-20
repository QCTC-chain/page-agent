import { describe, expect, it } from 'vitest'

import iifeConfig from './vite.iife.config'

describe('public IIFE build configuration', () => {
	it('does not define browser-visible LLM environment values', () => {
		const config = iifeConfig({ command: 'build', mode: 'production' })

		expect(config.define).toBeUndefined()
	})
})
