export class WebToolError extends Error {
  readonly code: string;
  readonly diagnostics?: {
    status?: number;
    trackId?: string;
    chatId?: string;
  };

  constructor(
    code: string,
    message = "web search unavailable",
    diagnostics?: { status?: number; trackId?: string; chatId?: string },
  ) {
    super(message);
    this.code = code;
    this.diagnostics = diagnostics;
    this.name = "WebToolError";
  }

  toPublic(): { error: string; message: string } {
    return { error: this.code, message: "web search unavailable" };
  }
}

export function webUnavailable(code = "UNAVAILABLE"): { error: string; message: string } {
  return new WebToolError(code).toPublic();
}
