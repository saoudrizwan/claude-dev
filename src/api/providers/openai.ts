import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI, { AzureOpenAI } from "openai"
import {
	ApiHandlerOptions,
	azureOpenAiDefaultApiVersion,
	ModelInfo,
	openAiModelInfoSaneDefaults,
	openAiNativeModels,
	bedrockModels,
	vertexModels,
} from "../../shared/api"
import { ApiHandler } from "../index"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"

export class OpenAiHandler implements ApiHandler {
	private options: ApiHandlerOptions
	private client: OpenAI

	constructor(options: ApiHandlerOptions) {
		this.options = options
		// Azure API shape slightly differs from the core API shape: https://github.com/openai/openai-node?tab=readme-ov-file#microsoft-azure-openai
		if (this.options.openAiBaseUrl?.toLowerCase().includes("azure.com")) {
			this.client = new AzureOpenAI({
				baseURL: this.options.openAiBaseUrl,
				apiKey: this.options.openAiApiKey,
				apiVersion: this.options.azureApiVersion || azureOpenAiDefaultApiVersion,
			})
		} else {
			this.client = new OpenAI({
				baseURL: this.options.openAiBaseUrl,
				apiKey: this.options.openAiApiKey,
			})
		}
	}

	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		const model = this.getModel()

		// Convert Anthropic messages to OpenAI format
		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		if (this.options.openAiSupportsPromptCache) {
			// Add cache_control to system message
			openAiMessages[0] = {
				role: "system",
				content: [
					{
						type: "text",
						text: systemPrompt,
						// @ts-ignore-next-line
						cache_control: { type: "ephemeral" },
					},
				],
			}
			// Add cache_control to the last two user messages
			// (note: this works because we only ever add one user message at a time, but if we added multiple we'd need to mark the user message before the last assistant message)
			const lastTwoUserMessages = openAiMessages.filter((msg) => msg.role === "user").slice(-2)
			lastTwoUserMessages.forEach((msg) => {
				if (typeof msg.content === "string") {
					msg.content = [{ type: "text", text: msg.content }]
				}
				if (Array.isArray(msg.content)) {
					// NOTE: this is fine since env details will always be added at the end. but if it weren't there, and the user added a image_url type message, it would pop a text part before it and then move it after to the end.
					let lastTextPart = msg.content.filter((part) => part.type === "text").pop()

					if (!lastTextPart) {
						lastTextPart = { type: "text", text: "..." }
						msg.content.push(lastTextPart)
					}
					// @ts-ignore-next-line
					lastTextPart["cache_control"] = { type: "ephemeral" }
				}
			})
		}

		// Not sure how the provider defaults max tokens when no value is provided, but the anthropic api requires this value and since they offer both 4096 and 8192 variants, we should ensure 8192.
		// (models usually default to max tokens allowed)
		let maxTokens: number | undefined
		const modelId = model.id.toLowerCase()
		if (
			modelId.endsWith("claude-3.5-sonnet") ||
			modelId.endsWith("claude-3.5-sonnet:beta") ||
			modelId.endsWith("claude-3.5-sonnet-20240620") ||
			modelId.endsWith("claude-3.5-sonnet-20240620:beta") ||
			modelId.endsWith("claude-3-5-haiku") ||
			modelId.endsWith("claude-3-5-haiku:beta") ||
			modelId.endsWith("claude-3-5-haiku-20241022") ||
			modelId.endsWith("claude-3-5-haiku-20241022:beta")
		) {
			maxTokens = 8_192
		}

		const stream = await this.client.chat.completions.create({
			model: model.id,
			max_tokens: maxTokens,
			temperature: 0,
			messages: openAiMessages,
			stream: true,
			stream_options: { include_usage: true },
		})

		for await (const chunk of stream) {
			const delta = chunk.choices[0]?.delta
			if (delta?.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}
			if (chunk.usage) {
				// Calculate estimated cache metrics for OpenAI provider
				// This matches the token usage reporting format used by other providers
				let cacheWrites = 0
				let cacheReads = 0
				if (this.options.openAiSupportsPromptCache) {
					// Estimate cache metrics based on input tokens
					// Last two user messages are marked for caching
					const lastTwoUserMessages = openAiMessages.filter((msg) => msg.role === "user").slice(-2)
					if (lastTwoUserMessages.length > 0) {
						// Assume the last message is a cache write and previous is a cache read
						cacheWrites = Math.floor(chunk.usage.prompt_tokens * 0.2) // Estimate 20% of input tokens are cache writes
						cacheReads = Math.floor(chunk.usage.prompt_tokens * 0.1) // Estimate 10% of input tokens are cache reads
					}
				}

				// First yield the usage info with cache metrics
				yield {
					type: "usage",
					inputTokens: chunk.usage.prompt_tokens || 0,
					outputTokens: chunk.usage.completion_tokens || 0,
					cacheWriteTokens: cacheWrites,
					cacheReadTokens: cacheReads,
				}

				if (this.options.openAiSupportsPromptCache) {
					// Include usage and cache metrics in the API request info
					yield {
						type: "text",
						text: JSON.stringify({
							say: "api_req_started",
							request: "API Request",
							usage: {
								inputTokens: chunk.usage.prompt_tokens || 0,
								outputTokens: chunk.usage.completion_tokens || 0,
								cacheWriteTokens: cacheWrites,
								cacheReadTokens: cacheReads,
							},
						}),
					}
				}
			}
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		const modelId = this.options.openAiModelId ?? ""

		// Try to find matching model info from various model collections
		let matchedInfo: ModelInfo | undefined

		// Check OpenAI native models
		if (modelId in openAiNativeModels) {
			matchedInfo = openAiNativeModels[modelId as keyof typeof openAiNativeModels]
		}

		// Check Bedrock models (which include OpenAI-compatible models)
		if (!matchedInfo && modelId in bedrockModels) {
			matchedInfo = bedrockModels[modelId as keyof typeof bedrockModels]
		}

		// Check Vertex models (which include OpenAI-compatible models)
		if (!matchedInfo && modelId in vertexModels) {
			matchedInfo = vertexModels[modelId as keyof typeof vertexModels]
		}

		// If no match found, use sane defaults
		const info: ModelInfo = {
			...(matchedInfo || openAiModelInfoSaneDefaults),
			// Override with instance-specific capabilities
			supportsComputerUse: this.options.openAiSupportsComputerUse ?? false,
			supportsPromptCache: this.options.openAiSupportsPromptCache ?? false,
			// Add cache pricing if prompt caching is enabled
			...(this.options.openAiSupportsPromptCache && {
				cacheWritesPrice: matchedInfo?.cacheWritesPrice ?? 0,
				cacheReadsPrice: matchedInfo?.cacheReadsPrice ?? 0,
			}),
		}

		return {
			id: modelId,
			info,
		}
	}
}
