import type { ModelMessage, JSONValue, LanguageModel } from "ai";

function isAnthropicModel(model: LanguageModel): boolean {
  if (typeof model === "string") {
    return model.includes("anthropic") || model.includes("claude");
  }
  return (
    model.provider === "anthropic" ||
    model.provider.includes("anthropic") ||
    model.modelId.includes("anthropic") ||
    model.modelId.includes("claude")
  );
}

/**
 * Adds provider-specific cache control options to messages for optimal caching.
 *
 * Currently supports Anthropic models with ephemeral cache control. This pattern
 * can be extended to support other providers with different caching strategies.
 *
 * For Anthropic: marks the last message with `cacheControl: { type: "ephemeral" }`
 * per their docs - "Mark the final block of the final message with cache_control
 * so the conversation can be incrementally cached."
 *
 * For non-Anthropic models, messages are returned unchanged.
 *
 * @param options - Configuration object
 * @param options.messages - The array of messages to process
 * @param options.model - The language model (used to determine provider-specific behavior)
 * @param options.providerOptions - Custom provider options (defaults to Anthropic ephemeral cache)
 *
 * @example
 * ```ts
 * prepareStep: ({ messages, model, ...rest }) => ({
 *   ...rest,
 *   messages: addCacheControlToMessages({ messages, model }),
 * }),
 * ```
 */
export function addCacheControlToMessages({
  messages,
  model,
  providerOptions = {
    anthropic: { cacheControl: { type: "ephemeral" } },
  },
}: {
  messages: ModelMessage[];
  model: LanguageModel;
  providerOptions?: Record<string, Record<string, JSONValue>>;
}): ModelMessage[] {
  if (messages.length === 0) return messages;
  if (!isAnthropicModel(model)) return messages;

  return messages.map((message, index) => {
    if (index === messages.length - 1) {
      return {
        ...message,
        providerOptions: {
          ...message.providerOptions,
          ...providerOptions,
        },
      };
    }
    return message;
  });
}
