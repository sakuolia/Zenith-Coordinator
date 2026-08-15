/**
 * @file Query-side access control — the single gate every party-scoped read
 *       passes through.
 *
 * Two requirements meet here, and they are deliberately implemented as **one**
 * mechanism rather than two (`docs/specs/10_requirements.md` §8.5):
 *
 * - **S-5** — "アクセスは目的コードなしに成立しない". Every read names *why* it is
 *   reading (`X-Purpose-Code`, §3.3.2.2.1) and is blocked in real time if it does
 *   not (§3.3.2.2.1.1-2), with the decision recorded in the Access Audit Log
 *   (§3.3.2.2.1.1-1).
 * - **S-7** — "参加行間の越境参照が構造的に不可能であること". A participant reaches
 *   only the rows it is a party to; everything else is indistinguishable from
 *   absent (§3.3.2.3-1).
 *
 * They are one mechanism because they need the same two facts: *who is asking*
 * and *what are they entitled to see*. Splitting them would have produced two
 * identity resolvers that drift apart — the failure mode this repository keeps
 * closing structurally rather than by discipline.
 *
 * **Refusal semantics.** The status codes differ by *when* the refusal happens,
 * and the difference is load-bearing:
 *
 * - Missing purpose code / unidentified caller → **403**. Refused *before* any
 *   lookup, so the response cannot reveal whether the resource exists.
 * - Identified caller who is not a party → **404**, identical to a row that does
 *   not exist. A 403 here would answer "this transaction exists but is not
 *   yours", which is precisely the cross-participant fact S-7 forbids
 *   (the same reasoning as `GET /api/dns/:business_date/hold_detail`,
 *   `20_method_design.md` §9.4.4 (B)-1).
 *
 * **Aggregate reads are operator-only.** List/feed endpoints have no per-caller
 * scoping, and §3.3.2.2.3 already forbids participants from doing全件検索:
 * "照会は取引ID/CASE ID/当事者キーに限定する". So a participant asking for a list
 * is refused rather than silently filtered — inventing a filter would be the
 * kind of quiet, leak-prone half-measure that requirement rules out.
 *
 * **Binding the subject to a credential.** `X-Bank-Id` alone is an assertion, and
 * an assertion is not an identity: any caller can type another bank's id. The
 * subject is therefore bound to a `KeyRegistry` key
 * (`owner_type='PARTICIPANT'`) by a request signature — the mirror image of
 * ZC's own egress signing (`shared/zc_signature.ts`).
 *
 * **Enforcement is keyed on registry state, not on the caller's headers.** If the
 * claimed bank has any ACTIVE participant key, a valid signature is *required*
 * for that bank; a caller cannot downgrade itself by omitting the header. Banks
 * with no registered key fall back to the asserted identity, which is what makes
 * this a migration rather than a flag day: registering a key turns enforcement
 * on for that participant, one participant at a time, and the operator drives
 * the rollout by registering keys (`32_api_contracts.md § 照会の認可`).
 *
 * Compare the precedent this repository already set — ZC egress dual-accepts on
 * the presence of `X-ZC-Key-Id`. That form is right for an *outbound* migration,
 * where the sender chooses its generation. It would be wrong here: an inbound
 * authenticity check that the caller can switch off by omission checks nothing.
 *
 * @module zc/platform/access
 */
import type { Env } from "../../types";
import { nowISO } from "../../types";
import { newUUID } from "../../shared/idempotency";
import { timingSafeEqualStr } from "../../shared/hmac";
import { verifyExternalSignature } from "../../shared/external_signature";
import { isDomainError } from "../../shared/errors";
import { jsonError } from "../ingress/_shared";
import { isPurposeCode, recordDataAccessViolation, type PurposeCode } from "./purpose";

/** Who is asking. `UNIDENTIFIED` never reaches a resource. */
export type AccessSubjectType = "OPERATOR" | "PARTICIPANT" | "UNIDENTIFIED";

export type AccessDecision = "PERMIT" | "DENY";

export type AccessSubject =
  | { type: "OPERATOR" }
  /**
   * `authenticated` records whether the bank id was proven by a signature or
   * merely asserted. It is written to the audit log on every read so the gap is
   * visible per request while a participant is still migrating — an
   * unauthenticated read is not a violation, but it is a fact worth keeping.
   */
  | { type: "PARTICIPANT"; bankId: string; authenticated: boolean }
  | { type: "UNIDENTIFIED" };

/** A read that passed the gate: identity plus the purpose it declared. */
export interface AccessGrant {
  subject: AccessSubject;
  purpose: PurposeCode;
}

/** Denial reasons, in the order the gate evaluates them. */
export type AccessDenialCode =
  | "PURPOSE_CODE_REQUIRED"
  | "REQUESTER_UNIDENTIFIED"
  | "PARTICIPANT_SIGNATURE_REQUIRED"
  | "PARTICIPANT_SIGNATURE_INVALID"
  | "CROSS_PARTICIPANT_SCOPE"
  | "NOT_A_PARTY";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Headers a participant uses to prove the bank id it claims. */
export const PARTICIPANT_AUTH_HEADERS = {
  keyId: "X-Participant-Key-Id",
  nonce: "X-Participant-Sig-Nonce",
  time: "X-Participant-Sig-Time",
  signature: "X-Participant-Signature",
} as const;

/**
 * What a participant signs: the request it is making, not a bare token.
 *
 * Binding method, path and purpose into the signed payload means a captured
 * signature cannot be replayed against a *different* read — without it, a
 * signature lifted from a permitted request would authorise any other one until
 * the nonce expired.
 */
export function participantAuthPayload(input: {
  method: string;
  path: string;
  bankId: string;
  purposeCode: string | null;
}): Record<string, string | null> {
  return {
    method: input.method.toUpperCase(),
    path: input.path,
    bank_id: input.bankId,
    purpose_code: input.purposeCode,
  };
}

/** Does this bank have any ACTIVE participant key? If so, signing is required. */
async function participantKeysRegistered(db: D1Database, bankId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM KeyRegistry
        WHERE owner_type = 'PARTICIPANT' AND owner_ref = ? AND status = 'ACTIVE'
        LIMIT 1`
    )
    .bind(bankId)
    .first<{ x: number }>();
  return !!row;
}

export type SubjectResolution =
  | { ok: true; subject: AccessSubject }
  | { ok: false; subject: AccessSubject; reason: AccessDenialCode; detail: string };

/**
 * Resolve the caller. Operator identity (the internal secret) wins over a bank
 * header, so an operator tool that also sends `X-Bank-Id` is not silently
 * narrowed to one participant's view.
 */
export async function resolveSubject(
  req: Request,
  env: Env,
  path: string
): Promise<SubjectResolution> {
  const cronSecret = req.headers.get("X-Cron-Secret");
  if (cronSecret && env.CRON_SECRET && timingSafeEqualStr(cronSecret, env.CRON_SECRET)) {
    return { ok: true, subject: { type: "OPERATOR" } };
  }

  const bankId = req.headers.get("X-Bank-Id");
  if (!bankId) return { ok: true, subject: { type: "UNIDENTIFIED" } };

  const keyId = req.headers.get(PARTICIPANT_AUTH_HEADERS.keyId);
  const asserted: AccessSubject = { type: "PARTICIPANT", bankId, authenticated: false };

  if (!keyId) {
    // Enforcement is a property of the registry, not of the request: a bank that
    // has registered a key may not fall back to asserting its id.
    if (await participantKeysRegistered(env.DB, bankId)) {
      return {
        ok: false,
        subject: asserted,
        reason: "PARTICIPANT_SIGNATURE_REQUIRED",
        detail: `participant ${bankId} has a registered key; sign the request`,
      };
    }
    return { ok: true, subject: asserted };
  }

  const nonce = req.headers.get(PARTICIPANT_AUTH_HEADERS.nonce);
  const occurredAt = req.headers.get(PARTICIPANT_AUTH_HEADERS.time);
  const signatureB64 = req.headers.get(PARTICIPANT_AUTH_HEADERS.signature);
  if (!nonce || !occurredAt || !signatureB64) {
    return {
      ok: false,
      subject: asserted,
      reason: "PARTICIPANT_SIGNATURE_INVALID",
      detail: "nonce, timestamp and signature headers are all required",
    };
  }

  try {
    const key = await verifyExternalSignature(env.DB, {
      keyId,
      nonce,
      occurredAt,
      signatureB64,
      payload: participantAuthPayload({
        method: req.method,
        path,
        bankId,
        purposeCode: req.headers.get("X-Purpose-Code"),
      }),
    });
    // The signature proves possession of *a* key. It becomes an identity only
    // once the key is a participant key belonging to the bank being claimed —
    // otherwise any registered attester or watcher could read as any bank.
    if (key.owner_type !== "PARTICIPANT" || key.owner_ref !== bankId) {
      return {
        ok: false,
        subject: asserted,
        reason: "PARTICIPANT_SIGNATURE_INVALID",
        detail: `key ${keyId} does not belong to participant ${bankId}`,
      };
    }
    return { ok: true, subject: { type: "PARTICIPANT", bankId, authenticated: true } };
  } catch (err) {
    const reason = isDomainError(err) ? err.reason_code : "EXTERNAL_SIGNATURE_INVALID";
    return {
      ok: false,
      subject: asserted,
      reason: "PARTICIPANT_SIGNATURE_INVALID",
      detail: `${reason}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Access Audit Log
// ---------------------------------------------------------------------------

/**
 * Record one access decision. Denials are recorded as well as permits: the
 * pattern of refusals is what separates a misconfigured client from probing,
 * and §3.3.2.2.1.1-3's post-hoc detection has nothing to work with otherwise.
 *
 * Never throws — an audit-write failure must not turn a legitimate read into an
 * error, and the alternative (failing the read) would make the log a new
 * availability dependency of every query.
 */
export async function recordAccess(
  db: D1Database,
  entry: {
    subject: AccessSubject;
    purpose: PurposeCode | string | null;
    resource: string;
    decision: AccessDecision;
    reason_code?: AccessDenialCode | null;
    export_ref?: string | null;
  }
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO AccessAuditLog
           (access_id, occurred_at, subject_type, subject_id, purpose_code,
            resource, decision, reason_code, export_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        newUUID(),
        nowISO(),
        entry.subject.type,
        entry.subject.type === "PARTICIPANT"
          ? // Mark an asserted-only identity in the ledger itself: an auditor
            // reading this row must be able to tell proof from claim.
            entry.subject.authenticated
            ? entry.subject.bankId
            : `${entry.subject.bankId}(unauthenticated)`
          : null,
        entry.purpose ?? null,
        entry.resource,
        entry.decision,
        entry.reason_code ?? null,
        entry.export_ref ?? null
      )
      .run();
  } catch (err) {
    console.error("[access] audit log write failed:", err);
  }
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type AccessResult = { ok: true; grant: AccessGrant } | { ok: false; response: Response };

/**
 * Gate a party-scoped read: require a purpose code and an identified caller.
 *
 * Both refusals happen before any lookup, so neither can reveal whether the
 * resource exists. The party check itself is a separate step
 * (`assertParty`) because it needs the resource.
 */
export async function authorizeRead(
  req: Request,
  env: Env,
  resource: string
): Promise<AccessResult> {
  const db = env.DB;
  const purpose = req.headers.get("X-Purpose-Code");
  const resolution = await resolveSubject(req, env, resource);
  const subject = resolution.subject;

  if (!isPurposeCode(purpose)) {
    await recordAccess(db, {
      subject,
      purpose,
      resource,
      decision: "DENY",
      reason_code: "PURPOSE_CODE_REQUIRED",
    });
    await recordDataAccessViolation(db, {
      resource,
      subject: subject.type === "PARTICIPANT" ? subject.bankId : subject.type,
      purpose_code: purpose,
      reason: "PURPOSE_CODE_MISSING",
    });
    return {
      ok: false,
      response: jsonError(
        403,
        "PURPOSE_CODE_REQUIRED",
        "X-Purpose-Code (P01-P07) is required for this read"
      ),
    };
  }

  if (subject.type === "UNIDENTIFIED") {
    await recordAccess(db, {
      subject,
      purpose,
      resource,
      decision: "DENY",
      reason_code: "REQUESTER_UNIDENTIFIED",
    });
    await recordDataAccessViolation(db, {
      resource,
      subject: "UNIDENTIFIED",
      purpose_code: purpose,
      reason: "REQUESTER_UNIDENTIFIED",
    });
    return {
      ok: false,
      response: jsonError(
        403,
        "REQUESTER_UNIDENTIFIED",
        "X-Bank-Id (participant) or X-Cron-Secret (operator) is required for this read"
      ),
    };
  }

  // A failed authenticity check is refused *as* an identification failure: the
  // caller claimed a bank it did not prove, so it is not that bank. Recording it
  // as a violation is deliberate — a bad signature against a registered key is
  // the shape impersonation takes.
  if (!resolution.ok) {
    await recordAccess(db, {
      subject,
      purpose,
      resource,
      decision: "DENY",
      reason_code: resolution.reason,
    });
    await recordDataAccessViolation(db, {
      resource,
      subject: subject.type === "PARTICIPANT" ? subject.bankId : subject.type,
      purpose_code: purpose,
      reason: "REQUESTER_UNIDENTIFIED",
    });
    return { ok: false, response: jsonError(403, resolution.reason, resolution.detail) };
  }

  return { ok: true, grant: { subject, purpose } };
}

/**
 * Refuse a participant an aggregate (list / feed) read.
 *
 * Not a filter: §3.3.2.2.3 restricts participant queries to a transaction id,
 * a CASE id, or a party key, so a participant asking for "all transactions" is
 * asking for something the rulebook does not grant, whatever the filter says.
 */
export async function authorizeAggregateRead(
  req: Request,
  env: Env,
  resource: string
): Promise<AccessResult> {
  const gated = await authorizeRead(req, env, resource);
  if (!gated.ok) return gated;
  if (gated.grant.subject.type !== "OPERATOR") {
    await recordAccess(env.DB, {
      subject: gated.grant.subject,
      purpose: gated.grant.purpose,
      resource,
      decision: "DENY",
      reason_code: "CROSS_PARTICIPANT_SCOPE",
    });
    return {
      ok: false,
      response: jsonError(
        403,
        "CROSS_PARTICIPANT_SCOPE",
        "list and feed reads are operator-scoped; query by txid / gtid / case_id instead"
      ),
    };
  }
  await recordAccess(env.DB, {
    subject: gated.grant.subject,
    purpose: gated.grant.purpose,
    resource,
    decision: "PERMIT",
  });
  return gated;
}

// ---------------------------------------------------------------------------
// Party predicates
// ---------------------------------------------------------------------------

/** The banks entitled to see a given resource, or null when it does not exist. */
export type PartyLookup = (db: D1Database, id: string) => Promise<string[] | null>;

/** Parties to a transaction: the payer bank and the payee bank. */
export const txParties: PartyLookup = async (db, txid) => {
  const row = await db
    .prepare(`SELECT payer_bank_id, payee_bank_id FROM Transactions WHERE txid = ?`)
    .bind(txid)
    .first<{ payer_bank_id: string; payee_bank_id: string }>();
  return row ? [row.payer_bank_id, row.payee_bank_id] : null;
};

/** Parties to a GTID: every bank holding a leg. */
export const gtidParties: PartyLookup = async (db, gtid) => {
  const head = await db
    .prepare(`SELECT gtid FROM GtidTransactions WHERE gtid = ?`)
    .bind(gtid)
    .first<{ gtid: string }>();
  if (!head) return null;
  const legs = await db
    .prepare(`SELECT DISTINCT bank_id FROM GtidLegs WHERE gtid = ?`)
    .bind(gtid)
    .all<{ bank_id: string }>();
  return (legs.results ?? []).map((r) => r.bank_id);
};

/** Parties to an HTLC: payer bank and payee bank. */
export const htlcParties: PartyLookup = async (db, htlcId) => {
  const row = await db
    .prepare(`SELECT payer_bank_id, payee_bank_id FROM HtlcContracts WHERE htlc_id = ?`)
    .bind(htlcId)
    .first<{ payer_bank_id: string; payee_bank_id: string }>();
  return row ? [row.payer_bank_id, row.payee_bank_id] : null;
};

/** Parties to a continuous-collection contract: the paying and payee banks. */
export const debitMandateParties: PartyLookup = async (db, ddMandateId) => {
  const row = await db
    .prepare(`SELECT payer_bank_id, payee_bank_id FROM DebitMandate WHERE dd_mandate_id = ?`)
    .bind(ddMandateId)
    .first<{ payer_bank_id: string; payee_bank_id: string }>();
  return row ? [row.payer_bank_id, row.payee_bank_id] : null;
};

/**
 * Parties to a collection: those of its contract. A notice carries the amount
 * and timing of a debit against a named customer, so it is party-scoped from
 * the moment it is registered — well before any Transaction exists.
 */
export const collectionParties: PartyLookup = async (db, collectionId) => {
  const row = await db
    .prepare(
      `SELECT m.payer_bank_id, m.payee_bank_id
         FROM ScheduledCollection c JOIN DebitMandate m USING (dd_mandate_id)
        WHERE c.collection_id = ?`
    )
    .bind(collectionId)
    .first<{ payer_bank_id: string; payee_bank_id: string }>();
  return row ? [row.payer_bank_id, row.payee_bank_id] : null;
};

/**
 * Parties to a CASE: the parties of the transaction or GTID it is linked to.
 * A CASE with neither link is operator-only — there is no party to derive.
 */
export const caseParties: PartyLookup = async (db, caseId) => {
  const row = await db
    .prepare(`SELECT related_txid, related_gtid FROM Cases WHERE case_id = ?`)
    .bind(caseId)
    .first<{ related_txid: string | null; related_gtid: string | null }>();
  if (!row) return null;
  if (row.related_txid) return (await txParties(db, row.related_txid)) ?? [];
  if (row.related_gtid) return (await gtidParties(db, row.related_gtid)) ?? [];
  return [];
};

/** Parties to a payee-initiated authorisation: the merchant's bank and the payer's bank. */
export const htlcAuthParties: PartyLookup = async (db, authId) => {
  const row = await db
    .prepare(`SELECT payer_bank_id, payee_bank_id FROM HtlcAuthRequests WHERE auth_id = ?`)
    .bind(authId)
    .first<{ payer_bank_id: string; payee_bank_id: string }>();
  return row ? [row.payer_bank_id, row.payee_bank_id] : null;
};

/** Parties to a Reversal: the parties of the original transaction it compensates. */
export const reversalParties: PartyLookup = async (db, reversalId) => {
  const row = await db
    .prepare(`SELECT original_txid FROM ReversalRecords WHERE reversal_id = ?`)
    .bind(reversalId)
    .first<{ original_txid: string }>();
  if (!row) return null;
  return (await txParties(db, row.original_txid)) ?? [];
};

/**
 * Party of a resource keyed by the bank itself (e.g. a participant's own
 * circuit-breaker state). The identifier *is* the party, so no lookup is
 * needed — and notably the row need not exist: an unregistered bank legitimately
 * reads its own default state (`32_api_contracts.md § GET /api/circuit-breaker/:bank_id`).
 */
export const selfParty: PartyLookup = async (_db, bankId) => [bankId];

/**
 * Apply the party check to a granted read.
 *
 * A non-party — and a resource that does not exist — both yield 404 with the
 * same body. That indistinguishability *is* the requirement (S-7): if the two
 * were distinguishable, a participant could enumerate identifiers to learn
 * which transactions another participant is running.
 */
export async function assertParty(
  env: Env,
  grant: AccessGrant,
  resource: string,
  lookup: PartyLookup,
  id: string
): Promise<Response | null> {
  const db = env.DB;
  if (grant.subject.type === "OPERATOR") {
    await recordAccess(db, {
      subject: grant.subject,
      purpose: grant.purpose,
      resource,
      decision: "PERMIT",
    });
    return null;
  }

  if (grant.subject.type === "UNIDENTIFIED") return jsonError(404, "NOT_FOUND", "not found");

  const bankId = grant.subject.bankId;
  const parties = await lookup(db, id);
  const permitted = !!parties && parties.includes(bankId);
  await recordAccess(db, {
    subject: grant.subject,
    purpose: grant.purpose,
    resource,
    decision: permitted ? "PERMIT" : "DENY",
    reason_code: permitted ? null : "NOT_A_PARTY",
  });
  if (permitted) return null;
  return jsonError(404, "NOT_FOUND", "not found");
}
