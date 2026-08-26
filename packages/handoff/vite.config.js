// @ts-check
import chalk from 'chalk'
import { dirname, resolve } from 'path'
import dts from 'unplugin-dts/vite'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))

console.log(chalk.cyan(`📦 Building @page-agent/handoff`))

export default defineConfig({
	clearScreen: false,
	plugins: [
		dts({
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts'],
			bundleTypes: true,
			compilerOptions: {
				composite: true,
				noEmit: false,
				emitDeclarationOnly: true,
				declaration: true,
			},
		}),
	],
	publicDir: false,
	build: {
		lib: {
			entry: resolve(__dirname, 'src/index.ts'),
			name: 'PageAgentHandoff',
			fileName: 'handoff',
			formats: ['es'],
		},
		outDir: resolve(__dirname, 'dist', 'lib'),
		rollupOptions: {
			external: ['zod', 'zod/v4', /^@page-agent\//],
		},
		minify: false,
		sourcemap: true,
	},
	define: {
		'process.env.NODE_ENV': '"production"',
	},
})
