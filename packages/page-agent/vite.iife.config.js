// @ts-check
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import cssInjectedByJsPlugin from 'vite-plugin-css-injected-by-js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// UMD Bundle for CDN
// - alias all local packages so that they can be build in
// - no external
// - no d.ts. dts does not work with monorepo aliasing
// Runtime connection options are intentionally supplied by script query parameters.
// Do not inline LLM credentials or private service configuration into this public bundle.
export default defineConfig(() => ({
	plugins: [
		cssInjectedByJsPlugin({ relativeCSSInjection: true }),
		// analyzer()
	],
	publicDir: false,
	build: {
		lib: {
			entry: resolve(__dirname, 'src/demo.ts'),
			name: 'PageAgent',
			fileName: () => `embeding-assistant.js`,
			formats: ['iife'],
		},
		outDir: resolve(__dirname, 'dist', 'iife'),
		cssCodeSplit: true,
		// minify: false,
		rollupOptions: {
			// output: {
			// 	// force use .js as extension
			// 	entryFileNames: 'page-agent.js',
			// },
			onwarn: function (message, handler) {
				if (message.code === 'EVAL') return
				handler(message)
			},
		},
	},
}))
