import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const outputPath = fileURLToPath(new URL('../dist/iife/embeding-assistant.js', import.meta.url))
const forbiddenPatterns = [
	'HERMES_GATEWAY_API_KEY_REF',
	'HERMES_GATEWAY_BASE_URL',
	'LLM_API_KEY',
	'LLM_BASE_URL',
	'LLM_MODEL_NAME',
	'Do not call Hermes server-side tools',
	'localhost',
	'127.0.0.1',
	'.internal',
]
const credentialPatterns = [/\bsk-[A-Za-z0-9_-]{8,}\b/, /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i]

/**
 * Verify that the distributed IIFE only contains public browser runtime code.
 * Extra deployment-specific values can be supplied as comma-separated values
 * through PUBLIC_IIFE_FORBIDDEN_VALUES without printing them to build logs.
 */
async function verifyPublicIife() {
	const bundle = await readFile(outputPath, 'utf8')
	const deploymentValues = (process.env.PUBLIC_IIFE_FORBIDDEN_VALUES || '')
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean)
	const matches = [
		...forbiddenPatterns.filter((value) => bundle.includes(value)),
		...deploymentValues.filter((value) => bundle.includes(value)),
		...credentialPatterns
			.filter((pattern) => pattern.test(bundle))
			.map((pattern) => pattern.toString()),
	]

	if (matches.length > 0) {
		throw new Error(
			`Public IIFE contains forbidden sensitive content (${matches.length} match(es))`
		)
	}
}

await verifyPublicIife()
