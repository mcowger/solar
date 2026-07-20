import { Type } from "@earendil-works/pi-ai";
import { evaluate } from "mathjs";
import type { ResolvedTool } from "./mcp";

export interface UserLocation {
	timeZone?: string;
	latitude?: number;
	longitude?: number;
	accuracy?: number;
	timestamp?: number;
	displayName?: string;
	city?: string;
	region?: string;
	country?: string;
	countryCode?: string;
}

const asText = (value: unknown) =>
	typeof value === "string" ? value : JSON.stringify(value, null, 2);

function formatDateTime(timeZone: string): string | undefined {
	try {
		return new Intl.DateTimeFormat("en-US", {
			timeZone,
			dateStyle: "full",
			timeStyle: "long",
		}).format(new Date());
	} catch {
		return undefined;
	}
}

function formatTimezoneInfo(timeZone: string): string | undefined {
	const now = new Date();
	try {
		const utcOffset =
			new Intl.DateTimeFormat("en-US", {
				timeZone,
				timeZoneName: "longOffset",
			})
				.formatToParts(now)
				.find((part) => part.type === "timeZoneName")?.value ?? "unknown";
		const abbreviation =
			new Intl.DateTimeFormat("en-US", {
				timeZone,
				timeZoneName: "short",
			})
				.formatToParts(now)
				.find((part) => part.type === "timeZoneName")?.value ?? "unknown";
		return `${timeZone} (${abbreviation}, ${utcOffset})`;
	} catch {
		return undefined;
	}
}

/** Render the built-in context values supported in preset system prompts. */
export function renderBuiltinPromptInterpolations(
	systemPrompt: string | null | undefined,
	userLocation?: UserLocation,
): string | null | undefined {
	if (!systemPrompt) return systemPrompt;
	const timeZone = userLocation?.timeZone ?? "UTC";
	const values = {
		get_current_datetime: formatDateTime(timeZone) ?? "unknown",
		get_user_location: userLocation?.displayName ?? "unknown",
		get_timezone_info: formatTimezoneInfo(timeZone) ?? "unknown",
	};
	return systemPrompt.replace(
		/{{(get_current_datetime|get_user_location|get_timezone_info)}}/g,
		(_, name: keyof typeof values) => values[name],
	);
}

function getCurrentDatetime(
	args: { timeZone?: string },
	userLocation?: UserLocation,
): {
	content: string;
	isError: boolean;
} {
	const now = new Date();
	try {
		const timeZone = args.timeZone ?? userLocation?.timeZone;
		const localTimeZone = timeZone ?? "UTC";
		const local = new Intl.DateTimeFormat("en-US", {
			timeZone: localTimeZone,
			dateStyle: "full",
			timeStyle: "long",
		}).format(now);
		return {
			content: asText({
				unix: Math.floor(now.getTime() / 1000),
				utc: now.toISOString(),
				local: { timeZone: localTimeZone, formatted: local },
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

function getUserLocation(userLocation?: UserLocation): {
	content: string;
	isError: boolean;
} {
	return {
		content: asText({
			timeZone: userLocation?.timeZone ?? "UTC",
			latitude: userLocation?.latitude,
			longitude: userLocation?.longitude,
			accuracy: userLocation?.accuracy,
			timestamp: userLocation?.timestamp,
			displayName: userLocation?.displayName,
			city: userLocation?.city,
			region: userLocation?.region,
			country: userLocation?.country,
			countryCode: userLocation?.countryCode,
		}),
		isError: false,
	};
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

export function resolveBuiltinTools(
	userLocation?: UserLocation,
): ResolvedTool[] {
	return [
		builtin(
			"get_current_datetime",
			'Get the current date and time in UTC and the user\'s local time zone, plus a Unix timestamp. Optionally provide an IANA time zone (e.g. "America/New_York") to override the browser time zone.',
			Type.Object({
				timeZone: Type.Optional(
					Type.String({
						description: 'IANA time zone name, e.g. "Europe/London".',
					}),
				),
			}),
			(args) => getCurrentDatetime(args as { timeZone?: string }, userLocation),
		),
		builtin(
			"get_user_location",
			"Get the user’s browser-provided location, including IANA time zone and, when permission was granted, latitude, longitude, and accuracy.",
			Type.Object({}),
			() => getUserLocation(userLocation),
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
