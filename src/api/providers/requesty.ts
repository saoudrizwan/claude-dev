import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { withRetry } from "../retry"
import { ApiHandlerOptions, ModelInfo, openAiModelInfoSaneDefaults } from "../../shared/api"
import { ApiHandler } from "../index"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { convertToR1Format } from "../transform/r1-format"

export class RequestyHandler implements ApiHandler {
	private options: ApiHandlerOptions
	private client: OpenAI

	constructor(options: ApiHandlerOptions) {
		this.options = options
		this.client = new OpenAI({
			baseURL: "https://router.requesty.ai/v1",
			apiKey: this.options.requestyApiKey,
			defaultHeaders: {
				"HTTP-Referer": "https://cline.bot",
				"X-Title": "Cline",
			},
		})
	}

	@withRetry()
	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		const modelId = this.options.requestyModelId ?? ""
		const isDeepseekReasoner = modelId.includes("deepseek-reasoner")

		let openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...convertToOpenAiMessages(messages),
		]

		if (isDeepseekReasoner) {
			openAiMessages = convertToR1Format([{ role: "user", content: systemPrompt }, ...messages])
		}

		const stream = await this.client.chat.completions.create({
			model: modelId,
			messages: openAiMessages,
			temperature: 0,
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

			if (delta && "reasoning_content" in delta && delta.reasoning_content) {
				yield {
					type: "reasoning",
					reasoning: (delta.reasoning_content as string | undefined) || "",
				}
			}

			// Requesty usage includes an extra field for Anthropic use cases.
			// Safely cast the prompt token details section to the appropriate structure.
			interface RequestyUsage extends OpenAI.CompletionUsage {
				prompt_tokens_details?: {
					caching_tokens?: number
					cached_tokens?: number
				}
			}

			if (chunk.usage) {
				const usage = chunk.usage as RequestyUsage
				yield {
					type: "usage",
					inputTokens: usage.prompt_tokens || 0,
					outputTokens: usage.completion_tokens || 0,
					cacheWriteTokens: usage.prompt_tokens_details?.caching_tokens || undefined,
					cacheReadTokens: usage.prompt_tokens_details?.cached_tokens || undefined,
				}
			}
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: this.options.requestyModelId ?? "",
			info: openAiModelInfoSaneDefaults,
		}
	}
}
