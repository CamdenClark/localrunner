import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";
import * as schema from "./schema";

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (db) return db;

  const dir = join(homedir(), ".localrunner");
  mkdirSync(dir, { recursive: true });

  const dbPath = join(dir, "localrunner.db");
  const sqlite = new Database(dbPath);
  sqlite.exec("PRAGMA journal_mode=WAL");

  db = drizzle(sqlite, { schema });

  migrate(db, { migrationsFolder: join(import.meta.dir, "migrations") });

  return db;
}
