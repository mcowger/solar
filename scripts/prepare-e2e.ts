import { rm } from "node:fs/promises";

const E2E_ARTIFACTS = [
	new URL("../.e2e.db", import.meta.url),
	new URL("../.e2e.db-shm", import.meta.url),
	new URL("../.e2e.db-wal", import.meta.url),
	new URL("../.e2e-attachments", import.meta.url),
];

await Promise.all(
	E2E_ARTIFACTS.map((artifact) =>
		rm(artifact, { recursive: true, force: true }),
	),
);
