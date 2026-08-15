/**
 * @file index.ts — Cloudflare Worker entry point and HTTP/Queue/Cron router.
 *
 * This is the single entry point for the Zenith Mock system deployed as a
 * Cloudflare Worker. It dispatches incoming requests to the appropriate
 * handler based on URL path prefix:
 *
 *  - `/`              → Dashboard HTML (index.html)
 *  - `/console`       → Operations console (console.html)
 *  - `/bank-app`      → Customer banking app (bank-app.html)
 *  - `/theater`       → Settlement Theater (animated tx playback)
 *  - `/api/...`       → ZC Core API (transfers, HTLC, GTID, RTP, DNS, etc.)
 *  - `/bank/:id/...`  → Bank API (ZC→Bank ingress, customer, teller, filters)
 *  - `/internal/...`  → Internal API (seed, cron triggers, DNS management)
 *
 * Also handles:
 *  - Cloudflare Queues consumer (async state machine advancement)
 *  - Cron triggers (EOD settlement at 07:30 UTC, timeout sweep every minute)
 *
 * @module index
 */
import bankAppHtml from "./dashboard/bank-app.html";
import consoleHtml from "./dashboard/console.html";
import dashboardHtml from "./dashboard/index.html";
import skyHtml from "./exploratory/ui/sky.html";
import theaterHtml from "./exploratory/ui/theater.html";
import type { Env, QueueMessage } from "./types";
import { errorResponse, isDomainError, isRetryable } from "./shared/errors";
import { handleBankApi } from "./router/bank";
import { handleInternal } from "./router/internal";
import { handleZcApi } from "./router/zc";
import { finalizeResponse, jsonError } from "./zc/ingress";
import { newRequestLogger } from "./shared/logger";
import { decideApiAuth } from "./shared/api_auth";
import { processQueueMessage } from "./zc/orchestrator";
import { runEod } from "./cron/eod";
import { runTimeoutSweep } from "./cron/timeout_sweep";

export { StreamDO } from "./zc/events/stream_rafiki";

// V8 perf: hoist invariants to module scope so they are allocated once at
// isolate startup rather than once per request. The header tuple form keeps
// a stable hidden class and avoids the `Object.entries(...)` allocation that
// otherwise happens on every response (was previously called 4× per request).
const CORS_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Access-Control-Allow-Origin", "*"],
  ["Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS"],
  ["Access-Control-Allow-Headers", "*"],
];
const CORS_OPTIONS_INIT: ResponseInit = {
  status: 204,
  headers: {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  },
};
const HTML_HEADERS_INIT = {
  "Content-Type": "text/html; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function withCors(resp: Response): Response {
  const newResp = new Response(resp.body, resp);
  const h = newResp.headers;
  for (let i = 0; i < CORS_HEADERS.length; i++) {
    const pair = CORS_HEADERS[i]!;
    h.set(pair[0], pair[1]);
  }
  return newResp;
}

/**
 * Path-prefix dispatch. Returns the (already CORS-wrapped, for API/Bank/Internal)
 * response; cross-cutting concerns (X-Request-Id, error-envelope normalization)
 * are applied by the caller via finalizeResponse.
 */
async function route(
  req: Request,
  env: Env,
  url: URL,
  path: string,
  method: string,
  log: ReturnType<typeof newRequestLogger>
): Promise<Response> {
  // -----------------------------------------------------------------------
  // Dashboard
  // -----------------------------------------------------------------------
  if (path === "/" || path === "/dashboard") {
    return new Response(dashboardHtml, { headers: HTML_HEADERS_INIT });
  }
  if (path === "/console") {
    return new Response(consoleHtml, { headers: HTML_HEADERS_INIT });
  }
  if (path === "/bank-app") {
    return new Response(bankAppHtml, { headers: HTML_HEADERS_INIT });
  }
  if (path === "/theater" || path === "/theatre") {
    return new Response(theaterHtml, { headers: HTML_HEADERS_INIT });
  }
  if (path === "/sky") {
    return new Response(skyHtml, { headers: HTML_HEADERS_INIT });
  }

  // -----------------------------------------------------------------------
  // ZC Core API: /api/...
  // -----------------------------------------------------------------------
  if (path.startsWith("/api/")) {
    // The perimeter: a credential, or nothing. The rule and the reasoning behind
    // it live in src/shared/api_auth.ts — including why no header can stand in
    // for the credential.
    const auth = decideApiAuth(req, env, url.origin);
    if (!auth.allowed) {
      return withCors(
        jsonError(401, "UNAUTHORIZED", "Valid X-Api-Key or Authorization Bearer header required")
      );
    }
    if (auth.via === "UI_FALLBACK") {
      // Serving the API without a credential is a deployment choice, so it is
      // one an operator can see in the logs rather than infer from the config.
      log.warn("http.unauthenticated_ui_access", { path });
    }

    return withCors(await handleZcApi(req, path, method, env));
  }

  // -----------------------------------------------------------------------
  // Bank API: /bank/:bankId/...
  // -----------------------------------------------------------------------
  if (path.startsWith("/bank/")) {
    return withCors(await handleBankApi(req, path, method, env));
  }

  // -----------------------------------------------------------------------
  // Internal Cron / Seed
  // -----------------------------------------------------------------------
  if (path.startsWith("/internal/")) {
    return withCors(await handleInternal(req, path, method, env));
  }

  log.warn("http.not_found");
  return withCors(jsonError(404, "NOT_FOUND", `Path ${path} not found`));
}

export default {
  // =========================================================================
  // HTTP fetch handler
  // =========================================================================
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    if (method === "OPTIONS") {
      return new Response(null, CORS_OPTIONS_INIT);
    }

    // Per-request tracing: generate or honor inbound X-Request-Id, then log
    // request boundary events. Every error response also carries this ID so
    // operators can correlate user-visible failures with structured logs.
    const inboundId = req.headers.get("X-Request-Id") ?? undefined;
    const log = newRequestLogger({ request_id: inboundId, method, path });
    log.info("http.request");

    try {
      const resp = await route(req, env, url, path, method, log);
      return await finalizeResponse(resp, log.request_id);
    } catch (err) {
      // Domain errors surface as their typed JSON; unknown errors are reported
      // as INTERNAL with the original message preserved.
      if (isDomainError(err)) {
        log.warn("http.domain_error", {
          reason_code: err.reason_code,
          category: err.category,
          duration_ms: log.elapsed(),
        });
      } else {
        log.error("http.unhandled_error", { error: err, duration_ms: log.elapsed() });
      }
      return await finalizeResponse(withCors(errorResponse(err, log.request_id)), log.request_id);
    }
  },

  // =========================================================================
  // Cloudflare Queues consumer
  // =========================================================================
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const log = newRequestLogger({
        kind: "queue",
        message_type: msg.body?.type,
        txid: msg.body?.txid,
        gtid: msg.body?.gtid,
        attempt: msg.body?.attempt,
      });
      try {
        log.info("queue.dispatch");
        await processQueueMessage(msg.body, env);
        log.info("queue.ack", { duration_ms: log.elapsed() });
        msg.ack();
      } catch (err) {
        // DomainError categorization decides whether to retry: only DOWNSTREAM /
        // TIMEOUT / RATE_LIMIT are retryable. Anything else is a bug or invalid
        // input — retrying just amplifies the problem, so we ack and surface
        // the failure via Cases (already handled inside the orchestrator).
        const retryable = !isDomainError(err) || isRetryable(err.category);
        log.error("queue.failed", {
          error: err,
          retryable,
          duration_ms: log.elapsed(),
        });
        if (retryable) msg.retry();
        else msg.ack();
      }
    }
  },

  // =========================================================================
  // Cron Triggers
  // =========================================================================
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = event.cron;
    if (cron === "30 7 * * *") {
      ctx.waitUntil(runEod(env).then((r) => console.log("[eod]", r.log)));
    } else if (cron === "* * * * *") {
      ctx.waitUntil(runTimeoutSweep(env).then((r) => console.log("[sweep] swept:", r.swept)));
    }
  },
};
