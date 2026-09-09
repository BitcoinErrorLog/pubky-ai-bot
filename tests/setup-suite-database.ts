import { databaseName, pinSuiteDatabaseEnv, suiteDatabaseName } from "./helpers/suite-database.js";

const url = pinSuiteDatabaseEnv();
const name = databaseName(url);
if (name !== suiteDatabaseName()) {
  throw new Error(`test worker DATABASE_URL names ${name}, expected ${suiteDatabaseName()}`);
}
if (process.env.JEB_DB_URL_REASON || process.env.JEB_DB_URL_INGEST) {
  throw new Error("test worker must not keep JEB_DB_URL_REASON / JEB_DB_URL_INGEST (they can point a role at a live database)");
}
