/**
 * @file Pre-Shared Payment Reference (PSPR) registration and lookup. Allows
 *       payees to pre-register receiving references.
 * @module zc/pspr
 */
import { nowISO } from "../../types";
import { sha256hex } from "../../shared/hmac";
import {
  buildEntityStateLogConditionalInsert,
  transitionEntityWithLog,
} from "../../shared/entity_state_log";

/**
 * PSPR registration (POST /api/pspr/register)
 */
export async function registerPspr(
  db: D1Database,
  psprRef: string,
  payeeBankId: string,
  accountHash: string,
  expiresAt: string
): Promise<{ result: "REGISTERED" | "ALREADY_EXISTS"; pspr_ref: string }> {
  const now = nowISO();
  const digest = await sha256hex(`${psprRef}:${payeeBankId}:${accountHash}:${expiresAt}`);

  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO PsprRegistry
     (pspr_ref, payee_bank_id, account_hash, capability_state, digest, expires_at, created_at)
     VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)`
      )
      .bind(psprRef, payeeBankId, accountHash, digest, expiresAt, now),
    buildEntityStateLogConditionalInsert(db, {
      entityType: "PSPR",
      entityId: psprRef,
      eventType: "PsprRegistered",
      stateFrom: null,
      stateTo: "ACTIVE",
      actor: payeeBankId,
    }),
  ]);

  return {
    result: (results[0]?.meta.changes ?? 0) > 0 ? "REGISTERED" : "ALREADY_EXISTS",
    pspr_ref: psprRef,
  };
}

/**
 * PSPR revocation
 */
export async function revokePspr(db: D1Database, psprRef: string): Promise<void> {
  const cur = await db
    .prepare(`SELECT capability_state FROM PsprRegistry WHERE pspr_ref = ?`)
    .bind(psprRef)
    .first<{ capability_state: string }>();
  if (!cur) return;

  await transitionEntityWithLog(db, {
    update: {
      sql: `UPDATE PsprRegistry SET capability_state='REVOKED', revoked_at=? WHERE pspr_ref=? AND capability_state!='REVOKED'`,
      binds: [nowISO(), psprRef],
    },
    transition: {
      entityType: "PSPR",
      entityId: psprRef,
      eventType: "PsprRevoked",
      stateFrom: cur.capability_state,
      stateTo: "REVOKED",
    },
  });
}
