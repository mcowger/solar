/**
 * Shared domain types used across server and web.
 *
 * The tRPC `AppRouter` type is exported from `@solar/server` (its natural home,
 * since the router is implemented there) and imported type-only by the web app.
 * This package holds framework-agnostic domain types shared by both sides.
 */

export type Role = "admin" | "user";

/** Placeholder shared type; real domain types land with M1. */
export interface HealthStatus {
  ok: boolean;
  service: string;
}
