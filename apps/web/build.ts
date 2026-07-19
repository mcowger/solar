import { cp, rm } from "node:fs/promises";
import tailwind from "bun-plugin-tailwind";
import { generateSW } from "workbox-build";

const outputDirectory = "../server/dist/web";

await rm(outputDirectory, { recursive: true, force: true });

const result = await Bun.build({
	entrypoints: ["./index.html"],
	outdir: outputDirectory,
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
	minify: true,
	plugins: [tailwind],
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

await cp("./public", outputDirectory, { recursive: true });

await generateSW({
	globDirectory: outputDirectory,
	globPatterns: ["**/*.{html,js,css,woff2,png,webmanifest}"],
	globIgnores: ["sw.js", "workbox-*.js", "fonts/**"],
	swDest: `${outputDirectory}/sw.js`,
	cleanupOutdatedCaches: true,
	clientsClaim: true,
	skipWaiting: true,
	inlineWorkboxRuntime: true,
	maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
	navigateFallback: "/index.html",
	navigateFallbackDenylist: [/^\/(?:api|trpc|healthz)(?:\/|$)/],
});
