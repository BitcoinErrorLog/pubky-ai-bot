export class WebToolError extends Error {
  readonly code: string;
  readonly billedCostUsd: number;
  constructor(code: string, message = "web search unavailable", billedCostUsd = 0) {
    super(message);
    this.code = code;
    this.billedCostUsd = billedCostUsd;
    this.name = "WebToolError";
  }

  toPublic(): { error: string; message: string } {
    return { error: this.code, message: "web search unavailable" };
  }
}

export function webUnavailable(code = "UNAVAILABLE"): { error: string; message: string } {
  return new WebToolError(code).toPublic();
}
