import { LogLayer, StructuredTransport, type LogLevelType } from "loglayer";
import { serializeError } from "serialize-error";

const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export type SolarLogLevel = (typeof LOG_LEVELS)[number];

function initialLevel(): SolarLogLevel {
  const value = process.env.SOLAR_LOG_LEVEL;
  if (value && LOG_LEVELS.includes(value as SolarLogLevel)) return value as SolarLogLevel;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

let level = initialLevel();

export const logger = new LogLayer({
  errorSerializer: serializeError,
  transport: new StructuredTransport({ logger: console }),
});

logger.setLevel(level);

export function getLogLevel(): SolarLogLevel {
  return level;
}

export function setLogLevel(nextLevel: SolarLogLevel): void {
  level = nextLevel;
  logger.setLevel(nextLevel as LogLevelType);
  logger.info(`log level changed to ${nextLevel}`);
}
