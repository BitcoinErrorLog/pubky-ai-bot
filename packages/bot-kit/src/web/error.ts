export class WebToolError extends Error {
  readonly code: string;
  constructor(code: string, message = "web search unavailable") {
    super(message);
    this.code = code;
    this.name = "WebToolError";
  }

  toPublic(): { error: string; message: string } {
    return { error: this.code, message: "web search unavailable" };
  }
}

export function webUnavailable(code = "UNAVAILABLE"): { error: string; message: string } {
  return new WebToolError(code).toPublic();
}
