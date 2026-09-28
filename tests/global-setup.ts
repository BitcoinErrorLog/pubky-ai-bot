import {
  assertSuiteDatabaseIdle,
  ensureSuiteDatabase,
  migrateSuiteDatabase,
  pinSuiteDatabaseEnv,
  truncateOwnedTables,
} from "./helpers/suite-database.js";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const url = pinSuiteDatabaseEnv();
  process.env.JEB_BOT_PK ??= "9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y";
  await ensureSuiteDatabase(url);
  await migrateSuiteDatabase(url);
  await assertSuiteDatabaseIdle(url);
  return async () => {
    await truncateOwnedTables(url);
  };
}
