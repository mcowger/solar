import { FileMigrationProvider, Migrator } from "kysely";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { logger } from "../logger";
import { db } from "./index";

/**
 * Runs all pending Kysely migrations. Invoked via `bun run migrate` and at
 * server startup so a fresh `solar.db` is always schema-current.
 */
export async function migrateToLatest(): Promise<void> {
	const migrator = new Migrator({
		db,
		provider: new FileMigrationProvider({
			fs,
			path,
			migrationFolder: path.join(import.meta.dir, "migrations"),
		}),
	});

	const { error, results } = await migrator.migrateToLatest();

	for (const r of results ?? []) {
		if (r.status === "Success") {
			logger
				.withMetadata({ migration: r.migrationName })
				.info("migration applied");
		} else if (r.status === "Error") {
			logger
				.withMetadata({ migration: r.migrationName })
				.error("migration failed");
		}
	}

	if (error) {
		logger.withError(error).error("migration error");
		throw error;
	}
}

if (import.meta.main) {
	await migrateToLatest();
	logger.info("migrations up to date");
	process.exit(0);
}
