/** Bound on waiting for an in-flight loop tick (or child process) before closing resources. */
export const SHUTDOWN_GRACE_MS = 10_000;

export class StoppingError extends Error {
  constructor(message = "stopping") {
    super(message);
    this.name = "StoppingError";
  }
}

/** Resolves when `p` settles or `ms` elapses, whichever first. */
export async function awaitWithGrace(p: Promise<unknown> | null | undefined, ms = SHUTDOWN_GRACE_MS): Promise<void> {
  if (!p) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      p.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
