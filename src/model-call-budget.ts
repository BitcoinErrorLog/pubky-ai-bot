import type { CoreMessage } from "ai";

/** Provider/message framing allowance beyond the serialized request fields. */
export const MODEL_CALL_FIXED_OVERHEAD_TOKENS = 8_192;
export const MODEL_CALL_MESSAGE_OVERHEAD_TOKENS = 256;
export const MODEL_CALL_TOOL_OVERHEAD_TOKENS = 512;

function jsonBytes(value: unknown): number {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return { binary: "omitted" };
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "function" || typeof item === "symbol" || item === undefined) {
      throw new Error("model request contains an unbounded value");
    }
    if (item && typeof item === "object") {
      if (seen.has(item)) throw new Error("model request contains a cycle");
      seen.add(item);
    }
    return item;
  });
  if (serialized === undefined) throw new Error("model request is not serializable");
  return Buffer.byteLength(serialized, "utf8");
}

/**
 * Hard token upper bound for one image-bearing provider call.
 *
 * For textual/schema input this charges one token per serialized UTF-8 byte.
 * A tokenizer token cannot encode less than one non-empty byte. Binary image
 * bodies are omitted from serialization and charged by the decoded visual
 * estimate. Explicit fixed/per-message/per-tool allowances cover provider
 * framing and special tokens; output is bounded independently at the provider.
 */
export function estimateModelCallHardUpperBound(args: {
  messages: CoreMessage[];
  toolSchemas?: unknown[];
  visualTokens: number;
  maxOutputTokens: number;
}): number {
  if (!Number.isSafeInteger(args.visualTokens) || args.visualTokens <= 0 ||
      !Number.isSafeInteger(args.maxOutputTokens) || args.maxOutputTokens <= 0) {
    throw new Error("invalid model call bound inputs");
  }
  const schemas = args.toolSchemas ?? [];
  const inputBytes = jsonBytes({ messages: args.messages, tools: schemas });
  const bound =
    inputBytes +
    args.visualTokens +
    args.maxOutputTokens +
    MODEL_CALL_FIXED_OVERHEAD_TOKENS +
    args.messages.length * MODEL_CALL_MESSAGE_OVERHEAD_TOKENS +
    schemas.length * MODEL_CALL_TOOL_OVERHEAD_TOKENS;
  if (!Number.isSafeInteger(bound) || bound <= 0) throw new Error("model call bound overflow");
  return bound;
}

export function messagesContainImages(messages: CoreMessage[]): boolean {
  return messages.some((message) =>
    Array.isArray(message.content) &&
    message.content.some((part) => part && typeof part === "object" && "type" in part && part.type === "image"));
}

/** Preserve all text/tool context while removing binary image parts. */
export function withoutImages(messages: CoreMessage[]): CoreMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.filter(
        (part) => !(part && typeof part === "object" && "type" in part && part.type === "image"),
      ),
    } as CoreMessage;
  });
}
