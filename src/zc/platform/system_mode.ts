/**
 * @file system_mode.ts — ZC-wide operational mode and read-only degradation
 * (design principle 10 + テーマ H 可搬性と縮退).
 *
 * The single source of truth is held in a consensus log; principle 10 says
 * that when its integrity is uncertain the system must **degrade to read-only
 * to avoid mis-decisions**, rather than keep committing state. This module is
 * the enforcement point for that posture. Two read-only modes share one
 * mechanism:
 *
 *   - BCP_READONLY          — operator-declared vendor-outage degradation
 *                             (テーマ H). Toggled via /internal/system-mode/bcp-*.
 *   - QUORUM_LOSS_READONLY  — automatic principle-10 degradation when the
 *                             consensus quorum is lost. Driven by
 *                             `quorum.ts#reconcileQuorum`, never by an operator.
 *
 * `getSystemMode()` reads the mode; `assertWritable()` / `assertWritableDb()`
 * fast-fail money-moving writes while *any* read-only mode is active; read-only
 * queries are unaffected. The lane write primitives (`transitionWithLog`,
 * `insertTxWithLog`, `cancelInFlightTx`) and `suspendTx` all call
 * `assertWritableDb()` so a state advance is structurally impossible while the
 * system is read-only — the same choke point that guarantees CAS+log atomicity.
 *
 * Mode transitions are themselves audited to the FinalityLog GLOBAL chain. The
 * `writeFinalityLog` dependency is pulled in via dynamic import inside
 * `transitionSystemMode` so this module's static import graph stays free of the
 * orchestrator — that keeps it importable from `lanes/_helpers.ts` and
 * `orchestrator/finality.ts` without an import cycle.
 *
 * @module zc/system_mode
 */
import type { Env, SystemModeRow, SystemModeValue } from "../../types";
import { nowISO } from "../../types";
import { DomainError } from "../../shared/errors";

const DEFAULT_MODE: SystemModeRow = {
  mode: "NORMAL",
  reason: null,
  activated_at: null,
  updated_at: "1970-01-01T00:00:00.000Z",
};

/** Modes in which money-moving writes are refused. */
const READONLY_MODES: ReadonlySet<SystemModeValue> = new Set<SystemModeValue>([
  "BCP_READONLY",
  "QUORUM_LOSS_READONLY",
]);

/** reason_code raised by `assertWritable` for each read-only mode. */
const READONLY_REASON_CODE: Record<string, string> = {
  BCP_READONLY: "SYSTEM_BCP_READ_ONLY",
  QUORUM_LOSS_READONLY: "SYSTEM_QUORUM_LOSS_READ_ONLY",
};

/** Read the current ZC-wide operational mode. Defaults to NORMAL if the seed row is missing. */
export async function getSystemMode(db: D1Database): Promise<SystemModeRow> {
  const row = await db
    .prepare(`SELECT mode, reason, activated_at, updated_at FROM SystemMode WHERE id = 1`)
    .first<SystemModeRow>();
  return row ?? DEFAULT_MODE;
}

/** True when the system is accepting new state-committing writes. */
export function isWritable(mode: SystemModeRow): boolean {
  return !READONLY_MODES.has(mode.mode);
}

/**
 * Throw if the system is in any read-only mode. The reason_code reflects which
 * mode is active (`SYSTEM_BCP_READ_ONLY` / `SYSTEM_QUORUM_LOSS_READ_ONLY`);
 * both are DOWNSTREAM-category (502, retryable) so the queue holds in-flight
 * work and replays it once the system returns to NORMAL.
 *
 * Intended for handlers/primitives that commit new state; read-only queries
 * (status lookups, etc.) should not call this.
 */
export function assertWritable(mode: SystemModeRow): void {
  if (!isWritable(mode)) {
    const reason_code = READONLY_REASON_CODE[mode.mode] ?? "SYSTEM_BCP_READ_ONLY";
    throw new DomainError(
      reason_code,
      `ZC is in ${mode.mode} mode: ${mode.reason ?? "no reason given"}`,
      {
        mode: mode.mode,
        reason: mode.reason,
        activated_at: mode.activated_at,
      }
    );
  }
}

/** Read the mode and assert writability in one call (the form the write primitives use). */
export async function assertWritableDb(db: D1Database): Promise<void> {
  assertWritable(await getSystemMode(db));
}

/**
 * Persist a mode transition and audit it to the FinalityLog GLOBAL chain.
 * Idempotent: a no-op (and no audit entry) when already in `toMode`.
 *
 * Note the audit write goes through `writeFinalityLog` directly (not the
 * `assertWritableDb`-gated lane primitives), so the transition INTO a read-only
 * mode can still record itself. `writeFinalityLog` is dynamically imported to
 * avoid a static import cycle (orchestrator → … → system_mode).
 */
async function transitionSystemMode(
  env: Env,
  toMode: SystemModeValue,
  reason: string | null,
  eventType: string
): Promise<SystemModeRow> {
  const db = env.DB;
  const before = await getSystemMode(db);
  if (before.mode === toMode) return before;

  const now = nowISO();
  const isNormal = toMode === "NORMAL";
  await db
    .prepare(
      `UPDATE SystemMode SET mode = ?, reason = ?, activated_at = ?, updated_at = ? WHERE id = 1`
    )
    .bind(toMode, reason, isNormal ? null : now, now)
    .run();

  const { writeFinalityLog } = await import("../orchestrator");
  await writeFinalityLog(db, {
    txid: null,
    event_type: eventType,
    state_from: before.mode,
    state_to: toMode,
    payload_json: JSON.stringify({ reason, previous_reason: before.reason }),
    txid_or_gtid: null,
  });

  return {
    mode: toMode,
    reason: isNormal ? null : reason,
    activated_at: isNormal ? null : now,
    updated_at: now,
  };
}

/**
 * Activate BCP_READONLY mode (operator-declared vendor outage). Idempotent.
 *
 * Guard: refuses to overwrite an active QUORUM_LOSS_READONLY degradation. That
 * mode is the automatic principle-10 posture and is owned by quorum
 * reconciliation; the system is *already* read-only while it holds, so a BCP
 * activation buys nothing. Allowing the overwrite was a latent safety hole:
 * once BCP_READONLY masked the quorum loss, a subsequent operator
 * `bcp-deactivate` would clear straight back to NORMAL — re-enabling
 * money-moving writes while consensus quorum was still genuinely lost. The
 * quorum-loss record (and its write-block) must survive until quorum actually
 * recovers, so we leave the existing mode untouched here.
 */
export async function activateBcpReadOnly(env: Env, reason: string): Promise<SystemModeRow> {
  const before = await getSystemMode(env.DB);
  if (before.mode === "QUORUM_LOSS_READONLY") {
    throw new DomainError(
      "SYSTEM_QUORUM_LOSS_READ_ONLY",
      "cannot activate BCP_READONLY while QUORUM_LOSS_READONLY is active; the system is already read-only and the quorum-loss degradation clears only on quorum recovery",
      { mode: before.mode, reason: before.reason }
    );
  }
  return transitionSystemMode(env, "BCP_READONLY", reason, "SystemBcpActivated");
}

/**
 * Deactivate BCP_READONLY mode, returning to NORMAL. Idempotent.
 *
 * Guard: refuses to clear a QUORUM_LOSS_READONLY degradation — that mode is
 * owned by quorum reconciliation and clears only when quorum is restored, not
 * by an operator BCP toggle.
 */
export async function deactivateBcpReadOnly(env: Env): Promise<SystemModeRow> {
  const before = await getSystemMode(env.DB);
  if (before.mode === "QUORUM_LOSS_READONLY") {
    throw new DomainError(
      "SYSTEM_QUORUM_LOSS_READ_ONLY",
      "cannot clear QUORUM_LOSS_READONLY via BCP deactivate; it clears automatically on quorum recovery",
      { mode: before.mode, reason: before.reason }
    );
  }
  return transitionSystemMode(env, "NORMAL", null, "SystemBcpDeactivated");
}

/**
 * Enter QUORUM_LOSS_READONLY (design principle 10 degradation). Idempotent.
 * Called by `quorum.ts#reconcileQuorum` when the consensus quorum is lost.
 */
export async function degradeToQuorumLossReadOnly(
  env: Env,
  reason: string
): Promise<SystemModeRow> {
  return transitionSystemMode(env, "QUORUM_LOSS_READONLY", reason, "SystemQuorumLossActivated");
}

/**
 * Leave QUORUM_LOSS_READONLY, returning to NORMAL. Idempotent. Called by
 * `quorum.ts#reconcileQuorum` when quorum is restored.
 */
export async function restoreFromQuorumLoss(env: Env): Promise<SystemModeRow> {
  return transitionSystemMode(env, "NORMAL", null, "SystemQuorumLossCleared");
}
