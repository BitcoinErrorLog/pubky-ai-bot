import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseMigrator } from "./infrastructure/database/migrator.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("DatabaseMigrator migration cache", () => {
  it("loads migration files once for repeated readiness checks", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pubchi-migrations-"));
    tempDirs.push(dir);
    await writeFile(path.join(dir, "001_first.sql"), "SELECT 1;");
    const migrator = new DatabaseMigrator({} as never, dir);

    const first = await migrator.loadMigrations();
    await rm(path.join(dir, "001_first.sql"));
    const second = await migrator.loadMigrations();

    expect(first).toEqual(second);
    expect(second).toEqual([{ id: 1, filename: "001_first.sql", sql: "SELECT 1;" }]);
  });
});
