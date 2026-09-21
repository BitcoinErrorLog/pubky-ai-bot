import { describe, expect, it, vi } from "vitest";
import { emitImageEvent } from "./image-observability.js";
import { log } from "./log.js";
import { metrics } from "./metrics.js";

describe("image observability isolation", () => {
  it("never masks product work when logging or metrics fail", () => {
    const logger = vi.spyOn(log, "info").mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const counter = vi.spyOn(metrics, "incrementImageEvent").mockImplementation(() => {
      throw new Error("metrics unavailable");
    });
    expect(() =>
      emitImageEvent(
        "info",
        "reservation",
        "image_reservation",
        "reserved",
        { target_estimated_tokens: 123, duration_ms: 4 },
        "image reservation completed",
      )
    ).not.toThrow();
    logger.mockRestore();
    counter.mockRestore();
  });
});
