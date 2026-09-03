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

export function isNotRegistered(err: unknown): boolean {
  const s = String(err).toLowerCase();
  if (/timeout|econn|enotfound|network|502|503|504|\b500\b/.test(s)) return false;
  return /not registered|not found|unknown (user|key)|does not exist|no such user|\b404\b|signup required|unregistered/.test(
    s,
  );
}

export class PublisherAuthError extends Error {
  readonly code = "failed_auth";
  constructor(message: string) {
    super(message);
    this.name = "PublisherAuthError";
  }
}
