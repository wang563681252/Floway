// Copilot accepts GPT-5.6 Sol on its Anthropic Messages count endpoint even
// though the model catalog advertises only OpenAI Responses for generation.
// Keep this operation-specific: declaring Anthropic Messages on the model
// would incorrectly move ordinary generation off the OpenAI Responses wire.
//
// The reference implementation applies one model mapping set to Anthropic
// Messages, Messages count_tokens, OpenAI Responses, and Chat Completions:
// https://github.com/caozhiyuan/copilot-api/blob/acb4cf387e0313e558586f843ab6687d0174ca12/src/routes/messages/route.ts
export const copilotModelSupportsAnthropicMessagesCountTokens = (modelId: string): boolean =>
  modelId === 'gpt-5.6-sol';
