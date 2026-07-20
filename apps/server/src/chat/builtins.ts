import { Type } from "@earendil-works/pi-ai";
import { evaluate } from "mathjs";
import type { ResolvedTool } from "./mcp";

const asText = (value: unknown) =>
	typeof value === "string" ? value : JSON.stringify(value, null, 2);

function getCurrentDatetime(args: { timeZone?: string }): {
	content: string;
	isError: boolean;
} {
	const now = new Date();
	try {
		const timeZone = args.timeZone;
		const formatted = new Intl.DateTimeFormat("en-US", {
			timeZone,
			dateStyle: "full",
			timeStyle: "long",
		}).format(now);
		return {
			content: asText({
				iso: now.toISOString(),
				unix: Math.floor(now.getTime() / 1000),
				timeZone: timeZone ?? "UTC",
				formatted,
			}),
			isError: false,
		};
	} catch (error) {
		return {
			content: `Invalid time zone: ${args.timeZone} (${(error as Error).message})`,
			isError: true,
		};
	}
}

function getTimezoneInfo(args: { timeZone: string }): {
	content: string;
	isError: boolean;
} {
	const now = new Date();
	try {
		const utcOffset =
			new Intl.DateTimeFormat("en-US", {
				timeZone: args.timeZone,
				timeZoneName: "longOffset",
			})
				.formatToParts(now)
				.find((part) => part.type === "timeZoneName")?.value ?? "unknown";
		const abbreviation =
			new Intl.DateTimeFormat("en-US", {
				timeZone: args.timeZone,
				timeZoneName: "short",
			})
				.formatToParts(now)
				.find((part) => part.type === "timeZoneName")?.value ?? "unknown";
		return {
			content: asText({
				timeZone: args.timeZone,
				utcOffset,
				abbreviation,
				localTime: new Intl.DateTimeFormat("en-US", {
					timeZone: args.timeZone,
					dateStyle: "full",
					timeStyle: "long",
				}).format(now),
			}),
			isError: false,
		};
	} catch (error) {
		return {
			content: `Invalid time zone: ${args.timeZone} (${(error as Error).message})`,
			isError: true,
		};
	}
}

function calculate(args: { expression: string }): {
	content: string;
	isError: boolean;
} {
	try {
		return { content: String(evaluate(args.expression)), isError: false };
	} catch (error) {
		return {
			content: `Could not evaluate expression: ${(error as Error).message}`,
			isError: true,
		};
	}
}

const builtin = (
	name: string,
	description: string,
	parameters: ResolvedTool["tool"]["parameters"],
	execute: (args: Record<string, unknown>) => {
		content: string;
		isError: boolean;
	},
): ResolvedTool => ({
	tool: { name, description, parameters },
	serverName: "builtin",
	remoteName: name,
	execute: async (args) => execute(args),
});

export function resolveBuiltinTools(): ResolvedTool[] {
	return [
		builtin(
			"get_current_datetime",
			'Get the current date and time as an ISO 8601 string, Unix timestamp, and a human-readable form. Optionally provide an IANA time zone (e.g. "America/New_York") to localize the result; defaults to UTC.',
			Type.Object({
				timeZone: Type.Optional(
					Type.String({
						description: 'IANA time zone name, e.g. "Europe/London".',
					}),
				),
			}),
			(args) => getCurrentDatetime(args as { timeZone?: string }),
		),
		builtin(
			"get_timezone_info",
			'Get the current UTC offset, abbreviation, and local time for an IANA time zone (e.g. "Asia/Tokyo").',
			Type.Object({
				timeZone: Type.String({
					description: 'IANA time zone name, e.g. "Asia/Tokyo".',
				}),
			}),
			(args) => getTimezoneInfo(args as { timeZone: string }),
		),
		builtin(
			"calculator",
			'Evaluate a mathematical expression and return the result. Supports arithmetic, functions (sqrt, sin, log, ...), and unit conversions (e.g. "2 cm to inch").',
			Type.Object({
				expression: Type.String({
					description: 'Expression to evaluate, e.g. "(3 + 4) * 2".',
				}),
			}),
			(args) => calculate(args as { expression: string }),
		),
	];
}
