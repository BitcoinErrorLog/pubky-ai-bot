type AsyncCleanup = () => Promise<void>;

export async function teardownEvalResources(
  endPool: AsyncCleanup,
  disposeEmbeddings: AsyncCleanup,
  primaryExitCode: number | undefined,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await endPool();
  } catch (error) {
    errors.push(error);
  }
  try {
    await disposeEmbeddings();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0 && (primaryExitCode === undefined || primaryExitCode === 0)) {
    throw new AggregateError(errors, "evaluation teardown failed");
  }
}
