export function isAuthError(err: unknown): boolean {
  if (err && typeof err === "object" && "status" in err) {
    const st = Number((err as { status: unknown }).status);
    if (st === 401 || st === 403) return true;
  }
  const s = String(err).toLowerCase();
  return /\b401\b|\b403\b|unauthorized|forbidden|unauthenticated|session expired|invalid session|not authenticated/.test(
    s,
  );
}

function errText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function isTransientNetwork(err: unknown): boolean {
  const s = errText(err).toLowerCase();
  return /timeout|econn|enotfound|network|502|503|504|\b500\b/.test(s);
}

function isPkarrError(err: unknown): boolean {
  const name = err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
  if (name === "PkarrError") return true;
  return /pkarr operation failed/i.test(errText(err));
}

function isMissingOwnPkarrRecord(err: unknown, botPk: string): boolean {
  if (!botPk || !isPkarrError(err)) return false;
  const text = errText(err);
  if (!/no https endpoints found|record is malformed or missing/i.test(text)) return false;
  return text.includes(`_pubky.${botPk}`);
}

export function isNotRegistered(err: unknown, botPk?: string): boolean {
  if (isTransientNetwork(err)) return false;
  if (botPk && isMissingOwnPkarrRecord(err, botPk)) return true;
  const s = errText(err).toLowerCase();
  return /not registered|not found|unknown (user|key)|does not exist|no such user|\b404\b|signup required|unregistered/.test(
    s,
  );
}

export type AuthFailureReason = "missing_pkarr" | "not_registered" | "transient" | "unknown";

export function classifyAuthFailure(err: unknown, botPk?: string): AuthFailureReason {
  if (botPk && isMissingOwnPkarrRecord(err, botPk)) return "missing_pkarr";
  if (isTransientNetwork(err)) return "transient";
  if (isNotRegistered(err, botPk)) return "not_registered";
  return "unknown";
}

export class PublisherAuthError extends Error {
  readonly code = "failed_auth";
  constructor(message: string) {
    super(message);
    this.name = "PublisherAuthError";
  }
}
