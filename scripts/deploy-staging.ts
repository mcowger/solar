import { spawnSync } from "node:child_process";

const context = process.env.SOLAR_STAGING_DOCKER_CONTEXT ?? "dolphin";
const stagingUrl = (process.env.SOLAR_STAGING_URL ?? "https://solar.home.cowger.us").replace(/\/$/, "");
const containerName = process.env.SOLAR_STAGING_CONTAINER_NAME ?? "Solar";
const imageName = process.env.SOLAR_STAGING_IMAGE_NAME ?? "solar";
const dataDir = process.env.SOLAR_STAGING_DATA_DIR ?? "/mnt/user/appdata/solar";
const port = process.env.SOLAR_STAGING_PORT ?? "3444";
const imageRetention = Number.parseInt(process.env.SOLAR_STAGING_IMAGE_RETAIN ?? "3", 10);
const healthTimeout = Number.parseInt(process.env.SOLAR_STAGING_HEALTH_TIMEOUT ?? "60", 10);
const targetPlatform = process.env.SOLAR_TARGETPLATFORM ?? "linux/amd64";

const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "").replace("T", "-");
const newTag = `${imageName}:staging-${timestamp}`;
const latestTag = `${imageName}:staging-latest`;

function docker(args: string[], options: { fatal?: boolean; stream?: boolean } = {}) {
  const result = spawnSync("docker", ["--context", context, ...args], {
    encoding: "utf-8",
    stdio: options.stream ? "inherit" : "pipe",
  });
  const success = result.status === 0;
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";

  if (!success && options.fatal !== false) {
    if (stderr) console.error(stderr);
    console.error(`\nCommand failed: docker --context ${context} ${args.join(" ")}`);
    process.exit(1);
  }

  return { success, stdout, stderr };
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

console.log("Solar staging deploy");
console.log(`  Context: ${context}`);
console.log(`  URL: ${stagingUrl}`);
console.log(`  Container: ${containerName}`);
console.log(`  Data mount: ${dataDir}:/data`);
console.log(`  New image: ${newTag}`);

const inspect = docker(["inspect", "--format", "{{json .}}", containerName], { fatal: false });
let previous: { image: string; imageId: string; status: string } | undefined;
if (inspect.success && inspect.stdout) {
  try {
    const container = JSON.parse(inspect.stdout) as {
      Config?: { Image?: string };
      Image?: string;
      State?: { Status?: string };
    };
    if (!container.Config?.Image || !container.Image) throw new Error("missing image details");
    previous = { image: container.Config.Image, imageId: container.Image, status: container.State?.Status ?? "unknown" };
    console.log(`  Current image: ${previous.image} (${previous.imageId}, ${previous.status})`);
  } catch {
    console.error(`\nCould not read the current image for ${containerName}.`);
    process.exit(1);
  }
} else {
  console.log("  Initial deployment");
}

console.log("\nBuilding on the staging host...");
docker(
  [
    "build",
    "--platform",
    targetPlatform,
    "-t",
    newTag,
    "-t",
    latestTag,
    ".",
  ],
  { stream: true },
);

if (previous?.status === "running") {
  console.log(`\nTagging ${newTag} as ${previous.image} for the running container...`);
  docker(["tag", newTag, previous.image]);

  console.log(`\nReplacing ${containerName} through Watchtower...`);
  docker([
    "run",
    "--rm",
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock",
    "-e",
    "DOCKER_API_VERSION=1.40",
    "containrrr/watchtower",
    "--run-once",
    "--no-pull",
    containerName,
  ]);
} else {
  if (previous) {
    console.log(`\nRemoving non-running container ${containerName}...`);
    docker(["rm", "-f", containerName]);
  }
  console.log(`\nStarting ${containerName}...`);
  docker([
    "run",
    "-d",
    "--name",
    containerName,
    "--restart",
    "unless-stopped",
    "-p",
    `${port}:3000`,
    "-v",
    `${dataDir}:/data`,
    newTag,
  ]);
}

const updated = docker(["inspect", "--format", "{{.Image}}", containerName], { fatal: false });
if (!updated.success || !updated.stdout || (previous && updated.stdout === previous.imageId)) {
  console.error("\nDeploy did not replace the running image.");
  process.exit(1);
}

console.log(`  Image updated: ${updated.stdout}`);
console.log(`\nWaiting for ${stagingUrl}/healthz...`);
let healthy = false;
for (let elapsed = 1; elapsed <= healthTimeout; elapsed += 1) {
  await sleep(1000);
  try {
    const response = await fetch(`${stagingUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
    const body = await response.json() as { ok?: boolean };
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

const images = docker(["images", imageName, "--format", "{{.Tag}}"], { fatal: false });
if (images.success) {
  const staleTags = images.stdout
    .split("\n")
    .filter((tag) => tag.startsWith("staging-") && tag !== "staging-latest")
    .slice(imageRetention);
  for (const tag of staleTags) docker(["rmi", `${imageName}:${tag}`], { fatal: false });
}

console.log(`\nDeploy complete: ${newTag}`);
