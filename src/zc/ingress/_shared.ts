/**
 * @file ZC ingress — shared JSON response helpers (json / jsonError).
 * @module zc/ingress/_shared
 */

import { type ErrorCategory, categoryOf } from "../../shared/errors";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
export function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Best-effort category for an HTTP status, used only when the reason_code is not
 * registered in the central catalog (categoryOf → INTERNAL). Keeps direct-return
 * validation errors from being mislabeled INTERNAL just because their code is
 * endpoint-local rather than catalog-registered.
 */
function categoryFromStatus(status: number): ErrorCategory {
  switch (status) {
    case 400:
    case 422:
      return "VALIDATION";
    case 401:
    case 403:
      return "AUTH";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "RATE_LIMIT";
    case 502:
    case 503:
      return "DOWNSTREAM";
    case 504:
      return "TIMEOUT";
    default:
      return "INTERNAL";
  }
}

/**
 * Render a direct-return error response in the canonical error envelope.
 *
 * The cross-cutting contract (docs/specs/32_api_contracts.md) requires every failure
 * body to carry `{error, reason_code, category, details, request_id}`. This
 * helper fills `category` (derived from the reason_code) and `details`; the
 * `request_id` (body field + `X-Request-Id` header) is stamped centrally by the
 * top-level fetch handler so it is present even on responses this helper does
 * not produce.
 */
export function jsonError(
  status: number,
  reason_code: string,
  message: string,
  details: Record<string, unknown> = {}
): Response {
  const known = categoryOf(reason_code);
  const category = known === "INTERNAL" && status !== 500 ? categoryFromStatus(status) : known;
  return json(status, {
    error: message,
    reason_code,
    category,
    details,
  });
}

/**
 * Enforce the cross-cutting response contract on any outgoing response:
 *
 *  1. Every HTTP response carries an `X-Request-Id` header.
 *  2. Every JSON error body (status ≥ 400 carrying a `reason_code`) is the full
 *     `{error, reason_code, category, details, request_id}` envelope.
 *
 * Validation responses produced by the `jsonError()` direct-return path
 * historically emitted only `{error, reason_code}` and no header. Normalizing
 * centrally guarantees the invariant holds regardless of which code path (thrown
 * DomainError vs. direct return) produced the response. The body is only
 * re-serialized when a field is actually missing, so success responses and
 * already-complete envelopes pass through untouched.
 */
export async function finalizeResponse(resp: Response, requestId: string): Promise<Response> {
  resp.headers.set("X-Request-Id", requestId);

  if (resp.status < 400) return resp;
  const ctype = resp.headers.get("Content-Type") ?? "";
  if (!ctype.includes("application/json")) return resp;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await resp.clone().text());
  } catch {
    return resp; // non-JSON or unreadable body; leave as-is
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return resp;
  const body = parsed as Record<string, unknown>;
  if (typeof body.reason_code !== "string") return resp; // not an error envelope

  let changed = false;
  if (body.category === undefined) {
    const known = categoryOf(body.reason_code);
    body.category =
      known === "INTERNAL" && resp.status !== 500 ? categoryFromStatus(resp.status) : known;
    changed = true;
  }
  if (body.details === undefined) {
    body.details = {};
    changed = true;
  }
  if (body.request_id === undefined) {
    body.request_id = requestId;
    changed = true;
  }
  if (!changed) return resp;

  const next = new Response(JSON.stringify(body), resp);
  next.headers.set("X-Request-Id", requestId);
  return next;
}
