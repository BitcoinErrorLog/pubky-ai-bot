import { describe, expect, it } from "vitest";
import {
  estimateModelCallHardUpperBound,
  MODEL_CALL_FIXED_OVERHEAD_TOKENS,
  withoutImages,
} from "./model-call-budget.js";

describe("model call hard upper bound", () => {
  it("dominates serialized UTF-8 bytes plus visual and bounded output", () => {
    const text = "🙂".repeat(100);
    const messages = [{
      role: "user" as const,
      content: [
        { type: "text" as const, text },
        { type: "image" as const, image: new Uint8Array([1, 2, 3]), mimeType: "image/png" as const },
      ],
    }];
    const bound = estimateModelCallHardUpperBound({
      messages,
      toolSchemas: [{ name: "x", parameters: { type: "object" } }],
      visualTokens: 1_536,
      maxOutputTokens: 4_096,
    });
    expect(bound).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify({ messages: withoutImages(messages), tools: [] }), "utf8") +
      1_536 + 4_096 + MODEL_CALL_FIXED_OVERHEAD_TOKENS,
    );
  });

  it("fails closed on cyclic request data", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => estimateModelCallHardUpperBound({
      messages: [{ role: "user", content: "bounded" }],
      toolSchemas: [cyclic],
      visualTokens: 1,
      maxOutputTokens: 1,
    })).toThrow(/cycle/);
  });
});
