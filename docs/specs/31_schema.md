# DBスキーマ定義（正）

`migrations/` のSQLと完全に一致させること。矛盾がある場合は `migrations/0001_consolidated_schema.sql`（SQL）を正とし、本ファイルを追随修正する。

マイグレーション構成:
- `0001_consolidated_schema.sql` — **統合スキーマ（唯一の正）。** かつては
  旧 `0001`〜`0042` の連番マイグレーション（ZC基本テーブル / Bank基本テーブル /
  トレーサビリティ・着金フィルタ・HTLC Auth / 新決済機能 / RTP / BOJプレファンド /
  DNS / Circuit Breaker / Reversal / FinalityLog ハッシュチェーン /
  EntityStateLog / KeyRegistry / Attestation / Mandate / クロスチェーンHTLC /
  マルチ通貨 / 稼働ウィンドウ / 給付行政 / DNS リングフェンス 等）が存在し、
  後続でさらに `0002`〜`0006`（`BankJournals` の通貨次元化 / `DnsCycles` の
  決済チェーン / クロスカレンシー FX マーケットプレイス）も切られていた。
  本ファイルは、それら増分の `ALTER` / `DROP` / `RENAME` 履歴をすべて畳み込み、
  **最終形の 1 ファイル**へ統合したものである。全テーブルを確定形で定義し、
  索引と初期シードデータ（システム参加者・システム勘定・プレファンド仕訳・
  金利・FinalitySeq・SystemMode）を含む。
  統合に含まれる主な最終形:
  - `BankJournals.amount_currency`（ISO 4217、DEFAULT 'JPY'）+ 索引
    `idx_jnl_account_ccy`。元帳金額の通貨次元化（共有の透明・別段勘定をまたぐ
    単位混在の防止）。
  - `DnsCycles.settlement_chain`。非JPYサイクルが確定するトークン化中銀当座
    （CBT）のチェーンを固定（NULL=JPYクラシックBOJ-Net）。通貨→中央銀行の
    レジストリは `src/shared/central_bank.ts`。
  - `Participants.is_fx_provider` + `FxQuotes` 表（索引 `idx_fxq_pair` /
    `idx_fxq_fxp`）。FXプロバイダ(FXP)が提示する方向別レート。レートは整数
    固定小数（`RATE_SCALE=1e8`）。クロスカレンシー FX（`docs/specs/30_internal_design.md`）の第1段。
  - `FxTransfers` 表。FX送金1件の事実（採用経路・ロックした見積・実効レート・
    脚を束ねる共有ハッシュロック）を gtid 単位で保持。FX送金は FXP導管型 GTID
    （payer→FXP→payee の通貨別脚）として既存 GTID レーンで原子決済される
    （`src/zc/fx/transfer.ts`）。
  - `FxLegLocks` 表（索引 `idx_fxleglocks_state`）。クロスレール原子性
    （`30_internal_design.md`（FX内部設計・実装状況））の束ねレイヤ。共有ハッシュロック＋段階的タイムロックで
    各通貨脚をロックし、secret 公開（claim）で全脚を一括 CLAIMED にして初めて
    GTID を登録・決済、未公開ならタイムロック満了で全脚 REFUNDED（無決済）。
    実装は `src/zc/fx/htlc.ts`。

> **過去の連番マイグレーションについて**: かつて存在した `0002`〜`0042` の
> 個別ファイル（および本番デプロイ後に判明した不具合のパッチ群）、ならびに
> 後続で切られた `0002`〜`0006` の各ファイルは、本統合にあたって削除済み。
> 新規 DB はこの 1 ファイルを適用すれば完全なスキーマが得られる。
> **スキーマの正は本ファイル (`31_schema.md`) と
> `migrations/0001_consolidated_schema.sql`** であり、齟齬が出たら SQL 側を信じる。

---

## マイグレーション運用

### 鉄則
1. **統合スキーマ (`0001_consolidated_schema.sql`) を直接編集する。**
   本リポジトリはスキーマを単一の統合ファイルで保持する参照実装であり、
   スキーマ変更は新しい連番ファイルを切らず、この 1 ファイルを唯一の正と
   して直接書き換える。`31_schema.md`（本ファイル）も必ず同じ変更で更新し、
   両者を一致させる。
   - 列の追加・変更は対象 `CREATE TABLE` の定義に**直接列を足す**（別の
     後置 `ALTER` を積まない）。確定形の 1 ファイルを保つ。
   - 本番運用上の注意: D1 の `wrangler d1 migrations apply` は適用済み
     ファイルの再適用を行わないため、すでにデプロイ済みの実 DB に同手法を
     適用する場合は別途の前進的マイグレーション（または再構築）が要る。
     本参照実装は「新規 DB にこの 1 ファイルを適用して完全形を得る」前提。
2. **`test/helpers/d1-mock.ts` の `SCHEMA_MIGRATIONS` は
   `0001_consolidated_schema.sql` 単体を保つ。** テスト/ローカルは統合
   スキーマを毎回新規適用するため、スキーマ変更は同ファイルへの編集だけで
   反映される（配列に新ファイルを足さない）。
3. **インデックスは追加したら `31_schema.md` の索引カタログにも必ず記載する。**
   未記載は `test/invariants/schema_doc_drift.test.ts` が検出する。

---

## ZC基本テーブル

### Participants（参加主体）
```sql
CREATE TABLE Participants (
  bank_id          TEXT    PRIMARY KEY,             -- '001', '002', ...
  bank_name        TEXT    NOT NULL,
  ingress_base_url TEXT    NOT NULL,                -- '/bank/001'
  h_limit          INTEGER NOT NULL DEFAULT 0,      -- H上限（円）
  h_used           INTEGER NOT NULL DEFAULT 0,      -- H消費中（円）
  is_active        INTEGER NOT NULL DEFAULT 1,
  registered_at    TEXT    NOT NULL,                -- RFC3339
  participation_mode TEXT  NOT NULL DEFAULT 'FULL', -- FULL|RECEIVE_ONLY|SEND_ONLY
  tx_amount_limit  INTEGER,                         -- 1件あたり上限（円）
  daily_amount_limit INTEGER,                       -- 日次上限（円）
  daily_amount_used INTEGER NOT NULL DEFAULT 0,     -- 日次累計（EODリセット）
  -- 日次上限のリセット日付（クロン未実行時の自動リセット判定用）
  daily_amount_last_reset_date TEXT,                -- 'YYYY-MM-DD'
  -- HIGH_VALUE 自動エスカレーション閾値（制度パラメータ PR-HV-THRESHOLD、30_internal_design.md §12.9）
  -- NULL = 環境変数 ZC_HV_THRESHOLD（既定 1 億円）にフォールバック
  hv_threshold     INTEGER,
  -- 参加行の稼働ウィンドウ（'HH:MM' JST＝システム時刻）
  -- NULL/NULL = 常時オープン
  -- start < end: 同日内ウィンドウ / start > end: 日付をまたぐウィンドウ
  -- start === end: 24時間オープン扱い
  operating_window_start TEXT,
  operating_window_end   TEXT,
  -- 給付発起参加者の類型化
  participant_type TEXT NOT NULL DEFAULT 'BANK',  -- 'BANK'|'GOVERNMENT'
  -- FXプロバイダ(FXP)フラグ。is_fx_provider=1 かつ 2通貨以上の
  -- ParticipantCurrencyLimits 行を持つ参加行は、その通貨ペアの方向別 FxQuotes を提示できる。
  is_fx_provider   INTEGER NOT NULL DEFAULT 0
);
```

> **`h_used` / `daily_amount_used` の設計意図**: これらは一見すると
> `SUM(HReservations WHERE is_released=0)` や当日 `Transactions` の合計から
> 導出できる冗長カラムに見えるが、**意図的に保持している実体化カウンタ**で
> ある。`UPDATE Participants SET h_used = h_used + ? WHERE (h_used + ?)
> <= h_limit` のような単文 UPDATE は、上限チェックと加算を 1 命令で済ませる
> ことで同時実行下でも race-free に上限を強制できる。SUM して比較してから
> INSERT する形に置き換えると、SUM と INSERT の間に TOCTOU 窓が開いて
> 上限超過の二重予約が発生し得る。本リポジトリは「事実は追記、状態カラムは
> 更新しない」を原則とするが、性能/同時実行のための materialization は
> 例外として明示的に容認する（参照: `src/zc/liquidity/h_model.ts#reserveH`、
> `src/zc/ingress/transfers.ts` の `daily_amount_used` 加算）。整合性は `is_released=0`
> な `HReservations` の合計との reconciliation で随時検証できる。

### Transactions（取引）
```sql
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
  updated_at            TEXT    NOT NULL,
  external_settlement_status TEXT DEFAULT 'NONE',  -- NONE|REQUESTED|SETTLED|FAILED|HOLD
  verification_id       TEXT,                      -- FK → AccountVerifications
  edi_ref               TEXT,                      -- FK → EdiRecords
  fatf_data_json        TEXT,                      -- FATF R16データ JSON
  is_cross_border       INTEGER NOT NULL DEFAULT 0,
  fatf16_applicable     INTEGER NOT NULL DEFAULT 0,
  mandate_id            TEXT,                      -- FK → Mandate（任意）
  -- 相手行の稼働ウィンドウ待ちで
  -- PRECHECKED_SUSPENDED + reason_code='COUNTERPARTY_WINDOW_CLOSED' に
  -- 一時停止した際の元PaymentInitiatedRequestのスナップショット（JSON）。
  -- タイムアウトスイープがウィンドウ再オープン後にこれを復元してEXPRESSを再開する。
  pending_request_json  TEXT,
  -- 単一所有者則: この行を「いま動かせる」唯一の主体。
  -- 'ZC' | 'CYCLE:<cycle_id>' | 'VENUE:<venue_id>' | 'CHAIN:<watcher_set>'
  owner                 TEXT    NOT NULL DEFAULT 'ZC',
  -- timeout sweep が計測する「待ちの開始時刻」。書き込むのはレーン共通
  -- プリミティブ（insertTxWithLog / transitionWithLog）と Authority Check の
  -- 留置印（_authority_check.ts）だけである。
  --
  -- なぜ updated_at ではないか: updated_at はこの行への**あらゆる**書込みで動く。
  -- 進捗と無関係な書込み——CASE 起票時の case_id（src/zc/cases/case.ts）、
  -- 送金内容データ連携時の edi_ref（src/zc/richdata/edi.ts）——にも状態ガードが
  -- 無いため、滞留した取引に CASE を起票するという運用者の当然の動作が、
  -- その取引自身の期限を後ろへずらしていた。繰り返せば無限にずれる。
  -- 有界時間内の検出（docs/disclosure/CORE_DISCLOSURE.md【0013】(a)・【0124】4）が
  -- 成立しない。タイマを最も必要とする行ほど、待っている間に別の理由で
  -- 触られる機会が多いからである。
  --
  -- NULL は本列の導入前に書かれた行のみ。sweep は
  -- COALESCE(pending_since, updated_at) を読むので、それらも従来どおり期限切れする。
  pending_since         TEXT
);
CREATE INDEX idx_tx_state ON Transactions(state);
CREATE INDEX idx_tx_owner ON Transactions(owner, state);
CREATE INDEX idx_tx_payer ON Transactions(payer_bank_id, state);
CREATE INDEX idx_tx_payee ON Transactions(payee_bank_id, state);
CREATE INDEX idx_tx_dns   ON Transactions(dns_cycle_id);
CREATE INDEX idx_transactions_mandate_id ON Transactions(mandate_id);
```

> **`lane` の値域（規範）**: 本列は **8 値**（`EXPRESS｜STANDARD｜BULK｜DEFERRED｜RTP｜HTLC｜HIGH_VALUE｜GTID`）。
> このうち **`GTID` は API リクエスト値ではない** ——`POST /api/transfers` が受け付ける 7 値
> （`32_api_contracts.md § POST /api/transfers`、実装 `src/types/states.ts#LaneType`）に加え、
> GT-level Decision 確定後にレッグを実体化する際 `src/zc/lanes/gtid/advance.ts` が内部生成する。
> 列の値域は `src/types/states.ts#TxLane`。
> **`HTLC_AUTH` は本列の値ではない**：受取側起点オーソリは `lane='HTLC'` ＋ FinalityLog payload の
> `flow='HTLC_AUTH'` として表現し、詳細は `HtlcAuthRequests` に持つ
> （用語の切り分けは `10_requirements.md` 序章「レーンと `lane` 列の関係」を正とする）。

> **`owner`（単一所有者則）**: どの瞬間も各取引を動かす権利はちょうど一人が持つ
> （単一所有者則の詳細は `30_internal_design.md#single-owner`）。所有権の移転は
> `transferOwnership` / `transitionWithLog` の `setColumns`
> （`src/zc/lanes/_helpers.ts`）に一本化され、FinalityLog に
> `OwnershipTransferred` / `OwnershipReclaimed` として記録される。
> タイムアウトスイープは `owner='ZC'` の行だけを対象とする
> （`dns_cycle_id` / `external_settlement_status` による除外述語の列挙を置換）。

### HReservations（H予約）
```sql
CREATE TABLE HReservations (
  reservation_id TEXT    PRIMARY KEY,
  txid           TEXT    NOT NULL,
  bank_id        TEXT    NOT NULL,
  amount         INTEGER NOT NULL,
  mode           TEXT    NOT NULL DEFAULT 'RESERVED', -- RESERVED|LOCKED
  is_released    INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL,
  released_at    TEXT,
  -- このリザベーションが消費するH容量の通貨。
  -- 'JPY' は Participants.h_limit/h_used、それ以外は ParticipantCurrencyLimits を消費する。
  currency       TEXT    NOT NULL DEFAULT 'JPY'
);
CREATE INDEX idx_hres_bank ON HReservations(bank_id, is_released);
```

### ParticipantCurrencyLimits（非JPYのH上限/使用量）
```sql
-- 通貨を H-Model の次元に昇格。JPY は引き続き Participants.h_limit/h_used を
-- 使用し、非JPY通貨はこのテーブルの (bank_id, currency) 単位の行で
-- 上限・使用量を管理する。既存JPY専用フローへの影響・データ移行は無し。
CREATE TABLE ParticipantCurrencyLimits (
  bank_id  TEXT    NOT NULL,
  currency TEXT    NOT NULL,
  h_limit  INTEGER NOT NULL DEFAULT 0,
  h_used   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bank_id, currency)
);
```

### FinalityLog（不変ログ・INSERT ONLY、改ざん耐性ハッシュチェーン）
```sql
CREATE TABLE FinalityLog (
  log_id       TEXT    PRIMARY KEY,                -- UUID
  txid         TEXT,
  gtid         TEXT,
  event_type   TEXT    NOT NULL,                   -- 監査イベント名。値域は src/types/api/messaging.ts#FinalityEventType（I/F語彙との関係は 30_internal_design.md §12.1.6）
  state_from   TEXT,
  state_to     TEXT    NOT NULL,
  payload_json TEXT    NOT NULL,                   -- イベント全体（JSON）
  event_seq    INTEGER NOT NULL,                   -- FinalitySeq から単調割当
  occurred_at  TEXT    NOT NULL,
  -- SHA-256 ハッシュチェーン
  prev_hash    TEXT,                               -- 同 chain の直前 entry_hash（先頭は 'GENESIS'）
  entry_hash   TEXT                                -- SHA-256(prev|log_id|txid|gtid|event_type|state_from|state_to|payload_json|event_seq|occurred_at)
);
CREATE INDEX idx_fl_txid ON FinalityLog(txid);
CREATE INDEX idx_fl_gtid ON FinalityLog(gtid);
CREATE INDEX idx_fl_seq  ON FinalityLog(event_seq);
CREATE INDEX idx_fl_chain_seq  ON FinalityLog(txid, event_seq);
CREATE INDEX idx_fl_gchain_seq ON FinalityLog(gtid, event_seq);
-- TX チェーンの prev_hash 部分 UNIQUE（並列ワーカーによる分岐防止）
CREATE UNIQUE INDEX idx_fl_chain_prev_hash
  ON FinalityLog(txid, prev_hash) WHERE txid IS NOT NULL;
-- event_seq 全体 UNIQUE（FinalitySeq の belt-and-braces）
CREATE UNIQUE INDEX idx_fl_event_seq_unique ON FinalityLog(event_seq);
-- GTID 専用チェーンの prev_hash 部分 UNIQUE
CREATE UNIQUE INDEX idx_fl_gtid_chain_prev_hash
  ON FinalityLog(gtid, prev_hash) WHERE gtid IS NOT NULL AND txid IS NULL;
```

#### ハッシュチェーンの規範
- **chain_id**: `COALESCE(txid, gtid, 'GLOBAL')` で識別される。TX と GTID
  は独立したチェーンに記録され、`'GLOBAL'` はシステム全体イベント用。
- **prev_hash の決定**: 同一 chain の直前エントリの `entry_hash`。新規
  チェーン先頭は `'GENESIS'`。
- **entry_hash の決定**: 上記 SQL コメント記載の通り、フィールドを `|`
  連結した文字列を SHA-256。フィールド順は契約。
- **検証**: `verifyChain(db, chain_id)` がチェーン全体を再計算し、
  `LEGACY_UNCHAINED_ENTRY` / `PREV_HASH_MISMATCH` / `ENTRY_HASH_MISMATCH`
  のいずれかを break_reason として返す。`GET /api/transactions/:txid/verify`
  および `GET /api/gtid/:gtid/verify` 経由で公開。
- **書込み原子性**: `transitionWithLog` は CAS UPDATE と FinalityLog
  INSERT を 1 つの `db.batch()` で発行し、`changes() > 0` でガードする。
  CAS に勝った呼び出しのみがログを書く。

### FinalitySeq（FinalityLog 単調 event_seq 採番）
```sql
CREATE TABLE FinalitySeq (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  next_seq  INTEGER NOT NULL
);
-- 初期化（migration 内で実行）。統合スキーマを適用する新規DBでは FinalityLog が
-- 空のため、next_seq はリテラル 0 をシードする（統合スキーマの確定形）。
INSERT OR IGNORE INTO FinalitySeq (id, next_seq)
VALUES (1, 0);
```
`writeFinalityLog` は `UPDATE FinalitySeq SET next_seq = next_seq + 1
WHERE id = 1 RETURNING next_seq` で event_seq をアトミック割当する。

> **補足（シード値について）**: 既存ログを持つ実 DB へ後追いで適用する場合は
> `COALESCE((SELECT MAX(event_seq) FROM FinalityLog), 0)` で現在値から再開させるのが
> 安全だが、統合スキーマは「新規 DB にこの 1 ファイルを適用して完全形を得る」前提であり
> `FinalityLog` が空なので、`(1, 0)` のリテラル値をシードする。

### EntityStateLog（非Transaction エンティティの状態遷移履歴・INSERT ONLY）
マネーパス（`Transactions` / `HtlcContracts` / `GtidTransactions` / `GtidLegs`）
の状態遷移は `transitionWithLog` が `FinalityLog` に、DNS サイクルは
`'DNS-'` チェーンにそれぞれ追記する。一方で運用系エンティティ
（`Cases.state` / `PsprRegistry.capability_state` / `BankAccounts.status` /
`ReversalRecords.status`）は status 列を上書きするだけで遷移履歴が失われて
いた。`EntityStateLog` は status 列を**現在状態の射影**として残しつつ、変更
ごとに不変の事実（`state_from → state_to`）を 1 行追記する。**UPDATE/DELETE
は一切しない。**

```sql
CREATE TABLE EntityStateLog (
  log_id       TEXT    PRIMARY KEY,           -- 'ESL-<uuid>'
  entity_type  TEXT    NOT NULL,              -- 'CASE'|'PSPR'|'BANK_ACCOUNT'|'REVERSAL'|'MANDATE'|'DEBIT_MANDATE'|'COLLECTION'
  entity_id    TEXT    NOT NULL,              -- エンティティ主キー値
  event_type   TEXT    NOT NULL,              -- ドメインイベント名（'CaseOpened' 等）
  state_from   TEXT,                          -- 直前状態（生成時 NULL）
  state_to     TEXT    NOT NULL,              -- 新状態
  reason_code  TEXT,                          -- 変更理由（任意）
  actor        TEXT,                          -- 'ZC'|'OPS'|'BANK_{bankId}'|'SYSTEM'
  payload_json TEXT,                          -- 追加コンテキスト JSON（任意）
  occurred_at  TEXT    NOT NULL               -- RFC3339
);
CREATE INDEX idx_esl_entity   ON EntityStateLog(entity_type, entity_id, occurred_at);
CREATE INDEX idx_esl_occurred ON EntityStateLog(occurred_at);
```

**書込み規範**: `src/shared/entity_state_log.ts#transitionEntityWithLog` が
status 変更 UPDATE と `EntityStateLog` INSERT を 1 つの `db.batch()` で発行する。
INSERT は直前 UPDATE の `changes() > 0` をガードに用いる条件付き形式のため、
no-op（同一状態への再適用など）ではログを書かない。`FinalityLog` の
`buildFinalityLogConditionalInsert` と同型。同一 `occurred_at` のタイ解決は
INSERT 順（rowid 昇順）で行う。

### DnsCycles（DNSサイクル）

`business_date` には `UNIQUE` 制約を貼らない（late-arriving cycle が同一
business_dateで複数サイクルを持てるよう、suffix付き`cycle_id`で区別する）。

`currency` / `intraday_seq` 列は、通貨別・日内複数回サイクルを一意化する
正規識別子形式 `DNS-{CCY}-YYYYMMDD-NN`（`src/zc/settlement/dns_cycle_id.ts`）の
識別情報を保持する列である。この2列は `cycle_id`
文字列（`DNS-${business_date}` / late-cycle の `DNS-${business_date}-${HHMMSS}`）
とは独立して管理される。単一日次 JPY サイクルは `currency='JPY'`,
`intraday_seq=1`（正規形 `DNS-JPY-YYYYMMDD-01` 相当）として記録される
（`src/zc/settlement/dns_cycle_id.ts` の `legacyDnsCycleIdentity()`）。late-cycle には
その business_date 内での作成順に基づく連番（2, 3, ...）が割り当てられる。

```sql
CREATE TABLE DnsCycles (
  cycle_id      TEXT PRIMARY KEY,
  business_date TEXT NOT NULL,                     -- 'YYYY-MM-DD'（UNIQUEではない。複数サイクル/日を許容）
  state         TEXT NOT NULL DEFAULT 'OPEN',      -- DnsState: OPEN|KICKED|SETTLED|HOLD_ACTIVE
  igs_mode      TEXT NOT NULL DEFAULT 'NORMAL',    -- IgsMode: NORMAL|STOP|RINGFENCED|RINGFENCED_PLUS
  kicked_at     TEXT,
  settled_at    TEXT,
  hold_reason   TEXT,                             -- JSON: {reason, shortfalls}（`shortfalls` は閉域情報。`20_method_design.md` §9.4.4）
  net_positions TEXT,                              -- JSON: {bank_id: net_amount}
  updated_at    TEXT,                              -- holdDnsが参照
  currency      TEXT NOT NULL DEFAULT 'JPY',       -- 正規識別子のCCY（`20_method_design.md` §9.4.2）
  intraday_seq  INTEGER NOT NULL DEFAULT 1,        -- 正規識別子のNN（`20_method_design.md` §9.4.2）
  created_at    TEXT NOT NULL,
  hold_causing_participants TEXT,                  -- JSON配列: HOLD時にショートフォールの原因となった参加行集合（`20_method_design.md` §2.4 類型B のリングフェンス、settleDnsがRINGFENCED昇格時に記録、settle成功でNULLクリア）
  -- RINGFENCED_PLUS 昇格証跡（`20_method_design.md` §2.4 類型B・§10.9.3.1）。ZCが算式で
  -- リアルタイム算定する復旧リザーブと、その再現可能性のための入力/算式/出力
  -- ダイジェスト（reserve_explain_hash）・信頼度（reserve_confidence）。
  -- promoteRingfencePlus が RINGFENCED→RINGFENCED_PLUS 昇格時に記録する。
  dns_recovery_reserve INTEGER,                    -- 算定リザーブ
  reserve_explain_hash TEXT,                       -- 入力+算式+出力のSHA-256
  reserve_confidence   REAL,                       -- 信頼度 0..1（閾値以上で昇格）
  settlement_chain     TEXT,                        -- 決済レール/チェーン。NULL=JPYクラシックBOJ-Net（{bank}-BOJ）。非JPYは 'ETH'|'POLYGON'|… を固定し、トークン化中銀当座 {bank}-CBT-{CCY}-{CHAIN} で確定
  -- HOLD 中の公式発表テンプレID（`DNS_HOLD_{business_date}`）。HOLD_ACTIVE 以外は NULL。
  -- ZC の公式ステータスと、参加行が顧客へ表示してよい定型文を機械的に突合するための
  -- 唯一のキー（`10_requirements.md` §3.3.1-3/-4、`20_method_design.md` §9.4.4.2）。
  public_message_id    TEXT
);
CREATE INDEX idx_dns_business_date ON DnsCycles(business_date);  -- 非UNIQUE
```

> **中銀決済レール（settlement_chain）**: ファイナリティは*その通貨の*中央銀行で
> 確定する。BOJ は JPY のみを扱い、EUR は ECB、USD は FedNY… となる。ZC は日本の
> コーディネータで外国中銀の RTGS に直接接続できないため、非JPYは**トークン化中銀
> 当座預金（CBT）**をチェーン上で確定させる：cycle が `settlement_chain` を固定し、
> 決済は `{bank}-CBT-{CCY}-{CHAIN}` 勘定（発行中銀）へ向かう。確定の証跡は発行体署名
> を `KeyRegistry` で検証した `venue='CB_TOKEN'` の `SettlementProofRef`（ONCHAIN /
> ATTESTATION と同じ信頼モデル）。JPY のクラシック BOJ 当座（`{bank}-BOJ`）は不変で、
> トークン化JPY（`{bank}-CBT-JPY-{CHAIN}`）は**追加レール**。
> 詳細は `src/shared/central_bank.ts`。

### IgsDeferQueue（IGS Deferキュー — DNS HOLD中の優先度付き再投入）

DNS HOLD（`igs_mode`）中にブロックされた IGS（HIGH_VALUE）を、単純な
suspend→sweep ではなく**優先度＋実行予定ウィンドウ付きで再投入**するキュー
（`20_method_design.md` §2.4 類型B・§10.9.3.1「拒否ではなく Defer を原則とし、
`scheduled_execution_window` を付与する」）。txid 単位で一意（`idx_igs_defer_txid`）。
timeout sweep が `status='DEFERRED'` かつ実行ウィンドウ到来分を `priority` 昇順で
再投入する。

```sql
CREATE TABLE IgsDeferQueue (
  defer_id                   TEXT PRIMARY KEY,
  txid                       TEXT NOT NULL,
  cycle_id                   TEXT NOT NULL,
  payer_bank_id              TEXT NOT NULL,
  payee_bank_id              TEXT NOT NULL,
  amount_value               INTEGER NOT NULL,
  reason_code                TEXT NOT NULL,        -- DNS_IGS_THROTTLED|DNS_RINGFENCED|DNS_HOLD_IGS_STOPPED
  priority                   INTEGER NOT NULL DEFAULT 100,  -- 小さいほど優先
  scheduled_execution_window TEXT NOT NULL,        -- ISO: この時刻以降で再投入可
  status                     TEXT NOT NULL DEFAULT 'DEFERRED', -- DEFERRED|RESUMED|CANCELLED
  enqueued_at                TEXT NOT NULL,
  resumed_at                 TEXT
);
CREATE INDEX idx_igs_defer_status ON IgsDeferQueue(status, priority, scheduled_execution_window);
CREATE UNIQUE INDEX idx_igs_defer_txid ON IgsDeferQueue(txid);
```

### IgsThrottleState（IGS公平性スロットル消費）

RINGFENCED_PLUS 中に各参加行が消費した IGS admission 予算
（`igs_throttle_budget` 公平性制御。`20_method_design.md` §2.4 類型B）。予算超過分は reject ではなく Defer
され、希少な復旧期流動性を一行が独占しないようにする。

```sql
CREATE TABLE IgsThrottleState (
  cycle_id        TEXT NOT NULL,
  bank_id         TEXT NOT NULL,
  admitted_amount INTEGER NOT NULL DEFAULT 0,
  admitted_count  INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (cycle_id, bank_id)
);
```

### LsmRuns（Bulk LSM最適化の採択証跡）

Bulk/Deferred の LSM（流動性節約）最適化の各ウィンドウ実行を記録する監査表
（`30_internal_design.md` §14.2 / §14.3）。入力スナップショット・制約ダイジェスト・採択集合ハッシュ・
追跡ダイジェスト・目的関数の達成度（およびフォールバック時の劣化）を残し、
「なぜこの集合が採択されたか」を後から説明可能にする。

```sql
CREATE TABLE LsmRuns (
  run_id             TEXT PRIMARY KEY,
  business_date      TEXT NOT NULL,
  window_id          TEXT NOT NULL,
  mode               TEXT NOT NULL,          -- OPTIMIZED|FIFO|PRIORITY|THROTTLE
  is_fallback        INTEGER NOT NULL DEFAULT 0,
  input_snapshot_id  TEXT NOT NULL,          -- 候補集合ダイジェスト（F.2）
  constraints_digest TEXT NOT NULL,          -- H残高/期限/優先度/停止条件（F.2）
  execution_set_hash TEXT NOT NULL,          -- 採択tx集合（F.2）
  trace_digest       TEXT NOT NULL,          -- 再現可能な根拠（F.2）
  candidate_count    INTEGER NOT NULL DEFAULT 0,
  selected_count     INTEGER NOT NULL DEFAULT 0,
  deferred_count     INTEGER NOT NULL DEFAULT 0,
  objective_metrics  TEXT NOT NULL,          -- 辞書式目的の達成度+劣化（F.1/F.3）
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_lsm_runs_date ON LsmRuns(business_date, created_at);
```

### DnsNetPositions（DNS清算明細）
```sql
CREATE TABLE DnsNetPositions (
  id            TEXT    PRIMARY KEY,
  cycle_id      TEXT    NOT NULL,
  bank_id       TEXT    NOT NULL,
  gross_send    INTEGER NOT NULL DEFAULT 0,
  gross_receive INTEGER NOT NULL DEFAULT 0,
  net_position  INTEGER NOT NULL DEFAULT 0,        -- 正=受取超、負=支払超
  is_settled    INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (cycle_id) REFERENCES DnsCycles(cycle_id)
);
```

### HtlcContracts（HTLC取引）
```sql
CREATE TABLE HtlcContracts (
  htlc_id                    TEXT    PRIMARY KEY,
  txid                       TEXT    NOT NULL UNIQUE,
  state                      TEXT    NOT NULL,     -- HtlcState
  hashlock                   TEXT    NOT NULL,     -- SHA256ハッシュ（hex）
  timelock                   TEXT    NOT NULL,     -- RFC3339（期限。ZC側の外側タイムロック）
  amount_value               INTEGER NOT NULL,
  payer_bank_id              TEXT    NOT NULL,
  payee_bank_id              TEXT    NOT NULL,
  secret_verified            INTEGER NOT NULL DEFAULT 0, -- 1=検証済み
  authority_recheck_required INTEGER NOT NULL DEFAULT 0,
  version                    INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT    NOT NULL,
  updated_at                 TEXT    NOT NULL,
  -- クロスチェーンHTLC関連列
  cross_chain_source         TEXT,   -- NULL=通常のHTLC。非NULLの場合、同じhashlockが
                                      -- この`source`下のオンチェーンエスクローもロックする
  onchain_timelock           TEXT,   -- RFC3339（オンチェーン側の内側タイムロック。
                                      -- 必ず`timelock`より厳密に前）
  onchain_lock_ref           TEXT,   -- CrossChainLocked観測のexternal_ref
  onchain_lock_proof_json    TEXT,   -- CrossChainLocked観測のSettlementProofRef（JSON）
  onchain_release_proof_json TEXT,   -- OnchainProofObserved観測のSettlementProofRef（JSON）
  -- 条件テンプレート参照（プログラマビリティの汎用化）
  condition_template_id     TEXT,   -- FK → ConditionTemplate（任意）。設定時は
                                      -- claimHtlcByAttestationによるアテステーション
                                      -- 経由の成立（PASS）でも、既存のpreimage経由でも
                                      -- fulfillできる
  onchain_min_confirmations  INTEGER NOT NULL DEFAULT 0, -- オンチェーン解放を確定とみなす最小承認数（確認深度ゲート）
  onchain_min_watchers       INTEGER NOT NULL DEFAULT 1, -- 決済に必要な相異なる Watcher 運用主体の数（n-of-m クォーラム。1=従来の単一Watcher）
  -- AND/OR 条件合成（プログラマビリティの汎用化）
  condition_expr_json   TEXT,   -- {template_id} | {op:AND|OR, operands:[...]} の式木。claimHtlcByConditions で評価
  -- クロスチェーン確定種別 + 量子リスク証跡
  onchain_chain_class    TEXT,  -- PUBLIC|PRIVATE|PERMISSIONED
  onchain_crypto_suite   TEXT,  -- 例: secp256k1|ed25519|dilithium3
  onchain_quantum_risk   TEXT,  -- VULNERABLE|RESISTANT|UNKNOWN（suite から導出可）
  onchain_finality_class TEXT,  -- PROBABILISTIC|DETERMINISTIC（chain_class から導出）
  FOREIGN KEY (txid) REFERENCES Transactions(txid)
);
```

### GtidTransactions（GTID取引）

> **`legs_ready_count` / `legs_settled_count` の位置付け**: GT の合流判定
> （`checkAndFinalizeGtid`）は実 leg/tx state を JOIN して評価しており、
> これらのカラムを参照していない。ダッシュボード表示用の denormalize 値で
> あり、`GT_DECIDED_TO_SETTLE` / `GT_SETTLED` 遷移時に snapshot 書込みされる
> ため終端状態では正確だが、原理的には drift し得る。単一 GTID 詳細 API
> （`handleGetGtid`）は実 leg 状態から導出した値で上書きして返す。新規の
> GT 合流ロジックは**実 leg state を参照**し、これらのカウンタに依存しない
> こと（参照: `src/zc/orchestrator/gtid.ts#checkAndFinalizeGtid`）。
```sql
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
  updated_at         TEXT    NOT NULL,
  mandate_id         TEXT                          -- FK → Mandate（任意）
);
```

### GtidLegs（GTIDの脚）
```sql
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
  updated_at     TEXT    NOT NULL,
  -- 脚ごとの通貨。PvP（多通貨同時決済）は
  -- 「異通貨2レッグの GTID」として、このカラムを参照して脚をグルーピングする。
  leg_currency   TEXT    NOT NULL DEFAULT 'JPY',
  -- 受付時の正規化（`20_method_design.md` §2.2.5.1）が leg_id を書き換えた場合の、
  -- 参加者が登録した元の leg_id。NULL = 登録どおりの脚。
  origin_leg_id  TEXT,
  FOREIGN KEY (gtid) REFERENCES GtidTransactions(gtid),
  FOREIGN KEY (txid) REFERENCES Transactions(txid)
);
CREATE INDEX idx_legs_gtid ON GtidLegs(gtid);
CREATE INDEX idx_legs_txid ON GtidLegs(txid);  -- orchestrator.ts の txid 検索（onPayeeExecConfirmed/suspendTx）のフルスキャン対策
```

### FxQuotes（FXプロバイダの方向別レート）
クロスカレンシー FX（`docs/specs/30_internal_design.md`）のレート市場。FXP（`is_fx_provider=1` の
参加銀行）が `from_currency→to_currency` の方向別レートを提示する。レートは
整数固定小数（`rate` = 1 単位 from に対する to の数量 × `RATE_SCALE`=1e8）。
ペアの bid/ask は「X→Y」「Y→X」の2行で表現し、スプレッドは
`rate(X→Y)·rate(Y→X) < 1e16`。ルーティング(`src/zc/fx/routing.ts`)が ACTIVE な
見積を読み、最良実効レート/経路を選ぶ。
```sql
CREATE TABLE FxQuotes (
  quote_id      TEXT    PRIMARY KEY,             -- 'FXQ-<uuid>'
  fxp_bank_id   TEXT    NOT NULL,                -- FXP（参加銀行）
  from_currency TEXT    NOT NULL,                -- ISO 4217（売り＝入力）
  to_currency   TEXT    NOT NULL,                -- ISO 4217（買い＝出力）
  rate          INTEGER NOT NULL,                -- to/from × RATE_SCALE(1e8)
  min_amount    INTEGER NOT NULL DEFAULT 0,      -- from 通貨建ての取引下限
  max_amount    INTEGER,                         -- from 通貨建ての取引上限（NULL=無制限）
  valid_from    TEXT    NOT NULL,                -- RFC3339
  valid_to      TEXT    NOT NULL,                -- RFC3339 見積有効期限
  status        TEXT    NOT NULL DEFAULT 'ACTIVE', -- ACTIVE|WITHDRAWN
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  version       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_fxq_pair ON FxQuotes(from_currency, to_currency, status);  -- ルーティングのペア検索
CREATE INDEX idx_fxq_fxp  ON FxQuotes(fxp_bank_id, status);                 -- FXP単位の upsert/取下げ
```

### FxTransfers（FX送金レコード）
クロスカレンシー FX 送金1件を表す（`docs/specs/30_internal_design.md`）。FX送金は FXP を導管とする
通貨別脚の GTID（payer→FXP は source 通貨、FXP→payee は target 通貨。ブリッジ時は
中間通貨の脚が増える）として既存 GTID レーンで原子決済される。本表は GtidTransactions
が持たない FX 固有の事実（採用経路・ロック見積・実効レート・脚を束ねる共有ハッシュ
ロック）を gtid 単位で保持する。
```sql
CREATE TABLE FxTransfers (
  gtid           TEXT    PRIMARY KEY,            -- 導管 GTID
  from_currency  TEXT    NOT NULL,
  to_currency    TEXT    NOT NULL,
  amount_from    INTEGER NOT NULL,               -- payer 支払額（source）
  amount_to      INTEGER NOT NULL,               -- payee 受取額（target）
  effective_rate INTEGER NOT NULL,               -- 合成 rate(from→to) × RATE_SCALE
  hashlock       TEXT    NOT NULL,               -- SHA-256 hex（共有HTLCハッシュロック）
  route_json     TEXT    NOT NULL,               -- FxRoute（hops/quotes/amounts）
  quote_ids      TEXT    NOT NULL,               -- 経路上の quote_id（カンマ連結）
  status         TEXT    NOT NULL DEFAULT 'INITIATED', -- INITIATED|LOCKED|SETTLING|SETTLED|REFUNDED（`20_method_design.md` §17.4.5）
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
```

### FxLegLocks（FX脚のHTLCロック）
クロスカレンシー FX のクロスレール原子性（`docs/specs/30_internal_design.md` §17.4）。各通貨脚
（導管のエッジ）を**共有ハッシュロック＋段階的タイムロック**（上流ほど後に満了）で
ロックする。settle は claim（secret 公開）まで遅延し、claim で全脚を CLAIMED に
カスケードして初めて導管 GTID を登録・前進させる（全か無か）。未 claim なら
タイムロック満了で全脚 REFUNDED（資金移動なし）。決済の正は GTID 側。実装 `src/zc/fx/htlc.ts`。
```sql
CREATE TABLE FxLegLocks (
  gtid              TEXT    NOT NULL,            -- FxTransfers(gtid)
  leg_index         INTEGER NOT NULL,            -- 0=payer→fxp0 … 末尾=fxp→payee
  currency          TEXT    NOT NULL,
  amount            INTEGER NOT NULL,
  from_bank_id      TEXT    NOT NULL,
  from_account_hash TEXT    NOT NULL,
  to_bank_id        TEXT    NOT NULL,
  to_account_hash   TEXT    NOT NULL,
  hashlock          TEXT    NOT NULL,            -- gtid内の全脚で共有
  timelock          TEXT    NOT NULL,            -- RFC3339（段階的：上流ほど後）
  state             TEXT    NOT NULL DEFAULT 'LOCKED', -- LOCKED|CLAIMED|REFUNDED
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL,
  version           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (gtid, leg_index),
  FOREIGN KEY (gtid) REFERENCES FxTransfers(gtid)
);
CREATE INDEX idx_fxleglocks_state ON FxLegLocks(state, timelock);  -- 期限切れLOCKEDの払戻スイープ
```

### Cases（例外処理チケット）
```sql
CREATE TABLE Cases (
  case_id      TEXT PRIMARY KEY,
  related_txid TEXT,
  related_gtid TEXT,
  state        TEXT NOT NULL DEFAULT 'OPEN',       -- CaseState: OPEN|IN_PROGRESS|RESOLVED|ESCALATED
  reason_code  TEXT NOT NULL,
  description  TEXT,
  opened_by    TEXT NOT NULL,                      -- 'ZC'|'BANK'|'OPS'
  sla_deadline TEXT,                               -- 期限。超過で ESCALATED へ昇格（`20_method_design.md` §10.7.4）
  evidence_refs TEXT,                              -- JSON array（証跡参照 ID の配列。`20_method_design.md` §10.10.2）
  cause_key    TEXT,                               -- 集約キー 'CAUSE:{cause_party_id|detection_path}:{reason_code}'（`20_method_design.md` §10.7.2）
  cause_party_id TEXT,                             -- 原因主体識別子。検出時点で未特定なら NULL
  detection_path TEXT,                             -- 原因主体が未特定のとき集約キーに用いる検出経路識別子
  occurrence_count INTEGER NOT NULL DEFAULT 1,     -- 束ねた取引の件数（集約のたびに増分）
  last_occurred_at TEXT,                           -- 最終発生時刻（集約のたびに更新）
  escalated_at TEXT,                               -- ESCALATED へ遷移した時刻。二次エスカレーション判定の基準
  last_notified_at TEXT,                           -- 直近の二次通知時刻。同じ状況での再通知を抑止
  resolved_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_case_txid  ON Cases(related_txid);
CREATE INDEX idx_case_sla   ON Cases(state, sla_deadline);
CREATE INDEX idx_case_cause ON Cases(cause_key, state);
```

> **`cause_key` が NULL の CASE は集約しない**：原因主体も検出経路も与えられない起票は、
> 単独の CASE として立つ。`CAUSE::{reason_code}` を鍵にすると、原因の判らない CASE が
> 理由コードだけで束ねられ、「1 原因 1 件」ではなく「1 単語 1 件」になるためである。

> **`occurrence_count` は取引の数であって検出の数ではない**：増分は
> `CaseRelatedTransactions` への行挿入が成功した場合に限る（同一 txid の再検出では
> 動かない）。これにより `20_method_design.md` §10.7.2.2 の件数閾値が、再送量ではなく
> 被害の広がりを表す。

### CaseRelatedTransactions（集約 CASE に束ねた取引・INSERT ONLY）

集約された CASE の内訳。件数は `Cases.occurrence_count` が保持し、本表はどの取引が
束ねられたかを保持する（`20_method_design.md` §10.7.2「txid は関連付けで管理」）。

```sql
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
```

> `(case_id, link_key)` の主キーが二重計上を構造的に防ぐ。挿入は `INSERT OR IGNORE`
> であり、件数の増分と `EntityStateLog` への追記はいずれもこの挿入が行を追加した場合
> （`changes() > 0`）に限って実行される。同一 1 バッチであるから、「束ねたのに件数が
> 動いていない」「件数だけ動いて内訳がない」のいずれも生じない。

> **`sla_deadline` は必ず入る**：`openCase` は呼び出し側が指定しない場合、既定値
> （`CASE_SLA_SEC`）から期限を計算して必ず埋める。**期限の無い CASE は
> Auto-Progress → Manual-Only の昇格判定（`20_method_design.md` §10.7.4）の対象から
> 落ちてしまい、「待ち続けたまま誰にも気づかれない」状態になる**ため、NULL 許容の列では
> あるが実運用では空にしない。

### AccessAuditLog（アクセス監査台帳・INSERT ONLY）

当事者スコープの照会について「誰が・何を・どの目的コードで読み、どう判定されたか」を残す
（`10_requirements.md` §3.3.2.2.1.1-1）。**拒否も記録する**——誰が断られたかは、設定ミスの
クライアントと探索行為を分ける唯一の手掛かりであり、`10_requirements.md` §3.3.2.2.1.1-3 の
事後監査はこの列が無ければ成立しない。認可の機構は `src/zc/platform/access.ts`、対象経路の一覧は
`src/zc/platform/access_routes.ts`（規範は `32_api_contracts.md § 照会の認可`）。

```sql
CREATE TABLE AccessAuditLog (
  access_id    TEXT PRIMARY KEY,
  occurred_at  TEXT NOT NULL,                    -- RFC3339
  subject_type TEXT NOT NULL,                    -- AccessSubjectType: OPERATOR|PARTICIPANT|UNIDENTIFIED
  subject_id   TEXT,                             -- PARTICIPANT のとき bank_id、他は NULL
  purpose_code TEXT,                             -- P01..P07。欠落時は NULL（＝拒否の記録）
  resource     TEXT NOT NULL,                    -- 'transactions/TX-1' 等、読まれた対象
  decision     TEXT NOT NULL,                    -- AccessDecision: PERMIT|DENY
  reason_code  TEXT,                             -- 拒否理由。PERMIT では NULL
  export_ref   TEXT                              -- エクスポートを伴う読み取りの持出参照
);
CREATE INDEX idx_access_audit_time    ON AccessAuditLog(occurred_at);
CREATE INDEX idx_access_audit_subject ON AccessAuditLog(subject_type, subject_id, occurred_at);
```

> **書込み失敗で照会を落とさない（規範）**：`recordAccess` は例外を投げない。監査台帳の
> 書込み失敗を理由に正当な照会を失敗させると、**台帳が全照会の可用性依存になる**——
> `10_requirements.md` §8.2.1 の A-2（照会系は Decision 系より高い可用性）と正面から衝突する。
> 失敗はサーバログに残し、照会は続行する。

### Vault（短期秘匿ストア）
```sql
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
```

### PsprRegistry（PSPR登録）
```sql
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
```

### RtpRequests（RTP請求）

状態は `state` 列に一本化されている。payer 側受信一覧も本テーブルを直接参照する
（専用の通知ストレージは持たない）。

```sql
CREATE TABLE RtpRequests (
  rtp_id        TEXT    PRIMARY KEY,
  payee_bank_id TEXT    NOT NULL,
  payer_bank_id TEXT    NOT NULL,
  amount_value  INTEGER NOT NULL,
  -- 唯一の状態列。CREATED|NOTIFIED|ACCEPTED|TX_CREATED|COMPLETED|DECLINED|EXPIRED|FAILED
  state         TEXT    NOT NULL DEFAULT 'CREATED',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  linked_txid   TEXT,
  expires_at    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  payee_name         TEXT,
  description        TEXT,
  edi_ref            TEXT,
  notified_at        TEXT,
  linked_txid_new    TEXT,
  payer_account_id   TEXT,
  response_type      TEXT,
  responded_at       TEXT,
  payee_account_hash TEXT
);
```

### IdempotencyKeys（冪等キー管理：ZC側）
```sql
CREATE TABLE IdempotencyKeys (
  key           TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'PROCESSING', -- PROCESSING|DONE
  response_body TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT,
  request_hash  TEXT  -- sha256hex(JSON body)。本文比較に対応しない呼び出し元（リプレイ防止nonceキー等）は NULL
);
```

timeout sweep（毎分）が2種類の掃除を行う:
- **PROCESSING 孤児**（作成から15分超）: 取得元リクエストが completeIdempotency 前に
  死んだキー。放置するとクライアントの再送が永遠に `{result:'PROCESSING'}` を受け取る
  ため削除する。同一キーでの再実行は `Transactions.idempotency_key UNIQUE` が二重TXを防ぐ。
- **DONE キー**（作成から24h超）: 応答リプレイキャッシュの TTL 失効。

`request_hash` が非NULLで、再送ボディのハッシュと不一致の場合は
`409 IDEMPOTENCY_KEY_CONFLICT`（保存済み応答は返さない）。詳細は
[`docs/specs/32_api_contracts.md` § 冪等性（横断仕様）](./32_api_contracts.md#冪等性横断仕様)。

---

## ZC テーブル（トレーサビリティ・着金フィルタ・HTLC Auth）

### TxEventLog（ZC側 詳細処理イベントログ：INSERT ONLY）
FinalityLogが状態遷移イベントを記録するのに対し、TxEventLogはZC↔Bank間の呼び出し結果・フィルタ評価・処理時間を記録する。

```sql
CREATE TABLE TxEventLog (
  log_id        TEXT    PRIMARY KEY,             -- UUID
  txid          TEXT,                            -- 関連取引ID（NULL可）
  correlation_id TEXT,                           -- ZC→Bank 横断追跡ID
  actor         TEXT    NOT NULL,                -- 'ZC'|'BANK_{bankId}'|'CUSTOMER'|'SYSTEM'
  action        TEXT    NOT NULL,                -- アクション名
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
```

**action 定数一覧:**
- ZC側: `PAYMENT_INITIATED`, `PRE_CHECK`, `H_RESERVE`, `H_LOCK`, `H_RELEASE`, `DECIDE_SETTLE`, `DECIDE_CANCEL`, `PAYER_EXEC_CONFIRMED`, `PAYEE_EXEC_CONFIRMED`, `SETTLED`, `SUSPENDED`, `CANCELLED`
- Bank呼出: `RESERVE_FUNDS`, `EXECUTE_DEBIT`, `EXECUTE_CREDIT`, `RELEASE_RESERVE`, `AUTHORITY_CHECK`, `NAME_CHECK`, `LEG_READY_CHECK`
- Filter: `FILTER_EVALUATED`, `FILTER_REJECTED`, `FILTER_PENDING`
- HTLC Auth: `HTLC_AUTH_REQUESTED`, `HTLC_AUTH_APPROVED`, `HTLC_AUTH_DECLINED`, `HTLC_CAPTURE`, `HTLC_VOID`

### HtlcAuthWhitelist（HTLC受取側起点ロック ホワイトリスト）
```sql
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
  expires_at            TEXT,                    -- NULL=無期限
  -- 対象者該当性アテステーション
  -- 設定時、createAuthRequest() は当該テンプレートに対する署名付き PASS
  -- アテステーション（HtlcAuthRequestInput.eligibility_attestation）を要求する
  eligibility_template_id TEXT                   -- FK → ConditionTemplate. NULL=要件なし
);
CREATE INDEX idx_whitelist_payee ON HtlcAuthWhitelist(payee_bank_id, payee_account_hash, is_active);
```

### HtlcAuthRequests（HTLC受取側起点オーソリリクエスト）
カードのオーソリ（authorize → capture/void）に相当。受取側（加盟店）が起点となり、送金側（顧客）の承認を得てHTLCロックを確立する。

```sql
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
  payee_bank_id        TEXT    NOT NULL,
  payee_account_hash   TEXT    NOT NULL,
  payer_bank_id        TEXT    NOT NULL,
  payer_account_hash   TEXT    NOT NULL,
  amount_value         INTEGER NOT NULL,
  purpose              TEXT,
  description          TEXT,                     -- 商品・サービス説明
  auth_expires_at      TEXT    NOT NULL,         -- 送金側が承認する期限
  capture_expires_at   TEXT    NOT NULL,         -- 受取側がキャプチャする期限
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
  updated_at           TEXT    NOT NULL,
  -- whitelist.eligibility_template_id が設定されている場合に
  -- createAuthRequest() が記録する検証済みアテステーションのID
  eligibility_attestation_id TEXT,  -- FK → Attestation. NULL=要件なし/未検証
  FOREIGN KEY (whitelist_id) REFERENCES HtlcAuthWhitelist(whitelist_id)
);
CREATE INDEX idx_authreq_payer  ON HtlcAuthRequests(payer_bank_id, status);
CREATE INDEX idx_authreq_payee  ON HtlcAuthRequests(payee_bank_id, payee_account_hash, status);
CREATE INDEX idx_authreq_htlc   ON HtlcAuthRequests(htlc_id);
```

---

## ZC テーブル（清算・決済機能）

### IgsRequests（IGS連携 — 日銀ネット即時グロス清算）
```sql
CREATE TABLE IgsRequests (
  ext_instruction_id  TEXT PRIMARY KEY,
  txid                TEXT NOT NULL,
  payer_bank_id       TEXT NOT NULL,
  payee_bank_id       TEXT NOT NULL,
  amount_value        INTEGER NOT NULL,
  amount_currency     TEXT NOT NULL DEFAULT 'JPY',
  status              TEXT NOT NULL DEFAULT 'REQUESTED', -- REQUESTED|SETTLED|FAILED|HOLD|TIMEOUT
  boj_settle_ref      TEXT,
  requested_at        TEXT NOT NULL,
  settled_at          TEXT,
  failed_reason       TEXT,
  retry_count         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_igs_txid   ON IgsRequests(txid);
CREATE INDEX idx_igs_status ON IgsRequests(status);
```

### AccountVerifications（事前口座確認）
```sql
CREATE TABLE AccountVerifications (
  verification_id     TEXT PRIMARY KEY,
  request_bank_id     TEXT NOT NULL,
  target_bank_id      TEXT NOT NULL,
  target_account_hash TEXT NOT NULL,
  target_account_name TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING', -- PENDING|MATCHED|UNMATCHED|NOT_FOUND|ERROR|EXPIRED
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
```

### CreditNotifications（入金結果通知）
```sql
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
```

### EdiRecords（ZEDI統合 — 全銀EDIリッチデータ）
```sql
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
  line_items_json     TEXT,                        -- JSON配列
  created_by_bank_id  TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_edi_txid    ON EdiRecords(txid);
CREATE INDEX idx_edi_invoice ON EdiRecords(invoice_number);
```

### ProxyDirectory（エイリアス送金）
```sql
CREATE TABLE ProxyDirectory (
  proxy_id            TEXT PRIMARY KEY,
  proxy_type          TEXT NOT NULL,               -- PHONE|EMAIL|NATIONAL_ID
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
```

### QrCodes（QRコード送金）
```sql
CREATE TABLE QrCodes (
  qr_ref              TEXT PRIMARY KEY,
  qr_type             TEXT NOT NULL,               -- STATIC|DYNAMIC
  payee_bank_id       TEXT NOT NULL,
  payee_account_id    TEXT NOT NULL,
  payee_name          TEXT NOT NULL,
  amount_value        INTEGER,                     -- NULL=任意額（Static QR）
  amount_currency     TEXT NOT NULL DEFAULT 'JPY',
  purpose             TEXT,
  edi_ref             TEXT,
  signature           TEXT NOT NULL,               -- HMAC署名
  is_used             INTEGER NOT NULL DEFAULT 0,   -- DYNAMIC は単一使用（消費はCAS）
  expires_at          TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_qr_payee ON QrCodes(payee_bank_id);
```

> **規範（DYNAMIC QR の単一使用）**：DYNAMIC QR の消費は `UPDATE QrCodes SET
> is_used = 1 WHERE qr_ref = ? AND is_used = 0` の **CAS** で行い、`changes() == 0`
> の敗者は `QR_ALREADY_USED` で拒否する。読取り時の `is_used` チェックだけでは、
> 読取り（ガード）と書込み（消費）が別文のため同一 QR への並行決済が双方ともガードを
> 通過し（TOCTOU）二重使用が成立しうる。単一使用を担保するのは行述語 `is_used = 0`
> である（実装 `src/zc/directory/qr.ts#processQrPayment`、回帰 `test/zc/qr.test.ts`）。

### RichDataStore（リッチデータストレージ）
```sql
CREATE TABLE RichDataStore (
  data_ref            TEXT PRIMARY KEY,
  data_type           TEXT NOT NULL,               -- RichDataType: EDI|INVOICE|ATTACHMENT_META|REMITTANCE
  txid                TEXT,
  content_json        TEXT NOT NULL,
  content_hash        TEXT NOT NULL,
  r2_key              TEXT,                        -- R2バケットキー（大容量データ用）
  created_by_bank_id  TEXT NOT NULL,
  retention_days      INTEGER NOT NULL DEFAULT 2555, -- 約7年
  created_at          TEXT NOT NULL,
  expires_at          TEXT
);
CREATE INDEX idx_rds_txid ON RichDataStore(txid);
CREATE INDEX idx_rds_type ON RichDataStore(data_type);
```

### CrossBorderTransactions（クロスボーダー送金）
```sql
CREATE TABLE CrossBorderTransactions (
  cb_txid             TEXT PRIMARY KEY,
  domestic_txid       TEXT,                        -- FK → Transactions
  direction           TEXT NOT NULL,               -- OUTBOUND|INBOUND
  foreign_fps_id      TEXT NOT NULL,               -- 外国FPS識別子
  foreign_bank_bic    TEXT NOT NULL,               -- 相手行BIC
  foreign_account_id  TEXT NOT NULL,
  foreign_currency    TEXT NOT NULL,
  foreign_amount      INTEGER NOT NULL,
  exchange_rate       REAL,
  domestic_amount     INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'INITIATED', -- INITIATED|ROUTED|FOREIGN_ACCEPTED|SETTLED|FAILED|RETURNED
  settlement_bank_id  TEXT,
  nostro_account_ref  TEXT,
  fatf_data_json      TEXT NOT NULL,               -- FATF R16準拠送金人・受取人データ
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_cb_domestic ON CrossBorderTransactions(domestic_txid);
CREATE INDEX idx_cb_status   ON CrossBorderTransactions(status);
```

### EventStream（双方向通信 — SSEイベントキュー）
```sql
CREATE TABLE EventStream (
  event_id            TEXT PRIMARY KEY,
  target_bank_id      TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  payload_json        TEXT NOT NULL,
  is_delivered        INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);
CREATE INDEX idx_es_bank ON EventStream(target_bank_id, is_delivered, created_at);
```

---

## ZC テーブル（Circuit Breaker / Reversal）

### CircuitBreakerState（参加行疎通監視）
参加行ごとのサーキットブレーカー状態と運用観測メトリクスを保持する。
状態遷移は `CLOSED → OPEN → HALF_OPEN → CLOSED` の標準パターン。

```sql
CREATE TABLE CircuitBreakerState (
  bank_id               TEXT PRIMARY KEY,
  state                 TEXT NOT NULL DEFAULT 'CLOSED',  -- CLOSED|OPEN|HALF_OPEN
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  last_failure_at       TEXT,
  opened_at             TEXT,
  half_open_at          TEXT,
  updated_at            TEXT NOT NULL,
  -- 観測メトリクス
  total_requests        INTEGER NOT NULL DEFAULT 0,      -- 累計呼び出し数
  total_successes       INTEGER NOT NULL DEFAULT 0,      -- 累計成功
  total_failures        INTEGER NOT NULL DEFAULT 0,      -- 累計失敗
  total_denied          INTEGER NOT NULL DEFAULT 0,      -- OPEN 状態で拒否した数
  half_open_inflight    INTEGER NOT NULL DEFAULT 0,      -- HALF_OPEN 中の進行中呼び出し
  last_success_at       TEXT                             -- 直近成功時刻
);
```

`GET /api/circuit-breaker[/:bank_id]` で全行 / 特定行のメトリクスを照会、
`POST /api/circuit-breaker/:bank_id/reset` で運用上の強制 CLOSED が可能。
詳細は `32_api_contracts.md § Circuit Breaker`。

### ReversalRecords（救済取引）
SETTLED 後に発生した苦情・誤送金等を救済するための補償取引メタデータ。
`reversal_txid` は実際の補償送金 TX を指す（lane=STANDARD, purpose='REFUND'
で生成）。

```sql
CREATE TABLE ReversalRecords (
  reversal_id    TEXT PRIMARY KEY,
  original_txid  TEXT NOT NULL,                     -- 元の SETTLED な txid
  reversal_txid  TEXT,                              -- 補償送金の txid（生成後に埋まる）
  amount         INTEGER NOT NULL,
  reason         TEXT NOT NULL,                     -- ReversalReason: CUSTOMER_DISPUTE|DUPLICATE_PAYMENT|INCORRECT_AMOUNT|INCORRECT_PAYEE|FRAUD|OPERATIONAL_ERROR
  status         TEXT NOT NULL DEFAULT 'REQUESTED', -- ReversalStatus: REQUESTED|APPROVED|TX_CREATED|COMPLETED|REJECTED
  requested_by   TEXT NOT NULL,                     -- bank_id | 'OPS'
  description    TEXT,
  -- 一部の reason は事前承認 ref が必須
  approval_ref   TEXT,                              -- 内部統制系チケット参照
  -- リバーサル要求の冪等キー（at-least-once 再配信のリプレイ用）
  idempotency_key TEXT,                             -- UNIQUE; 未設定は NULL
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_rev_original    ON ReversalRecords(original_txid);
CREATE INDEX idx_rev_reversal_tx ON ReversalRecords(reversal_txid);
CREATE UNIQUE INDEX idx_rev_idempotency ON ReversalRecords(idempotency_key);
```

**要求の冪等性**: `requestReversal` は `idempotency_key` を ReversalRecords に
保存し、再配信された要求（同一キー）を自身の台帳で検知して元のリバーサルを
そのままリプレイ返却する。UNIQUE インデックスは並行二重要求のバックストップ
でもある（敗者の INSERT はバッチごとロールバックされ phantom 行を残さない）。

**`reversal_txid` 経由のカスケード**: `onPayeeExecConfirmed`（補償送金が
SETTLED に到達）は `ReversalRecords WHERE reversal_txid = ?` を引いて該当
すれば `completeReversal` を呼ぶ。

---

## ZC テーブル（KeyRegistry）

### KeyRegistry（外部主体の検証用公開鍵レジストリ）
`SettlementProofRef`・`Attestation`・`Mandate`・FinalityCosign（副署）が
共有する信頼アンカー。ZC は **検証
専用の公開鍵のみ**を保持し、秘密鍵は持たない。ZC→外部（egress）の署名は引き
続き既存の HMAC 共有秘密（`src/shared/hmac.ts`）を用い、本テーブルの対象外。

```sql
CREATE TABLE KeyRegistry (
  key_id      TEXT    PRIMARY KEY,           -- 外部主体が指定する不透明な識別子
  owner_type  TEXT    NOT NULL,              -- 'PARTICIPANT'|'ATTESTER'|'AGENT'|'EXTERNAL_RAIL'
  owner_ref   TEXT    NOT NULL,              -- bank_id / participant_id / attester id 等
  public_key  TEXT    NOT NULL,              -- 公開鍵の raw バイト列（base64）
  algo        TEXT    NOT NULL,              -- 'ECDSA_P256'|'ED25519'
  valid_from  TEXT    NOT NULL,              -- RFC3339
  valid_to    TEXT,                          -- RFC3339, NULL=無期限
  revoked_at  TEXT,                          -- RFC3339, NULL=未失効
  status      TEXT    NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE'|'REVOKED'|'EXPIRED'
  created_at  TEXT    NOT NULL
);
CREATE INDEX idx_key_registry_owner ON KeyRegistry(owner_type, owner_ref);
```

**検証モデル**（`src/shared/external_signature.ts`）:
- 署名は `occurred_at`（署名者が主張する時刻）が `[valid_from, valid_to)` の
  範囲内、かつ `revoked_at` が設定されている場合は `occurred_at < revoked_at`
  のときのみ有効（失効は遡及しない）。
- (`key_id`, `nonce`) のリプレイ防止は既存 `IdempotencyKeys` に
  `sig:<key_id>:<nonce>` という合成キーで相乗りする（新規テーブルなし）。
- 鍵の登録・失効は ZC 運営の制度行為として 4 眼承認の対象とする
  （`10_requirements.md`（制度・ガバナンス要件）のブレークグラスと同じ統制思想）。

---

## ZC テーブル（ConditionTemplate / Attestation）

### ConditionTemplate（条件テンプレートのホワイトリスト）
HTLC の「preimage 提示＝条件成立」を一般化した、署名付き「条件成立」表明
（アテステーション）の whitelist 本体。`HtlcAuthWhitelist` と同じ統制思想で、
許可制だが第三者が提案できる。

```sql
CREATE TABLE ConditionTemplate (
  template_id            TEXT    PRIMARY KEY,        -- 例: 'TPL-INSPECTION-COMPLETE'
  predicate_kind         TEXT    NOT NULL,           -- ドメインラベル（例: 'INSPECTION_COMPLETE'）
  allowed_attester_scope TEXT    NOT NULL,           -- JSON: {key_ids?, owner_refs?, owner_types?}
  status                 TEXT    NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE'|'SUSPENDED'|'REVOKED'
  description            TEXT,
  registered_at          TEXT    NOT NULL
  -- プログラマビリティ拡張（統合スキーマに収録）
  , min_attester_quorum  INTEGER NOT NULL DEFAULT 1  -- 条件成立に要する distinct attester operator 数（k-of-n）。1=従来の単一表明
  , ledger_predicate_json TEXT                       -- 非NULL時、外部表明ではなく ZC 自身の確定済み FinalityLog で解決する述語（LedgerPredicate）
);
```

プログラマビリティ拡張の 2 列（いずれも既定値ありで後方互換）:

- `min_attester_quorum`: そのテンプレートの Attestation が条件リーフを満たすために必要な **distinct な attester operator（`KeyRegistry.owner_ref`）数**。Watcher の `onchain_min_watchers` と同型の k-of-n 定足数で、同一 operator が複数鍵を持っても 1 と数える。既定 1 は従来挙動。判定は `src/shared/attestation_quorum.ts`（純粋な定足数・equivocation 判定は `src/shared/operator_quorum.ts` に集約し Watcher 経路と共有）。
- `ledger_predicate_json`: 非 NULL のとき、このテンプレートは外部 attester ではなく **ZC が自分の確定済み FinalityLog に対して決定的に解決**する（`src/zc/platform/ledger_predicate.ts`、例 `{"kind":"TX_REACHED_STATE","txid":"TX-…","states":["SETTLED"]}`）。この種のテンプレートは `allowed_attester_scope='{}'`（誰も表明できない＝fail-closed）とする。

### Attestation（署名付き「条件成立」表明）
ZC は表明の真偽を判断せず、「誰が・いつ・どの条件根拠で表明したか」の証跡
のみを持つ。原文は保持せず `statement_hash`（sha256 hex）と検証結果
（`verified_result`）のみ保持する（`30_internal_design.md` §11.2-b）。

```sql
CREATE TABLE Attestation (
  attestation_id   TEXT    PRIMARY KEY,              -- 'ATT-<uuid>'
  template_id      TEXT    NOT NULL,
  subject_ref      TEXT    NOT NULL,                 -- txid / gtid / leg_id
  attester_key_id  TEXT    NOT NULL,                 -- KeyRegistry.key_id
  statement_hash   TEXT    NOT NULL,                 -- sha256 hex
  signature        TEXT    NOT NULL,                 -- base64
  nonce            TEXT    NOT NULL,
  occurred_at      TEXT    NOT NULL,                 -- RFC3339（表明者主張）
  verified_result  TEXT    NOT NULL,                 -- 'PASS'|'FAIL'
  created_at       TEXT    NOT NULL,
  FOREIGN KEY (template_id) REFERENCES ConditionTemplate(template_id)
);
CREATE INDEX idx_attestation_subject  ON Attestation(subject_ref);
CREATE INDEX idx_attestation_template ON Attestation(template_id);
```

**検証フロー**（`src/shared/attestation.ts` の `recordAttestation()`）:
1. `ConditionTemplate` が `status='ACTIVE'` であること（`TEMPLATE_NOT_WHITELISTED`）。
2. `statement_hash` が sha256 hex 形式であること（`ATTESTATION_INVALID`）。
3. `{template_id, subject_ref, statement_hash, verified_result}` への署名を
   `KeyRegistry`（§K）で検証（`KEY_*` / `EXTERNAL_SIGNATURE_INVALID` /
   `SIGNATURE_REPLAYED`）。
4. 検証済み鍵が `allowed_attester_scope` の範囲内であること
   （`ATTESTER_UNAUTHORIZED`。空スコープは fail-closed＝誰も許可されない）。

---

## ZC テーブル（Mandate）

### Mandate（委任チェーン — 「誰の権限で指示されたか」）
すべての指図に「どの権限根拠で発生したか」の参照を持たせる委任エンティティ。
新しいレーン／状態は追加しない。
受理時に `mandate_id` を解決し、`parent_mandate_id` を遡って委任チェーンを
辿り、各リンクの amount/purpose/lane が許可範囲内であることを検証する
（`assertMandateValid`）。委任は親のスコープを狭める方向にのみ働く。

```sql
CREATE TABLE Mandate (
  mandate_id               TEXT    PRIMARY KEY,        -- 'MANDATE-<uuid>'
  principal_participant_id TEXT    NOT NULL,           -- 権限の最終的な保持者
  grantee_ref              TEXT    NOT NULL,           -- 委任先（エージェント等）
  parent_mandate_id        TEXT,                       -- 自己参照FK。NULL=root mandate
  max_amount               INTEGER,                    -- NULL=このリンクでは無制限（金額は整数の最小単位）
  allowed_purposes         TEXT,                       -- JSON配列。NULL=このリンクでは無制限
  allowed_lanes            TEXT,                       -- JSON配列。NULL=このリンクでは無制限
  valid_from               TEXT    NOT NULL,           -- RFC3339
  valid_to                 TEXT    NOT NULL,           -- RFC3339
  principal_key_id         TEXT    NOT NULL,           -- KeyRegistry.key_id（principalの鍵）
  signature                TEXT    NOT NULL,           -- base64
  nonce                    TEXT    NOT NULL,
  occurred_at              TEXT    NOT NULL,           -- RFC3339（principal主張）
  revoked_at               TEXT,                       -- RFC3339, NULL=未失効
  created_at               TEXT    NOT NULL,
  FOREIGN KEY (parent_mandate_id) REFERENCES Mandate(mandate_id)
);
CREATE INDEX idx_mandate_principal ON Mandate(principal_participant_id);
CREATE INDEX idx_mandate_grantee   ON Mandate(grantee_ref);
CREATE INDEX idx_mandate_parent    ON Mandate(parent_mandate_id);
```

**登録フロー**（`src/shared/mandate.ts` の `registerMandate()`）:
- principal が `buildMandatePayload()` の正規ペイロード
  （`principal_participant_id`, `grantee_ref`, `parent_mandate_id`, `max_amount`,
  `allowed_purposes`, `allowed_lanes`, `valid_from`, `valid_to`）に署名し、
  `KeyRegistry`（§K）で検証する（`KEY_*` / `EXTERNAL_SIGNATURE_INVALID` /
  `SIGNATURE_REPLAYED`）。`parent_mandate_id` の存在確認は呼び出し側の責務。

**検証フロー**（`assertMandateValid(db, mandate_id, check, now)`）:
1. `mandate_id`（またはその祖先）が存在しない → `MANDATE_NOT_FOUND`
2. `revoked_at` が設定済みかつ `now >= revoked_at` → `MANDATE_REVOKED`
   （失効は遡及しない）
3. `now` が `[valid_from, valid_to)` の範囲外 → `MANDATE_EXPIRED`
4. `check.amount`/`purpose`/`lane` がいずれかのリンクの
   `max_amount`/`allowed_purposes`/`allowed_lanes` を超える → `MANDATE_BREACH`
5. `parent_mandate_id` を辿って 1〜4 をルートまで繰り返す
   （`MAX_CHAIN_DEPTH=10` を超えると `MANDATE_BREACH`、循環防止）。

返り値は参照された mandate（index 0）からルートまでのチェーン。

---

## ZC テーブル（継続収納）

要件＝[`10_requirements.md` §3.2.8](10_requirements.md#dd-layers)、処理方式＝[`20_method_design.md` §2.2.7](20_method_design.md#direct-debit-flow)。

3 層で構成する。**各層の担う仕事は重ならない。**

| 層 | 表 | 守るもの |
|---|---|---|
| 契約 | `DebitMandate` + `MandateBudget` | 誰が誰に、何について、どこまでの回収を許したか |
| 予告 | `ScheduledCollection` + `CollectionAttempt` | いつ・いくら回収するかの事前開示と、変更の統制 |
| 実行 | `Transactions`（`lane='DIRECT_DEBIT'`） | 資金移動そのもの |

### DebitMandate（継続収納契約）

顧客が署名した `Mandate` を根拠に、受取人が反復的に回収できる範囲を固定する。

**上限（`*_cap`）は本表に一元的に保持し、`MandateBudget` 側に写しを置かない。** 上限は契約の途中で変更されうる（[`10_requirements.md` §3.2.8.4-10](10_requirements.md#dd-budget)：引き下げは顧客署名不要、引き上げは必要）ため、写しを持つと伝播漏れが「宣言された上限と実際に効いている上限の食い違い」を生む。枠の判定は本表への相関副問合せで行う。

```sql
CREATE TABLE DebitMandate (
  dd_mandate_id        TEXT    PRIMARY KEY,        -- 'DDM-<uuid>'
  mandate_id           TEXT    NOT NULL,           -- FK → Mandate（顧客署名の根拠）
  payer_bank_id        TEXT    NOT NULL,
  payer_account_alias  TEXT    NOT NULL,           -- ALS/Proxy 解決対象。口座番号を直書きしない
  payee_bank_id        TEXT    NOT NULL,
  payee_account_hash   TEXT    NOT NULL,
  product_ref          TEXT    NOT NULL,           -- 商材参照。ZC は意味を解釈しない
  charge_mode          TEXT    NOT NULL,           -- 'PERIODIC' | 'ITEMIZED'
  period_cycle         TEXT,                       -- PERIODIC 時 'MONTHLY'|'YEARLY'
  collection_mode      TEXT    NOT NULL,           -- 'REALTIME'|'SCHEDULED'|'SCHEDULED_LONG'
  notice_days_min      INTEGER NOT NULL DEFAULT 0,
  amend_freeze_hours   INTEGER NOT NULL,           -- 振替日から遡る凍結時刻（時間）
  ladder_max           INTEGER NOT NULL,
  nonbusiness_day_rule TEXT    NOT NULL DEFAULT 'NEXT_BUSINESS',
  per_collection_cap   INTEGER,                    -- 1 回あたり金額
  month_amount_cap     INTEGER,                    -- 暦月の累計金額（リセット型）
  month_count_cap      INTEGER,                    -- 暦月の回数（リセット型）
  two_month_amount_cap INTEGER,                    -- 連続 2 暦月の合計（境界攻撃の防止）
  day_count_cap        INTEGER,                    -- 1 日あたりの回数（リセット型）
  lifetime_amount_cap  INTEGER,                    -- 全期間の累計金額（消尽型）
  lifetime_count_cap   INTEGER,                    -- 全期間の回数（消尽型）
  pending_amount_cap   INTEGER,                    -- 未確定枠
  pending_count_cap    INTEGER,
  latefee_month_cap    INTEGER,                    -- 遅延損害金の独立枠
  latefee_rate_max     REAL,
  realtime_month_count_cap INTEGER,                -- モード別枠
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
```

- `NULL` の `*_cap` は「この枠は制約として働かない」を意味する。
- **認可期限は必須ではない**（[`10_requirements.md` §3.2.8.1-4](10_requirements.md#dd-layers)）。無期限の契約は `Mandate.valid_to` を遠い将来の番兵値で表現する（`assertMandateValid` の検証意味論を変更しないため）。
- `payer_account_alias` に口座番号を直書きしないのは、口座変更・行内番号変更・合併に耐えるため。

### MandateBudget（累計枠のカウンタ）

**契約あたり 1 行に全カウンタを集約する。** 収納 1 件は暦月枠・消尽枠・未確定枠を*同時に*消費するため、窓ごとに行を分けると複数行の原子的取得が必要になり、取得順序の管理（＝デッドロック回避）を要求してしまう。全カウンタを 1 行に置けば、単一行 CAS がそのまま直列化点になる（`transitionWithLog` / H 予約 / `FxTransfers.status` と同じ作法）。

```sql
CREATE TABLE MandateBudget (
  dd_mandate_id        TEXT    PRIMARY KEY,
  month_key            TEXT    NOT NULL,           -- 'YYYY-MM'
  month_amount         INTEGER NOT NULL DEFAULT 0,
  month_count          INTEGER NOT NULL DEFAULT 0,
  prev_month_key       TEXT,                       -- 連続 2 暦月合計の算定用
  prev_month_amount    INTEGER NOT NULL DEFAULT 0,
  day_key              TEXT    NOT NULL,           -- 'YYYY-MM-DD'
  day_count            INTEGER NOT NULL DEFAULT 0,
  latefee_month_amount INTEGER NOT NULL DEFAULT 0,
  realtime_month_count INTEGER NOT NULL DEFAULT 0,
  lifetime_amount      INTEGER NOT NULL DEFAULT 0, -- 消尽型（回復しない）
  lifetime_count       INTEGER NOT NULL DEFAULT 0, -- 消尽型（回復しない）
  pending_amount       INTEGER NOT NULL DEFAULT 0, -- 未確定枠（確定時に解放）
  pending_count        INTEGER NOT NULL DEFAULT 0,
  last_amount          INTEGER,                    -- 前回比の変動幅判定用
  updated_at           TEXT    NOT NULL,
  version              INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (dd_mandate_id) REFERENCES DebitMandate(dd_mandate_id)
);
```

**窓のロールオーバーは予約と同じ UPDATE の中で行う。** `month_key` が現在の暦月と異なれば、その UPDATE の中で `CASE` 式によりカウンタをリセットし、旧値を `prev_month_*` へ送る。別ジョブでリセットすると、リセットと予約のあいだに競合窓が生じる。

- **リセット型**（`month_*` / `day_*` / `latefee_month_*` / `realtime_month_*`）は窓が変われば自動的に回復する。意味はレート制限。
- **消尽型**（`lifetime_*`）は回復しない。意味は契約の総量であり、**使い切りをもって契約が終了する**（「12 回払い」はこれで表現する）。違反時の理由コードを分ける（`BUDGET_RATE_EXCEEDED` / `BUDGET_EXHAUSTED`）のは、両者が「取りすぎ」と「契約範囲外」という別の事象だからである。
- **上限変更はカウンタをリセットしない**（引き上げ→引き下げの往復による消費の洗浄を防ぐ）。

### ScheduledCollection（収納予告）

`Transactions` ではない。振替日に発火したものだけが `Transactions` として実体化する。ラダーの各段も本表の行であり、同一 `charge_ref` を共有する。

```sql
CREATE TABLE ScheduledCollection (
  collection_id     TEXT    PRIMARY KEY,           -- 'COL-<uuid>'
  dd_mandate_id     TEXT    NOT NULL,
  charge_ref        TEXT    NOT NULL,              -- 請求費目（正規化済み・顧客に表示される）
  ladder_seq        INTEGER NOT NULL DEFAULT 1,    -- 段番号（1 = 基本段）
  amount_value      INTEGER NOT NULL,              -- 元本
  latefee_value     INTEGER NOT NULL DEFAULT 0,    -- 遅延損害金（元本と分離）
  amount_currency   TEXT    NOT NULL DEFAULT 'JPY',
  due_date          TEXT    NOT NULL,              -- 振替日 'YYYY-MM-DD'
  confirm_deadline_at TEXT  NOT NULL,              -- 失敗が確定する時刻（モードごとの確定点）
  amend_freeze_at   TEXT    NOT NULL,              -- RFC3339。REALTIME は生成時刻と等しい
  mode              TEXT    NOT NULL,              -- 実効モード（降格後）
  requested_mode    TEXT    NOT NULL,              -- 受取行が要求したモード（降格の説明用）
  state             TEXT    NOT NULL DEFAULT 'SCHEDULED',
  result            TEXT,                          -- NULL(未確定)|'CONFIRMED_OK'|'CONFIRMED_NG'
  reason_code       TEXT,
  retriable_today   INTEGER NOT NULL DEFAULT 0,
  vault_ref         TEXT,                          -- 認可証明 preimage の Vault 参照
  hashlock          TEXT,
  extra_mandate_id  TEXT,                          -- 単発認可（追加認可）
  edi_ref           TEXT,
  priority_hint     INTEGER,                       -- 顧客の優先指定（充当順序 第1項）
  budget_reserved   INTEGER NOT NULL DEFAULT 0,
  txid              TEXT,                          -- FIRED 後
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

CREATE UNIQUE INDEX uq_collection_charge_ok
  ON ScheduledCollection(dd_mandate_id, charge_ref)
  WHERE result = 'CONFIRMED_OK';

CREATE INDEX idx_collection_due    ON ScheduledCollection(due_date, state);
CREATE INDEX idx_collection_ddm    ON ScheduledCollection(dd_mandate_id, charge_ref);
CREATE INDEX idx_collection_txid   ON ScheduledCollection(txid);
CREATE INDEX idx_collection_freeze ON ScheduledCollection(amend_freeze_at, state);
```

**`uq_collection_charge_ok` が二重収納の防止とラダーの排他（OCO）を同時に担う唯一の制約である。** 1 費目について `CONFIRMED_OK` に到達できる収納は高々ひとつなので、先行段が成功すれば後続段は構造的に成立しえない。**両者に別々の機構を設けてはならない**——同じ不変条件だからである。部分ユニークインデックス（`WHERE result = 'CONFIRMED_OK'`）としているのは、失敗した段や未確定の段は同一 `charge_ref` に複数並立してよいためである。

状態遷移は [`20_method_design.md` §2.2.7.3](20_method_design.md#direct-debit-flow) の図を正とする。`SUPERSEDED` / `LAPSED` / `WITHDRAWN` は**行削除ではなく状態**である——「5月13日の再請求は 4月27日に成功したため取り消された」と説明できなければならない。

### CollectionAttempt（試行の系列）

追記型。収納の現在状態は、この系列と窓の開閉から**導出**する（設計思想 1）。中間結果は確定ではないが、受取人にとっては行動の根拠となる（0 時に未成功が判れば当日中に督促できる）ため記録する。

```sql
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
```

**確定は成功と失敗で非対称である。** 成功した試行を観測した時点で `result='CONFIRMED_OK'` が確定する（資金が動いた以上それ以上変わらない）。失敗は**振替日 24:00** をもって初めて `CONFIRMED_NG` に確定する——日中の残高不足は「まだ b に到達していない」だけであり、顧客が日中に入金すれば後続のセンターカットで成功しうる。

---

## ZC テーブル（WatcherObservation）

### WatcherObservation（外部レール確定イベントの観測記録）
ZC コアは外部レール
（オンチェーン／IGS／海外レール）を直接観測しない。`Watcher`
（`KeyRegistry.owner_type='EXTERNAL_RAIL'|'ATTESTER'` として登録）が観測した
確定イベントの署名付き表明のみを信頼し、P1 `SettlementProofRef` を生成する。

```sql
CREATE TABLE WatcherObservation (
  observation_id  TEXT    PRIMARY KEY,        -- 'WOBS-<uuid>'
  source          TEXT    NOT NULL,           -- レール/Watcher識別子。例: 'ONCHAIN:ETH', 'IGS_BOJ', 'CB_TOKEN:ECB:ETH'
  external_ref    TEXT    NOT NULL,           -- チェーン上txハッシュ／IGS確認ID／アテステーションID
  venue           TEXT    NOT NULL,           -- 'IGS_BOJ'|'ONCHAIN'|'ATTESTATION'|'CB_TOKEN'
  proof_type      TEXT    NOT NULL,           -- ProofType（a/bのいずれの証跡か）
  issuer_ref      TEXT    NOT NULL,           -- SettlementProofRef.issuer_bank_id に転記
  watcher_key_id  TEXT    NOT NULL,           -- KeyRegistry.key_id（観測したWatcher）
  signature       TEXT    NOT NULL,           -- base64
  nonce           TEXT    NOT NULL,
  occurred_at     TEXT    NOT NULL,           -- RFC3339（Watcher主張の観測時刻）
  proof_ref       TEXT    NOT NULL,           -- JSON SettlementProofRef
  created_at      TEXT    NOT NULL,
  confirmations   INTEGER                     -- オンチェーン観測の承認数（onchain_min_confirmationsとの確認深度ゲート）
);
-- 1イベント×1 Watcher鍵で一意。同一 Watcher の重複観測は dedup し、別 Watcher の
-- 観測は n-of-m クォーラムへの1票として追加記録される。
CREATE UNIQUE INDEX idx_watcher_observation_source_ref_key ON WatcherObservation(source, external_ref, watcher_key_id);
CREATE INDEX idx_watcher_observation_event ON WatcherObservation(source, external_ref);
CREATE INDEX idx_watcher_observation_key ON WatcherObservation(watcher_key_id);
```

**記録フロー**（`src/shared/watcher.ts` の `recordWatcherObservation()`）:
1. `(source, external_ref, watcher_key_id)` が既に記録済みなら、署名を再検証せず
   既存行を返す（`deduped: true`）。**同一 Watcher** の重複観測は `20_method_design.md` §7.7.2 の冪等として
   吸収する。一方、**別 Watcher** が同一イベントを報告した場合は dedup せず、検証して
   1行追加する（n-of-m クォーラムへの1票）。
2. 未記録の場合、`buildWatcherObservationPayload()` の正規ペイロード
   （`source`, `external_ref`, `venue`, `proof_type`, `issuer_ref`）への
   Watcher の署名を `KeyRegistry`（§K）で検証する（`KEY_*` /
   `EXTERNAL_SIGNATURE_INVALID` / `SIGNATURE_REPLAYED`）。
3. 検証済み鍵の `owner_type` が `EXTERNAL_RAIL` または `ATTESTER` であること
   （`WATCHER_UNAUTHORIZED`。それ以外の主体は Watcher として認めない）。
4. `WatcherObservation` 行を保存し、`venue`/`external_ref`/`signer_key_id`/
   `verified_at` を備えた `SettlementProofRef` を返す。

**Watcher クォーラム（信頼最小化）**: `countDistinctWatchers()` は、あるイベント
（`source`,`external_ref`）を観測した**相異なる Watcher 運用主体**（`KeyRegistry.owner_ref`。
`key_id` ではなく `owner_ref` で数えるため、1主体が複数鍵を持っても1票）の数を返す。
クロスチェーン HTLC の決済（`recordOnchainFulfillment`）は、HTLC の
`onchain_min_watchers`（既定 1）に達するまで `HTLC_ONCHAIN_PENDING` に留める。
これにより、単一の Watcher 鍵だけでクロスチェーン脚を確定できないようにする
（クォーラム未達の間は `OnchainQuorumPending` を FinalityLog に記録し、
`reason_code='ONCHAIN_QUORUM_PENDING'` とする）。

---

## ZC テーブル（FinalityAnchor / FinalityCosign）

### FinalityAnchor（透明性アンカリング）
検証可能性の強化（単一書き込み者・完全性）。ZC は単一書き手のままだが、
FinalityLog の各チェーン（`finality_chain.ts`）の先端ハッシュを
`event_seq` のハイウォーターマークで定期的にスナップショットし、
追記専用の `FinalityAnchor` 行へ固定する。これが「ZC が書き換えられない
参照点」となり、参加者は後から自チェーンの包含を独立検証できる。

```sql
CREATE TABLE FinalityAnchor (
  anchor_id          TEXT    PRIMARY KEY,        -- 'ANCHOR-<uuid>'
  anchor_seq         INTEGER NOT NULL,           -- アンカーの連番
  high_watermark_seq INTEGER NOT NULL,           -- アンカー時点の MAX(FinalityLog.event_seq)
  chain_tips_json    TEXT    NOT NULL,           -- JSON配列 {chain_id, tip_hash}（chain_id昇順）
  root_hash          TEXT    NOT NULL,           -- chain_tips_json の sha256
  created_at         TEXT    NOT NULL
);
CREATE UNIQUE INDEX idx_finality_anchor_seq ON FinalityAnchor(anchor_seq);
CREATE INDEX idx_finality_anchor_watermark ON FinalityAnchor(high_watermark_seq);
```

**フロー**（`src/zc/finality/finality_anchor.ts`）:
- `createFinalityAnchor()`：全チェーンID（`finality_audit.ts` の
  `listChainIds()`）について `high_watermark_seq` 時点の tip hash を
  `getChainTipHashAsOf()` で取得し、`chain_tips_json`／`root_hash` とともに
  新しい `FinalityAnchor` 行を追記する。FinalityLog が空の場合は `null`。
- `verifyChainInclusion(db, anchor_id, chain_id)`：アンカー時点の
  `chain_id` の tip hash を再計算し、アンカーに記録された値と一致するかを
  返す（`included: boolean`）。不一致はアンカー後にそのチェーンの
  `entry_hash` が書き換えられたことを示す。`ANCHOR_NOT_FOUND` /
  `CHAIN_NOT_ANCHORED` を reason_code として登録。
- 配布先（全参加行配信／公開トランスペアレンシーログ／公開チェーンへの
  従的アンカリング）は運用上の決定であり、本実装は `FinalityAnchor`
  テーブルへの記録までを担う（§G オープン論点）。

### FinalityCosign（参加行の副署）
自行が当事者となる **TX / GTID / DNS** チェーンについて、その現在の tip hash に
参加行が署名する（当事者判定: TX=payer/payee、GTID=leg 銀行、DNS=ネット
ポジション銀行）。`KeyRegistry`（`owner_type='PARTICIPANT'`、§K）で検証する。
`chain_kind` 列が対象チェーン種別を記録する。

```sql
CREATE TABLE FinalityCosign (
  cosign_id      TEXT    PRIMARY KEY,        -- 'COSIGN-<uuid>'
  chain_id       TEXT    NOT NULL,           -- FinalityLog chain id（txid/gtid/cycle_id）
  participant_id TEXT    NOT NULL,           -- 副署する参加行の bank_id
  entry_hash     TEXT    NOT NULL,           -- 副署対象の tip entry_hash
  signer_key_id  TEXT    NOT NULL,           -- KeyRegistry.key_id（owner_type='PARTICIPANT', owner_ref=participant_id）
  signature      TEXT    NOT NULL,           -- base64
  nonce          TEXT    NOT NULL,
  occurred_at    TEXT    NOT NULL,           -- RFC3339（参加行主張）
  created_at     TEXT    NOT NULL,
  chain_kind     TEXT                        -- TX|GTID|DNS
);
CREATE UNIQUE INDEX idx_finality_cosign_chain_participant_entry ON FinalityCosign(chain_id, participant_id, entry_hash);
CREATE INDEX idx_finality_cosign_participant ON FinalityCosign(participant_id);
```

### CosignPolicy（副署の必須化ポリシー）
チェーン種別ごとに副署を必須化する設定。`is_mandatory=1` のチェーン種別は、
現在の tip に対して `min_cosigners` 以上の異なる参加行が副署して初めて
「外部検証済み」とみなせる（`checkCosignRequirement()` が判定）。

```sql
CREATE TABLE CosignPolicy (
  chain_kind     TEXT PRIMARY KEY,            -- TX|GTID|DNS
  min_cosigners  INTEGER NOT NULL DEFAULT 1,
  is_mandatory   INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL
);
```

**フロー**（`recordFinalityCosign()`）:
1. `chain_id` が co-signable（`TX-*` / `GT-*`・`GTID-*` / `DNS-*`）であり、
   `participant_id` が当該チェーンの当事者であること
   （`COSIGN_NOT_APPLICABLE`。GLOBAL チェーン・非当事者は対象外）。
2. チェーンに最低1件の FinalityLog エントリがあること
   （`COSIGN_ENTRY_NOT_FOUND`）。
3. `{chain_id, entry_hash}` への参加行の署名を `KeyRegistry`（§K）で検証
   （`KEY_*` / `EXTERNAL_SIGNATURE_INVALID` / `SIGNATURE_REPLAYED`）。
4. 検証済み鍵が `owner_type='PARTICIPANT'` かつ `owner_ref=participant_id`
   であること（`COSIGN_PARTICIPANT_MISMATCH`）。
5. `(chain_id, participant_id, entry_hash)` が既存なら署名再検証せず既存行
   を返す（同一 tip への再副署は冪等）。

**副署の必須/任意**（§G オープン論点）：本実装は副署を**任意の追加証跡**
として扱い、決済フローの状態機械（受理・決済判定）には影響しない。

---

## ZC テーブル（SystemMode）

### SystemMode（ZC全体のBCP縮退モード）
`DnsCycles.HOLD_ACTIVE`
（DNS_HOLD）と同じ「不確定時は Read-only へ縮退」原則を、ベンダー障害
（Cloudflare 障害等）シナリオまで拡張する。`id=1` の単一行テーブルで
ZC 全体の運用モードを保持する。

```sql
CREATE TABLE SystemMode (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  mode         TEXT NOT NULL DEFAULT 'NORMAL',  -- NORMAL | BCP_READONLY
  reason       TEXT,
  activated_at TEXT,
  updated_at   TEXT NOT NULL
);
```

**フロー**（`src/zc/platform/system_mode.ts`）:
- `getSystemMode()`：現在のモードを返す（seed行が無い場合は `NORMAL` を既定値とする）。
- `assertNotBcpReadOnly(mode)`：`mode === 'BCP_READONLY'` のとき
  `SYSTEM_BCP_READ_ONLY`（reason_code、`docs/specs/32_api_contracts.md` §エラーカタログ）
  を投げる。新規の資金移動を開始する ingress ハンドラ向け。照会系
  （ステータス参照など）は対象外。
- `activateBcpReadOnly(env, reason)` / `deactivateBcpReadOnly(env)`：
  `NORMAL` ⇄ `BCP_READONLY` の遷移。冪等（既に目的のモードであれば
  FinalityLog への二重書き込みを行わず既存行を返す）。遷移を
  `FinalityLog` の GLOBAL チェーン（`txid IS NULL AND gtid IS NULL`）に
  `SystemBcpActivated` / `SystemBcpDeactivated` として記録する。

**API**：`GET /api/system-mode`（現在のモード取得）、
`POST /internal/system-mode/bcp-activate`（`{reason}` を指定して
`BCP_READONLY` へ移行）、`POST /internal/system-mode/bcp-deactivate`
（`NORMAL` へ復帰）。

可搬性（Cloudflare固有バインディングの抽象化層）は本実装の対象外
（§H オープン論点として残る）。

---

## HtlcContracts クロスチェーン拡張

### クロスチェーンHTLC（`HtlcContracts` の `cross_chain_*` / `onchain_*` 列）
オンチェーン決済手段との接続（クロスチェーンHTLC）。列定義は上記 HtlcContracts
を参照（`cross_chain_source` / `onchain_timelock` / `onchain_lock_ref` /
`onchain_lock_proof_json` / `onchain_release_proof_json`）。
`cross_chain_source` が `NULL` の場合は通常の ZC 側 HTLC と完全に同一の
動作。`cross_chain_source` が設定されている場合、
同じ `hashlock` が `source`（例: `'ONCHAIN:ETH'`）下のオンチェーンエスクロー
もロックしており、ZC はチェーンを直接検査せず Watcher（`20_method_design.md` §7.7）の
署名付き観測（`SettlementProofRef`、venue=`ONCHAIN`）のみを受理する。

**不変条件**:
- `onchain_timelock`（オンチェーン側の内側タイムロック）は必ず `timelock`
  （ZC側の外側タイムロック）より厳密に前（`createHtlc` が
  `ONCHAIN_TIMELOCK_INVALID` で拒否）。ZC側のH予約は常にオンチェーン側より
  長く保持される。
- 同一 `hashlock`（= `secret_hash`）が ZC 側・オンチェーン側の両レッグを
  アンロックする。二重決済は不可（`HTLC_FULFILL_REQUESTED` への CAS が
  単一のソース状態からのみ許可される）。

**状態遷移**（`src/zc/lanes/htlc.ts`）:
- `HTLC_LOCKED` → `HTLC_ONCHAIN_PENDING`（`recordCrossChainLock`、
  `CrossChainLocked` イベント。Watcherがオンチェーンエスクローのロックを
  観測）。`onchain_lock_ref` / `onchain_lock_proof_json` を記録。
- `HTLC_ONCHAIN_PENDING` → `HTLC_FULFILL_REQUESTED` → `DECIDED_TO_SETTLE`
  → ...（`recordOnchainFulfillment`、`OnchainProofObserved` イベント。
  Watcherがオンチェーンエスクローのプリイメージ公開を観測。
  `settleAfterPreimage` で `claimHtlc` と同じ決済シーケンスを共有）。
  `onchain_release_proof_json` を記録。
- プリイメージが `hashlock` に一致しない場合: `ONCHAIN_PROOF_MISMATCH`
  （Watcherの署名/nonceを消費する前に拒否、`HtlcClaimRejected` ログ）。
- `onchain_timelock` 超過かつ未フルフィルの場合: `ONCHAIN_TIMEOUT` で
  `cancelHtlc`（`HTLC_ONCHAIN_PENDING` も `cancelHtlc` の対象状態に含まれる）。
  ZC側 `timelock` 超過の場合は既存の `TIMELOCK_EXPIRED` で `cancelHtlc`。
  どちらもタイムアウトスイープ（`src/cron/timeout_sweep.ts`）が定期的に検出。

**API**: `POST /api/htlc/:htlc_id/cross-chain-lock` /
`POST /api/htlc/:htlc_id/onchain-fulfillment`（いずれも Watcher 専用、
`docs/specs/32_api_contracts.md` 参照）。

---

## Bank基本テーブル

### BankAccounts（口座マスター）
```sql
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
```

### BankJournals（元帳：ゼロサム・INSERT ONLY）
```sql
CREATE TABLE BankJournals (
  journal_id  TEXT    PRIMARY KEY,             -- UUID
  bank_id     TEXT    NOT NULL,
  account_id  TEXT    NOT NULL,
  amount      INTEGER NOT NULL,                -- 符号付き（正=増加、負=減少）
  amount_currency TEXT NOT NULL DEFAULT 'JPY', -- ISO 4217。元帳金額の通貨次元
  tx_type     TEXT    NOT NULL,                -- TRANSFER|RESERVE|EXECUTE|CREDIT|INTEREST|CASH|CORRECTION
  txid        TEXT,                            -- ZC取引ID（外部参照）
  tx_group_id TEXT    NOT NULL,                -- 仕訳グループ（ゼロサム確認単位）
  description TEXT,
  value_date  TEXT    NOT NULL,                -- 勘定日付 'YYYY-MM-DD'
  created_at  TEXT    NOT NULL
);
CREATE INDEX idx_jnl_account ON BankJournals(account_id, value_date);
CREATE INDEX idx_jnl_txid    ON BankJournals(txid);
CREATE INDEX idx_jnl_group   ON BankJournals(tx_group_id);
CREATE INDEX idx_jnl_account_ccy ON BankJournals(account_id, amount_currency);
```

> **通貨次元（amount_currency）**: 共有の透明・別段勘定（suspense `{bank}0000000`、
> ZC清算 `{bank}-ZCS`、利益剰余 `{bank}-RE`）は通貨で口座分離されないため、
> 単純な `SUM(amount)` は非JPYフローが混じると単位を取り違える。各行に通貨を
> 持たせ、ゼロサム検証（`verifyZeroSum`）と残高計算（`calcBalance(account_id, ccy)`）を
> **通貨ごと**に行う。`insertJournalGroup` のゼロサム検査も通貨別（PvP のような
> 多通貨グループは各通貨が独立に均衡することを要求）。既存行は DEFAULT 'JPY' で
> 後方互換。

### ZcRequests（ZC指示の冪等管理）
```sql
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
```

### SuspenseDetails（別段預金明細）
```sql
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
```

CUSTODY（凍結/解約/該当なし口座宛の受取資金）の解消経路は2つ:
1. **手動**: teller API `POST /bank/:bankId/v1/teller/suspense/:suspenseId/resolve`（SETTLE/RETURN）
2. **自動**: timeout sweep（毎分）の `releaseRecoveredCustody` が、口座が
   NORMAL+SAVINGS に復旧した CUSTODY レコードを顧客口座へ自動入金（CUSTODY→SETTLED）。
   NOT_FOUND / SYSTEM_ACCOUNT 由来（account_id が別段口座を指す）は対象外で、手動解消のみ。

### DailyBalances（日次残高スナップショット）
```sql
CREATE TABLE DailyBalances (
  account_id       TEXT    NOT NULL,
  snapshot_date    TEXT    NOT NULL,             -- 'YYYY-MM-DD'
  end_of_day_balance INTEGER NOT NULL,
  PRIMARY KEY (account_id, snapshot_date)
);
```

### InterestRates（利率マスター）
```sql
CREATE TABLE InterestRates (
  rate_id        TEXT PRIMARY KEY,
  bank_id        TEXT NOT NULL,
  account_type   TEXT NOT NULL,
  annual_rate    REAL NOT NULL,                -- 例: 0.001 = 0.1%
  effective_from TEXT NOT NULL,
  effective_to   TEXT
);
```

---

## Bank テーブル（監査ログ・着金フィルタ）

### BankAuditLog（Bank側 コマンド監査ログ：INSERT ONLY）
```sql
CREATE TABLE BankAuditLog (
  log_id       TEXT    PRIMARY KEY,              -- UUID
  bank_id      TEXT    NOT NULL,
  txid         TEXT,
  request_id   TEXT,                             -- ZC request_id
  command      TEXT    NOT NULL,                 -- reserve-funds|execute-debit|...
  status       TEXT    NOT NULL,                 -- 'OK'|'NG'
  reason_code  TEXT,
  amount       INTEGER,
  account_id   TEXT,
  details_json TEXT,
  occurred_at  TEXT    NOT NULL
);
CREATE INDEX idx_audlog_bank ON BankAuditLog(bank_id, occurred_at);
CREATE INDEX idx_audlog_txid ON BankAuditLog(txid);
CREATE INDEX idx_audlog_req  ON BankAuditLog(request_id);
```

### PaymentFilters（着金フィルタリングルール）
```sql
CREATE TABLE PaymentFilters (
  filter_id      TEXT    PRIMARY KEY,
  bank_id        TEXT    NOT NULL,
  scope          TEXT    NOT NULL DEFAULT 'ACCOUNT',  -- 'BANK_WIDE'|'ACCOUNT'
  account_id     TEXT,                           -- scope=ACCOUNT の場合の対象口座
  filter_type    TEXT    NOT NULL,
  -- 'SENDER_BLOCK'      : 特定送金元口座ハッシュをブロック
  -- 'SENDER_BANK_BLOCK' : 特定送金元銀行IDをブロック
  -- 'AMOUNT_LIMIT'      : 金額上限（超過は action 適用）
  -- 'EDI_PATTERN'       : 電文EDIのパターンマッチ
  -- 'REQUIRE_APPROVAL'  : 全着金に顧客承認を要求
  condition_json TEXT    NOT NULL,
  action         TEXT    NOT NULL,               -- 'REJECT'|'HOLD_CONFIRM'|'HOLD_MANUAL'
  description    TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE INDEX idx_filter_bank    ON PaymentFilters(bank_id, is_active);
CREATE INDEX idx_filter_account ON PaymentFilters(account_id, is_active);
```

### PaymentApprovalRequests（着金承認待ちリクエスト）
```sql
CREATE TABLE PaymentApprovalRequests (
  approval_id         TEXT    PRIMARY KEY,
  bank_id             TEXT    NOT NULL,
  account_id          TEXT    NOT NULL,
  txid                TEXT    NOT NULL,
  filter_id           TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'PENDING', -- PENDING|APPROVED|REJECTED|TIMEOUT
  sender_bank_id      TEXT    NOT NULL,
  sender_account_hash TEXT,
  amount_value        INTEGER NOT NULL,
  edi_data            TEXT,
  expires_at          TEXT    NOT NULL,
  responded_at        TEXT,
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);
CREATE INDEX idx_approval_account ON PaymentApprovalRequests(account_id, status);
CREATE INDEX idx_approval_txid    ON PaymentApprovalRequests(txid);
```

---

## 初期データ

### ZC側
```sql
INSERT OR IGNORE INTO Participants (...) VALUES
  ('001', 'みずほ銀行',   '/bank/001', 100000000, 0, 1, '2025-01-01T00:00:00Z'),
  ('002', '三菱UFJ銀行', '/bank/002', 100000000, 0, 1, '2025-01-01T00:00:00Z');
```

### Bank側

口座命名規則: `{bankId}0000000`=別段預金, `{bankId}-ZCS`=清算勘定, `{bankId}-CASH`=現金, `{bankId}-BOJ`=日銀預け金

```sql
-- 口座マスター（システム勘定 + 顧客口座）
-- 001行: 別段預金, ZC清算勘定, 現金, 日銀預け金, 顧客2名
-- 002行: 同上
-- 各顧客口座の初期残高: 100万円（ゼロサム仕訳でZC清算勘定と相殺）
-- 利率: 普通預金 0.1%（001・002共通）
```

---

## Index Catalog

D1 はクエリプランナの統計情報が貧弱で、行数が増えるとインデックス無し
クエリの p99 が急速に悪化する。下表は**現在実装されている**クエリが
利用するインデックスを網羅したもの。新規クエリ追加時は本表をまず確認し、
既存インデックスで賄えない場合は統合スキーマ `0001_consolidated_schema.sql`
に索引を直接追加し、本カタログにも記載すること。なお本ファイル上部の各テーブル `CREATE TABLE` スニペットは
代表的なインデックスのみを併記する場合があり、索引の網羅的な正（authoritative）は
本カタログ（および `migrations/0001_consolidated_schema.sql`）とする。

### Transactions
| Index               | Columns                       | Backed query                                           |
|---------------------|-------------------------------|--------------------------------------------------------|
| idx_tx_state        | (state)                       | 状態別一覧                                             |
| **idx_tx_owner**    | (owner, state)                | timeout sweep の `owner='ZC'` 述語（単一所有者則）     |
| idx_tx_payer        | (payer_bank_id, state)        | 銀行毎の出金照会                                       |
| idx_tx_payee        | (payee_bank_id, state)        | 銀行毎の入金照会                                       |
| idx_tx_dns          | (dns_cycle_id)                | DNS 清算明細生成                                       |
| **idx_tx_updated_at** | (updated_at)                | 更新時刻順の走査（timeout sweep の期限判定は `pending_since` 側。上記 Transactions の列注記） |
| **idx_tx_lane_state** | (lane, state)               | レーン × 状態のダッシュボードフィルタ                  |
| **idx_transactions_mandate_id** | (mandate_id)        | mandate別の関連TX照会（委任チェーン）                       |

### FinalityLog
| Index                          | Columns                       | Backed query                                                   |
|--------------------------------|-------------------------------|----------------------------------------------------------------|
| idx_fl_txid                    | (txid)                        | TX 単体トレース                                                |
| idx_fl_gtid                    | (gtid)                        | GTID 単体トレース                                              |
| idx_fl_seq                     | (event_seq)                   | 全体時系列                                                     |
| idx_fl_chain_seq               | (txid, event_seq)             | ハッシュチェーン検証（TX）                                     |
| idx_fl_gchain_seq              | (gtid, event_seq)             | ハッシュチェーン検証（GTID）                                   |
| **idx_fl_occurred_at**         | (occurred_at)                 | 時間範囲監査（`GET /api/events?limit=&offset=`）               |
| **idx_fl_chain_prev_hash**     | (txid, prev_hash) WHERE …     | TX チェーン分岐防止（部分 UNIQUE）                             |
| **idx_fl_event_seq_unique**    | (event_seq)                   | event_seq 重複防止（UNIQUE）                                   |
| **idx_fl_gtid_chain_prev_hash**| (gtid, prev_hash) WHERE …     | GTID 専用チェーン分岐防止（部分 UNIQUE）                       |

### HtlcContracts
| Index                  | Columns                       | Backed query                                       |
|------------------------|-------------------------------|----------------------------------------------------|
| **idx_htlc_payee_state** | (payee_bank_id, state)      | timeout sweep / payee 側 HTLC 一覧                 |
| **idx_htlc_payer_state** | (payer_bank_id, state)      | payer 側 HTLC 一覧                                 |
| **idx_htlc_timelock**    | (timelock, state)           | timelock 期限切れ抽出                              |
| **idx_htlc_condition_template** | (condition_template_id) | プログラマビリティ: condition_template_id別のHTLC照会     |

### RtpRequests
| Index                 | Columns                       | Backed query                                       |
|-----------------------|-------------------------------|----------------------------------------------------|
| **idx_rtp_payer_state** | (payer_bank_id, state)      | 銀行毎の RTP 一覧                                  |
| **idx_rtp_payee_state** | (payee_bank_id, state)      | 銀行毎の RTP 一覧                                  |
| **idx_rtp_expires**     | (expires_at, state)         | 期限切れ RTP 巡回                                  |

### Cases / IdempotencyKeys / DnsCycles
| Index            | Columns                  | Backed query                                          |
|------------------|--------------------------|-------------------------------------------------------|
| idx_case_txid    | (related_txid)           | TX に紐づくケース照会                                 |
| **idx_case_sla**   | (state, sla_deadline)  | 期限超過 CASE の昇格スイープ（`20_method_design.md` §10.7.4） |
| **idx_case_state** | (state, created_at)    | OPEN/IN_PROGRESS のケース一覧                         |
| **idx_case_gtid**  | (related_gtid)         | GTID に紐づくケース照会                               |
| **idx_case_cause** | (cause_key, state)     | 集約先の探索「この原因の未解決 CASE は既にあるか」（`20_method_design.md` §10.7.2） |
| **idx_case_rel_txid** | (related_txid)      | 集約 CASE の内訳照会（txid 側）                       |
| **idx_case_rel_gtid** | (related_gtid)      | 集約 CASE の内訳照会（gtid 側）                       |
| **idx_idemp_created** | (created_at)        | timeout sweep の冪等キー掃除（PROCESSING孤児 15分 / DONE 24h TTL） |
| **idx_dns_state**     | (state, created_at) | DNS サイクル状態別一覧                                |
| **idx_dns_business_date** | (business_date)  | business_date によるサイクル照会（非UNIQUE）          |

### GtidLegs
| Index            | Columns      | Backed query                                                    |
|------------------|--------------|------------------------------------------------------------------|
| idx_legs_gtid    | (gtid)       | GTID単位でのレグ一覧取得                                          |
| idx_legs_txid    | (txid)       | orchestrator.ts: onPayeeExecConfirmed / suspendTx の txid 逆引き  |

### AccessAuditLog
| Index            | Columns      | Backed query                                                    |
|------------------|--------------|------------------------------------------------------------------|
| idx_access_audit_time    | (occurred_at)                            | 期間指定の監査レビュー |
| idx_access_audit_subject | (subject_type, subject_id, occurred_at)  | 主体別のアクセス履歴（横断突合の事後検知。`10_requirements.md` §3.3.2.2.1.1-3） |

### KeyRegistry
| Index                   | Columns                | Backed query                                  |
|--------------------------|------------------------|------------------------------------------------|
| **idx_key_registry_owner** | (owner_type, owner_ref) | 主体別の鍵一覧（鍵ローテーション・失効操作）   |

### Attestation
| Index                     | Columns       | Backed query                                  |
|----------------------------|---------------|------------------------------------------------|
| **idx_attestation_subject**  | (subject_ref) | 取引/レグ単位のアテステーション一覧            |
| **idx_attestation_template** | (template_id) | テンプレート単位の利用状況集計                 |

### Mandate
| Index                  | Columns               | Backed query                                  |
|--------------------------|-----------------------|------------------------------------------------|
| **idx_mandate_principal** | (principal_participant_id) | principal別のmandate一覧（失効操作）    |
| **idx_mandate_grantee**    | (grantee_ref)         | grantee別のmandate一覧                        |
| **idx_mandate_parent**     | (parent_mandate_id)   | 委任チェーンの子mandate探索                    |

### DebitMandate
| Index                 | Columns                                        | Backed query                                     |
|-----------------------|------------------------------------------------|--------------------------------------------------|
| **idx_ddm_payer**     | (payer_bank_id, payer_account_alias, state)    | 顧客の「私が許可している引き落とし一覧」         |
| **idx_ddm_payee**     | (payee_bank_id, payee_account_hash, state)     | 受取人別の契約一覧・資格喪失時の一括失効         |
| **idx_ddm_mandate**   | (mandate_id)                                   | Mandate 失効時に波及する継続収納契約の探索       |

### ScheduledCollection
| Index                       | Columns                          | Backed query                                                        |
|-----------------------------|----------------------------------|---------------------------------------------------------------------|
| **uq_collection_charge_ok** | (dd_mandate_id, charge_ref) WHERE result='CONFIRMED_OK' | 二重収納の防止とラダー排他（OCO）。部分ユニーク    |
| **idx_collection_due**      | (due_date, state)                | 振替日の発火対象の抽出・充当順序の算定                              |
| **idx_collection_ddm**      | (dd_mandate_id, charge_ref)      | 契約単位の照会（予定を含む）・ラダーの段の探索                      |
| **idx_collection_txid**     | (txid)                           | 実行中の Transactions から予告への逆引き                            |
| **idx_collection_freeze**   | (amend_freeze_at, state)         | 凍結時刻到来分の掃引（cron）                                        |

### CollectionAttempt
| Index                       | Columns                          | Backed query                                     |
|-----------------------------|----------------------------------|--------------------------------------------------|
| **idx_cattempt_collection** | (collection_id, attempt_no)      | 試行系列の時系列取得（現在状態の導出）           |

### WatcherObservation
| Index                  | Columns                  | Backed query                                  |
|--------------------------|--------------------------|------------------------------------------------|
| **idx_watcher_observation_source_ref_key** | (source, external_ref, watcher_key_id) UNIQUE | 1イベント×1 Watcher鍵で一意（同一Watcherは dedup、別Watcherは追加票） |
| **idx_watcher_observation_event**      | (source, external_ref)   | イベント単位の観測一覧（クォーラム集計）        |
| **idx_watcher_observation_key**        | (watcher_key_id)         | Watcher別の観測一覧（鍵失効時の影響調査）      |

### FinalityAnchor / FinalityCosign
| Index                  | Columns                  | Backed query                                  |
|--------------------------|--------------------------|------------------------------------------------|
| **idx_finality_anchor_seq**       | (anchor_seq) UNIQUE | アンカーの連番引き                              |
| **idx_finality_anchor_watermark** | (high_watermark_seq)| ウォーターマークによるアンカー検索              |
| **idx_finality_cosign_chain_participant_entry** | (chain_id, participant_id, entry_hash) UNIQUE | 副署の冪等チェック |
| **idx_finality_cosign_participant** | (participant_id)  | 参加行別の副署一覧                              |

### Legacy Adapter（対外接続系）
| Index                  | Columns              | Backed query                                       |
|--------------------------|----------------------|----------------------------------------------------|
| **idx_outbox_pending**  | (bank_id, status)    | 未適用（PENDING）postingのドレイン走査（drainOutbox） |
| **idx_outbox_claimed**  | (status, claimed_at) | CLAIMED のまま放置された行の失効回収（recoverStaleClaims） |
| **idx_notify_unread**   | (bank_id, status)    | 未読（UNREAD）通知のプル取得（pullNotifications）      |

その他の表（Vault、Bank: BankAccounts, BankJournals, …）
は定義済みの既存インデックスで賄える。

---

## Legacy Adapter テーブル（対外接続系）

現実の勘定系に見られる制約（バッチ窓・非冪等・予約プリミティブ無し・
ミッドバッチ照会不可・タイムアウト・push口無し）を意図的に再現した
敵対的コアモデルを前提とする。この前提の上で、ZC からはクリーンな
24/365・冪等・リアルタイムな面に見せるためのアダプタ層である。設計とテストは
[`30_internal_design.md`](30_internal_design.md)（レガシー勘定系アダプタ 内部設計）、実装は `src/bank/legacy/`、
適合性検証テストは `test/bank/legacy/adversarial.test.ts`。

| テーブル | 役割 | 対応する提案 |
|---|---|---|
| **LegacyProfiles** | 参加者ごとの能力プロファイル（role / reservation_mode / settlement_mode / notify_mode / window 等）。異機種を分岐ではなく設定で飲む。 | #1 |
| **LegacyCoreAccounts** | 敵対的コアモデルの権威残高（balance と customer_name のみ。予約カラム無し。複式簿記ではない — 現実のコアは通常内部で複式簿記を保つため、この単純化は既知の割り切り）。customer_name は name-check(7)/account-verify(8) の裏付け。 | — |
| **LegacyCoreJournal** | コアが実際に適用した posting の追記ログ。`txid` を持ち監査追跡可能（`request_id` はアダプタ内部の相関idに過ぎない）。二重適用の検知に使う。 | — |
| **AdapterShadow** | 利用可能残高ミラー（available / reserved）。コアに触れず承認。reserved はコアが持てない予約を吸収。 | #2 |
| **AdapterOutbox** | store-and-forward。shadow で承認済みだがコア未適用の posting。`txid` を保持。status は `PENDING → CLAIMED → APPLIED`（または `BLOCKED`）の3〜4状態遷移で、claim-then-apply により同時 drain 呼出し下でも二重適用しない。 | #2 / #4 / #6 |
| **AdapterNotifications** | プル型通知ストア。コアに push 口を要求しない。 | #5 |
| **AdapterReconDrift** | 三者照合（core vs shadow vs outbox）のドリフト記録。`case_id` で実際の `Cases` 行に紐づき、status=OPEN は本物の CASE として運用監視される。 | #3 |

以下は該当7テーブルの確定形DDL（`migrations/0001_consolidated_schema.sql` からの転記）。
索引（`idx_outbox_pending` / `idx_outbox_claimed` / `idx_notify_unread`）は上記 Index Catalog にも記載済み。

```sql
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

CREATE TABLE LegacyCoreAccounts (
  bank_id       TEXT    NOT NULL,
  account_id    TEXT    NOT NULL,
  balance       INTEGER NOT NULL DEFAULT 0,
  customer_name TEXT,
  PRIMARY KEY (bank_id, account_id)
);

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

CREATE TABLE AdapterShadow (
  bank_id    TEXT    NOT NULL,
  account_id TEXT    NOT NULL,
  available  INTEGER NOT NULL DEFAULT 0,
  reserved   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bank_id, account_id)
);

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
CREATE INDEX idx_outbox_claimed ON AdapterOutbox (status, claimed_at);

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
```

冪等性は専用テーブルを持たず、既存の `IdempotencyKeys`（`src/shared/idempotency.ts`
の `resolveIdempotency`/`completeIdempotency`）を再利用する。request_id 単位で
INSERT を先に行う atomic-claim 方式のため、read-then-write の競合窓が無い。

照合不変条件（`reconcile.ts` が全口座で検査）:

```
core.balance == shadow.available + shadow.reserved
                 + Σ(pending DEBIT) − Σ(pending CREDIT)
```

---

## Foreign Key 戦略

参照整合性は **実際に強制・検証している**。テスト D1（`test/helpers/d1-mock.ts`）
は `PRAGMA foreign_keys = ON` で起動する。`db.batch()` 内ではさらに
`PRAGMA defer_foreign_keys = ON`（COMMIT 時に一括検査）を設定し、子行が同一
バッチ内で親と一緒にコミットされる lane プリミティブの合成に対応する。
単発文は文ごとの即時検査となる。FK を本番相当に強制したうえで全テスト
（全テストスイート）が通ることを CI ゲートとする。

### 宣言している FK（構造的な所有関係）

| 子 | 列 | 親 | 備考 |
|---|---|---|---|
| `HtlcContracts` | `txid` | `Transactions(txid)` | `insertTxWithLog` で親と同一バッチ生成 |
| `GtidLegs` | `gtid` | `GtidTransactions(gtid)` | |
| `GtidLegs` | `txid` | `Transactions(txid)` | Decision 後にバッチで backref |
| `FxLegLocks` | `gtid` | `FxTransfers(gtid)` | |
| `HtlcAuthRequests` | `whitelist_id` | `HtlcAuthWhitelist(whitelist_id)` | |
| `DnsNetPositions` | `cycle_id` | `DnsCycles(cycle_id)` | |
| `Attestation` | `template_id` | `ConditionTemplate(template_id)` | |
| `Mandate` | `parent_mandate_id` | `Mandate(mandate_id)` | 自己参照（委任チェーン） |
| `DebitMandate` | `mandate_id` | `Mandate(mandate_id)` | 継続収納契約の署名根拠 |
| `MandateBudget` | `dd_mandate_id` | `DebitMandate(dd_mandate_id)` | 枠は契約に従属する |
| `ScheduledCollection` | `dd_mandate_id` | `DebitMandate(dd_mandate_id)` | 予告は契約に従属する |
| `ScheduledCollection` | `extra_mandate_id` | `Mandate(mandate_id)` | 単発認可（追加認可）。NULL 可 |
| `CollectionAttempt` | `collection_id` | `ScheduledCollection(collection_id)` | 試行は予告に従属する |

### 意図的に FK を貼らない列（理由つき）

1. **監査・追記専用ログ**（`FinalityLog`, `TxEventLog`, `BankAuditLog`,
   `EntityStateLog`）。`FinalityLog.txid_or_gtid` は **ポリモーフィック**
   （txid または gtid を取る）であり単一の親に FK できない。また親が論理的に
   消えても履歴は残す必要がある。
2. **`HReservations.txid`**。H は **確定的に予測した txid に対して、その
   `Transactions` 行が生成される前に予約される**（GTID/FX:
   `src/zc/lanes/gtid/advance.ts` で `reserveH` が `insertTxWithLog` に先行）。
   したがってこの列は前方参照であり、満たせる FK ではない。FK 強制によって
   この不変条件の不成立が観測されたため、明示的に非 FK とする。
3. **`bank_id` 系の論理識別子**（`Transactions.payer_bank_id` 等）。参加者
   マスタへの参照だが、運用上の論理キーとして扱い、行ライフサイクルの所有関係
   ではないため FK 化しない。
4. **`ScheduledCollection.txid`**。予告は `Transactions` を*所有しない*——予告
   が先に存在し、振替日に発火したものだけが取引を生む。したがってこの列は
   「発火したかどうか」を表す後書きの参照であり、行ライフサイクルの所有関係
   ではない。`HtlcAuthRequests.txid`（承認後に書かれる）と同じ扱いとする。

ON DELETE 句は付けていない（既定 = `NO ACTION`）。本システムは行を物理削除
しない（状態機械＋追記ログ）ため、削除カスケードは不要であり、誤った削除は
制約違反として fail-closed させる方が安全である。
