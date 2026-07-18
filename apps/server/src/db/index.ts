import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "kysely-bun-sqlite";
import { config } from "../config";
import type { Database } from "./schema";

/**
 * Single shared SQLite connection for the whole process. The same underlying
 * `bun:sqlite` Database backs both our Kysely instance and Better Auth (see
 * `auth.ts`), so app tables and auth tables live in one `solar.db` and can be
 * joined directly.
 */
export const sqlite = new BunDatabase(config.dbPath, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

export const dialect = new BunSqliteDialect({ database: sqlite });

export const db = new Kysely<Database>({ dialect });
