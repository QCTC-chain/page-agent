import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		name: 'page-agent',
		include: ['src/**/*.test.ts'],
		silent: 'passed-only',
	},
})
