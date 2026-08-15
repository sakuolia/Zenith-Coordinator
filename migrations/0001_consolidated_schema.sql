-- ============================================================================
-- Zenith Coordinator — consolidated schema (single source of truth)
--
-- This file is the result of squashing migrations 0001–0042 into one
-- definitive schema. The incremental ALTER/DROP/RENAME history has been
-- removed: every table is defined here in its final shape, with all
-- indexes and the seed data a fresh database needs.
--
-- The authoritative narrative documentation lives in docs/specs/31_schema.md.
-- When changing the schema, EDIT THIS FILE DIRECTLY (31_schema.md § マイグレーション
-- 運用 鉄則#1): this repo keeps the schema as a single consolidated file — do
-- NOT add new numbered migration files, and do not append trailing ALTERs (fold
-- column changes into the CREATE TABLE definitions). Update docs/specs/31_schema.md in
-- the same change; test/helpers/d1-mock.ts applies only this file, and
-- test/invariants/schema_doc_drift.test.ts enforces the doc sync.
-- ============================================================================

CREATE TABLE Participants (
  bank_id          TEXT    PRIMARY KEY,             -- '001', '002', ...
  bank_name        TEXT    NOT NULL,
  ingress_base_url TEXT    NOT NULL,                -- '/bank/001'
  h_limit          INTEGER NOT NULL DEFAULT 0,      -- H上限（円）
  h_used           INTEGER NOT NULL DEFAULT 0,      -- H消費中（円）
  is_active        INTEGER NOT NULL DEFAULT 1,
  registered_at    TEXT    NOT NULL                 -- RFC3339
  , participation_mode TEXT NOT NULL DEFAULT 'FULL'
  , tx_amount_limit INTEGER
  , daily_amount_limit INTEGER
  , daily_amount_used INTEGER NOT NULL DEFAULT 0
  , daily_amount_last_reset_date TEXT
  , hv_threshold INTEGER
  , operating_window_start TEXT
  , operating_window_end TEXT
  , participant_type TEXT NOT NULL DEFAULT 'BANK'
  -- FXP capability flag. A bank with is_fx_provider=1 and ParticipantCurrencyLimits
  -- rows for ≥2 currencies can post directional FxQuotes for those pairs.
  , is_fx_provider INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE Transactions (
  txid                  TEXT    PRIMARY KEY,
  lane                  TEXT    NOT NULL,           -- EXPRESS|STANDARD|BULK|DEFERRED|RTP|HTLC|HIGH_VALUE|GTID|DIRECT_DEBIT
  state                 TEXT    NOT NULL,           -- TxState
  amount_value          INTEGER NOT NULL,
  amount_currency       TEXT    NOT NULL DEFAULT 'JPY',
  payer_bank_id         TEXT    NOT NULL,
  payer_account_hash    TEXT    NOT NULL,
  payee_bank_id         TEXT    NOT NULL,
  payee_account_hash    TEXT,
  pspr_ref              TEXT,
  purpose               TEXT,                      -- MERCHANT|P2P|BILL|SALARY|REFUND
  idempotency_key       TEXT    UNIQUE NOT NULL,
  schema_version        TEXT    NOT NULL DEFAULT '1.0',
  h_reservation_id      TEXT,                      -- FK → HReservations
  decision_proof_ref    TEXT,
  finality_log_ref      TEXT,
  payer_bank_proof_ref  TEXT,                      -- JSON: bank_proof_ref構造
  payee_bank_proof_ref  TEXT,                      -- JSON: bank_proof_ref構造
  reason_code           TEXT,
  case_id               TEXT,
  dns_cycle_id          TEXT,
  expires_at            TEXT,                      -- RFC3339
  version               INTEGER NOT NULL DEFAULT 0, -- 楽観的ロック
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
  , external_settlement_status TEXT DEFAULT 'NONE'
  , verification_id TEXT
  , edi_ref TEXT
  , fatf_data_json TEXT
  , is_cross_border INTEGER NOT NULL DEFAULT 0
  , fatf16_applicable INTEGER NOT NULL DEFAULT 0
  , mandate_id TEXT
  , pending_request_json TEXT
  -- 単一所有者則 (docs/specs/30_internal_design.md §5): the single party
  -- currently allowed to move this row. 'ZC' | 'CYCLE:<cycle_id>' |
  -- 'VENUE:<venue_id>' | 'CHAIN:<watcher_set>'. Handoffs go through
  -- transferOwnership / transitionWithLog setColumns (src/zc/lanes/_helpers.ts);
  -- the timeout sweep only touches owner='ZC' rows.
  , owner TEXT NOT NULL DEFAULT 'ZC'
  -- When the wait the timeout sweep is measuring began. Written ONLY by the
  -- lane helpers (insertTxWithLog / transitionWithLog, src/zc/lanes/_helpers.ts)
  -- and by the Authority Check marker (src/zc/lanes/_authority_check.ts).
  --
  -- Why not `updated_at`: every timer used to measure from `updated_at`, but
  -- that column moves on ANY write to the row, including ones that say nothing
  -- about progress — `case_id` when a CASE is opened against the transaction
  -- (src/zc/cases/case.ts), `edi_ref` when remittance data is linked
  -- (src/zc/richdata/edi.ts). Opening a CASE on a stalled transfer — exactly
  -- what an operator does about a stalled transfer — therefore pushed its own
  -- deadline back, and repeated touches pushed it back indefinitely. That
  -- defeats 有界時間内の検出 (docs/disclosure/CORE_DISCLOSURE.md【0013】(a),
  -- 【0124】4): the row that most needs the timer is the one most likely to be
  -- touched for another reason while it waits.
  --
  -- NULL only for rows written before this column existed; the sweeps read
  -- COALESCE(pending_since, updated_at) so those still expire.
  , pending_since TEXT
);

CREATE INDEX idx_tx_state ON Transactions(state);
CREATE INDEX idx_tx_owner ON Transactions(owner, state);
CREATE INDEX idx_tx_payer ON Transactions(payer_bank_id, state);
CREATE INDEX idx_tx_payee ON Transactions(payee_bank_id, state);
CREATE INDEX idx_tx_dns   ON Transactions(dns_cycle_id);
CREATE INDEX idx_tx_updated_at ON Transactions(updated_at);
CREATE INDEX idx_tx_lane_state ON Transactions(lane, state);
CREATE INDEX idx_transactions_mandate_id ON Transactions(mandate_id);

CREATE TABLE HReservations (
  reservation_id TEXT    PRIMARY KEY,
  txid           TEXT    NOT NULL,
  bank_id        TEXT    NOT NULL,
  amount         INTEGER NOT NULL,
  mode           TEXT    NOT NULL DEFAULT 'RESERVED', -- RESERVED|LOCKED
  is_released    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  released_at    TEXT
  , currency TEXT NOT NULL DEFAULT 'JPY'
  -- NB: no FK on txid. H is reserved against a *predicted* (deterministic) txid
  -- before the leg's Transactions row exists (GTID/FX: see
  -- src/zc/lanes/gtid/advance.ts — reserveH precedes insertTxWithLog), so this
  -- column is a forward reference, not a satisfiable FK.
);

CREATE INDEX idx_hres_bank ON HReservations(bank_id, is_released);

CREATE TABLE FinalityLog (
  log_id       TEXT    PRIMARY KEY,                -- UUID
  txid         TEXT,
  gtid         TEXT,
  event_type   TEXT    NOT NULL,                   -- A.0 cmd/event一覧のname
  state_from   TEXT,
  state_to     TEXT    NOT NULL,
  payload_json TEXT    NOT NULL,                   -- イベント全体
  event_seq    INTEGER NOT NULL,
  occurred_at  TEXT    NOT NULL
  , prev_hash  TEXT
  , entry_hash TEXT
);

CREATE INDEX idx_fl_txid ON FinalityLog(txid);
CREATE INDEX idx_fl_gtid ON FinalityLog(gtid);
CREATE INDEX idx_fl_seq  ON FinalityLog(event_seq);
CREATE INDEX idx_fl_chain_seq ON FinalityLog(txid, event_seq);
CREATE INDEX idx_fl_gchain_seq ON FinalityLog(gtid, event_seq);
CREATE INDEX idx_fl_occurred_at ON FinalityLog(occurred_at);
CREATE UNIQUE INDEX idx_fl_chain_prev_hash
  ON FinalityLog(txid, prev_hash) WHERE txid IS NOT NULL;
CREATE UNIQUE INDEX idx_fl_event_seq_unique
  ON FinalityLog(event_seq);
CREATE UNIQUE INDEX idx_fl_gtid_chain_prev_hash
  ON FinalityLog(gtid, prev_hash) WHERE gtid IS NOT NULL AND txid IS NULL;

CREATE TABLE HtlcContracts (
  htlc_id                    TEXT    PRIMARY KEY,
  txid                       TEXT    NOT NULL UNIQUE,
  state                      TEXT    NOT NULL,     -- HtlcState
  hashlock                   TEXT    NOT NULL,     -- SHA256ハッシュ（hex）
  timelock                   TEXT    NOT NULL,     -- RFC3339（期限）
  amount_value               INTEGER NOT NULL,
  payer_bank_id              TEXT    NOT NULL,
  payee_bank_id              TEXT    NOT NULL,
  secret_verified            INTEGER NOT NULL DEFAULT 0, -- 1=検証済み
  authority_recheck_required INTEGER NOT NULL DEFAULT 0,
  version                    INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT    NOT NULL,
  updated_at                 TEXT    NOT NULL
  , cross_chain_source TEXT
  , onchain_timelock TEXT
  , onchain_lock_ref TEXT
  , onchain_lock_proof_json TEXT
  , onchain_release_proof_json TEXT
  , condition_template_id TEXT
  , onchain_min_confirmations INTEGER NOT NULL DEFAULT 0
  -- Watcher quorum: distinct Watcher operators required to attest the onchain
  -- release before it settles (trust minimization). 1 = legacy single-Watcher.
  , onchain_min_watchers INTEGER NOT NULL DEFAULT 1
  -- AND/OR condition composition: {template_id} | {op:AND|OR, operands:[...]} expr tree
  , condition_expr_json TEXT
  -- Cross-chain finality classification + quantum-risk evidence metadata
  , onchain_chain_class TEXT      -- PUBLIC|PRIVATE|PERMISSIONED
  , onchain_crypto_suite TEXT     -- e.g. secp256k1|ed25519|dilithium3
  , onchain_quantum_risk TEXT     -- VULNERABLE|RESISTANT|UNKNOWN
  , onchain_finality_class TEXT   -- PROBABILISTIC|DETERMINISTIC (derived from chain_class)
  , FOREIGN KEY (txid) REFERENCES Transactions(txid)
);

CREATE INDEX idx_htlc_payee_state ON HtlcContracts(payee_bank_id, state);
CREATE INDEX idx_htlc_payer_state ON HtlcContracts(payer_bank_id, state);
CREATE INDEX idx_htlc_timelock   ON HtlcContracts(timelock, state);
CREATE INDEX idx_htlc_condition_template ON HtlcContracts(condition_template_id);

CREATE TABLE GtidTransactions (
  gtid               TEXT    PRIMARY KEY,
  state              TEXT    NOT NULL,             -- GtidState
  initiator_bank_id  TEXT    NOT NULL,
  total_amount       INTEGER NOT NULL,
  leg_count          INTEGER NOT NULL,
  legs_ready_count   INTEGER NOT NULL DEFAULT 0,
  legs_settled_count INTEGER NOT NULL DEFAULT 0,
  expires_at         TEXT,
  version            INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
  , mandate_id TEXT
);

CREATE TABLE GtidLegs (
  leg_id         TEXT    PRIMARY KEY,
  gtid           TEXT    NOT NULL,
  txid           TEXT,                             -- 紐付くtxid（DECIDED後に確定）
  role           TEXT    NOT NULL,                 -- PAYER|PAYEE
  bank_id        TEXT    NOT NULL,
  account_hash   TEXT    NOT NULL,
  amount_value   INTEGER NOT NULL,
  state          TEXT    NOT NULL,                 -- LegState
  bank_proof_ref TEXT,                             -- JSON
  expires_at     TEXT,
  version        INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL, leg_currency TEXT NOT NULL DEFAULT 'JPY',
  -- The leg_id the participant registered, when registration-time normalization
  -- rewrote it (fan-out split / general N×M waterfall decomposition,
  -- docs/specs/20_method_design.md §2.2.5.1). NULL = this leg is as registered.
  -- Without it the derivation lives only inside a leg_id string format, and a
  -- participant cannot be told which of its own legs a settled sub-leg came from.
  origin_leg_id  TEXT,
  FOREIGN KEY (gtid) REFERENCES GtidTransactions(gtid),
  FOREIGN KEY (txid) REFERENCES Transactions(txid)
);

CREATE INDEX idx_legs_gtid ON GtidLegs(gtid);
CREATE INDEX idx_legs_txid ON GtidLegs(txid);

CREATE TABLE Cases (
  case_id      TEXT PRIMARY KEY,
  related_txid TEXT,
  related_gtid TEXT,
  state        TEXT NOT NULL DEFAULT 'OPEN',       -- CaseState: OPEN|IN_PROGRESS|RESOLVED|ESCALATED
  reason_code  TEXT NOT NULL,
  description  TEXT,
  opened_by    TEXT NOT NULL,                      -- 'ZC'|'BANK'|'OPS'
  sla_deadline TEXT,                               -- 期限。超過で ESCALATED へ昇格（docs/specs/20_method_design.md §10.7.4）
  evidence_refs TEXT,                              -- JSON array of evidence reference ids
  -- 集約（docs/specs/20_method_design.md §10.7.2）。同一原因の CASE を 1 件に束ねる鍵。
  -- 形は 'CAUSE:{cause_party_id|detection_path}:{reason_code}'。NULL は「集約しない
  -- CASE」＝ 1 件で完結する起票を表す。
  cause_key    TEXT,
  cause_party_id TEXT,                             -- 原因主体識別子。検出時点で未特定なら NULL
  detection_path TEXT,                             -- 原因主体が未特定のとき、集約鍵に用いる検出経路識別子
  occurrence_count INTEGER NOT NULL DEFAULT 1,     -- 関連付けた取引の件数（集約のたびに増分）
  last_occurred_at TEXT,                           -- 最終発生時刻（集約のたびに更新）
  escalated_at TEXT,                               -- ESCALATED へ遷移した時刻。二次エスカレーション判定の基準
  last_notified_at TEXT,                           -- 直近の二次通知時刻。同じ状況での再通知を抑止する
  resolved_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_case_txid ON Cases(related_txid);
CREATE INDEX idx_case_state      ON Cases(state, created_at);
-- Serves the escalation sweep: open cases whose SLA has run out.
CREATE INDEX idx_case_sla        ON Cases(state, sla_deadline);
CREATE INDEX idx_case_gtid       ON Cases(related_gtid);
-- Serves the aggregation lookup: "is an unresolved CASE already open for this cause?"
CREATE INDEX idx_case_cause      ON Cases(cause_key, state);

-- 集約された CASE に束ねられた個々の取引。件数は Cases.occurrence_count が保持し、
-- 本表はその内訳（どの取引が束ねられたか）を保持する。link_key は txid または gtid
-- のいずれかであり、(case_id, link_key) の一意性が二重計上を構造的に防ぐ。
CREATE TABLE CaseRelatedTransactions (
  case_id      TEXT NOT NULL,
  link_key     TEXT NOT NULL,                      -- related_txid ?? related_gtid
  related_txid TEXT,
  related_gtid TEXT,
  linked_at    TEXT NOT NULL,
  PRIMARY KEY (case_id, link_key),
  FOREIGN KEY (case_id) REFERENCES Cases(case_id)
);

CREATE INDEX idx_case_rel_txid ON CaseRelatedTransactions(related_txid);
CREATE INDEX idx_case_rel_gtid ON CaseRelatedTransactions(related_gtid);

CREATE TABLE Vault (
  vault_ref    TEXT    PRIMARY KEY,
  txid         TEXT,
  data_type    TEXT    NOT NULL,                   -- VaultDataType: AML_EVAL|PII|RISK_HINT|HTLC_PREIMAGE
  payload_json TEXT    NOT NULL,                   -- 暗号化不要（モック）
  expires_at   TEXT    NOT NULL,                   -- TTL
  is_evicted   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL
);

CREATE INDEX idx_vault_expires ON Vault(expires_at, is_evicted);

CREATE TABLE PsprRegistry (
  pspr_ref         TEXT PRIMARY KEY,
  payee_bank_id    TEXT NOT NULL,
  account_hash     TEXT NOT NULL,
  capability_state TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE|SUSPENDED|REVOKED
  digest           TEXT NOT NULL,                  -- 内容ハッシュ（改ざん検知）
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  revoked_at       TEXT
);

CREATE TABLE RtpRequests (
  rtp_id        TEXT    PRIMARY KEY,
  payee_bank_id TEXT    NOT NULL,
  payer_bank_id TEXT    NOT NULL,
  amount_value  INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  linked_txid   TEXT,
  expires_at    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
  , state TEXT NOT NULL DEFAULT 'CREATED'
  , payee_name TEXT
  , description TEXT
  , edi_ref TEXT
  , notified_at TEXT
  , linked_txid_new TEXT
  , payer_account_id TEXT
  , response_type TEXT
  , responded_at TEXT
  , payee_account_hash TEXT
);

CREATE INDEX idx_rtp_payer_state ON RtpRequests(payer_bank_id, state);
CREATE INDEX idx_rtp_payee_state ON RtpRequests(payee_bank_id, state);
CREATE INDEX idx_rtp_expires     ON RtpRequests(expires_at, state);

CREATE TABLE IdempotencyKeys (
  key           TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'PROCESSING', -- PROCESSING|DONE
  response_body TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  request_hash  TEXT                                -- sha256hex(JSON body); NULL for callers that don't compare bodies (e.g. nonce-replay keys)
);

CREATE INDEX idx_idemp_created   ON IdempotencyKeys(created_at);

CREATE TABLE BankAccounts (
  account_id    TEXT PRIMARY KEY,              -- UUID
  bank_id       TEXT NOT NULL,                 -- '001'|'002'
  customer_id   TEXT NOT NULL,
  customer_name TEXT NOT NULL,                 -- 名義（名義確認用）
  account_type  TEXT NOT NULL DEFAULT 'SAVINGS', -- SAVINGS|CURRENT|SUSPENSE|SETTLEMENT|ASSET|BOJ
  status        TEXT NOT NULL DEFAULT 'NORMAL',  -- NORMAL|FROZEN|CLOSING_HOLD|CLOSED
  freeze_reason TEXT,
  opened_at     TEXT NOT NULL,
  closed_at     TEXT
);

CREATE INDEX idx_acct_bank     ON BankAccounts(bank_id, status);
CREATE INDEX idx_acct_customer ON BankAccounts(customer_id);

CREATE TABLE BankJournals (
  journal_id  TEXT    PRIMARY KEY,             -- UUID
  bank_id     TEXT    NOT NULL,
  account_id  TEXT    NOT NULL,
  amount      INTEGER NOT NULL,                -- 符号付き（正=増加、負=減少）
  tx_type     TEXT    NOT NULL,                -- TRANSFER|RESERVE|EXECUTE|CREDIT|INTEREST|CASH|CORRECTION
  txid        TEXT,                            -- ZC取引ID（外部参照）
  tx_group_id TEXT    NOT NULL,                -- 仕訳グループ（ゼロサム確認単位）
  description TEXT,
  value_date  TEXT    NOT NULL,                -- 勘定日付 'YYYY-MM-DD'
  created_at  TEXT    NOT NULL
  -- 元帳金額の通貨次元。共有の透明・別段勘定をまたぐ単位混在を防ぐ（ISO 4217）。
  , amount_currency TEXT NOT NULL DEFAULT 'JPY'
);

CREATE INDEX idx_jnl_account ON BankJournals(account_id, value_date);
CREATE INDEX idx_jnl_txid    ON BankJournals(txid);
CREATE INDEX idx_jnl_group   ON BankJournals(tx_group_id);
CREATE INDEX idx_jnl_account_ccy ON BankJournals(account_id, amount_currency);

CREATE TABLE ZcRequests (
  request_id    TEXT PRIMARY KEY,              -- ZCのidempotency_key
  bank_id       TEXT NOT NULL,
  txid          TEXT,
  command_type  TEXT NOT NULL,                 -- reserve-funds|execute-debit|execute-credit|...
  status        TEXT NOT NULL DEFAULT 'PROCESSING', -- PROCESSING|DONE|PROOF_ISSUED
  response_body TEXT,                          -- 処理済みレスポンスJSON（重複時に返す）
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

CREATE INDEX idx_zcreq_txid ON ZcRequests(txid);

CREATE TABLE SuspenseDetails (
  suspense_id    TEXT    PRIMARY KEY,          -- UUID
  bank_id        TEXT    NOT NULL,
  account_id     TEXT    NOT NULL,             -- 元口座
  direction      TEXT    NOT NULL,             -- PAY|RECEIVE|HV_TRANSIT|HTLC
  status         TEXT    NOT NULL,             -- SuspenseStatus
  amount         INTEGER NOT NULL,
  txid           TEXT,
  request_id     TEXT,                         -- ZC request_id
  dns_cycle_id   TEXT,
  expires_at     TEXT,                         -- HTLC timelock
  custody_reason TEXT,                         -- CUSTODY時の理由
  settled_at     TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE INDEX idx_susp_account ON SuspenseDetails(account_id, status);
CREATE INDEX idx_susp_txid    ON SuspenseDetails(txid);

CREATE TABLE DailyBalances (
  account_id       TEXT    NOT NULL,
  snapshot_date    TEXT    NOT NULL,           -- 'YYYY-MM-DD'
  end_of_day_balance INTEGER NOT NULL,
  PRIMARY KEY (account_id, snapshot_date)
);

CREATE TABLE InterestRates (
  rate_id        TEXT PRIMARY KEY,
  bank_id        TEXT NOT NULL,
  account_type   TEXT NOT NULL,
  annual_rate    REAL NOT NULL,                -- 例: 0.001 = 0.1%
  effective_from TEXT NOT NULL,
  effective_to   TEXT
);

CREATE TABLE TxEventLog (
  log_id        TEXT    PRIMARY KEY,             -- UUID
  txid          TEXT,                            -- 関連取引ID（NULL可）
  correlation_id TEXT,                           -- ZC→Bank 横断追跡ID
  actor         TEXT    NOT NULL,                -- 'ZC'|'BANK_{bankId}'|'CUSTOMER'|'SYSTEM'
  action        TEXT    NOT NULL,                -- アクション名（下記定数参照）
  status        TEXT    NOT NULL,                -- 'OK'|'NG'|'PENDING'
  reason_code   TEXT,                            -- NGの場合の理由コード
  amount        INTEGER,                         -- 関連金額（円）
  bank_id       TEXT,                            -- 関連銀行ID
  account_id    TEXT,                            -- 関連口座（マスク済み可）
  details_json  TEXT,                            -- 追加コンテキスト JSON
  duration_ms   INTEGER,                         -- 処理時間（ミリ秒）
  occurred_at   TEXT    NOT NULL                 -- RFC3339
);

CREATE INDEX idx_evtlog_txid     ON TxEventLog(txid);
CREATE INDEX idx_evtlog_occurred ON TxEventLog(occurred_at);
CREATE INDEX idx_evtlog_actor    ON TxEventLog(actor, action, occurred_at);
CREATE INDEX idx_evtlog_status   ON TxEventLog(status, occurred_at);

CREATE TABLE BankAuditLog (
  log_id       TEXT    PRIMARY KEY,              -- UUID
  bank_id      TEXT    NOT NULL,
  txid         TEXT,                             -- ZC取引ID
  request_id   TEXT,                             -- ZC request_id（冪等キー）
  command      TEXT    NOT NULL,                 -- reserve-funds|execute-debit|...
  status       TEXT    NOT NULL,                 -- 'OK'|'NG'
  reason_code  TEXT,                             -- NGの場合の理由コード
  amount       INTEGER,                          -- 操作金額（円）
  account_id   TEXT,                             -- 対象口座ID
  details_json TEXT,                             -- 追加情報 JSON
  occurred_at  TEXT    NOT NULL                  -- RFC3339
);

CREATE INDEX idx_audlog_bank    ON BankAuditLog(bank_id, occurred_at);
CREATE INDEX idx_audlog_txid    ON BankAuditLog(txid);
CREATE INDEX idx_audlog_req     ON BankAuditLog(request_id);

CREATE TABLE PaymentFilters (
  filter_id      TEXT    PRIMARY KEY,            -- UUID
  bank_id        TEXT    NOT NULL,
  scope          TEXT    NOT NULL DEFAULT 'ACCOUNT',  -- 'BANK_WIDE'|'ACCOUNT'
  account_id     TEXT,                           -- scope=ACCOUNT の場合の対象口座
  filter_type    TEXT    NOT NULL,
  -- 'SENDER_BLOCK'      : 特定送金元口座ハッシュをブロック
  -- 'SENDER_BANK_BLOCK' : 特定送金元銀行IDをブロック
  -- 'AMOUNT_LIMIT'      : 金額上限（超過は action 適用）
  -- 'EDI_PATTERN'       : 電文EDIのパターンマッチ（正規表現）
  -- 'REQUIRE_APPROVAL'  : 全着金に顧客承認を要求
  condition_json TEXT    NOT NULL,               -- フィルタ条件 JSON
  -- SENDER_BLOCK:      {"sender_account_hash": "abc123"}
  -- SENDER_BANK_BLOCK: {"sender_bank_id": "001"}
  -- AMOUNT_LIMIT:      {"max_amount": 50000}
  -- EDI_PATTERN:       {"pattern": "\\bDENY\\b"}
  -- REQUIRE_APPROVAL:  {}
  action         TEXT    NOT NULL,               -- 'REJECT'|'HOLD_CONFIRM'|'HOLD_MANUAL'
  -- REJECT:       即時拒否（sender に返金）
  -- HOLD_CONFIRM: 顧客承認待ち（将来: プッシュ通知）
  -- HOLD_MANUAL:  行員手動対応待ち
  description    TEXT,                           -- 人間可読の説明
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT    NOT NULL,               -- customer_id or 'BANK'
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE INDEX idx_filter_bank    ON PaymentFilters(bank_id, is_active);
CREATE INDEX idx_filter_account ON PaymentFilters(account_id, is_active);

CREATE TABLE PaymentApprovalRequests (
  approval_id         TEXT    PRIMARY KEY,       -- UUID
  bank_id             TEXT    NOT NULL,
  account_id          TEXT    NOT NULL,          -- 承認が必要な受取口座
  txid                TEXT    NOT NULL,          -- 対象取引
  filter_id           TEXT    NOT NULL,          -- 発動したフィルタ
  status              TEXT    NOT NULL DEFAULT 'PENDING',
  -- 'PENDING'  : 顧客回答待ち
  -- 'APPROVED' : 顧客が承認
  -- 'REJECTED' : 顧客が拒否
  -- 'TIMEOUT'  : 期限切れ（自動拒否）
  sender_bank_id      TEXT    NOT NULL,          -- 送金元銀行ID
  sender_account_hash TEXT,                      -- 送金元口座ハッシュ
  amount_value        INTEGER NOT NULL,
  edi_data            TEXT,                      -- 送金電文のEDIデータ（表示用）
  expires_at          TEXT    NOT NULL,          -- 承認期限（超過でTIMEOUT）
  responded_at        TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);

CREATE INDEX idx_approval_account ON PaymentApprovalRequests(account_id, status);
CREATE INDEX idx_approval_txid    ON PaymentApprovalRequests(txid);

CREATE TABLE HtlcAuthWhitelist (
  whitelist_id          TEXT    PRIMARY KEY,     -- UUID
  payee_bank_id         TEXT    NOT NULL,        -- 加盟店の銀行ID
  payee_account_hash    TEXT    NOT NULL,        -- 加盟店の口座ハッシュ
  allowed_payer_bank_id TEXT,                    -- NULL=全銀行からのオーソリOK
  max_amount            INTEGER,                 -- NULL=金額制限なし（円）
  allowed_purposes      TEXT,                    -- JSON配列 ['MERCHANT'] NULL=全目的OK
  description           TEXT,                    -- 加盟店名・端末説明
  is_active             INTEGER NOT NULL DEFAULT 1,
  registered_at         TEXT    NOT NULL,
  expires_at            TEXT                     -- NULL=無期限
  , eligibility_template_id TEXT
);

CREATE INDEX idx_whitelist_payee ON HtlcAuthWhitelist(payee_bank_id, payee_account_hash, is_active);

CREATE TABLE HtlcAuthRequests (
  auth_id              TEXT    PRIMARY KEY,      -- UUID
  htlc_id              TEXT,                     -- 承認後に生成されるHTLC ID
  txid                 TEXT,                     -- 承認後に生成されるtxid
  status               TEXT    NOT NULL DEFAULT 'AUTH_REQUESTED',
  -- 'AUTH_REQUESTED' : オーソリリクエスト送信済み、送金側未承認
  -- 'AUTH_APPROVED'  : 送金側承認済み、HTLCロック確立
  -- 'AUTH_DECLINED'  : 送金側拒否
  -- 'CAPTURED'       : 受取側がキャプチャ（決済完了）
  -- 'VOIDED'         : 受取側がボイド（取消）
  -- 'EXPIRED'        : 有効期限切れ
  payee_bank_id        TEXT    NOT NULL,         -- 加盟店の銀行ID
  payee_account_hash   TEXT    NOT NULL,         -- 加盟店の口座ハッシュ
  payer_bank_id        TEXT    NOT NULL,         -- 顧客の銀行ID
  payer_account_hash   TEXT    NOT NULL,         -- 顧客の口座ハッシュ
  amount_value         INTEGER NOT NULL,
  purpose              TEXT,                     -- 取引目的
  description          TEXT,                     -- 商品・サービス説明（EDI相当）
  auth_expires_at      TEXT    NOT NULL,         -- 送金側が承認する期限
  capture_expires_at   TEXT    NOT NULL,         -- 受取側がキャプチャする期限（HTLCのtimelock）
  vault_ref            TEXT,                     -- Vault に保管した preimage への参照
  hashlock             TEXT,                     -- SHA256(preimage)（承認後に設定）
  whitelist_id         TEXT    NOT NULL,         -- FK → HtlcAuthWhitelist
  approved_at          TEXT,
  captured_at          TEXT,
  voided_at            TEXT,
  decline_reason       TEXT,
  idempotency_key      TEXT    NOT NULL UNIQUE,
  version              INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL
  , eligibility_attestation_id TEXT
  , FOREIGN KEY (whitelist_id) REFERENCES HtlcAuthWhitelist(whitelist_id)
);

CREATE INDEX idx_authreq_payer  ON HtlcAuthRequests(payer_bank_id, status);
CREATE INDEX idx_authreq_payee  ON HtlcAuthRequests(payee_bank_id, payee_account_hash, status);
CREATE INDEX idx_authreq_htlc   ON HtlcAuthRequests(htlc_id);

CREATE TABLE IgsRequests (
  ext_instruction_id  TEXT PRIMARY KEY,
  txid                TEXT NOT NULL,
  payer_bank_id       TEXT NOT NULL,
  payee_bank_id       TEXT NOT NULL,
  amount_value        INTEGER NOT NULL,
  amount_currency     TEXT NOT NULL DEFAULT 'JPY',
  status              TEXT NOT NULL DEFAULT 'REQUESTED',
  boj_settle_ref      TEXT,
  requested_at        TEXT NOT NULL,
  settled_at          TEXT,
  failed_reason       TEXT,
  retry_count         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_igs_txid   ON IgsRequests(txid);
CREATE INDEX idx_igs_status ON IgsRequests(status);

CREATE TABLE AccountVerifications (
  verification_id     TEXT PRIMARY KEY,
  request_bank_id     TEXT NOT NULL,
  target_bank_id      TEXT NOT NULL,
  target_account_hash TEXT NOT NULL,
  target_account_name TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  name_provided       TEXT,
  match_score         REAL,
  fraud_warning       INTEGER NOT NULL DEFAULT 0,
  cached_until        TEXT,
  idempotency_key     TEXT UNIQUE,
  created_at          TEXT NOT NULL,
  responded_at        TEXT
);

CREATE INDEX idx_av_target ON AccountVerifications(target_bank_id, target_account_hash);
CREATE INDEX idx_av_status ON AccountVerifications(status);

CREATE TABLE CreditNotifications (
  notification_id     TEXT PRIMARY KEY,
  txid                TEXT NOT NULL,
  payee_bank_id       TEXT NOT NULL,
  payee_account_hash  TEXT NOT NULL,
  amount_value        INTEGER NOT NULL,
  amount_currency     TEXT NOT NULL DEFAULT 'JPY',
  payer_bank_id       TEXT NOT NULL,
  payer_name_masked   TEXT,
  purpose             TEXT,
  edi_summary         TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING', -- NotificationStatus: PENDING|RETRY|DELIVERED|FAILED
  delivery_attempts   INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 5,
  created_at          TEXT NOT NULL,
  delivered_at        TEXT,
  next_retry_at       TEXT
);

CREATE INDEX idx_cn_payee ON CreditNotifications(payee_bank_id, status);
CREATE INDEX idx_cn_txid  ON CreditNotifications(txid);

CREATE TABLE EdiRecords (
  edi_ref             TEXT PRIMARY KEY,
  txid                TEXT,
  format_version      TEXT NOT NULL DEFAULT '1.0',
  invoice_number      TEXT,
  invoice_date        TEXT,
  payment_due_date    TEXT,
  tax_amount          INTEGER,
  tax_rate            REAL,
  discount_amount     INTEGER,
  note                TEXT,
  sender_ref          TEXT,
  receiver_ref        TEXT,
  line_items_json     TEXT,
  created_by_bank_id  TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE INDEX idx_edi_txid    ON EdiRecords(txid);
CREATE INDEX idx_edi_invoice ON EdiRecords(invoice_number);

CREATE TABLE ProxyDirectory (
  proxy_id            TEXT PRIMARY KEY,
  proxy_type          TEXT NOT NULL,
  proxy_value         TEXT NOT NULL,
  bank_id             TEXT NOT NULL,
  account_id          TEXT NOT NULL,
  account_holder_name TEXT NOT NULL,
  is_active           INTEGER NOT NULL DEFAULT 1,
  registered_at       TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(proxy_type, proxy_value)
);

CREATE INDEX idx_proxy_lookup ON ProxyDirectory(proxy_type, proxy_value, is_active);
CREATE INDEX idx_proxy_bank   ON ProxyDirectory(bank_id, account_id);

CREATE TABLE QrCodes (
  qr_ref              TEXT PRIMARY KEY,
  qr_type             TEXT NOT NULL,
  payee_bank_id       TEXT NOT NULL,
  payee_account_id    TEXT NOT NULL,
  payee_name          TEXT NOT NULL,
  amount_value        INTEGER,
  amount_currency     TEXT NOT NULL DEFAULT 'JPY',
  purpose             TEXT,
  edi_ref             TEXT,
  signature           TEXT NOT NULL,
  is_used             INTEGER NOT NULL DEFAULT 0,
  expires_at          TEXT,
  created_at          TEXT NOT NULL
);

CREATE INDEX idx_qr_payee ON QrCodes(payee_bank_id);

CREATE TABLE RichDataStore (
  data_ref            TEXT PRIMARY KEY,
  data_type           TEXT NOT NULL,               -- RichDataType: EDI|INVOICE|ATTACHMENT_META|REMITTANCE
  txid                TEXT,
  content_json        TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  r2_key              TEXT,
  created_by_bank_id  TEXT NOT NULL,
  retention_days      INTEGER NOT NULL DEFAULT 2555,
  created_at          TEXT NOT NULL,
  expires_at          TEXT
);

CREATE INDEX idx_rds_txid ON RichDataStore(txid);
CREATE INDEX idx_rds_type ON RichDataStore(data_type);

CREATE TABLE CrossBorderTransactions (
  cb_txid             TEXT PRIMARY KEY,
  domestic_txid       TEXT,
  direction           TEXT NOT NULL,
  foreign_fps_id      TEXT NOT NULL,
  foreign_bank_bic    TEXT NOT NULL,
  foreign_account_id  TEXT NOT NULL,
  foreign_currency    TEXT NOT NULL,
  foreign_amount      INTEGER NOT NULL,
  exchange_rate       REAL,
  domestic_amount     INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'INITIATED',
  settlement_bank_id  TEXT,
  nostro_account_ref  TEXT,
  fatf_data_json      TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_cb_domestic ON CrossBorderTransactions(domestic_txid);
CREATE INDEX idx_cb_status   ON CrossBorderTransactions(status);

CREATE TABLE EventStream (
  event_id            TEXT PRIMARY KEY,
  target_bank_id      TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  payload_json        TEXT NOT NULL,
  is_delivered        INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);

CREATE INDEX idx_es_bank ON EventStream(target_bank_id, is_delivered, created_at);

CREATE TABLE DnsCycles (
  cycle_id      TEXT PRIMARY KEY,
  business_date TEXT NOT NULL,                -- was UNIQUE, now allows multiple cycles/day
  state         TEXT NOT NULL DEFAULT 'OPEN', -- DnsState: OPEN|KICKED|SETTLED|HOLD_ACTIVE
  igs_mode      TEXT NOT NULL DEFAULT 'NORMAL',
  kicked_at     TEXT,
  settled_at    TEXT,
  hold_reason   TEXT,
  net_positions TEXT,
  updated_at    TEXT,
  created_at    TEXT NOT NULL
  , currency TEXT NOT NULL DEFAULT 'JPY'
  , intraday_seq INTEGER NOT NULL DEFAULT 1
  , hold_causing_participants TEXT
  -- RINGFENCED_PLUS promotion evidence (§11.4): ZC-computed recovery reserve +
  -- the digest of its inputs/formula/output and the confidence that gated it.
  , dns_recovery_reserve INTEGER
  , reserve_explain_hash TEXT
  , reserve_confidence   REAL
  -- 決済レール/チェーン。NULL=JPYクラシックBOJ-Net（{bank}-BOJ）。非JPYは
  -- 'ETH'|'POLYGON'|… を固定し、トークン化中銀当座 {bank}-CBT-{CCY}-{CHAIN} で確定。
  , settlement_chain TEXT
  -- Official-disclosure template id while the cycle is held (DNS_HOLD_{business_date}).
  -- NULL unless state='HOLD_ACTIVE'. The join key between ZC's official status and
  -- what a participant may show customers (docs/specs/10_requirements.md 3.3.1).
  , public_message_id TEXT
);

CREATE INDEX idx_dns_business_date ON DnsCycles(business_date);
CREATE INDEX idx_dns_state       ON DnsCycles(state, created_at);

CREATE TABLE CircuitBreakerState (
  bank_id               TEXT PRIMARY KEY,
  state                 TEXT NOT NULL DEFAULT 'CLOSED',  -- CLOSED|OPEN|HALF_OPEN
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  last_failure_at       TEXT,
  opened_at             TEXT,
  half_open_at          TEXT,
  updated_at            TEXT NOT NULL
  , total_requests     INTEGER NOT NULL DEFAULT 0
  , total_successes    INTEGER NOT NULL DEFAULT 0
  , total_failures     INTEGER NOT NULL DEFAULT 0
  , total_denied       INTEGER NOT NULL DEFAULT 0
  , half_open_inflight INTEGER NOT NULL DEFAULT 0
  , last_success_at    TEXT
);

CREATE TABLE ReversalRecords (
  reversal_id    TEXT PRIMARY KEY,
  original_txid  TEXT NOT NULL,                -- FK → Transactions.txid (SETTLED)
  reversal_txid  TEXT,                         -- FK → Transactions.txid (the compensating TX)
  amount         INTEGER NOT NULL,
  reason         TEXT NOT NULL,                -- CUSTOMER_DISPUTE|DUPLICATE_PAYMENT|...
  status         TEXT NOT NULL DEFAULT 'REQUESTED', -- REQUESTED|APPROVED|TX_CREATED|COMPLETED|REJECTED
  requested_by   TEXT NOT NULL,                -- bank_id or 'OPS'
  description    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
  , approval_ref TEXT
  , idempotency_key TEXT
);

CREATE INDEX idx_rev_original ON ReversalRecords(original_txid);
CREATE INDEX idx_rev_reversal_tx ON ReversalRecords(reversal_txid);
CREATE UNIQUE INDEX idx_rev_idempotency
  ON ReversalRecords(idempotency_key);

CREATE TABLE FinalitySeq (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  next_seq  INTEGER NOT NULL
);

CREATE TABLE DnsNetPositions (
  id            TEXT    PRIMARY KEY,
  cycle_id      TEXT    NOT NULL,
  bank_id       TEXT    NOT NULL,
  gross_send    INTEGER NOT NULL DEFAULT 0,
  gross_receive INTEGER NOT NULL DEFAULT 0,
  net_position  INTEGER NOT NULL DEFAULT 0,
  is_settled    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (cycle_id) REFERENCES DnsCycles(cycle_id)
);

-- IGS (HIGH_VALUE) blocked during a DNS hold, re-injected with a priority +
-- scheduled execution window (§4.4 類型B Defer queue).
CREATE TABLE IgsDeferQueue (
  defer_id                   TEXT PRIMARY KEY,
  txid                       TEXT NOT NULL,
  cycle_id                   TEXT NOT NULL,
  payer_bank_id              TEXT NOT NULL,
  payee_bank_id              TEXT NOT NULL,
  amount_value               INTEGER NOT NULL,
  reason_code                TEXT NOT NULL,        -- DNS_IGS_THROTTLED|DNS_RINGFENCED|DNS_HOLD_IGS_STOPPED
  priority                   INTEGER NOT NULL DEFAULT 100,  -- lower = higher priority
  scheduled_execution_window TEXT NOT NULL,        -- ISO ts; eligible for re-injection at/after
  status                     TEXT NOT NULL DEFAULT 'DEFERRED', -- DEFERRED|RESUMED|CANCELLED
  enqueued_at                TEXT NOT NULL,
  resumed_at                 TEXT
);
CREATE INDEX idx_igs_defer_status ON IgsDeferQueue(status, priority, scheduled_execution_window);
CREATE UNIQUE INDEX idx_igs_defer_txid ON IgsDeferQueue(txid);

-- Per (held cycle, participant) IGS admission budget consumed during a hold
-- (igs_throttle_budget fairness control, §11.4).
CREATE TABLE IgsThrottleState (
  cycle_id        TEXT NOT NULL,
  bank_id         TEXT NOT NULL,
  admitted_amount INTEGER NOT NULL DEFAULT 0,
  admitted_count  INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (cycle_id, bank_id)
);

-- Bulk LSM optimiser run audit (付録F.2 / F.3): input snapshot, constraint
-- digest, execution-set hash, trace digest, and objective metrics per window.
CREATE TABLE LsmRuns (
  run_id             TEXT PRIMARY KEY,
  business_date      TEXT NOT NULL,
  window_id          TEXT NOT NULL,
  mode               TEXT NOT NULL,          -- OPTIMIZED|FIFO|PRIORITY|THROTTLE
  is_fallback        INTEGER NOT NULL DEFAULT 0,
  input_snapshot_id  TEXT NOT NULL,
  constraints_digest TEXT NOT NULL,
  execution_set_hash TEXT NOT NULL,
  trace_digest       TEXT NOT NULL,
  candidate_count    INTEGER NOT NULL DEFAULT 0,
  selected_count     INTEGER NOT NULL DEFAULT 0,
  deferred_count     INTEGER NOT NULL DEFAULT 0,
  objective_metrics  TEXT NOT NULL,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_lsm_runs_date ON LsmRuns(business_date, created_at);

CREATE TABLE EntityStateLog (
  log_id       TEXT    PRIMARY KEY,           -- 'ESL-<uuid>'
  entity_type  TEXT    NOT NULL,              -- 'CASE'|'PSPR'|'BANK_ACCOUNT'|'REVERSAL'|'MANDATE'|'DEBIT_MANDATE'|'COLLECTION'
  entity_id    TEXT    NOT NULL,              -- the entity row's primary key value
  event_type   TEXT    NOT NULL,              -- domain event name (e.g. 'CaseOpened')
  state_from   TEXT,                          -- previous state; NULL on creation
  state_to     TEXT    NOT NULL,              -- new state
  reason_code  TEXT,                          -- optional reason for the change
  actor        TEXT,                          -- 'ZC'|'OPS'|'BANK_{bankId}'|'SYSTEM'
  payload_json TEXT,                          -- optional extra context (JSON)
  occurred_at  TEXT    NOT NULL               -- RFC3339
);

CREATE INDEX idx_esl_entity   ON EntityStateLog(entity_type, entity_id, occurred_at);
CREATE INDEX idx_esl_occurred ON EntityStateLog(occurred_at);

CREATE TABLE KeyRegistry (
  key_id      TEXT    PRIMARY KEY,           -- opaque external identifier
  owner_type  TEXT    NOT NULL,              -- 'PARTICIPANT'|'ATTESTER'|'AGENT'|'EXTERNAL_RAIL'
  owner_ref   TEXT    NOT NULL,              -- e.g. bank_id / participant_id / attester id
  public_key  TEXT    NOT NULL,              -- base64-encoded raw public key bytes
  algo        TEXT    NOT NULL,              -- 'ECDSA_P256'|'ED25519'
  valid_from  TEXT    NOT NULL,              -- RFC3339
  valid_to    TEXT,                          -- RFC3339, NULL = open-ended
  revoked_at  TEXT,                          -- RFC3339, NULL = not revoked
  status      TEXT    NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE'|'REVOKED'|'EXPIRED'
  created_at  TEXT    NOT NULL
);

CREATE INDEX idx_key_registry_owner ON KeyRegistry(owner_type, owner_ref);

CREATE TABLE ConditionTemplate (
  template_id            TEXT    PRIMARY KEY,        -- e.g. 'TPL-INSPECTION-COMPLETE'
  predicate_kind         TEXT    NOT NULL,           -- domain label, e.g. 'INSPECTION_COMPLETE'
  allowed_attester_scope TEXT    NOT NULL,           -- JSON: {key_ids?, owner_refs?, owner_types?}
  status                 TEXT    NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE'|'SUSPENDED'|'REVOKED'
  description            TEXT,
  registered_at          TEXT    NOT NULL,
  -- k-of-n distinct-operator quorum for this template's Attestations (mirrors
  -- HtlcContracts.onchain_min_watchers). 1 = single-attester (legacy default).
  min_attester_quorum    INTEGER NOT NULL DEFAULT 1,
  -- When non-NULL, ZC resolves this template against its own committed
  -- FinalityLog (a LedgerPredicate), not via an external attester; such
  -- templates carry an empty allowed_attester_scope so none can be recorded.
  ledger_predicate_json  TEXT
);

CREATE TABLE Attestation (
  attestation_id   TEXT    PRIMARY KEY,              -- 'ATT-<uuid>'
  template_id      TEXT    NOT NULL,
  subject_ref      TEXT    NOT NULL,                 -- txid / gtid / leg_id this attests to
  attester_key_id  TEXT    NOT NULL,                 -- KeyRegistry.key_id of the attester
  statement_hash   TEXT    NOT NULL,                 -- sha256 hex of the (off-ZC-held) statement
  signature        TEXT    NOT NULL,                 -- base64 signature over the attestation payload
  nonce            TEXT    NOT NULL,
  occurred_at      TEXT    NOT NULL,                 -- RFC3339, claimed by the attester
  verified_result  TEXT    NOT NULL,                 -- 'PASS'|'FAIL'
  created_at       TEXT    NOT NULL,
  FOREIGN KEY (template_id) REFERENCES ConditionTemplate(template_id)
);

CREATE INDEX idx_attestation_subject  ON Attestation(subject_ref);
CREATE INDEX idx_attestation_template ON Attestation(template_id);

CREATE TABLE Mandate (
  mandate_id               TEXT    PRIMARY KEY,        -- 'MANDATE-<uuid>'
  principal_participant_id TEXT    NOT NULL,           -- the delegating principal
  grantee_ref               TEXT    NOT NULL,          -- agent/participant the mandate is granted to
  parent_mandate_id         TEXT,                       -- NULL = root of the delegation chain
  max_amount                INTEGER,                    -- NULL = no amount limit
  allowed_purposes          TEXT,                       -- JSON array of purpose codes; NULL = unrestricted
  allowed_lanes             TEXT,                       -- JSON array of lane names; NULL = unrestricted
  valid_from                TEXT    NOT NULL,           -- RFC3339
  valid_to                  TEXT    NOT NULL,           -- RFC3339
  principal_key_id          TEXT    NOT NULL,           -- KeyRegistry.key_id of the principal
  signature                 TEXT    NOT NULL,           -- base64 signature over the mandate terms
  nonce                     TEXT    NOT NULL,
  occurred_at               TEXT    NOT NULL,           -- RFC3339, claimed by the principal
  revoked_at                TEXT,                        -- RFC3339, NULL = not revoked
  created_at                TEXT    NOT NULL,
  FOREIGN KEY (parent_mandate_id) REFERENCES Mandate(mandate_id)
);

CREATE INDEX idx_mandate_principal ON Mandate(principal_participant_id);
CREATE INDEX idx_mandate_grantee   ON Mandate(grantee_ref);
CREATE INDEX idx_mandate_parent    ON Mandate(parent_mandate_id);

-- ---------------------------------------------------------------------------
-- 継続収納（口座振替）  docs/specs/10_requirements.md §3.2.8 / 20_method_design.md §2.2.7
-- ---------------------------------------------------------------------------

-- 継続収納契約。顧客の署名した Mandate を根拠に、受取人が反復的に回収する
-- 権限の範囲を固定する。上限（*_cap）は本表に一元的に保持し、MandateBudget
-- 側に写しを持たせない（上限は契約の途中で変更されうるため。§3.2.8.4-12）。
CREATE TABLE DebitMandate (
  dd_mandate_id        TEXT    PRIMARY KEY,        -- 'DDM-<uuid>'
  mandate_id           TEXT    NOT NULL,           -- FK → Mandate（顧客署名の根拠）
  payer_bank_id        TEXT    NOT NULL,
  payer_account_alias  TEXT    NOT NULL,           -- ALS/Proxy 解決対象。口座番号を直書きしない
  payee_bank_id        TEXT    NOT NULL,
  payee_account_hash   TEXT    NOT NULL,
  product_ref          TEXT    NOT NULL,           -- 商材参照。ZC は意味を解釈しない不透明なスコープ鍵
  charge_mode          TEXT    NOT NULL,           -- 'PERIODIC' | 'ITEMIZED'
  period_cycle         TEXT,                       -- PERIODIC 時 'MONTHLY'|'YEARLY'。ITEMIZED は NULL
  collection_mode      TEXT    NOT NULL,           -- 'REALTIME'|'SCHEDULED'|'SCHEDULED_LONG'
  notice_days_min      INTEGER NOT NULL DEFAULT 0, -- 予告期間の下限（日）
  amend_freeze_hours   INTEGER NOT NULL,           -- 振替日から遡る凍結時刻（時間）
  ladder_max           INTEGER NOT NULL,           -- 段数上限（PR-DD-LADDER-MAX 以下）
  nonbusiness_day_rule TEXT    NOT NULL DEFAULT 'NEXT_BUSINESS', -- FORWARD|BACKWARD|NEXT_BUSINESS
  -- 累計枠の上限。NULL = この枠は制約として働かない
  per_collection_cap   INTEGER,                    -- 1 回あたり金額
  month_amount_cap     INTEGER,                    -- 暦月の累計金額（リセット型）
  month_count_cap      INTEGER,                    -- 暦月の回数（リセット型）
  two_month_amount_cap INTEGER,                    -- 連続 2 暦月の合計（暦月境界攻撃の防止）
  day_count_cap        INTEGER,                    -- 1 日あたりの回数（リセット型）
  lifetime_amount_cap  INTEGER,                    -- 全期間の累計金額（消尽型）
  lifetime_count_cap   INTEGER,                    -- 全期間の回数（消尽型。「12 回払い」）
  pending_amount_cap   INTEGER,                    -- 未確定枠（予告済み・未確定）
  pending_count_cap    INTEGER,
  latefee_month_cap    INTEGER,                    -- 遅延損害金の独立枠（元本と混ぜない）
  latefee_rate_max     REAL,                       -- 遅延損害金の率上限（年率）
  realtime_month_count_cap INTEGER,                -- モード別枠（即時収納は月 n 回まで）
  variance_ratio_max   REAL,                       -- 前回比の変動幅上限
  eligibility_attestation_id TEXT,                 -- 受取行が署名して主張した適格性
  state                TEXT    NOT NULL DEFAULT 'ACTIVE', -- ACTIVE|EXHAUSTED|REVOKED
  revoked_at           TEXT,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL,
  version              INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (mandate_id) REFERENCES Mandate(mandate_id)
);

CREATE INDEX idx_ddm_payer   ON DebitMandate(payer_bank_id, payer_account_alias, state);
CREATE INDEX idx_ddm_payee   ON DebitMandate(payee_bank_id, payee_account_hash, state);
CREATE INDEX idx_ddm_mandate ON DebitMandate(mandate_id);

-- 累計枠のカウンタ。契約あたり 1 行に全カウンタを集約する。
--
-- なぜ (dd_mandate_id, period_key) の複数行にしないか: 収納 1 件は暦月枠・
-- 消尽枠・未確定枠を「同時に」消費するため、窓ごとに行を分けると複数行の
-- 原子的取得が必要になり、取得順序の管理（＝デッドロック回避）を要求して
-- しまう。全カウンタを 1 行に置けば、単一行 CAS がそのまま直列化点になる
-- （transitionWithLog / H 予約 / FxTransfers.status と同じ作法）。
--
-- 窓のロールオーバーも同じ UPDATE の中で CASE 式により行う。別ジョブで
-- リセットすると、リセットと予約の競合窓が生じる。
CREATE TABLE MandateBudget (
  dd_mandate_id        TEXT    PRIMARY KEY,
  -- リセット型: 現在の窓の識別子と、その窓での消費
  month_key            TEXT    NOT NULL,           -- 'YYYY-MM'
  month_amount         INTEGER NOT NULL DEFAULT 0,
  month_count          INTEGER NOT NULL DEFAULT 0,
  prev_month_key       TEXT,                       -- 連続 2 暦月合計の算定用
  prev_month_amount    INTEGER NOT NULL DEFAULT 0,
  day_key              TEXT    NOT NULL,           -- 'YYYY-MM-DD'
  day_count            INTEGER NOT NULL DEFAULT 0,
  latefee_month_amount INTEGER NOT NULL DEFAULT 0,
  realtime_month_count INTEGER NOT NULL DEFAULT 0,
  -- 消尽型: 回復しない。使い切りをもって契約が終了する
  lifetime_amount      INTEGER NOT NULL DEFAULT 0,
  lifetime_count       INTEGER NOT NULL DEFAULT 0,
  -- 未確定枠: 予約済みで未確定の収納。確定時に解放する
  pending_amount       INTEGER NOT NULL DEFAULT 0,
  pending_count        INTEGER NOT NULL DEFAULT 0,
  last_amount          INTEGER,                    -- 前回比の変動幅判定用
  updated_at           TEXT    NOT NULL,
  version              INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (dd_mandate_id) REFERENCES DebitMandate(dd_mandate_id)
);

-- 収納予告。Transactions ではない（振替日に発火したものだけが実体化する）。
-- ラダーの各段も本表の行であり、同一 charge_ref を共有する。
CREATE TABLE ScheduledCollection (
  collection_id     TEXT    PRIMARY KEY,           -- 'COL-<uuid>'
  dd_mandate_id     TEXT    NOT NULL,
  charge_ref        TEXT    NOT NULL,              -- 請求費目（正規化済み・顧客に表示される）
  ladder_seq        INTEGER NOT NULL DEFAULT 1,    -- 段番号（1 = 基本段）
  amount_value      INTEGER NOT NULL,              -- 元本
  latefee_value     INTEGER NOT NULL DEFAULT 0,    -- 遅延損害金（元本と分離。総額に溶かさない）
  amount_currency   TEXT    NOT NULL DEFAULT 'JPY',
  due_date          TEXT    NOT NULL,              -- 振替日 'YYYY-MM-DD'
  -- 失敗が確定する時刻。24:00 をロジックに埋め込まず、モードごとの確定点を
  -- データとして持つ。SCHEDULED/SCHEDULED_LONG = 振替日の 24:00（日中に後続の
  -- センターカットがありうる）、REALTIME = Decision の時点（試行は 1 回きり）。
  -- 分けているのは「後続の試行がありうるか」であって同期／非同期ではない
  -- ——成功側の b は全モードで非同期に成立する。掃引はモード横断で
  -- `confirm_deadline_at <= now AND result IS NULL` の一様な述語で回る。
  confirm_deadline_at TEXT  NOT NULL,              -- RFC3339
  -- 変更受付の凍結時刻。REALTIME は窓を持たないため生成時刻と等しくなる
  -- （「窓が無い」を NULL ではなく「窓の幅が 0」として表現する）。
  amend_freeze_at   TEXT    NOT NULL,              -- RFC3339。以後は不利益変更を受け付けない
  mode              TEXT    NOT NULL,              -- 実効モード（降格後）
  requested_mode    TEXT    NOT NULL,              -- 受取行が要求したモード（降格の説明用）
  state             TEXT    NOT NULL DEFAULT 'SCHEDULED',
  -- SCHEDULED | AWAITING_ADDITIONAL_AUTH | FROZEN | FIRED
  -- | DECLINED_BY_PAYER | LAPSED | WITHDRAWN | SUPERSEDED
  result            TEXT,                          -- NULL(未確定) | 'CONFIRMED_OK' | 'CONFIRMED_NG'
  reason_code       TEXT,
  retriable_today   INTEGER NOT NULL DEFAULT 0,    -- 当日中の再挑戦余地（受取人の督促判断用）
  vault_ref         TEXT,                          -- 認可証明 preimage の Vault 参照
  hashlock          TEXT,                          -- 予告時点の委任状照合の証明
  extra_mandate_id  TEXT,                          -- 単発認可（追加認可）の Mandate
  edi_ref           TEXT,                          -- 請求根拠
  priority_hint     INTEGER,                       -- 顧客の優先指定（充当順序 第1項）
  budget_reserved   INTEGER NOT NULL DEFAULT 0,    -- 累計枠を予約済みか
  txid              TEXT,                          -- FIRED 後に紐づく Transactions
  notified_at       TEXT,
  frozen_at         TEXT,
  fired_at          TEXT,
  confirmed_at      TEXT,
  idempotency_key   TEXT    NOT NULL UNIQUE,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  version           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (dd_mandate_id, charge_ref, ladder_seq),
  FOREIGN KEY (dd_mandate_id) REFERENCES DebitMandate(dd_mandate_id),
  FOREIGN KEY (extra_mandate_id) REFERENCES Mandate(mandate_id)
);

-- 二重収納の防止と、ラダーの排他（OCO）を担う唯一の制約。
-- 1 費目について CONFIRMED_OK に到達できる収納は高々ひとつ。先行段が成功
-- すれば後続段は構造的に成立しえない（docs/specs/20_method_design.md §2.2.7.3-4）。
CREATE UNIQUE INDEX uq_collection_charge_ok
  ON ScheduledCollection(dd_mandate_id, charge_ref)
  WHERE result = 'CONFIRMED_OK';

CREATE INDEX idx_collection_due   ON ScheduledCollection(due_date, state);
CREATE INDEX idx_collection_ddm   ON ScheduledCollection(dd_mandate_id, charge_ref);
CREATE INDEX idx_collection_txid  ON ScheduledCollection(txid);
CREATE INDEX idx_collection_freeze ON ScheduledCollection(amend_freeze_at, state);

-- 試行の系列（追記型）。収納の現在状態はこの系列と窓の開閉から導出する。
-- 中間結果は確定ではないが、受取人にとっては行動の根拠となるため記録する。
CREATE TABLE CollectionAttempt (
  attempt_id      TEXT    PRIMARY KEY,             -- 'CATT-<uuid>'
  collection_id   TEXT    NOT NULL,
  attempt_no      INTEGER NOT NULL,
  observed_at     TEXT    NOT NULL,                -- RFC3339
  result          TEXT    NOT NULL,                -- 'OK' | 'NG'
  reason_code     TEXT,
  retriable_today INTEGER NOT NULL DEFAULT 0,
  bank_proof_ref  TEXT,
  created_at      TEXT    NOT NULL,
  UNIQUE (collection_id, attempt_no),
  FOREIGN KEY (collection_id) REFERENCES ScheduledCollection(collection_id)
);

CREATE INDEX idx_cattempt_collection ON CollectionAttempt(collection_id, attempt_no);

CREATE TABLE WatcherObservation (
  observation_id  TEXT    PRIMARY KEY,        -- 'WOBS-<uuid>'
  source          TEXT    NOT NULL,           -- rail/watcher identifier, e.g. 'ONCHAIN:ETH', 'IGS_BOJ'
  external_ref    TEXT    NOT NULL,           -- chain tx hash / IGS confirmation id / attestation id
  venue           TEXT    NOT NULL,           -- 'IGS_BOJ'|'ONCHAIN'|'ATTESTATION'
  proof_type      TEXT    NOT NULL,           -- ProofType (a/b proof phase)
  issuer_ref      TEXT    NOT NULL,           -- issuer_bank_id carried into the SettlementProofRef
  watcher_key_id  TEXT    NOT NULL,           -- KeyRegistry.key_id of the observing Watcher
  signature       TEXT    NOT NULL,           -- base64
  nonce           TEXT    NOT NULL,
  occurred_at     TEXT    NOT NULL,           -- RFC3339 (Watcher-claimed observation time)
  proof_ref       TEXT    NOT NULL,           -- JSON SettlementProofRef
  created_at      TEXT    NOT NULL
  , confirmations INTEGER
);

-- One vote per (event, Watcher key): redundant observations by the SAME Watcher
-- dedup, while DISTINCT Watchers each record a vote toward the n-of-m quorum.
CREATE UNIQUE INDEX idx_watcher_observation_source_ref_key ON WatcherObservation(source, external_ref, watcher_key_id);
CREATE INDEX idx_watcher_observation_event ON WatcherObservation(source, external_ref);
CREATE INDEX idx_watcher_observation_key ON WatcherObservation(watcher_key_id);

CREATE TABLE FinalityAnchor (
  anchor_id          TEXT    PRIMARY KEY,        -- 'ANCHOR-<uuid>'
  anchor_seq         INTEGER NOT NULL,           -- monotonic anchor sequence number
  high_watermark_seq INTEGER NOT NULL,           -- MAX(FinalityLog.event_seq) covered by this anchor
  chain_tips_json    TEXT    NOT NULL,           -- JSON array of {chain_id, tip_hash}, sorted by chain_id
  root_hash          TEXT    NOT NULL,           -- sha256 over chain_tips_json
  created_at         TEXT    NOT NULL
);

CREATE UNIQUE INDEX idx_finality_anchor_seq ON FinalityAnchor(anchor_seq);
CREATE INDEX idx_finality_anchor_watermark ON FinalityAnchor(high_watermark_seq);

CREATE TABLE FinalityCosign (
  cosign_id      TEXT    PRIMARY KEY,        -- 'COSIGN-<uuid>'
  chain_id       TEXT    NOT NULL,           -- FinalityLog chain id (txid)
  participant_id TEXT    NOT NULL,           -- bank_id of the co-signer
  entry_hash     TEXT    NOT NULL,           -- chain tip entry_hash being co-signed
  signer_key_id  TEXT    NOT NULL,           -- KeyRegistry.key_id (owner_type='PARTICIPANT', owner_ref=participant_id)
  signature      TEXT    NOT NULL,           -- base64
  nonce          TEXT    NOT NULL,
  occurred_at    TEXT    NOT NULL,           -- RFC3339 (participant-claimed)
  created_at     TEXT    NOT NULL
  , chain_kind   TEXT                        -- TX|GTID|DNS|ANCHOR (which chain kind this co-signature targets)
);

CREATE UNIQUE INDEX idx_finality_cosign_chain_participant_entry ON FinalityCosign(chain_id, participant_id, entry_hash);
CREATE INDEX idx_finality_cosign_participant ON FinalityCosign(participant_id);

-- Per chain-kind co-signing requirement (mandatory-cosign policy).
CREATE TABLE CosignPolicy (
  chain_kind     TEXT PRIMARY KEY,            -- TX|GTID|DNS
  min_cosigners  INTEGER NOT NULL DEFAULT 1,
  is_mandatory   INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL
);

CREATE TABLE SystemMode (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  mode         TEXT NOT NULL DEFAULT 'NORMAL',  -- NORMAL | BCP_READONLY
  reason       TEXT,
  activated_at TEXT,
  updated_at   TEXT NOT NULL
);

-- Access Audit Log (docs/specs/10_requirements.md §3.3.2.2.1.1-1). Every read of
-- party-scoped data records who read what, under which purpose code, and how it
-- was decided. Denials are recorded too: "who was refused" is the signal that
-- distinguishes a misconfigured client from a probe. INSERT ONLY.
CREATE TABLE AccessAuditLog (
  access_id    TEXT PRIMARY KEY,
  occurred_at  TEXT NOT NULL,                    -- RFC3339
  subject_type TEXT NOT NULL,                    -- AccessSubjectType: OPERATOR|PARTICIPANT|UNIDENTIFIED
  subject_id   TEXT,                             -- bank_id for PARTICIPANT; NULL otherwise
  purpose_code TEXT,                             -- P01..P07, or NULL when absent (a denial)
  resource     TEXT NOT NULL,                    -- e.g. 'transactions/TX-1' — the object read
  decision     TEXT NOT NULL,                    -- AccessDecision: PERMIT|DENY
  reason_code  TEXT,                             -- denial reason; NULL on PERMIT
  export_ref   TEXT                              -- set when the read produced an export artefact
);
CREATE INDEX idx_access_audit_time    ON AccessAuditLog(occurred_at);
CREATE INDEX idx_access_audit_subject ON AccessAuditLog(subject_type, subject_id, occurred_at);

CREATE TABLE ParticipantCurrencyLimits (
  bank_id  TEXT    NOT NULL,
  currency TEXT    NOT NULL,
  h_limit  INTEGER NOT NULL DEFAULT 0,
  h_used   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bank_id, currency)
);

-- Cross-currency FX marketplace (docs/specs/30_internal_design.md). Directional FX quotes posted by
-- FXPs. A pair's bid/ask is expressed as the two directional rows (X→Y and
-- Y→X); a spread means rate(X→Y)·rate(Y→X) < 1e16. Rate is integer fixed-point
-- (units of to_currency per 1 from_currency, × RATE_SCALE = 1e8).
CREATE TABLE FxQuotes (
  quote_id      TEXT PRIMARY KEY,             -- 'FXQ-<uuid>'
  fxp_bank_id   TEXT NOT NULL,                -- FXP (a participant bank)
  from_currency TEXT NOT NULL,                -- ISO 4217 (sell side input)
  to_currency   TEXT NOT NULL,                -- ISO 4217 (buy side output)
  rate          INTEGER NOT NULL,             -- units of to_currency per 1 from_currency, × RATE_SCALE (1e8)
  min_amount    INTEGER NOT NULL DEFAULT 0,   -- min tradable amount in from_currency
  max_amount    INTEGER,                      -- max tradable amount in from_currency (NULL = unbounded)
  valid_from    TEXT NOT NULL,                -- RFC3339
  valid_to      TEXT NOT NULL,                -- RFC3339 quote expiry
  status        TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | WITHDRAWN
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 0
);

-- Routing engine reads ACTIVE quotes for a pair; index the lookup path.
CREATE INDEX idx_fxq_pair ON FxQuotes(from_currency, to_currency, status);
-- Per-FXP quote management (upsert / withdraw all of a bank's quotes).
CREATE INDEX idx_fxq_fxp ON FxQuotes(fxp_bank_id, status);

-- FX-specific facts for a single cross-currency transfer (FXP-conduit GTID):
-- the route taken, the locked quote(s), the effective rate, and the shared
-- hashlock that binds the legs for cross-rail atomicity. Keyed 1:1 by gtid.
CREATE TABLE FxTransfers (
  gtid           TEXT    PRIMARY KEY,            -- the conduit GTID
  from_currency  TEXT    NOT NULL,
  to_currency    TEXT    NOT NULL,
  amount_from    INTEGER NOT NULL,               -- source paid by payer
  amount_to      INTEGER NOT NULL,               -- target received by payee
  effective_rate INTEGER NOT NULL,               -- composed rate(from→to) × RATE_SCALE
  hashlock       TEXT    NOT NULL,               -- SHA-256 hex; shared HTLC hashlock
  route_json     TEXT    NOT NULL,               -- serialized FxRoute (hops, quotes, amounts)
  quote_ids      TEXT    NOT NULL,               -- comma-joined quote ids on the route
  status         TEXT    NOT NULL DEFAULT 'INITIATED', -- INITIATED|LOCKED|SETTLING|SETTLED|REFUNDED (see docs/specs/20_method_design.md 17.4.5)
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

-- Cross-rail atomicity binding layer (30_internal_design.md §13 P2). Each row is one currency
-- segment (edge) of the conduit: funds move from_* → to_* in `currency` under a
-- single shared hashlock with staggered timelocks (upstream later). All legs
-- CLAIMED on secret reveal (settle), else REFUNDED past timelock (no settlement).
CREATE TABLE FxLegLocks (
  gtid              TEXT    NOT NULL,            -- FK to FxTransfers(gtid)
  leg_index         INTEGER NOT NULL,            -- 0 = payer→fxp0 … last = fxp→payee
  currency          TEXT    NOT NULL,
  amount            INTEGER NOT NULL,
  from_bank_id      TEXT    NOT NULL,
  from_account_hash TEXT    NOT NULL,
  to_bank_id        TEXT    NOT NULL,
  to_account_hash   TEXT    NOT NULL,
  hashlock          TEXT    NOT NULL,            -- shared across all legs of the gtid
  timelock          TEXT    NOT NULL,            -- RFC3339; staggered (upstream later)
  state             TEXT    NOT NULL DEFAULT 'LOCKED', -- LOCKED|CLAIMED|REFUNDED
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  version           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (gtid, leg_index),
  FOREIGN KEY (gtid) REFERENCES FxTransfers(gtid)
);

-- Sweep LOCKED legs past their timelock for refund.
CREATE INDEX idx_fxleglocks_state ON FxLegLocks(state, timelock);

-- ============================================================================
-- Legacy adapter (対外接続系) — lets ZC front a legacy core-banking system that
-- is not 24/365, not idempotent, and cannot hold a reservation, without
-- requiring any of that from the core itself. See docs/specs/10_requirements.md.
-- Idempotency reuses the existing IdempotencyKeys table (no separate table).
-- ============================================================================

-- Per-participant capability profile. ZC branches on this so heterogeneous
-- cores are configuration, not special-casing.
CREATE TABLE LegacyProfiles (
  bank_id             TEXT PRIMARY KEY,
  role                TEXT    NOT NULL DEFAULT 'FULL',      -- FULL | PAYEE_ONLY | PAYER_ONLY
  reservation_mode    TEXT    NOT NULL DEFAULT 'SUSPENSE',  -- SUSPENSE | NONE
  settlement_mode     TEXT    NOT NULL DEFAULT 'DIRECT',    -- DIRECT | PREFUNDED_SHADOW
  notify_mode         TEXT    NOT NULL DEFAULT 'PUSH',      -- PUSH | PULL
  sync_reserve        INTEGER NOT NULL DEFAULT 1,           -- can the core hold/return a reservation synchronously
  realtime_name_check INTEGER NOT NULL DEFAULT 1,           -- can the core answer name-check in real time
  batch_ingest        INTEGER NOT NULL DEFAULT 0,           -- prefers file/bulk ingest over N synchronous calls
  window_open_hour    INTEGER,                              -- JST hour the core comes online (NULL = always online)
  window_close_hour   INTEGER,                              -- JST hour the core goes offline for batch
  created_at          TEXT    NOT NULL
);

-- The adversarial core's authoritative ledger. Deliberately minimal: a single
-- balance per account (not double-entry) and an append log, matching the
-- reduced posting surface (DEBIT/CREDIT only, no hold) a hostile legacy core
-- exposes to the adapter. customer_name backs name-check(7)/account-verify(8)
-- (docs/specs/10_requirements.md §1) — account holder name is core MASTER
-- DATA every vendor core has, not an API capability being asked of them, so
-- it does not reintroduce the table-access anti-pattern fixed for postDebit.
CREATE TABLE LegacyCoreAccounts (
  bank_id       TEXT    NOT NULL,
  account_id    TEXT    NOT NULL,
  balance       INTEGER NOT NULL DEFAULT 0,
  customer_name TEXT,
  PRIMARY KEY (bank_id, account_id)
);

-- Every posting the core actually applied. txid carries the originating ZC
-- transaction for audit traceability (request_id alone is an adapter-internal
-- correlation id, not a first-class ledger reference).
CREATE TABLE LegacyCoreJournal (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id    TEXT    NOT NULL,
  account_id TEXT    NOT NULL,
  amount     INTEGER NOT NULL,   -- signed: DEBIT negative, CREDIT positive
  op         TEXT    NOT NULL,   -- DEBIT | CREDIT
  txid       TEXT,
  request_id TEXT,
  applied_at TEXT    NOT NULL
);

-- Adapter shadow / available-funds mirror. The adapter authorises against
-- this WITHOUT touching the core, so ZC gets a real-time answer even while
-- the core is inside its batch window. `reserved` absorbs the reservation
-- the core itself cannot hold.
CREATE TABLE AdapterShadow (
  bank_id    TEXT    NOT NULL,
  account_id TEXT    NOT NULL,
  available  INTEGER NOT NULL DEFAULT 0,
  reserved   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bank_id, account_id)
);

-- Store-and-forward outbox. Postings authorised against the shadow but not
-- yet applied to a core that was offline / windowed. Drained when the core
-- comes back online.
--
-- status lifecycle: PENDING -> CLAIMED -> APPLIED (happy path), or
-- CLAIMED -> PENDING (drain aborted after claiming: offline/timeout before
-- the core posting committed — safe to retry), or PENDING/CLAIMED -> BLOCKED
-- (the core rejected the posting, e.g. insufficient funds discovered at
-- drain time; a Cases row is opened and the row awaits manual resolution
-- rather than being retried silently forever).
CREATE TABLE AdapterOutbox (
  outbox_id  TEXT    PRIMARY KEY,
  bank_id    TEXT    NOT NULL,
  account_id TEXT    NOT NULL,
  op         TEXT    NOT NULL,                   -- DEBIT | CREDIT
  amount     INTEGER NOT NULL,                   -- unsigned magnitude
  txid       TEXT,
  request_id TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'PENDING', -- PENDING | CLAIMED | APPLIED | BLOCKED
  attempts   INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT,
  created_at TEXT    NOT NULL,
  applied_at TEXT
);
CREATE INDEX idx_outbox_pending ON AdapterOutbox (bank_id, status);
-- Stale-claim recovery (drain crashed between claim and apply): swept by
-- cron/timeout_sweep.ts alongside the orphaned-IdempotencyKeys sweep.
CREATE INDEX idx_outbox_claimed ON AdapterOutbox (status, claimed_at);

-- Pull-based notifications. The core has no push endpoint, so credit
-- notifications AND rtp-notify(10) requests are stored here for the bank to
-- pull — both are pure notifications requiring nothing from the core.
-- account_id is nullable: an rtp-notify(10) precedes any actual transaction
-- and is not yet scoped to a specific payer account (txid holds the rtp_id
-- in that case, since no txid exists yet either).
CREATE TABLE AdapterNotifications (
  notify_id  TEXT    PRIMARY KEY,
  bank_id    TEXT    NOT NULL,
  txid       TEXT    NOT NULL,
  account_id TEXT,
  amount     INTEGER NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'UNREAD', -- UNREAD | READ
  created_at TEXT    NOT NULL,
  read_at    TEXT
);
CREATE INDEX idx_notify_unread ON AdapterNotifications (bank_id, status);

-- Reconciliation drift. A three-way mismatch (core vs shadow vs outbox
-- backlog) is recorded here AND opens a real Cases row (case_id) — the
-- adapter's application of ZC's rule that an unexplained state must converge
-- into a CASE, not a table nobody watches.
CREATE TABLE AdapterReconDrift (
  drift_id        TEXT    PRIMARY KEY,
  bank_id         TEXT    NOT NULL,
  account_id      TEXT    NOT NULL,
  core_balance    INTEGER NOT NULL,
  shadow_expected INTEGER NOT NULL,
  drift_amount    INTEGER NOT NULL,
  case_id         TEXT,
  status          TEXT    NOT NULL DEFAULT 'OPEN', -- OPEN | RESOLVED
  detected_at     TEXT    NOT NULL
);

-- ============================================================================
-- Seed data (system participants, system accounts, prefund journals,
-- interest rates, finality sequence counter, system mode).
-- ============================================================================

INSERT OR IGNORE INTO "Participants" ("bank_id", "bank_name", "ingress_base_url", "h_limit", "h_used", "is_active", "registered_at", "participation_mode", "tx_amount_limit", "daily_amount_limit", "daily_amount_used", "daily_amount_last_reset_date", "hv_threshold", "operating_window_start", "operating_window_end", "participant_type") VALUES
  ('001', 'みずほ銀行', '/bank/001', 100000000, 0, 1, '2025-01-01T00:00:00Z', 'FULL', NULL, NULL, 0, NULL, NULL, NULL, NULL, 'BANK'),
  ('002', '三菱UFJ銀行', '/bank/002', 100000000, 0, 1, '2025-01-01T00:00:00Z', 'FULL', NULL, NULL, 0, NULL, NULL, NULL, NULL, 'BANK');

INSERT OR IGNORE INTO "BankAccounts" ("account_id", "bank_id", "customer_id", "customer_name", "account_type", "status", "freeze_reason", "opened_at", "closed_at") VALUES
  ('0010000000', '001', 'SYSTEM', '別段預金', 'SUSPENSE', 'NORMAL', NULL, '2025-01-01T00:00:00Z', NULL),
  ('001-ZCS', '001', 'SYSTEM', 'ZC清算勘定', 'SETTLEMENT', 'NORMAL', NULL, '2025-01-01T00:00:00Z', NULL),
  ('001-CASH', '001', 'SYSTEM', '現金', 'ASSET', 'NORMAL', NULL, '2025-01-01T00:00:00Z', NULL),
  ('001-BOJ', '001', 'BOJ', '日本銀行（預け金勘定）', 'BOJ', 'NORMAL', NULL, '2025-01-01T00:00:00Z', NULL),
  ('0010000001', '001', 'C001', '田中 太郎', 'SAVINGS', 'NORMAL', NULL, '2025-01-01T00:00:00Z', NULL),
  ('0010000002', '001', 'C002', '佐藤 花子', 'SAVINGS', 'NORMAL', NULL, '2025-01-01T00:00:00Z', NULL),
  ('0020000000', '002', 'SYSTEM', '別段預金', 'SUSPENSE', 'NORMAL', NULL, '2025-01-01T00:00:00Z', NULL),
  ('002-ZCS', '002', 'SYSTEM', 'ZC清算勘定', 'SETTLEMENT', 'NORMAL', NULL, '2025-01-01T00:00:00Z', NULL),
  ('002-CASH', '002', 'SYSTEM', '現金', 'ASSET', 'NORMAL', NULL, '2025-01-01T00:00:00Z', NULL),
  ('002-BOJ', '002', 'BOJ', '日本銀行（預け金勘定）', 'BOJ', 'NORMAL', NULL, '2025-01-01T00:00:00Z', NULL),
  ('0020000001', '002', 'C003', '鈴木 一郎', 'SAVINGS', 'NORMAL', NULL, '2025-01-01T00:00:00Z', NULL),
  ('0020000002', '002', 'C004', '山田 美咲', 'SAVINGS', 'NORMAL', NULL, '2025-01-01T00:00:00Z', NULL),
  ('001-RE', '001', 'INTERNAL', '利益剰余金', 'ASSET', 'NORMAL', NULL, '2025-01-01T00:00:00Z', NULL),
  ('002-RE', '002', 'INTERNAL', '利益剰余金', 'ASSET', 'NORMAL', NULL, '2025-01-01T00:00:00Z', NULL);

INSERT OR IGNORE INTO "BankJournals" ("journal_id", "bank_id", "account_id", "amount", "tx_type", "txid", "tx_group_id", "description", "value_date", "created_at") VALUES
  ('JNL-INIT-001-1', '001', '0010000001', 1000000, 'CASH', NULL, 'INIT-001', '初期残高', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-INIT-001-1X', '001', '001-ZCS', -1000000, 'CASH', NULL, 'INIT-001', '初期ZC清算残高 offset', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-INIT-001-2', '001', '0010000002', 1000000, 'CASH', NULL, 'INIT-001', '初期残高', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-INIT-001-2X', '001', '001-ZCS', -1000000, 'CASH', NULL, 'INIT-001', '初期ZC清算残高 offset', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-INIT-002-1', '002', '0020000001', 1000000, 'CASH', NULL, 'INIT-002', '初期残高', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-INIT-002-1X', '002', '002-ZCS', -1000000, 'CASH', NULL, 'INIT-002', '初期ZC清算残高 offset', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-INIT-002-2', '002', '0020000002', 1000000, 'CASH', NULL, 'INIT-002', '初期残高', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-INIT-002-2X', '002', '002-ZCS', -1000000, 'CASH', NULL, 'INIT-002', '初期ZC清算残高 offset', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-BOJ-INIT-001-ZCS', '001', '001-ZCS', 10000000, 'CASH', NULL, 'BOJ-INIT-001', 'RTGS プレファンド積立 ZCS(+)', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-BOJ-INIT-001-BOJ', '001', '001-BOJ', -10000000, 'CASH', NULL, 'BOJ-INIT-001', 'RTGS プレファンド積立 BOJ(-)', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-BOJ-INIT-002-ZCS', '002', '002-ZCS', 10000000, 'CASH', NULL, 'BOJ-INIT-002', 'RTGS プレファンド積立 ZCS(+)', '2025-01-01', '2025-01-01T00:00:00Z'),
  ('JNL-BOJ-INIT-002-BOJ', '002', '002-BOJ', -10000000, 'CASH', NULL, 'BOJ-INIT-002', 'RTGS プレファンド積立 BOJ(-)', '2025-01-01', '2025-01-01T00:00:00Z');

INSERT OR IGNORE INTO "InterestRates" ("rate_id", "bank_id", "account_type", "annual_rate", "effective_from", "effective_to") VALUES
  ('RATE-001-SAVINGS', '001', 'SAVINGS', 0.001, '2025-01-01', NULL),
  ('RATE-002-SAVINGS', '002', 'SAVINGS', 0.001, '2025-01-01', NULL);

INSERT OR IGNORE INTO "FinalitySeq" ("id", "next_seq") VALUES
  (1, 0);

INSERT OR IGNORE INTO "SystemMode" ("id", "mode", "reason", "activated_at", "updated_at") VALUES
  (1, 'NORMAL', NULL, NULL, '1970-01-01T00:00:00.000Z');
