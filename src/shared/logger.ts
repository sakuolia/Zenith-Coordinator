/**
 * @file logger.ts — Structured JSON logger with per-request context.
 *
 * Emits one JSON line per log event so Cloudflare Logpush / wrangler tail
 * remain machine-parseable. Carries a `request_id` and arbitrary baggage
 * (txid, bank_id, lane, etc.) without forcing every call site to pass them.
 *
 * # Usage
 *
 * ```ts
 * const log = newRequestLogger({ method: 'POST', path: '/api/transfers' })
 * log.info('lane.dispatch', { txid, lane: 'EXPRESS' })
 * try {
 *   ...
 * } catch (e) {
 *   log.error('lane.failed', { txid, error: e })
 *   throw e
 * }
 * log.info('request.complete', { status: 200, duration_ms: log.elapsed() })
 * ```
 *
 * Output line shape and the event naming convention are in
 * docs/specs/30_internal_design.md § 3 (構造化ロギング).
 */

import { newUUID } from "./idempotency";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  request_id?: string;
  method?: string;
  path?: string;
  [k: string]: unknown;
}

export interface RequestLogger {
  /** Generate a child logger with merged baggage. Useful inside lane code. */
  child(extra: Record<string, unknown>): RequestLogger;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** Milliseconds elapsed since logger creation. */
  elapsed(): number;
  /** The request_id used for tracing; surfaced in error responses. */
  readonly request_id: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a logger scoped to one HTTP request / queue message / cron tick.
 * If `ctx.request_id` is omitted a new one is generated.
 */
export function newRequestLogger(ctx: LogContext = {}): RequestLogger {
  const start = Date.now();
  const baggage: LogContext = {
    request_id: ctx.request_id ?? `req-${newUUID()}`,
    ...ctx,
  };
  return makeLogger(baggage, start);
}

function makeLogger(baggage: LogContext, start: number): RequestLogger {
  // V8 perf: build the per-call log line in a stable hidden-class shape.
  // The previous `{...baggage, ...sanitize(fields)}` form forced V8 to allocate
  // a new object whose hidden class depended on `Object.entries` iteration
  // order, defeating inline-cache reuse across calls. The form below copies
  // properties via plain assignment, which keeps the resulting object's
  // shape monomorphic per (level,event) call site for typical logger use.
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event,
    };
    for (const k in baggage) {
      const v = (baggage as Record<string, unknown>)[k];
      if (v !== undefined) line[k] = v;
    }
    if (fields) sanitizeInto(fields, line);
    const writer =
      level === "debug"
        ? console.log
        : level === "info"
          ? console.info
          : level === "warn"
            ? console.warn
            : console.error;
    writer(JSON.stringify(line));
  };
  return {
    request_id: baggage.request_id as string,
    child(extra) {
      // Cheap merge: copy baggage then overwrite with extras. Avoids the
      // double-spread allocation pattern.
      const merged: LogContext = {};
      for (const k in baggage) {
        merged[k] = (baggage as Record<string, unknown>)[k];
      }
      for (const k in extra) merged[k] = extra[k];
      return makeLogger(merged, start);
    },
    debug(event, fields) {
      emit("debug", event, fields);
    },
    info(event, fields) {
      emit("info", event, fields);
    },
    warn(event, fields) {
      emit("warn", event, fields);
    },
    error(event, fields) {
      emit("error", event, fields);
    },
    elapsed() {
      return Date.now() - start;
    },
  };
}

// ---------------------------------------------------------------------------
// Field sanitization
// ---------------------------------------------------------------------------

/**
 * Convert non-serializable fields (Error, undefined) into JSON-safe values
 * and write them directly into the caller-provided log line. Strips fields
 * whose key looks PII-ish (vault_ref, secret, hmac_*).
 *
 * V8 perf: writes into the existing `out` object rather than allocating an
 * intermediate, and uses `for...in` instead of `Object.entries` to avoid the
 * intermediate `[k,v]` array allocation per field.
 */
function sanitizeInto(fields: Record<string, unknown>, out: Record<string, unknown>): void {
  for (const k in fields) {
    if (isPiiKey(k)) {
      out[k] = "[REDACTED]";
      continue;
    }
    const v = fields[k];
    if (v === undefined) continue;
    if (v instanceof Error) {
      const errObj: Record<string, unknown> = { name: v.name, message: v.message };
      const rc = (v as { reason_code?: unknown }).reason_code;
      if (rc != null) errObj.reason_code = rc;
      const details = (v as { details?: unknown }).details;
      if (details != null) errObj.details = details;
      out[k] = errObj;
    } else {
      out[k] = v;
    }
  }
}

const PII_KEYS = new Set([
  "vault_ref",
  "preimage",
  "secret",
  "hmac_secret",
  "authorization",
  "api_key",
  "private_key",
  // Raw customer PII (docs/specs/10_requirements.md §3.2.1 data minimization catalog):
  // ZC holds only hashed/salted identifiers (e.g. *_account_hash), never these.
  "customer_name",
  "account_holder_name",
  "address",
  "phone",
  "email",
  "date_of_birth",
  "account_number",
]);

function isPiiKey(k: string): boolean {
  const lower = k.toLowerCase();
  if (PII_KEYS.has(lower)) return true;
  return lower.includes("password") || lower.endsWith("_pii");
}
