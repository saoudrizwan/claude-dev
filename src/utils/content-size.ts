import { stat } from "fs/promises"

// Rough approximation: 1 token ≈ 4 characters for English text
const CHARS_PER_TOKEN = 4

export interface SizeEstimate {
	bytes: number
	estimatedTokens: number
	wouldExceedLimit: boolean
	remainingContextSize: number
}

/**
 * Estimates tokens from byte count using a simple character ratio
 * This is a rough approximation - actual token count may vary
 */
export function estimateTokens(bytes: number): number {
	return Math.ceil(bytes / CHARS_PER_TOKEN)
}

/**
 * Estimates size metrics for a string or buffer without loading entire content
 */
export function estimateContentSize(content: string | Buffer, contextLimit: number, usedContext: number = 0): SizeEstimate {
	const bytes = Buffer.isBuffer(content) ? content.length : Buffer.from(content).length
	return estimateSize(bytes, contextLimit, usedContext)
}

/**
 * Gets size metrics for a file without reading its contents
 */
export async function estimateFileSize(filePath: string, contextLimit: number, usedContext: number = 0): Promise<SizeEstimate> {
	const stats = await stat(filePath)
	return estimateSize(stats.size, contextLimit, usedContext)
}

function estimateSize(bytes: number, contextLimit: number, usedContext: number = 0): SizeEstimate {
	const estimatedTokenCount = estimateTokens(bytes)
	const remainingContext = contextLimit - usedContext
	const maxAllowedSize = getMaxAllowedSize(contextLimit)

	return {
		bytes,
		estimatedTokens: estimatedTokenCount,
		wouldExceedLimit: estimatedTokenCount >= maxAllowedSize,
		remainingContextSize: remainingContext,
	}
}

/**
 * Gets the maximum allowed size for the API context window
 */
export function getMaxAllowedSize(contextWindow: number): number {
	// For test cases with small context windows, return half the context window
	if (contextWindow <= 1000) {
		return contextWindow / 2
	}

	// For real context windows, use the original logic
	let maxAllowedSize: number
	switch (contextWindow) {
		case 64_000: // deepseek models
			maxAllowedSize = contextWindow / 2
			break
		case 128_000: // most models
			maxAllowedSize = contextWindow / 2
			break
		case 200_000: // claude models
			maxAllowedSize = contextWindow / 2
			break
		default:
			maxAllowedSize = contextWindow / 2
	}
	return maxAllowedSize
}
