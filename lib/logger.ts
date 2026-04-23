/**
 * Isomorphic structured logger backed by Pino.
 *
 * Single public surface:
 *   - `logger`          root singleton (rarely used directly)
 *   - `childLog(ns)`    per-module logger; always prefer this
 *   - `span(log, ...)`  entry/exit + timing wrapper for non-trivial ops
 *
 * Levels and env:
 *   - Server reads `LOG_LEVEL` (defaults: `debug` in dev, `info` in prod).
 *   - Browser reads `NEXT_PUBLIC_LOG_LEVEL` (defaults to `info`; flip to
 *     `debug` in-session when investigating).
 *
 * In development on the server, output goes through `pino-pretty` for
 * colorized, readable logs. In the browser, `asObject: true` preserves
 * the structured payload so devtools can expand fields.
 */

import pino, { type Logger, stdSerializers } from "pino";

const IS_BROWSER = typeof window !== "undefined";
const IS_PROD = process.env.NODE_ENV === "production";

const serverLevel = process.env.LOG_LEVEL ?? (IS_PROD ? "info" : "debug");
const clientLevel = process.env.NEXT_PUBLIC_LOG_LEVEL ?? "info";

export const logger: Logger = pino({
	level: IS_BROWSER ? clientLevel : serverLevel,
	// Redact common secret paths. Extend this list as new sensitive fields
	// surface in the codebase.
	redact: {
		paths: [
			"*.apiKey",
			"*.api_key",
			"*.authorization",
			"*.Authorization",
			"*.cookie",
			"*.token",
			"*.password",
			"*.secret",
			"headers.authorization",
			"headers.cookie",
		],
		censor: "[REDACTED]",
	},
	// Expand Error instances to `{ type, message, stack, cause }`. Without this,
	// `log.error({ err }, "…")` in the browser serializes err to `{}` because
	// Error properties are non-enumerable. `serialize: true` in the browser
	// config is what makes pino-browser apply the serializers below.
	serializers: {
		err: stdSerializers.err,
		error: stdSerializers.err,
	},
	browser: { asObject: true, serialize: true },
	// pino-pretty only loads on the server in development. Bundlers do not
	// follow this require, so it stays out of client and production builds.
	...(!IS_BROWSER && !IS_PROD
		? {
				transport: {
					target: "pino-pretty",
					options: {
						colorize: true,
						translateTime: "HH:MM:ss.l",
						ignore: "pid,hostname",
					},
				},
			}
		: {}),
	base: undefined, // drop default pid/hostname
});

/**
 * Returns a scoped child logger. Use one per module at file top-level:
 *
 *     const log = childLog("mcp-client");
 *     log.debug({ url }, "connecting");
 */
export function childLog(
	namespace: string,
	bindings: Record<string, unknown> = {},
): Logger {
	return logger.child({ ns: namespace, ...bindings });
}

/**
 * Wrap a non-trivial op with debug entry/exit logs and wall-clock timing.
 * Works transparently for sync and async functions. On throw, logs at `error`
 * with the error object attached, then re-throws.
 *
 *     await span(log, "connect", { url }, async () => client.connect(transport));
 *     const tools = span(log, "filterTools", () => filter(rawTools));
 */
export function span<T>(
	log: Logger,
	name: string,
	context: Record<string, unknown>,
	fn: () => T,
): T;
export function span<T>(log: Logger, name: string, fn: () => T): T;
export function span<T>(
	log: Logger,
	name: string,
	contextOrFn: Record<string, unknown> | (() => T),
	maybeFn?: () => T,
): T {
	const [context, fn] =
		typeof contextOrFn === "function"
			? [{}, contextOrFn]
			: [contextOrFn, maybeFn as () => T];
	const start = performance.now();
	log.debug({ span: name, ...context }, "enter");

	const finish = (
		outcome: "exit" | "failed",
		extra: Record<string, unknown>,
	) => {
		const ms = Math.round((performance.now() - start) * 100) / 100;
		if (outcome === "failed") {
			log.error({ span: name, ms, ...context, ...extra }, "failed");
		} else {
			log.debug({ span: name, ms, ...context, ...extra }, "exit");
		}
	};

	try {
		const result = fn();
		if (result && typeof (result as { then?: unknown }).then === "function") {
			return (result as unknown as Promise<unknown>).then(
				(v) => {
					finish("exit", { ok: true });
					return v;
				},
				(e) => {
					finish("failed", { err: e });
					throw e;
				},
			) as T;
		}
		finish("exit", { ok: true });
		return result;
	} catch (e) {
		finish("failed", { err: e });
		throw e;
	}
}
