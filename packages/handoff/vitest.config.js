import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		silent: 'passed-only',
		include: ['src/**/*.test.ts'],
		environment: 'happy-dom',
		environmentOptions: {
			happyDOM: {
				// Same origin used by the tests (cross-origin replaceState would throw).
				url: 'https://example.test/app',
			},
		},
	},
})
