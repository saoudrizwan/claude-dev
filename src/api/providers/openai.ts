import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI, { AzureOpenAI } from "openai"
import { withRetry } from "../retry"
import { ApiHandlerOptions, azureOpenAiDefaultApiVersion, ModelInfo, openAiModelInfoSaneDefaults } from "../../shared/api"
import { ApiHandler } from "../index"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { convertToR1Format } from "../transform/r1-format"
import { ChatCompletionReasoningEffort } from "openai/resources/chat/completions.mjs"

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

	@withRetry()
	async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		const modelId = this.options.openAiModelId ?? ""
		const isDeepseekReasoner = modelId.includes("deepseek-reasoner")

		var openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] 

		if (isDeepseekReasoner) {
			openAiMessages = convertToR1Format([{ role: "user", content: systemPrompt }, ...messages])
		}
		else {
			switch (modelId) {
				case "o1": 
				case "o3-mini": {
					// o1 and o3-mini suggests changing message role from 'system' to 'developer'
					openAiMessages = [
						{ role: "developer", content: systemPrompt },
						...convertToOpenAiMessages(messages),
					]
					break
				}
				case "o1-preview":
				case "o1-mini": {
					// o1-preview and o1-mini doesnt support system prompt, reasoning effort, non-1 temp, and streaming
					openAiMessages = [
						{ role: "user", content: systemPrompt },
						...convertToOpenAiMessages(messages),
					]
					const response = await this.client.chat.completions.create({
						model: modelId,
						messages: openAiMessages,
					})
					yield {
						type: "text",
						text: response.choices[0]?.message.content || "",
					}
					yield {
						type: "usage",
						inputTokens: response.usage?.prompt_tokens || 0,
						outputTokens: response.usage?.completion_tokens || 0,
					}
					return
				}
				default: {
					openAiMessages =  [{ role: "system", content: systemPrompt },
						...convertToOpenAiMessages(messages),
					]
					break
				}
			}
		}

		const stream = await this.client.chat.completions.create({
			model: modelId,
			messages: openAiMessages,
			temperature: this.options.isReasoningModel ? undefined : 0,
			stream: true,
			stream_options: { include_usage: true },
			reasoning_effort: this.options.isReasoningModel
				? (this.options.oSeriesReasoningEffortLevel as ChatCompletionReasoningEffort) || "medium"
				: undefined,
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

			if (chunk.usage) {
				yield {
					type: "usage",
					inputTokens: chunk.usage.prompt_tokens || 0,
					outputTokens: chunk.usage.completion_tokens || 0,
				}
			}
		}
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: this.options.openAiModelId ?? "",
			info: this.options.openAiModelInfo ?? openAiModelInfoSaneDefaults,
		}
	}
}
