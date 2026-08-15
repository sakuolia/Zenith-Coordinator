# API契約定義（全エンドポイント）

`30_internal_design.md` 第12章（I/F契約：§12.1 cmd/event 正本、§12.4 冪等キー、§12.6 署名）・第13章（メッセージ定義）を踏まえたエンドポイント一覧。
**実装の正は稼働中のコードそのもの。データ定義の正は `31_schema.md`、API契約の正は本ファイルである。**

---

## ZC Core API

### 参加行→ZC 受付

#### POST /api/transfers
PaymentInitiated（`30_internal_design.md` §13.1 準拠）

Request:
```json
{
  "schema_version": "1.0",
  "message_type": "EVENT",
  "name": "PaymentInitiated",
  "message_id": "uuid",
  "idempotency_key": "string",
  "occurred_at": "RFC3339",
  "txid": "TX-...",
  "lane": "EXPRESS|STANDARD|BULK|DEFERRED|RTP|HTLC|HIGH_VALUE",
  "amount": { "value": 1200, "currency": "JPY" },
  "payer": { "bank_id": "001", "account_hash": "h:...", "vault_ref": "optional" },
  "payee": { "bank_id": "002", "account_hash": "h:optional", "vault_ref": "optional" },
  "purpose": "MERCHANT|P2P|BILL|SALARY|REFUND",
  "pspr_ref": "optional",
  "expires_at": "RFC3339",
  "is_cross_border": 0,
  "fatf_data": { "...FATF R16フィールド..." },
  "proxy_type": "optional",
  "proxy_value": "optional",
  "qr_ref": "optional",
  "mandate_id": "optional, e.g. MANDATE-..."
}
```

Response（レーン別・同期）:

| 指定 lane | HTTP | result | state | 語義 |
|---|---|---|---|---|
| `EXPRESS` | 200 | `DECISION_ACCEPTED` | `DECIDED_TO_SETTLE` | Decision（Raftコミット）まで完了し `decision_proof_ref` が発行済み（`20_method_design.md` §2.1） |
| `STANDARD` / `BULK` / `DEFERRED` | 200 | `INGRESS_ACCEPTED` | `RECEIVED` | `RECEIVED` が FinalityLog へ永続化済み。Decision は未確定 |
| `RTP` | 200 | `INGRESS_ACCEPTED` | `RECEIVED` | 同上（請求起点は `POST /api/rtp/request`。本エンドポイントは Attempt 成功後の実行 TX を受ける） |
| `HIGH_VALUE` | 200 | `INGRESS_ACCEPTED` | `RECEIVED` | 受理まで同期。以降は HIGH_VALUE フロー（`H_RESERVED` を経由しない） |
| `HTLC` | **422** | — | — | **本エンドポイントでは受理しない**。`USE_HTLC_ENDPOINT` を返す（下記） |

> **`lane=HTLC` を本エンドポイントで受理しない理由（規範）**: HTLC の受付には
> `hashlock` / `timelock`（およびクロスチェーン脚では `cross_chain`）が不可欠だが、
> `PaymentInitiated` のボディはこれらを運べない。したがって HTLC レーンの入口は
> **`POST /api/htlc/create` のみ**とし、本エンドポイントに `lane=HTLC` が来た場合は
> `422 USE_HTLC_ENDPOINT` で拒否する。
>
> **拒否は副作用の前に行う（規範）**: この拒否は、冪等キーの確保・`daily_amount_used` の
> 加算・`Transactions` 行と `PaymentInitiated` の書き込みの **いずれよりも前** に行わなければ
> ならない。後から拒否すると、(a) 日次上限の枠を消費したまま取引が成立しない、(b) 誰も前進
> させない `RECEIVED` 行が残る、という 2 つの説明できない状態が生じる（設計原則4 違反）。
> 実装は `src/zc/ingress/transfers.ts`（バリデーション直後のガード）。

`GTID` は本エンドポイントの lane 値ではない（`POST /api/gtid/register` が `201 GTID_ACCEPTED` /
`state: GT_RECEIVED` を返す）。`HTLC_AUTH` も lane 値ではなく、`lane=HTLC` 上のフローである
（`10_requirements.md` 序章「レーンと `lane` 列の関係」）。

> **`LaneType` に `HTLC` が残る理由**: 上表のとおり本エンドポイントは `lane=HTLC` を拒否するが、
> `HTLC` は依然として **API リクエスト値の値域（`src/types/states.ts#LaneType`）と
> `Transactions.lane` 列の値**である——`POST /api/htlc/create` が作る行は `lane='HTLC'` を持つ。
> 拒否されるのは「`POST /api/transfers` という入口での指定」であって、レーンそのものの
> 存在ではない。`GTID`（リクエスト値ではない）とは性質が異なるので混同しないこと。

> **HIGH_VALUE 自動エスカレーション（規範・lane 書換え可能性）**: `amount.value` が閾値（`PR-HV-THRESHOLD`。参加行個別 `Participants.hv_threshold` → 環境変数 `ZC_HV_THRESHOLD` → 既定 1 億円の順で解決、`30_internal_design.md` §12.9）以上の場合、リクエストが `lane=EXPRESS`/`STANDARD` を指定していても ZC は受付時点で `lane` を `HIGH_VALUE` に書き換える（`10_requirements.md` §1.2.4・§3.2.7）。書換えは 2 通りで観測できる。(1) **同期応答**：`EXPRESS` 指定なら本来 `{result: "DECISION_ACCEPTED", state: "DECIDED_TO_SETTLE"}` が返るところ、書換え後は `{result: "INGRESS_ACCEPTED", state: "RECEIVED"}` になる。(2) **照会 API**（`GET /api/transactions/:txid`）：`lane` が `HIGH_VALUE` となり、`state` 遷移経路も `PRECHECKED → DECIDED_TO_SETTLE`（`H_RESERVED` を経由しない）を辿る。FinalityLog の `PaymentInitiated` には書換え後の lane が記録される。

バリデーション:
- `tx_amount_limit` チェック（Participantsテーブル）
- `daily_amount_limit` チェック（アトミック UPDATE + meta.changes=0 パターン）
- クロスボーダー送金時は FATF R16 バリデーション（全レーン対象）
- `mandate_id` を指定する場合は `MANDATE-` で始まること（`INVALID_MANDATE_ID`）

`mandate_id`（エージェンティック・コマース／委任チェーン）:
- EXPRESS / STANDARD のプレチェック時に `assertMandateValid(db, mandate_id, {amount, purpose, lane}, now)`
  （`src/shared/mandate.ts`、`31_schema.md § Mandate`）で委任チェーンを検証する。
- `MANDATE_NOT_FOUND` / `MANDATE_REVOKED` / `MANDATE_EXPIRED` / `MANDATE_BREACH` の
  いずれかが発生した場合、即時拒否ではなく `PRECHECKED_SUSPENDED` へ遷移し、
  当該 reason_code で `Cases` を1件 open する（人/オペレーションによる解除待ち）。
- `mandate_id` を指定しないリクエストはこのチェックをスキップし、従来通り処理される。

#### POST /api/htlc/create
HTLC新規作成

Request:
```json
{
  "htlc_id": "HTLC-...",
  "hashlock": "sha256hex",
  "timelock": "RFC3339",
  "amount": { "value": 5000, "currency": "JPY" },
  "payer_bank_id": "001",
  "payer_account_hash": "...",
  "payee_bank_id": "002",
  "payee_account_hash": "...",
  "idempotency_key": "string",
  "cross_chain": {
    "source": "ONCHAIN:ETH",
    "onchain_timelock": "RFC3339"
  },
  "condition_template_id": "TPL-..."
}
```

`cross_chain`（任意、クロスチェーンHTLC）を指定すると、同じ
`hashlock` が `source` 下のオンチェーンエスクローもロックする。
`cross_chain.onchain_timelock` は `timelock` より厳密に前である必要があり、
そうでなければ `ONCHAIN_TIMELOCK_INVALID` で拒否される（ZC側の外側
タイムロックは常にオンチェーン側より長く保持される）。

`cross_chain` を指定する場合、`onchain_chain_class` は**必須**である
（`ONCHAIN_CHAIN_CLASS_REQUIRED`）。Watcher 定足数の既定は確定種別から導かれる
ため（`20_method_design.md` §7.7.2）、種別を欠いた脚は最弱の既定＝単一 Watcher に
落ちる。`min_watchers` を明示しても代替にならない——それは人数を決めるだけで、
確認深度が意味を持つ鎖かどうかを決めない。

`condition_template_id`（任意、プログラマビリティの汎用化）:
`TPL-` で始まる文字列（`INVALID_TEMPLATE_ID`）。指定すると、このHTLCは
`claim`（preimage提示）に加えて `claim-by-attestation`（当該テンプレートに
対するPASSアテステーション提示）でもfulfillできるようになる。ZCは
ConditionTemplateが実際にACTIVE/whitelistedかをこの時点では検証しない
（`claim-by-attestation`時に検証）。

#### POST /api/htlc/:htlc_id/claim
preimage提示（`30_internal_design.md` §13.5）

Request: `{ "htlc_id": "...", "preimage": "secret_hex", "idempotency_key": "string" }`

#### POST /api/htlc/:htlc_id/claim-by-attestation
署名付き成立証明（Attestation）によるHTLC fulfill（プログラマビリティの汎用化）。

「検品完了」「書類充足」「対象者該当」といった条件をZCがコードで
判定するのではなく、`condition_template_id`で指定されたwhitelist済み
ConditionTemplate（`30_internal_design.md` §15.5）に対する、`KeyRegistry`登録済みattesterの
署名付き成立証明（`verified_result: "PASS"`）の提示に還元する。
preimage提示（`claim`）と同じ `HTLC_LOCKED` → `HTLC_FULFILL_REQUESTED` →
`DECIDED_TO_SETTLE` 状態遷移を共有し、状態名は流用する。

Request:
```json
{
  "htlc_id": "HTLC-...",
  "template_id": "TPL-...",
  "statement_hash": "sha256hex",
  "verified_result": "PASS",
  "attester_key_id": "KEY-...",
  "nonce": "string",
  "occurred_at": "RFC3339",
  "signature": "base64",
  "idempotency_key": "string"
}
```

Response: `{ "result": "ACCEPTED"|"REJECTED", "htlc_id": "...", "state": "...", "reason_code"?: "..." }`

検証順序とreason_code:
- `htlc_id`未存在: `HTLC_NOT_FOUND`
- 対象HTLCに`condition_template_id`が設定されていない: `CONDITION_TEMPLATE_NOT_SET`
- `template_id`が`condition_template_id`と一致しない: `TEMPLATE_MISMATCH`
- 状態が`HTLC_LOCKED`でない: `INVALID_STATE`
- ZC側`timelock`超過: `TIMELOCK_EXPIRED`で`DECIDED_CANCEL`へ遷移
- `recordAttestation`（`30_internal_design.md` §15.5・`src/shared/attestation.ts`）によるwhitelist/署名/scope検証:
  `TEMPLATE_NOT_WHITELISTED` / `ATTESTATION_INVALID` /
  `ATTESTER_UNAUTHORIZED` / `KEY_*` / `EXTERNAL_SIGNATURE_INVALID` /
  `TIMESTAMP_SKEW` / `SIGNATURE_REPLAYED`
- アテステーションの鮮度切れ（`30_internal_design.md` §15.5.2、既定 60 分）: `ATTESTATION_EXPIRED`
- `verified_result !== "PASS"`: `ATTESTATION_NOT_PASS`（`HtlcClaimRejected`を
  FinalityLogに記録、状態は`HTLC_LOCKED`のまま）

ZCは下層の条件が実際に満たされたかどうかを判断しない。attesterの署名・
whitelist・scope・鮮度のみを検証し、`verified_result === "PASS"`を
そのまま成立条件として受理する。

#### POST /api/htlc/:htlc_id/claim-by-conditions
`condition_expr_json`（AND/OR/THRESHOLD 式木）による HTLC fulfill。
各リーフテンプレートを満たすか判定し、式が成立したときのみ
`HTLC_LOCKED → HTLC_FULFILL_REQUESTED → …` へ進む（`HtlcConditionsEvaluated`
を必ず証跡化）。リーフの満たし方は以下の 2 系統:

- **Attestation テンプレート**：提示された署名付き Attestation を
  `recordAttestation` で検証。`ConditionTemplate.min_attester_quorum`（既定1）
  に従い、**distinct な attester operator（`KeyRegistry.owner_ref`）の鮮度内
  PASS** が k 個揃って満たされる（k-of-n、Watcher の `onchain_min_watchers`
  と同型）。同一 operator の複数鍵は 1 と数える。同一 `(template, subject)` に
  PASS/FAIL が混在する **equivocation** は fail-closed（当該テンプレは不成立）
  とし、`ATTESTATION_EQUIVOCATION` の CASE へ収束（他の独立枝での成立は妨げない）。
- **決定的述語テンプレート**（`ledger_predicate_json` 非NULL）：外部表明を
  取らず、ZC が決定的に解決。種別は `TX_REACHED_STATE` /
  `GTID_REACHED_STATE`（確定 FinalityLog の状態）、`TIME_AFTER` / `TIME_BEFORE`
  （システム時刻に対する時刻ゲート）。Attestation の提示は無視する。時刻は
  JST（システム時刻）で、`at` にオフセットが無ければ JST とみなす。

Request: `{ "htlc_id", "attestations": [ {template_id, statement_hash, verified_result, attester_key_id, nonce, occurred_at, signature} ], "idempotency_key" }`（`attestations` は Attestation テンプレート分のみ。Ledger 述語のみの式では空配列可）

Response: `{ "result": "ACCEPTED"|"REJECTED", "htlc_id", "state", "reason_code"? }`
- 式不成立: `CONDITIONS_NOT_MET`（状態は `HTLC_LOCKED` のまま）
- 式未設定: `CONDITION_EXPR_NOT_SET` / 破損: `CONDITION_EXPR_INVALID`

#### 条件・マンデートのドライラン（読み取り専用）
副作用なし（書き込み・資金移動・Attestation 記録なし）。

- `POST /api/conditions/validate` — `{ condition_expr }` → `{ valid, error?, required_templates }`
- `POST /api/conditions/simulate` — `{ condition_expr, satisfied?: string[] }` → `{ valid, met, required_templates, satisfied, missing }`（不正式は400 `CONDITION_EXPR_INVALID`）
- `POST /api/mandates/check` — `{ mandate_id, amount?, purpose?, lane?, now? }` → `checkMandate` 結果 `{ ok, reason_code?, message? }`

#### POST /api/mandates/:mandate_id/revoke
委任の失効。`Mandate.revoked_at` を設定し、以後 `assertMandateValid` が `MANDATE_REVOKED` を返すようにする。冪等（再送は `already: true`）。

Request: `{ "reason"?: "string" }`

Response: `{ "result": "REVOKED", "mandate_id": "MANDATE-...", "revoked_at": "RFC3339", "already": false }`

- **失効は遡及しない。** `assertMandateValid` は `now >= revoked_at` で判定するため、失効前に成立した指図は影響を受けない（`31_schema.md § Mandate` 検証フロー 2）。
- 委任チェーンの親を失効させると、子も `MANDATE_REVOKED` として弾かれる（子は親のスコープを継承するため）。個別に子を失効させる必要はない。
- 継続収納契約（`DebitMandate`）が参照している委任を失効させた場合、当該契約も失効する。

エラー: `404 MANDATE_NOT_FOUND`。

> **背景**：`revoked_at` 列と失効判定は当初から実装されていたが、**それを書き込む本番経路が存在しなかった**（テストが直接 SQL を叩くのみ）。継続収納は「顧客がいつでも引落を止められる」ことを制度の前提に置くため、この穴を先に塞ぐ。

#### POST /api/htlc/:htlc_id/cross-chain-lock
クロスチェーンHTLC: オンチェーンエスクローのロックをWatcherが観測した
ことを記録する（クロスチェーンHTLC、Watcher専用）。`HTLC_LOCKED` →
`HTLC_ONCHAIN_PENDING`（`CrossChainLocked`イベント）。ZCはチェーンを
直接検査せず、`KeyRegistry`（`31_schema.md § KeyRegistry`）に登録されたWatcherの署名付き
観測のみを受理する。

Request:
```json
{
  "htlc_id": "HTLC-...",
  "external_ref": "0x...",
  "watcher_key_id": "KEY-WATCHER-...",
  "nonce": "string",
  "occurred_at": "RFC3339",
  "signature": "base64",
  "idempotency_key": "string"
}
```

Response: `{ "result": "ACCEPTED"|"REJECTED", "htlc_id": "...", "state": "...", "reason_code"?: "..." }`

対象でない/存在しない/状態不正の場合は `NOT_CROSS_CHAIN` /
`HTLC_NOT_FOUND` / `INVALID_STATE` を返す。

#### POST /api/htlc/:htlc_id/onchain-fulfillment
クロスチェーンHTLC: オンチェーンエスクローのプリイメージ公開を
Watcherが観測したことを記録する（クロスチェーンHTLC、Watcher専用）。
`HTLC_ONCHAIN_PENDING` → `HTLC_FULFILL_REQUESTED` → `DECIDED_TO_SETTLE`
→ ...（`OnchainProofObserved`イベント）。同じ`hashlock`がZC側・
オンチェーン側の両レッグをアンロックするため、`claimHtlc`と同一の
決済シーケンスが実行される。

Request:
```json
{
  "htlc_id": "HTLC-...",
  "external_ref": "0x...",
  "preimage": "secret_hex",
  "watcher_key_id": "KEY-WATCHER-...",
  "nonce": "string",
  "occurred_at": "RFC3339",
  "signature": "base64",
  "idempotency_key": "string"
}
```

Response: `{ "result": "ACCEPTED"|"REJECTED", "htlc_id": "...", "state": "...", "reason_code"?: "..." }`

- `preimage`が`hashlock`に一致しない場合: `ONCHAIN_PROOF_MISMATCH`
  （Watcherの署名/nonceを消費する前に拒否）。
- オンチェーン側内側タイムロック超過: `ONCHAIN_TIMEOUT`で
  `DECIDED_CANCEL`へ遷移。
- ZC側外側`timelock`超過: 既存の`TIMELOCK_EXPIRED`で`DECIDED_CANCEL`へ遷移。

#### POST /api/htlc/:htlc_id/capture
受取側キャプチャ（オーソリ型HTLC専用）

Request: `{ "idempotency_key": "string" }`

#### POST /api/htlc/:htlc_id/void
受取側ボイド（オーソリ型HTLC取消）

Request: `{ "idempotency_key": "string" }`

#### POST /api/htlc/auth-request
受取側起点オーソリリクエスト

Request:
```json
{
  "auth_id": "AUTH-...",
  "payee_bank_id": "001",
  "payee_account_hash": "...",
  "payer_bank_id": "002",
  "payer_account_hash": "...",
  "amount": { "value": 3000, "currency": "JPY" },
  "purpose": "MERCHANT",
  "description": "商品名等",
  "auth_expires_at": "RFC3339",
  "capture_expires_at": "RFC3339",
  "idempotency_key": "string",
  "eligibility_attestation": {
    "statement_hash": "...",
    "verified_result": "PASS",
    "attester_key_id": "KEY-...",
    "nonce": "...",
    "occurred_at": "RFC3339",
    "signature": "base64"
  }
}
```

- 期限は**絶対時刻（RFC3339）**で渡す。相対秒（かつて本節が記載していた
  `auth_timeout_seconds` / `capture_timeout_seconds`）は受理しない——受付側と発行側の
  時計差が期限の解釈差になり、キャプチャ可否が観測者によって変わってしまうため。
- 必須: `auth_id` / `payee_bank_id` / `payee_account_hash` / `payer_bank_id` /
  `payer_account_hash` / `amount` / `auth_expires_at` / `capture_expires_at` /
  `idempotency_key`。欠落は `400 MISSING_FIELDS`。
- `eligibility_attestation`（省略可・条件付き必須）: 対象のホワイトリスト
  （`payee_bank_id`/`payee_account_hash`）に `eligibility_template_id` が
  設定されている場合は必須。`recordAttestation()` / `assertAttestationFresh()`
  （`src/shared/attestation.ts`）で検証し、`verified_result==='PASS'` の場合のみ受理
  （`HtlcAuthRequests.eligibility_attestation_id` に記録、`FinalityLog` に
  `BenefitAttested` イベント）。未提供／FAIL／検証失敗は
  `ELIGIBILITY_NOT_ATTESTED`。

#### POST /api/htlc/auth/:auth_id/approve
送金側承認

Request: `{ "idempotency_key": "string" }`

#### POST /api/htlc/auth/:auth_id/decline
送金側拒否

Request: `{ "reason": "optional reason", "idempotency_key": "string" }`

#### GET /api/htlc/auth-requests
オーソリリクエスト一覧

Query: `?payer_bank_id=001&status=AUTH_REQUESTED`

#### GET /api/htlc/auth/:auth_id
オーソリリクエスト詳細

#### POST /api/htlc/auth-whitelist
ホワイトリスト登録

Request:
```json
{
  "payee_bank_id": "001",
  "payee_account_hash": "...",
  "allowed_payer_bank_id": "optional",
  "max_amount": 100000,
  "allowed_purposes": ["MERCHANT"],
  "description": "加盟店名",
  "expires_at": "optional RFC3339",
  "eligibility_template_id": "optional, TPL-..."
}
```

- `eligibility_template_id`（省略可）: `TPL-` プレフィックス必須。設定すると
  当該ホワイトリストへの `createAuthRequest()` は対象者該当性のアテステー
  ション（下記）を要求するようになる。プレフィックス不正は `400 INVALID_TEMPLATE_ID`。

#### GET /api/htlc/auth-whitelist
ホワイトリスト一覧

#### DELETE /api/htlc/auth-whitelist/:whitelist_id
ホワイトリスト削除

#### POST /api/gtid/register
GTID leg登録（GtLegRegistered）

Request:
```json
{
  "gtid": "GT-...",
  "legs": [
    { "leg_id": "L1", "role": "PAYER", "bank_id": "001", "account_hash": "h:...", "amount": { "value": 3000, "currency": "JPY" } },
    { "leg_id": "L2", "role": "PAYEE", "bank_id": "002", "account_hash": "h:...", "amount": { "value": 3000, "currency": "JPY" } }
  ],
  "expires_at": "RFC3339",
  "idempotency_key": "string"
}
```

`legs[].amount.currency` は `JPY` / `USD` / `EUR` / `GBP` / `CHF` のいずれか
（既定 `JPY`）。それ以外を指定すると `INVALID_CURRENCY` で拒否される。

**PvP（多通貨同時決済）**: legsが複数通貨に跨る場合、原子性は既存のGTID
all-or-nothing保証（leg_idの辞書順対応付け）のまま、PAYER/PAYEE総額の一致
チェック（`AMOUNT_BALANCE_MISMATCH`）が**通貨ごと**に行われる。H予約・DNS
サイクル（`DNS-{CCY}-YYYYMMDD-NN`）も脚の通貨ごとに独立して割り当てられる。

> **脚の正規化と `leg_id` の書き換え（規範）**: **PAYER と PAYEE の本数は一致していなくてよい。**
> 1×M（fan-out）も両側とも複数の一般形 N×M も受理・決済される。ただし ZC は受付時に脚集合を
> **通貨グループごとに 1:1 の部分取引へ正規化**したうえで決済経路へ渡すため、
> **登録した `leg_id` はそのまま残らないことがある**（fan-out は `{元のleg_id}~{連番}`、
> 一般形の分解は `{通し番号}~P~{元のleg_id}` / `{通し番号}~Q~{元のleg_id}`）。
> したがって `GET /api/gtid/:gtid` が返す脚は登録した脚と 1:1 とは限らず、**自分が付けた
> `leg_id` を照会キーとして仮定してはならない**（各口座の金額の総和は保存される）。
> **書き換えられた脚は `legs[].origin_leg_id` に登録時の `leg_id` を持つ**ので、
> 「自分のどの脚がここで決済されたのか」は照会で辿れる（登録どおりの脚では `null`）。
> 通貨をまたいだ相殺は行わない——ある通貨が単独で均衡しない構成は
> `AMOUNT_BALANCE_MISMATCH` で取消され、クロスカレンシーは FX レーン
> （`POST /api/fx/transfers`）が扱う。規則の正は `20_method_design.md` §2.2.5.1。

> **タイミングに関する注記**: `POST /api/gtid/register` 自体は形式が妥当な
> legsであれば常に同期的に `201 GTID_ACCEPTED`（`state: GT_RECEIVED`）を返す
> — この時点では通貨ごとの一致チェックは**実行されない**。実際の判定は
> Queueコンシューマ（`advanceGtid`、leg-ready-check後）で**非同期**に行われ、
> 不一致なら `GT_RECEIVED → GT_PRECHECKED → GT_CANCELLED`（reason
> `AMOUNT_BALANCE_MISMATCH`）に遷移する。クライアントは register の 201 を
> 「決済確定」と解釈してはならず、`GET /api/gtid/:gtid` で最終状態
> （`GT_DECIDED_TO_SETTLE` / `GT_CANCELLED`）を確認する必要がある。

### クロスカレンシー FX（要件 `10_requirements.md` 第6章／方式 `20_method_design.md` 第17章／内部設計 `30_internal_design.md` 第17章）
レートは整数固定小数（`RATE_SCALE = 1e8`。`rate=670000` は 1 from = 0.0067 to）。
FX送金は FXP を導管とする通貨別脚の GTID として既存 GTID レーンで原子決済される。

> **前提: レート形成はスコープ外。ZC は価格を作らない。** 実効レートのプライシング
> （建値・スプレッド・ヘッジ判断）は各 FXP が**系の外**で決める。ZC 側に為替オラクル・
> 参照レートフィード・レート算出ロジックは**存在しない**。API がやるのは、FXP が投入した
> レートの (1) 受理・保存（`PUT /api/fx/rates`、形式検査と FXP 資格ゲートのみ）、
> (2) 最良経路の集約・選定（`POST /api/fx/quote` / `transfers`、`routing.ts`）、
> (3) 有効期限と `min_effective_rate` による逆行ガードのみ。詳細は `20_method_design.md` §17.3 の前提。

#### PUT /api/fx/rates
FXプロバイダ(FXP)が**系外で決定した**方向別レートを upsert（FXP+ペアで1本のACTIVE見積を
上書き）。`is_fx_provider=1` の参加行のみ可（非FXPは `UNAUTHORIZED`）。サーバはレート値の
**形式（正の整数 ×`RATE_SCALE`）のみを検査し、値自体は補正・算出しない**（価格形成はFXPの裁量）。

Request:
```json
{
  "fxp_bank_id": "002",
  "from_currency": "JPY",
  "to_currency": "USD",
  "rate": 670000,
  "min_amount": 0,
  "max_amount": null,
  "valid_from": "RFC3339 (optional)",
  "valid_to": "RFC3339"
}
```
Response: `{ "result": "QUOTE_ACCEPTED", "quote": { ...FxQuotes row } }`

#### GET /api/fx/rates?from=JPY&to=USD
ペアの ACTIVE 見積一覧（rate 降順）。

#### DELETE /api/fx/rates/:quote_id
見積を WITHDRAWN にする。未存在/既取下げは `404`。

#### POST /api/fx/quote
最良経路の価格照会（コミットしない）。`denomination` は `PAYER`（from建て）/
`PAYEE`（to建て）。経路なしは `409 FX_NO_ROUTE`。

Request:
```json
{ "from_currency": "JPY", "to_currency": "USD", "amount": 1000000, "denomination": "PAYER", "max_bridge_hops": 1 }
```
Response: `{ "result": "ROUTE_FOUND", "rate_scale": 100000000, "route": { "hops": [...], "amount_from": 1000000, "amount_to": 6700, "effective_rate": 670000, "expires_at": "..." } }`

#### POST /api/fx/transfers
FX送金を起動。サーバが**権威的に再価格付け**（クライアント提示の経路は信用しない）。
`fxp_accounts` は各 FXP の通貨別決済口座（キー `"<bankId>:<currency>"`）。冪等。

Request:
```json
{
  "gtid": "GT-...",
  "idempotency_key": "string",
  "from_currency": "JPY", "to_currency": "USD",
  "amount": 1000000, "denomination": "PAYER",
  "payer": { "bank_id": "001", "account_hash": "h:..." },
  "payee": { "bank_id": "001", "account_hash": "h:..." },
  "fxp_accounts": { "002:JPY": "h:...", "002:USD": "h:..." },
  "min_effective_rate": 660000,
  "expires_at": "RFC3339 (optional)"
}
```
Response: `{ "result": "FX_TRANSFER_INITIATED", "gtid", "hashlock", "amount_from", "amount_to", "effective_rate", "route" }`。
エラー: `409 FX_NO_ROUTE` / `409 FX_RATE_MISMATCH`（min_effective_rate割れ）/
`409 FX_QUOTE_EXPIRED` / `400 FX_FXP_ACCOUNT_MISSING`。

**クロスレール原子性（HTLC束ね）**: リクエストに `"bind_htlc": true` を付けると、
即時決済せず各通貨脚を**共有ハッシュロック＋段階的タイムロック**でロックし、決済を
`/claim` まで遅延する（`20_method_design.md` §17.4.2）。Response は
`{ "result": "FX_TRANSFER_LOCKED", "gtid", "hashlock", "secret", "amount_from", "amount_to", "legs", "route" }`
（`secret` はここで生成した場合のみ。payee へ別経路で渡す）。

#### POST /api/fx/transfers/:gtid/claim
secret 公開で HTLC束ね送金を確定。`sha256(secret)==hashlock` を検証→全脚を一括 CLAIMED→
導管 GTID を登録・前進させて決済。冪等。Request: `{ "secret": "64-hex" }`。
Response: `{ "result": "FX_TRANSFER_CLAIMED", "gtid", "status": "SETTLED", "gtid_state", "already" }`。
エラー: `400 PREIMAGE_MISMATCH`（secret不一致）/ `404 GTID_NOT_FOUND` /
`409 FX_ALREADY_REFUNDED`（払戻済みは claim 不可）。

#### POST /api/fx/transfers/:gtid/refund
タイムロック満了後、未 claim の HTLC束ね送金を払戻（全脚 REFUNDED、資金移動なし）。
Response: `{ "result": "FX_TRANSFER_REFUNDED", "gtid", "status": "REFUNDED", "refunded_legs" }`。
エラー: `409 STATE_GUARD`（claim済み or タイムロック未満了）/ `404 GTID_NOT_FOUND`。

#### GET /api/fx/transfers/:gtid
FX送金の状態（FX固有事実＋GTID状態＋脚）。HTLC束ねの場合は脚ごとロック状態
（`leg_locks`: LOCKED/CLAIMED/REFUNDED＋timelock）も返す。未存在は `404 GTID_NOT_FOUND`。

#### POST /api/rtp/request
RTP請求登録

Request:
```json
{
  "rtp_id": "RTP-...",
  "payee_bank_id": "001",
  "payer_bank_id": "002",
  "amount": { "value": 2000, "currency": "JPY" },
  "expires_at": "RFC3339",
  "idempotency_key": "string",
  "payee_name": "optional",
  "description": "optional",
  "payee_account": "optional"
}
```

#### POST /api/rtp/:rtpId/respond
RTP請求への応答

Request: `{ "action": "ACCEPT|DECLINE", "payer_account_id": "...", "idempotency_key": "string" }`

#### GET /api/rtp/incoming
受信RTP請求一覧（payer側）

Query: `?account=XXXXXXXXXX`（口座番号先頭3桁で銀行ID自動判定）

#### POST /api/transfers/:txid/authorize
TransferAuthorize（Standard/HV: 支払人最終認可）

Request: `{ "txid": "...", "authorized": true, "idempotency_key": "string" }`

#### POST /api/transfers/:txid/cancel
取消（Decision前のみ）

Request: `{ "txid": "...", "reason_code": "CANCEL_BY_PAYER", "idempotency_key": "string" }`

#### POST /api/transfers/:txid/no-debit-proof
H_locked の自動解放（未実行証明・`20_method_design.md`（整合性・ファイナリティ設計））。PayerBank が「デビット未記録」を署名付きで提出し、ZC が `X-ZC-Signature` を検証のうえ H_locked を解放する。

Request: `{ "proof_ref": "PROOF-...", "bank_id": "001" }`（Header: `X-ZC-Signature`）

Response: `{ "ok": true, "result": "H_RELEASED", "txid": "...", "reservation_id": "H-...", "amount": 5000, "event": "NoDebitRecordedProofSubmitted" }`

検査順: 署名検証（`401 MISSING_SIGNATURE`/`INVALID_SIGNATURE`）が先、`proof_ref` 必須チェック（`400 PROOF_REF_REQUIRED`）はそのあと — 未認証の呼び出し元にフィールド欠落を教えないため（bank-ingress HTTP ラッパーと同じ順序）。

ガード: a（PAYER_EXEC_CONFIRMED）/ b（PAYEE_EXEC_CONFIRMED）成立済みは解放不可（`422 A_OR_B_CONFIRMED` → 補償＝Reversal 経路）。現在状態と FinalityLog 履歴の双方で判定。

#### POST /api/transfers/:txid/credit-failed-proof
Reversal の原因事由証明（三層ゲート**第1層**、`10_requirements.md` §4.3.0）。受取銀行が
「資金を先へ動かすことが**物理的に不能**である」ことを署名付きで提出し、ZC が
`X-ZC-Signature` を検証のうえ `CreditFailedProofSubmitted` を FinalityLog に追記する。
**この証明が記録されている取引だけが Reversal を起票できる。**

Request: `{ "proof_ref": "PROOF-...", "bank_id": "002", "reason_code": "optional" }`（Header: `X-ZC-Signature`）

Response: `{ "ok": true, "result": "CREDIT_FAILED_PROOF_RECORDED", "txid": "...", "already": false }`

検査順: 署名検証（`401 MISSING_SIGNATURE`/`INVALID_SIGNATURE`）が先、`proof_ref` 必須チェック
（`400 PROOF_REF_REQUIRED`）はそのあと（`no-debit-proof` と同じ順序）。

ガード（いずれも `422`、`ok:false` と `reason` を返す）:
- `B_NOT_CONFIRMED` — 元取引が `SETTLED` でない。**b 未成立なら巻き戻す対象が無い**ので、
  収束は取消または CASE であって Reversal ではない（`10_requirements.md` §4.3.0-4）。
- `PROOF_ISSUER_MISMATCH` — 発行者が受取銀行でない。この証明は受取側だけが知り得る事実に
  ついての主張であり、支払側に発行させれば Reversal が自己申告で通ってしまう。
- `ACCOUNT_CONDITION_NOT_A_CAUSE` — `reason_code` が口座都合
  （`ACCOUNT_FROZEN` / `ACCOUNT_CLOSED` / `ACCOUNT_NOT_FOUND` / `INSUFFICIENT_FUNDS` /
  `CLOSING_HOLD`）。これらは **Custody で吸収する設計**であり、証明の形を借りて原因事由に
  格上げすることを禁じる（`10_requirements.md` §4.3、`20_method_design.md` §6.3.1）。
- `TX_NOT_FOUND` — 元取引なし。

冪等：再送は `already: true` を返し、FinalityLog を二重に書かない。元取引の state は動かない
（証明は SETTLED な取引「についての」事実であり、その遷移ではない）。

#### POST /api/transfers/:txid/h-unlock-authorize
H_locked の運用解放（二重統制＝4 眼・`20_method_design.md`（整合性・ファイナリティ設計））。未実行証明が得られない場合に、2 名の異なる承認者と証跡参照を要件として解放する。

Request: `{ "approver_1": "ops.alice", "approver_2": "ops.bob", "evidence_type": "LEDGER_HASH|QUERY_SIGNATURE|AUTHORITY_CHECK", "evidence_ref": "...", "case_id": "CASE-..." }`

Response: `{ "ok": true, "result": "H_RELEASED", "event": "HUnlockAuthorized", ... }`

ガード: `approver_1 != approver_2`（`422 FOUR_EYES_REQUIRED`）、`evidence_ref` 必須（`422 EVIDENCE_REQUIRED`）、a/b 成立済みは解放不可（`422 A_OR_B_CONFIRMED`）。

#### POST /api/transfers/:txid/resume-namecheck
名義確認サスペンド（`PRECHECKED_SUSPENDED`）からの再開。`resumeFromNameCheckSuspended` が mandate を再検証のうえ `PRECHECKED_SUSPENDED → PRECHECKED` を CAS で進める（dedup 点）。

Response: `{ "result": "RESUMED", "txid": "...", "state": "..." }`

ガード: 未存在は `404 NOT_FOUND`、並行更新は `409 STATE_CONFLICT`、対象外状態は `409 INVALID_STATE`。

#### POST /api/transfers/:txid/misrecord-correct
誤記録訂正（`10_requirements.md`（法制度・契約構造との整合）「唯一の超例外」）。ZC障害等で `a`
（PayerExecConfirmed）が**実際にはデビットされていないのに誤って記録された**場合に限り、
その誤った証跡を訂正する。取消でも Reversal でもない（資金は動いていない）。
`correctMisrecord`（`src/zc/finality/misrecord.ts`）が 3 統制（時間ウィンドウ・4眼・証跡参照）を
検証し、`MisrecordCorrected` を追記（改ざんでなく追記）、`PAYER_EXEC_CONFIRMED → SUSPENDED`
へ戻し、CASE を1件 open する。`b`（PAYEE_EXEC_CONFIRMED）成立後は境界が不可逆のため訂正不可。

Request: `{ "approver_1": "ops.alice", "approver_2": "ops.bob", "evidence_type": "...", "evidence_ref": "...", "note": "optional" }`

Response: `{ "ok": true, "result": "MISRECORD_CORRECTED", "txid": "...", "case_id": "CASE-...", "state_from": "...", "state_to": "..." }`

ガード（いずれも `422`、`ok:false` と `reason` を返す）: `approver_1 != approver_2`
（`FOUR_EYES_REQUIRED`）、`evidence_type`/`evidence_ref` 必須（`EVIDENCE_REQUIRED`）、
`b` 成立済み・SETTLED は訂正不可で Reversal 経路（`B_CONFIRMED`）、訂正対象の `a` が無い
（`NO_MISRECORD`）、時間ウィンドウ超過（`WINDOW_EXPIRED`）、既訂正（`ALREADY_CORRECTED`）、
並行更新（`STATE_CONFLICT`）、対象外状態（`NOT_CORRECTABLE`）、未存在（`TX_NOT_FOUND`）。

---

### 口座確認・EDI・Proxy・QR・RichData

#### POST /api/account-verify
口座確認リクエスト（単件）

Request:
```json
{
  "verification_id": "V-...",
  "request_bank_id": "001",
  "target_bank_id": "002",
  "target_account_id": "0020000001",
  "name_to_verify": "佐藤 花子",
  "idempotency_key": "string"
}
```

- 宛先は **`target_account_id`**（口座番号。ZC は先頭 `h:` を剥がしたものを口座ハッシュと同一視する）。
  `request_bank_id` は省略時 `X-Bank-Id` ヘッダから補う。
- `name_to_verify` を省略すると**口座存在確認のみ**となる。
- 同一 `idempotency_key` の再送は既存の `verification_id` をそのまま返す。同一
  `(target_bank_id, target_account_id)` の有効なキャッシュがあれば銀行を呼ばずに複写する。

#### POST /api/account-verify/batch
口座確認リクエスト（一括）

Request:
```json
{
  "batch_id": "B-...",
  "request_bank_id": "001",
  "items": [
    { "target_bank_id": "002", "target_account_id": "0020000001", "name_to_verify": "..." }
  ],
  "idempotency_key": "string"
}
```

各 item は単件と同じ経路を通り、`idempotency_key` は `"{idempotency_key}-{index}"` で分割される。

#### GET /api/account-verify/:verificationId
口座確認結果照会

#### POST /api/edi/register
EDIレコード登録

Request:
```json
{
  "txid": "TX-...",
  "invoice_number": "INV-2026-001",
  "invoice_date": "2026-03-01",
  "payment_due_date": "2026-03-31",
  "tax_amount": 500,
  "tax_rate": 0.1,
  "discount_amount": 0,
  "note": "optional",
  "sender_ref": "optional",
  "receiver_ref": "optional",
  "line_items": [{"item": "商品A", "quantity": 1, "unit_price": 5000}]
}
```

#### GET /api/edi/tx/:txid
取引IDでEDI照会

#### GET /api/edi/:ediRef
EDI参照IDで照会

#### POST /api/proxy/register
プロキシ（エイリアス）登録

`proxy_type` の値域（実装の正: `src/types/states.ts#ProxyType`: `PHONE` | `EMAIL` | `NATIONAL_ID`）。

Request:
```json
{
  "proxy_type": "PHONE|EMAIL|NATIONAL_ID",
  "proxy_value": "090-xxxx-xxxx",
  "bank_id": "001",
  "account_id": "0010000001",
  "account_holder_name": "田中 太郎"
}
```

#### GET /api/proxy/resolve
プロキシ解決

Query: `?type=PHONE&value=090-xxxx-xxxx`

#### DELETE /api/proxy/:proxyId
プロキシ無効化

#### POST /api/qr/generate
QRコード生成

`type` の値域（実装の正: `src/types/states.ts#QrType`: `STATIC` | `DYNAMIC`）。

Request:
```json
{
  "type": "STATIC|DYNAMIC",
  "payee_bank_id": "001",
  "payee_account_id": "0010000001",
  "payee_name": "田中商店",
  "amount": 1000,
  "purpose": "MERCHANT",
  "expires_at": "optional RFC3339"
}
```

`type` は必須（`STATIC` / `DYNAMIC`）。`amount` は省略可で、指定する場合は
正の整数（最小通貨単位、通貨は `JPY` 固定）。必須欠落・型不正は `400`
（`INVALID_REQUEST` / `MISSING_FIELD` / `INVALID_AMOUNT`）で拒否される。

#### POST /api/qr/pay
QRコード決済実行

Request:
```json
{
  "qr_ref": "QR-...",
  "payer_bank_id": "002",
  "payer_account_id": "0020000001",
  "amount": 1000,
  "idempotency_key": "string"
}
```
→ 内部的に POST /api/transfers を呼び出してEXPRESS送金を起動

> **規範（単一使用）**：DYNAMIC QR は単一使用。消費は `is_used` の CAS（`... WHERE
> qr_ref = ? AND is_used = 0`）で行い、並行決済の敗者（`changes() == 0`）は
> `QR_ALREADY_USED` で拒否する。読取り時チェックのみでは TOCTOU により二重使用が
> 成立しうるため、行述語で原子的に消費すること。STATIC QR は任意回数再利用可。

#### GET /api/qr/:qrRef
QRコード照会

#### POST /api/richdata/store
リッチデータ格納

Header: `X-Bank-Id: 001`（格納主体。省略時は `UNKNOWN` として記録される）

Request:
```json
{
  "data_type": "EDI|INVOICE|ATTACHMENT_META|REMITTANCE",
  "bank_id": "001",
  "txid": "TX-...",
  "content": { "...任意のJSON..." }
}
```

- `data_type` の値域（実装の正: `src/types/states.ts#RichDataType`: `EDI` | `INVOICE` | `ATTACHMENT_META` | `REMITTANCE`）。値ごとに R2 退避時の D1 サマリ項目が異なる（`buildSummary`、`src/zc/richdata/richdata.ts`）。
- **保持期間はリクエストで指定できない**：`RICHDATA_DEFAULT_RETENTION_DAYS`（`src/shared/constants.ts`）が一律に適用され、`expires_at` が算出される。かつて本節は `retention_days` を受理するかのように記載していたが、実装は受け取らない。
- 本文が 50KB を超え `R2_BUCKET` バインディングがある場合は R2 へ退避し、D1 には `data_type` 別のサマリのみを保存する（`content_hash` は常に全文の SHA-256）。

#### GET /api/richdata/tx/:txid
取引IDでリッチデータ照会

#### GET /api/richdata/:dataRef
参照IDでリッチデータ照会

---

### クロスボーダー送金

#### POST /api/cross-border/send
クロスボーダー送金開始

Request:
```json
{
  "direction": "OUTBOUND",
  "foreign_fps_id": "SGPAYNOW",
  "foreign_bank_bic": "DBSSSGSG",
  "foreign_account_id": "1234567890",
  "foreign_currency": "SGD",
  "foreign_amount": 100,
  "domestic_amount": 10000,
  "exchange_rate": 100.0,
  "settlement_bank_id": "001",
  "fatf_data": {
    "originator":            { "name": "...", "account_id": "...", "address": "optional" },
    "beneficiary":           { "name": "...", "account_id": "..." },
    "ordering_institution":  { "bank_id": "001", "bank_name": "...", "country": "JP" },
    "beneficiary_institution": { "bank_id": "...", "bank_name": "...", "country": "SG" },
    "is_cross_border": true,
    "fatf16_applicable": true
  },
  "domestic_txid": "TX-..."
}
```

`fatf_data` の構造は `src/types/primitives.ts#FatfR16Data` を正とする（当事者は
`{name, account_id, address?, national_id?, date_of_birth?, place_of_birth?}` の入れ子。
平坦な `originator_name` / `beneficiary_name` は受理しない）。検証は
`src/shared/fatf_validator.ts` で、不備は水際で `FATF_VALIDATION_FAILED` / `FATF_DATA_REQUIRED`。

#### GET /api/cross-border/:cbTxid
クロスボーダー送金照会

#### POST /api/cross-border/:cbTxid/callback
外国FPSからのステータス更新

Request: `{ "status": "SETTLED|FAILED", "foreign_ref": "..." }`

---

### 照会

#### GET /api/transactions/:txid
QueryResponse（`30_internal_design.md` §13.6 準拠）

Response:
```json
{
  "txid": "TX-...",
  "state": "TxState",
  "reason_code": "optional",
  "decision": { "status": "NONE|DECIDED_TO_SETTLE|DECIDED_CANCEL", "decision_proof_ref": "optional" },
  "execution": { "a": "NONE|OK|NG", "b": "NONE|OK|NG", "payer_bank_proof_ref": "optional", "payee_bank_proof_ref": "optional" },
  "case": { "case_id": "optional", "status": "optional" },
  "as_of": "RFC3339",
  "watermark": 12345,
  "watermark_detail": { "shards": { "TX:TX-2026-0001": 12345, "GT:GTID-7": 67890 } },
  "freshness_level": "GREEN|YELLOW|RED",
  "next_action_hint": "WAIT|RETRY_LATER|CONTACT_PAYER_BANK|OPEN_CASE",
  "next_retry_at": "RFC3339 | null",
  "public_message_id": "IGS_HOLD_YYYY-MM-DD (optional)",
  "dns_settlement_status": "HOLD_ACTIVE (optional)",
  "external_settlement": { "status": "IgsStatus", "retriable": true }
}
```

- `next_action_hint` は**閉じた 4 値**（実装の正: `src/types/api/transfers.ts` の `QueryResponse.next_action_hint`：`WAIT` | `RETRY_LATER` | `CONTACT_PAYER_BANK` | `OPEN_CASE`）。事象固有の含意は `reason_code` が担い、事象ごとに新しい hint 値を作らない（`30_internal_design.md` §13.6）。
- `freshness_level` の閾値・測定基準および現行実装との差分は `30_internal_design.md` §13.6 を正とする。
- `watermark` は `watermark_detail.shards` の最大値、`watermark_detail.shards` は当該取引に関する事実を
  載せている各チェーンの `MAX(event_seq)`。キー書式（`TX:` / `GT:` / `DNS:`）と「参加していて未記帳の
  チェーンは 0 を返す」規範は `30_internal_design.md` §13.6 を正とする。
- `public_message_id` / `dns_settlement_status` は**清算サイクルが HOLD 中のときだけ**付与される
  （`20_method_design.md` §9.4.4.1）。2 つの場合を混同しないこと：
  (A) IGS リングフェンスで止まっている HIGH_VALUE は取引自体が未完了なので `public_message_id`
  （`IGS_HOLD_{business_date}`）を伴う。
  (B) 通常レーンの取引が既に `SETTLED` で、行間のネット清算だけが HOLD の場合は
  `dns_settlement_status: "HOLD_ACTIVE"` を参考情報として付すのみで、**取引未完了として表示しては
  ならない**。
- `external_settlement` は**中銀決済まで到達した取引にのみ**付く（`external_settlement_status != NONE`）。
  `status` の値域（実装の正: `src/types/states.ts#IgsStatus`: `REQUESTED` | `SETTLED` | `FAILED` |
  `HOLD` | `TIMEOUT`）。`retriable` は「待てば進みうるか」で、`HOLD` / `TIMEOUT` が `true`。
  **`reason_code` は HOLD と不成立を区別しない**ため、窓口の分岐はこのフィールドで行う
  （§状態 reason_code の注意、`20_method_design.md` §9.4.4.1 (A)）。中銀の生の失敗理由は
  相手方の不足を名指しし得るので運ばない（閉域は `hold_detail`）。
- 応答には上記のほか、UI 補助フィールド（`lane` / `amount_value` / 当事者 ID 等）が付随する。これらは QueryResponse 契約の一部ではなく、契約の対象は上記フィールドのみである。

#### GET /api/transactions
取引一覧

Query: `?state=...&payer_bank_id=...&payee_bank_id=...&lane=...&limit=50&offset=0`

#### GET /api/transactions/:txid/events
取引イベントログ照会

#### GET /api/transactions/:txid/explain
人間可読な状態遷移サマリー + 改ざん検知付き。`FinalityLog` を辿って
イベントごとに日本語の reason / actors を付与し、`integrity.chain_verified`
で同 TX のハッシュチェーン健全性を返す。

Response（抜粋）:
```json
{
  "txid": "TX-...",
  "lane": "EXPRESS",
  "current_state": "SETTLED",
  "summary": "送金は正常に最終確定しました",
  "timeline": [
    { "seq": 1, "at": "...", "event": "PaymentInitiated",
      "state_from": null, "state_to": "RECEIVED",
      "reason": "送金リクエストを受け付けました", "actors": ["ZC"], "payload": {} },
    ...
  ],
  "integrity": {
    "chain_verified": true,
    "entries_checked": 7,
    "break_at_seq": null,
    "break_reason": null,
    "algorithm": "SHA-256 hash-chain v2"
  },
  "proofs": { "decision_proof_ref": "...", "payer_bank_proof_ref": "...",
              "payee_bank_proof_ref": "...", "finality_log_ref": "..." }
}
```

#### GET /api/transactions/:txid/story
`/explain` の構造化データに加えて、ナラティブ段落 + Mermaid sequenceDiagram +
健全性ヴァーディクト（`OK | WATCH | STUCK | TERMINAL`）を返す。オペレータが
1 件の TX を画面でレビューする用途。

Response（抜粋）:
```json
{
  "txid": "TX-...",
  "headline": "[EXPRESS] 001 → 002 の ¥5,000 は最終確定済み",
  "narrative": "09:00:01 JST に 001 から 002 への ¥5,000 の取引（EXPRESS）が動き出しました。...",
  "mermaid_sequence": "sequenceDiagram\n  autonumber\n  ...",
  "pacing": {
    "started_at": "...", "last_event_at": "...", "elapsed_ms": 123,
    "longest_gap": { "from_event": "...", "to_event": "...", "gap_ms": 80 }
  },
  "health": { "status": "TERMINAL", "message": "...", "next_expected": [] },
  "integrity": { "chain_verified": true, "entries_checked": 7 }
}
```
`health.status = STUCK`（最後のイベントから 60 秒以上経過し、まだ終端状態に
到達していない）が返ったら運用調査の合図。

#### GET /api/transactions/:txid/verify
TX チェーンのハッシュチェーン全件検証＋副署必須化ポリシーの充足判定。

Response:
```json
{
  "chain_id": "TX-...",
  "valid": true,
  "entries_checked": 7,
  "break_at_seq": null,
  "break_reason": null,
  "algorithm": "SHA-256 hash-chain v2",
  "cosign": {
    "chain_id": "TX-...",
    "chain_kind": "TX",
    "required": true,
    "min_cosigners": 2,
    "cosign_count": 2,
    "satisfied": true,
    "basis_kind": "IRREVERSIBILITY",
    "basis_entry_hash": "…"
  },
  "finality_confirmed": true
}
```
`valid: false` のとき `break_reason` は
`LEGACY_UNCHAINED_ENTRY | PREV_HASH_MISMATCH | ENTRY_HASH_MISMATCH` のいずれか。
`finality_confirmed` は **ハッシュチェーン健全（`valid`）かつ副署必須化ポリシー充足
（`cosign.satisfied`）** のときだけ `true`。当該チェーン種別（TX/GTID/DNS）に
mandatory ポリシーが設定されていなければ `cosign.required=false` で常に充足扱い。

> **規範（副署は「基準エントリ」に対して行う。現 tip に対して行ってはならない）**
> 副署の対象は**動かないエントリ**でなければならない。定足数とは「相異なる k 者が
> **同一のハッシュ**に署名した」ことであり、tip は通常の業務追記のたびに動くから、
> tip に署名させると 2 人目は別のハッシュに署名することになり、**どの単一ハッシュに対する
> 計数も 1 を超えられない**。すなわち `min_cosigners >= 2` の mandatory ポリシーは
> 原理的に充足不能になる。
>
> したがって基準エントリ（basis entry）を次の優先で決める（`resolveCosignBasis`,
> `src/zc/finality/finality_anchor.ts`）。
> 1. **当該チェーンの不可逆点を記録したエントリ**——TX は `PAYEE_EXEC_CONFIRMED`（b）、
>    GTID は `GT_SETTLED`、DNS はサイクルの `SETTLED`。
> 2. 無ければ、**直近アンカーが固定した当該チェーンの tip**（`FinalityAnchor.chain_tips_json`）。
> 3. どちらも無ければ `COSIGN_BASIS_NOT_FOUND`。**tip へフォールバックしてはならない**
>    ——上の欠陥をそのまま呼び戻すためである。
>
> 応答の `cosign` は `basis_kind`（`IRREVERSIBILITY` / `ANCHOR`）と `basis_entry_hash` を
> 併せて返す。参加行が何に署名すべきかは、この値が唯一の出所である。
>
> **この帰結として `finality_confirmed` は単調である。** 基準エントリは動かないので、
> k 者が署名し終えた後にチェーンへ追記があっても `cosign_count` は 0 に戻らない。
> 本節はかつて「tip が動けば `cosign_count` は 0 に戻る。これは実装上の欠落ではなく
> 意味論の帰結である」と書いていたが、これは**誤り**であった——「副署は署名した時点までの
> 履歴を覆う」という意味論は正しく、そこから導かれるのは「署名対象を履歴上の固定点に
> 取る」ことであって、「毎回 0 に戻る」ことではない。どの固定点を制度上の「外部確定」と
> みなすか（不可逆点のエントリか日次アンカーか）は上記 1/2 の優先として本節が定める。
>
> **`finality_confirmed=false` を「ファイナリティが取り消された」と読んではならない。**
> 決済の不可逆性（b）を表すのは取引の `state` であり、本フィールドは
> 「**外部検証者に提示できる副署が、基準エントリに対して揃っているか**」を表す。

#### GET /api/gtid/:gtid/verify
#### GET /api/dns/:cycle_id/verify
GTID／DNS チェーン専用の検証。Response 形は `/transactions/:txid/verify`
と同形（`chain_id` に gtid／cycle_id が入る）。

#### POST /api/finality/cosign
当該チェーンの当事者参加行（TX=payer/payee、GTID=leg 銀行、DNS=ネットポジション
銀行）が、チェーンの**基準エントリ**（上記 `/verify` の規範。`cosign.basis_entry_hash`
で取得する）に副署する。署名は `KeyRegistry`（`owner_type='PARTICIPANT'`）で検証。Body:
```json
{ "chainId": "DNS-2026-06-30", "participantId": "002", "signerKeyId": "KEY-002",
  "nonce": "n-002", "occurredAt": "2026-06-30T07:30:00.000Z", "signatureB64": "..." }
```
署名対象は `{chain_id, entry_hash}`（`entry_hash` = 基準エントリ）。ZC 側でも
`resolveCosignBasis` で同じ値を解決するため、tip に対する署名は検証に通らない。
失敗時は `COSIGN_NOT_APPLICABLE | COSIGN_ENTRY_NOT_FOUND | COSIGN_BASIS_NOT_FOUND |
COSIGN_PARTICIPANT_MISMATCH` ほか `KEY_*` / `EXTERNAL_SIGNATURE_INVALID` /
`SIGNATURE_REPLAYED` / `TIMESTAMP_SKEW`。

#### PUT/GET /internal/cosign-policy/:kind  （`:kind` = TX | GTID | DNS）
副署必須化ポリシーの設定／参照（運用 API、`X-Cron-Secret` 必須）。
PUT Body: `{ "min_cosigners": 2, "is_mandatory": true }`。mandatory を設定すると、
その種別のチェーンは required 数の相異なる参加行が**基準エントリ**に副署するまで
`/verify` の `finality_confirmed` が `false` になる。

#### GET /api/events
全体イベントログ（最近N件）

Query: `?limit=100&offset=0`

Index: `idx_fl_occurred_at`。

#### GET /api/gtid/:gtid
GTID照会

#### GET /api/gtid
GTID一覧

Query: `?limit=20&offset=0`

#### GET /api/gtid/:gtid/events
GTIDイベントログ照会

#### GET /api/htlc/:htlc_id
HTLC照会

#### GET /api/htlc
HTLC一覧

Query: `?limit=50&offset=0`

#### GET /api/dns/:business_date/status
DNS状態照会

→ `{ "state": "OPEN|KICKED|SETTLED|HOLD_ACTIVE", "igs_mode": "NORMAL|STOP|RINGFENCED|RINGFENCED_PLUS", "cycle_id": "...", "business_date": "YYYY-MM-DD", "public_message_id": "DNS_HOLD_YYYY-MM-DD|null" }`

- `state` の値域（実装の正: `src/types/states.ts#DnsState`: `OPEN` | `KICKED` | `SETTLED` | `HOLD_ACTIVE`）。
- **当該営業日のサイクルがまだ生成されていない場合のみ** `{ "state": "NOT_STARTED", "business_date": "..." }` を 200 で返す（`NOT_STARTED` は `DnsState` の値ではなく、「行が無い」ことを 404 ではなく状態として返すための応答専用の特例値。実装 `src/zc/query/query.ts#handleGetDnsStatus`）。
- `igs_mode` の値域（実装の正: `src/types/states.ts#IgsMode`: `NORMAL` | `STOP` | `RINGFENCED` | `RINGFENCED_PLUS`）。
- `RECALC_EXCLUDING_BANK` は**本応答の値ではない**（中央銀行が返す清算結果の種別。`20_method_design.md` §9.4.4 の規範）。
- `public_message_id` は HOLD 中のみ非 NULL（`DNS_HOLD_{business_date}`）。参加行はこの ID に
  対応する事前承認テンプレにのみ顧客表示を限定する（`10_requirements.md` §3.3.1-3/-4）。
  **本応答は全参加主体向けであり、原因行・不足額は決して含めない**——含まれるのは
  「HOLD である」という公式ステータスと、それに対応するテンプレ ID だけである。

#### GET /api/dns/:business_date/position
参加行ネットポジション照会

→ `{ "business_date": "YYYY-MM-DD", "positions": [ { "cycle_id": "DNS-...", "bank_id": "001", "net_position": -1200000, "gross_send": ..., "gross_receive": ..., "is_settled": 0 }, ... ] }`
（`net_position` は ＋受取／−支払）

> **フィールド名の正（規範）**：ネットポジションの項目名は **本節を正**とする（`net_position` / `gross_send` / `gross_receive`）。`20_method_design.md` §9.4.4 は「ネットポジション」「グロス送信／受信」という業務語で規範を述べ、項目名は本節を参照する形に整理してある。
>
> **未充足**：`20_method_design.md` §9.4.4 (A) は本照会に `as_of` / `watermark`（鮮度）の付与を規範として求めているが、**本契約は付与していない**。同節の規範は「事務が回るための必須要件」として書かれているため、この差分を充足済みとして扱ってはならない（`30_internal_design.md` 第10章 Roadmap で追跡）。

#### GET /api/dns/:business_date/hold_detail
DNS_HOLD の閉域詳細照会。**閉域認可を持つ主体（当該の負け参加行・監督当局・中央銀行・ZC運営）
のみ**が呼べる（`20_method_design.md` §9.4.4 (B) が「事務が回るための必須要件」として規範化）。

リクエストヘッダ:
```
X-Purpose-Code: P01|P02|P03|P04|P05|P06|P07   # 必須（`10_requirements.md` §3.3.2.2.1）
X-Bank-Id:      001                            # 参加行スコープ（当該の負け参加行のみ）
X-Cron-Secret:  <CRON_SECRET>                  # 運営スコープ（ZC運営・監督当局・中央銀行）
```

- **認可が無い呼び出しは `403` ではなく `404 NOT_FOUND`** を返す。HOLD が発生しているか
  どうか自体が閉域情報であり、`403` は「無い」と「見せない」を区別してしまう——
  「あの行は今日ショートしているのか」は取り付けの引き金そのものである。
- 次の 4 つはすべて**同一の 404 本文**を返し、応答から HOLD の有無を推測できないようにする：
  目的コード欠落／呼び出し主体不明／当該営業日に HOLD 無し／当事者でない参加行。
- **目的コードの無い呼び出しは実時間で遮断し、`DataAccessViolationDetected` を GLOBAL チェーンへ
  記録する**（`10_requirements.md` §3.3.2.2.1.1-2。事後監査ではなく遮断が規範）。
- 認可された読み取りも `ClosedDomainAccessGranted` として記録する。ZC が提供する中で最も機微な
  読み取り（原因行の特定情報と不足額）であるため、拒否だけでなく許可も監査対象とする。
- スコープ差: 参加行は**自行の不足額のみ**、運営スコープはサイクル全体の合計を得る。
- `collateral_call_amount` は不足額に復旧リザーブと同じバッファ率
  （`DNS_RECOVERY_RESERVE_BUFFER_RATE`）を乗じた値。「何を差し入れるべきか」と
  「ZC がこの HOLD に対して見込むリザーブ」を 1 つのバッファ率から導き、二重管理を避ける。
- 実装: `src/zc/query/query.ts#handleGetDnsHoldDetail`・`src/zc/settlement/dns/query.ts#getDnsHoldDetail`、
  認可プリミティブは `src/zc/platform/purpose.ts`。

Response:
```json
{
  "business_date": "2026-06-30",
  "cycle_id": "DNS-JPY-20260630-01",
  "shortfall_amount": 1200000000,
  "collateral_call_amount": 1500000000,
  "recommended_actions": ["MARKET_FUNDING", "LENDING_REQUEST", "COLLATERAL_PLEDGE"],
  "contact_channel": "...",
  "as_of": "RFC3339"
}
```

> **規範**: 本エンドポイントの応答は**閉域情報**であり、`GET /api/dns/:business_date/status`
> （全参加主体向け・公式ステータスと完全一致）には決して含めない
> （`10_requirements.md` §3.2.5.1・`20_method_design.md` §9.4.4）。

#### GET /api/boj/positions
各参加行の日銀預け金勘定（BOJ）残高照会（公開API・プリファンド型RTGSの残高モニタ、
プリファンド型RTGSの残高可視化）。
→ `{ "positions": [ { "bank_id": "001", "boj_balance": 100000000000 }, ... ], "as_of": "RFC3339" }`
（同等データの運用内部版は `GET /internal/boj-positions`。そちらは `as_of` を付けない）

#### GET /api/cases/:case_id
CASE照会

#### POST /api/cases/:case_id/update
CASE状態更新

Request: `{ "state": "IN_PROGRESS|RESOLVED|ESCALATED" }`

- 値域の正は実装の `src/zc/cases/case.ts#CASE_UPDATE_STATES`。**それ以外は `400 INVALID_STATE`**。
- `OPEN` は受け付けない。CASE が生まれる状態であり、そこへ戻すと「いつ開いたか」が曖昧になる——
  解決後に再び作業が要る事象は、同じ txid に紐づく**新しい CASE** として起票する
  （b 成立後の救済を別取引で行うのと同じ理由。`10_requirements.md` §4.3）。

#### GET /api/system-mode
ZC全体の運用モード照会（縮退モード）
→ `{ "mode": "NORMAL|BCP_READONLY|QUORUM_LOSS_READONLY", "reason": "...|null", "activated_at": "...|null", "updated_at": "..." }`

`mode` の値域（実装の正: `src/types/states.ts#SystemModeValue`: `NORMAL` | `BCP_READONLY` | `QUORUM_LOSS_READONLY`）。

縮退モードは2種類。いずれも新規の資金移動（状態確定）を拒否し、照会系は影響を受けない。

- `BCP_READONLY`：運用者が宣言するベンダー障害縮退（可搬性と縮退）。`bcp-activate`/`bcp-deactivate` で操作。
- `QUORUM_LOSS_READONLY`：設計原則10の自動縮退。単一正本性を担保する合意ログが quorum を喪失した際、誤決定を避けるため自動的に read-only へ縮退し、quorum 回復で自動復帰する。運用者トグルでは解除できない（`bcp-deactivate` は当モード中は `SYSTEM_QUORUM_LOSS_READ_ONLY` で拒否）。

#### POST /internal/system-mode/bcp-activate
`BCP_READONLY`（ベンダー障害縮退モード）へ移行。冪等。

Request: `{ "reason": "Cloudflare regional outage" }`

#### POST /internal/system-mode/bcp-deactivate
`NORMAL` へ復帰。冪等。`QUORUM_LOSS_READONLY` 中は拒否（quorum 回復まで縮退を維持）。

#### POST /internal/system-mode/quorum-report
合意ログのレプリカ到達性を報告し、ZC のモードを quorum 健全性と整合させる（設計原則10）。
運用の健全性監視がレプリカ集合の到達状況を POST し、ZC は quorum 喪失で `QUORUM_LOSS_READONLY` へ縮退、回復で `NORMAL` へ復帰する。運用者宣言の `BCP_READONLY` は上書きしない。

Request: `{ "reachable": ["tokyo", "osaka"] }`（省略時はメンバ全到達＝健全とみなす）
→ `{ "health": { "total": 3, "reachable": 2, "required": 2, "hasQuorum": true, ... }, "mode": {...}, "action": "DEGRADED|RESTORED|NO_CHANGE" }`

メンバ集合は `ZC_QUORUM_REPLICAS`（カンマ区切り、未設定時は3レプリカ既定）。quorum は厳密過半数（`floor(N/2)+1`）。

#### GET /internal/system-mode
現在の運用モード照会（運用ダッシュボード用）。

---

### SSE（Server-Sent Events）

#### GET /api/sse/events/:bankId
銀行宛リアルタイムイベントストリーム

レスポンス: `text/event-stream` 形式。EventStreamテーブルから未配信イベントをポーリング。

---

### IGS

#### POST /api/igs/callback
日銀ネット即時グロス清算のコールバック

Request:
```json
{
  "ext_instruction_id": "...",
  "status": "SETTLED|FAILED",
  "boj_settle_ref": "optional",
  "failed_reason": "optional"
}
```

---

### 先進的アーキテクチャ実験（Advanced Features）

#### GET /api/stream/connect
Rafiki風 ストリーミング・マイクロ決済 (WebSocket)
接続確立後、`{ "type": "START", "gtid": "..." }` を送信し、`{ "type": "PACKET", "amount": 10 }` 等を複数回送信可能。
一定間隔のDO AlarmによってD1にまとめてStateが記録される。

#### GET /api/als/lookup
Mojaloop風 O(1) エイリアス解決ディレクトリキャッシュ

Query: `?alias=phone:090xxxx`
Response: `{ "bank_id": "001", "account_hash": "...", "pspr_ref": "..." }`

---

### Reversal（救済取引）

SETTLED 済み TX に対する苦情・誤送金・二重送金などへの補償フロー。
起票可否の判定は `10_requirements.md` §4.3.0（Reversal の三層ゲート）、API と reason 区分は同 §4.3.1、データ構造は `31_schema.md § ReversalRecords`。

#### POST /api/reversals
補償取引を起票する。一部の `reason` は `approval_ref` 必須（社内統制の事前
承認チケット番号など）。受理されると lane=STANDARD, purpose=REFUND の
新規 TX が生成される。

Request:
```json
{
  "original_txid": "TX-...",
  "amount": 5000,
  "reason": "ReversalReason",
  "requested_by": "001 (bank_id) | OPS",
  "approval_ref": "string (required when reason ∈ APPROVAL_REQUIRED_REASONS)",
  "description": "optional"
}
```

`reason` の値域（実装の正: `src/zc/cases/reversal.ts#ReversalReason`: `CUSTOMER_DISPUTE` |
`DUPLICATE_PAYMENT` | `INCORRECT_AMOUNT` | `INCORRECT_PAYEE` | `FRAUD` | `OPERATIONAL_ERROR`）。
意味は `10_requirements.md` §4.3.1 を正とする。**値をここで散文的に例示しない**——かつて本節は
`WRONG_RECIPIENT` という実在しない値を例に挙げ続けており（`10_requirements.md` 側では既に
除去済みだった）、宣言の書式に寄せることで CI の値域照合の対象になる。
Response 201:
```json
{
  "result": "REVERSAL_CREATED",
  "reversal_id": "REV-...",
  "reversal_txid": "TX-...",
  "status": "TX_CREATED"
}
```
Response 422 の `reason_code`:
- `CREDIT_FAILED_PROOF_REQUIRED` — **第1層未充足**。`POST /api/transfers/:txid/credit-failed-proof`
  が未提出。この場合、要求は握り潰さず **CASE として受理**し、応答に `case_id` を返す
  （`10_requirements.md` §4.3.0-1「満たさない顧客異議は Reversal ではなく CASE として受理し、
  当事者間の解決へ接続する」）。顧客異議は実在する事象であって、それ自体は巻き戻しの根拠ではない。
- `APPROVAL_REF_REQUIRED` — 第2層（内部統制版）未充足。`APPROVAL_REQUIRED_REASONS` に該当する
  `reason` に `approval_ref` が無い。
- `ORIGINAL_NOT_FOUND` / `ORIGINAL_NOT_SETTLED` / `INVALID_REVERSAL_AMOUNT` / `OVER_REVERSAL`。

> **検査順（規範）**: 金額の妥当性・累計超過は**第1層ゲートより前**に評価する。逆順にすると、
> 単なる入力ミスのたびに CASE が起票され、誰かがそれを閉じる仕事が増える。ゲートは AND なので
> 順序は結果を変えないが、**運用負荷は変える**。

#### GET /api/reversals/:reversal_id
特定 Reversal の状態と関連 TX を返す。

#### GET /api/transactions/:txid/reversals
ある TX に紐づく Reversal 一覧。

---

### Circuit Breaker（参加行疎通監視）

ZC→Bank 呼び出しの連続失敗に対するブレーカー。状態は `CLOSED → OPEN → HALF_OPEN → CLOSED`。
詳細は `31_schema.md § CircuitBreakerState` / `10_requirements.md`（制度・ガバナンス要件）。

#### GET /api/circuit-breaker
全行のサーキットブレーカー状態とメトリクスを一覧。

Response:
```json
{ "circuit_breakers": [
  { "bank_id": "001", "state": "CLOSED", "consecutive_failures": 0,
    "total_requests": 1234, "total_successes": 1200, "total_failures": 34,
    "total_denied": 0, "half_open_inflight": 0,
    "last_success_at": "...", "last_failure_at": "..." },
  ...
] }
```

#### GET /api/circuit-breaker/:bank_id
特定行のサーキットブレーカー状態。未登録（メトリクスがまだ無い）行は
`state: CLOSED` の初期値が返る（404 ではない）。

#### POST /api/circuit-breaker/:bank_id/reset
強制 CLOSED へリセット（運用オペレーション）。

Response: `{ "result": "RESET", "bank_id": "..." }`

---

### 継続収納（口座振替） <a id="direct-debit-api"></a>

制度要件は [`10_requirements.md` §3.2.8](10_requirements.md#dd-layers)、処理方式は [`20_method_design.md` §2.2.7](20_method_design.md#direct-debit-flow)、スキーマは `31_schema.md § ZC テーブル（継続収納）`。

**呼び出し主体は常に参加行である。** 受取人（収納事業者）は ZC の参加者ではなく受取行の顧客であり、収納の起票も結果の受領も受取行を経由する（[`10_requirements.md` §3.2.8.8-4](10_requirements.md#dd-payee-eligibility)）。ZC が受取人と直接やり取りする経路は設けない。

#### POST /api/debit-mandates
継続収納契約の登録。顧客が `buildMandatePayload` の正規ペイロードに署名し、`KeyRegistry` で検証する（`registerMandate` と同じ経路）。

Request:
```json
{
  "payer_bank_id": "002",
  "payer_account_alias": "tel:+81-90-...",
  "payee_bank_id": "001",
  "payee_account_hash": "h:...",
  "product_ref": "◯◯ゴールドカード ****1234",
  "charge_mode": "PERIODIC",
  "period_cycle": "MONTHLY",
  "collection_mode": "SCHEDULED",
  "notice_days_min": 14,
  "amend_freeze_hours": 33,
  "ladder_max": 3,
  "caps": {
    "per_collection": 30000, "month_amount": 30000, "month_count": 2,
    "two_month_amount": 50000, "lifetime_amount": null, "lifetime_count": null,
    "pending_amount": 60000, "pending_count": 4,
    "latefee_month": 500, "latefee_rate_max": 0.146,
    "realtime_month_count": 0, "variance_ratio_max": 1.5
  },
  "eligibility_attestation": { "...": "受取行が署名した適格性証明" },
  "mandate": { "principal_key_id": "KEY-...", "nonce": "...", "occurred_at": "RFC3339",
               "signature": "base64", "valid_from": "RFC3339", "valid_to": "RFC3339" },
  "idempotency_key": "string"
}
```

Response: `{ "result": "REGISTERED", "dd_mandate_id": "DDM-...", "mandate_id": "MANDATE-...", "effective_collection_mode": "SCHEDULED", "demoted": false }`

- **`effective_collection_mode` は払出行のプロファイルから導出する。** 要求モードを提供できない行（Tier 1 等）では自動降格し、`demoted: true` と `demotion_reason` を返す（[`10_requirements.md` §3.2.8.2-4](10_requirements.md#dd-modes)）。**黙って挙動を変えない。**
- **認可期限は必須ではない。** 無期限は `valid_to` の番兵値で表現する（[`10_requirements.md` §3.2.8.1-4](10_requirements.md#dd-layers)）。
- 宣言した上限が制度上限（`PR-DD-*`）を超える場合は `422 CAP_EXCEEDS_POLICY`。
- `collection_mode='REALTIME'` は既定で不許可（`422 REALTIME_NOT_PERMITTED`）。開放は制度判断による。

エラー: `401 MISSING_SIGNATURE` / `INVALID_SIGNATURE`、`409 KEY_REVOKED`、`422 CAP_EXCEEDS_POLICY` / `LADDER_MAX_EXCEEDS_POLICY` / `REALTIME_NOT_PERMITTED` / `MODE_UNSUPPORTED_BY_PAYER_BANK`。

#### PATCH /api/debit-mandates/:dd_mandate_id/caps
上限の変更。**方向により要件が非対称である**（[`10_requirements.md` §3.2.8.4-10](10_requirements.md#dd-budget)）。

| 方向 | 顧客署名 |
| --- | --- |
| 引き下げ | 不要 |
| 引き上げ | **必要**（実質的に新たな委任であるため） |

Request: `{ "caps": { ... }, "mandate"?: { 引き上げ時のみ必須の署名一式 }, "idempotency_key": "string" }`

Response: `{ "result": "CAPS_UPDATED", "dd_mandate_id": "DDM-...", "raised": ["month_amount"], "lowered": ["month_count"] }`

- **消費済みカウンタはリセットしない**（引き上げ→引き下げの往復による消費の洗浄を防ぐ）。
- 引き上げに署名がなければ `401 SIGNATURE_REQUIRED_FOR_RAISE`。

#### DELETE /api/debit-mandates/:dd_mandate_id
契約の失効。顧客・受取行のいずれからも可能（顧客に不利益が生じないため）。冪等。

Response: `{ "result": "REVOKED", "dd_mandate_id": "DDM-...", "revoked_at": "RFC3339", "superseded_collections": 2, "already": false }`

失効は以後の解錠を全滅させる。未確定の予告は `SUPERSEDED` ではなく `LAPSED` として終端し、件数を返す。

#### GET /api/debit-mandates/:dd_mandate_id
契約単位の照会。**未来の予定を含む**（[`10_requirements.md` §3.2.8.8](10_requirements.md#dd-payee-eligibility)、G6）。

Response: 契約内容・累計枠の消費状況（残枠つき）・過去の収納履歴・**次回以降の予定（ラダー全段）**。当事者判定と目的コードは[照会の認可](#query-authorization)に従う。

#### GET /api/debit-mandates?payer_account_alias=...
顧客の「私が許可している引き落とし一覧」。実物の口座振替が提供しない可視性であり、本制度の固有の価値にあたる。

#### POST /api/collections
収納予告の登録。ラダーの全段を一括で登録する。**予告を経ない収納は存在しない。**

Request:
```json
{
  "dd_mandate_id": "DDM-...",
  "charge_ref": "2026年4月分",
  "edi_ref": "EDI-...",
  "rungs": [
    { "ladder_seq": 1, "amount": 9800, "latefee": 0,   "due_date": "2026-04-27" },
    { "ladder_seq": 2, "amount": 9800, "latefee": 50,  "due_date": "2026-04-28" },
    { "ladder_seq": 3, "amount": 9800, "latefee": 150, "due_date": "2026-05-13" }
  ],
  "idempotency_key": "string"
}
```

Response:
```json
{ "result": "COLLECTION_NOTICED",
  "collections": [ { "collection_id": "COL-...", "ladder_seq": 1, "state": "SCHEDULED",
                     "due_date": "2026-04-27", "amend_freeze_at": "2026-04-26T15:00:00+09:00",
                     "confirm_deadline_at": "2026-04-28T00:00:00+09:00" } ],
  "budget_reserved": true }
```

- **全段が予告時点で顧客に開示される**（[`10_requirements.md` §3.2.8.5-5](10_requirements.md#dd-notice)）。再請求の時期と金額を顧客が事前に知り得ることが本制度の要件である。
- **遅延損害金は元本と分離して登録する**（`latefee`）。総額への溶かし込みは受理しない。段ごとに固定額であり、計算式は受け付けない。
- 累計枠は**この時点で予約される**（[`10_requirements.md` §3.2.8.4-1](10_requirements.md#dd-budget)）。枠は資金ではなく認可の配分であるため、予告時点で押さえても顧客は何も失わない。
- **第 2 段以降を `REALTIME` にできない**（[`10_requirements.md` §3.2.8.5-7](10_requirements.md#dd-notice)）→ `422 LADDER_RUNG_CANNOT_BE_REALTIME`。
- スコープ超過は却下せず、当該段を `AWAITING_ADDITIONAL_AUTH` として返す（`state` を見ること）。

エラー: `404 DD_MANDATE_NOT_FOUND`、`409 CHARGE_REF_ALREADY_COLLECTED`（当該費目は既に `CONFIRMED_OK`）、`422 BUDGET_RATE_EXCEEDED` / `BUDGET_EXHAUSTED` / `NOTICE_PERIOD_TOO_SHORT` / `LADDER_MAX_EXCEEDED` / `LATEFEE_EXCEEDS_POLICY` / `CHARGE_REF_INVALID`（`PERIODIC` の構造検証違反・`PR-DD-PERIOD-AHEAD-MAX` 超過）。

#### PATCH /api/collections/:collection_id
予告の変更。**凍結が止めるのは不利益変更のみである**（[`10_requirements.md` §3.2.8.5-3](10_requirements.md#dd-notice)）。

| 操作 | 凍結前 | 凍結後 |
| --- | --- | --- |
| 減額・予定日の後ろ倒し | 可 | **可** |
| 増額・予定日の前倒し | 可 | **不可**（`422 FROZEN_UNFAVOURABLE_CHANGE`） |

**変更は上書きせず追記する**（`CollectionAmended` を FinalityLog へ）。「先月いくらで予告されていたか」が消えてはならない。

#### DELETE /api/collections/:collection_id
予告の取下げ（`WITHDRAWN`）。顧客に有利な変更であるため**凍結後も常に可能**。他手段での入金があった場合の正当な運用経路である。予約済みの累計枠は解放する。

#### GET /api/collections/:collection_id
収納の状態照会。

Response:
```json
{ "collection_id": "COL-...", "charge_ref": "2026年4月分", "ladder_seq": 1,
  "state": "FIRED", "settlement_status": "ACCEPTED", "result": null,
  "confirmed": false, "confirm_deadline_at": "2026-04-28T00:00:00+09:00",
  "retriable_today": true,
  "attempts": [ { "attempt_no": 1, "observed_at": "...", "result": "NG",
                  "reason_code": "INSUFFICIENT_FUNDS", "retriable_today": true } ],
  "txid": "TX-..." }
```

> **`settlement_status` の語義（規範）**：`ACCEPTED` は**受理・照合済みであって収納完了ではない**。この値で売掛の消し込みを行ってはならない。`confirmed: false` を必ず併せて返すのは、`ACCEPTED` を成功と読み違えた実装が消し込みを走らせる事故を防ぐためである。確定は `CONFIRMED_OK` / `CONFIRMED_NG` のみが表す（[`10_requirements.md` §3.2.8.6-8](10_requirements.md#dd-finality)）。他手段との二重収納の防止は受取人の責任であり、ZC の債務はこの信号の品質に限られる。

`retriable_today` は当日中の再挑戦余地の有無。`ACCOUNT_NOT_FOUND` 等は当日の入金では解決しないため、受取人が督促対象を絞れるようにする。**督促そのものは ZC の外側で行われる。**

#### POST /api/collections/:collection_id/additional-auth
追加認可（再許諾）。スコープ超過で `AWAITING_ADDITIONAL_AUTH` にある収納を、顧客の署名により通す。

Request: `{ "decision": "APPROVE" | "DECLINE", "mandate"?: { 単発認可の署名一式 }, "idempotency_key": "string" }`

Response: `{ "result": "APPROVED"|"DECLINED", "collection_id": "COL-...", "state": "SCHEDULED"|"DECLINED_BY_PAYER", "extra_mandate_id": "MANDATE-..." }`

- **既定は単発認可**（当該 `charge_ref`・当該金額・1 回限りのスコープ）。恒久的な引き上げを望む場合は `PATCH /api/debit-mandates/:id/caps` を用いる。
- **単発認可は枠を迂回せず、枠に加算する**（[`10_requirements.md` §3.2.8.7-4](10_requirements.md#dd-reauth)）。
- **無応答は拒否である。** 振替日までに応答がなければ `LAPSED` となり、**ラダー全体が終了する**（後続段は発火しない）。この既定を反転させてはならない——沈黙を同意とみなすと本機構自体が過大請求の経路となる。

#### GET /api/directory/banks/:bankId/collection-profile
払出行の勘定系プロファイルの公開ビュー。**公知情報**（銀行の取扱時間は約款等で公表される運用事実）であり、受取人が「この行の顧客なら何時までに入金してもらえば間に合うか」を自ら算定できるようにする。

Response: `{ "bank_id": "002", "supported_modes": ["SCHEDULED","SCHEDULED_LONG"], "center_cut_schedule": ["00:00","12:00","20:00"], "realtime_name_check": true, "last_attempt_guidance": "20:00" }`

収納ごとの状態ではなく**静的な参照データ**である。`LegacyProfile` の `window_open_hour` / `window_close_hour` / `realtime_name_check` から導出する。

---

### 管理・設定

#### POST /api/pspr/register
PSPR登録

Request: `{ "pspr_ref": "...", "payee_bank_id": "001", "account_hash": "h:...", "expires_at": "RFC3339" }`

#### POST /api/participants/register
参加行登録（初期投入用）

Request: `{ "bank_id": "001", "bank_name": "長岡銀行", "ingress_base_url": "/bank/001", "h_limit": 100000000 }`

#### GET /api/banks
参加行一覧

#### POST /api/banks/add
参加行追加（シミュレーター用: 銀行＋システム勘定を一括作成）

Request: `{ "bank_id": "003", "bank_name": "加賀銀行", "h_limit": 100000000, "participant_type": "GOVERNMENT" }`

- `participant_type`（省略可）: `"BANK"`（既定）| `"GOVERNMENT"`。給付発起参加者
  の類型化。不正な値は `400 INVALID_INPUT`。

#### DELETE /api/banks/:bankId
参加行削除

#### GET /api/banks/:bankId/accounts
参加行の口座一覧

#### GET /api/accounts/:accountId/name
口座名義照会

---

### OpenAPI仕様書

#### GET /api/openapi/zc.yaml
ZC APIのOpenAPI仕様書（YAML）

#### GET /api/openapi/bank.yaml
Bank APIのOpenAPI仕様書（YAML）

---

## ZC→Bank Ingress API（13本・Bank Mockが実装）

### SettlementProofRef（`bank_proof_ref` の一般化）

`bank_proof_ref` の型は `BankProofRef`/`SettlementProofRef`（同一型の別名）。
`proof_type` の値域（実装の正: `src/types/primitives.ts#ProofType`:
`PAYER_EXEC_PROOF` | `PAYER_HV_ISOLATION_PROOF` | `PAYEE_EXEC_PROOF` |
`NO_DEBIT_RECORDED_PROOF` | `ONCHAIN_ESCROW_LOCK_PROOF` | `ONCHAIN_RELEASE_PROOF` |
`CREDIT_FAILED_PROOF` | `EXT_REFUND_PROOF`）と
既存フィールド（`issuer_bank_id`, `proof_id`, `recorded_at`, `custody_detail`）は不変。
値の意味の全体像は `30_internal_design.md` §12.3.3 を正とする。
**`proof_type` と `venue` は直交する別軸**であり、`SettlementProofRef` は型の別名であって
`proof_type` の値ではない（同§の規範）。以下の4フィールドを**加法的**
（すべて optional/nullable）に追加し、銀行勘定確認以外の証跡型
（日銀ネット／オンチェーン／第三者アテステーション）を同列に扱う。

```json
{
  "issuer_bank_id": "001",
  "proof_type": "PAYEE_EXEC_PROOF",
  "proof_id": "PROOF-...",
  "recorded_at": "RFC3339",
  "custody_detail": null,
  "venue": "BANK_LEDGER",
  "external_ref": null,
  "signer_key_id": null,
  "verified_at": null
}
```

- `venue`: `"BANK_LEDGER"`（既定・参加行勘定確認）| `"IGS_BOJ"`（日銀ネット相当）
  | `"ONCHAIN"`（オンチェーン移転証明）| `"ATTESTATION"`（第三者アテステーション）
  | `"CB_TOKEN"`（トークン化中央銀行当座預金での確定）。
  既存の `createProof()`（参加行勘定確認、`src/shared/proof.ts`）が生成する
  proof は省略可（実質 `BANK_LEDGER`）。
  `CB_TOKEN` は非JPY通貨のファイナリティ・レール：各通貨の中央銀行（ECB / FedNY…）
  がトークン化した当座預金をチェーン上で確定させる。ZC は外国中銀へ直接接続できない
  ため、発行体の署名付き観測（`source='CB_TOKEN:{中銀}:{チェーン}'`）を
  `KeyRegistry` で検証した証跡のみ受理する。トークン化JPYは BOJ クラシック当座に
  追加するレール（`src/shared/central_bank.ts`）。
- `external_ref`: 当該 venue 内での参照（チェーン上の tx ハッシュ／IGS-ID／
  アテステーションID）。`venue=BANK_LEDGER` では未使用。
- `signer_key_id`: 証跡に署名した外部主体の `KeyRegistry.key_id`。
- `verified_at`: ZC が `src/shared/external_signature.ts` で署名検証に成功
  した時刻（RFC3339）。

`venue != "BANK_LEDGER"` の証跡は `src/shared/proof.ts` の
`createSettlementProof()` で生成する。このパスは内部で
`verifyExternalSignature()` を呼ぶため、`KeyRegistry` 未登録・失効・署名
不正の場合は §エラーカタログの `KEY_*` / `EXTERNAL_SIGNATURE_INVALID` /
`SIGNATURE_REPLAYED` を返す。

全エンドポイントは `POST /bank/{bank_id}/zc-ingress/...`

共通リクエストヘッダー（ZC の egress 署名は**二重受け**。`X-ZC-Key-Id` の有無で判別）:
```
# 非対称署名パス（新方式・優先）: X-ZC-Key-Id が在るときこちらが選択される
X-ZC-Key-Id:    KEY-...          # KeyRegistry の署名鍵 key_id（owner_type='ZC'）
X-ZC-Sig-Nonce: string           # 鍵ごとに一意な nonce（リプレイ防止）
X-ZC-Sig-Time:  RFC3339          # 署名時刻
X-ZC-Signature: base64           # buildSignedMessage(...) への署名

# HMAC パス（旧方式・後方互換）: X-ZC-Key-Id が無いときのフォールバック
X-ZC-Signature: HMAC-SHA256-hex

X-Idempotency-Key: string        # 参考。ingress の冪等判定はボディの request_id（ZcRequests）で行う
Content-Type: application/json
```

検証は `handleBankIngressHttp`（`src/bank/ingress.ts`）が行い、`X-ZC-Key-Id`
ヘッダーの有無で非対称署名（`verifyZcSignature`、`src/shared/zc_signature.ts`）と
HMAC（`verifySignature`、`src/shared/hmac.ts`）を判別する。いずれも失敗時は
`401 INVALID_SIGNATURE`、HMAC パスで署名欠落時は `401 MISSING_SIGNATURE`。この
段階的二重受けは §メッセージ・スキーマ進化と互換性政策 で述べる移行パターンの実例である。

### POST /bank/:bankId/zc-ingress/reserve-funds
H_RESERVED確保要求

Request:
```json
{
  "request_id": "uuid",
  "txid": "TX-...",
  "amount": { "value": 1200, "currency": "JPY" },
  "account_hash": "h:..."
}
```

Response OK: `{ "result": "RESERVED", "reservation_ref": "uuid" }`
Response NG: `{ "result": "ERROR", "reason_code": "INSUFFICIENT_FUNDS" }`

### POST /bank/:bankId/zc-ingress/execute-debit
a実行指示（PayerExecRequested準拠、`30_internal_design.md` §13.2）

Request:
```json
{
  "request_id": "uuid",
  "txid": "TX-...",
  "amount": { "value": 1200, "currency": "JPY" },
  "decision_proof_ref": "DP-...",
  "h_reservation": { "reservation_id": "H-...", "mode": "RESERVED" },
  "execution_deadline": "RFC3339",
  "lane": "EXPRESS|...",
  "payer_account_hash": "h:..."
}
```

Response: `{ "result": "OK", "bank_proof_ref": { "issuer_bank_id": "001", "proof_type": "PAYER_EXEC_PROOF", "proof_id": "...", "recorded_at": "RFC3339" } }`

※ HIGH_VALUEレーンは reserve-funds を経由しないため `payer_account_hash` を直接渡す

### POST /bank/:bankId/zc-ingress/execute-credit
b実行指示（PayeeExecRequested）

Request:
```json
{
  "request_id": "uuid",
  "txid": "TX-...",
  "amount": { "value": 1200, "currency": "JPY" },
  "decision_proof_ref": "DP-...",
  "payee_account_hash": "h:..."
}
```

Response: `{ "result": "OK", "bank_proof_ref": { "issuer_bank_id": "002", "proof_type": "PAYEE_EXEC_PROOF", "proof_id": "...", "recorded_at": "RFC3339", "custody_detail": null } }`
※ Custody発生時: `"custody_detail": { "is_custody": true, "reason_code": "ACCOUNT_CLOSED", "custody_account_ref": "..." }`

### POST /bank/:bankId/zc-ingress/release-reserve
H_RESERVED解放

Request: `{ "request_id": "uuid", "txid": "TX-...", "reservation_ref": "uuid" }`

Response: `{ "result": "RELEASED", "reservation_ref": "uuid" }`

### POST /bank/:bankId/zc-ingress/leg-ready-check
GTID事前レディネス確認

Request:
```json
{
  "request_id": "uuid",
  "gtid": "GT-...",
  "leg_id": "L1",
  "role": "PAYER|PAYEE",
  "amount": { "value": 3000, "currency": "JPY" },
  "account_hash": "h:..."
}
```

Response: `{ "result": "OK" }` または `{ "result": "NG", "reason_code": "INSUFFICIENT_FUNDS" }`

### POST /bank/:bankId/zc-ingress/authority-check
AML/制裁スクリーニング

Request:
```json
{
  "request_id": "uuid",
  "txid": "TX-...",
  "check_type": "INITIAL|RECHECK",
  "vault_ref": "optional"
}
```

Response: `{ "result": "OK" }` または `{ "result": "NG", "reason_code": "SANCTIONS_MATCH" }`

### POST /bank/:bankId/zc-ingress/name-check
名義確認

Request:
```json
{
  "request_id": "uuid",
  "txid": "TX-...",
  "pspr_ref": "optional",
  "account_hash": "h:..."
}
```

Response: `{ "result": "MATCH" }` または `{ "result": "MISMATCH", "reason_code": "NAME_MISMATCH" }`

### POST /bank/:bankId/zc-ingress/account-verify
口座確認（ZCからBankへ照会）

Request:
```json
{
  "request_id": "uuid",
  "verification_id": "V-...",
  "target_account_hash": "h:...",
  "target_account_name": "佐藤 花子"
}
```

Response: `{ "result": "MATCHED|MISMATCHED|NOT_FOUND", "match_score": 1.0, "name_provided": "...|null", "fraud_warning": false }`

- `match_score` は完全一致 1.0 ／ 編集距離 1 以内 0.8（表記ゆれ吸収）／ それ以外 0.0。
- 照合対象の名義（`name_provided`）は**要求側が渡した文字列**をそのまま返す。**行内に保管された
  名義そのもの（かつて本節が `actual_name` として記載していたもの）は返さない**——
  返せば、口座番号を総当たりして名義を収集する経路になる。したがって ZC 側の
  `AccountVerifications.target_account_name` は本経路では埋まらない。
- `target_account_name` を省略した場合は口座存在確認のみとなり `MATCHED` / `match_score: 1.0`。
- **本節の項目名は ZC 側 `POST /api/account-verify` の項目名と一致しない**（ZC が
  `target_account_id`/`name_to_verify` を受け、境界で `target_account_hash`/`target_account_name`
  へ写す）。両端の型は `src/types/api/bank-ingress.ts#BankAccountVerifyIngressRequest` /
  `#BankAccountVerifyIngressResponse` を**唯一の宣言**とし、呼び手（`src/zc/directory/account_verify.ts`）と
  受け手（`src/bank/ingress/verify.ts`）の双方がこれを import する——両端が別々に同名の型を
  宣言していた間、項目名がずれていても型検査が通り、当コマンドは口座を解決できないまま
  出荷されていた。

### POST /bank/:bankId/zc-ingress/credit-notify
入金結果通知

Request:
```json
{
  "request_id": "uuid",
  "txid": "TX-...",
  "payee_account_hash": "...",
  "amount": { "value": 1200, "currency": "JPY" },
  "payer_bank_id": "001",
  "payer_name_masked": "タ●●",
  "purpose": "P2P"
}
```

Response: `{ "result": "NOTIFIED" }`

### POST /bank/:bankId/zc-ingress/rtp-notify
RTP請求通知（payee → payer bank）

Request:
```json
{
  "request_id": "uuid",
  "rtp_id": "RTP-...",
  "payee_bank_id": "001",
  "payer_bank_id": "002",
  "amount": { "value": 2000, "currency": "JPY" },
  "expires_at": "RFC3339",
  "payee_name": "田中商店",
  "description": "optional"
}
```

Response: `{ "result": "NOTIFIED" }`

### POST /bank/:bankId/zc-ingress/debit-settled
決済完了通知（払出行＝発起行向け）。ZC が TX を SETTLED まで確定させた後に送り、
着金が相手方へ届き end-to-end で最終確定したことを知らせる（全銀将来ビジョン
入金結果通知の払出側）。行内では監査証跡（`BankAuditLog`）を残すのみ。冪等。

Request:
```json
{
  "request_id": "uuid",
  "txid": "TX-...",
  "amount": { "value": 1200, "currency": "JPY" },
  "payee_bank_id": "002",
  "settled_at": "RFC3339"
}
```

Response: `{ "result": "ACKNOWLEDGED", "txid": "TX-..." }`

### POST /bank/:bankId/zc-ingress/initialize-bank
参加行側の勘定・仕訳の初期化。ZC は参加行登録（Participants）のみを行い、行内勘定
（別段預金 SUSPENSE／ZC清算勘定 SETTLEMENT／現金 ASSET／利益剰余金 EQUITY／日銀預け金
BOJ）と初期仕訳は各行が用意する（設計原則: 金融機関は既存の責務を保持）。冪等
（別段預金が既存なら `ALREADY_INITIALIZED`）。

Request: `{ "request_id": "optional uuid", "boj_prefund": 100000000000 }`（`boj_prefund` 省略時は1000億円のBOJプレファンド）

Response: `{ "result": "INITIALIZED"|"ALREADY_INITIALIZED", "bank_id": "001" }`

### POST /bank/:bankId/zc-ingress/cleanup-bank
参加行離脱時の行内データ（勘定・仕訳・金利設定・日次残高）削除。ZC側データ
（Participants・ZcRequests・SuspenseDetails 等）は別途ZCが削除する。

Request: `{}`（ボディ不要）

Response: `{ "result": "CLEANED_UP", "bank_id": "001" }`

---

## Bank 顧客API（顧客向け）

共通ヘッダー: `X-Bank-Id: 001`, `X-Customer-Id: customer_uuid`（モック用・認証なし）

#### GET /bank/:bankId/v1/me/accounts
口座一覧

#### GET /bank/:bankId/v1/me/accounts/:accountId/balance
残高照会 → `{ "account_id": "...", "balance": 980000, "currency": "JPY", "as_of": "RFC3339" }`

#### GET /bank/:bankId/v1/me/accounts/:accountId/transactions
取引履歴

#### POST /bank/:bankId/v1/me/transfers
振込実行（全ZCレーン対応）

Request:
```json
{
  "amount": { "value": 5000, "currency": "JPY" },
  "payee_bank_id": "002",
  "payee_account_hash": "h:...",
  "payee_account_id": "0020000001",
  "lane": "STANDARD",
  "purpose": "P2P",
  "idempotency_key": "uuid",
  "payer_account_id": "optional"
}
```

`payee_account_id` 指定時は `payee_bank_id` を口座番号先頭3桁から自動導出可能。

#### GET /bank/:bankId/v1/me/transfers/:txid
振込状態照会

#### GET /bank/:bankId/v1/me/approvals
着金承認リクエスト一覧

Query: `?account_id=...&status=PENDING`

#### POST /bank/:bankId/v1/me/approvals/:approvalId/respond
着金承認への応答

Request: `{ "approved": true }`

承認時はZCにresume_creditを通知（Queue経由）。

---

## Bank 行員API（行員向け）

共通ヘッダー: `X-Bank-Id: 001`, `X-Teller-Id: teller_id`（モック用・認証なし）

#### POST /bank/:bankId/v1/teller/cash/deposit
現金入金

#### POST /bank/:bankId/v1/teller/cash/withdrawal
現金払い戻し

#### GET /bank/:bankId/v1/teller/accounts
口座一覧（行員用）

#### POST /bank/:bankId/v1/teller/accounts
口座作成

#### POST /bank/:bankId/v1/teller/accounts/batch
口座一括作成

#### PATCH /bank/:bankId/v1/teller/accounts/:accountId/status
口座ステータス更新（NORMAL/FROZEN/CLOSING_HOLD/CLOSED）

#### GET /bank/:bankId/v1/teller/accounts/:accountId/journals
口座の仕訳照会

#### GET /bank/:bankId/v1/teller/journals
全仕訳照会（行全体）

#### GET /bank/:bankId/v1/teller/suspense
別段預金一覧

#### POST /bank/:bankId/v1/teller/suspense/:suspenseId/resolve
別段預金収束処理（Custody解消等）

#### GET /bank/:bankId/v1/teller/batch/status
バッチ処理状態照会

#### GET /bank/:bankId/v1/teller/audit-log
監査ログ照会

Query: `?txid=TX-...&limit=100`

---

## Bank 着金フィルタAPI

#### GET /bank/:bankId/v1/filters
フィルタ一覧

Query: `?account_id=...`

#### POST /bank/:bankId/v1/filters
フィルタ作成

Request:
```json
{
  "scope": "ACCOUNT",
  "account_id": "0010000001",
  "filter_type": "AMOUNT_LIMIT|SENDER_BLOCK|SENDER_BANK_BLOCK|EDI_PATTERN|REQUIRE_APPROVAL",
  "condition": { "max_amount": 50000 },
  "action": "REJECT|HOLD_CONFIRM|HOLD_MANUAL",
  "description": "5万円超の着金を承認制に"
}
```

値域の正（実装）: `src/types/states.ts#FilterType`: `AMOUNT_LIMIT` | `SENDER_BLOCK` |
`SENDER_BANK_BLOCK` | `EDI_PATTERN` | `REQUIRE_APPROVAL` ／
`src/types/states.ts#FilterAction`: `REJECT` | `HOLD_CONFIRM` | `HOLD_MANUAL`。

#### DELETE /bank/:bankId/v1/filters/:filterId
フィルタ削除

#### PATCH /bank/:bankId/v1/filters/:filterId
フィルタ有効/無効切替

Request: `{ "is_active": false }`

---

## 内部API（Cron用・外部公開しない）

`X-Cron-Secret` ヘッダー検証必須。

> **規範（管理シークレットの取扱い）**：`CRON_SECRET` の照合は **定数時間比較**
> （`timingSafeEqualStr`）で行い、応答タイミングからの逐次的な秘密復元を防ぐ。
> ヘッダ欠落・環境側未設定はいずれも **fail-closed**（403）で拒否し、空文字どうしの
> 一致を通過扱いにしてはならない。また `CRON_SECRET` を **クライアントへ配信される成果物
> （ダッシュボード HTML/JS 等）へ埋め込んではならない**。埋め込むと view-source で全
> `/internal/*` 操作の認可を回避できてしまう。運用ダッシュボードは秘密を実行時に運用者から取得し
> sessionStorage 等に保持する（実装 `src/router/internal.ts`、`src/dashboard/*.html`、
> 回帰 `test/invariants/dashboard_secret_guard.test.ts`）。

#### GET /internal/metrics
運用メトリクス（権威状態の読み取り専用射影）。既定は Prometheus テキスト展開形式
（`Content-Type: text/plain; version=0.0.4`）、`?format=json` で JSON を返す。書き込みを
行わないため read-only 縮退中でもスクレイプ可能。実装 `src/zc/platform/metrics.ts`。

#### POST /internal/cron/eod
EODバッチ手動トリガー

#### POST /internal/cron/timeout-sweep
タイムアウト巡回手動トリガー

#### POST /internal/cron/finality-audit
FinalityLog ハッシュチェーン全鎖監査の手動トリガー（通常は EOD バッチに内包）。断絶検知時は CASE へ収束。

Response: `{ "chains_checked": N, "entries_checked": M, "broken_chains": [...], "cases_opened": K }`

#### POST /internal/seed
初期データ投入（開発用）

#### POST /internal/dns/kick
DNS手動キック

Request: `{ "business_date": "YYYY-MM-DD" }`（省略時は当日）

#### POST /internal/dns/settle
DNS手動清算

Request: `{ "cycle_id": "..." }`

#### POST /internal/dns/intraday-cutoff
日中カットオフ（24/365）。現行の OPEN ウィンドウを締め（kick＋settle）、次の日中サイクルを
開く。1日複数回の清算＝ローリング清算を可能にする（`runIntradayDnsCutoff`）。

Request: `{ "business_date": "YYYY-MM-DD", "currency": "JPY" }`（いずれも省略可。既定は当日・`JPY`。サイクルIDは `DNS-{CCY}-YYYYMMDD-NN`）

#### POST /internal/dns/resume
DNS_HOLD（ネット債務者の残高不足による中断）からの再開。ブリッジ流動性の補填後に呼び、`resumeDns` が当座残高を再チェックして清算を再試行する（`10_requirements.md` §3.2.5.2 の制度プロトコル）。

Request: `{ "cycle_id": "..." }`

#### GET /internal/boj-positions
各銀行の日銀預け金勘定（BOJ）残高照会

#### POST /internal/sim/setup
シミュレーター大規模初期化（20行×200口座）

#### POST /internal/sim/setup-bank
シミュレーター単行セットアップ

#### POST /internal/transfers/:txid/resume-credit
着金承認後のクレジット処理再開通知

---

## ダッシュボード・静的ページ

| パス | 内容 |
|---|---|
| `/` `/dashboard` | メインダッシュボード（取引一覧・状態可視化） |
| `/console` | オペレーションコンソール（Alpine.js + ECharts） |
| `/bank-app` | 顧客向け銀行アプリ（Alpine.js） |
| `/theater` `/theatre` | Settlement Theater — 状態遷移のアニメーション再生 |
| `/sky` | Sky モード（システム俯瞰ビュー） |

---

## リクエストトレーシング（横断仕様）

全 HTTP レスポンスは `X-Request-Id` ヘッダーを必ず返す。エラー時は
レスポンス本文の `request_id` フィールドにも同値が入り、構造化ログ
（後述）と突合可能になる。

- リクエスト側が `X-Request-Id` を付与した場合、その値をそのまま採用する。
- 付与が無い場合、サーバが `req-<uuid>` を生成して返す。
- Cloudflare Queues コンシューマでも同等の logger を初期化し、`request_id`,
  `message_type`, `txid`, `gtid`, `attempt` を 1 行 JSON として `console`
  に出力する（Logpush でそのままパース可能）。

実装: `src/shared/logger.ts` を参照。詳細は
[`docs/specs/30_internal_design.md` § Observability](./30_internal_design.md#observability) に集約。

---

## 冪等性（横断仕様）

`idempotency_key` を受け取る全エンドポイント（`/api/transfers`、
`/api/gtid/register`、`/api/rtp/request`、`/api/htlc/*`、
`/api/fx/transfers` など）は、同一キーの再送に対して**保存済みの応答を
そのまま返す**。ただし HTTP ステータスコードは初回と異なる場合がある
（例: HTLC create は初回 `201`、再送では `200`）。

同一キーが**異なるリクエストボディ**で再使用された場合は、保存済み応答
を返さず `409 IDEMPOTENCY_KEY_CONFLICT` を返す。ボディの同一性は
リクエスト全体の SHA-256 ハッシュで判定する（`src/shared/idempotency.ts`
の `resolveIdempotency()`）。これにより、クライアントが同じキーを使い回し
つつ金額や payee だけ変えてしまうといった実装ミスをしても、古い応答が
意図せずそのまま返ってしまったり、二重実行と誤認されたりすることを防げる。

署名のリプレイ防止など、ボディ比較を伴わない単発キー（例:
`sig:{key_id}:{nonce}`）はこの判定の対象外（ハッシュ未保存、常に
非衝突）。

実装: `src/shared/idempotency.ts`。

---

## メッセージ・スキーマ進化と互換性政策（横断仕様）

参加者は N 行いても**同時にはアップグレードしない**。したがって電文・API 契約には
明示的な進化政策が要る。これが無いまま本番へ行くと、**最初のスキーマ改訂が最初の
全網障害**になりかねない。実在の決済レールの電文改訂が「年次サイクル・数年前告知」
という重さで動くのは、この「参加者全員が同時にはアップグレードできない」という
問題への答えである。ZC も同じ規律を採る。

**方針（3点）**

1. **n / n-1 併存受理**: サーバは常に現行スキーマ `n` と直前 `n-1` の 2 世代を同時に
   受理する。リクエストは `schema_version`（`PaymentInitiated` の必須フィールド。永続化列は
   `Transactions.schema_version`、`31_schema.md § Transactions`、既定 `'1.0'`）で自世代を自己申告する。
   新フィールドは**加法的・任意**（省略時は従来動作）として入れ、破壊的変更は世代境界で
   のみ行う。
2. **公表された非推奨期限**: `n-1` を受理し続ける期限を事前に公表する。告知から期限までは
   全参加行が移行できるだけの猶予（実在レール同様、複数年規模）を置く。
3. **強制移行手続**: 期限到来後、`n-1` のリクエストは受理を停止し明示拒否する
   （サイレントに古い解釈へ倒さない）。移行が滞る参加行には期限前に個別告知し、接続
   認定試験で `n` 適合を確認したうえで切替える。

**すでに一度やっている実例（署名方式の段階的二重受理）**

この「段階的二重受理」を ZC は署名方式の移行で一度通している。ZC の egress 署名は
歴史的に共有 HMAC だったが、非対称署名（`KeyRegistry` の公開鍵、`owner_type='ZC'`）へ
移行した。検証側（bank ingress、`src/bank/ingress/`）は**`X-ZC-Key-Id` ヘッダーの有無**
だけで新旧を判別する。ヘッダーが在れば非対称パス（`verifyZcSignature`、
`src/shared/zc_signature.ts`）、無ければ従来の HMAC パスへフォールバックする（§ZC→Bank
Ingress API の共通ヘッダー参照）。送信側は世代をまたいで切り替えられ、受信側は両方を
無停止で受ける。これは上記「n / n-1 併存受理」を署名という一断面で具体化したものに
ほかならない。

電文スキーマ全体にはこの発想をそのまま一般化する:「新方式の存在を示す自己申告
（署名では `X-ZC-Key-Id` の有無、電文では `schema_version`）で世代を判別し、告知した
期限まで両受け、期限で強制移行」。署名で正しく機能しているこのパターンを、契約
バージョニングの既定手続として明文化しておく。

---

## エラーカタログ（横断仕様）

全エンドポイントは失敗時に以下の JSON 形を返す。`reason_code` は機械可読、
`category` は HTTP ステータスとリトライ可否を一元化する。

```json
{
  "error":       "human-readable message",
  "reason_code": "H_LIMIT_EXCEEDED",
  "category":    "CONFLICT",
  "details":     { "txid": "TX-001", "requested": 1000, "available": 500 },
  "request_id":  "req-..."
}
```

### カテゴリと HTTP ステータス対応

`src/shared/errors.ts` の `httpStatusOf()` がただ一つの真。

| Category    | HTTP | Retryable | 用途                                                           |
|-------------|------|-----------|---------------------------------------------------------------|
| VALIDATION  | 400  | ✗         | 入力不正、フォーマット違反、FATF R.16 違反                        |
| AUTH        | 401  | ✗         | API キー欠落・HMAC 不一致・Whitelist 拒否                        |
| NOT_FOUND   | 404  | ✗         | TX/HTLC/GTID/RTP/Account/Proxy/Participant 不在                 |
| CONFLICT    | 409  | ✗         | 状態ガード・楽観ロック衝突・H 上限超過・名義不一致・サーキット開放 |
| RATE_LIMIT  | 429  | ✓ (backoff) | レート制限                                                  |
| INVARIANT   | 500  | ✗         | 不変条件違反（バグ）。FinalityLog 改ざん検出、二重記帳など       |
| INTERNAL    | 500  | ✗         | 未分類例外。実装漏れ                                           |
| DOWNSTREAM  | 502  | ✓         | 銀行 / IGS / 外部呼び出しの一時的失敗                            |
| TIMEOUT     | 504  | ✓         | 銀行 / IGS のタイムアウト                                       |

Queue コンシューマは `Retryable=✓` のみ `msg.retry()` し、それ以外は
`msg.ack()` してケース化する（無限ループ防止）。

> **422 (Unprocessable Entity) について**: 上表の `category → HTTP` 写像は
> `httpStatusOf()`（`DomainError` 経由）の対応であり 422 を含まない。一方、
> 一部のエンドポイントは**業務ルール違反**を `httpStatusOf()` を介さず 422 で
> 直接返す（`FOUR_EYES_REQUIRED` / `EVIDENCE_REQUIRED` / `A_OR_B_CONFIRMED`
> (`POST /api/.../h-unlock-authorize`)、`FOUR_EYES_REQUIRED` / `EVIDENCE_REQUIRED` /
> `B_CONFIRMED` / `WINDOW_EXPIRED` / `NOT_CORRECTABLE`
> (`POST /api/transfers/:txid/misrecord-correct`)、`OVER_REVERSAL`（`POST /api/reversals`）、
> `AMOUNT_BALANCE_MISMATCH`（GTID advance）など）。これらは「構文は妥当だが
> 現在の業務状態では処理不能」を表す意図的な 422 であり、`category` 写像の
> 対象外である点に注意（`category` フィールドには `VALIDATION` を付す）。

> **金額の上限について**: 金額系フィールド（`amount.value` / QR `amount` /
> 銀行テラー `amount` / `initial_deposit` 等）は、各 ingress の入力境界で
> `MAX_AMOUNT_VALUE`（`src/shared/constants.ts`、1兆＝`1_000_000_000_000`）を
> 超えると `INVALID_AMOUNT` で拒否される。これは業務上の上限（`tx_amount_limit`
> / `daily_amount_limit` / `hv_threshold` は別途 Participants 等で管理）では
> なく、FXレート乗算など下流の数値演算が `Number.MAX_SAFE_INTEGER` に近づいて
> 精度劣化することを防ぐための、不正・異常入力に対するセーフティネットである。
> 適用対象：`POST /api/transfers`、`POST /api/htlc/create`、
> `POST /api/gtid/register`（leg単位）、`POST /api/rtp/request`、
> `POST /api/fx/quote`・`POST /api/fx/transfers`、QR `generate`、
> 銀行テラー `cash/deposit`・`cash/withdrawal`・口座開設 `initial_deposit`。

### 主要 reason_code 一覧

| reason_code            | category   | 発生箇所例                                                  |
|------------------------|------------|-------------------------------------------------------------|
| INVALID_REQUEST        | VALIDATION | バリデーション全般                                           |
| MISSING_FIELD          | VALIDATION | 必須フィールド欠落                                           |
| INVALID_AMOUNT         | VALIDATION | 金額が負・非整数・上限超過（`amount.value` は 1兆 (`MAX_AMOUNT_VALUE`、`src/shared/constants.ts`) を超えると拒否される） |
| INVALID_CURRENCY       | VALIDATION | `amount.currency` が非対応（`POST /api/transfers`はJPY固定、`POST /api/gtid/register`は`JPY`/`USD`/`EUR`/`GBP`/`CHF`。上記「GTID register」本文の許可通貨が正） |
| INVALID_LANE           | VALIDATION | 未知の lane 値                                               |
| INVALID_STATE          | VALIDATION | クライアント側からの不正な状態指定                           |
| INVALID_PROXY_TYPE     | VALIDATION | Proxy 解決時                                                 |
| FATF_R16_VIOLATION     | VALIDATION | クロスボーダーの FATF データ不備                             |
| PREIMAGE_MISMATCH      | VALIDATION | HTLC claim 時に hashlock 不一致                              |
| EXPIRED                | VALIDATION | RTP・HTLC・QR の有効期限超過                                 |
| UNAUTHORIZED           | AUTH       | API キー欠落                                                 |
| INVALID_HMAC           | AUTH       | ZC↔Bank HMAC 検証失敗                                       |
| WHITELIST_REJECTED     | AUTH       | HTLC Auth Whitelist で拒否                                   |
| ACCOUNT_FROZEN         | AUTH       | 口座凍結中の操作                                             |
| TX_NOT_FOUND           | NOT_FOUND  | `GET /api/transactions/:txid` などで該当無し                 |
| HTLC_NOT_FOUND         | NOT_FOUND  | HTLC 操作対象不在                                            |
| GTID_NOT_FOUND         | NOT_FOUND  | GTID 操作対象不在                                            |
| RTP_NOT_FOUND          | NOT_FOUND  | RTP 操作対象不在                                             |
| ACCOUNT_NOT_FOUND      | NOT_FOUND  | 口座照会失敗                                                 |
| PROXY_NOT_FOUND        | NOT_FOUND  | Proxy 解決失敗                                               |
| PARTICIPANT_NOT_FOUND  | NOT_FOUND  | 参加行未登録                                                 |
| CONCURRENCY_CONFLICT   | CONFLICT   | 楽観ロック競合（`transitionWithLog` strict モード）          |
| STATE_GUARD            | CONFLICT   | 状態ガードで遷移不可                                         |
| IDEMPOTENCY_REPLAY     | CONFLICT   | 同一 idempotency_key の再送（既存応答返却）                  |
| IDEMPOTENCY_KEY_CONFLICT | CONFLICT | 同一 idempotency_key を異なるリクエストボディで再使用（`409`、既存応答は返さない） |
| ALREADY_PROCESSED      | CONFLICT   | 既処理イベントの再投入                                       |
| H_LIMIT_EXCEEDED       | CONFLICT   | H 予約が h_limit を超過（JPYは`Participants`、非JPYは`ParticipantCurrencyLimits`） |
| RESERVE_FAILED         | CONFLICT   | 銀行側 reserve-funds が NG                                   |
| AUTHORITY_CHECK_NG     | CONFLICT   | 銀行側 authority-check が NG                                 |
| NAME_MISMATCH          | CONFLICT   | 名義不一致                                                   |
| CIRCUIT_OPEN           | CONFLICT   | CircuitBreaker が OPEN                                       |
| BANK_ERROR             | DOWNSTREAM | 銀行 ingress が 5xx                                          |
| BANK_TIMEOUT           | TIMEOUT    | 銀行 ingress が応答遅延                                      |
| IGS_ERROR              | DOWNSTREAM | IGS コールバック失敗                                         |
| ALS_LOOKUP_FAILED      | DOWNSTREAM | ALS（Account Lookup Service）失敗                            |
| RATE_LIMITED           | RATE_LIMIT | レート上限                                                   |
| LEGACY_ADAPTER_REQUEST_IN_FLIGHT | DOWNSTREAM | Legacy adapter: 同一 request_id が別の呼出しで処理中（`src/bank/legacy/adapter.ts`） |
| MANDATE_NOT_FOUND      | NOT_FOUND  | 委任が存在しない（失効操作・スコープ照合）                   |
| DD_MANDATE_NOT_FOUND   | NOT_FOUND  | 継続収納契約が存在しない                                     |
| COLLECTION_NOT_FOUND   | NOT_FOUND  | 収納予告が存在しない                                         |
| CHARGE_REF_ALREADY_COLLECTED | CONFLICT | 当該費目は既に `CONFIRMED_OK`（二重収納の防止）           |
| CHARGE_REF_INVALID     | VALIDATION | `PERIODIC` の構造検証違反、または `PR-DD-PERIOD-AHEAD-MAX` 超過 |
| BUDGET_RATE_EXCEEDED   | CONFLICT   | リセット型の累計枠を超過（時が経てば再び使える）             |
| BUDGET_EXHAUSTED       | CONFLICT   | 消尽型の累計枠を使い切った（契約の総量に達した＝契約範囲外） |
| CAP_EXCEEDS_POLICY     | VALIDATION | 契約が宣言した上限が制度上限（`PR-DD-*`）を超える             |
| SIGNATURE_REQUIRED_FOR_RAISE | AUTH | 上限の引き上げに顧客署名がない（引き下げには不要）           |
| FROZEN_UNFAVOURABLE_CHANGE | CONFLICT | 凍結後の不利益変更（増額・前倒し）。減額・取下げは可         |
| NOTICE_PERIOD_TOO_SHORT | VALIDATION | 予告期間が契約の `notice_days_min` に満たない                |
| LADDER_MAX_EXCEEDED    | VALIDATION | ラダーの段数が上限を超える                                   |
| LADDER_RUNG_CANNOT_BE_REALTIME | VALIDATION | 第 2 段以降を `REALTIME` にはできない                 |
| LATEFEE_EXCEEDS_POLICY | VALIDATION | 遅延損害金が率または絶対額の上限を超える                     |
| REALTIME_NOT_PERMITTED | AUTH       | 即時収納は既定で不許可（開放は制度判断による）               |
| MODE_UNSUPPORTED_BY_PAYER_BANK | CONFLICT | 払出行のプロファイルが要求モードを提供できない          |
| CHAIN_TAMPERED         | INVARIANT  | FinalityLog のハッシュチェーン検証失敗                       |
| LEDGER_IMBALANCE       | INVARIANT  | Bank 仕訳の借方=貸方が崩れた                                 |
| IMPOSSIBLE_TRANSITION  | INVARIANT  | `ALLOWED_TRANSITIONS` 不在の遷移                             |
| OWNERSHIP_VIOLATION    | INVARIANT  | 単一所有者則違反: 行を所有しない当事者が状態遷移を発行（`strict:false`でも降格されず無条件throw、`src/shared/errors.ts` / `30_internal_design.md#single-owner`） |
| KEY_NOT_FOUND          | NOT_FOUND  | `KeyRegistry` に `key_id` が存在しない（外部署名検証）       |
| KEY_REVOKED            | AUTH       | `occurred_at` が鍵の `revoked_at` 以降（外部署名検証）       |
| KEY_EXPIRED            | AUTH       | 鍵が `status!=ACTIVE`、または有効期間外（外部署名検証）      |
| EXTERNAL_SIGNATURE_INVALID | AUTH   | `KeyRegistry` の公開鍵での署名検証失敗                       |
| SIGNATURE_REPLAYED     | CONFLICT   | 同一 (`key_id`,`nonce`) の再使用（外部署名検証）             |
| TIMESTAMP_SKEW         | VALIDATION | `occurred_at` が許容スキューを超過（外部署名検証）           |
| TEMPLATE_NOT_WHITELISTED | AUTH     | `ConditionTemplate` が存在しないか `ACTIVE` でない           |
| ATTESTER_UNAUTHORIZED  | AUTH       | 鍵が `allowed_attester_scope` の範囲外（アテステーション）   |
| ATTESTATION_INVALID    | VALIDATION | `statement_hash` が sha256 hex 形式でない                    |
| ATTESTATION_EXPIRED    | VALIDATION | `occurred_at` から TTL（既定60分）を超過したアテステーションを利用しようとした |
| MANDATE_NOT_FOUND      | NOT_FOUND  | `Mandate`（または委任チェーンの祖先）が存在しない            |
| MANDATE_BREACH         | AUTH       | amount/purpose/lane がチェーン中いずれかのリンクの許可範囲外 |
| MANDATE_EXPIRED        | AUTH       | `now` がいずれかのリンクの `[valid_from, valid_to)` 範囲外    |
| MANDATE_REVOKED        | AUTH       | いずれかのリンクが `revoked_at` 以降（失効は遡及しない）     |
| WATCHER_UNAUTHORIZED   | AUTH       | 署名検証済み鍵の `owner_type` が `EXTERNAL_RAIL`/`ATTESTER` でない |
| ANCHOR_NOT_FOUND       | NOT_FOUND  | `FinalityAnchor` に `anchor_id` が存在しない                 |
| CHAIN_NOT_ANCHORED     | NOT_FOUND  | アンカー時点で当該チェーンが存在しなかった                   |
| COSIGN_ENTRY_NOT_FOUND | NOT_FOUND  | 副署対象チェーンに FinalityLog エントリが無い（GENESIS）     |
| COSIGN_BASIS_NOT_FOUND | NOT_FOUND  | 副署の基準エントリがまだ無い（不可逆点のエントリも、当該チェーンを含むアンカーも存在しない）。tip へフォールバックすると定足数が成立しなくなるため、エラーとして返す |
| COSIGN_PARTICIPANT_MISMATCH | AUTH  | 署名検証済み鍵の owner が `participant_id` と一致しない      |
| COSIGN_NOT_APPLICABLE  | VALIDATION | GLOBAL/未分類チェーン、または当該チェーン（TX/GTID/DNS）の当事者でない参加行への副署 |
| SYSTEM_BCP_READ_ONLY   | DOWNSTREAM | ZCが `BCP_READONLY`（ベンダー障害縮退モード）中で新規の資金移動を受理できない |
| SYSTEM_QUORUM_LOSS_READ_ONLY | DOWNSTREAM | ZCが `QUORUM_LOSS_READONLY`（設計原則10の自動縮退、合意ログ quorum 喪失）中で状態確定を受理できない。回復で自動解除されるため queue は retry で保持 |
| ONCHAIN_TIMELOCK_INVALID | VALIDATION | `cross_chain.onchain_timelock` が `timelock` 以降（ZC側外側タイムロックが先に切れる） |
| ONCHAIN_CHAIN_CLASS_REQUIRED | VALIDATION | `cross_chain` 指定時に `onchain_chain_class` が無い（確定種別が無いと Watcher 定足数の既定が最弱に落ちるため） |
| NOT_CROSS_CHAIN        | VALIDATION | `cross-chain-lock`/`onchain-fulfillment` を `cross_chain_source` が NULL のHTLCに対して呼んだ |
| ONCHAIN_PROOF_MISMATCH | VALIDATION | `onchain-fulfillment` の `preimage` が `hashlock` に一致しない |
| ONCHAIN_TIMEOUT        | VALIDATION | クロスチェーンHTLCの `onchain_timelock` 超過（`DECIDED_CANCEL`へ遷移） |
| CONDITION_TEMPLATE_NOT_SET | VALIDATION | `claim-by-attestation` 対象のHTLCに `condition_template_id` が設定されていない（プログラマビリティ） |
| TEMPLATE_MISMATCH      | VALIDATION | `claim-by-attestation` の `template_id` がHTLCの `condition_template_id` と一致しない（プログラマビリティ） |
| ATTESTATION_NOT_PASS   | VALIDATION | アテステーションの `verified_result` が `PASS` でない（`HtlcClaimRejected`を記録） |
| COUNTERPARTY_WINDOW_CLOSED | CONFLICT | EXPRESS精査時に相手行（payee）の稼働ウィンドウが閉じている。`PRECHECKED_SUSPENDED`へ一時停止し、ウィンドウ再開後にタイムアウトスイープが自動再開する（稼働ウィンドウ） |
| ELIGIBILITY_NOT_ATTESTED | AUTH | `createAuthRequest()`：ホワイトリストに `eligibility_template_id` が設定されているが、`eligibility_attestation` が未提供／`verified_result!=='PASS'`／検証失敗（受取側起点オーソリ） |
| PURPOSE_VIOLATION      | AUTH       | `captureHtlcAuth()`：`HtlcAuthRequests.purpose` がホワイトリストの `allowed_purposes` に含まれない（受取側起点オーソリ） |
| PROOF_SOURCE_UNTRUSTED | AUTH       | `assertTrustedSettlementProof()`：`venue!=='BANK_LEDGER'` の `SettlementProofRef` に `signer_key_id`/`verified_at` が無い＝署名検証済みでない（決済証跡の信頼アンカー） |
| CONDITION_EXPR_INVALID | VALIDATION | `condition_expr_json` の式木が構造検証に失敗（`POST /api/htlc/create`・`claim-by-conditions`・`POST /api/conditions/*`） |
| CONDITION_EXPR_NOT_SET | VALIDATION | `claim-by-conditions` 対象の HTLC に `condition_expr_json` が設定されていない |
| CONDITIONS_NOT_MET     | VALIDATION | 条件式が不成立（状態は `HTLC_LOCKED` のまま。`HtlcConditionsEvaluated` を証跡化） |
| ATTESTATION_EQUIVOCATION | CONFLICT | 同一 `(template, subject)` に PASS/FAIL が混在（fail-closed。CASE へ収束） |
| WATCHER_EQUIVOCATION   | CONFLICT   | 同一 `(source, external_ref)` に矛盾する Watcher 観測（`WatcherEquivocationDetected` を証跡化し CASE へ収束。`20_method_design.md` §7.7.2-4） |
| ONCHAIN_QUORUM_PENDING | VALIDATION | Watcher 定足数（`onchain_min_watchers`）未達。`HTLC_ONCHAIN_PENDING` に留まり `OnchainQuorumPending` を証跡化（`20_method_design.md` §7.7.2-2） |
| ONCHAIN_INSUFFICIENT_CONFIRMATIONS | VALIDATION | 確認深度ゲート未通過。深度は定足数を構成する相異なる運用主体の申告の**最小値**を採る（`20_method_design.md` §7.7.2-3） |
| INVARIANT_VIOLATION    | INVARIANT  | 状態機械・所有権・ゼロサム等の不変条件違反（バグ）。`IMPOSSIBLE_TRANSITION` / `OWNERSHIP_VIOLATION` の上位分類 |
| ZC_SIGNING_NOT_CONFIGURED | INTERNAL | ZC egress 署名鍵が未設定（`src/shared/zc_signature.ts`） |
| ZC_SIGNATURE_WRONG_OWNER | AUTH     | ZC egress 署名の検証鍵の `owner_type` が `ZC` でない |
| FX_NO_ROUTE            | CONFLICT   | 指定通貨ペアに ACTIVE な見積経路が無い（`POST /api/fx/quote`・`/api/fx/transfers`） |
| FX_QUOTE_EXPIRED       | CONFLICT   | 経路上の見積が失効（`valid_to` 超過・`WITHDRAWN`） |
| FX_ALREADY_REFUNDED    | CONFLICT   | 払戻済みの FX 送金への claim（`POST /api/fx/transfers/:gtid/claim`）。かつて `FX_QUOTE_EXPIRED` を流用していたが、「見積が切れた」と「もう払い戻した」は呼び出し側の次の行動が異なるため分離した |
| FX_CLAIM_WINDOW_EXPIRED | CONFLICT  | claim 時点で最上流 timelock までの残余が 1 ホップ分（`FX_HTLC_HOP_MARGIN_MS`）を切っており、決済を開始しても間に合わない。ゲートを取らずに払戻側へ倒す（`POST /api/fx/transfers/:gtid/claim`） |
| FX_RATE_MISMATCH       | VALIDATION | 再プライシング後の `effective_rate` が `min_effective_rate` より不利（`POST /api/fx/transfers`） |
| INVALID_FX_RATE        | VALIDATION | `PUT /api/fx/rates` のレート値・通貨・有効期限が不正 |
| FX_FXP_ACCOUNT_MISSING | VALIDATION | `fxp_accounts` に経路上の全 FXP×全通貨のキーが揃っていない |
| FX_ROUTE_INCONSISTENT  | VALIDATION | **予約コード**（経路の連結性違反）。`buildFxEdges` が構築時に連結を保証するため現在どこからも投げられない（`20_method_design.md` §17.5-3） |
| FX_LIQUIDITY_INSUFFICIENT | CONFLICT | **予約コード**（FXP の流動性不足）。GTID レーンの H 予約失敗パスが汎用的に検出するため現在どこからも投げられない（`20_method_design.md` §17.5） |

#### `DomainError` を経由しない reason_code（直接 HTTP 返却）

上表は `REASON_CODE_CATEGORY`（`src/shared/errors.ts`）に登録され、`categoryOf()` →
`httpStatusOf()` の写像を持つコードである。これとは別に、**入力境界で `jsonError(status, code, …)`
により直接 HTTP を返すコード**が存在する。両者を混同しないため、代表的なものを以下に挙げる。

| reason_code | HTTP | 発生箇所 |
|---|---|---|
| USE_HTLC_ENDPOINT | 422 | `POST /api/transfers` に `lane=HTLC`（§ POST /api/transfers。副作用の前に拒否） |
| DAILY_LIMIT_EXCEEDED | 422 | `Participants.daily_amount_limit` 超過（アトミック UPDATE の `meta.changes=0`） |
| AMOUNT_EXCEEDS_TX_LIMIT | 422 | `Participants.tx_amount_limit` 超過 |
| PARTICIPATION_MODE_RECEIVE_ONLY | 422 | `RECEIVE_ONLY` 参加行が送金を起票 |
| AMOUNT_BALANCE_MISMATCH | 422 | GTID の通貨別金額均衡違反（`advanceGtid`。`10_requirements.md` §3.2.4-7） |
| MISSING_LEG_ROLE | 422 | GTID に PAYER / PAYEE いずれかの leg が存在しない（同上） |
| OVER_REVERSAL | 422 | Reversal 累計が元 TX 金額を超過（`POST /api/reversals`） |
| APPROVAL_REF_REQUIRED | 422 | 事前承認必須 `reason` に `approval_ref` が無い（`10_requirements.md` §4.3.1） |
| INVALID_MANDATE_ID | 400 | `mandate_id` が `MANDATE-` で始まらない |
| PURPOSE_CODE_REQUIRED | 403 | 照会に `X-Purpose-Code` が無い（§照会の認可） |
| REQUESTER_UNIDENTIFIED | 403 | 照会の主体が識別できない（同上） |
| PARTICIPANT_SIGNATURE_REQUIRED | 403 | 鍵登録済みの参加行が署名なしで照会した（同上） |
| PARTICIPANT_SIGNATURE_INVALID | 403 | 署名不正／他行の鍵／リプレイ（同上） |
| CROSS_PARTICIPANT_SCOPE | 403 | 参加者が一覧・フィード系を照会した（同上） |
| FATF_DATA_REQUIRED / FATF_VALIDATION_FAILED | 400 | クロスボーダーの FATF R.16 データ不備 |

> **規範（category の決まり方）**：`jsonError()` は、まず `categoryOf(reason_code)` を引く。
> **登録済みならその category を用いる。未登録の場合に限り、HTTP ステータスから category を
> 導出する**（400/422→`VALIDATION`、401/403→`AUTH`、404→`NOT_FOUND`、409→`CONFLICT`、
> 429→`RATE_LIMIT`、502→`DOWNSTREAM`、504→`TIMEOUT`）。したがって直接 HTTP 返却のコードは
> 未登録でも安全に分類される。
>
> **ただし `DomainError` は例外である**：`throw new DomainError(code, …)` の `code` が未登録だと
> HTTP ステータスの手がかりが無く、`categoryOf()` は `INTERNAL`（500・retry 不可）へ落ちる。
> **`DomainError` に渡す `reason_code` は必ず `REASON_CODE_CATEGORY` へ登録すること。**
> この不変条件は `test/invariants/spec_refs.test.ts` が機械検査する。

**規範（追加時の手順）**：新規 `reason_code` を追加する場合は `src/shared/errors.ts` の
`REASON_CODE_CATEGORY` と本表を**同じ変更で**更新する。両者の一致は
`test/invariants/spec_refs.test.ts` が突合し、片方だけの更新は CI で落ちる。

---

## 照会の認可（横断仕様） <a id="query-authorization"></a>

要件 **S-5**（アクセスは目的コードなしに成立しない）と **S-7**（参加行間の越境参照が構造的に
不可能）は、**ひとつの機構**として実装する（`10_requirements.md` §8.5、実装
`src/zc/platform/access.ts`、対象経路表 `src/zc/platform/access_routes.ts`）。両者は同じ 2 つの
事実——**誰が訊いているか**と**何を見てよいか**——を必要とするため、分けると主体解決が 2 つ生まれて
やがて食い違う。

### リクエストヘッダ

```
X-Purpose-Code: P01|P02|P03|P04|P05|P06|P07   # 必須（`10_requirements.md` §3.3.2.2.1）
X-Bank-Id:      001                            # 参加者スコープ
X-Cron-Secret:  <CRON_SECRET>                  # 運営スコープ（両方あれば運営が優先）

# 参加者の主体認証（当該行に ACTIVE な PARTICIPANT 鍵があるときは必須）
X-Participant-Key-Id:    KEY-001                # KeyRegistry（owner_type='PARTICIPANT'）
X-Participant-Sig-Nonce: string                 # 鍵ごとに一意（リプレイ防止）
X-Participant-Sig-Time:  RFC3339                # 署名時刻（スキュー検査）
X-Participant-Signature: base64                 # 下記ペイロードへの署名
```

### 参加者の主体認証（規範）

**`X-Bank-Id` 単独は主張であって身元ではない。** 誰でも他行の ID を書けるため、これだけでは
当事者判定（S-7）が飾りになる。参加者は `KeyRegistry`（`owner_type='PARTICIPANT'`）の鍵で
**リクエストに署名**して主体を証明する——ZC egress 署名（`shared/zc_signature.ts`）の鏡像である。

**署名対象**は次の 4 項目（`buildSignedMessage` の payload。`30_internal_design.md` §12.6 と同じ正規化）。

```json
{ "method": "GET", "path": "<資源識別子>", "bank_id": "001", "purpose_code": "P01" }
```

`path` と `purpose_code` を署名に含めるのは、**ある照会で得た署名を別の照会へ付け替えられない**
ようにするためである。含めなければ、一度許可された署名が nonce の有効な間だけ「何でも読める券」に
なる。

**強制は鍵の登録状態で決まる（規範）**：当該参加行に **ACTIVE な PARTICIPANT 鍵が 1 本でもあれば、
署名は必須**（欠落は `403 PARTICIPANT_SIGNATURE_REQUIRED`）。鍵が無い参加行は従来どおり
`X-Bank-Id` の申告で読めるが、**アクセス監査台帳には未認証として記録される**
（`subject_id` に `(unauthenticated)` を付す）。

> **なぜ「ヘッダの有無」で切り替えないか**：ZC egress の署名移行は `X-ZC-Key-Id` の有無で新旧を
> 両受けしている（§メッセージ・スキーマ進化）。あれは**送信側**の移行であり、世代を選ぶのは
> 送信者自身なので正しい。**受信側の真正性検査を呼び出し側の任意で切れるようにしたら、
> 検査していないのと同じ**である。したがってここでは切替の権限を**レジストリ側**に置き、
> 鍵を登録した参加行から順に強制が有効になる形にした（参加行ごとの段階移行であり、
> 一斉切替の日を作らない）。

**鍵の所有者検査**：署名が通っても、その鍵が `owner_type='PARTICIPANT'` かつ
`owner_ref == X-Bank-Id` でなければ拒否する（`403 PARTICIPANT_SIGNATURE_INVALID`）。
これが無いと、登録済みのアテスターや Watcher の鍵で任意の参加行になりすませる。

鍵の登録・失効は制度行為であり、4 眼承認の統制に従う（`10_requirements.md` §3.3.4）。

### 判定と応答

| 状況 | 応答 | なぜその番号か |
|---|---|---|
| 目的コードが無い／未知の値 | **403** `PURPOSE_CODE_REQUIRED` | **参照する前**に拒否するため、応答は対象の存在を漏らさない |
| 主体が識別できない | **403** `REQUESTER_UNIDENTIFIED` | 同上 |
| 鍵登録済みの参加行が署名を付けない | **403** `PARTICIPANT_SIGNATURE_REQUIRED` | 主張した行であることを証明していない＝その行ではない |
| 署名が不正／他行の鍵／リプレイ | **403** `PARTICIPANT_SIGNATURE_INVALID` | 同上。**`DataAccessViolationDetected` を記録する**——登録鍵に対する不正署名はなりすましの形そのもの |
| 参加者が当事者でない | **404** `NOT_FOUND`（存在しない場合と**同一本文**） | `403` は「在るがあなたのものではない」と答えてしまう。それは S-7 が禁じた越境の事実そのもの（`20_method_design.md` §9.4.4 (B)-1 と同じ論理） |
| 参加者が一覧・フィードを要求 | **403** `CROSS_PARTICIPANT_SCOPE` | `10_requirements.md` §3.3.2.2.3 が参加者の照会を「取引ID/CASE ID/当事者キー」に限定している。黙って絞り込むのではなく拒否する——絞り込みの実装漏れは静かに漏れる |
| 運営スコープ | 許可（横断可） | 監督・運用の職務。すべて監査台帳に残る |

**当事者の定義**：取引＝payer/payee 行、GTID＝全レッグの行、HTLC＝payer/payee 行、
受取側起点オーソリ＝payer/payee 行、CASE＝紐づく取引・GTID の当事者、Reversal＝元取引の当事者、
Circuit Breaker（個別）＝当該行自身。取引の派生ビュー（`/events`・`/explain`・`/story`・
`/verify`・`/reversals`）は元取引と同じ判定に従う。

**公開のまま残す照会**：`GET /api/dns/:business_date/status`（全参加主体向けの公式ステータス）、
`/api/banks`、OpenAPI 仕様書等。**公開である理由を経路表に明記**しており、理由の無い除外は
`test/invariants/query_access.test.ts` が落とす。同テストは、**新しい `GET /api/…` が経路表にも
公開一覧にも無い**場合にも落ちる——認可漏れは「書き忘れ」で起きるため、書き忘れ自体を検出する。

**閉域照会は別規範**：`GET /api/dns/:business_date/hold_detail` は拒否を**一律 404** に統一する
（HOLD の有無自体が閉域情報であるため）。上表の 403／404 の使い分けは適用しない。

**監査台帳**：許可・拒否のいずれも `AccessAuditLog` に記録する（`31_schema.md § AccessAuditLog`）。
台帳の書込み失敗で照会を失敗させてはならない（可用性要件 A-2 との衝突を避ける）。

> **未充足**：**鍵を登録していない参加行は申告のみで読める**（移行のための意図的な経路）。
> 系として「参加行が他行を騙れない」と言えるのは全参加行が鍵を登録し終えた時点であり、
> それは制度側の移行工程（登録の督促と期限）に属する。機構・強制・監査は揃っている——
> 残っているのは**運用（全行の鍵登録）**であって設計ではない
> （`30_internal_design.md` 第10章 Roadmap）。

---

## 状態 reason_code（横断仕様） <a id="state-reason-code"></a>

`reason_code` という語は本書群で **3 つの異なる値空間**を指す（`10_requirements.md` 序章
[§ `reason_code` の 3 つの値空間](10_requirements.md#reason-code-spaces)）。上の
§ エラーカタログ が定めるのは **エラー `reason_code`**——要求が拒否された理由——だけである。
本節は残る 2 つ、すなわち **状態 `reason_code`**（`Transactions.reason_code` 列）と
**CASE `reason_code`**（`Cases.reason_code` 列）を扱う。

### 位置づけ

- **説明するもの**：受理された取引が **いま その状態にある理由**。「なぜ止まっているのか」「なぜ取り消されたのか」。
- **載る場所**：`GET /api/transactions/:txid` の `reason_code`、FinalityLog の payload、`Cases.reason_code`。
- **HTTP ステータスを持たない。** したがって `REASON_CODE_CATEGORY` への登録は要求しない
  （登録済みの値と綴りが一致することはあるが、それは共用であって規約ではない）。
- **窓口の説明はこの空間に紐づける**（`20_method_design.md` §10.4.1.1）。

### 主要な値（レーン・局面別）

| reason_code | 付く局面 | 遷移 |
|---|---|---|
| `SUSPEND_NAMECHECK_PENDING` | 名義確認の応答待ち | `PRECHECKED → PRECHECKED_SUSPENDED` |
| `SUSPEND_AUTHORITY_PENDING` | AML/制裁照会（Authority Check）の応答待ち。判定不能の時点で `PRECHECKED` のまま先置きし、T_auth 超過で遷移する（`20_method_design.md` §3.3.1） | `PRECHECKED → PRECHECKED_SUSPENDED` |
| `SUSPEND_EXEC_TIMEOUT` | Decision 後、a が期限内に成立しない | `DECIDED_TO_SETTLE → SUSPENDED` |
| `SUSPEND_PAYEE_PROOF_TIMEOUT` | a 成立後、b が期限内に成立しない | `PAYER_EXEC_CONFIRMED → SUSPENDED` |
| `FAILED_EXEC_TIMEOUT` | `SUSPENDED` の滞留が上限を超えた | `SUSPENDED → FAILED_EXECUTION` |
| `IGS_FAILED` | 中銀決済が HOLD または不成立で返った（**両者を区別しない**。下記の注意） | `PAYER_EXEC_CONFIRMED → SUSPENDED` |
| `BOJ_INSUFFICIENT_FUNDS` | HIGH_VALUE 受付時に中銀当座残高が不足 | `PRECHECKED → DECIDED_CANCEL` |
| `DNS_HOLD_IGS_STOPPED` | DNS_HOLD 中で `igs_mode=STOP`（全件停止） | `PRECHECKED → PRECHECKED_SUSPENDED` |
| `DNS_RINGFENCED` | `igs_mode=RINGFENCED` で原因行として隔離 | 同上 |
| `DNS_IGS_THROTTLED` | `igs_mode=RINGFENCED_PLUS` で公平性予算を超過（Defer） | 同上 |
| `INSUFFICIENT_FUNDS` | 参加行側の残高不足 | `PRECHECKED → DECIDED_CANCEL` |
| `CANCEL_BY_PAYER` | 支払人による取消 | `→ DECIDED_CANCEL` |
| `TIMELOCK_EXPIRED` | HTLC の timelock 到来 | `HTLC_LOCKED → DECIDED_CANCEL` |
| `RECHECK_AUTHORITY_NG` | claim 直前の AML 再照会が NG | `HTLC_LOCKED → DECIDED_CANCEL` |
| `RECHECK_AUTHORITY_UNAVAILABLE` | claim 直前の AML 再照会に**答えが返らない**（回路 OPEN 等）。claim を拒否するが取消はせず、再試行に委ねる（`30_internal_design.md` §15.4） | 遷移なし（証跡のみ） |
| `INVALID_PREIMAGE` | preimage 不一致（状態は維持し、証跡のみ残す） | 遷移なし |
| `MISRECORD_CORRECTED` | 誤記録訂正（`10_requirements.md` §4.4） | 追記のみ |
| `SUSPEND_ADAPTER_DOWN` | 参加行 Adapter へ到達できない（Circuit Breaker が `OPEN`）。**「相手が拒否した」`EXEC_*_FAILED` とは別値**——CASE 集約（`20_method_design.md` §10.9.3.6）がこの区別に依存する | `→ SUSPENDED` |
| `EXEC_DEBIT_FAILED` / `EXEC_CREDIT_FAILED` | 参加行に届いたうえで実行が失敗した | `→ SUSPENDED` |
| `CREDIT_FAILED_PROOF_REQUIRED` | Reversal 起票に物理的不能の証明が無く CASE へ収束（`10_requirements.md` §4.3.0） | CASE 起票 |

> **注意（`IGS_FAILED` は HOLD と不成立を区別しない）**：中銀決済が `HOLD`（一時的な流動性
> 不足。再試行で解消しうる）で返った場合も、`FAILED`（不成立）で返った場合も、取引に付く
> 状態 `reason_code` は **同一の `IGS_FAILED`** である。両者を分けるのは `IgsRequests.status`
> であって取引側の `reason_code` ではない。したがって **窓口が「待てば済むのか、済まないのか」を
> `reason_code` だけで判断してはならない**——判断材料は照会応答の **`external_settlement`**
> （`{status, retriable}`）である（`20_method_design.md` §9.4.4.1 (A)）。

### 命名規約（規範）

状態 `reason_code` は 2 つの family に分かれる。**どちらの family かで綴りを決める**。

| family | いつ使うか | 綴り | 例 |
|---|---|---|---|
| **待機理由** | **何かを待っている**——時間経過または相手の応答で解ける。窓口の答えは「待てば進む」 | `SUSPEND_*`。**待ちが解けずに終わった**ときは `CANCEL_*_TIMEOUT`（＝解けなかった待ちの帰結を接頭辞にする） | `SUSPEND_NAMECHECK_PENDING`・`SUSPEND_EXEC_TIMEOUT`・`SUSPEND_ADAPTER_DOWN`・`CANCEL_PRECHECK_TIMEOUT` |
| **事象理由** | **確定した事実が起きた**——待っても変わらない。窓口の答えは「この理由で止まった／終わった」 | 事象そのものの名前（接頭辞を付けない） | `IGS_FAILED`・`BOJ_INSUFFICIENT_FUNDS`・`DNS_RINGFENCED`・`TIMELOCK_EXPIRED` |

**規範**

1. **遷移先を名前に含めない（事象理由）／含める（待機理由）**という上表の使い分けを守る。
   遷移先そのものは `state` 列が既に持っているので、事象理由にまで接頭辞を付けると重複になり、
   `CANCELLED` の行に `SUSPEND_*` が載るような**矛盾する組み合わせ**を作れてしまう。
   - **`CANCEL_` で始まる値がすべて待機理由なのではない。** 待機理由に属するのは
     **解けなかった待ちの帰結**、すなわち `CANCEL_*_TIMEOUT` の形だけである
     （`CANCEL_PRECHECK_TIMEOUT`）。一方 `CANCEL_BY_PAYER` は**支払人が取り消したという確定した
     事実**であり、待ちではない——待機理由の綴りを共有しているが**事象理由**に属する。
     接頭辞ではなく「待っていたのか、起きたのか」で family を決める、が上表の趣旨である。
2. **エラー `reason_code` を状態 `reason_code` として転用しない。** 両空間は別物である
   （`10_requirements.md` 序章）。転用すると、窓口が見る値に「API 呼び出しが失敗した理由」が
   混入する。かつて Adapter 不通が `CIRCUIT_OPEN`（エラー空間の値）で表現されず
   `EXEC_DEBIT_FAILED` に潰れていたのは、この線引きが無かったためである
   （現在は待機理由 `SUSPEND_ADAPTER_DOWN` を用いる）。
3. **「相手が拒否した」と「相手に届かなかった」を同じ値にしない。** 前者は事象理由、
   後者は待機理由であり、顧客への説明も運用の打ち手も異なる。

### 規範

1. **本表は網羅ではない。** 状態 `reason_code` は局面ごとに追加され得るため、本表は**窓口・運用が
   分岐に使う主要値**を固定する。網羅的な現行値は実装（`Transactions.reason_code` に書き込む
   全箇所）を正とする。
2. **本書群が規範として名指しする状態 `reason_code` は、実在する値でなければならない。**
   規範として先に固定したが未実装の値は、`【未実装】` を付して明示する（`30_internal_design.md` §10.0）。
   この不変条件は `test/invariants/spec_refs.test.ts` が機械検査する。
3. **遷移の条件を状態 `reason_code` で書かない。** `reason_code` は人間向けの説明ラベルであり、
   状態機械のガードではない。遷移を縛るのは状態そのもの（`ALLOWED_TRANSITIONS`）と、
   `external_settlement_status` のような**専用の判定列**である（`20_method_design.md` §3.2.1）。
