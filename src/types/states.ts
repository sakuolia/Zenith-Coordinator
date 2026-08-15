/**
 * @file states.ts — All state union types and enum-like string literals.
 *
 * Pure string unions with no intra-package dependencies. Imported by rows.ts,
 * api.ts, and any module that needs to refer to a state or mode value.
 */

// ---------------------------------------------------------------------------
// ZC Transaction State Machine
// ---------------------------------------------------------------------------

/**
 * Transaction state machine for the Zenith Coordinator.
 *
 * Lifecycle: RECEIVED -> PRECHECKED -> H_RESERVED -> DECIDED_TO_SETTLE
 *   -> PAYER_EXEC_CONFIRMED -> PAYEE_EXEC_CONFIRMED -> SETTLED
 */
export type TxState =
  | "RECEIVED"
  | "PRECHECKED"
  | "PRECHECKED_SUSPENDED"
  | "H_RESERVED"
  | "HTLC_LOCKED"
  | "HTLC_ONCHAIN_PENDING"
  | "HTLC_FULFILL_REQUESTED"
  | "DECIDED_TO_SETTLE"
  | "DECIDED_CANCEL"
  | "PAYER_EXEC_CONFIRMED"
  | "PAYEE_EXEC_CONFIRMED"
  | "SETTLED"
  | "SUSPENDED"
  | "FAILED_EXECUTION"
  | "CANCELLED";

/** State machine for HTLC (Hash Time-Locked Contract) transactions. */
export type HtlcState =
  | "HTLC_RECEIVED"
  | "HTLC_LOCKED"
  /** Cross-chain HTLC (テーマA): ZC-side locked, waiting for the onchain
   *  escrow leg under the same `hashlock` to be observed by a Watcher. */
  | "HTLC_ONCHAIN_PENDING"
  | "HTLC_FULFILL_REQUESTED"
  | "DECIDED_TO_SETTLE"
  | "PAYER_EXEC_CONFIRMED"
  | "PAYEE_EXEC_CONFIRMED"
  | "SETTLED"
  | "SUSPENDED"
  | "DECIDED_CANCEL"
  | "CANCELLED"
  | "FAILED_EXECUTION";

/** State machine for GTID coordinated multi-leg transactions. */
export type GtidState =
  | "GT_RECEIVED"
  | "GT_PRECHECKED"
  | "GT_DECIDED_TO_SETTLE"
  | "GT_DECIDED_CANCEL"
  | "GT_SETTLED"
  | "GT_SUSPENDED"
  | "GT_CANCELLED"
  | "GT_FAILED";

/** State of an individual leg within a GTID coordinated transaction. */
export type LegState =
  | "LEG_REGISTERED"
  | "LEG_READY_CHECKED"
  | "LEG_PAYER_CONFIRMED"
  | "LEG_PAYEE_CONFIRMED"
  | "LEG_SETTLED"
  | "LEG_SUSPENDED"
  | "LEG_FAILED";

/**
 * DNS (Deferred Net Settlement) cycle state.
 * - OPEN: Accepting transactions for netting.
 * - KICKED: Net positions calculated; awaiting settlement.
 * - SETTLED: All net positions settled via BOJ.
 * - HOLD_ACTIVE: Settlement suspended (e.g. insufficient funds at BOJ).
 */
export type DnsState = "OPEN" | "KICKED" | "SETTLED" | "HOLD_ACTIVE";

/**
 * IGS (Interbank Gross Settlement) operating mode.
 * - NORMAL: Standard RTGS processing.
 * - STOP: Settlement halted.
 * - RINGFENCED: Only pre-approved transactions settle.
 * - RINGFENCED_PLUS: Stricter ringfencing with additional controls.
 */
export type IgsMode = "NORMAL" | "STOP" | "RINGFENCED" | "RINGFENCED_PLUS";

/** Investigation case lifecycle state. */
export type CaseState = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "ESCALATED";

/**
 * Request-to-Pay lifecycle state.
 *
 * The single, authoritative set of states that resulted from consolidating the
 * old `state` (REQUESTED|ATTEMPTED|SETTLED|EXPIRED|FAILED) and the old
 * `rtp_status` (CREATED|NOTIFIED|...) into a single `state` column in
 * the RTP consolidation.
 *  - CREATED      : RtpRequests row created, bank not yet notified
 *  - NOTIFIED     : rtp-notify to the payer bank succeeded
 *  - ACCEPTED     : payer approved (transient state before TX creation — usually not passed through)
 *  - TX_CREATED   : the linked transfer Transaction has been created
 *  - COMPLETED    : the transfer is confirmed SETTLED
 *  - DECLINED     : payer declined
 *  - EXPIRED      : expires_at elapsed
 *  - FAILED       : other failure such as exceeding max_attempts
 */
export type RtpState =
  | "CREATED"
  | "NOTIFIED"
  | "ACCEPTED"
  | "TX_CREATED"
  | "COMPLETED"
  | "DECLINED"
  | "EXPIRED"
  | "FAILED";

/**
 * Processing lane determining settlement speed and method.
 * - EXPRESS: Real-time gross settlement (seconds).
 * - STANDARD: Near-real-time with DNS batching.
 * - BULK: Batch processing (salary, utility).
 * - DEFERRED: Deferred settlement via DNS cycle.
 * - RTP: Request-to-Pay initiated by payee.
 * - HTLC: Hash Time-Locked Contract conditional payment.
 * - HIGH_VALUE: Large-value transactions requiring IGS/RTGS settlement.
 */
export type LaneType = "EXPRESS" | "STANDARD" | "BULK" | "DEFERRED" | "RTP" | "HTLC" | "HIGH_VALUE";

/**
 * Domain of the `Transactions.lane` column.
 *
 * Wider than {@link LaneType}: GTID legs are materialised as Transactions rows
 * with `lane='GTID'` by `src/zc/lanes/gtid/advance.ts`, but `GTID` is never a
 * client-supplied lane on `POST /api/transfers` — it is produced internally.
 *
 * `DIRECT_DEBIT` is likewise internal-only: a continuous-collection contract
 * fires a `ScheduledCollection` on its due date and *that* materialises the
 * Transactions row. There is no path from `POST /api/transfers` to this lane —
 * every collection must pass through the notice entity, which is what carries
 * the mandate-scope check, the budget reservation, and the charge-item
 * uniqueness (docs/specs/10_requirements.md 序章, rule 3).
 *
 * The three collection modes (REALTIME / SCHEDULED / SCHEDULED_LONG) are *not*
 * separate lane values. They differ in when the result becomes final, which is
 * a property of the notice, so the mode lives on `ScheduledCollection.mode`
 * rather than splitting this column.
 *
 * HTLC_AUTH is deliberately *not* a member: an authorisation flow is written
 * with `lane='HTLC'` plus `flow:'HTLC_AUTH'` in the FinalityLog payload
 * (`src/zc/lanes/htlc_auth/approve.ts`), so it is a flow on the HTLC lane
 * rather than a lane of its own.
 *
 * See docs/specs/31_schema.md § Transactions and docs/specs/10_requirements.md 序章.
 */
export type TxLane = LaneType | "GTID" | "DIRECT_DEBIT";

/** Transaction purpose category. */
export type PurposeType = "MERCHANT" | "P2P" | "BILL" | "SALARY" | "REFUND";

/**
 * ZC-wide operational mode (テーマ H 可搬性と縮退 — portability and graceful degradation).
 *
 * - NORMAL: normal operation.
 * - BCP_READONLY: vendor-outage degradation mode — money-movement requests
 *   are rejected (`SYSTEM_BCP_READ_ONLY`); read-only queries are unaffected.
 *   The same "degrade to read-only when uncertain" posture as DNS_HOLD.
 *   Operator-controlled (declared/cleared via /internal/system-mode/bcp-*).
 * - QUORUM_LOSS_READONLY: design-principle-10 degradation — the consensus
 *   log backing the single source of truth has lost quorum, so the system
 *   refuses to commit new state ("when uncertain, degrade to read-only to
 *   avoid mis-decisions") and rejects money movement with
 *   `SYSTEM_QUORUM_LOSS_READ_ONLY`. Driven automatically by quorum health
 *   reconciliation (`src/zc/platform/quorum.ts`) — entered on quorum loss and
 *   cleared automatically on quorum recovery, never by an operator toggle.
 */
export type SystemModeValue = "NORMAL" | "BCP_READONLY" | "QUORUM_LOSS_READONLY";

// ---------------------------------------------------------------------------
// Bank-side State Types
// ---------------------------------------------------------------------------

/**
 * Suspense (escrow) account entry lifecycle.
 * - RESERVED: Funds reserved from payer account.
 * - EXECUTED: Debit/credit executed against customer account.
 * - HV_TRANSIT: High-value funds in transit via IGS.
 * - HTLC_LOCKED: Funds locked under HTLC hash-lock.
 * - LANDED: Credit landed in payee suspense (hard landing).
 * - SETTLED: DNS/IGS settlement completed.
 * - CUSTODY: Funds held in custody (payee account frozen/closed/not found).
 * - RETURNED: Funds returned to originator.
 */
export type SuspenseStatus =
  | "RESERVED"
  | "EXECUTED"
  | "HV_TRANSIT"
  | "HTLC_LOCKED"
  | "LANDED"
  | "SETTLED"
  | "CUSTODY"
  | "RETURNED";

/** Direction of a suspense entry relative to the bank. */
export type SuspenseDirection = "PAY" | "RECEIVE" | "HV_TRANSIT" | "HTLC";

/** Status of a ZC Ingress command processed by the bank. */
export type ZcRequestStatus = "PROCESSING" | "DONE" | "PROOF_ISSUED";

/** Customer account status governing transaction eligibility. */
export type AccountStatus = "NORMAL" | "FROZEN" | "CLOSING_HOLD" | "CLOSED";

/**
 * Bank account type.
 * - SAVINGS/CURRENT: Customer deposit accounts.
 * - SUSPENSE: Internal escrow account for in-flight transactions.
 * - SETTLEMENT: ZC settlement account (nostro equivalent).
 * - ASSET: Bank's own asset account (e.g. cash).
 * - BOJ: Bank of Japan current account (prefund balance).
 */
export type AccountType = "SAVINGS" | "CURRENT" | "SUSPENSE" | "SETTLEMENT" | "ASSET" | "BOJ";

// ---------------------------------------------------------------------------
// Feature State Types
// ---------------------------------------------------------------------------

export type TxEventStatus = "OK" | "NG" | "PENDING";

export type FilterType =
  | "SENDER_BLOCK"
  | "SENDER_BANK_BLOCK"
  | "AMOUNT_LIMIT"
  | "EDI_PATTERN"
  | "REQUIRE_APPROVAL";

export type FilterAction = "REJECT" | "HOLD_CONFIRM" | "HOLD_MANUAL";
export type FilterScope = "BANK_WIDE" | "ACCOUNT";
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "TIMEOUT";

export type HtlcAuthStatus =
  | "AUTH_REQUESTED"
  | "AUTH_APPROVED"
  | "AUTH_DECLINED"
  | "CAPTURED"
  | "VOIDED"
  | "EXPIRED";

export type IgsStatus = "REQUESTED" | "SETTLED" | "FAILED" | "HOLD" | "TIMEOUT";
export type ExternalSettlementStatus = "NONE" | "REQUESTED" | "SETTLED" | "FAILED" | "HOLD";

export type VerificationStatus =
  | "PENDING"
  | "MATCHED"
  | "UNMATCHED"
  | "NOT_FOUND"
  | "ERROR"
  | "EXPIRED";

export type NotificationStatus = "PENDING" | "RETRY" | "DELIVERED" | "FAILED";

export type QrType = "STATIC" | "DYNAMIC";

export type RichDataType = "EDI" | "INVOICE" | "ATTACHMENT_META" | "REMITTANCE";

export type CrossBorderStatus =
  | "INITIATED"
  | "ROUTED"
  | "FOREIGN_ACCEPTED"
  | "SETTLED"
  | "FAILED"
  | "RETURNED";

export type StreamEventType =
  | "TX_STATE_CHANGED"
  | "CREDIT_RECEIVED"
  | "IGS_SETTLED"
  | "DNS_KICKED"
  | "RTP_RECEIVED"
  | "ACCOUNT_VERIFIED"
  | "QR_PAYMENT_RECEIVED"
  | "CROSS_BORDER_UPDATED";

export type ParticipationMode = "FULL" | "RECEIVE_ONLY" | "SEND_ONLY";

export type ProxyType = "PHONE" | "EMAIL" | "NATIONAL_ID";
