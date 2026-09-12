import { describe, expect, it, vi } from "vitest";
import { teardownEvalResources } from "./eval-retrieval-lifecycle.js";

describe("retrieval gate teardown", () => {
  it("preserves the undersized-corpus failure when teardown also fails", async () => {
    const endPool = vi.fn().mockRejectedValue(new Error("pool close failed"));
    const dispose = vi.fn().mockRejectedValue(new Error("embedder close failed"));

    await expect(teardownEvalResources(endPool, dispose, 1)).resolves.toBeUndefined();
    expect(endPool).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("fails a successful gate when teardown fails", async () => {
    await expect(
      teardownEvalResources(
        vi.fn().mockResolvedValue(undefined),
        vi.fn().mockRejectedValue(new Error("native teardown failed")),
        0,
      ),
    ).rejects.toThrow("evaluation teardown failed");
  });
});
