import { spawnSync } from "node:child_process";

const context = process.env.SOLAR_DEPLOY_DOCKER_CONTEXT ?? "dolphin";
const sshHost = process.env.SOLAR_DEPLOY_SSH_HOST ?? context;
const stagingUrl = (
	process.env.SOLAR_URL ?? "https://solar.home.cowger.us"
).replace(/\/$/, "");
const containerName = process.env.SOLAR_DEPLOY_CONTAINER_NAME ?? "Solar";
const imageName = process.env.SOLAR_DEPLOY_IMAGE_NAME ?? "solar";
const imageRetention = Number.parseInt(
	process.env.SOLAR_DEPLOY_IMAGE_RETAIN ?? "3",
	10,
);
const healthTimeout = Number.parseInt(
	process.env.SOLAR_DEPLOY_HEALTH_TIMEOUT ?? "60",
	10,
);
const targetPlatform =
	process.env.SOLAR_DEPLOY_TARGET_PLATFORM ?? "linux/amd64";

const timestamp = new Date()
	.toISOString()
	.replace(/[-:]/g, "")
	.replace(/\.\d{3}Z$/, "")
	.replace("T", "-");
const newTag = `${imageName}:staging-${timestamp}`;
const latestTag = `${imageName}:staging-latest`;

function runCommand(
	command: string,
	args: string[],
	options: { env?: NodeJS.ProcessEnv; fatal?: boolean; stream?: boolean } = {},
) {
	const result = spawnSync(command, args, {
		encoding: "utf-8",
		env: options.env,
		stdio: options.stream ? "inherit" : "pipe",
	});
	const success = result.status === 0;
	const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
	const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";

	if (!success && options.fatal !== false) {
		if (stderr) console.error(stderr);
		console.error(`\nCommand failed: ${command} ${args.join(" ")}`);
		process.exit(1);
	}

	return { success, stdout, stderr };
}

function docker(
	args: string[],
	options: { fatal?: boolean; stream?: boolean } = {},
) {
	return runCommand("docker", ["--context", context, ...args], options);
}

function shellQuote(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function compose(workingDir: string, project: string) {
	return runCommand("ssh", [
		sshHost,
		`cd ${shellQuote(workingDir)} && docker compose --project-name ${shellQuote(project)} up --detach --force-recreate solar`,
	]);
}

function sleep(milliseconds: number) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

console.log("Solar staging deploy");
console.log(`  Context: ${context}`);
console.log(`  SSH host: ${sshHost}`);
console.log(`  URL: ${stagingUrl}`);
console.log(`  Container: ${containerName}`);
console.log(`  New image: ${newTag}`);

const inspect = docker(["inspect", "--format", "{{json .}}", containerName], {
	fatal: false,
});
let previous:
	| {
			image: string;
			imageId: string;
			status: string;
			composeWorkingDir: string;
			composeProject: string;
	  }
	| undefined;
if (inspect.success && inspect.stdout) {
	try {
		const container = JSON.parse(inspect.stdout) as {
			Config?: {
				Image?: string;
				Labels?: Record<string, string>;
			};
			Image?: string;
			State?: { Status?: string };
		};
		if (!container.Config?.Image || !container.Image)
			throw new Error("missing image details");
		const composeWorkingDir =
			container.Config.Labels?.["com.docker.compose.project.working_dir"];
		const composeProject =
			container.Config.Labels?.["com.docker.compose.project"];
		if (!composeWorkingDir || !composeProject)
			throw new Error("missing Compose project metadata");
		previous = {
			image: container.Config.Image,
			imageId: container.Image,
			status: container.State?.Status ?? "unknown",
			composeWorkingDir,
			composeProject,
		};
		console.log(
			`  Current image: ${previous.image} (${previous.imageId}, ${previous.status})`,
		);
		console.log(`  Compose project: ${composeProject} (${composeWorkingDir})`);
	} catch {
		console.error(`\nCould not read the current image for ${containerName}.`);
		process.exit(1);
	}
}

if (!previous) {
	console.error(
		"\nCannot deploy without an existing Compose-managed Solar container.",
	);
	process.exit(1);
}

console.log("\nBuilding on the staging host...");
docker(
	["build", "--platform", targetPlatform, "-t", newTag, "-t", latestTag, "."],
	{ stream: true },
);
console.log(`\nRecreating ${containerName} through Compose...`);
compose(previous.composeWorkingDir, previous.composeProject);

const updated = docker(["inspect", "--format", "{{.Image}}", containerName], {
	fatal: false,
});
if (
	!updated.success ||
	!updated.stdout ||
	(previous && updated.stdout === previous.imageId)
) {
	console.error("\nDeploy did not replace the running image.");
	process.exit(1);
}

console.log(`  Image updated: ${updated.stdout}`);
console.log(`\nWaiting for ${stagingUrl}/healthz...`);
let healthy = false;
for (let elapsed = 1; elapsed <= healthTimeout; elapsed += 1) {
	await sleep(1000);
	try {
		const response = await fetch(`${stagingUrl}/healthz`, {
			signal: AbortSignal.timeout(5000),
		});
		const body = (await response.json()) as { ok?: boolean };
		if (response.ok && body.ok === true) {
			healthy = true;
			console.log(`  Healthy after ${elapsed}s.`);
			break;
		}
	} catch {
		// The server is still starting.
	}
}

if (!healthy) {
	console.error("\nHealth check failed. Recent container logs:");
	docker(["logs", "--tail", "50", containerName], { fatal: false });
	process.exit(1);
}

const historyOutput =
	process.env.SOLAR_HISTORY_OUTPUT ?? `.staging-history/${timestamp}.json`;
console.log(`\nExporting all staging chat history to ${historyOutput}...`);
runCommand(
	"bun",
	[
		"run",
		"solar",
		"history",
		"export-all",
		"--url",
		stagingUrl,
		"--output",
		historyOutput,
	],
	{
		stream: true,
	},
);

const images = docker(["images", imageName, "--format", "{{.Tag}}"], {
	fatal: false,
});
if (images.success) {
	const staleTags = images.stdout
		.split("\n")
		.filter((tag) => tag.startsWith("staging-") && tag !== "staging-latest")
		.slice(imageRetention);
	for (const tag of staleTags)
		docker(["rmi", `${imageName}:${tag}`], { fatal: false });
}

console.log(`\nDeploy complete: ${newTag}`);
