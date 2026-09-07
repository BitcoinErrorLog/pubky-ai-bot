import {
  assertSuiteDatabaseIdle,
  ensureSuiteDatabase,
  migrateSuiteDatabase,
  pinSuiteDatabaseEnv,
  truncateOwnedTables,
} from "./helpers/suite-database.js";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const url = pinSuiteDatabaseEnv();
  await ensureSuiteDatabase(url);
  await migrateSuiteDatabase(url);
  await assertSuiteDatabaseIdle(url);
  return async () => {
    await truncateOwnedTables(url);
  };
}
