# 内部設計書（Internal / Detailed Design）

> **本書の役割**: 本書は内部設計書。実装規約・不変条件・I/F契約・メッセージ定義・
> アルゴリズム詳細を定める。要件は `10_requirements.md`、処理方式は
> `20_method_design.md`、テーブル定義は別紙 `31_schema.md`、API契約は別紙
> `32_api_contracts.md` を参照。

このドキュメントは、Zenith Mock の **横断的な実装規約**（エラー、ロギング、
レーン共通基盤、単一所有者則）、**一貫性モデルと保管バックエンドの移植契約**、
そしてコード品質を引き上げるための**ロードマップ**を記録する。
ビジネス要件は `10_requirements.md`、処理方式は `20_method_design.md`、API 個別仕様は
`32_api_contracts.md`、DB は `31_schema.md` を参照。クロスカレンシー FX の内部設計は
本書 第17章、レガシー勘定系アダプタの内部設計は本書 第18章 を参照。

> **読み方**:「なぜこの設計にしたか」と「次に何を直すか」を集約した内部
> 文書。具体的な API ペイロードや SQL は他ドキュメントが正。

## 目次（Table of Contents）

| 章 | タイトル | 内容 |
|---|---|---|
| [第1章](#s1-layers) | システム階層 | Worker entry → レーン → orchestrator → FinalityLog の全体像 |
| [第2章](#s2-errors) | 構造化エラー | `DomainError` / `reason_code` / category とリトライ方針 |
| [第3章](#observability) | 構造化ロギング | 1 リクエスト 1 コンテキスト・イベント命名規約 |
| [第4章](#s4-primitives) | レーン共通プリミティブ | `_helpers.ts` の **4 プリミティブ**と不変条件 |
| [第5章](#single-owner) | 単一所有者則（Single-Owner Rule） | `owner` 列・4 つの handoff・`transferOwnership`・段階導入 |
| [第6章](#consistency-model) | 一貫性モデル（Consistency Model） | 何が正か・保証する一貫性・縮退（原則10） |
| [第7章](#portability) | 可搬性と保管バックエンド移植契約（Portability） | 方言差し替え表・event_seq・受入条件・S3 回答 |
| [第8章](#s8-database) | データベース改善 | 統合スキーマ運用・FK 戦略 |
| [第9章](#s9-testing) | テスト戦略 | runtime / 静的インバリアント / 残高統合テスト |
| [第10章](#s10-roadmap) | 既知の制約・将来項目（Roadmap） | 規範↔実装ギャップと残件 |
| [第11章](#s11-programmability) | プログラマビリティ | 外部アテスター前提の条件付き決済 |
| [第12章](#appendix-a-if) | I/F契約・データ辞書 | cmd/event一覧・共通ヘッダ・データ辞書・冪等キーのスコープ・seq の粒度・署名対象と正規化・パラメータ統制と PR-* 台帳 |
| [第13章](#appendix-e-messages) | 主要メッセージのボディ定義 | 実装テンプレ（PaymentInitiated 他） |
| [第14章](#appendix-f-lsm) | LSM（流動性節約）詳細 | Bulk向け目的関数・フォールバック |
| [第15章](#appendix-g-htlc) | HTLC（hashlock+timelock）詳細 | 状態遷移・条件合成・クロスチェーン確定 |
| [第16章](#appendix-h-raft) | Raft運用（合意ログ）詳細 | シャード・スナップショット・メンバーシップ変更 |
| [第17章](#fx-internal) | クロスカレンシーFX 内部設計 | スキーマ・API・既存コードへの接地・将来課題 |
| [第18章](#adapter-internal) | レガシー勘定系アダプタ 内部設計 | 冪等性・適合性検証・監査是正 |

---

## 第1章 システム階層 <a id="s1-layers"></a>

```
                ┌─────────────────────────────────────────┐
                │  src/index.ts  (Worker entry / router)  │  ← X-Request-Id 採番
                └───────────┬─────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────────┐
        ▼                   ▼                       ▼
   /api/* (ZC)         /bank/* (Bank)         /internal/*
    ZC Ingress      ZC→Bank Ingress         Cron / Seed
        │                   │
        ▼                   │
   src/zc/lanes/*           │            ┌──────────────────────┐
   (state machines)         │     ◀──── │ src/shared/errors.ts │ DomainError, errorResponse
        │                   │            └──────────────────────┘
        ▼                   │            ┌──────────────────────┐
   src/zc/orchestrator      │     ◀──── │ src/shared/logger.ts │ newRequestLogger
   (queue consumer +        │            └──────────────────────┘
    state transitions)      │            ┌──────────────────────┐
        │                   │     ◀──── │ src/zc/lanes/        │ 4 primitives:
        ▼                   │            │   _helpers.ts        │ transition/cancel/
                            │            │                      │ insert/transferOwner
   FinalityLog              ▼            └──────────────────────┘
   (append-only)        Bank ledger
                       (zero-sum journal)
```

横断モジュール（右側）は **どのレーン・どの ingress からでも安全に呼べる**
副作用最小のプリミティブとして設計されている。新規エンドポイントや新規
レーンを追加する場合、まずここから組み立てる。

---

## 第2章 構造化エラー — `src/shared/errors.ts` <a id="s2-errors"></a>

### 設計意図
- かつてはレーン・ingress に「`console.error()` してから silent return」
  というアンチパターンが散在していた。これは**プロセス境界で失敗を観測
  できない** という致命的な問題を生む。
- `DomainError` を持ち上げて統一することで、HTTP / Queue / FinalityLog
  すべてで**同じ識別子（`reason_code`）と分類（`category`）**を使える。

### コア API
```ts
new DomainError(reason_code, message, details?, { category?, cause? })

errorResponse(err, request_id?)  // → Response (HTTP)
isDomainError(e)                 // 型ガード
isRetryable(category)            // Queue の retry 判定
httpStatusOf(category)           // HTTP マッピングの SoT
```

### カテゴリの拡張ルール
1. 新しい `reason_code` は `REASON_CODE_CATEGORY` に登録する。登録忘れの影響は
   **経路によって異なる**ので、区別して理解すること。
   - **`throw new DomainError(code, …)`** ：未登録だと `categoryOf()` が
     `INTERNAL`（500・retry 不可）へ落ちる。HTTP ステータスの手がかりが無いため
     fail-soft が効かない。**登録は必須**。
   - **`jsonError(status, code, …)`** ：未登録でも `categoryFromStatus(status)` が
     HTTP ステータスから category を導出するため安全側に落ちる
     （`src/zc/ingress/_shared.ts`）。登録は推奨だが必須ではない。
   - この非対称性は `32_api_contracts.md` § エラーカタログ の
     「`DomainError` を経由しない reason_code」節に規範として明記してある。
2. `category` を増やす場合は `httpStatusOf` と `isRetryable` の両方を
   更新する。`32_api_contracts.md` § Error Catalog の表も同じ PR で更新する。
   **この 2 つの一致は `test/invariants/spec_refs.test.ts` が機械照合する**
   ——片方だけ更新した PR は CI で落ちる。
3. 業務ルール由来（H_LIMIT_EXCEEDED 等）は `CONFLICT`、外部系障害は
   `DOWNSTREAM` または `TIMEOUT` を選ぶ。**「リトライしていい失敗かどうか」
   が分類の本質**。

### Queue リトライポリシー
`src/index.ts#queue` は `DomainError` の `category` を見て:
- `DOWNSTREAM` / `TIMEOUT` / `RATE_LIMIT` → `msg.retry()`
- それ以外（`VALIDATION` / `CONFLICT` / `INVARIANT` / `INTERNAL`）→ `msg.ack()`

ack 側は無限ループせず、Cases テーブルにエスカレーションされる。
DomainError 以外の throw は従来通り全て retry する（互換性のため）。

---

## 第3章 構造化ロギング — `src/shared/logger.ts` <a id="observability"></a>

### 1 リクエスト 1 コンテキスト
```ts
const log = newRequestLogger({ method: 'POST', path: '/api/transfers' })
const child = log.child({ txid, lane: 'EXPRESS' })
child.info('lane.dispatch')
```

- 出力は **1 行 1 JSON**。Cloudflare の Logpush / `wrangler tail` がそのまま
  パースできる。
- 自動付与フィールド: `ts`, `level`, `event`, `request_id`。
- `request_id`：受信ヘッダ `X-Request-Id` を honor し、無ければ `req-<uuid>`。
  全レスポンスにも `X-Request-Id` を返す → エラー報告→ログ突合が自明。
- PII セーフ: `vault_ref`, `preimage`, `secret`, `password`, `_pii` 末尾な
  キーは自動 `[REDACTED]`。
- `Error` インスタンスは `name` / `message` / `reason_code` / `details` の
  4 フィールドに圧縮して出力。

### イベント命名規約
`<scope>.<verb>` 形式。

| Scope             | 例                                                 |
|-------------------|----------------------------------------------------|
| `http.*`          | `http.request`, `http.not_found`, `http.unhandled_error`, `http.domain_error` |
| `queue.*`         | `queue.dispatch`, `queue.ack`, `queue.failed`      |
| `lane.*`          | `lane.dispatch`, `lane.transition`, `lane.cancel`  |
| `bank.*`          | `bank.call`, `bank.timeout`, `bank.error`          |
| `dns.*`, `eod.*`  | cron 系                                            |

新スコープ追加時は本表も更新する。

---

## 第4章 レーン共通プリミティブ — `src/zc/lanes/_helpers.ts` <a id="s4-primitives"></a>

### 動機
全 8 レーン（express, standard, htlc, gtid, rtp, highvalue, bulk, htlc_auth）
は **同じ 2 パターン**を独自実装していた:
1. `Transactions` の状態遷移（CAS UPDATE。CAS＝Compare-And-Swap の略で、
   「読んだ時点の値と一致している場合だけ書き込む」楽観ロック更新のこと）
   → `FinalityLog` 書き込み。この2つは原則ペアであるべきだが、別々の SQL
   として発行すると片方だけ成功する余地が生まれ、アトミック（不可分）ではない。
2. 取消時に「状態ガード → H 解放 → ログ → 終了状態化」という順序で進める。
   これは TOCTOU（Time-Of-Check to Time-Of-Use、確認した時点と実際に使う
   時点のズレを突く事故）を避けるための安全な順序である。

これらが各ファイルにコピペされており、片方を直し忘れる事故が発生して
いた（`GtidLegs(txid)` インデックス漏れ — 現在は `idx_legs_txid` として
統合スキーマに収録 — や、`htlc.ts` cancelHtlc の TOCTOU 事故が再発した）。

### 提供 API

`_helpers.ts` は **4 つのプリミティブ**を提供する（3 つの mutate/create
＋ 1 つの所有権移転）。3 番目までが Transactions 行を「進める／作る」プリミティブ、
4 番目 `transferOwnership` は「状態を変えずに所有権だけ動かす」プリミティブで、
[§5 単一所有者則](#single-owner) の choke point になる。

```ts
transitionWithLog(db, {
  txid, fromState, toState, eventType,
  payload?, setColumns?, sideUpdates?, strict?,
  issuer?,   // 単一所有者則: 既定 'ZC'。行の現 owner と一致しないと OWNERSHIP_VIOLATION（無条件）
}): Promise<{ applied: boolean; previousState: string | null }>

cancelInFlightTx(db, {
  txid, reasonCode, fromStates?, skipReleaseH?, sideUpdates?, eventType?, payloadExtra?,
  issuer?,   // 単一所有者則: 既定 'ZC'。取消も owner だけが発行できる。取消 CAS は owner を 'ZC' に返す
}): Promise<boolean>

insertTxWithLog(db, {
  txid, lane, initialState, amount, payer*, payee*,
  idempotencyKey, eventType, payload?, extraColumns?, sideUpdates?,
}): Promise<{ inserted: boolean }>   // 新規行は owner='ZC'（列 DEFAULT）で生まれる

transferOwnership(db, {
  txid, fromOwner, toOwner, eventType?, payload?, setColumns?,
}): Promise<{ applied: boolean; previousOwner: string | null }>
  // owner の CAS ＋ FinalityLog(OwnershipTransferred / OwnershipReclaimed) を単一バッチで発行。
  // transitionWithLog の鏡像。state は動かさず custody だけ動かす。
```

> `transitionWithLog` から `skipStateMachineCheck` は撤去済み。状態機械検証は
> **無条件**であり、バイパスするパラメータは存在しない（実装 §状態機械検証を参照）。

### 不変条件（実装で担保）
- **アトミック CAS + ログ**: `transitionWithLog` は CAS UPDATE と
  `FinalityLog` INSERT を 1 つの `db.batch()` で発行する。INSERT は直前
  UPDATE の `changes() > 0` をガードに用いる条件付き INSERT のため、CAS
  に勝てなかった呼び出しはログも書き込まれない。バッチ内で例外が起きれば
  両方ロールバック。これにより「状態だけ進んで監査ログが残らない」窓は
  存在しない。`transferOwnership` も同じアトミシティ契約（owner CAS ＋ 条件付き
  FinalityLog INSERT を単一バッチ）で所有権 handoff を記録する。
- **単一所有者則（OWNERSHIP_VIOLATION）**: `transitionWithLog` と
  `cancelInFlightTx` は CAS 前に `SELECT state, version, owner` を読み、
  **`issuer !== owner` なら無条件で `OWNERSHIP_VIOLATION` を投げる**。
  `strict:false` でも降格されない——`INVARIANT_VIOLATION` と同格の「バグ」扱い
  （行を所有しない発行者の操作は、owner 列が構造的に潰そうとしている二元帳乖離
  そのもの）。さらに CAS UPDATE の `WHERE` 句に `AND owner = ?` を加え、
  **コミット時に owner を再表明**する。DNS バルクスナップショット（kickDns）は
  意図的に `version` を上げないため、SELECT と UPDATE の間に割り込んだ handoff を
  version ガードだけでは検知できないからである。詳細と 4 つの handoff は
  [§5 単一所有者則](#single-owner)。
- **状態機械検証**: `isValidTransition` を CAS UPDATE 前に常に呼ぶ。
  `ALLOWED_TRANSITIONS` に無い遷移は DB に到達せず、`INVARIANT_VIOLATION`
  を投げる（または `applied:false` を返す）。この検証は**無条件でバイパス不可**——
  将来レーンを足しても、未登録の遷移がこっそり通ることはない。
- **CAS 並列安全**: `version = ?` 楽観ロック。並列 N 本でも `applied:true`
  は最大 1 本（テスト: `lane_helpers.test.ts`、`atomic_finality.test.ts`）。
- **取消順序**: `cancelInFlightTx` は **状態ガード成立後にのみ** H 解放を
  行う。逆順だと並列 decision 経路に勝った場合に LOCKED 予約を誤って解放
  してしまう（ZC で発生済みのバグと同型）。`DecidedCancel` ログも同じ
  `db.batch()` でアトミックに書き込む。取消された行は終端であり、CAS は
  `owner='ZC'` へ返す（custody をコーディネータに戻す）。
- **read-only 縮退ゲート**: 4 プリミティブすべて（および `suspendTx`）は確定前に
  `assertWritableDb` を通る。quorum 喪失・BCP 中は書き込みを拒否する
  （[§6 一貫性モデル](#consistency-model)）。owner CAS と同じ choke point。
- **event_seq 単調性**: `writeFinalityLog` は `FinalitySeq.next_seq` を
  `UPDATE ... RETURNING` でアトミック増分し event_seq を割り当てる
  （`src/zc/orchestrator/finality.ts#allocateEventSeq`）。Date.now() + 乱数
  + UNIQUE リトライ方式は廃止。単一ノード D1 ではこの 1 行採番がコミット順の
  全順序を与える。分散 SQL への移植時に大域単調性をどう保つかは
  [§7.2 event_seq 採番](#portability)。

### GTID 状態機械（`gtid_state_machine.ts`）

`TxState` に `ALLOWED_TRANSITIONS`（`state_machine.ts`）があるのと対称に、
GTID 集約レベルの状態（`GtidState`: `GT_RECEIVED → GT_PRECHECKED →
GT_DECIDED_TO_SETTLE → GT_SETTLED` ほか）にも単一の正となる遷移表
`ALLOWED_GTID_TRANSITIONS` を `src/zc/orchestrator/gtid_state_machine.ts`
に置く。導入前は GTID の合法遷移グラフが `lanes/gtid/` と
`orchestrator/gtid.ts` の生 `UPDATE GtidTransactions ... WHERE state='GT_X'`
の WHERE 句にのみ暗黙的に存在し、複数行アトミック決済（複数銀行に同時に
資金移動する集約）に、各 TX が持つ検証付き遷移表が無い状態だった。

- **宣言**: `ALLOWED_GTID_TRANSITIONS`（全 `GtidState` を網羅）と、INSERT 入口
  state の `ALLOWED_GTID_ENTRY_STATES`（`GT_RECEIVED`=通常登録 /
  `GT_SETTLED`=`settleDns` が直接生成する DNS ネット清算 GTID）。規範参照は
  `20_method_design.md` §3.5（第3章 取引ライフサイクルと状態遷移）。
- **実行時ガード（多重防御）**: 遷移元が DB 由来（リテラルでない）の
  終端化経路で `assertValidGtidTransition(from, to)` を CAS 前に呼ぶ
  （`checkAndFinalizeGtid` の `GT_SUSPENDED` / `GT_SETTLED`、`advanceGtid`
  の `GT_PRECHECKED`）。不正遷移は `INVARIANT_VIOLATION`。
- **静的ガード**: `test/zc/gtid_state_machine.test.ts` が GTID ソースを走査し、
  すべての `UPDATE GtidTransactions SET state='GT_Y' ... WHERE ... state='GT_X'`
  と `INSERT ... VALUES (?, 'GT_X')` を抽出して宣言グラフに含まれるか検証する。
  生 SQL で未宣言の遷移（例: `GT_RECEIVED → GT_SETTLED`、決定の飛ばし）を
  追加すると落ちる。`TxState` を `lane_invariants` が守るのと同じ役割。

### 新規 lane 追加時のチェックリスト

CI で `test/zc/lane_invariants.test.ts` が以下を静的にチェックする
（regex によるソース走査）。チェックリストはそのまま自動 enforce される。

1. 既存状態を進めるなら **`transitionWithLog`**。CAS が他レーン側状態と
   並走するなら `sideUpdates` で同一バッチに入れる（HtlcContracts が参照実装）。
2. キャンセル経路は **`cancelInFlightTx`** を使う。`sideUpdates` で別表の
   キャンセル CAS も同時にロールバック可能にする（HtlcContracts の cancel が参照実装）。
3. 新規行をレーン特有の入口 state で作る場合は **`insertTxWithLog`** を使い、
   必要であれば `ALLOWED_ENTRY_STATES` に入口 state を追加する。FinalityLog は
   INSERT と同じバッチで書かれるので「行はあるが audit が無い」窓は構造的に閉じる。
   `purpose` のような一回限りのカラムは `extraColumns` で渡す。
4. 新規イベント名は `src/types/api/messaging.ts#FinalityEventType` の union に追加する
   （未登録のイベント名は lane_invariants が落ちる）。
5. `test/zc/<lane>.test.ts` に lane 単体テストを足し、
   `test/integration/balance_invariants.test.ts` に 1 ケース追加する。
6. 新規 lane file は `test/zc/lane_invariants.test.ts#LANE_FILES` に登録する
   （ファイル名 → 論理 lane 名 + Transactions.lane カラム値）。

### `lane_invariants.test.ts` が落ちたとき

| エラー | 直し方 |
|---|---|
| `UPDATE Transactions SET state` が検出された | `transitionWithLog` か `cancelInFlightTx` に置き換える |
| `INSERT INTO Transactions` が検出された | `insertTxWithLog` に置き換える。フィールドが足りなければ `extraColumns` を使う |
| lane file に `_helpers` の import が無い | 上記いずれかの helper を呼ぶ実装に直す |
| `LANE_FILES` と src ディレクトリが乖離 | テスト側の `LANE_FILES` 表を実態に合わせて更新 |
| lane の unit test が無い | `test/zc/<stem>*.test.ts` を作る |
| balance-invariant ケースが無い | `test/integration/balance_invariants.test.ts` に 1 ケース足す（または KNOWN_GAPS に登録） |
| event 名が `FinalityEventType` 未登録 | `src/types/api/messaging.ts` の union に追加 |

---

## 第5章 単一所有者則（Single-Owner Rule） <a id="single-owner"></a>

> **本節の位置づけ**: 本章は「なぜ owner 列を一級化したか」と「4 つの handoff がどこで起きるか」を集約する。
> 二元帳アトミシティと、タイムアウト掃引の正しさは、いずれもここに帰着する。
> 実装の入口は [`src/zc/lanes/_helpers.ts`](../src/zc/lanes/_helpers.ts) の 4 プリミティブ
> （[§4](#s4-primitives)）。

### 5.1 owner モデル — 「動かせる者は常にちょうど一人」

これまで「掃引の対象から除外する条件」（`dns_cycle_id IS NULL`、
`external_settlement_status != 'REQUESTED'`、レーン除外…）が増え続けていた。
その正体を突き詰めると、**所有権の記録が複数の列にばらばらに散らばっていた**
だけだったとわかる。そこで所有権を一つの列に昇格させ、一元管理する:

- 各 `Transactions` 行はちょうど一つの `owner` を持つ。値は
  **`'ZC'` | `'CYCLE:<cycle_id>'` | `'VENUE:<venue_id>'` | `'CHAIN:<watcher_set>'`**。
  定数は `_helpers.ts` の `OWNER_ZC='ZC'` / `OWNER_VENUE_BOJ='VENUE:BOJ'` /
  `OWNER_CHAIN_DEFAULT='CHAIN:default'` / `cycleOwner(id)='CYCLE:<id>'`。
- スキーマは `Transactions.owner TEXT NOT NULL DEFAULT 'ZC'`、索引 `idx_tx_owner(owner, state)`
  （`migrations/0001_consolidated_schema.sql`）。新規行は `insertTxWithLog` により
  DEFAULT の `'ZC'` で生まれる。
- **掃引は `owner='ZC'` の行しか触らない**。`src/cron/timeout_sweep.ts` の T2/T3 クエリは
  `WHERE state=? AND owner='ZC' AND updated_at<?`。
  - 補足（誇張しない）: T2 掃引には今も `T2_EXEMPT_LANES` によるレーン除外が残るが、
    これは custody ではなく **SLA（そのレーンに T2 タイムアウトが無い）** という
    タイムアウト方針であり、owner が置換したのは custody 述語だけである
    （`timeout_sweep.ts` の該当コメント参照）。

これにより、二元帳乖離の典型パターン（`src/cron/timeout_sweep.ts` のコメントに二元帳乖離
カタログとして記録されている）は**例外規則から定理**になる:

1. **BOJ 遅延決済 vs T3 放棄**: money leg が外部決済 venue に in-flight の間は
   `owner='VENUE:BOJ'`（`external_settlement_status='REQUESTED'` と原子的に押される）。
   T3 掃引からは**構造的に不可視**——中央銀行が確定するまで T3 は放棄できない。
2. **DNS スナップショット vs 個別掃引**: kickDns がスナップショットした瞬間
   `owner='CYCLE:<id>'` になるため、個別掃引は**構造的に不可能**。

### 5.2 4 つの handoff（所有権の受け渡し）

所有権が動く瞬間は実測で **4 群**だけ。いずれも FinalityLog 上のイベントとして記録され、
「いま誰がこの取引を握っているか」も説明可能性の一部になる（原則4 の自然な拡張）。

| # | handoff | コード site | owner の動き |
|---|---|---|---|
| 1 | DNS kick（ネットポジション取り込み） | [`src/zc/settlement/dns/cycle.ts`](../src/zc/settlement/dns/cycle.ts)（kickDns スナップショット） | `dns_cycle_id` を押す同一バッチで `'ZC' → 'CYCLE:<id>'`（`cycleOwner`） |
| 2 | DNS settle / サイクル取消 | [`src/zc/settlement/dns/settle.ts`](../src/zc/settlement/dns/settle.ts) | 決済・取消の確定バッチで `'CYCLE:<id>' → 'ZC'` に返還 |
| 3 | IGS submit / callback | [`src/zc/settlement/igs.ts`](../src/zc/settlement/igs.ts) | 提出時 `transferOwnership('ZC'→'VENUE:BOJ')`（`external_settlement_status='REQUESTED'` と同時）、確定コールバックで `'VENUE:BOJ'→'ZC'` に返還（IGS_FAILED は `issuer='VENUE:BOJ'` の suspend で `owner='ZC'` へ）|
| 4 | HTLC crosschain enter / exit ＋ 外側タイムロック lease 回収 | [`src/zc/lanes/htlc/crosschain.ts`](../src/zc/lanes/htlc/crosschain.ts)・[`_fulfill.ts`](../src/zc/lanes/htlc/_fulfill.ts)・[`src/cron/timeout_sweep.ts`](../src/cron/timeout_sweep.ts) | `HTLC_ONCHAIN_PENDING` 突入で `transitionWithLog(setColumns owner='CHAIN:default')`、Watcher 由来の解放は `issuer='CHAIN:default'` ＋ `setColumns owner='ZC'`（`_fulfill.ts`）|

- handoff #1・#2 の DNS バルク UPDATE は `transferOwnership` を経由しない**唯一の
  例外**（複数行を 1 文で押すため）。この 2 site だけが `owner` を直書きしてよい
  ホワイトリストで、`test/invariants/ownership.test.ts` の静的ガードが他の直書きを禁じる。
- handoff #3・#4 のような単一行の handoff は `transferOwnership` を使う。
- **外側タイムロック lease 回収（期限切れ→回収）**: `HTLC_ONCHAIN_PENDING`
  行は Watcher 集合（`'CHAIN:default'`）が所有し、外側タイムロックはその**リースの契約上の
  満了**である——ZC が watcher の応答を待たずに行を取り戻してよい唯一の瞬間。満了時は
  まず `transferOwnership(..., eventType:'OwnershipReclaimed')` で所有権を ZC に戻し、
  **その後**に ZC 自身として cancel する。watcher 由来の claim がレースに勝っていれば
  reclaim の CAS が外れ、cancel の状態ガードが no-op になる——claim が行を保持する。
  この経路は `crosschain.ts#recordOnchainFulfillment`（内側と外側の分岐）と
  `timeout_sweep.ts`（期限切れ HTLC 掃引）の双方にある。

### 5.3 `transferOwnership` と owner の CAS 再表明

`transferOwnership` は `transitionWithLog` の鏡像で、**state を動かさず owner だけ**を CAS で
動かし、`FinalityLog(OwnershipTransferred)` を単一バッチで書く（state_from = state_to =
現 state）。lease 満了回収は `eventType:'OwnershipReclaimed'`。

決定的なのは **CAS によるコミット時の owner 再表明**である。`transitionWithLog` /
`cancelInFlightTx` / `suspendTx` は CAS UPDATE の `WHERE` 句に `AND owner = ?`（発行者）を
含める。理由: **DNS バルクスナップショット（kickDns）は意図的に `version` を上げない**ため、
`SELECT` と `UPDATE` の間に割り込んだ handoff を version 楽観ロックだけでは検知できない。
owner を WHERE で照合することで、SELECT 後にスナップショットされた行への ZC の書き込みは
CAS が外れて no-op になる。

`suspendTx` だけは扱いが異なる: `owner !== 'ZC'` のとき **throw ではなく skip**（`console.error`
してリターン）。呼び手が cron/queue であり、正当な並行 handoff（例: 掃引の SELECT と本呼び出しの
間に kickDns がスナップショット）に行を奪われるのは**バグではなく良性のレース**だからである。
これに対し `transitionWithLog` / `cancelInFlightTx` の `OWNERSHIP_VIOLATION` は throw——
明示的な発行者が所有しない行を動かそうとするのはバグである。

### 5.4 段階導入（観測→移転→強制の三段：Phase 1/2/3）

決済システムの流儀に従い、いきなり強制せず**観測→移転→強制**の三段で入れる。

- **Phase 1 — スキーマ＋シャドーモード（挙動変更ゼロ）**: `owner` 列と索引を追加し、
  既存列から機械的にバックフィルする（＝所有権が既に暗黙に存在していたことの証明）。
  `transitionWithLog` の SELECT を `state, version, owner` に広げ、`issuer?`（既定 `'ZC'`）を
  受ける。不一致は**ブロックせず記録のみ**。ライブ移行時のバックフィル SQL:

  ```sql
  UPDATE Transactions SET owner =
    CASE
      WHEN dns_cycle_id IS NOT NULL                 THEN 'CYCLE:' || dns_cycle_id
      WHEN external_settlement_status = 'REQUESTED' THEN 'VENUE:BOJ'
      WHEN state = 'HTLC_ONCHAIN_PENDING'           THEN 'CHAIN:default'
      ELSE 'ZC'
    END;
  ```

  （本リポジトリの統合スキーマは新規適用のみのため、`owner` は `DEFAULT 'ZC'` で足りる。
  上の CASE は既存テーブルへのライブ移行時にのみ使う。）
- **Phase 2 — 所有権移転の一級化**: `transferOwnership` を `_helpers.ts` に追加し、
  [§5.2](#single-owner) の 4 handoff site を呼び替える。
- **Phase 3 — 強制と掃引の置換**: シャドーを強制へ——`issuer !== owner` は
  `OWNERSHIP_VIOLATION`（`INVARIANT_VIOLATION` と同格）。掃引の除外述語を撤去して
  `owner='ZC'` に統一。不変条件テスト 2 本——(a) 全 (state × owner) 組で「動かせる主体が
  ちょうど一つ」を総当たり固定、(b) `owner` の手書き UPDATE を静的禁止
  （`test/invariants/ownership.test.ts`）。

> **この参照実装は Phase 3 まで完了・強制有効で出荷している。** 加えて
> `timeout_sweep.ts` には「旧述語 vs 新 owner 列の一回限りの突き合わせ検証」
> （`owner='ZC'` なのに旧述語が「他者所有」と言う行を CASE 起票する一回限りの検証。
> *1 リリースで撤去*）が残っている——新旧の言い分が食い違う行こそ handoff バグの在り処。

### 5.5 スコープ外（将来）: リース＋フェンシングトークン

**所有者障害からの回収**（期限切れリース＋単調エポックのフェンシングトークン）は
**将来項目**。owner 列はその土台としてそのまま使えるが、フェンシングトークンは
**受け手（銀行側アダプタ・venue ゲートウェイ）が stale トークンを拒否して初めて
意味を持つ＝信頼境界を越える**ため、参加者の接続認定試験（certification suite）の
整備と同じタイミングに送る。受入条件「stale トークンの拒否」は
[`10_requirements.md` の要求仕様章](10_requirements.md#core-requirements)
に一行追加する。詳細は [§10 既知の制約](#s10-roadmap) にも Roadmap として連ねる。

### 5.6 一貫性モデルとの接続

owner の CAS は、read-only 縮退の `assertWritableDb` ゲートと**同じ choke point**である
（[§4](#s4-primitives) の不変条件、[§6 一貫性モデル](#consistency-model)）。したがって
「所有権を持たない書き込み」も「縮退中の書き込み」も、同一の狭い関門で構造的に閉じる。
ここで誠実に認めておくべき譲歩がある——**原則1 の再スコープ**である。FinalityLog が
唯一の正なのは*協調事実*についてであり、金銭事実の正は各元帳にある。ZC の主張は
「乖離しない」ではなく「すべての乖離は有界時間内に検出・帰責される」というものであり、
これは [§6.4](#consistency-model) と噛み合う。本節が単一所有者則の一次記述である。

---

## 第6章 一貫性モデル（Consistency Model） <a id="consistency-model"></a>

設計原則10「単一正本性は合意ログで担保し、不確定時は Read-only へ縮退する」を、
**何を・どこまで保証するか**として明文化する。実装の現状（D1 単一ノード）と、本番化時に
満たすべき規範の両方を、同じ語彙で区別して書く。

> 関連: 規範は `10_requirements.md` 設計原則10、`20_method_design.md` 第6章（整合性モデルとファイナリティ設計）、縮退の実装は
> [`../src/zc/platform/system_mode.ts`](../src/zc/platform/system_mode.ts) と
> [`../src/zc/platform/quorum.ts`](../src/zc/platform/quorum.ts)、移植契約は
> [§7 可搬性](#portability)、書き込みプリミティブは [§4](#s4-primitives)、
> 所有権の choke point は [§5 単一所有者則](#single-owner)。

### 6.1 何が「正」か

唯一の正本は **FinalityLog**（追記専用・チェーン単位ハッシュ連鎖）。`Transactions` などの
派生ビューは捨てて FinalityLog から再構築できる（原則1）。したがって一貫性の議論は
**「FinalityLog への追記がどの順序で・どの保証で確定するか」** に帰着する。

> なお、[§5.6](#single-owner) で述べた誠実な再スコープを踏まえると、原則1 が「唯一の正」と
> 言い切れるのは**協調事実**（決定・所有権移転・受領した署名付き証明）についてであり、
> **金銭事実の正は ZC が触れない各行の元帳にある**。ZC の一貫性保証はこの前提の上で読む。

### 6.2 保証する一貫性（規範）

| 対象 | 保証 | 根拠 |
| --- | --- | --- |
| 単一取引/チェーンの状態確定 | **線形化可能（linearizable）** | 状態遷移は CAS＋FinalityLog 追記を単一トランザクションで発行。確定は合意ログの linearization point で一意に順序づく |
| チェーン内のイベント順序 | **全順序（per-chain total order）** | `prev_hash` 連鎖＋ `event_seq` 単調。改ざんは後続全エントリを無効化 |
| 取引照会（trace / verify） | **read-your-writes / monotonic reads** | 確定済みエントリは同じ取引番号で誰が照会しても同じ説明を返す（原則の中核 UX） |
| 異なるチェーン間の順序 | **因果順序のみ**（大域全順序は要求しない） | チェーンは txid/gtid 単位で独立。大域整列が要るのはアンカー透かしのみ（[§7.2 event_seq](#event-seq) 参照） |

**linearization point**：合意ログが書き込みを quorum にコミットした瞬間。これより前に観測される
状態は存在しない（部分適用窓が無い＝CAS＋ログのアトミック契約、[§4](#s4-primitives)）。

### 6.3 不確定時の縮退（原則10）

合意ログが **quorum**（合意を成立させるために必要な最小限の過半数のレプリカ数）**を喪失**
した区間では、少数派パーティションで誤った確定（mis-decision）を書かないために、システム
全体を **read-only に縮退** する。これは場当たり的な例外処理ではなく、**制度化された状態遷移**
（`SystemMode: NORMAL → QUORUM_LOSS_READONLY`）として扱う（原則9）。

- 縮退の判定: `quorum.ts#reconcileQuorum`。メンバ集合（`ZC_QUORUM_REPLICAS`）に対する到達性を
  受け取り、厳密過半数 `floor(N/2)+1` を割ったら縮退、回復で自動復帰。
- 縮退の強制点: **書き込みプリミティブ**（`transitionWithLog` / `insertTxWithLog` /
  `cancelInFlightTx` / `transferOwnership` / `suspendTx`）が確定前に `assertWritableDb` を通る。
  CAS＋ログアトミシティ・owner 再表明と同じ choke point なので、**read-only 中に状態だけ進む窓は
  構造的に存在しない**。
- 失敗の意味論: 縮退中の確定要求は `SYSTEM_QUORUM_LOSS_READ_ONLY`（category `DOWNSTREAM` ＝
  retryable）。queue は ack（破棄）せず retry で in-flight を保持し、`NORMAL` 復帰後に再開する。
  同期 API には 502 系で返す（資金移動は受理されていない、という契約; 原則5）。
- 縮退中も許すもの: すべての**照会**（状態・残高・trace・verify）。読み取りは linearization point
  より前のコミット済み状態だけを返すため、誤決定を生まない。

> **本番での reconcileQuorum の給餌**: 実在の分散 SQL（特に Spanner）は
> レプリカのメンバシップを外に見せない。したがって本番は「レプリカ到達性の注入」ではなく
> **カナリア書き込みループ**（合成トランザクションの成功率＋レイテンシ＝「いま、コミット
> できるか」の直接計測）を quorum-report の給餌源にする。詳細は [§7.5](#s3-hidden)。
> 強制配線（`assertWritableDb` ゲート）はどちらの給餌でもそのまま機能する。

#### NORMAL ↔ 縮退の所有権

| モード | 所有者 | 解除条件 |
| --- | --- | --- |
| `QUORUM_LOSS_READONLY` | quorum 整合（自動） | quorum 回復で自動復帰のみ。運用者トグル不可 |
| `BCP_READONLY` | 運用者（宣言） | 運用者の `bcp-deactivate` |

両者は独立。quorum 回復は運用者宣言の `BCP_READONLY` を上書きせず、`bcp-deactivate` は
`QUORUM_LOSS_READONLY` を解除しない（`reconcileQuorum` と `deactivateBcpReadOnly` のガードで担保、
テスト: [`../test/zc/quorum.test.ts`](../test/zc/quorum.test.ts)）。

### 6.4 規範↔実装ギャップ（誠実に）

本参照実装は正本性を **D1（単一ノード SQLite）** で簡易に実現している。したがって:

- **充足（制御側）**: 原則10の *縮退半分* ——quorum 評価・自動縮退・read-only の強制配線・
  自動復帰・監査（GLOBAL チェーンへの `SystemQuorumLoss*` イベント）。観測された到達性を
  `quorum-report` で注入して end-to-end に動作・テスト可能。
- **未充足（保管側）**: 実体としての地理分散合意ログそのもの（第10章 Roadmap で追跡）。単一ノードには観測すべき
  multi-replica quorum が無い。本番では合意を内包した分散 SQL（Spanner / Aurora DSQL /
  CockroachDB / YugabyteDB）が正本を保管し、その **メンバシップ健全性を `reconcileQuorum` に
  供給** する（実務はカナリア書き込み、[§7.5](#s3-hidden)）。強制配線（書き込みプリミティブの
  `assertWritableDb` ゲート）はそのまま機能する。
  - **単一ノードの PostgreSQL は正本性・quorum 要件を単体では満たさない**ため、置くなら
    クラスタ/HA 構成が前提。
- 移植時に方言依存で書き換えが要る点（`changes()` ガード、`INSERT OR IGNORE`、単一行
  `UPDATE...RETURNING` 採番など）と受入条件は [§7 可搬性](#portability) に集約。
- **移植時に隠れている再設計が二つある**（in-doubt/retry 意味論、quorum 健全性の測り方）。
  これは縮退ロジックの再設計ではなく**移植タスク**だが、工数は小さくない。詳細は
  [§7.5](#s3-hidden) に明記した。

---

## 第7章 可搬性と保管バックエンド移植契約（Portability） <a id="portability"></a>

設計原則10は、単一正本性を**合意を内包した分散 SQL**で保管することを規範としている。本参照
実装は D1（単一ノード SQLite）で簡易に実現しているため、本番化にあたっては保管バックエンドを
差し替える必要がある。本章は、**「差し替え時に何を書き換え、何をもって完了とみなすか」**の
契約を一箇所に集約する。

> 関連: 一貫性の保証は [§6 一貫性モデル](#consistency-model)、縮退の実装は
> `src/zc/platform/{system_mode,quorum}.ts`、横断アーキ（実行環境の抽象化）は
> [§10 既知の制約](#s10-roadmap)。

### 7.1 縮退の制御側は移植不要

quorum 健全性の評価・自動縮退（`QUORUM_LOSS_READONLY`）・read-only の強制配線・自動復帰は
**保管バックエンドに依存しない**（実装: `quorum.ts` / `system_mode.ts`）。移植側がやることは
**「保管バックエンドのメンバシップ健全性を `reconcileQuorum(env, reachableIds)` に供給する」**
ことだけ。書き込みプリミティブの `assertWritableDb` ゲートはそのまま機能する。

供給経路は2つ:
- 既存の `/internal/system-mode/quorum-report`（外部ヘルスモニタが到達レプリカを POST）。
- 分散 SQL ドライバの cluster health API を cron で polling し `reconcileQuorum` を呼ぶ。

> ただし Spanner のようにメンバシップを外に見せないエンジンでは、上記「到達レプリカ」の
> 概念そのものが取れない。本番の**推奨配線はカナリア書き込み**（[§7.5](#s3-hidden)）——
> 4 候補すべてで同一配線が動く。

### 7.2 書き換えが必要な SQLite/D1 方言（保管側） <a id="event-seq"></a>

決済コアは方言依存を意図的に集約している。差し替え時に等価へ書き換える対象は以下。**いずれも
パイプライン上の少数の choke point に閉じている**ため、全 32k 行の散在修正にはならない。

| 方言イディオム | 使用箇所（代表） | 移植先の等価表現 |
| --- | --- | --- |
| `changes() > 0` ガード付き条件 INSERT（CAS 成否でログ INSERT を発火） | `orchestrator/finality.ts#buildFinalityLogConditionalInsert`、`lanes/_helpers.ts` | 直列化トランザクション内で `UPDATE ... RETURNING` の戻り有無でアプリ分岐、または `INSERT ... SELECT ... WHERE EXISTS(更新後行)` 単文 |
| `db.batch()` の暗黙トランザクション | `_helpers.ts`（CAS＋ログ＋sideUpdates）、`bank/ledger.ts#insertJournalGroup` | 明示的 `BEGIN ... COMMIT`（分離レベル = SERIALIZABLE / external consistency） |
| `INSERT OR IGNORE`（冪等 INSERT） | `lanes/_helpers.ts#insertTxWithLog`、seed | `INSERT ... ON CONFLICT DO NOTHING` |
| `INSERT OR REPLACE` | 各所の upsert | `INSERT ... ON CONFLICT (...) DO UPDATE SET ...` |
| 単一行 `UPDATE FinalitySeq ... RETURNING` による event_seq 採番 | `orchestrator/finality.ts#allocateEventSeq` | リスク#2参照（下記） |
| `version = ?` 楽観ロック | `_helpers.ts` 全 CAS | そのまま（SSI と素直に整合。競合は abort→retry） |
| `WHERE txid = ? OR gtid = ?` のチェーン整列 | `finality/finality_chain.ts` | そのまま（per-chain 全順序のみ要求、大域整列は不要） |

#### event_seq 採番（リスク#2 と結合）

`FinalitySeq` 単一行の `UPDATE...RETURNING` は単一ノードでは無料だが、分散 SQL では
**全書き込みが1行で大域直列化** されクロスリージョン合意のボトルネックになる。event_seq の
大域単調性は **ハッシュチェーンの正当性要件ではない**（`prev_hash` が per-chain 順序を独立に
担保）。移植時は次のいずれかへ:
- **HiLo / ブロック割当**（短期・低リスク）: isolate ごとに N 個まとめて採番、競合を 1/N に。
- **per-chain シーケンス＋HLC**（分散 SQL 向け）: チェーン単位単調＋無協調な大域整列。大域全順序が
  必要なのはアンカー透かし（`finality/finality_anchor.ts#MAX(event_seq)`）のみで、これは HLC
  または per-chain アンカーへ置換可能。

> **単調性は壁時計ではなく DB のコミット順序から導く**: event_seq（ないしその
> 後継の大域整列値）の単調性は **`Date.now()` などの壁時計からではなく、エンジン native の
> コミット順序**——Spanner のコミットタイムスタンプ、CockroachDB の HLC——から導くこと。
> 壁時計はノード間でずれ、アンカー境界（下記 UUID v7 評価参照）がコミット順を要するこの
> 設計では不整合の源になる。

#### UUID v7 はこの用途に最適ではない（評価）

「event_seq を UUID v7 に替える」案は、**ボトルネック（大域 1 行採番）は確かに消える**（無協調で
生成でき時刻順にほぼ整列する）一方、この設計では**割に合わない**:

1. **アンカー包含証明の完全性を弱める**。アンカーは `getChainTipHashAsOf(chain, maxSeq)` で
   `event_seq <= 透かし` を満たすチェーン先端を確定し「この透かしまでの全イベントを被覆した」と
   主張する。UUID v7 は**同一ミリ秒内・ノード間の順序がランダム下位ビット依存**で *コミット順* を
   反映しない。採番（=コミット順、単一ノードの `UPDATE...RETURNING`）と違い、透かし生成時に
   in-flight だったイベントが後でコミットし、その UUID v7 時刻が透かしより**前**に並ぶと
   「被覆されるべきなのに被覆されない」隙間が生じ得る。アンカーの境界は *コミット順序付きの
   切れ目* を要するが、UUID v7 のランダム末尾はそれを保証しない。
2. **要らない大域順序を過剰供給する**。[§6.2](#consistency-model) はチェーン間を**因果順序のみ**と
   規定し、大域全順序が要るのはアンカーだけ。UUID v7 は弱い大域時刻順序を全書き込みに付与するが
   要件超過で、しかも (1) の保証は満たさない。
3. **列・索引の作り替え**（`INTEGER` 4 索引＋`FinalityAnchor.high_watermark_seq` → `TEXT/BLOB`）と
   既存の厳密単調テスト（`chaos_nasty #N10`）の書き換えが要る。

**推奨**: 単一ノード D1 では event_seq は**そもそもボトルネックではない**（単一ライタで全書き込みが
直列するため、追加の 1 行 `UPDATE...RETURNING` は実質無料でコミット順の全順序が手に入る）。分散化
時は UUID v7 ではなく **(a) per-chain seq（チェーン内単調・prev_hash と素直に整合）＋(b) アンカー
境界をエンジン native のコミット順序値（Spanner commit timestamp / Cockroach MVCC）または HLC で
定義** する。UUID v7 は「因果保証を欠いた HLC ライト」であり、アンカーの切れ目がコミット順序を要する
この設計には HLC / native-commit-ts が正解。

### 7.3 受入条件（Acceptance Criteria）

保管バックエンド差し替えが「完了」とみなせる条件:

0. **方言契約コンフォーマンス緑**: `test/integration/portability_conformance.test.ts` が新バックエンド
   上で全通過（§7.2 の方言表を実行可能な表明に落としたもの——`changes()` ゲート条件 INSERT・
   `db.batch()` の原子性・`INSERT OR IGNORE` 冪等・event_seq 厳密単調）。移植時の**最初のゲート**：
   アダプタを `createTestDb` の背後で差し替えてこのファイルを回す。緑＝決済コアが依存する 4 挙動が成立。
   ただしこれは **契約の明文化** であって、実マルチリージョンクラスタ上の（§7.3 条件1）chaos 全通過や
   （§7.3 条件3–4）の linearizability / split-brain 検証の**代替ではない**（それらは実バックエンドが要る）。
1. **全 chaos スイート緑**: `test/integration/chaos_*.ts`（並行・冪等再送・TOCTOU 取消順序・
   ゼロサム不変条件・ハッシュチェーン監査）が新バックエンド上で全通過。
2. **原則10 の縮退が観測可能**: quorum 喪失注入で `QUORUM_LOSS_READONLY` へ縮退し、書き込みが
   `SYSTEM_QUORUM_LOSS_READ_ONLY` で拒否され、回復で自動復帰する（`test/zc/quorum.test.ts`
   相当をバックエンド上で再現）。
3. **線形化可能性**: 確定済みエントリの読み取りが linearization point 以前のみを返す
   （[§6.2](#consistency-model)）。
4. **split-brain 安全**: 少数派パーティションが新規確定を書けない（縮退が機能する）こと。
5. **対話型トランザクションを持ち込まない**: 移植後も **interactive read-then-write
   トランザクションを導入しない**こと。D1 の「静的バッチ」（全文が事前確定した single-round-trip）は
   制約に見えて、実は**資産**である——分散 SQL 上で競合リトライが最少になる形そのものだからだ。
   これを受入条件へ昇格させる。

### 7.4 データ層の可搬と切替時のファイナリティ整合（未着手）

Cloudflare 固有バインディング（Workers/D1/Queues/R2）の抽象化層と、データ層（D1）の可搬先・
切替時のファイナリティ整合は本章のロードマップとして残る（[§10 既知の制約](#s10-roadmap)）。
本章は **保管バックエンドの移植契約** に範囲を限定し、実行環境の抽象化（可搬性）は別件。

### 7.4.1 資源バインドの宣言（規範）

Cloudflare の資源バインド（D1 / Queues / R2 / KV / Durable Objects）は `Env` 上で
`?:`（optional）として型付けしてよい。Worker はバインド不在でも起動でき、コードは意図的に
縮退する（ALS はキャッシュ無しで解決し、RichData はしきい値超過でもインラインに保持し、
`/api/stream/connect` は 500 を返す）から、型が「常に在る」と偽るほうが誤りである。

**ただし、その縮退モードに“気づかないまま本番が入る”ことは許さない。** optional 記法は
宣言漏れを不可視にする——実際 `ALS_KV` は `src/zc/directory/als.ts` が読んでいるのに
`wrangler.toml.example` には存在しなかった。したがって optionality は型に残したまま、
**配布する設定ファイルの完全性を機械検査で担保する**：`Env` 上で資源型を持つフィールドは
すべて `wrangler.toml.example` に宣言されていなければならない
（`test/invariants/worker_bindings.test.ts`）。検査の対象は資源バインドに限る——シークレット
（`ZC_SIGNING_KEY_PKCS8` 等）は秘密ストアに置くものであり、リポジトリ内の toml に現れては
ならない。

### 7.5 S3 回答: 移植時に隠れる二つの再設計と設計規律 <a id="s3-hidden"></a>

> 一貫性・移植契約の充足可能性について: 契約は**充足可能——ただし書かれていない再設計が
> 二つ隠れている**。どちらも縮退ロジックの再設計ではなく**移植タスク**である。

まず良い報せ: 主張されている保証（チェーン単位の線形化・チェーン内全順序・チェーン間は因果のみ、
[§6.2](#consistency-model)）は per-key 線形化で足りるため候補4製品すべてが満たす。大域外部整合は
要求しておらず、Spanner 専用機能への依存もない。「D1 バッチ→単一 ACID トランザクション」
「`changes()` ガード→`UPDATE ... WHERE state=? RETURNING`」は §7.2 の通り機械的に写る。

**隠れた再設計① — リトライ意味論（in-doubt）**。分散 SQL はトランザクションを abort→retry させ、
コミット直後のクラッシュでは「コミットされたか不明」（in-doubt）が生じる。D1 単一ノードには
この曖昧さが存在しないため、現コードは無防備。**トランザクション結果表（txn-outcome table）＋
冪等ラッパ**を全書き込みプリミティブに被せる必要がある。ただし**結果表は新設不要**——
既存の Idempotency 表（[`src/shared/idempotency.ts`](../src/shared/idempotency.ts)、
`IdempotencyKeys`：`acquireIdempotency` / `completeIdempotency` / `resolveIdempotency`）を
**「コミット済み結果の権威」（txn-outcome table）として流用**し、書き込みプリミティブを冪等に
包む。縮退ロジックの再設計ではないが、工数は小さくない。

**隠れた再設計② — quorum 健全性の測り方（カナリア書き込み）**。`reconcileQuorum` に
レプリカ到達性（メンバシップ）を注入する現設計は、**Spanner がそもそもメンバシップを外に
見せない**時点で破綻する。測るべきは「**今、コミットできるか**」そのもの——**カナリア書き込み
ループ**（合成トランザクションの成功率とレイテンシ）を `quorum-report` の給餌源にせよ。これなら
4 製品すべてで同一の配線が本当に動き、「観測すべき quorum が無い」という現行の言い訳ごと消える。
これが本番の**具体的な production wiring** である（[§6.3](#consistency-model) / [§7.1](#portability)
の給餌経路をこれで置き換える）。

**移植時の設計規律**（受入条件へ昇格済み: [§7.3](#portability) 条件5）: D1 の静的バッチは資産で
あり、**対話型 read-then-write トランザクションを導入しない**。あわせて `event_seq` の単調性は
**DB のコミット順序**（Spanner commit timestamp / CockroachDB HLC）から導く（[§7.2](#event-seq)）。

---

## 第8章 データベース改善 <a id="s8-database"></a>

詳細は `31_schema.md` に集約。要点だけここに残す:

- **スキーマは `0001_consolidated_schema.sql` に統合済み**（旧 0001–0042 の
  連番チェーンを最終形のテーブル定義・index・seed に畳んだ唯一の正）。
  hot-path index（timeout sweep, lane×state ダッシュボード, audit by
  time-range, expired RTP/HTLC sweep など）もこの中に含む。
- **スキーマ変更はこの統合ファイルを直接編集する**（新しい連番ファイルは
  切らない）。列の追加・修正は対象 `CREATE TABLE` に直接反映し、`31_schema.md`
  も同じ変更で更新する。`test/helpers/d1-mock.ts` の `SCHEMA_MIGRATIONS` は
  この 1 本を毎回新規適用するため、配列への追記は不要。詳細な鉄則は
  `31_schema.md` § マイグレーション運用。
- **Foreign Key は意図的に最小**（mock であり、参照整合は ZC 側状態機械と
  FinalityLog で担保）。本番化方針は `31_schema.md` § Foreign Key 戦略。

---

## 第9章 テスト戦略 <a id="s9-testing"></a>

### 既存
- Vitest + better-sqlite3 in-memory D1 mock による約1,000ケースのテストスイート（正確な数はリポジトリを正とする）。

### 横断プリミティブ
- `test/shared/errors.test.ts` — DomainError/errorResponse/カテゴリ写像
- `test/shared/logger.test.ts` — JSON shape, redaction, child baggage
- `test/zc/lane_helpers.test.ts` — CAS / 並列 N 本 / TOCTOU 取消順序 / sideUpdates / insertTxWithLog

### 静的解析インバリアント（`test/zc/lane_invariants.test.ts`）
**目的**: 「新規 lane 追加時のチェックリスト」§4 を機械化する。`src/zc/lanes/`
配下のソースを regex で走査し、helper を回避する直書き SQL（`UPDATE
Transactions SET state` / `INSERT INTO Transactions`）、`FinalityEventType`
union 未登録のイベント名、test 漏れを検出する。runtime suite が「動く」を
確認するのに対し、こちらは「規約を守って動く」を確認する。

### 残高インバリアントの統合テスト（`test/integration/balance_invariants.test.ts`）
**目的**: 「状態機械が正しい」だけでなく「最終的に顧客口座の数字が合う」までを
往復で固定する。state-machine 系の単体テストはレーンの遷移条件を見るが、
仕訳まで追うものが無かったため、過去に以下のような**仕訳起点のバグが摺り抜けた**：

| バグ | 内容 | 修正 |
|---|---|---|
| double-credit | `onPayeeExecConfirmed` が無条件に `credit-notify` を呼び、その bank ハンドラがもう一度 `Customer(+)/ZCS(-)` を仕訳していた。EXPRESS / STANDARD / HTLC / HTLC_AUTH / HIGH_VALUE / BULK のすべてで payee が 2 倍着金。 | `bankCreditNotify` を**仕訳しない通知層**に変更（BankAuditLog + DELIVERED 応答のみ）。`execute-credit` 経由の仕訳が唯一の真実。 |
| HTLC_AUTH stuck | `approveAuthRequest` が `Transactions(state='H_RESERVED')` で INSERT。`claimHtlc` の CAS は `WHERE state='HTLC_LOCKED'` のため Transactions が動かず、Bank だけ debit されて payee は永遠に着金しない。 | **（当時）** INSERT 時の state を `HTLC_LOCKED` に変更し `HtlcContracts` と整合。**（現行）** その後、`HTLC_LOCKED` 直挿入は `PaymentInitiated` の証跡を残さないため**禁止**され、`RECEIVED` で INSERT → `transitionWithLog` で `RECEIVED → HTLC_LOCKED` を通る canonical 入口に再是正された（下記注記）。 |
| GTID leg pairing | 2×2 で PAYEE が leg_id 昇順以外で挿入されると、PAYER↔PAYEE のペアが取り違わって誤った銀行に着金。 | `payerLegs` / `payeeLegs` を leg_id でソートし、同じ index で組む。 |

> **注記（上表 HTLC_AUTH stuck 行の「当時の修正」は現行規範ではない）**
> 上表は**バグが摺り抜けた経緯の記録**であって、現行の規範ではない。HTLC_AUTH 行の
> 「INSERT 時の state を `HTLC_LOCKED` に変更」は当時の是正であり、その後
> **`HTLC_LOCKED` での直接 INSERT は禁止**された——`RECEIVED` で挿入し
> `transitionWithLog` で `RECEIVED → HTLC_LOCKED` を正規遷移することで、
> `PaymentInitiated` が必ず FinalityLog に残る（canonical 入口の証拠）。
> 規範は `10_requirements.md` §3.2.3.1-5 および `20_method_design.md` §3.2.1、
> 実装は `src/zc/lanes/htlc_auth/approve.ts`、固定は
> `test/zc/htlc_auth_canonical.test.ts` / `htlc_auth_regression.test.ts`。
> **本表の「修正」欄を現行の実装指針として読んではならない。**

カバー範囲（11 テスト）:
- 各レーン（EXPRESS / STANDARD / HTLC / HTLC_AUTH / HIGH_VALUE / BULK / GTID 1×1 / GTID 2×2 逆順 / 複数レーン同時）について、
  1. payer 顧客 Δ == −amount
  2. payee 顧客 Δ == +amount
  3. 各行内ゼロサム
  4. BOJ 系全行合計の保存則（RTGS 経由でも 0 保存）

新規バグ修正は**この suite の `expect()` が落ちる**ことで検出できる。新レーン
追加時はこの suite に 1 ケース足すのを義務付けたい。

### ZC→Bank ingress 接合部（`test/integration/ingress_commands.test.ts` / `test/invariants/ingress_seam.test.ts`） <a id="ingress-seam"></a>

**目的**: 13 コマンド（[`10_requirements.md` §7.2.1](10_requirements.md#req-master)）の
**呼び手と受け手が同じ電文を指していること**を、機構と往復の二段で固定する。

きっかけは `account-verify` で実際に見つかった不具合である。呼び手と受け手が同じコマンドの電文を
別々に宣言し、項目名が食い違ったまま両側が型検査を通っていた。受け手は口座を一度も
解決できず、呼び手は受け手が返さない値を期待して既定分岐（`ERROR`）に落ちていた。
それでもスイートは緑だった——当該コマンドの唯一のテストが、呼び手のマッピング関数を
**手書きの応答オブジェクト**で単体呼び出ししていたためである。
**接合部を跨がないテストは、片側の思い込みを言い直して「思い込み＝思い込み」を確認する。**

したがって規約は次の 2 つである。

1. **電文型は 1 箇所でのみ宣言する**——`src/types/api/bank-ingress.ts`。呼び手も受け手も
   ここから import する。コマンド名から電文型への写像 `BankIngressRequestMap` と、
   コマンドの正本一覧 `BANK_INGRESS_COMMANDS` を同ファイルに置き、`src/bank/ingress.ts`
   の dispatch はこの写像で型付けされたテーブルとする。**どちらかの端が項目名を変えれば
   `tsc` が落ちる**——規律ではなく機構で守る（第4章 `_helpers.ts` と同じ方針）。
   受け手が独自に電文型を宣言していないことは `invariants/ingress_seam.test.ts` が静的に検査する。
2. **13 コマンドすべてに往復テストを置く**——`integration/ingress_commands.test.ts`。
   各テストは **呼び手が組んだ電文**（本番の call site が使うのと同じ builder /
   `callBank*` ラッパ）を **実物の受け手**に通し、戻り値を **呼び手のマッピング**へ流す。
   テスト中に電文・応答のリテラルを手書きしてはならない（手書きした瞬間、それは
   接合部ではなく片側の再宣言になる）。
   - 電文は dispatch 前に JSON 往復させる（`overWire`）。内部呼び出しはオブジェクトを
     そのまま渡すが、`handleBankIngressHttp` は電文を回線から parse する。
     片方でしか成立しない契約は契約ではない。
   - 表明は応答の形だけでなく **受け手の効果**（仕訳・行の状態）に置く。`undefined` を
     読んだ受け手も、それらしい形の応答は返せるためである。
   - 網羅は `BANK_INGRESS_COMMANDS` に対して機械検査する。**往復テストの無いコマンドが
     増えること自体**が、`account-verify` が死んだまま出荷された経路だった。

この 2 つは役割が違う。1 は「二度と食い違わない」を保証し、2 は「そもそも繋がっている」を
保証する。型が一致していても呼び手が受け手を一度も呼んでいなければ（`rtp-notify` が
実際にそうだった）1 は何も言わない。

### 追加テスト
1. **冪等キー再送**（`test/integration/idempotency_replay.test.ts`）— EXPRESS / STANDARD / HTLC で
   同一 idempotency_key の 2 回目リクエストが同一レスポンスを返し、Transactions 行が 1 本のみであることを確認。
2. **Queue retry/ack ポリシー**（`test/integration/queue_retry_policy.test.ts`）— DomainError
   category × `msg.retry()` / `msg.ack()` の対応を全カテゴリで検証。non-DomainError も retry 対象であることを確認。
3. **HTLC cancel payer 残高**（`test/integration/htlc_cancel_balance.test.ts`）— `TIMELOCK_EXPIRED`
   および直接 cancel の 2 経路で payer suspense が普通預金に戻り、行内ゼロサムが保たれることを確認。

---

## 第10章 既知の制約・将来項目（Roadmap） <a id="s10-roadmap"></a>

### 10.0 実装状況の書き方（本書群共通の規範） <a id="asbuilt-policy"></a>

設計書は **規範（そうでなければならないこと）を現在形で書く文書** であり、実装の進捗表ではない。
両者を同じ本文に混ぜると、規範が commit ごとに腐り、しかも腐り方が非対称に危険である——
「未実装なのに実装済みと書いてある」側にしか倒れないからである。したがって本書群は、
実装状況を次の **非対称なルール** で扱う。

| 種別 | 本文に書くか | 書き方 |
|---|---|---|
| **規範に実装が達している** | **書かない** | 規範を現在形で書くだけでよい。「実装済み」と書き足さない |
| **規範に実装が達していない** | **必ず書く** | 当該箇所に **1 行**（「**未充足**：〜。本書 第10章で追跡」）を置き、実体は本章に登録する |
| **実装の所在（どのファイルにあるか）** | 本書（内部設計書）に限り書いてよい | 「実装: `src/...`」。状態ではなく所在なので腐りにくく、`file_structure.md` の機械検査が守る |
| **設計経緯（なぜ採らなかったか）** | 判断の再利用に必要な範囲で書いてよい | 「経緯」と明示し、規範と混ぜない。作業履歴（いつ何件実装したか）は git が持つ |

**根拠**：`10_requirements.md` §8.8 は「未充足のものを充足しているかのように書かない」を既に規範として
定めている。上表はその裏側——**充足していることをわざわざ書かない**——を対にして固定したものである。
片側だけを規範にすると、「実装済み」注記が増えるほど、注記の無い箇所が「未検証」に見え、
注記のインフレが起きる。**沈黙が「規範どおり」を意味する**という約束が、この文書群を短く保つ。

**本章について**：本章は **残っている作業だけ** を載せる。項目が完了したら、その行は消し、
必要なら本文側の規範へ記述を移す（「実装済み」として本章に残さない）。

### 10.1 セキュリティ・運用基盤

- **参加者鍵の登録を全行へ広げる**: 照会の主体認証は `KeyRegistry` の
  `owner_type='PARTICIPANT'` 鍵によるリクエスト署名として実装済みで、**強制は鍵の登録状態で
  決まる**（登録済みの行は署名必須、未登録の行は申告のみで読めるが監査台帳に未認証として残る。
  `32_api_contracts.md` § 照会の認可）。したがって残件はコードではなく**運用**——全参加行の
  鍵登録と、その期限の制度化（`10_requirements.md` §3.3.4 の 4 眼統制に乗る）。
  ブラウザから直接叩く参照ダッシュボードは鍵を持てないため、運営スコープ（`X-Cron-Secret`）で
  読む前提のままである。
- **OpenAPI 自動生成**: `src/openapi/*.ts`（YAML 文字列定数）は手書き。コードの
  ルーティングと型から再生成する仕組みを入れたい。

### 10.2 規範に対する実装の残件

- **保管側の単一正本性**: 地理分散合意ログの実体が未実装（制御側——quorum 評価・
  自動縮退・read-only 強制配線・自動復帰・GLOBAL チェーン監査——は実装済み）。保証する
  一貫性と移植契約は [§6 一貫性モデル](#consistency-model) と [§7 可搬性](#portability)、
  移植時に隠れる二つの再設計は [§7.5](#s3-hidden) が正。
- **実行環境の可搬性**: Cloudflare 固有バインディングを抽象化層の背後へ隔離し「第二の
  実行環境で動く」ことを受入条件化する横断アーキ変更は未着手（BCP 縮退モード自体は
  実装済み）。データ層（D1）の可搬先と切替時のファイナリティ整合も未検討
  （`10_requirements.md` §8.7 の要件 M-2 が未充足であることの実体はここ）。
- **リース＋フェンシングトークン**: 所有者障害からの回収。`owner` 列（[§5 単一所有者則](#single-owner)）
  をそのまま土台に使えるが、**受け手が stale トークンを拒否して初めて意味を持つ＝信頼境界を
  越える**ため、参加者の接続認定試験と同じタイミングに送る
  （[`10_requirements.md` 要求仕様章](10_requirements.md#core-requirements)）。
- **CBT 確定の自動 EOD 取り込み**: 現状の非JPY DNS 取り込みは内部仕訳までで、発行体の
  署名付き確定観測を待ってからの finality 連結は外部 Watcher 経路に委ねている。
- **ILP / ISO 20022 への対外接続**: 元帳の通貨次元化（`BankJournals.amount_currency`）を
  対外プロトコルへ接続する部分。
- **Watcher 定足数：確定種別の権威と独立性の制度化**: 既定値はレール別に効いており
  （`onchain_chain_class='PUBLIC'` は 2、決定的チェーンは 1、`src/zc/lanes/htlc/create.ts`）、
  種別を欠くクロスチェーン脚は `ONCHAIN_CHAIN_CLASS_REQUIRED` で拒否する。残るのは
  (a) **申告された種別を誰も検証しない**こと——`PUBLIC` の鎖を `PRIVATE` と申告すれば
  定足数は 1 に落ちるので、`source` と種別の対応はチェーン登録として制度側に置く必要がある、
  (b) Watcher の独立性（鍵・運用組織・ネットワーク・チェーンノード）の制度化と実地検証
  （`20_method_design.md` §7.7.3。`10_requirements.md` §8.5 の要件 S-4 に残るのはこの 2 点）。
- **禁止クエリパターンの内容による検出**: `10_requirements.md` §3.3.2.2.1.1-2。一覧・フィード系は
  経路として運営スコープに限定済みだが（`10_requirements.md` §3.3.2.2.3 の取得制限を経路で実装した形）、単件照会の
  *内容*が濫用的な相関探索かどうかの判定は無い。`AccessAuditLog` はその判定に必要な材料
  （主体・目的・対象・時刻）を既に残しているので、次は事後検知（`10_requirements.md` §3.3.2.2.1.1-3）から着手できる。
- **`export_ref` の発行経路**: `AccessAuditLog.export_ref` は列として在るが、エクスポートを
  伴う照会（帳票・CSV。`20_method_design.md` §10.4.2）が未実装のため常に NULL。
- **FX の任意の発展**: 流動性連動の動的上限・丸め益の帰属ルール・決済前 AML フックの接続・
  紛争フロー・HTLC レーン自体の通貨次元化（§17.4「将来課題」。FX は独立 `FxLegLocks` で
  完結しているため必須ではない）。
- **プログラマビリティの発展余地**: 決定的に評価できる範囲での述語追加、定期/据置の
  第一級オブジェクト化、外部イベント購読（§11.6）。
- **未開示の挙動の棚卸し**: 「実装にあって文書に無い」を受動的に見つけるのではなく
  能動的に探す。候補は**変換を行う箇所**——正規化（GTID 脚）・識別子の書式生成・既定値の充填——で
  あり、いずれも「参加者が送ったものと、系に残るものが違う」場所である。過去にこの型で
  3 件（脚正規化・照会の認可・`origin_leg_id`）が同時に見つかっており、まだあると見るのが妥当。
- **時間軸で崩れる前提の棚卸し**: 「単体では正しいが、**別のスイープ・別のジョブが
  時間とともに前提を崩す**」箇所を能動的に探す。CASE の重複判定が
  `state='OPEN'` だったために、`20_method_design.md` §10.7.4 の昇格スイープが走った翌日から
  監査チェーン破断の CASE を毎晩複製していた例（`UNRESOLVED_CASE_STATES` で解決済み）がある。
  候補の型は**同じ列の値域を 2 箇所以上が手書きしている**場所であり、`Transactions.state`・
  `DnsCycles.state`・`IgsRequests.status` について同じ棚卸しをしていない。
- **状態 `reason_code` の family 判定の機械化**: 命名規約
  （`32_api_contracts.md § 状態 reason_code` の待機理由／事象理由）は文章であり、
  `CANCELLED` の行に `SUSPEND_*` が載るような矛盾した組み合わせを検査していない。
  拡張の可否は**誤検知率を実測してから**決める。

### 10.3 制度設計に委ねる論点（方式は固定済み・最終仕様は制度合意待ち）

`dns_recovery_reserve` の算式（本実装は shortfall+バッファの方式モデル）、Bulk LSM
の目的関数の重みづけ・近似度（`20_method_design.md` 第11章 RFP）、エージェント identity の発行主体、
HTLC 条件テンプレートの第三者提案プロセス、オンチェーン確定種別の分類権威
（チェーン登録）、FinalityAnchor の配布先（全参加行配信／公開トランスペアレン
シーログ／公開チェーン）の選定。

> **解消済み（副署の基準点）**：本節はかつて「副署が覆う時点の確定」を制度合意待ちの
> 論点として掲げ、基準点を**現 tip**・b を記録したエントリ・日次アンカーのいずれに置くかは
> 未決である、としていた。これは論点の立て方自体が誤っていた——現 tip は選択肢ではない。
> 定足数は「相異なる k 者が同一のハッシュに署名した」ことであり、tip は通常の業務追記の
> たびに動くから、tip に署名させると **`min_cosigners >= 2` が原理的に充足不能**になる
> （制度の好みの問題ではなく、構成上そうなる）。基準エントリは「不可逆点のエントリ、
> 無ければ直近アンカーの tip」と固定し、`resolveCosignBasis` で解決する。
> 規範は `32_api_contracts.md § GET /api/transactions/:txid/verify`。

これらは本書の Roadmap として残し、優先度の高いものから別途 issue 化する。

---

## 第11章 プログラマビリティ（外部アテスター前提の条件付き決済） <a id="s11-programmability"></a>

> 本章はプログラマビリティの**思想・構成レイヤ**の一次記述である。HTLC claim 経路での適用規範（状態遷移・`claim-by-conditions`・証跡）は 第15章 §15.5 を正とする。両者は対であり、重複する詳細は互いに参照で解決する。

条件付き・合成可能な決済に関する設計を集約する。規範は本書
[第15章 HTLC（hashlock+timelock）詳細](#appendix-g-htlc) §15.5、API は
[`32_api_contracts.md`](32_api_contracts.md)、スキーマは [`31_schema.md`](31_schema.md)。

### 11.1 基本思想 — 判定はエッジ、コアは決定的

ZC のプログラマビリティは、**「真偽の判定は外部（エッジ）に任せ、コアは決定的に評価するだけ」**という考え方を大前提とする。これは設計原則（証跡・単一正本・説明可能性）から導かれる、意図的な機能の抑制である。そのため、イーサリアムの EVM のようなチューリング完全な VM（任意のプログラムを実行できる仮想機械）は**載せない**。

- **外部アテスター前提**: 「検品完了」「書類充足」「制裁非該当」等、現実世界の条件そのものを ZC が判定することはない。ZC が行うのは、`KeyRegistry` に登録済みの外部アテスター（第三者の検証者）が署名した **Attestation**（証明、`verified_result='PASS'|'FAIL'`）を検証することだけである。真偽の判断・複雑な業務ロジック・数量やレートやデータに依存する判断は、すべてアテスター側に委ねる。コア側の表現力をあえて薄くしているのは、判定を担うエッジ側の自由度に上限が無いからである。
- **コアの性質**: **決定的**（同じ入力なら常に同じ結果になる）／**fail-closed**（条件が未充足・不整合の場合は必ず「不成立」側に倒す安全側の設計）／**全証跡**（評価結果は必ず FinalityLog に残る）／**非チューリング完全**（任意のプログラムを実行できる汎用計算能力を持たないため、停止性判定・ガス代・非決定性といった問題が構造的に発生しない）。
- **HTLC を普遍プリミティブに**: 条件付き決済はすべて「ロック → 条件が成立すれば解放／タイムロック期限が来れば返金」という HTLC の形に落とし込む。HTLC 本来の「preimage（秘密の値）の提示＝条件成立」という考え方を、Attestation・条件式・決定的述語を使ってより一般化したものと捉えるとよい。

ただし、「HTLC ＋ 外部アテステーションだけ」ではカバーしきれない領域（流動性効率・複数拠点にまたがる同期的なアトミシティ・時刻の扱い）もある。これらは別のプリミティブ（DNS/H・GTID・決定的述語）で補っている。

### 11.2 構成レイヤ

```
condition_expr（純粋ブール合成: AND / OR / THRESHOLD k-of-n）
   ├─ Attestation リーフ  ── 外部署名 + ConditionTemplate whitelist + KeyRegistry scope/鮮度
   │      └─ テンプレ単位 distinct-operator 定足数（min_attester_quorum）+ equivocation → CASE
   └─ 決定的述語リーフ    ── ZC 自身が確定状態/時刻で解決（LedgerPredicate）
Mandate（委譲権限: 別軸。「誰の権限で」を金額/目的/レーンで縮小のみ委譲）
```

**a. 条件式 `condition_expr`** — [`src/zc/platform/condition_expr.ts`](../src/zc/platform/condition_expr.ts)
`{template_id}` リーフ、`{op:'AND'|'OR', operands}`、`{op:'THRESHOLD', k, operands}`（k-of-n。AND=`THRESHOLD n` / OR=`THRESHOLD 1` の一般化）から成る式木の**純粋評価器＋検証器**。深さ・オペランド数・参照テンプレ数に上限（濫用・無限再帰防止）。ZC は式の真偽そのものは作らず、満たされたテンプレ集合に対するブール合成を評価するだけ。

**b. Attestation ＋ ConditionTemplate** — [`src/shared/attestation.ts`](../src/shared/attestation.ts)
`ConditionTemplate` は許可制 whitelist（第三者提案可、統制思想は `HtlcAuthWhitelist` と同型）。`recordAttestation` が署名（`KeyRegistry`、`31_schema.md § KeyRegistry`）・スコープ（`allowed_attester_scope`）・鮮度（既定 60 分）を検証。原文は保持せず `statement_hash` と `verified_result` のみ。

**c. distinct-operator 定足数 ＋ equivocation** — [`src/shared/attestation_quorum.ts`](../src/shared/attestation_quorum.ts)
テンプレ単位 `min_attester_quorum`（既定 1）により、条件リーフは **k 個の distinct な attester operator（`KeyRegistry.owner_ref`、鍵ではなく）の鮮度内 PASS** が揃って初めて満たされる。同一 operator の複数鍵は 1。同一 `(template, subject)` に PASS/FAIL 混在の **equivocation** は fail-closed（当該リーフ不成立）＋ `ATTESTATION_EQUIVOCATION` の CASE 収束（他の独立枝での成立は妨げない）。
純粋な定足数・equivocation 判定は [`src/shared/operator_quorum.ts`](../src/shared/operator_quorum.ts) に集約し、**Watcher のオンチェーン n-of-m（`onchain_min_watchers`）と同一ポリシーを共有**（「鍵ではなく operator で数える／不一致は一致でない」を一箇所に）。

**d. 決定的述語 `LedgerPredicate`** — [`src/zc/platform/ledger_predicate.ts`](../src/zc/platform/ledger_predicate.ts)
`ConditionTemplate.ledger_predicate_json` が非 NULL のテンプレートは、外部表明を取らず **ZC 自身が決定的に解決**（`allowed_attester_scope='{}'`＝誰も表明できない fail-closed）。汎用 VM に広げず、確定状態か固定時刻から再現可能に真偽が定まる少数の述語のみ:

| 種別 | 意味 | 単調性 |
| --- | --- | --- |
| `TX_REACHED_STATE {txid, states[]}` | 確定 FinalityLog に txid の `state_to ∈ states` | 単調（追記専用） |
| `GTID_REACHED_STATE {gtid, states[]}` | 同上（GTID 集約状態） | 単調 |
| `TIME_AFTER {at}` | `now >= at` | 単調（false→true） |
| `TIME_BEFORE {at}` | `now < at` | **非単調**（true→false） |

`*_REACHED_STATE` は linearization point 以前の確定エントリのみ読む → 「txid#2 が `b` に到達したら解放」型 DvP を、自台帳状態を外部署名者へ外注せず表現。`TIME_*` は据置（先日付）・期限を*条件*として表現（スケジューラ本体ではない）。時刻は **JST**（§11.4）。

**e. Mandate（委譲権限）** — [`src/shared/mandate.ts`](../src/shared/mandate.ts)
「どの権限でその指図が出たか」を金額/目的/レーンの scope 付きで委譲チェーン化（`parent_mandate_id`）。**縮小のみ**（sub-mandate は親を緩められない）。条件成立の真偽とは直交する別軸（agentic commerce 前提）。

### 11.3 claim 経路と証跡

`claimHtlcByConditions`（[`src/zc/lanes/htlc/claim.ts`](../src/zc/lanes/htlc/claim.ts)）は式が参照するテンプレートを Attestation テンプレ／決定的述語テンプレに分け、前者は提示 Attestation を記録＋定足数/ equivocation 判定、後者は `evaluateLedgerPredicate(db, p, now)` で解決し、満たされたテンプレ集合で式を評価する。いずれの場合も **`HtlcConditionsEvaluated`**（満たされた集合・required・定足数内訳・ledger 内訳・equivocation・評価に用いた `evaluated_at`・met）を FinalityLog に残すため、時刻ゲート成立も監査で完全再現できる。成立時のみ既存の成立経路（`HTLC_LOCKED → HTLC_FULFILL_REQUESTED → …`）へ進む。

### 11.4 システム時刻 = JST

システムの業務・表示時刻は **JST（Asia/Tokyo, UTC+09:00）**。単一の正は [`src/types/primitives.ts`](../src/types/primitives.ts)。

- **瞬時値の保存は UTC**（`nowISO`, RFC3339 `Z`）— 辞書順＝時系列を保ち、FinalityLog ハッシュ連鎖と `occurred_at ≥ cutoff` 比較を一意に保つため。
- **業務・表示は JST** — `businessDateJST()`（業務日）・`systemMinutesOfDay()`（稼働ウィンドウ）・`parseSystemTime()`（オフセット無し入力を JST 解釈）。`TIME_*` の `at` にオフセットが無ければ JST とみなす。全ての業務日/バリュー日派生・稼働ウィンドウ・HTLC の翌日境界 AML 再チェックを JST に統一。

### 11.5 ドライラン（読み取り専用）

副作用なし（書き込み・資金移動・Attestation 記録なし）で条件式・マンデートを事前評価する。既存の純関数を再利用（[`src/zc/query/simulate.ts`](../src/zc/query/simulate.ts)）。

- `POST /api/conditions/validate` — 構造検証＋参照テンプレ列挙
- `POST /api/conditions/simulate` — 仮の satisfied 集合に対する met/missing
- `POST /api/mandates/check` — マンデートの scope 判定

### 11.6 意図的な非対象と将来

コアに**入れない**（＝この設計の一貫性を保つための線引き）:
- **汎用計算/スクリプト VM**、および**数量・レート・添付データ依存の述語**。これらは非決定/外部データ依存なので、アテスターが判定して PASS 署名する既存経路に載せる。
- **スケジューラ本体**（push 実行・定期・冪等再送）。`TIME_AFTER` は*pull 型の時刻ゲート条件*どまり。
- **外部開発者向け pub/sub（署名付き Webhook）**。現状 `EventStream` は銀行宛て配信で、反応型プログラムはポーリング前提。

将来の発展余地（決定的に評価できる範囲での述語追加、定期/据置の第一級オブジェクト化、外部イベント購読）は Roadmap（[§10](#s10-roadmap)）に連なる。

### 11.7 テスト

- 純粋層: [`test/shared/operator_quorum.test.ts`](../test/shared/operator_quorum.test.ts)、[`test/zc/ledger_predicate.test.ts`](../test/zc/ledger_predicate.test.ts)、`condition_expr`（[`test/zc/htlc_conditions.test.ts`](../test/zc/htlc_conditions.test.ts) / [`test/zc/htlc_programmability.test.ts`](../test/zc/htlc_programmability.test.ts)）。
- 統合: THRESHOLD・定足数・equivocation・決定的述語（TX/GTID/TIME）は `htlc_programmability.test.ts`、ドライラン API は [`test/integration/simulate_endpoints.test.ts`](../test/integration/simulate_endpoints.test.ts)。

---

## 第12章 I/F契約・データ辞書 <a id="appendix-a-if"></a>

本章以降（第12〜16章）は、実装・検証のための静的参照（スキーマ、型、制約、コード表、レーン詳細）である。

**本章は規範（Normative）** であり、実装・運用・監査・契約の前提として固定される。
ここに無いものは「実装しても良いが、制度・接続の共通基盤として保証しない」。

> **採番について（旧付録記号の廃止）**：かつて独立していた付録A〜Iは本章以下の章番号ベースの節番号（`12.1`, `13.1`, …）へ移行済みである。旧記号は本書群では使用しない。対応は次のとおり。
>
> | 旧記号 | 現節 | 内容 |
> |---|---|---|
> | 付録A（A.0〜A.2） | §12.1〜§12.3 | I/F契約：cmd/event一覧・共通ヘッダ・データ辞書 |
> | （新設） | §12.4〜§12.6 | 冪等キーのスコープ・seq の粒度・署名対象と正規化 |
> | 付録D（D.0〜D.2） | §12.7〜§12.9 | パラメータ統制・対象カテゴリ・PR-* 台帳 |
> | 付録E | §13.1〜§13.6 | 主要メッセージのボディ定義 |
> | 付録F | §14.1〜§14.3 | LSM（Bulk向け流動性節約）詳細 |
> | 付録G | §15.1〜§15.6 | HTLC（hashlock+timelock）詳細 |
> | 付録H | §16.1〜§16.3 | Raft運用（合意ログ）詳細 |
> | 付録I | `20_method_design.md` §10.10 | CASE（例外収束）運用テンプレ |
> | 付録B・付録C | 廃止 | 用語は `10_requirements.md` 序章「Zenith 独自用語ミニディクショナリー」を参照 |



### 12.1 cmd/event一覧（正本）

本表は **ZC ⇄ 参加行のあいだで交換する cmd/event 名の正本**である。他文書のシーケンス図・本文が
名指すメッセージは、すべて本表に存在しなければならない。

> **FinalityLog の `event_type` とは別の語彙である。** 本表は「線の上を流れる電文」の名前を固定する。
> FinalityLog に追記される監査イベントの語彙はこれより広く（ZC 内部のライフサイクル事実を含む）、
> その正本は `src/types/api/messaging.ts#FinalityEventType` である。両者の関係は **§12.1.6** に示す。

#### 12.1.1 取引ライフサイクル（TX / GTID / RTP / PSPR / CASE）
| name | type | producer → consumer | aggregate | 再送条件（例） | 配送 | 順序制約 |
| --- | --- | --- | --- | --- | --- | --- |
| TxReceived | EVENT | ZC → Banks | TX:{txid} | 再送可 | at-least-once | txid内でevent_seq単調 |
| PaymentInitiated | EVENT | PayerBank → ZC | TX:{txid} | ACK未達/timeout | 同上 | txid内でevent_seq単調 |
| NameCheckRequested | COMMAND | ZC → PayeeBank | TX:{txid} | timeout/DLQ復旧 | 同上 | txid内でcommand_seq単調 |
| NameChecked | EVENT | PayeeBank → ZC | TX:{txid} | 同上 | 同上 | txid内でevent_seq単調 |
| AuthorityCheckRequested | COMMAND | ZC → Authority | TX:{txid} | timeout/DLQ復旧 | 同上 | txid内でcommand_seq単調 |
| AuthorityCleared | EVENT | Authority → ZC | TX:{txid} | 同上 | 同上 | txid内でevent_seq単調 |
| TransferAuthorize | COMMAND | PayerBank → ZC | TX:{txid} | ACK未達/timeout | 同上 | txid内でcommand_seq単調 |
| HReservationPlaced | EVENT | ZC → Banks | TX:{txid} | 再送可（冪等） | 同上 | txid内で単調 |
| PayerExecRequested | COMMAND | ZC → PayerBank | TX:{txid} | timeout/DLQ復旧 | 同上 | txid内でcommand_seq単調 |
| PayerExecConfirmed | EVENT | PayerBank → ZC | TX:{txid} | ACK未達/timeout | 同上 | txid内でevent_seq単調 |
| DecideToSettle | EVENT | ZC → Banks | TX:{txid} | 再送可 | 同上 | Finality Log順序 |
| DecidedCancel | EVENT | ZC → Banks | TX:{txid} | 再送可 | 同上 | Finality Log順序 |
| PayeeExecRequested | COMMAND | ZC → PayeeBank | TX:{txid} | timeout/DLQ復旧 | 同上 | txid内でcommand_seq単調 |
| PayeeExecConfirmed | EVENT | PayeeBank → ZC | TX:{txid} | ACK未達/timeout | 同上 | txid内でevent_seq単調 |
| NoDebitRecordedProofSubmitted | EVENT | PayerBank → ZC | TX:{txid} | 再送可 | 同上 | txid内でevent_seq単調 |
| CreditFailedProofSubmitted | EVENT | PayeeBank → ZC | TX:{txid} | 再送可（冪等） | 同上 | txid内でevent_seq単調 |
| HUnlockAuthorized | EVENT | ZC/Ops → Banks | TX:{txid} | 再送可 | 同上 | Finality Log順序 |
| MisrecordCorrected | EVENT | ZC/Ops → Banks | TX:{txid} | 再送可 | 同上 | Finality Log順序 |
| ReversalInitiated | EVENT | Bank → ZC | TX:{reversal_txid} | 再送可 | 同上 | txid内で単調 |
| CaseOpened | EVENT | ZC/Banks → ZC/Banks | CASE:{case_id} | 再送可 | 同上 | case内で単調 |
| CaseUpdated | EVENT | ZC/Banks → ZC/Banks | CASE:{case_id} | 再送可 | 同上 | case内で単調 |
| ExpressCapabilityChanged | EVENT | ZC → Banks | BANK:{bank_id} | 再送可 | 同上 | bank_id内で単調 |
| PspRegisterRequested | COMMAND | ZC → PayeeBank | PSPR:{pspr_ref} | timeout/DLQ復旧 | 同上 | pspr_ref内でcommand_seq単調 |
| PspRegistered | EVENT | PayeeBank → ZC | PSPR:{pspr_ref} | 再送可 | 同上 | pspr_ref内でevent_seq単調 |
| RtpRequested | EVENT | PayeeBank → ZC | RTP:{rtp_id} | 再送可 | 同上 | rtp_id内で単調 |
| RequestToAttempt | COMMAND | ZC → PayerBank | RTP:{rtp_id}:{attempt_id} | timeout/DLQ復旧 | 同上 | attempt内で単調 |
| AttemptResult | EVENT | PayerBank → ZC | RTP:{rtp_id}:{attempt_id} | 再送可 | 同上 | attempt内で単調 |
| GtLegRegistered | EVENT | Initiator → ZC | GT:{gtid} | 再送可 | 同上 | gtid内で単調 |
| GtDecideToSettle | EVENT | ZC → Banks | GT:{gtid} | 再送可 | 同上 | gtid内で単調 |
| GtDecidedCancel | EVENT | ZC → Banks | GT:{gtid} | 再送可 | 同上 | gtid内で単調 |
| LegPayeeExecConfirmed | EVENT | PayeeBank → ZC | LEG:{gtid}:{leg_id} | 再送可 | 同上 | leg内で単調 |
| LsmRunCommitted | EVENT | ZC → Banks | WINDOW:{window_id} | 再送可 | 同上 | window内で単調 |
| LsmRunFallback | EVENT | ZC → Banks | WINDOW:{window_id} | 再送可 | 同上 | window内で単調 |
| GtLegReadyRequested | COMMAND | ZC → Banks | LEG:{gtid}:{leg_id} | timeout/DLQ復旧 | 同上 | leg内でcommand_seq単調 |
| GtLegReadyAcked | EVENT | Banks → ZC | LEG:{gtid}:{leg_id} | ACK未達/timeout | 同上 | leg内でevent_seq単調 |
| RtpNotified | COMMAND | ZC → PayerBank | RTP:{rtp_id} | timeout/DLQ復旧 | 同上 | rtp_id内でcommand_seq単調 |
| RtpExecuteNowRequested | COMMAND | PayerBank → ZC | RTP:{rtp_id} | ACK未達/timeout | 同上 | rtp_id内でcommand_seq単調 |
| RtpDeferred | EVENT | PayerBank → ZC | RTP:{rtp_id} | 再送可 | 同上 | rtp_id内でevent_seq単調 |
| TransferStarted | EVENT | ZC → Banks | TX:{txid} | 再送可 | 同上 | txid内でevent_seq単調 |
| InternalCancelAccepted | EVENT | PayerBank → ZC | TX:{txid} | 再送可 | 同上 | txid内でevent_seq単調 |
| CustomerCancelRequested | EVENT | PayerBank → ZC | TX:{txid} | 再送可 | 同上 | txid内でevent_seq単調 |

#### 12.1.2 HTLC・クロスチェーン・条件付き決済
| name | type | producer → consumer | aggregate | 再送条件（例） | 配送 | 順序制約 |
| --- | --- | --- | --- | --- | --- | --- |
| HtlcLocked | EVENT | ZC → Banks | TX:{txid} | 再送可 | at-least-once | txid内でevent_seq単調 |
| HtlcClaimRejected | EVENT | ZC → Banks | TX:{txid} | 再送可 | 同上 | txid内でevent_seq単調 |
| HtlcConditionsEvaluated | EVENT | ZC → Banks | TX:{txid} | 再送可 | 同上 | txid内でevent_seq単調 |
| CrossChainLocked | EVENT | Watcher → ZC | TX:{txid} | 再送可（冪等） | 同上 | txid内でevent_seq単調 |
| OnchainProofObserved | EVENT | Watcher → ZC | TX:{txid} | 再送可（冪等） | 同上 | txid内でevent_seq単調 |
| OnchainFinalityClassified | EVENT | ZC → Banks | TX:{txid} | 再送可 | 同上 | txid内でevent_seq単調 |
| BenefitAttested | EVENT | ZC → Banks | TX:{txid} | 再送可 | 同上 | txid内でevent_seq単調 |

#### 12.1.3 外部清算（IGS／DNS／中央銀行レール）
| name | type | producer → consumer | aggregate | 再送条件（例） | 配送 | 順序制約 |
| --- | --- | --- | --- | --- | --- | --- |
| DnsHoldRequested | EVENT | ZC → Banks | DNS:{business_date} | 再送可 | at-least-once | 日次内で単調 |
| DnsHoldActivated | EVENT | ZC → Banks | DNS:{business_date} | 再送可 | 同上 | 日次内で単調 |
| DnsResumed | EVENT | ZC → Banks | DNS:{business_date} | 再送可 | 同上 | 日次内で単調 |
| DnsIntradayCutoff | EVENT | ZC → Banks | DNS:{business_date} | 再送可 | 同上 | 日次内で単調 |
| ExtInstructionSent | EVENT | ZC → （記録） | TX:{txid} | 再送可（`ext_instruction_id` で冪等） | 同上 | txid内でevent_seq単調 |
| ExtResultObserved | EVENT | ESA → ZC | TX:{txid} | 再送可（冪等） | 同上 | txid内でevent_seq単調 |
| ExtResultReconciled | EVENT | ZC → Banks | TX:{txid} | 再送可 | 同上 | txid内でevent_seq単調 |
| CbSettled | EVENT | ESA → ZC | TX:{txid} | 再送可（冪等） | 同上 | txid内でevent_seq単調 |
| CbPending | EVENT | ESA → ZC | TX:{txid} | 再送可（冪等） | 同上 | txid内でevent_seq単調 |

#### 12.1.4 所有権・システム運用
| name | type | producer → consumer | aggregate | 再送条件（例） | 配送 | 順序制約 |
| --- | --- | --- | --- | --- | --- | --- |
| OwnershipTransferred | EVENT | ZC → （記録） | TX:{txid} | 再送不可（CAS で1回） | at-least-once | txid内でevent_seq単調 |
| OwnershipReclaimed | EVENT | ZC → （記録） | TX:{txid} | 再送不可（CAS で1回） | 同上 | txid内でevent_seq単調 |
| SystemQuorumLossActivated | EVENT | ZC → Banks | GLOBAL | 再送可 | 同上 | GLOBALチェーン内で単調 |
| SystemQuorumLossCleared | EVENT | ZC → Banks | GLOBAL | 再送可 | 同上 | GLOBALチェーン内で単調 |
| SystemBcpActivated | EVENT | ZC/Ops → Banks | GLOBAL | 再送可 | 同上 | GLOBALチェーン内で単調 |
| SystemBcpDeactivated | EVENT | ZC/Ops → Banks | GLOBAL | 再送可 | 同上 | GLOBALチェーン内で単調 |
| DataAccessViolationDetected | EVENT | ZC → Ops/監査 | GLOBAL | 再送可 | 同上 | GLOBALチェーン内で単調 |
| ClosedDomainAccessGranted | EVENT | ZC → Ops/監査 | GLOBAL | 再送可 | 同上 | GLOBALチェーン内で単調 |

#### 12.1.5 図中略記と正式名の対応（規範）

`20_method_design.md` 第2章のシーケンス図は、可読性のため UPPER_SNAKE の略記と
`CMD`/`EVT` 接頭辞を用いる。**正式名は本節（§12.1）であり、図中表記は略記に過ぎない。**
両者の対応は次のとおり固定する（図に新しいメッセージを描く場合は、本表と §12.1.1〜§12.1.4
への追加を同じ変更で行う）。

| 図中の略記 | 正式名 |
|---|---|
| `PSPR_REGISTER` | `PspRegisterRequested` |
| `TransferAccept` / `GroupAccept` / `HTLC_ACCEPT` | `PaymentInitiated` |
| `NAMECHECK_REQUEST` / `NAMECHECK_RESULT` / `NAMECHECK_PRESENT` | `NameCheckRequested` / `NameChecked` |
| `AUTHORITY_CHECK` / `AUTHORITY_RESULT` / `AUTHORITY_PRESENT` / `AUTHORITY_RECHECK_IF_NEEDED` | `AuthorityCheckRequested` / `AuthorityCleared` |
| `PAYER_EXEC_REQUEST` / `PAYER_EXEC_CONFIRMED` | `PayerExecRequested` / `PayerExecConfirmed` |
| `PAYEE_EXEC_REQUEST` / `PAYEE_EXEC_CONFIRMED` | `PayeeExecRequested` / `PayeeExecConfirmed` |
| `LEG_READY_REQUEST` / `LEG_READY_ACK` | `GtLegReadyRequested` / `GtLegReadyAcked` |
| `RTP_REQUESTED` | `RtpRequested` |
| `REQUEST_TO_ATTEMPT` / `ATTEMPT_RESULT` | `RequestToAttempt` / `AttemptResult` |
| `RTP_NOTIFY` / `RTP_EXECUTE_NOW` / `RTP_DEFERRED` | `RtpNotified` / `RtpExecuteNowRequested` / `RtpDeferred` |
| `START_TRANSFER` / `STARTED` | `TransferStarted` |
| `BOJ_SETTLE_REQUEST` | `ExtInstructionSent` |
| `CB_SETTLED` / `EVT_CB_SETTLED` / `IGS_RESULT` / `BOJ_SETTLED` | `CbSettled` |
| `BOJ_PENDING` | `CbPending` |
| `INTERNAL_CANCEL_ACCEPTED` | `InternalCancelAccepted` |
| `EXT_INSTRUCTION_SENT` / `EXT_RESULT_OBSERVED` / `EXT_RESULT_RECONCILED` | `ExtInstructionSent` / `ExtResultObserved` / `ExtResultReconciled` |
| `DNS_HOLD_REQUESTED` / `DNS_HOLD_ACTIVE` / `DNS_RESUMED` | `DnsHoldRequested` / `DnsHoldActivated` / `DnsResumed` |
| `READ_ONLY_ENTERED` / `READ_ONLY_EXITED` | 縮退の種別ごとに `SystemQuorumLossActivated` / `SystemQuorumLossCleared`（原則10の自動縮退）または `SystemBcpActivated` / `SystemBcpDeactivated`（運用者宣言）|

#### 12.1.6 FinalityLog の `event_type` との関係（規範）

§12.1 の cmd/event（I/F 語彙）と、FinalityLog に追記される `event_type`（監査語彙）は
**別の集合**であり、部分的にしか重ならない。混同すると「この電文名で監査ログを引けるはずだ」
という誤った期待を生むため、関係を明示する。

```
  §12.1 cmd/event（I/F 語彙）        FinalityEventType（監査語彙）
  ┌──────────────────┐
  │ NameCheckRequested        │      ZC 内部のライフサイクル事実
  │ PayerExecRequested        │      （PreCheckPassed / HReserved /
  │ GtLegReadyRequested   …   │       Suspended / Settled / DnsKicked …）
  │                ┌──────────┼──────────────────┐
  │                │  同名で FinalityLog にも記録される（下記 1.）  │
  │                └──────────┼──────────────────┘
  └──────────────────┘
```

**1. 同名で FinalityLog にも記録されるもの（30 件）**

集合の正は下記の列挙であり、CI が実装の列挙型と機械照合する。

`PaymentInitiated` / `PayerExecConfirmed` / `PayeeExecConfirmed` / `DecidedCancel` /
`NoDebitRecordedProofSubmitted` / `CreditFailedProofSubmitted` / `HUnlockAuthorized` /
`MisrecordCorrected` / `RtpRequested` /
`LsmRunCommitted` / `LsmRunFallback` / `HtlcLocked` / `HtlcClaimRejected` /
`HtlcConditionsEvaluated` / `CrossChainLocked` / `OnchainProofObserved` /
`OnchainFinalityClassified` / `BenefitAttested` / `DnsHoldRequested` / `DnsHoldActivated` / `DnsResumed` /
`DnsIntradayCutoff` / `OwnershipTransferred` / `OwnershipReclaimed` /
`SystemQuorumLossActivated` / `SystemQuorumLossCleared` / `SystemBcpActivated` /
`SystemBcpDeactivated` / `DataAccessViolationDetected` / `ClosedDomainAccessGranted`

**2. I/F 語彙のみ（FinalityLog には別名で、または個別には記録されない）**
：`NameCheckRequested` / `PayerExecRequested` / `GtLegReadyRequested` 等の**要求・応答電文**。
これらの結果は状態遷移イベント（`PreCheckPassed`・`HReserved`・`DecidedToSettle` 等）として
記録される。

**3. 監査語彙のみ（線の上を流れない ZC 内部事実）**
：`PreCheckPassed` / `PreCheckFailed` / `HReserved` / `DecidedToSettle` / `Suspended` /
`Settled` / `Cancelled` / `FailedExecution` / `GtidRegistered` / `GtidDecided` / `GtidSettled` /
`DnsKicked` / `DnsSettled` / `DnsHoldActivated` / `DnsRingfencePromoted` / `IgsDeferred` /
`HtlcCreated` / `HtlcFulfillRequested` / `HtlcAuthRequested` / `FinalityCosigned` /
`WatcherEquivocationDetected` 等。

**規範**

- FinalityLog の `event_type` 列の値域は `src/types/api/messaging.ts#FinalityEventType` を正とする
  （`31_schema.md § FinalityLog`）。本書 §12.1 は**この列の値域ではない**。
- 上記 1. の集合は「§12.1 の名前 ∩ `FinalityEventType`」と一致しなければならない
  （`test/invariants/spec_refs.test.ts` が機械照合する）。§12.1 に新しい EVENT を足し、
  それを同名で FinalityLog にも記録するなら、1. のリストと `FinalityEventType` の両方を
  同じ変更で更新すること。

### 12.2 共通ヘッダ（全cmd/event：固定）
```json
{
  "schema_version": "1.0",
  "message_type": "COMMAND|EVENT",
  "name": "PaymentInitiated|PayerExecRequested|...",
  "message_id": "uuid",
  "occurred_at": "RFC3339",
  "idempotency_key": "string",
  "command_seq": 123,
  "event_seq": 456,
  "correlation_id": "uuid",
  "causation_id": "uuid",
  "producer": { "org_id": "string", "system_id": "string" },
  "signature": {
    "alg": "POLICY_DEFINED",
    "canonicalization": "FIXED",
    "signed_fields": ["..."],
    "value": "base64"
  }
}
```



**規範（固定）**
- `command_seq` / `event_seq` は **永続・単調増加（巻戻り不可）** 。欠番は許容するが再利用不可。  
- **COMMANDは `command_seq` 必須 / `event_seq` はnullまたは省略。EVENTは `event_seq` 必須 / `command_seq` はnullまたは省略。 ** （両方を同時必須にしない）  
- 粒度： **送信者×aggregate**（§12.5）。  
- `correlation_id` は業務トレース単位で継承。 `causation_id` は直前因果。  
- 署名は **対象範囲と正規化を固定**（§12.6）。



### 12.3 データ辞書（最小十分：揉めどころ固定）

#### 12.3.1 識別子
| field | required | type | maxLen | null | constraint |
| --- | --- | --- | --- | --- | --- |
| txid | 条件 | string | 64 | 可 | 一意 |
| gtid | 条件 | string | 64 | 可 | 一意 |
| leg_id | 条件 | string | 64 | 可 | gtid内一意 |
| rtp_id | 条件 | string | 64 | 可 | 一意 |
| attempt_id | 条件 | int | - | 可 | `1..PR-RTP-ATTEMPT-MAX`（§12.9） |
| case_id | 条件 | string | 64 | 可 | 一意 |

#### 12.3.2 金額
| field | required | type | constraint |
| --- | --- | --- | --- |
| amount.value | 必須 | int | >0 |
| amount.currency | 必須 | string | ISO通貨（運用でJPY固定可） |
| amount_components[] | 条件 | array | 内訳列挙 |
| calculation_version | 必須 | string | 版管理 |
| trace_digest | 必須 | string | 改ざん検知 |

#### 12.3.3 Proof参照（bank_proof_ref：固定）
b証憑（`PAYEE_EXEC_PROOF`）は、単なるACKではなく、**銀行内部の台帳記録**を指し示すものでなければならない。

```json
{
  "bank_proof_ref": {
    "issuer_bank_id": "B001",
    "proof_type": "PAYEE_EXEC_PROOF",
    "proof_id": "core_journal_id_12345",
    "recorded_at": "RFC3339",
    "retrieval_hint": "...",
    "custody_detail": {
      "is_custody": true,
      "reason_code": "ACCOUNT_CLOSED",
      "custody_account_ref": "segregated_custody_acct_001"
    }
  }
}
```

- **規範** ：`proof_id` は後日の監査において、銀行の勘定系元帳（GL）と突合可能でなければならない。
- `custody_detail` は Custody 発生時のみ付与し、Custodyでない場合は省略してよい。

##### `proof_type` の値域（規範）

`proof_type` は自由文字列ではなく、次の閉じた集合とする。追加は本表の更新を伴う。

**現行の値域**（実装の正: `src/types/primitives.ts#ProofType`: `PAYER_EXEC_PROOF` | `PAYER_HV_ISOLATION_PROOF` | `PAYEE_EXEC_PROOF` | `NO_DEBIT_RECORDED_PROOF` | `ONCHAIN_ESCROW_LOCK_PROOF` | `ONCHAIN_RELEASE_PROOF` | `CREDIT_FAILED_PROOF` | `EXT_REFUND_PROOF`）

| proof_type | 発行主体 | 意味 | 参照 |
|---|---|---|---|
| `PAYER_EXEC_PROOF` | PayerBank | a（支払人側実施完了）の証憑 | `20_method_design.md` §6.3.1 |
| `PAYER_HV_ISOLATION_PROOF` | PayerBank | **a_HV**：顧客口座→清算専用中継勘定への資金隔離完了。**ZC はこの proof_type を受領した場合にのみ中銀決済（IGS）を起動する** | `10_requirements.md` §1.2.3、`20_method_design.md` §1.5.1 |
| `PAYEE_EXEC_PROOF` | PayeeBank | b（受取人側利用可能化＝弁済完了）の証憑 | `20_method_design.md` §6.3.1 |
| `NO_DEBIT_RECORDED_PROOF` | PayerBank | 未実行証明。H_locked の自動解放根拠 | `20_method_design.md` §6.4.1 |
| `ONCHAIN_ESCROW_LOCK_PROOF` | 外部レール（Watcher 観測） | 同一 `hashlock` 下のオンチェーンエスクローがロックされた事実 | 本書 §15.6、`20_method_design.md` §7.7 |
| `ONCHAIN_RELEASE_PROOF` | 外部レール（Watcher 観測） | `hashlock` に一致する preimage でオンチェーンエスクローが解放された事実 | 本書 §15.6、`20_method_design.md` §7.7 |
| `CREDIT_FAILED_PROOF` | PayeeBank | 物理的に資金移動が不能であることの証明。**Reversal を許容する唯一の原因事由**。受理は `POST /api/transfers/:txid/credit-failed-proof`（`32_api_contracts.md`）で、b 成立後・PayeeBank 発行・口座都合でないことを検査する | `10_requirements.md` §4.3.0、`20_method_design.md` §6.3.2 |
| `EXT_REFUND_PROOF` | PayerBank | 中銀決済が不成立（FAILED/HOLD）となった際の、隔離資金の内部復元証跡。**銀行間 Reversal の前提にしない**——資金は支払銀行から出ていないので、行間で巻き戻すものが無い | `10_requirements.md` §1.2.3 |

> **規範（`proof_type` と `venue` は直交する別軸）** ：`SettlementProofRef` は
> `BankProofRef` の別名であって `proof_type` の値ではない。「どの決済場で確定したか」は
> **`venue` 列**（`BANK_LEDGER` / `IGS_BOJ` / `ONCHAIN` / `ATTESTATION` / `CB_TOKEN`、
> 実装の正: `src/types/primitives.ts#ProofVenue`）が担い、`proof_type` は
> 「その証憑が何を証明しているか」を担う。両者を同じ列挙に混ぜてはならない
> （契約は `32_api_contracts.md § SettlementProofRef`）。

> **規範（HV の起動条件）** ：高額即時レーンにおいて、`PayerExecConfirmed` の
> `bank_proof_ref.proof_type` が `PAYER_HV_ISOLATION_PROOF` でない場合、ZC は
> `ExtInstructionSent`（中銀決済依頼）を発行してはならない。外形上の状態は
> `PAYER_EXEC_CONFIRMED`（a）と同一であるため、**区別は proof_type だけが担う**。

### 12.4 idempotency_key のスコープ（規範）

冪等キーは「どの論理コマンドの再送か」を一意に決める。**スコープを取り違えると
txid / gtid / leg / attempt が混線し、別々の指図が同一要求として吸収される**——
本節はその混線を構造的に防ぐためにキー空間を固定する。

**書式（固定）**

```
TX:{txid}:{name}:{issuer}
GT:{gtid}:{name}:{issuer}
LEG:{gtid}:{leg_id}:{name}:{issuer}
RTP:{rtp_id}:{attempt_id}:{name}:{issuer}
CASE:{case_id}:{name}:{issuer}
```

| 要素 | 意味 | 制約 |
|---|---|---|
| 先頭トークン | aggregate 種別（`TX`／`GT`／`LEG`／`RTP`／`CASE`） | 閉じた集合。新設は本節の更新を伴う |
| 識別子部 | 当該 aggregate の主キー。`LEG` は gtid と leg_id の両方、`RTP` は rtp_id と attempt_id の両方を含む | 省略不可 |
| `{name}` | §12.1 の正式名 | §12.1 に存在する名前のみ |
| `{issuer}` | 発行主体の `org_id`（`producer.org_id` と一致） | 省略不可 |

**規範**

1. **同一キー＝同一要求** ：同一 `idempotency_key` の再送に対し、受信側は副作用を
   1 回だけ発生させ、保存済みの応答を返す（`32_api_contracts.md § 冪等性`）。
2. **識別子部の省略禁止** ：`LEG` から `leg_id` を、`RTP` から `attempt_id` を落として
   はならない。落とすと同一 gtid の別 leg、同一 rtp_id の別 attempt が同一要求として
   吸収され、**片方の指図が黙って消える**。
3. **`{issuer}` の省略禁止** ：発行主体が異なれば別のキーである。省略すると、ZC 発行の
   コマンドと参加行発行のイベントが衝突し得る。
4. **キーの再利用禁止** ：ボディが異なる同一キーの再使用は `409 IDEMPOTENCY_KEY_CONFLICT`
   （ボディ同一性はリクエスト全体の SHA-256 で判定。`src/shared/idempotency.ts`）。
5. **単発キーの例外** ：署名リプレイ防止用の `sig:{key_id}:{nonce}` はボディ比較の対象外
   （ハッシュ未保存・常に非衝突）。

実装: `src/shared/idempotency.ts`（`acquireIdempotency` / `completeIdempotency` /
`resolveIdempotency`）、テーブルは `31_schema.md § IdempotencyKeys`。

### 12.5 command_seq / event_seq の粒度（規範）

seq は「どの範囲で単調であることを契約するか」を決める。全体順序は**要求しない**
（`20_method_design.md` §5.1）。

- **粒度＝送信者 × aggregate** 。すなわち `(producer.org_id, aggregate)` の組ごとに
  独立したカウンタを持つ。aggregate の表記は §12.4 の先頭トークン＋識別子部と同一
  （`TX:{txid}`／`GT:{gtid}`／`LEG:{gtid}:{leg_id}`／`RTP:{rtp_id}:{attempt_id}`／
  `CASE:{case_id}`／`BANK:{bank_id}`／`PSPR:{pspr_ref}`／`WINDOW:{window_id}`／
  `DNS:{business_date}`／`GLOBAL`）。
- **永続・単調増加・巻戻り不可** 。プロセス再起動をまたいでも巻き戻らないこと。
- **欠番は許容、再利用は禁止** 。欠番は配送欠落・破棄として説明できるが、再利用は
  「同じ seq で別の内容」を生み監査が破綻する。
- **COMMAND は `command_seq` 必須／`event_seq` は null または省略。EVENT は `event_seq`
  必須／`command_seq` は null または省略**（両方を同時必須にしない。§12.2）。
- **受信側の検証義務** ：Kafka 等のキー順序に依存する場合でも、アプリ層で seq を検証する
  （`20_method_design.md` §5.5）。ギャップは許容、巻戻りは拒否。

> **ZC 内部の event_seq との関係** ：上記は**参加行との I/F 契約**上の粒度である。
> ZC が FinalityLog へ書く `event_seq` は、これとは別に `FinalitySeq` 単一行の
> `UPDATE ... RETURNING` で大域単調に採番される（§4 不変条件、§7.2）。両者を混同しないこと。

### 12.6 署名対象（signed_fields）と正規化（canonicalization）（規範）

署名は「アルゴリズム」より先に「**何を署名するか**」と「**どうバイト列に落とすか**」を
固定する。ここが揺れると、後日の監査・訴訟で「その署名は何を保証していたのか」が
争点になる。

#### 12.6.1 署名対象（signed_fields）

**最小必須集合（すべての cmd/event で署名対象に含める）**

| フィールド | 理由 |
|---|---|
| `schema_version` | 世代の取り違えによる再解釈を防ぐ（`32_api_contracts.md § スキーマ進化`） |
| `message_type` / `name` | COMMAND と EVENT、別名メッセージの取り違えを防ぐ |
| `message_id` | メッセージ同一性 |
| `occurred_at` | 時刻の後付け改変を防ぐ（`TIMESTAMP_SKEW` 検査の対象） |
| `idempotency_key` | §12.4 のスコープごと署名対象に含める |
| `command_seq` / `event_seq` | 順序の改変を防ぐ（該当する方のみ） |
| `correlation_id` / `causation_id` | 因果リンクの改変を防ぐ |
| `producer.org_id` / `producer.system_id` | 発行主体のなりすまし防止 |
| ボディ側の**金額・識別子・時刻・相関ID・証憑参照** | `20_method_design.md` §7.3 の最低限 |

**規範**

1. `signature.signed_fields` には、実際に署名対象としたフィールドの**完全な列挙**を
   JSON Pointer 形式（`/amount/value` 等）で昇順に記載する。
2. **署名対象外のフィールドを増やしてはならない。** 新フィールドを加法的に追加する場合
   （`32_api_contracts.md § スキーマ進化` の「加法的・任意」）も、そのフィールドが業務上の
   意味を持つなら署名対象へ入れる。「任意フィールドだから署名しない」は禁止する——
   署名されない業務フィールドは、経路上で書き換えても検出できない。
3. `signed_fields` に列挙されていないフィールドは、**受信側が業務判断に用いてはならない**。

#### 12.6.2 正規化（canonicalization）

`signature.canonicalization` の値は `FIXED` とし、次の手順を指す。

1. `signed_fields` の各 JSON Pointer が指す値を、**列挙順**に取り出す。
2. 各値を次のとおり文字列化する。
   - 文字列: そのまま（Unicode 正規化は **NFC**）
   - 整数: 十進表記、先行ゼロなし、負号は `-`
   - 真偽: `true` / `false`
   - null / 不在: 空文字列
   - 配列・オブジェクト: 本手順を再帰適用し、要素を `,` で連結
3. 得られた文字列を **`|`（U+007C）で連結**する（FinalityLog の `entry_hash` と同じ区切り。
   `20_method_design.md` §8.2.1）。
4. UTF-8 でエンコードしたバイト列を署名対象とする。

**規範**

- 浮動小数点は署名対象に含めない（金額は整数、レートは整数固定小数。`20_method_design.md` §17.3.1）。
- JSON のキー順・空白・エスケープ表現は正規化の入力にしない（**値だけを順序どおり連結する**）。
  これにより JSON シリアライザの実装差が署名の可否を左右しない。
- **本手順は破壊的変更の対象としない。** 変更が必要な場合は `canonicalization` に
  新しい値（`FIXED_V2` 等）を導入し、`32_api_contracts.md § スキーマ進化` の n / n-1
  併存受理に従って移行する。

#### 12.6.3 検証側の義務

- 署名検証は**メッセージ単位**で行う（`20_method_design.md` §7.1 ゼロトラスト）。
- 鍵は `KeyRegistry`（`31_schema.md § KeyRegistry`）で解決し、`revoked_at` は**非遡及**
  （`occurred_at < revoked_at` の署名は有効。`10_requirements.md` §3.3.4）。
- 失敗時の `reason_code` は `32_api_contracts.md § エラーカタログ` の
  `EXTERNAL_SIGNATURE_INVALID` / `KEY_NOT_FOUND` / `KEY_REVOKED` / `KEY_EXPIRED` /
  `SIGNATURE_REPLAYED` / `TIMESTAMP_SKEW` に写す。

実装: `src/shared/external_signature.ts`（外部主体の検証）、`src/shared/zc_signature.ts`
（ZC egress の非対称署名）、`src/shared/hmac.ts`（旧方式の後方互換パス）。

#### 12.6.4 共有 HMAC のローテーション重複窓（規範）

`ZC_HMAC_SECRET` は**全参加者が同じ値を持つ対称鍵**であり、非対称鍵（§12.6.3）と違って
`key_id` 単位の差し替えができない。重複窓が無ければ交換は全か無かの切替になり、ZC が新しい
値で検証を始めた瞬間に旧値で署名している相手が全て 401 になる——結果として**運用上は決して
ローテーションされない**という、共有鍵にとって最悪の定常状態に落ち着く。したがって次を規範と
する。

- **署名は常に現行値のみ**。旧値で署名してはならない（対外的な切替は瞬時に完了する）。
- **検証は旧値も受理する。ただし期限まで**。旧値は `ZC_HMAC_SECRET_PREVIOUS`、期限は
  `ZC_HMAC_SECRET_PREVIOUS_UNTIL`（RFC3339）で与える。期限到来後は**再デプロイなしに**
  受理をやめる（窓は時計が閉じるのであって、人が変数を消し忘れないことに依存しない）。
- **期限の無い旧値は無効**とする（fail-closed）。期限の無い 2 本目は重複窓ではなく
  「生きた鍵が 2 本ある」状態であり、本項が防ごうとしているものそのものである。解釈不能な
  期限も同じく無効として扱い、いずれの場合も警告を残す。
- 同じ扱いは **bearer / API キーとしての比較**（`X-Api-Key`・`Authorization`）にも適用する。
  比較は定数時間で行い、**どの値に一致したかを応答時間から区別できない**ようにする
  （窓の開いている間、捕獲した鍵が現行か退役中かを attacker に教えないため）。

実装: `src/shared/secret_rotation.ts`。

#### 12.6.5 `/api/*` の外周認証（規範）

ZC Core API に到達した呼び出し元を認証するのは **資格情報だけ**である。リクエストヘッダは
呼び出し元が自由に設定できる以上、ヘッダから「これは自分のダッシュボードだ」と推論しては
ならない。特に **`Origin` の不在を同一オリジンの証拠として扱ってはならない**——`Origin` は
ブラウザのヘッダであり、curl・スクリプト・サーバ間呼び出しは既定で付けない。不在を許可条件に
すると、**排除したかった呼び出し元だけが通る**という反転が起きる（`Sec-Fetch-Site` も同様。
ページには設定できないがクライアントには設定できるので、非ブラウザの攻撃者には何も証明しない）。

鍵無しの経路は**推論ではなく運用上の明示的な選択**としてのみ残す：同梱のデモ用ダッシュボードの
ために `ZC_ALLOW_UNAUTHENTICATED_UI="true"` を設定したときに限り、同一オリジンの無資格
呼び出しを通す。**既定は off**——何も書かなかったデプロイは閉じている。有効時は 1 リクエスト
ごとに警告ログ（`http.unauthenticated_ui_access`）を残し、**この設定を入れた配備は API を
公開したのだと読むこと**。同一オリジン判定はブラウザ向けの礼儀であって、第二の要素ではない。

このフラグが、**UI から鍵なしで取引する（`/api/*` の POST を含む）ための公式かつ唯一の経路**
である。参照リファレンスとしては UI から手で動かせることに価値があるが、その手段は
**隠れた迂回路（バックドア）ではなく、明示・opt-in・可視のフラグ**でなければならない——
規範として理由を固定する：**リファレンスはコピーされるため、認証を迂回する隠れた経路を
コードに置くと、複製した配備がその迂回路ごと本番に出る**（本章が塞いだ `Origin` 欠落の穴と
同型）。ゆえに鍵無し経路を追加する場合も、常にこの 3 条件——既定 off・明示的な env による
opt-in・1 リクエストごとの記録——を満たすこと。ハードコードされた常時許可、未文書の
マジックヘッダ、常に通る秘密値の類は置いてはならない。

なお `/internal/*` は `X-Cron-Secret` の定数時間比較で fail-closed（`src/router/internal.ts`）、
`/bank/*` の ZC→Bank ingress は署名検証（§12.6.3）で、それぞれ別の資格情報に依っている。

実装: `src/shared/api_auth.ts`（判定）、`src/index.ts`（適用）。

### 12.7 パラメータ統制（公開版）
- パラメータはカテゴリ単位で管理し、変更時は **変更証跡（evidence_ref）** と周知期間を必須とする。
- 変更は「変更管理（合意・証跡）」「監督説明」「参加者運用」のいずれに属するかを明確化し、責任主体を固定する。

### 12.8 対象カテゴリ（例）
- Express：PSPR有効期限、同期受付の目標遅延
- Standard：名義確認/Authority Checkのタイムアウト、保留→CASEへの収束期限
- Decision：受理→DECIDED_* の最大待ち、取消/保留境界
- RTP：Attempt回数（`PR-RTP-ATTEMPT-MAX`）・推奨時刻（`PR-RTP-ATTEMPT-SCHEDULE`）（当日収束のための自動再挑戦）
- gtid：legs固定後の変更不可、収束タイムアウト、総額上限
- Vault：保持上限、削除トリガ、退避（Evict）運用
- Consensus/Delivery：過半数合意を満たすノード構成、配送モデル（at-least-once）、冪等（seq巻戻り禁止）
- Crisis：DNS_HOLD/IGS制御（`igs_mode`）、`dns_recovery_reserve` 算定の信頼度閾値（`reserve_confidence`）、公平性スロットリング（`igs_throttle_budget`）

> **設計規範（Vault保持と情報喪失リスクの排除）**  
> Vaultは短期保持を基本としつつ、Decisionに必要な情報が保持上限超過で失われないよう、上限到達時は**退避（Evict）**して参照を残す。  
> 退避時は参照IDを発行し、参加主体側またはWORM複製へ自動移送する。  
> これにより「Decisionに必要な情報が消える」事故を規範として禁止する。

### 12.9 PR-* パラメータ台帳 <a id="pr-params"></a>

本文（`10_requirements.md`・`20_method_design.md`）中に `PR-*` として登場する規程パラメータの索引。値そのものは制度（規程）で確定し、公開版では非公開のものがある。「所定時間」「所定水準」等の伏せ字も本台帳のカテゴリに属する。

| パラメータ名 | 意味 | 単位 | 確定主体 | 公開可否 | 本文での参照箇所 |
| --- | --- | --- | --- | --- | --- |
| `PR-GTID-TTL` | GTID の一部 leg 未成立を `GT_SUSPENDED` に収束させるまでの許容時間 | 時間 | 制度（規程） | 非公開（Public版） | `10_requirements.md` §3.2.4-5 |
| `PR-LIQ-COVER2_FACTOR` | cover-2 算定で加算する第2位ネット債務者の割合 | 比率 | 制度（規程） | 非公開 | `10_requirements.md` §3.2.5.3 |
| `PR-DATA-VIOLATION_NOTIFY_TTL` | 重大データアクセス違反の当局・本会・監査への通知期限 | 時間 | 制度（規程） | 非公開 | `10_requirements.md` §3.3.2.2.1.1-4 |
| `PR-SOFT-LIMIT` | Express の条件付き Soft Reservation を許容する1取引上限（例: 5万円） | 金額 | 制度（規程） | 公開（例示値） | `20_method_design.md` §13.7.2 |
| `PR-HV-THRESHOLD` | `EXPRESS`/`STANDARD` を `HIGH_VALUE` へ自動エスカレーションする金額閾値。変更は所定の承認権者（4眼）のみ（技術既定＝最終フォールバックは 1 億円、`src/shared/constants.ts#DEFAULT_HV_THRESHOLD`）。参加行個別の上書きは `Participants.hv_threshold`、システム共通の上書きは環境変数 `ZC_HV_THRESHOLD` | 金額 | 制度（規程） | 公開（例示値） | `10_requirements.md` §3.2.7 |
| `PR-RTP-ATTEMPT-MAX` | RTP の当日 Attempt 回数上限（`attempt_id` の上限値） | 回 | 制度（規程） | 非公開（Public版） | `10_requirements.md` §1.2.1、`20_method_design.md` §2.2.3・§10.4、本書 §12.3.1 |
| `PR-RTP-ATTEMPT-SCHEDULE` | RTP の各 Attempt の推奨実行時刻 | 時刻列 | 制度（規程） | 非公開（Public版） | `20_method_design.md` §2.2.3 |
| `PR-DD-PERIOD-AHEAD-MAX` | 継続収納（`PERIODIC` 費目）で受理する将来期間の上限。これを超える先の期間を費目に指定した予告は受理しない | 期間 | 制度（規程） | 非公開（Public版） | `10_requirements.md` §3.2.8.3-4 |
| `PR-DD-AMEND-FREEZE` | 収納予告の変更受付を凍結する時刻（振替日から遡る相対値）。凍結後は不利益変更のみを止め、減額・取下げは受け付ける | 時間 | 制度（規程） | 非公開（Public版） | `10_requirements.md` §3.2.8.5-2 |
| `PR-DD-LADDER-MAX` | 事前登録ラダーの段数上限（制度上限。契約はこれ以下の値を宣言する） | 段 | 制度（規程） | 非公開（Public版） | `10_requirements.md` §3.2.8.5-9 |
| `PR-DD-LATEFEE-RATE-MAX` | 継続収納の遅延損害金の率上限（年率）。契約はこれ以下の値を宣言する。適法性の判断は各参加主体の責任であり ZC は行わない | 比率 | 制度（規程） | 非公開（Public版） | `10_requirements.md` §3.2.8.5-11 |
| `PR-DD-LATEFEE-CAP` | 継続収納の遅延損害金の絶対額上限 | 金額 | 制度（規程） | 非公開（Public版） | `10_requirements.md` §3.2.8.5-11 |
| `PR-SLO-STANDARD-P99` | Standard の end-to-end latency SLO（`20_method_design.md` §10.9.1 の X） | 秒 | 制度（規程） | 非公開 | `20_method_design.md` §10.9.1・§16.2 |
| `PR-SLO-RTP-P99` | RTP の acceptance-to-b latency SLO（同 Y） | 秒 | 制度（規程） | 非公開 | `20_method_design.md` §10.9.1・§16.2 |
| `PR-SLO-BULK-COMPLETION` | Bulk の期限内完了率 SLO（同 Z） | 比率 | 制度（規程） | 非公開 | `20_method_design.md` §10.9.1・§16.2 |
| `PR-SLO-DNS-CYCLE-CLOSE` | DNS サイクル閉鎖時間 SLO（同 T） | 時間 | 制度（規程） | 非公開 | `20_method_design.md` §10.9.1・§16.2 |
| `PR-FRESHNESS-RED` | 照会応答の `freshness_level` が RED になる Read Model 遅延（GREEN=10秒 / YELLOW=60秒 は公開既定値。実装既定は 60 秒） | 秒 | 制度（規程） | 非公開 | 本書 §13.6 |
| `PR-CASE-SLA` | CASE が `OPEN` / `IN_PROGRESS` のまま滞留してよい上限。超過で `ESCALATED` へ昇格する（技術既定は 24 時間） | 時間 | 制度（規程） | 非公開 | `20_method_design.md` §10.7.4・§10.10.2 |
| `PR-CASE-SECONDARY-COUNT` | `ESCALATED` の CASE に束ねた取引の件数がこれを超えたら、状態を変えずに再通知する（二次エスカレーション。技術既定は 100 件） | 件数 | 運用 | 非公開 | `20_method_design.md` §10.7.2.2 |
| `PR-RETRY-MAX` | 非同期 cmd/event の再送上限回数。到達で DLQ へ落とし CASE へ接続する（`20_method_design.md` §5.4）。技術既定は 3（IGS 再送。実装の正: `src/zc/settlement/igs.ts#retryFailedIgs`） | 回 | 制度（規程） | 公開（例示値） | `10_requirements.md` 序章（DLQ 用語）、`20_method_design.md` §5.4 |
| `PR-DNS-HOLD-NOTIFY-TTL` | DNS_HOLD 宣言後の当局・当事者への閉域通知期限（「所定時間内」） | 時間 | 制度（規程） | 非公開 | `10_requirements.md` §3.3.1-1 |
| `PR-DNS-HOLD-DISCLOSE-TTL` | DNS_HOLD の第1報公表期限（「所定期間内」） | 時間 | 制度（規程） | 非公開 | `10_requirements.md` §3.3.1-3 |
| `PR-BREAKGLASS-REVIEW-TTL` | ブレークグラス付与の事後レビュー期限（「所定時間以内」） | 時間 | 制度（規程） | 非公開 | `10_requirements.md` §3.3.2.2.2 |
| `PR-BREAKGLASS-GRANT-MAX` | 一時権限の最長付与期間（「最長所定時間」） | 時間 | 制度（規程） | 非公開 | `10_requirements.md` §3.3.2.2.3 |
| `PR-STRESS-PASS-RATE` | ストレステスト合格基準：当日解消率（「所定水準」） | 比率 | 制度（規程） | 非公開 | `10_requirements.md` §3.2.5.3 |
| `PR-STRESS-MAX-RESOLVE` | ストレステスト合格基準：最大解消時間（「所定時間」） | 時間 | 制度（規程） | 非公開 | `10_requirements.md` §3.2.5.3 |
| `PR-DNS-ROLLOVER-MAX` | DNS_HOLD の翌日繰越を許容する時間・回数（「所定の時間・回数」） | 時間／回 | 制度（規程） | 非公開 | `10_requirements.md` §3.2.5.4 |
| `PR-NFR-AVAILABILITY-DECISION` | 受付・Decision 系 API の年間可用性目標（要件 A-1） | 比率 | 制度（規程） | 非公開 | `10_requirements.md` §8.2.1 |
| `PR-NFR-AVAILABILITY-QUERY` | 照会系 API の年間可用性目標（要件 A-2。A-1 より高い水準） | 比率 | 制度（規程） | 非公開 | `10_requirements.md` §8.2.1 |
| `PR-NFR-RTO` | 復旧目標時間（要件 A-6） | 時間 | 制度（規程） | 非公開 | `10_requirements.md` §8.2.2 |
| `PR-NFR-READMODEL-REBUILD` | Finality Log からの Read Model 全再構築の目標時間（要件 A-7） | 時間 | 制度（規程） | 非公開 | `10_requirements.md` §8.2.2 |
| `PR-NFR-EXPRESS-P99` | Express の同期 Decision 応答時間 SLO（要件 P-2。店舗導線で成立する水準） | ミリ秒 | 制度（規程） | 非公開 | `10_requirements.md` §8.3.1 |
| `PR-NFR-PEAK-TPS` | 設計ピーク受付レート（レーン別。要件 P-4） | 件/秒 | 制度（規程） | 非公開 | `10_requirements.md` §8.3.2 |
| `PR-NFR-PEAK-FACTOR` | ピーク係数＝平常時比の設計余裕（要件 P-5） | 倍率 | 制度（規程） | 非公開 | `10_requirements.md` §8.3.2 |
| `PR-NFR-DEGRADED-CAPACITY` | 1 地域喪失時に維持すべき処理能力（要件 P-7） | 比率 | 制度（規程） | 非公開 | `10_requirements.md` §8.3.2 |
| `PR-NFR-RETENTION-ONLINE` | オンラインで即時照会可能とする期間（これ以降は WORM 退避可。要件 B-6） | 年 | 制度（規程） | 非公開 | `10_requirements.md` §8.4 |

#### 12.9.1 伏せ字の基準（規範）

公開版で値を伏せるか具体値を書くかは、担当者の裁量にせず次の基準で決める。

| 区分 | 扱い | 例 |
|---|---|---|
| **技術的な既定値**（実装が持ち、値が漏れても制度リスクにならない） | **具体値を書く** | PSPR 短寿命 60〜180 秒、HTLC preimage TTL `capture_expires_at + 60 分`、Attestation 鮮度 60 分、`RATE_SCALE=1e8`、`MAX_AMOUNT_VALUE`＝1兆、freshness GREEN 10 秒 / YELLOW 60 秒 |
| **制度が確定するパラメータ**（値の公開が濫用・裁定・風評を招き得る） | **`PR-*` 名で参照し、値は本台帳で非公開** | 上表の全項目 |
| **法令・監督指針に由来する既定値**（公表が前提のもの） | **具体値を書き、根拠法令を併記** | 保存年限（`10_requirements.md` §3.3.5.1） |

> **HV 閾値の位置づけ（規範）**：HIGH_VALUE 自動エスカレーション閾値の最終フォールバック
> （1 億円）は法令由来の値ではなく、ZC 運営が 4 眼承認で確定する制度パラメータである
> （`10_requirements.md` §3.2.7）。したがって上表の**中段**（制度が確定するパラメータ）に属し、
> `PR-HV-THRESHOLD` として本台帳に登録する。`PR-SOFT-LIMIT` と同じ「公開（例示値）」の扱い
> ——値そのものは公開する（顧客説明・接続認定で必要なため）が、変更は制度行為である。

> **規範** ：本文に「所定時間」「所定期間」「所定水準」等の伏せ字を書く場合は、**必ず対応する
> `PR-*` を本台帳に登録し、本文からはその名前で参照する**。名前の無い伏せ字を残してはならない
> （どのパラメータの話かが特定できず、変更管理の対象にならないため）。
>
> 値の変更は §12.7 のパラメータ統制（`evidence_ref` ＋周知期間）に従う。新規の `PR-*` を本文へ
> 追加する場合は本台帳にも同時登録する。







---

## 第13章 主要メッセージのボディ定義（実装テンプレ） <a id="appendix-e-messages"></a>

> 第12章（I/F契約）は“契約の骨格”であり、本章（第13章）は“実装の迷いを潰すための型”である。

### 13.1 PaymentInitiated（参加行→ZC）

```json
{
  "txid": "TX-...",
  "lane": "EXPRESS|STANDARD|BULK|DEFERRED|RTP|HTLC|HIGH_VALUE",
  "amount": { "value": 1200, "currency": "JPY" },

  "payer": {
    "bank_id": "B001",
    "account_hash": "h:...",          // 必須（永続）：ソルト付ハッシュ
    "vault_ref": "v:optional"         // 任意（短寿命）：Vault参照（表示/照会に必要な場合）
  },

  "payee": {
    "bank_id": "B999",
    "account_hash": "h:optional",     // ExpressではIngress時は省略可
    "vault_ref": "v:optional"         // 任意（短寿命）：Vault参照（表示/照会に必要な場合）
  },

  "purpose": "MERCHANT|P2P|BILL|SALARY|REFUND",
  "pspr_ref": "optional",
  "participant_ref": "optional",
  "ref_issuer": "PAYER_BANK|PSPR|ZC",
  "ref_proof": "optional",
  "requested_at": "RFC3339",
  "expires_at": "RFC3339",
  "client_ref": "optional",
  "risk_hint": { "vault_ref": "optional" }
}
```

値域の正（実装）: `src/types/states.ts#LaneType`: `EXPRESS` | `STANDARD` | `BULK` | `DEFERRED` |
`RTP` | `HTLC` | `HIGH_VALUE` ／ `src/types/states.ts#PurposeType`: `MERCHANT` | `P2P` | `BILL` |
`SALARY` | `REFUND`。

- `pspr_ref` は **optional**。参加行が保持できないケースを想定し、`participant_ref` / `client_ref` を代替キーとして併置する（発番主体は `ref_issuer` で識別）。
- `payee.account_hash` / `payee.vault_ref` は **Express では optional**（alias/宛先確認で補完可）としつつ、`DECIDED_TO_SETTLE` 以降に **解決済み参照（例：`account_resolved_ref`）をRead Modelに保持**して説明可能性を担保する。


**規範**
- Expressは `pspr_ref` を **推奨**（参加行が保持できる場合）。保持できない場合は `participant_ref` または `client_ref` の **いずれかを必須** とし、照会・突合のキーを確保する。
- Expressでは `payee.account_hash` / `payee.vault_ref` は **Ingress時は省略可能**（alias/宛先確認で補完）だが、`DECIDED_TO_SETTLE` までに解決済み参照へ確定させる（Read Modelに保持）。Express では PayeeBank が `pspr_ref` から必要項目を解決する（ZC は参照番号と digest のみ保持）。
- `expires_at` 超過は `REJECT_PRECHECK_EXPIRED`。

### 13.2 PayerExecRequested（ZC→参加行）

```json
{
  "txid": "TX-...",
  "amount": { "value": 1200, "currency": "JPY" },
  "decision_proof_ref": "DP-...",
  "h_reservation": { "reservation_id": "H-...", "mode": "RESERVED|LOCKED" },
  "execution_deadline": "RFC3339",
  "causation_id": "..."
}
```

### 13.3 PayerExecConfirmed（参加行→ZC）

```json
{
  "txid": "TX-...",
  "result": "OK|NG",
  "reason_code": "optional",
  "bank_proof_ref": {
    "issuer_bank_id": "B001",
    "proof_type": "PAYER_EXEC_PROOF",
    "proof_id": "...",
    "retrieval_hint": "..."
  }
}
```

### 13.4 DecideToSettle（ZC→参加行）

※ `DecideToSettle` は「決めた」ことの通知（EVENT）であり、実施を起動するトリガは `PayerExecRequested` / `PayeeExecRequested`（COMMAND）である。

```json
{
  "txid": "TX-...",
  "decision": "DECIDED_TO_SETTLE",
  "decision_proof_ref": "DP-...",
  "finality_log_ref": "FL-...",
  "reason_code": "optional"
}
```

### 13.5 HTLC Reveal（クライアント/参加行→ZC）

secret（preimage）提示メッセージのボディ。ZC は `hashlock` と検証証跡のみを保持し、`secret` は永続保存しない（`20_method_design.md` §3.2.2、本書 §15.4）。

```json
{
  "txid": "TX-...",
  "htlc": {
    "hash_alg": "SHA-256",
    "hashlock": "hex",
    "secret": "hex",
    "timelock_expires_at": "RFC3339"
  }
}
```

### 13.6 QueryResponse（ZC→参加行/Client表示用）

```json
{
  "txid": "TX-...",
  "state": "RECEIVED|PRECHECKED|PRECHECKED_SUSPENDED|H_RESERVED|HTLC_LOCKED|HTLC_ONCHAIN_PENDING|HTLC_FULFILL_REQUESTED|DECIDED_TO_SETTLE|DECIDED_CANCEL|PAYER_EXEC_CONFIRMED|PAYEE_EXEC_CONFIRMED|SUSPENDED|FAILED_EXECUTION|CANCELLED|SETTLED",
  "reason_code": "optional",

  "decision": {"status":"NONE|DECIDED_TO_SETTLE|DECIDED_CANCEL", "decision_proof_ref":"optional"},
  "execution": {"a":"NONE|OK|NG", "b":"NONE|OK|NG", "payer_bank_proof_ref":"optional", "payee_bank_proof_ref":"optional"},

  "case": {"case_id":"optional", "status":"optional"},

  "as_of": "RFC3339",
  "freshness_level": "GREEN|YELLOW|RED",
  "next_action_hint": "WAIT|RETRY_LATER|CONTACT_PAYER_BANK|OPEN_CASE",
  "next_retry_at": "RFC3339 optional",

  "watermark": 12345,
  "watermark_detail": {
    "shards": {"TX:TX-2026-0001": 12345, "GT:GTID-7": 67890}
  }
}
```

> **`watermark_detail.shards` のキー（規範）**  
> キーは **直列化キー＝1本のハッシュチェーン**を指す（[§16.1](#appendix-h-raft)「1シャード＝1クラスター」の
> シャードと同じ単位）。書式は `TX:<txid>` / `GT:<gtid>` / `DNS:<dns_cycle_id>` であり、
> **値はそのチェーンの `MAX(event_seq)`**。当該取引に関する事実を載せている**チェーンを漏れなく**
> 並べること——GTID 脚の決定は脚の chain ではなく GT chain に載るので、脚の番号だけでは
> 監査が答えを再導出できない。参加していて未記帳のチェーンは**省略せず 0** を返す
> （「そのチェーンは無い」と「まだ何も無い」は別の主張である）。  
> `watermark` は上記の**最大値**であり、内訳より新しいと主張してはならない。
> 実装: `src/zc/finality/watermark.ts`。

> **値域の正（規範）**  
> `next_action_hint` の値域は**閉じた 4 値**であり、実装の正: `src/types/api/transfers.ts` の `QueryResponse.next_action_hint`：`WAIT` | `RETRY_LATER` | `CONTACT_PAYER_BANK` | `OPEN_CASE`  
> 事象ごとに新しい hint 値を作ってはならない。事象固有の含意は `reason_code` が担う。

> **設計規範（照会応答の役割分離）**  
> 窓口/顧客向けの画面では `watermark` / `watermark_detail` を表示せず、`freshness_level` と `as_of` のみを表示する。  
> `watermark` 系は監査・技術者向けに保持するが、業務説明の前面に出さない。
>
> **補足：freshness_level の定義（規範）**  
> **測るのは「Read Model がどれだけ SoT に遅れているか」であって、取引が最後に動いた時刻ではない。**具体的には **当該 txid の FinalityLog 先端（`MAX(occurred_at)`）と派生行の `updated_at` の差**を遅延（lag）とする。SoT に自分より新しいエントリが無い行は追いついているので、**終端に達した取引は何年経っても GREEN** である。  
> 「取引が最後に動いてからの経過時間」で測ってはならない——正常に完了した取引が 1 分後から一律 RED になり、下の窓口テンプレ（「照会が混み合っております」）を引いてしまう。指標の意味と顧客説明が同時に壊れるため、閾値調整では直らない。  
> 境界は**下側を含み上側を含まない**（区間は左閉右開）：  
> **GREEN**：lag &lt; **10 秒**（ほぼリアルタイム）  
> **YELLOW**：**10 秒** ≤ lag &lt; **`PR-FRESHNESS-RED`（既定 60 秒）**（許容遅延）  
> **RED**：lag ≥ **`PR-FRESHNESS-RED`**（§12.9。Read Model遅延／調査推奨）
>
> ---
>
> **窓口対応（推奨テンプレ：原因をぼかす）**
> - GREEN / YELLOW：表示どおり案内（通常応対）
> - RED：**「現在照会が混み合っております。少し時間を置いて再度ご確認ください。」**
>
> ※資金不足や特定参加主体の事情を想起させる表現は避け、公式発表・公式ステータスに整合させる。


**規範**
- `as_of` は表示の鮮度（いつ時点の派生ビューか）を示す。
- `watermark` は **Finality Log群（シャード単位）** の反映位置を示す。gtid 等の複合集約では `watermark_detail.shards` に関与する全チェーンの watermark を並べ、監査再現性を担保する（上記のキー規範）。
- `next_action_hint` は窓口/コールセンターの定型応対を支援する（文言固定・閉じた 4 値）。
- `next_retry_at` は「この時刻より前に再照会しても状態が進みにくい」最短目安であり、電話・再照会の氾濫を防ぐ。



---

## 第14章 LSM（流動性節約）詳細 <a id="appendix-f-lsm"></a>

### 14.1 目的関数（設計意図）

Bulkは“遅くてもよい”のではなく、 **大量件数を低単価で安定処理する** ことが目的である。  
よってLSMは以下の両立を狙う。

1. **H制約（安全弁）を超過しない** （絶対条件）
2. **期限（due_at）を守る** （最優先の最適化）
3. **公平性（特定参加行の飢餓を防ぐ）** （運用品質）
4. **処理量（スループット）を最大化** （コスト効率）

> **設計規範（LSMの優先順位：辞書式）**  
> 目的関数は同時に最大化できないため、実装ブレを防ぐ目的で **辞書式（lexicographic）** に固定する。
> 1. 期限遵守（due_at超過の最小化）
> 2. 公平性（飢餓防止：待ち時間に基づく重み付け）
> 3. 効率（スループット最大化）


### 14.2 入力・出力（監査再現性）

- 入力スナップショット：`input_snapshot_id`（window締切時点の候補集合）
- 制約ダイジェスト：`constraints_digest`（H残高、期限、優先度、停止条件）
- 出力集合：`execution_set_hash`（採択leg/txの集合）
- 追跡情報：`trace_digest`（再現可能な根拠）

**規範** ：`LsmRunCommitted` は上記を必須とし、後日「なぜこの集合が採択されたか」を説明できること。

### 14.3 フォールバック（必須）

LSMが失敗した場合でも処理を停止させない。

- `LsmRunFallback(mode=FIFO)`：到着順処理
- `LsmRunFallback(mode=PRIORITY)`：期限優先
- `LsmRunFallback(mode=THROTTLE)`：参加行別の上限で間引き

**規範** ：フォールバック時は `objective_metrics.degraded=true` を立てて劣化を記録し、運用に自動通知する。

### 14.4 採否の扱い（規範）

- **非採択は reject しない**：LSM に採られなかった候補は**次ウィンドウへ Defer** する。締切に間に合わなかったことを失敗として返すと、参加行側に再送ループを作る（§14.1 の「期限遵守」は最適化目的であって、不採択の理由ではない）。
- **採択の確定点は H 予約コミット**：最適化の出力そのものではなく、`advanceBulk` における H 予約コミット（安全弁）の成否をもって確定とする。最適化は提案、確定は安全弁——この順序を逆にしない。
- **実装の所在**：`src/zc/liquidity/bulk_lsm.ts#runBulkLsm`（候補集合は BULK / RECEIVED、EOD もこの経路で確定する）。




---

## 第15章 HTLC（hashlock+timelock）詳細 <a id="appendix-g-htlc"></a>

### 15.1 適用範囲

HTLC（Hashed Time-Lock Contract）は、デジタルアセットのクロスチェーン交換や、エスクロー（第三者預託）的な **「双方が条件（シークレット）を満たした時のみ成立し、期限が来れば確実に無効化される取引」** を整理するための機能である。成立後の取消（Reversal）等の用途には使用しない。  
本基盤が規範化するのは **hashlock（SHA-256ハッシュ） + timelock（ISO8601日時ベースの期限）** のみであり、外部オラクル参照など責任分界が曖昧になる要素は規範の対象外とする。

### 15.2 セキュリティ・暗号プリミティブ制約

- **ハッシュ関数アルゴリズム**: `SHA-256` のみを標準とし、他の危弱なアルゴリズムや複雑すぎるアルゴリズムを排除して検証コストを固定する。
- **Preimage（シークレットパスワード）エントロピー**: 生成されるシークレット（`preimage`）は最低256ビット空間から十分なエントロピーを用いて生成されることを推奨し、ブルートフォース攻撃から保護する（参加銀行側の実装要件）。
- **Timelockの基準時計**: ZC（ワーカー群）のシステム時刻を正とし、ネットワークの遅延を考慮して余裕を持った `timelock` （または `expires_at`）を設定させる。

### 15.3 状態遷移（txid拡張とAPI）

HTLCの主役は「保留（Lock）」と「解決（Claim / Reveal）」の2段階である。

> **状態名の正（規範）**：本節が用いる状態名は、`Transactions.state` については
> `src/types/states.ts#TxState`、`HtlcContracts.state` については同 `#HtlcState` を正とする。
> 以下では**実在する状態名のみ**を用いる。

1. **`RECEIVED`（`Transactions`）／`HTLC_RECEIVED`（`HtlcContracts`）**：支払人が
   `POST /api/htlc/create` で、送金金額とともに `hashlock` と `timelock` を指定する。
   **`Transactions` 行は必ず `RECEIVED` で生成する**（`HTLC_LOCKED` 直挿入は禁止。
   `10_requirements.md` §3.2.3.1-5）。
2. **`HTLC_LOCKED`**：形式検証・AMLチェック後、ZCが仕向側限度（H）を予約し、資金がロックされる。
   遷移は `RECEIVED → HTLC_LOCKED`（canonical 入口）。この間、日次DNSの清算対象には**計上されない**。
3. **`HTLC_FULFILL_REQUESTED`**：受取人が期限内に正しい `preimage` を提示（Claim）し、
   ハッシュ値が一致（ZCが検証）した状態。**この状態に入った後は取消不可**であり、
   `DECIDED_TO_SETTLE`（成立）か `FAILED_EXECUTION`（実施未確定で終端）に収束する。
   クロスチェーン脚では `HTLC_LOCKED → HTLC_ONCHAIN_PENDING → HTLC_FULFILL_REQUESTED`
   を経由する（§15.6）。
4. **`DECIDED_TO_SETTLE`**：ハッシュ合致により決済確定（通常の送金と同様の `a` → `b` の状態へ進行する）。
5. **`DECIDED_CANCEL` → `CANCELLED`**：期限（`timelock`）到来までに `preimage` が提示されなかった
   場合、自動で取消決定へ収束し、H予約は安全にロールバックされる。**「期限切れ」を表す独立した
   状態は持たない**——期限到来は `DECIDED_CANCEL` への遷移イベントであり、理由は `reason_code`
   （`TIMELOCK_EXPIRED` 等）が担う。

正準の遷移グラフ（図）は `20_method_design.md` §3.2.2、実装上の唯一の正は
`src/zc/orchestrator/state_machine.ts#ALLOWED_TRANSITIONS` である。

### 15.4 重大な証跡とデータ保持の固定点

- **ZCにシークレット（preimage）の平文を永続保存してはならない**：ZCが保持するのは、検証用の `hashlock` と、提示・検証結果の**検証ログ（および監査ハッシュ）**のみである。これにより、ZC自身がシークレット漏洩の起点となるリスクを根絶する。
- **否認防止（Non-repudiation）の担保**：シークレット提示（Claim）は、提示側（PayeeBankまたは連携主体）による**署名付きイベント**として受け付ける。  
  - 必須パラメータの例：`presenter_org_id`, `presenter_system_id`, `presented_at`, `preimage`, `present_signature`
- **検証のアトミック性**：シークレット提示は **一度だけ成功** させる。既に Claim 済みの取引への再 Claim は、冪等処理として成功（同じ結果）を返し、二重実行を防ぐ。
- **タイムロック超過の完全性**：`timelock` が1ミリ秒でも超過した場合、ZCは如何なる理由（通信遅延、障害等）であっても Claim を拒否し `DECIDED_CANCEL` で回収する。
- **Claim 直前の AML 再照会も fail-closed**：`timelock` が当営業日末を越える HTLC は、資金解放の
  直前に払い手銀行へ AML/制裁の再照会（`check_type='RECHECK'`）を行う。この照会の答えは
  OK / NG の 2 つではなく、**「答えが返らない」が third case として存在する**（回路 OPEN 等）。
  判定不能を「NG でなければ解放する」と扱ってはならない——到達できなかった照会が非該当と
  同じ効果を持つことになる（事前審査側の同じ規範は `20_method_design.md` §3.3.1 の T_auth）。
  - **判定不能の帰結は「claim の拒否」であり、取消でも待機でもない。** claim 経路には
    `PRECHECKED_SUSPENDED` に相当する待機状態が無く、待つこと自体が timelock と競合する。
    したがって **HTLC を一切変えずに** claim を退け（`reason_code`
    `RECHECK_AUTHORITY_UNAVAILABLE`）、再試行に委ねる。再照会は timelock が当営業日末を
    越える場合にのみ走るので、拒否された claim には**構造上その日の残り以上の再試行余地がある**。
    銀行が復旧しなければ外側 timelock が取消・返金する（未 claim の HTLC と同じ backstop）。
  - **残余リスクは明示して受け入れる**：他チェーンで既に preimage を明かした受取人は、
    秘密を手放したまま再試行の成功を待つことになる。これは timelock で上限が付き再試行で
    回復しうるのに対し、**未審査の相手へ解放することは上限も回復手段も無い**——ゆえにこちらを
    採る。
  - 拒否は**遷移を伴わない証跡**として FinalityLog に残す（`HtlcClaimRejected`、
    `state_from == state_to`。`INVALID_PREIMAGE` の記録と同型）。審査できなかったことを
    理由に決済を拒んだ事実こそ、監督当局が後から尋ねるものである。

### 15.5 プログラマビリティの汎用化（条件の AND/OR 合成）

> 本節（§15.5）は HTLC 固有の**適用規範**。条件式・k-of-n 定足数・equivocation・決定的述語・JST の設計思想と構成レイヤの一次記述は 第11章（プログラマビリティ）を参照（重複説明は同章に集約）。

preimage 提示に代えて、ホワイトリスト化された **ConditionTemplate** への署名付き Attestation（`verified_result='PASS'`）でも HTLC を成立させられる（単一テンプレ）。これを **複数テンプレートの AND/OR 合成** へ一般化する。`HtlcContracts.condition_expr_json` が `{template_id} | {op:'AND'|'OR', operands:[…]}` の式木を保持し、`claimHtlcByConditions`（`POST /api/htlc/:htlc_id/claim-by-conditions`）が各リーフの Attestation を `recordAttestation`（署名・スコープ・鮮度を検証）で確認したうえで、PASS となったテンプレ集合に対し純粋評価器でブール式を判定する。

- **規範**：ZC は条件の真偽そのものを判定しない。各リーフの Attestation が有効かつ PASS かのみを検証し、式の成立は集合に対する純粋なブール合成として評価する。式が満たされた場合のみ既存の成立経路（`HTLC_LOCKED → HTLC_FULFILL_REQUESTED → …`）へ進み、いずれの場合も `HtlcConditionsEvaluated`（満たされたテンプレ集合・判定結果・定足数内訳）を証跡化する。単一リーフは従来の単一テンプレ挙動に一致する。
- 構造上限（濫用・無限再帰の防止）：式木の深さ・オペランド数・参照テンプレ数に上限を設ける。

#### 15.5.1 k-of-n THRESHOLD ノード

AND/OR に加え `{op:'THRESHOLD', k, operands:[…]}` を持つ。オペランドのうち **少なくとも k 個**が真なら成立する（AND = `THRESHOLD k=#operands`、OR = `THRESHOLD k=1` の一般化）。「n 個中 k 個」を AND/OR の組合せ展開なしに直接表現できる。`k` は `1..#operands` の整数に限る。

#### 15.5.2 テンプレート単位の distinct-operator 定足数と equivocation（HTLC 適用）

定足数（`min_attester_quorum`）と equivocation の**モデル定義は §11.2-c を正とする**。ここでは
HTLC claim 経路への適用のみを述べる。

- claim 判定時、各 Attestation リーフは §11.2-c の distinct-operator 定足数を満たしたときにのみ
  「満たされた」と扱い、その内訳を `HtlcConditionsEvaluated` の定足数内訳として証跡化する。
- equivocation 検出時は当該リーフを fail-closed とし、**HTLC 自体は `HTLC_LOCKED` のまま**
  （取消はしない）。`ATTESTATION_EQUIVOCATION` の CASE へ収束させ、timelock 満了までは
  他の独立枝での成立を妨げない。

#### 15.5.3 決定的述語（LedgerPredicate）（HTLC 適用）

述語の**種別・意味・単調性の定義は §11.2-d を正とする**（`TX_REACHED_STATE` /
`GTID_REACHED_STATE` / `TIME_AFTER` / `TIME_BEFORE` の 4 種）。ここでは HTLC claim 経路への
適用のみを述べる。

- `ledger_predicate_json` が非 NULL のテンプレートは Attestation の提示を無視し、claim 時点で
  `evaluateLedgerPredicate(db, p, now)` により解決する。
- **評価に用いた `now` を `HtlcConditionsEvaluated` に必ず記録する**。`TIME_BEFORE` は非単調
  （true→false）であるため、記録が無いと「なぜあの時点で成立したのか」を後から再現できない。
- 構成上の相互待ち（相互参照、到達しない `TIME_AFTER`）は**安全性ではなく liveness の問題**であり、
  timelock 満了による返金で解消する。ZC は循環検出を行わない。
- 時刻は **JST**（§11.4）。`TIME_*` の `at` にオフセットが無い場合は JST とみなす。

#### 15.5.4 ドライラン（読み取り専用）

副作用なしで条件式・マンデートを事前評価できる（`POST /api/conditions/validate`・`/api/conditions/simulate`・`/api/mandates/check`）。書き込み・資金移動・Attestation 記録は行わない（`src/zc/query/simulate.ts`）。

### 15.6 クロスチェーン確定の種別と量子リスク証跡

クロスチェーン HTLC のオンチェーン脚は、レールの確定モデルに応じて確認の扱いを変える。`onchain_chain_class` を **PUBLIC（確率的確定：確認深度が意味を持つ）/ PRIVATE・PERMISSIONED（決定的確定）** として記録し、そこから `onchain_finality_class`（PROBABILISTIC / DETERMINISTIC）を導出する。

- **確認深度ゲート**：内側 `onchain_timelock` 経過後の解放は十分な確認深度を要する。決定的チェーンは 1 確認で確定とみなしてゲートを縮約し、確率的チェーンは設定された深度を尊重する（`requiredConfirmations`）。
- **量子危殆化リスクの証跡**：オンチェーン証明の署名スイートを `onchain_quantum_risk`（VULNERABLE / RESISTANT / UNKNOWN）として分類・記録する。古典スイート（secp256k1・ed25519 等）は VULNERABLE、PQ 耐性スイート（Dilithium 等）は RESISTANT、未知は UNKNOWN（安全側に倒さない）。
- 分類は作成時に `OnchainFinalityClassified` で証跡化する。チェーン登録の権威（どの source をどの class とみなすか）は制度設計に委ねる。




---

## 第16章 Raft運用（合意ログ）詳細 <a id="appendix-h-raft"></a>

### 16.1 1シャード＝1クラスター

- 取引の直列化キー（txid/gtid等）単位でシャードを切り、各シャードでRaft合意を取る。
- **過半数に到達できない場合はRead-only** へ遷移し、誤決定（split-brain）を防止する。

### 16.2 スナップショットとコンパクション

- Finality Logは追記で増大するため、スナップショットを必須とする。
- 監査再現に必要な最小範囲（例：過去N日＋係争中）を保持し、それ以前はWORM等へ退避する。

### 16.3 メンバーシップ変更

- ノード追加・除去は段階的に行い、変更操作自体も `evidence_ref` で証跡化する。

---

## 第17章 クロスカレンシーFX 内部設計 <a id="fx-internal"></a>

> 本機能の全体像 — 要件:`10_requirements.md` ／ 処理方式:`20_method_design.md` ／ 内部設計:本章。

### 17.1 スキーマ

`migrations/0001_consolidated_schema.sql` は歴史的な個別マイグレーションを1ファイルに
統合した、現在の**唯一の**スキーマ定義ファイルである（新規変更も新しい番号付き
マイグレーションを切らず、この統合ファイルを直接編集する運用。§8・`docs/specs/31_schema.md` マイグレーション運用）。FX 関連の3テーブルもこの1ファイルの
中で定義されている。`test/helpers/d1-mock.ts` の `SCHEMA_MIGRATIONS` に登録済みで、
テストDBにも反映される。

- `FxQuotes`（`20_method_design.md` §17.3.2）。
- FXP 能力フラグ: `Participants.is_fx_provider INTEGER NOT NULL DEFAULT 0`。
  対応通貨は `ParticipantCurrencyLimits` の存在で判定する（別表は無い）。
- `FxTransfers`: 導管 GTID の FX 固有事実（経路・実効レート・hashlock・quote_ids・status）を
  `gtid` で1:1に保持（`20_method_design.md` §17.4.5）。
- `FxLegLocks`: `bind_htlc=true` の経路でのみ使われる、脚ごとのロック状態
  （`LOCKED`/`CLAIMED`/`REFUNDED`、`20_method_design.md` §17.4.2・§17.4.3）。
- `FinalityEventType` に FX 専用の値は追加していない。FX の導管 GTID も通常の GTID が書く
  既存のファイナリティログ（例: `GtidRegistered`）をそのまま使う。
- `reason_code`（`REASON_CODE_CATEGORY`、`src/shared/errors.ts`）に登録済みで FX が
  実際に投げるもの: `FX_NO_ROUTE`（CONFLICT）、`FX_QUOTE_EXPIRED`（CONFLICT）、
  `FX_ALREADY_REFUNDED`（CONFLICT。払戻済みへの claim）、
  `FX_RATE_MISMATCH`（VALIDATION）、`INVALID_FX_RATE`（VALIDATION）、
  `FX_FXP_ACCOUNT_MISSING`（VALIDATION）。登録済みだが現在どこからも投げられていない
  予約コード: `FX_ROUTE_INCONSISTENT`（VALIDATION）、`FX_LIQUIDITY_INSUFFICIENT`
  （CONFLICT、`20_method_design.md` §17.5）。HTLC関連は FX 専用コードを新設せず既存の汎用コードを再利用する:
  `PREIMAGE_MISMATCH`（VALIDATION）、`STATE_GUARD`（CONFLICT）、`GTID_NOT_FOUND`
  （NOT_FOUND）、`UNAUTHORIZED`（AUTH）。

---


### 17.2 API

実装は `src/zc/fx/api.ts`、ルーティングは `src/router/zc.ts`、OpenAPI は
`src/openapi/zc-api.ts` の `fx` タグ。

#### `PUT /api/fx/rates`
FXP が自行の方向別レートを upsert する。
- リクエスト: `{ fxp_bank_id, from_currency, to_currency, rate, min_amount?, max_amount?, valid_from?, valid_to }`
- 検査: 通貨は ISO 4217・`from_currency !== to_currency`・`rate` は正整数・`valid_to` は
  RFC3339。`fxp_bank_id` の `Participants` が存在し、`is_active=1` かつ `is_fx_provider=1`
  であること。
- 失敗: 404 `PARTICIPANT_NOT_FOUND` ｜ 409 `STATE_GUARD`（非活性）｜
  401 `UNAUTHORIZED`（FXP未登録。`UNAUTHORIZED` は AUTH カテゴリ＝401。
  `docs/specs/32_api_contracts.md` のエラーカタログ写像に従う。以前は 403 をハードコードしていたが
  カタログと矛盾していたため 401 に修正済み、`api.ts`）｜ 400 `INVALID_FX_RATE` ほか。
- 成功: 200 `{ result: "QUOTE_ACCEPTED", quote }`。

#### `DELETE /api/fx/rates/:quote_id`
見積の取り下げ。成功: 200 `{ result: "QUOTE_WITHDRAWN", quote_id }`。対象が ACTIVE で
見つからない（既に取り下げ済み/存在しない）場合は 404。

#### `GET /api/fx/rates?from=&to=`
指定ペアの ACTIVE 見積一覧。`{ from_currency, to_currency, quotes }`。

#### `POST /api/fx/quote`
価格発見（コミットしない）。
- リクエスト: `{ from_currency, to_currency, amount, denomination, max_bridge_hops? }`
- 成功: 200 `{ result: "ROUTE_FOUND", rate_scale, route }`。
- 経路が無ければ 409 `FX_NO_ROUTE`。

#### `POST /api/fx/transfers`
- リクエスト: `{ gtid, idempotency_key, from_currency, to_currency, amount, denomination,
  payer: { bank_id, account_hash }, payee: { bank_id, account_hash },
  fxp_accounts: { "<bankId>:<currency>": "<accountHash>" }, max_bridge_hops?,
  expires_at?, min_effective_rate?, bind_htlc? }`
- **冪等化**: `idempotency_key` で `resolveIdempotency`（初回受理か再生かを判定。内部で
  `acquireIdempotency`/`getIdempotentResponse` を用いる）と `completeIdempotency`（確定した
  応答を保存）を使う（`api.ts`）。2回目以降は1回目の応答を200で再生し、同一キーで**本文が
  異なる**場合は 409 `IDEMPOTENCY_KEY_CONFLICT` を返す。
- **権威的再プライシング**: クライアントが `POST /api/fx/quote` で得た経路は信用せず、
  ここで `findBestRoute` を**再実行**する。経路が見つからなければ 409 `FX_NO_ROUTE`。
- `min_effective_rate` を指定していれば、再プライシング後の `effective_rate` がそれより
  悪ければ 409 `FX_RATE_MISMATCH`。
- `fxp_accounts` に経路上の**全 FXP×全通貨**（各ホップの from/to）のキー
  `"<bankId>:<currency>"` が無ければ 400 `FX_FXP_ACCOUNT_MISSING`。
- `bind_htlc` が真なら `lockFxTransfer` を呼び、201
  `{ result: "FX_TRANSFER_LOCKED", gtid, hashlock, secret?, amount_from, amount_to, legs, route }`。
- 偽（デフォルト）なら `initiateFxTransfer` を呼び、201
  `{ result: "FX_TRANSFER_INITIATED", gtid, hashlock, amount_from, amount_to, effective_rate, route }`。

#### `POST /api/fx/transfers/:gtid/claim`（HTLC経路）
- リクエスト: `{ secret }`。
- 成功: 200 `{ result: "FX_TRANSFER_CLAIMED", gtid, status: "SETTLED", gtid_state, already }`。
- 失敗: 400 `PREIMAGE_MISMATCH` ｜ 404 `GTID_NOT_FOUND` ｜ その他 409
  （例: `FX_ALREADY_REFUNDED` ＝既に払戻済み）。

#### `POST /api/fx/transfers/:gtid/refund`（HTLC経路）
- 成功: 200 `{ result: "FX_TRANSFER_REFUNDED", gtid, status: "REFUNDED", refunded_legs }`。
- 失敗: 404 `GTID_NOT_FOUND` ｜ その他 409 `STATE_GUARD`（既に CLAIMED 済み、または
  タイムロック未到来）。

#### `GET /api/fx/transfers/:gtid`
- 成功: 200 `{ gtid, status, from_currency, to_currency, amount_from, amount_to,
  effective_rate, hashlock, quote_ids: string[], gtid_state, legs: GtidLegs[],
  leg_locks: [{ leg_index, currency, amount, timelock, state }, ...] }`。
- `FxTransfers` レコードが無ければ 404 `GTID_NOT_FOUND`。
- `leg_locks` は HTLC 経路でのみ要素を持つ（デフォルトの即時経路では空配列）。

---


### 17.3 既存コードへの接地

| 機能 | 接地先 |
|---|---|
| 多脚協調・状態機械 | `src/zc/lanes/gtid.ts`（バレル）, `src/zc/lanes/gtid/{register,advance,legs}.ts`, `GtidTransactions`/`GtidLegs` |
| 通貨別 H | `src/zc/liquidity/h_model.ts`（`reserveH`）, `ParticipantCurrencyLimits` |
| 脚の中銀確定 | `src/shared/central_bank.ts`（CBT/`settlementAccountId`）, `src/zc/settlement/dns.ts`, `src/zc/settlement/igs.ts` |
| 非JPY 確定証跡 | `venue='CB_TOKEN'` ＋ `src/shared/watcher.ts` / `src/shared/proof.ts` |
| 通貨別ゼロサム | `src/bank/ledger.ts`（`amount_currency`） |
| 通貨許可リスト | `src/shared/validator.ts`（`VALID_CURRENCIES`） |
| GTID確定後のFX連動 | `src/zc/orchestrator/gtid.ts`（`checkAndFinalizeGtid` が `FxTransfers.status` を更新） |
| キュー処理 | `src/zc/orchestrator.ts`（`processQueueMessage` の `ZC_BANK_LEG_READY` ケースが `advanceGtid` を呼ぶ） |
| cronスイープ | `src/cron/timeout_sweep.ts`（`sweepExpiredFxLocks`、本書 §17.4） |
| FX専用HTLC（GTIDレーンの `htlc.ts` とは独立） | `src/zc/fx/htlc.ts`, `FxLegLocks`（生SQL＋`db.batch()`。`test/zc/lane_invariants.test.ts` は `src/zc/lanes/` のみを走査するため対象外） |

---


### 17.4 既存コードへの接地

> **実装メモ**: 既存 GTID レーンは通貨別 H・通貨別中銀ファイナリティで多通貨脚を
> すでに原子決済できる（`multi_currency` / `chaos_gtid` #19）。FXP を**明示的な導管**
> （payer→FXP は source 通貨、FXP→payee は target 通貨。ブリッジは中間通貨脚を追加）
> として置くと各通貨が両側で均衡し、`AMOUNT_BALANCE_MISMATCH` に触れず決済コア無改修で
> 成立する。`AMOUNT_BALANCE_MISMATCH` が阻むのは「FXP不在の経済的に不完全な FX 表現」
> だけ。よって `20_method_design.md` §17.5 の均衡検査置換は不要となり、代わりに「導管型 GTID を構築する層」を
> 実装した（当初設計より低リスク・低侵襲）。

#### 実装の所在

- **レート市場・経路・導管決済**: `src/zc/fx/rates.ts` の整数固定小数レート演算
  （`RATE_SCALE=1e8`、BigInt内部、forward=floor / backward=ceil、ブリッジ合成）。
  `FxQuotes` 市場（`migrations/0001_consolidated_schema.sql`）＋
  `src/zc/fx/quotes.ts`（upsert/取下げ/期限）。`src/zc/fx/routing.ts` の最良経路選定
  （直接＋単一中間通貨ブリッジ、payer/payee 建て）。`FxTransfers`（同マイグレーション）＋
  `src/zc/fx/transfer.ts`（導管GTID構築・共有ハッシュロック生成・見積生存確認）。
  `src/zc/fx/api.ts` ＋ `src/router/zc.ts` の配線（quote/transfers/rates/状態）。
  検証: `fx_rates`/`fx_routing`/`fx_transfer`/`fx_api`/`fx_settlement`（E2E残高）。
- **HTLCによるクロスレール原子性**: `FxLegLocks`（同マイグレーション）＋
  `src/zc/fx/htlc.ts`（`lockFxTransfer`/`claimFxTransfer`/`refundFxTransfer`）。
  各通貨脚を**共有ハッシュロック＋段階的タイムロック**（上流ほど後に満了）でロック
  し、**決済は claim まで遅延**させる。secret 公開で `sha256==hashlock` を検証→全脚を
  一括 CLAIMED→導管 GTID を登録・前進させて初めて決済（全か無か）。未公開ならタイム
  ロック満了で全脚 REFUNDED（無決済）。決済が「完全 claim 時に一度だけ原子的に起き、
  refund がそれを締め切る」ため、レールをまたいでも部分決済は起こり得ない。決済コア
  （共有オーケストレータ）は無改修。API: `bind_htlc` フラグ ＋ `/claim`・`/refund`
  （`src/zc/fx/api.ts`）。検証: `test/zc/fx_htlc.test.ts`（lock/claim/refund・誤secret
  棄却・冪等・相互排他）。
  - 設計当初は `HtlcContracts` 拡張を想定したが、同表は単一HTLC決済に密結合のため、
    FX専用の独立束ねテーブル `FxLegLocks` として実装した（低リスク・決済コア無改修）。
- **運用仕上げ**: 期限切れロックの**払戻スイープ cron**（`sweepExpiredFxLocks` を毎分
  `runTimeoutSweep` に接続。`src/cron/timeout_sweep.ts` step 16）。**`FxTransfers`
  SETTLED 連動**: 導管 GTID が `GT_SETTLED` に達したとき `checkAndFinalizeGtid` が
  `FxTransfers.status='SETTLED'` を立てる（デフォルト経路）。HTLC 経路では
  `claimFxTransfer` がその場で即座に立てる（`20_method_design.md` §17.4.5の書き込みタイミングの違い）。
  **OpenAPI**: 全 FX エンドポイントを `src/openapi/zc-api.ts`（`fx` タグ）に記載。
  **アトミシティの敵対的検証**: `test/integration/chaos_fx.test.ts`（本書 §9 テスト戦略）。
  検証: `test/zc/fx_htlc.test.ts`（sweep）、`test/integration/fx_settlement.test.ts`
  （SETTLED連動）。

#### 将来課題

流動性連動の動的上限（FXP 実残高に max を連動）、丸め益の明示的帰属ルール（現状は
デフォルトでFXP）、決済前のAML/トラベルルールフックの接続、紛争フロー
（`Cases` 連携）、HTLC レーン自体の通貨次元化（`HtlcContracts` の非JPY化＝単一HTLCの
多通貨対応。FX は独立 `FxLegLocks` で完結しているため必須ではない）。

---

## 第18章 レガシー勘定系アダプタ 内部設計 <a id="adapter-internal"></a>

> 本機能の全体像 — 要件:`10_requirements.md` ／ 処理方式:`20_method_design.md` ／ 内部設計:本章。

### 18.1 冪等性（非冪等コアの防御、read-then-write ではなく atomic claim）
既存の `IdempotencyKeys` テーブルと `resolveIdempotency`/`completeIdempotency`
（`src/shared/idempotency.ts`）を再利用する。`acquireIdempotency` は
`INSERT OR IGNORE` を**最初の操作として**実行するため、「まず確認してから
書き込む（read-then-decide）」方式にありがちな競合の隙間が無い。同じ
リクエストが二重に送られてきた場合、後から届いた方は、先行する呼び出しが
既に完了していればそのキャッシュ結果を返し（REPLAY）、まだ処理中であれば
`LEGACY_ADAPTER_REQUEST_IN_FLIGHT`（リトライ可能な `DomainError`）で
弾かれる。いずれの場合も、副作用（実際の入出金処理）が二重に実行される
ことはない。

drain 側は outbox の `PENDING → CLAIMED → APPLIED` の claim-then-apply
方式（下記）で、同時 drain 呼出し下でも一度しか適用しない。

---


### 18.2 適合性検証テストが固定していること（`adversarial.test.ts`, 34 ケース） <a id="conformance"></a>

- **ベースライン**: 素のコアが本当に非冪等（再送で二重適用）、オフラインで
  全 call 失敗、残高不足を同期で拒否する——再現した制約そのものを先に証明。
- **#2**: コア停止中に debit を即時承認 → outbox 保留 → コアは無傷 →
  window オープンで一度だけ drain → 照合ドリフト 0。二度目の drain は no-op。
- **冪等性（逐次）**: 同一 request_id の execute-credit 二重送（逐次）で、
  非冪等コアが一度だけ適用（キャッシュ結果を返す）。
- **#4**: reserve 無操作 → debit → 下流失敗 → 補償 Reversal → payer net zero →
  drain 後もコア残高は開始値、ドリフト 0。txid で debit/reversal が対応付く。
- **#5**: 通知格納 → プル一度きり → 再送しても重複しない。
- **#6**: オフラインで N 件取込 → drain で全件一度だけ適用 → 全口座ドリフト 0。
- **#3**: クリーンフローは常にドリフト 0（outbox 保留中でも不変条件成立）。
  out-of-band なコア変更は OPEN ドリフト**かつ実際の CASE** として検出。
- **オーバードラフト保護**: shadow 側の承認後、drain 時点で実コア残高が不足
  していることが判明した場合、コアはマイナスにならず、outbox は `BLOCKED`
  になり実際の CASE が開く（サイレントな無限リトライも money loss もしない）。
- **タイムアウト**: drain 中タイムアウト → outbox は PENDING のまま（ロスト
  無し）→ 回復後に一度だけ適用（二重適用無し）。
- **並行性（TOCTOU 競合の再現と修正確認）**: 同一 request_id の
  executeCredit 2 件を `Promise.all` で同時実行しても、コアには一度しか
  適用されない。同一 PENDING outbox 行に対する 2 件の同時 `drainOutbox`
  も、claim-then-apply により一方だけが適用する。
- **失効 CLAIMED の回収**: `recoverStaleClaims` が、drain 中断で
  `CLAIMED` のまま取り残された行を `PENDING` に戻し、再試行可能にする。
- **name-check**: 非リアルタイム行は `DEFERRED` に降格、リアルタイム行でも
  バッチ中は throw せず `DEFERRED`（送金を落とさない）。

---


### 18.3 監査で見つかった問題と是正 <a id="audit-fixes"></a>

> **本節の位置づけ（§10.0 の規約における「設計経緯」）**：本節は、現行コードが**なぜこの形か**を
> 説明するための経緯記録である。ここに書かれた「是正内容」は、**現行の規範ではなく当時の判断**であり、
> 規範は各章の本文（§18.1 冪等性・`20_method_design.md` §18.2 コア境界）を正とする。
> 本節を残す理由は 2 つ——(1) 同じ罠（read-then-write 冪等、`db.batch()` の無条件実行、
> コア内部テーブルへの依存）を再び踏まないため、(2) 本サブシステムが最初から無欠陥だったという
> 印象を残さないため。

初版実装を「勘定系のプロの目線」で監査した結果、以下の問題が見つかり、いずれも是正した。

| # | 問題 | 重大度 | 是正内容 |
|---|---|---|---|
| 1 | **マイグレーション運用の鉄則違反**: `migrations/0002_legacy_adapter.sql` という新規連番ファイルを切っていた。本リポジトリの鉄則（`docs/specs/31_schema.md` § マイグレーション運用）は「統合スキーマ `0001` を直接編集し、新規ファイルを切らない」。 | 重大（プロジェクト規約違反） | `0002` を廃止し、全テーブルを `0001_consolidated_schema.sql` に直接統合。`test/helpers/d1-mock.ts` の `SCHEMA_MIGRATIONS` も単一ファイルに戻した。 |
| 2 | **冪等性が read-then-write で TOCTOU 競合に弱い**: 独自の `AdapterIdempotency` テーブルに対し「SELECT で既存確認 → 無ければ実行 → INSERT OR IGNORE で記録」という順序だった。2つの同時呼出しが両方とも「未処理」を観測し、両方とも副作用（shadow 更新・outbox 追加）を実行してしまい得る——真の二重処理。既存の `IdempotencyKeys`/`acquireIdempotency` が使う「INSERT を先に行い、その成否だけで所有権を判定する」atomic-claim パターンをなぜか使わず、独自に劣った実装を再発明していた。 | **重大（二重処理・二重出金のリスク）** | 独自実装を廃止し、既存の `resolveIdempotency`/`completeIdempotency` に置き換え。競合下の後着は `LEGACY_ADAPTER_REQUEST_IN_FLIGHT`（retryable）で弾かれる。`test/bank/legacy/adversarial.test.ts` の「concurrency: idempotency race」で固定。 |
| 3 | **drain の二重適用**: `drainOutbox` は「コア posting のステートメント（無条件実行）」+「outbox を `PENDING→APPLIED` にするガード付き UPDATE」を同一 `db.batch()` に積んでいた。しかし `db.batch()` は配列中の全ステートメントを**無条件に**実行する（前のステートメントの `changes` を見て後続を中断する仕組みが無い）ため、末尾のガードが 0 行しか更新しなくても、先行するコア posting は実行済み。2つの `drainOutbox` が同じ `PENDING` 行を同時に処理すると、コアに**二重 posting**され得た。 | **重大（実コアへの二重記帳）** | `PENDING → CLAIMED → APPLIED` の claim-then-apply 方式に変更。claim（`WHERE status='PENDING'` のガード付き UPDATE、`meta.changes` で所有権判定）に勝った呼出しだけが実際の posting を行う。`test/bank/legacy/adversarial.test.ts` の「concurrency: drain double-post race」で固定。claim 後にクラッシュした場合に備え、`recoverStaleClaims`（`cron/timeout_sweep.ts` から呼び出し）で失効回収。 |
| 4 | **drain 時のオーバードラフト無検証**: shadow 側で資金十分と承認された DEBIT でも、実コア残高が（ドリフト等により）不足している場合、drain は無条件にコア残高を減算しており、コアがマイナスになり得た。実際の勘定系はどれほどレガシーでも「残高マイナスを許す」ことは無い。 | **重大（会計上あり得ない状態を生成しうる）** | `LegacyCore.postDebit` 内部で、資金十分性チェックと journal 記帳を**同一の `WHERE EXISTS` 事前条件**で自己ガードする形に変更（コア自身の2テーブルのみに閉じた同期。本表 #8 の是正後は、この判定はコアの外＝アダプタ側からは見えない）。不足時は `{applied:false}` を返し、アダプタが outbox を `BLOCKED` にして実際の CASE を開く。`test/bank/legacy/adversarial.test.ts` の「drain-time overdraft protection」で固定。 |
| 5 | **照合ドリフトが「見られていない」テーブルへの記録のみ**: `AdapterReconDrift` に `status='OPEN'` を書くだけで、ZC 本体の `Cases`/`openCase()` は一切呼んでいなかった。文書では「CASE に収束」と謳いながら、実際にはオペレーションが監視する経路に繋がっていなかった。 | 中（overclaiming） | `reconcileAccount` が `openCase()` を呼び、`AdapterReconDrift.case_id` で実際の `Cases` 行に紐づくようにした。 |
| 6 | **監査追跡性の欠如**: `AdapterOutbox` と `LegacyCoreJournal` に `txid` 列が無く、ZC 取引 ID との対応が `request_id` 文字列への暗黙の依存になっていた。 | 中（監査・規制対応上の弱点） | 両テーブルに `txid` 列を追加し、`PostingCmd.txid` から一貫して伝播するようにした。 |
| 7 | **本番コードがテスト専用メソッドを呼んでいた**: `initAccount()`（口座開設という正規の本番操作）が `forcePostForTest()`という明示的にテスト専用と書かれたメソッドを呼んでいた——本番経路とテスト経路の境界が曖昧だった。 | 軽微（コードの健全性） | `seedOpeningBalance()`（本番用）と `injectDriftForTest()`（テスト専用、ドリフト注入）に分離。 |
| 8 | **「勘定系ベンダーとして本当に接続できるか」の観点で見ると、アダプタがコアの内部テーブル（`LegacyCoreAccounts`/`LegacyCoreJournal`）に直接 SQL で書き込む設計になっていた**（#4 の是正で導入した `debitStatementsIfSufficient` が典型）。これは「アダプタとコアが同一トランザクションを共有する」ことを前提にしており、**現実のどの勘定系ベンダーも、外部の協調層に自社の元帳テーブルへの直接書き込みを許可しない**。「勘定系には開発を追加させない」という設計思想の核心と真っ向から矛盾する、設計上の重大な手戻り。 | **重大（この設計のままでは実在ベンダーが誰も接続できない）** | `LegacyCore` の公開面を `postCredit`/`postDebit`（不透明な呼出し、結果は `{applied:boolean}` のみ）に限定し、アダプタは二度と相手のテーブル名を書かない形に再設計。詳細は § ベンダー接続可否。 |
| 9 | **API別要求仕様（`10_requirements.md`、旧 `docs/specs/legacy_core_requirements.md`）の初版で、13コマンド中2つ（leg-ready-check・rtp-notify）を「GTID/RTPの多者協調ロジックが必要」として範囲外に分類していたが、これは誤りだった**（ユーザーからの技術的指摘により発覚）。実装を精査すると、leg-ready-check の PAYER脚は reserve-funds と、PAYEE脚は account-verify と全く同一の操作であり、rtp-notify は credit-notify と全く同一の純粋通知だった。GTID/RTP の協調ロジック自体は ZC オーケストレータ側に閉じており、銀行/コアの境界には現れない——**「ZC側の内部オーケストレーションの複雑さ」と「コアに要求する能力の複雑さ」を混同していた**。 | 中（不要な範囲外指定によるスコープの過小申告） | `legReadyCheck` を `reserveFunds`/`accountVerify` への薄い委譲として実装、`rtpNotify` を `creditNotify` と同じ `AdapterNotifications` 経由で実装。13/13コマンド対応に到達。詳細は [§ 要求仕様 4-a](10_requirements.md#req-4a)。 |

#### 監査で見つかったが、意図的に是正していない既知の限界

- **`LegacyCoreAccounts` は複式簿記ではない**: 単一の `balance` 列のみで、
  相手勘定（貸方/借方のペア）を持たない。現実の勘定系は通常、内部的に
  複式簿記でゼロサムを保つ（`bank/ledger.ts`/`BankJournals` はその実装）。
  本モデルはあくまで「アダプタから見える posting API の表面」を再現した
  ものであり、コア内部の会計処理までは模していない——複式簿記の破れに
  よる資金創出/消失のクラスのバグは、このモデル単体では検出できない。
- **通貨次元が無い**: `AdapterShadow`/`LegacyCoreAccounts` に通貨列が無く、
  単一通貨前提。`BankJournals` はすでに通貨ごとにゼロサムを検証する
  設計になっているのに対し、本サブシステムはそこまで拡張していない。
- **`BLOCKED` になった posting の再処理経路は未実装**: オーバードラフトで
  `BLOCKED` になった outbox 行は、CASE を通じた人手（テラー）解決を前提とし、
  自動再試行はしない。手動解決後に `PENDING` へ戻す運用フック（API/画面）は
  未実装。
- **物理的に分離したコアでの冪等性**: 本参照実装はアダプタと敵対的コアモデルが
  **同一 SQLite（同一プロセス）**を共有するため、claim-then-apply の
  各段階を単一の `db.batch()` でアトミックに扱える。物理的に分離した実コア
  （別ネットワーク越しの MQ/固定長 API）では、この一貫性は**コア書込 API 側の
  冪等キー**として実装する必要がある——本モデルが「同一 DB」という前提で
  簡略化している点は明記しておく。

---

