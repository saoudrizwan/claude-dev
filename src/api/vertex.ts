import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { Anthropic } from "@anthropic-ai/sdk";
import { ApiHandlerOptions } from "../shared/api";
import { ApiHandler } from ".";

// https://docs.anthropic.com/en/api/claude-on-vertex-ai
export class VertexHandler implements ApiHandler {
	private options: ApiHandlerOptions;
	private client: AnthropicVertex;

	constructor(options: ApiHandlerOptions) {
		this.options = options;
		this.client = new AnthropicVertex({
			projectId: this.options.gcProjectId,
			region: this.options.gcRegion,
		});
	}

	async createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		tools: Anthropic.Messages.Tool[]
	): Promise<Anthropic.Messages.Message> {
		return await this.client.messages.create({
			model: "claude-3-5-sonnet@20240620", // https://docs.anthropic.com/en/docs/about-claude/models
			max_tokens: 4096,
			system: systemPrompt,
			messages,
			tools,
			tool_choice: { type: "auto" },
		});
	}

	createUserReadableRequest(
		userContent: Array<
			| Anthropic.TextBlockParam
			| Anthropic.ImageBlockParam
			| Anthropic.ToolUseBlockParam
			| Anthropic.ToolResultBlockParam
		>
	): any {
		return {
			model: "claude-3-5-sonnet@20240620",
			max_tokens: 4096,
			system: "(see SYSTEM_PROMPT in src/ClaudeDev.ts)",
			messages: [{ conversation_history: "..." }, { role: "user", content: userContent }],
			tools: "(see tools in src/ClaudeDev.ts)",
			tool_choice: { type: "auto" },
		};
	}
}
