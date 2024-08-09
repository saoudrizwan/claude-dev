export type ApiProvider = "anthropic" | "openrouter" | "bedrock" | "vertex"

export interface ApiHandlerOptions {
	apiKey?: string // anthropic
	openRouterApiKey?: string
	awsAccessKey?: string
	awsSecretKey?: string
	awsRegion?: string
	gcRegion?: string
	gcProjectId?: string
}

export type ApiConfiguration = ApiHandlerOptions & {
	apiProvider?: ApiProvider
}
