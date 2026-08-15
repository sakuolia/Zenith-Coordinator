/**
 * @file legacy_core.ts — An intentionally adversarial mock of a legacy
 * core-banking system (勘定系).
 *
 * A greenfield ledger (see `bank/ledger.ts`) is a friendly target: online 24/365,
 * idempotent, able to hold a reservation, queryable at any time. A real Japanese
 * mainframe core is none of those things, and that gap — not the protocol — is
 * where legacy integration projects die. This mock reproduces the hostility so
 * the adapter can be proven against it:
 *
 *   1. Batch window        — offline for nightly batch; any call fails while down.
 *   2. Non-idempotent      — the posting API has no de-dup; a re-send double-applies.
 *   3. No reservation      — it can only DEBIT / CREDIT / read a balance; no "hold".
 *   4. No mid-batch query  — the balance cannot be read while offline.
 *   5. Can time out        — a call may fail before the core processes it.
 *   6. No push endpoint    — it cannot receive notifications (pull only).
 *
 * A real core does still enforce one thing unconditionally: it never lets an
 * account go negative — {@link postDebit} returns `{applied:false}` rather than
 * moving the balance when funds are insufficient.
 *
 * BOUNDARY, and why it matters for vendor connectability: {@link postDebit} and
 * {@link postCredit} are the ENTIRE public posting surface. No method here lets
 * a caller reach into `LegacyCoreAccounts` / `LegacyCoreJournal` directly or
 * compose statements that ride in the SAME database transaction as the
 * adapter's own bookkeeping (AdapterOutbox, AdapterShadow). A real vendor core
 * is a separate system reached over MQ, a fixed-length batch file, or a
 * mainframe RPC — it will never share a SQL transaction with an external
 * coordinator, and would not agree to a contract that required it to. This
 * mock happens to share a process and a SQLite handle with the adapter (see
 * `createTestDb`), but that is a test-harness convenience, not part of the
 * contract: internally, `postDebit`/`postCredit` use their OWN atomic
 * transaction (their two tables only), exactly the way any vendor's own
 * ledger-plus-journal update already is atomic within their system — nothing
 * about that requires them to change anything for ZC. See
 * docs/specs/20_method_design.md § ベンダー接続可否 for what a real (physically
 * separate) core would additionally need, and the residual crash window this
 * boundary introduces (mitigated by reconciliation, not by pretending the
 * boundary doesn't exist).
 *
 * The adapter (`adapter.ts`) absorbs every one of these so ZC sees a clean,
 * real-time, idempotent, 24/365 surface. Nothing here is wired into the ZC
 * state machine; it is a test double for the legacy subsystem.
 */
import { nowISO } from "../../types";

/** Structured failures the hostile core raises. */
export type CoreErrorCode =
  | "CORE_OFFLINE" // called inside the batch window
  | "CORE_TIMEOUT" // the request failed before the core processed it
  | "INSUFFICIENT_FUNDS" // debit exceeds balance (DIRECT path only)
  | "UNSUPPORTED"; // capability the core does not have (e.g. name-check)

export class LegacyCoreError extends Error {
  constructor(
    public readonly code: CoreErrorCode,
    message?: string
  ) {
    super(message ?? code);
    this.name = "LegacyCoreError";
  }
}

export type CorePostingOp = "DEBIT" | "CREDIT";

/** Result of a posting call. `applied:false` means the core's OWN ledger
 * refused it (insufficient funds) — no partial effect, nothing to undo. */
export interface PostResult {
  applied: boolean;
  reason?: "INSUFFICIENT_FUNDS";
}

export interface PostMeta {
  txid?: string;
  requestId?: string;
}

/**
 * A hostile legacy core reached, in this reference implementation, over a
 * shared D1 handle (a real integration would reach it over MQ/fixed-length
 * batch file/mainframe RPC instead — see the file-level doc comment on why
 * that channel difference does not change this class's public contract).
 * Availability and timeout behaviour are explicit toggles so tests are
 * deterministic — no wall-clock dependence.
 */
export class LegacyCore {
  private online = true;
  private timingOut = false;

  constructor(private readonly db: D1Database) {}

  /** Simulate the nightly batch window closing (2) / opening the core. */
  setOnline(online: boolean): void {
    this.online = online;
  }

  /** Simulate the core failing a request before it is processed (5). */
  setTimingOut(timingOut: boolean): void {
    this.timingOut = timingOut;
  }

  isOnline(): boolean {
    return this.online;
  }

  private guardReachable(): void {
    if (!this.online) throw new LegacyCoreError("CORE_OFFLINE");
    if (this.timingOut) throw new LegacyCoreError("CORE_TIMEOUT");
  }

  /**
   * Public reachability gate for the adapter's drain path, so it can decide
   * to leave a claimed outbox row PENDING (release the claim) before even
   * attempting a posting call, without duplicating the offline/timeout logic.
   */
  assertReachable(): void {
    this.guardReachable();
  }

  /**
   * Read a balance. Throws while offline — a real batch core cannot answer a
   * balance query mid-batch (4). Reconciliation therefore only runs online.
   */
  async getBalance(bankId: string, accountId: string): Promise<number> {
    this.guardReachable();
    const row = await this.db
      .prepare(`SELECT balance FROM LegacyCoreAccounts WHERE bank_id=? AND account_id=?`)
      .bind(bankId, accountId)
      .first<{ balance: number }>();
    return row?.balance ?? 0;
  }

  /**
   * Look up the account holder name (backs name-check(7)/account-verify(8) —
   * docs/specs/10_requirements.md §1). Returns null if the account is
   * unknown. Subject to the same offline/timeout guard as getBalance: a real
   * batch core cannot answer a name lookup mid-batch either.
   */
  async getAccountName(bankId: string, accountId: string): Promise<string | null> {
    this.guardReachable();
    const row = await this.db
      .prepare(`SELECT customer_name FROM LegacyCoreAccounts WHERE bank_id=? AND account_id=?`)
      .bind(bankId, accountId)
      .first<{ customer_name: string | null }>();
    return row?.customer_name ?? null;
  }

  /**
   * Post a credit. A legacy core always accepts a credit (crediting an
   * account has no funds precondition) — atomic within the core's own two
   * tables, no caller-visible intermediate state.
   */
  async postCredit(
    bankId: string,
    accountId: string,
    amount: number,
    meta: PostMeta = {}
  ): Promise<PostResult> {
    this.guardReachable();
    await this.db.batch(this.rawPostingStatements(bankId, accountId, "CREDIT", amount, meta));
    return { applied: true };
  }

  /**
   * Post a debit. Atomically checks sufficient funds and, if so, moves the
   * balance and appends the journal row — all within the core's OWN
   * transaction (its accounts table + its journal table only). Returns
   * `{applied:false, reason:'INSUFFICIENT_FUNDS'}` rather than throwing when
   * funds are short: this is an ordinary business outcome the core reports
   * synchronously, not a channel failure.
   */
  async postDebit(
    bankId: string,
    accountId: string,
    amount: number,
    meta: PostMeta = {}
  ): Promise<PostResult> {
    this.guardReachable();
    const now = nowISO();
    const sufficientExists = `EXISTS (
      SELECT 1 FROM LegacyCoreAccounts WHERE bank_id = ? AND account_id = ? AND balance >= ?
    )`;
    // Two statements, ONE precondition, both scoped to the core's own tables —
    // ordinary same-system atomicity, not a cross-boundary trick. (Unlike an
    // adapter-composed batch, there is no third party's table in here.)
    //
    // ORDER MATTERS: the journal INSERT's `WHERE EXISTS` must run BEFORE the
    // balance UPDATE, not after — `db.batch()` executes statements strictly in
    // array order and the EXISTS subquery reads LIVE table state, so if the
    // balance update ran first, the journal check would evaluate the
    // ALREADY-DECREMENTED balance instead of the pre-debit balance. On a
    // single call this is invisible (sufficient funds stay sufficient either
    // way); it only surfaces on a back-to-back double-post of a debit that
    // leaves the account with LESS than the debit amount after the first
    // application — exactly the scenario the crash-window test in
    // adversarial.test.ts exercises, which is how this ordering bug was
    // caught. Journal-first keeps both statements reading the true pre-batch
    // balance.
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO LegacyCoreJournal (bank_id, account_id, amount, op, txid, request_id, applied_at)
           SELECT ?, ?, ?, 'DEBIT', ?, ?, ?
            WHERE ${sufficientExists}`
        )
        .bind(
          bankId,
          accountId,
          -amount,
          meta.txid ?? null,
          meta.requestId ?? null,
          now,
          bankId,
          accountId,
          amount
        ),
      this.db
        .prepare(
          `UPDATE LegacyCoreAccounts SET balance = balance - ? WHERE bank_id=? AND account_id=? AND balance >= ?`
        )
        .bind(amount, bankId, accountId, amount),
    ]);
    const applied = (results[0]?.meta.changes ?? 0) > 0;
    return applied ? { applied: true } : { applied: false, reason: "INSUFFICIENT_FUNDS" };
  }

  /**
   * The hostile synchronous posting API used ONLY by the baseline tests that
   * demonstrate the core's raw non-idempotency with NO adapter protection
   * (`applyNonIdempotent` — no de-dup, calling twice moves the balance
   * twice). Not used by the adapter; contrast {@link postDebit}/{@link postCredit},
   * which are what the adapter actually calls.
   */
  async applyNonIdempotent(
    bankId: string,
    accountId: string,
    op: CorePostingOp,
    amount: number,
    requestId?: string
  ): Promise<void> {
    this.guardReachable();
    if (op === "DEBIT") {
      const bal = await this.getBalance(bankId, accountId);
      if (bal < amount) throw new LegacyCoreError("INSUFFICIENT_FUNDS");
    }
    await this.db.batch(this.rawPostingStatements(bankId, accountId, op, amount, { requestId }));
  }

  /** Internal statement builder shared by postCredit and applyNonIdempotent. */
  private rawPostingStatements(
    bankId: string,
    accountId: string,
    op: CorePostingOp,
    amount: number,
    meta: PostMeta
  ): D1PreparedStatement[] {
    const signed = op === "DEBIT" ? -amount : amount;
    const now = nowISO();
    return [
      this.db
        .prepare(
          `INSERT INTO LegacyCoreAccounts (bank_id, account_id, balance)
           VALUES (?, ?, ?)
           ON CONFLICT(bank_id, account_id) DO UPDATE SET balance = balance + ?`
        )
        .bind(bankId, accountId, signed, signed),
      this.db
        .prepare(
          `INSERT INTO LegacyCoreJournal (bank_id, account_id, amount, op, txid, request_id, applied_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(bankId, accountId, signed, op, meta.txid ?? null, meta.requestId ?? null, now),
    ];
  }

  /**
   * Seed (or adjust) an account's opening balance and holder name. Used by
   * the adapter's `initAccount` — a legitimate production operation (account
   * onboarding / prefund sync), not a test-only backdoor. Contrast
   * {@link injectDriftForTest}.
   */
  async seedOpeningBalance(
    bankId: string,
    accountId: string,
    amount: number,
    customerName?: string
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO LegacyCoreAccounts (bank_id, account_id, balance, customer_name)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(bank_id, account_id) DO UPDATE
           SET balance = balance + ?, customer_name = COALESCE(excluded.customer_name, customer_name)`
      )
      .bind(bankId, accountId, amount, customerName ?? null, amount)
      .run();
  }

  /** Remove an account and its journal entries entirely — backs cleanup-bank(13). */
  async removeAccount(bankId: string, accountId: string): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(`DELETE FROM LegacyCoreAccounts WHERE bank_id=? AND account_id=?`)
        .bind(bankId, accountId),
      this.db
        .prepare(`DELETE FROM LegacyCoreJournal WHERE bank_id=? AND account_id=?`)
        .bind(bankId, accountId),
    ]);
  }

  /**
   * Out-of-band mutation used ONLY by tests to inject a discrepancy the adapter
   * did not cause (a lost posting, a manual core correction), so reconciliation
   * has real drift to detect. Bypasses availability, journalling, and the
   * funds guard — deliberately, since this simulates something happening
   * to the core OUTSIDE the adapter's control.
   */
  async injectDriftForTest(bankId: string, accountId: string, delta: number): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO LegacyCoreAccounts (bank_id, account_id, balance)
         VALUES (?, ?, ?)
         ON CONFLICT(bank_id, account_id) DO UPDATE SET balance = balance + ?`
      )
      .bind(bankId, accountId, delta, delta)
      .run();
  }
}
