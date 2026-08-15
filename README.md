# Zenith Coordinator / ZC

銀行間決済を、追跡可能な状態遷移の記録として扱う協調層（**Zenith Coordinator / ZC**）の参照実装です。

---

## 日本語

### この文書について

このリポジトリは、**Zenith Coordinator（ZC）** という構想の参照実装です。「決済を説明可能な状態機械として扱う」という設計思想のもと、TypeScript と Cloudflare Workers 上で end-to-end に動作します。**機密資料は一切用いていない** 個人プロジェクトであり、現実のいずれの組織・システム・運用も示していません。

→ 構想の全体像：[Zenith 構想・基本コンセプト](https://www.sakuolia.jp/zenith.html)

### なぜ作ったのか

日本の決済システムは、世界水準で見ても堅牢で、長く安定して動いてきました。一方で、利用者の側から眺めたときの **「いま、自分のお金がどこにあるのか」「なぜ遅れているのか」「誰に聞けば分かるのか」** という説明可能性には、まだ伸びしろがあるように感じています。

Zenith は既存のレールを置き換えるものではありません。各金融機関の勘定系と口座管理はこれまで通りに置いたまま、**その「間」で起きていることを、後からでも同じ取引番号で関係者の誰にでも同じように説明できる**ようにする協調層を設計する試みです。読み物だけでなく、**手で触れて動かせる形**にしてあります。

### 30 秒で伝わる例（電気代の口座振替で残高不足）

| | いまの体験 | Zenith があると |
| --- | --- | --- |
| 失敗に気づくまで | ハガキが届くまで（数日） | 数秒で利用者・事業者の双方に同じ通知 |
| 失敗 → 成立まで | 数日～半月 | 数時間 |
| 問い合わせ | 各自が状況を別々に再構成 | 全員が同じ取引番号・同じ時刻・同じ理由コードを見る |

詳細は [`docs/specs/11_walkthrough.md`](docs/specs/11_walkthrough.md)。

### このシステムは何をするか・何をしないか

- **すること**：複数の銀行間の決済を、**受理 → Decision（決定）→ Execution（実施確認）→ b（確定）** という状態の連なりに固定し、すべての状態遷移を追記専用の FinalityLog に記録する。利用者・事業者・当局のいずれにも、同じ取引番号で同じ説明を返す。
- **しないこと**：参加者の勘定系・口座管理を置き換えない。本人確認・与信・限度管理は各参加主体の裁量。法的判断は行わない。

### 設計の前提（要点）

1. 唯一の正は **Finality Log**。派生ビューは捨てて再構築できる。（※「唯一の正」の射程は **協調事実**——決定・所有権移転・受領した署名付き証明——であり、**金銭事実の正は各参加行の元帳**にある。ZC の主張は「乖離しない（原子性）」ではなく「すべての乖離は有界時間内に検出・帰責される（監査可能性）」——[`docs/specs/30_internal_design.md` §5 単一所有者則](docs/specs/30_internal_design.md#single-owner) と [`docs/specs/20_method_design.md`](docs/specs/20_method_design.md) §6.1 の精密化を参照。）
2. **Decision と Execution は必ず分離** する。
3. 不可逆境界は原則 **b（PAYEE_EXEC_CONFIRMED）**。b 後の救済は Reversal（別取引）として扱う。
4. **説明できない状態は禁止**。未決・不整合は必ず CASE へ収束させる。
5. 同期応答の意味は契約で固定する。
6. 証跡は後付けしない。
7. レーンは UX 区分ではなく、**確定点と証跡の契約**。
8. **H（仕向超過限度）は状態として管理** し、絶対超過を許さない。
9. 危機対応は例外ではなく **制度化された状態遷移** として扱う。
10. 単一正本性は分散合意ログで担保し、不確定時は Read-only へ縮退する。

詳細は [`docs/specs/20_method_design.md`](docs/specs/20_method_design.md)。

### 同じ語彙で TradFi と DeFi を語る

Zenith は、伝統的決済レール（RTGS、DNS ネッティング、全銀系リテール、ISO 20022、FATF R.16）と新しい原始要素（ハッシュタイムロック、原子マルチレグ）を、**橋渡し（bridge）ではなく、同じ状態機械のうえに並ぶ対等なレーン** として扱います。

| レーン | 出自 | ファイナリティ原始要素 |
| --- | --- | --- |
| EXPRESS / STANDARD / BULK | 伝統系（リテール、全銀系） | H 予約 + ネッティング |
| HIGH_VALUE | 伝統系（中央銀行 RTGS） | 即時グロス決済 |
| DNS サイクル | 伝統系（清算機関） | 日次ネットポジション |
| HTLC / HTLC_AUTH | DeFi ネイティブ | ハッシュロック + タイムロック |
| GTID | ハイブリッド（原子マルチレグ） | レッグ横断 all-or-nothing |
| RTP | ハイブリッド（受取人発起プル） | 名義確認 + 事前承認 |

Zenith が重点を置くのは、次の三点です。

- **HTLC・GTID 原子マルチレグ・RTGS・DNS ネッティングを、橋渡しではなく、ひとつの状態機械の対等なレーンとして並べる。**
- **状態遷移と FinalityLog 書込みのアトミック強制、および単一 trace ID による生涯トレース。**
- **DNS_HOLD 時の流動性供給カスケードを、コードと同じ温度の規程文書として書く点**（[`docs/specs/10_requirements.md`](docs/specs/10_requirements.md)）。

実装は [`src/zc/orchestrator/state_machine.ts`](src/zc/orchestrator/state_machine.ts) と [`src/zc/lanes/`](src/zc/lanes/) を参照。

### 「制度」として書かれている部分

コードや方式設計と並んで、**制度（規程・ガバナンス）の文書**も用意しています。4 眼承認・ブレークグラス、利用目的コード（P01〜P07）と最小化原則、DNS_HOLD 時の初動連絡・公表統制、資金源の発動順序（**破綻者の担保 → 破綻者の自助 → 運営者の自己資金 → LPB → 共同拠出 → 中央銀行**という defaulter-pays 先頭のウォーターフォール。中央銀行の資金供給は「保証された遷移」ではなく**要請経路**である）、WORM 保全と第三者保証──これらを [`docs/specs/10_requirements.md`](docs/specs/10_requirements.md) に集約しています。技術仕様だけでは決済は社会に着地しないため、制度面まで同じ粒度で記述しました。

### 触れてみる

必要なもの：Node.js 18+ / npm 8+ / Cloudflare アカウント（無料枠で動作）。

```bash
# ローカル
git clone https://github.com/pochatt/zenith-coordinator.git
cd zenith-coordinator
npm install
cp .dev.vars.example .dev.vars   # ローカル用の秘密情報を埋める（.gitignore 済み）
npm run db:migrate:local
npm run dev          # http://localhost:8787（ルートがダッシュボード）
# ダッシュボード/バンクアプリから鍵なしで送金・HTLC 等の取引（/api/* の POST 含む）を
# 行うには、wrangler.toml の [vars] に ZC_ALLOW_UNAUTHENTICATED_UI = "true" を入れる。
# これが「UI から鍵なしで取引する」ための公式かつ唯一の経路。既定 off・同一オリジン限定・
# 1 リクエストごとにログ（http.unauthenticated_ui_access）。本番では設定しないこと。

# Cloudflare へデプロイ
npx wrangler login
npx wrangler d1 create zenith-db
npx wrangler queues create zenith-coordinator-queue
npx wrangler r2 bucket create zenith-coordinator-r2
npx wrangler r2 bucket create zenith-coordinator-richdata
npx wrangler kv namespace create ALS_KV
cp wrangler.toml.example wrangler.toml   # database_id 等を埋める
# 秘密情報（ZC_HMAC_SECRET 等）は wrangler.toml に書かない。
# wrangler secret put ZC_HMAC_SECRET などで個別に登録する
# （一覧は wrangler.toml.example 冒頭のコメントを参照）。
npm run db:migrate:remote
npm run deploy
curl -X POST https://<your-worker>.workers.dev/internal/seed
```

```bash
npm run dev               # ローカル開発サーバー
npm run deploy            # Cloudflare へデプロイ
npm run type-check        # TypeScript 型チェック
npm run test              # テストスイート
npm run format            # Biome フォーマット適用（CI で format:check が強制）
npm run db:migrate:local  # ローカル D1 にマイグレーション
npm run db:migrate:remote # リモート D1 にマイグレーション
```

### 状態機械（中核）

```typescript
// src/zc/orchestrator/state_machine.ts
const ALLOWED_TRANSITIONS = {
  RECEIVED:               ['PRECHECKED', 'HTLC_LOCKED', 'DECIDED_CANCEL'],
  PRECHECKED:             ['PRECHECKED_SUSPENDED', 'H_RESERVED', 'DECIDED_CANCEL', 'DECIDED_TO_SETTLE'],
  PRECHECKED_SUSPENDED:   ['PRECHECKED', 'DECIDED_CANCEL'],
  H_RESERVED:             ['DECIDED_TO_SETTLE', 'DECIDED_CANCEL'],
  DECIDED_TO_SETTLE:      ['PAYER_EXEC_CONFIRMED', 'PAYEE_EXEC_CONFIRMED', 'SUSPENDED'],
  DECIDED_CANCEL:         ['CANCELLED'],
  PAYER_EXEC_CONFIRMED:   ['PAYEE_EXEC_CONFIRMED', 'SUSPENDED'],
  PAYEE_EXEC_CONFIRMED:   ['SETTLED'],
  SUSPENDED:              ['PAYER_EXEC_CONFIRMED', 'PAYEE_EXEC_CONFIRMED', 'FAILED_EXECUTION'],
  HTLC_LOCKED:            ['HTLC_FULFILL_REQUESTED', 'HTLC_ONCHAIN_PENDING', 'DECIDED_CANCEL'],
  HTLC_ONCHAIN_PENDING:   ['HTLC_FULFILL_REQUESTED', 'DECIDED_CANCEL'], // クロスチェーン: Watcher がオンチェーン escrow lock を観測
  HTLC_FULFILL_REQUESTED: ['DECIDED_TO_SETTLE', 'FAILED_EXECUTION'],
  // 終端: SETTLED, FAILED_EXECUTION, CANCELLED
}
```

`SETTLED`（確定）への入辺は `PAYEE_EXEC_CONFIRMED → SETTLED` ただ一つであり、**b（PAYEE_EXEC_CONFIRMED）を経ずに確定する経路は構造的に存在しません**。クロスチェーン HTLC は `HTLC_LOCKED → HTLC_ONCHAIN_PENDING → HTLC_FULFILL_REQUESTED` を経由し、ZC 自身はチェーンを観測せず、Watcher の署名付き観測（`SettlementProofRef`）を KeyRegistry で検証して受理します（トラストモデルの限界は「実装の現状と限界」を参照）。

すべての状態遷移は `transitionWithLog` ヘルパを通り、`ALLOWED_TRANSITIONS` の検査は**無条件**（バイパス不可）で、`Transactions` への CAS UPDATE と `FinalityLog` への INSERT を 1 つの D1 バッチでアトミックに発行します。FinalityLog はハッシュチェーン（`prev_hash`）で改ざん耐性を持ち、日次 cron で全チェーンを自動監査し、断絶を検知したら CASE へ収束させます。**「状態だけ進んで監査ログが残らない窓」は構造的に存在しません。**

### API のかたち（最小例）

```bash
# 送金の起票
POST /api/transfers
{ "lane": "EXPRESS", "amount": { "value": 5000, "currency": "JPY" },
  "payer": { "bank_id": "001", "account_hash": "h:..." },
  "payee": { "bank_id": "002", "account_hash": "h:..." } }

# 取引の照会（当事者なら誰が照会しても、同じ取引番号で同じ説明が返る）
#   X-Purpose-Code: 何のために読むか（P01〜P07）。無ければ 403
#   X-Bank-Id / X-Cron-Secret: 誰が読むか（参加者 / 運営）。当事者でなければ 404
GET  /api/transactions/TX-...
GET  /api/transactions/TX-.../verify   # FinalityLog ハッシュチェーン検証
```

「同じ説明」が及ぶのは**その取引の当事者**（払出行・被仕向行）と運営であり、無関係な参加行には
取引の存在ごと見えません（存在しない場合と同じ 404）。**説明可能性は全員に同じものを見せることでは
なく、見てよい人に同じものを見せること**です——認可の規範は
[`docs/specs/32_api_contracts.md` § 照会の認可](docs/specs/32_api_contracts.md#query-authorization)。

全エンドポイントは [`docs/specs/32_api_contracts.md`](docs/specs/32_api_contracts.md)。

### 主な機能

| レーン | 用途 | ファイナリティ |
| --- | --- | --- |
| EXPRESS | 店舗・即時 | H 予約担保 |
| STANDARD | 通常送金 | 名義確認 + 承認 |
| HTLC | 条件付きエスクロー | ハッシュロック解放 |
| HTLC_AUTH | 受取側起点オーソリ | Capture で b 成立 |
| RTP | 請求型回収 | 受取人発起 |
| GTID | 多者協調 | 全 leg の b 一致 |
| HIGH_VALUE | 高額即時（中銀経由） | RTGS 確定 |
| BULK | 大量バッチ | 日次ネッティング |

横断機能：日次ネット清算（DNS）、限度額直列化（TigerBeetle 流 Durable Object）、ディレクトリ ALS（O(1) エイリアス解決）、ストリーミング・マイクロ決済（Rafiki 流）、QR 決済（HMAC 検証）、エイリアス解決、FATF R.16 クロスボーダー、口座名義確認、ISO 20022 pacs.008 送出（FATF R.16 クロスボーダー）、EDI／リッチデータ、署名付き委任チェーン（Mandate）、外部主体の署名検証（KeyRegistry：ECDSA P-256／Ed25519・失効・nonce リプレイ防止）、サーキットブレーカ、**FinalityLog チェーンの日次自動監査（改ざん検知 → CASE）**、**単一所有者則（`Transactions.owner`：各取引を動かせる主体を DNS サイクル／決済 venue／チェーン Watcher 群のいずれか一つに固定し、タイムアウト掃引の二元帳乖離を構造的に排除。所有権移転は FinalityLog に記録）**、SSE イベントストリーム。

**表現レイヤー（`src/exploratory/`）**：上の運用機能とは **意図的に分離** してある実験的レイヤー。決済コアの正しさには一切関与せず、「状態の連なりをどう人に見せるか」だけを探究します。`/theater`・`/sky` で決済の流れを可視化します。趣味の色が濃い部分なので、運用機能と同列の「機能」として読まないでください。

### テスト

```bash
npm run test                          # 全ケース
npx vitest test/zc/express.test.ts    # 単一ファイル
```

`better-sqlite3` を D1 のインメモリ・モックとして用い、本物のスキーマに対して冪等再送・ゼロサム残高不変条件・サーキットブレーカ復帰・ハッシュチェーン監査などを統合的に検証します。`test/integration/balance_invariants.test.ts` では、各レーンで「payer Δ = −amount」「payee Δ = +amount」「行内ゼロサム」「BOJ 系の保存則」を仕訳まで往復で固定しています。

**並行性の検証について（正直な範囲）**：`better-sqlite3` は同期・単一スレッドのため、OS スレッドによる真の並列は再現できません。代わりに `test/integration/concurrent_races.test.ts` は、二つの非同期オペレーションを `Promise.all` で走らせ、各 `await` 境界でイベントループにインターリーブさせることで、**同一行に対する read→decide→write のインターリーブ競合**（check-then-act / TOCTOU）を実際に発生させて検証します（SQLite の各文は原子的に実行されるため、単一行 CAS の挙動を忠実に模す）。ロック競合・デッドロック・真の write-write 競合・分散バックエンドの分離レベルは対象外（実ストアでの検証が必要。[`docs/specs/30_internal_design.md` §7 可搬性](docs/specs/30_internal_design.md#portability)）。FX claim/refund の相互排他は `FxTransfers.status` への単一権威 CAS で担保され、このテストはどのインターリーブでも「部分決済ゼロ・二重決済ゼロ・送金一度きり」を固定します。

CI（GitHub Actions, `.github/workflows/ci.yml`）は push / PR ごとに `npm run lint:ci`（Biome、`src/` を警告ゼロで強制）・`npm run format:check`・`npm run type-check`・`npm run test` を必須ゲートとして実行します。テスト木は D1 モックに対する `any` キャストを意図的に許容しており、その方針は `biome.json` の `test/**` オーバーライドとして書いてある（`noExplicitAny` を off）——**方針を設定に書かず警告として出し続けると、1,100 件の既知ノイズに本物の指摘が埋もれる**ため。結果として `npm run lint`（ツリー全体）は警告ゼロで通り、ハードゲートの **lint:ci** は `src/` を警告ゼロで強制する。一方 **format はツリー全体**が対象です——書式は「biome.json に一致するか否か」しかなく許容すべき偽陽性が無いため、`test/` を除外する理由がありません。失敗時は `npm run format` で直します（このステップの対象を狭めて通すことは禁止）。

### 文書地図

文書は用途別に分かれています（構想・方式・制度・インタフェース／データ）：

- 構想：[Zenith 構想](https://www.sakuolia.jp/zenith.html)、[`docs/specs/11_walkthrough.md`](docs/specs/11_walkthrough.md)（5 分）
- 処理方式設計：[`docs/specs/20_method_design.md`](docs/specs/20_method_design.md)（アーキ・業務フロー・状態機械・整合性/ファイナリティ・運用/障害・移行・試験）
- 内部設計：[`docs/specs/30_internal_design.md`](docs/specs/30_internal_design.md)（横断実装規約・ロードマップに加え、[§5 単一所有者則](docs/specs/30_internal_design.md#single-owner)、[§6 一貫性モデル・原則10縮退](docs/specs/30_internal_design.md#consistency-model)、[§7 保管バックエンド移植契約](docs/specs/30_internal_design.md#portability)）。レガシー勘定系アダプタ（現実の制約を再現した敵対的コアモデルを前提にした対外接続系アダプタ）は、要件=[要求仕様章](docs/specs/10_requirements.md#core-requirements)（勘定系へのAPI別要求仕様・対応レベル表）／処理方式=`20_method_design.md`／内部設計=`30_internal_design.md` に分載
- 制度：[`docs/specs/10_requirements.md`](docs/specs/10_requirements.md)
- IF／データ：[`docs/specs/32_api_contracts.md`](docs/specs/32_api_contracts.md)、[`docs/specs/31_schema.md`](docs/specs/31_schema.md)、[`docs/specs/file_structure.md`](docs/specs/file_structure.md)
- **コアの要約と技術公開書**：[`docs/disclosure/CORE_DISCLOSURE.md`](docs/disclosure/CORE_DISCLOSURE.md)

### このシステムのコアと、それを公知にしておくこと

11,800 行の設計書のどこが**核**なのかを 1 箇所に集約し、あわせて
**その核を誰にも独占させないための技術公開書**として
[`docs/disclosure/CORE_DISCLOSURE.md`](docs/disclosure/CORE_DISCLOSURE.md) を置いています
（この文書のみ **CC0 1.0**＝パブリックドメイン提供。リポジトリ本体は MIT のまま）。

コアを一文にすると：**銀行間決済を原子的トランザクションにすることを明示的に放棄し、
代わりに「乖離は起きる。ただしすべての乖離は有界時間内に検出され、帰責され、
同一の説明として提示される」を保証対象に据えた点**にあります。
同書は**特許出願書類の様式**（明細書／特許請求の範囲／要約書／図面）で書いてあります。
権利を主張するためではなく、**先行技術としての対比が請求項どうしで行われるため、
開示の側も同じ様式で書いておく方が引用されやすい**という理由です。
26 の実施形態と【請求項1】〜【請求項70】に記載したすべての発明を、何人も自由に実施してよいものとします。
著者の特許非係争の宣言は [`NOTICE`](NOTICE) に置いてあります（CC0 1.0 は特許権を放棄しないため、
この宣言がないと穴が残ります）。

なお、条件性（HTLC）と多脚原子性（GTID）を橋渡しなしに合成できるのは、両者を
**同一の取引状態機械上の互いに素な区間**——条件性は決定の**前**（`HTLC_LOCKED` は `TxState` の値）、
多脚原子性は決定の**点**（脚は `DECIDED_TO_SETTLE` へ直接入場）——に配置しているためです。
別の問いに答えている層なので、選択肢ではなく重ねられます（同書 第3の実施形態）。

### 実装の現状と限界（誠実に）

個人による趣味の参照実装であり、本番運用は意図していません。

**このリポジトリは機能要件（協調層のふるまい）の参照リファレンスです。** 対象は
「決済を説明可能な状態機械として扱う」という機能面——状態遷移・証跡・単一所有者則・
例外/破綻/係争の扱い・レーンの契約——であり、そこは end-to-end に動き、`npm test` で
検証されます。一方で **非機能要件（可用性・スループット・容量・保管の耐久性・
セキュリティ堅牢化・運用性）は「規範として書いてあるが、この実装は満たしていない」** 
という位置づけです（要件は `docs/specs/10_requirements.md` 第8章、受入水準は同 §8.8）。
たとえば正本は単一ノードの D1（本番は分散合意 SQL が必要）、共有 HMAC は全参加者共通鍵、
性能値は開発環境の観測値——いずれも**本番仕様を示すのではなく、本番なら何が要るかを
示すための例示**です。要するに、**「何を作るべきか」を機能面で確かめるための実装であり、
「本番でどこまで満たすか」を非機能面で示す実装ではありません。** リファレンスはコピー
されるものなので、この線引きは設計判断そのものと同じ重さで扱っています。

- 署名・鍵管理：ZC 自身の送出署名は**非対称鍵に移行可能**——`ZC_SIGNING_KEY_*` を設定すると ZC は egress を秘密鍵（ECDSA P-256／Ed25519）で署名し、参加主体は `KeyRegistry` の ZC 公開鍵（`owner_type='ZC'`）で検証する（`src/shared/zc_signature.ts`）。秘密鍵は ZC 外に出ず、鍵ごと（`key_id`）にローテーション可能で、`docs/specs/10_requirements.md` §3.3.4 の KeyRegistry 統制（4 眼登録・失効）に乗る。未設定時は従来の単一 HMAC-SHA256 にフォールバックし、検証側（bank ingress）は `X-ZC-Key-Id` ヘッダの有無で非対称／HMAC を**両受け**して段階移行する。その共有 HMAC 自体も**期限付きの重複窓**で交換できる——署名は常に現行値、検証だけが `ZC_HMAC_SECRET_PREVIOUS` を `ZC_HMAC_SECRET_PREVIOUS_UNTIL` まで受理し、期限後は再デプロイなしに止まる。期限の無い旧値は「窓」ではなく生きた鍵が 2 本ある状態なので無効として扱う（`src/shared/secret_rotation.ts`、[`docs/specs/30_internal_design.md` §12.6.4](docs/specs/30_internal_design.md#appendix-a-if)）。外部主体（参加行・アテスター・エージェント・Watcher）からの署名は同じ `KeyRegistry` 公開鍵で検証し、有効期間・失効・時刻スキュー・(`key_id`, `nonce`) リプレイ防止まで見る。輸送層の TLS / mTLS、保存時暗号化、規制適合は範囲外。**照会の認可は実装済み**——目的コード・当事者判定（当事者でない行には取引の存在ごと見えない）・アクセス監査台帳に加え、参加者の主体は `KeyRegistry` の参加者鍵によるリクエスト署名で認証する。**強制は鍵の登録状態で決まる**（登録済みの行は署名必須。呼び出し側がヘッダを省いて降格することはできない）ため、参加行ごとの段階移行になる（[`docs/specs/32_api_contracts.md` § 照会の認可](docs/specs/32_api_contracts.md#query-authorization)）。
- **クロスチェーンのトラストモデル**：クロスチェーン HTLC は無信頼アトミックスワップ**ではない**（ZC はチェーンを自ら観測せず、Watcher の署名付き観測 `SettlementProofRef` を信頼根とする）。ただし**単一信頼点は解消済み**：決済は HTLC ごとの `onchain_min_watchers`（**PUBLIC＝確率的チェーンの既定は 2**、PRIVATE/PERMISSIONED＝決定的および未分類は 1、`cross_chain.min_watchers` で上書き可）に従い、**相異なる Watcher 運用主体**（`KeyRegistry.owner_ref` で計数。1主体が複数鍵を持っても1票）の n-of-m クォーラムが同一 release を独立に署名するまで `HTLC_ONCHAIN_PENDING` に留め、未達は `ONCHAIN_QUORUM_PENDING` で保留する（`src/shared/watcher.ts#countDistinctWatchers`、`src/zc/lanes/htlc/crosschain.ts`、`test/zc/htlc_crosschain_quorum.test.ts`）。クォーラムは**一致しているときだけ意味を持つ**ため、同一 `(source, external_ref)` に相異なる proof_type/venue を主張する Watcher の二枚舌（equivocation）は受理せず（票に数えない）、`WatcherEquivocationDetected` を起票して CASE へ収束させる（`src/shared/watcher.ts#recordWatcherObservation`）。preimage は `sha256hex(preimage)==hashlock` で実検証し、`onchain_timelock < timelock` のタイムロック順序と確認深度ゲート（`onchain_finality.ts`）が reorg を救う。確認深度は単一署名者の自己申告ではなく**クォーラムを構成する各 Watcher の最小値**（`minConfirmationsAcrossWatchers`）で評価し、1 主体が深度を水増ししてゲートを通すことはできない。残る前提は「クォーラムを構成する Watcher 群のうち過半数が正直」であること——信頼を単一鍵から n-of-m に分散したが、ゼロにはしていない（無信頼ブリッジではない）。
- **参照整合性（外部キー）**：構造的な所有関係（`HtlcContracts.txid`・`GtidLegs.{gtid,txid}`・`FxLegLocks.gtid`・`HtlcAuthRequests.whitelist_id`・`DnsNetPositions.cycle_id`・`Attestation.template_id`・`Mandate.parent_mandate_id`）に `FOREIGN KEY` を宣言し、テスト D1 を `PRAGMA foreign_keys = ON` で起動して全テストで強制・検証する（`test/invariants/foreign_keys.test.ts`）。追記専用ログ（`FinalityLog` 等。`txid_or_gtid` はポリモーフィック）と、行生成前に予測 txid へ予約する `HReservations.txid`（前方参照）は意図的に非 FK。詳細は [`docs/specs/31_schema.md`](docs/specs/31_schema.md) § Foreign Key 戦略。
- パフォーマンス値は開発環境の観測値であり、本番保証ではない。
- 単一正本性は D1（単一ノード SQLite）で簡易に実現している。設計原則 10 のうち **縮退側（制御半分）は実装済み**——quorum 健全性評価・quorum 喪失時の Read-only 自動縮退（`QUORUM_LOSS_READONLY`）・書き込みプリミティブでの強制・回復での自動復帰・GLOBAL チェーンへの監査（`src/zc/platform/{quorum,system_mode}.ts`、`/internal/system-mode/quorum-report`、`test/zc/quorum.test.ts`）。**未実装は保管側**——実体としての分散合意ログそのもの。単一ノード D1 には観測すべき multi-replica quorum が無いため、本番では合意を内包した分散 SQL（Google Spanner / Amazon Aurora DSQL / CockroachDB / YugabyteDB など）が正本を保管し、その**メンバシップ健全性を `reconcileQuorum` に供給**する（強制配線はそのまま機能）。単一ノードの PostgreSQL では quorum 要件を単体では満たさない（クラスタ/HA 構成が前提）。保証する一貫性は [`docs/specs/30_internal_design.md` §6 一貫性モデル](docs/specs/30_internal_design.md#consistency-model)、移植契約は [§7 可搬性](docs/specs/30_internal_design.md#portability)。
- 規範要件の多くは実装済み：DNS_HOLD の igs_mode 階層遷移（`RINGFENCED_PLUS` 昇格・`dns_recovery_reserve` 算定・`igs_throttle_budget` 公平性制御・優先度付き Defer キュー）、Bulk LSM 最適化（辞書式目的・採択理由証跡・フォールバック）、GTID の N:M fan-in / fan-out（単一・複数通貨の balanced 一般 N×M を含む）、誤記録訂正（`MisrecordCorrected`：時間窓＋4 眼＋evidence）、HTLC 条件の AND/OR 合成、署名付き委任チェーン（Mandate：親子スコープ逓減・サイクルガード・受付時 CASE 収束）、クロスチェーン確定種別（公開＝確率的／私的＝決定的）＋量子リスク証跡、DNS サイクルの日内複数回化、副署の GTID/DNS 拡張＋必須化ポリシー。クロスカレンシー FX（Icebreaker 型の導管分解＋共有ハッシュロック PvP）も実装済み（[`docs/specs/30_internal_design.md`](docs/specs/30_internal_design.md)）。残るのは制度設計側（リザーブ算式・LSM 目的関数・条件テンプレ提案プロセス・チェーン分類権威・アンカー配布先）と、FX の任意の発展（`docs/specs/30_internal_design.md` §17.4 将来課題：動的上限・丸め益帰属・紛争フロー）および CBT 署名付き確定の自動 EOD 取り込み。詳細は [`docs/specs/30_internal_design.md`](docs/specs/30_internal_design.md#s10-roadmap) § 10。

意図は **実物の代わりではなく、議論のたたき台** を提供することです。とりわけ議論したい問いは三つ：

1. この協調層を **誰が運営** し、既存の全銀ネット・日銀ネットと **どう接続** するのが現実的か。
2. 移行コストを誰がどう負担するか（並行稼働・段階移行の現実解）。
3. 危機時（DNS_HOLD）の流動性供給を、制度としてどこまで自動化し、どこから人の判断にするか。

### 想定する読者・ライセンス・連絡

決済の制度／サービス企画、銀行・決済事業者・SIer のエンジニア、監査性に関心のある方の参考になれば幸いです。

中身はどのような形でお使いいただいても構いません（MIT License、[LICENSE](LICENSE)）。質問・議論は [GitHub Issues](https://github.com/pochatt/zenith-coordinator/issues) へ。

> このリポジトリと付属文書はフィクションであり、実在のいずれの組織・システム・運用も示していません。

---

## English

### About

A reference implementation of the **Zenith Coordinator (ZC)**: a **coordination layer** that makes inter-bank settlement explicable as a sequence of states recorded in an append-only, hash-chained FinalityLog — **without replacing any bank's core ledger**. A personal project, built independently with **no confidential material**. It runs end-to-end on TypeScript + Cloudflare Workers, and represents no real institution, system, or operation.

→ The starting concept: [Zenith concept (Japanese)](https://www.sakuolia.jp/zenith.html).

### Why this exists

Japan's payment systems are robust and have been remarkably stable. What still feels incomplete, from the user's side, is **explicability** — knowing where one's money is, why something is delayed, and who can answer. Zenith does not replace the existing rails; each institution keeps its core banking exactly as today. It reimagines the **coordination layer between institutions**, so that whatever happens there can later be explained under a single transaction id — identically to every party to it — and it is meant to be run and touched, not only read.

**A 30-second example (a household direct debit that fails on insufficient funds):** today, the customer learns of the failure days later by mail and it takes ~16 days to resolve; with Zenith, both customer and biller see the same notification within seconds and it resolves in hours, all reading **the same transaction id, the same timestamps, the same reason code**. See [`docs/specs/11_walkthrough.md`](docs/specs/11_walkthrough.md).

### What it does, and does not

- **It does:** treat each settlement as **Acceptance → Decision → Execution → Finality (b)** across banks, recording every transition in an append-only FinalityLog, so users, businesses, and authorities obtain the same explanation under the same id.
- **It does not:** replace participants' core ledgers; decide identity, credit, or limits; or take legal positions.

### Design principles

1. The single source of truth is the **Finality Log**; derived views can be rebuilt. (Its scope is *coordination facts* — decisions, ownership handoffs, received signed proofs; the truth of *money facts* lives in each participant's ledger. ZC's claim is not "no divergence (atomicity)" but "every divergence is detected and attributed within bounded time (auditability)" — see [`docs/specs/30_internal_design.md` §5 single-owner rule](docs/specs/30_internal_design.md#single-owner).)
2. **Decision and Execution are always separated.**
3. The irreversible boundary is **b (PAYEE_EXEC_CONFIRMED)**; remedies after b are Reversals (new transactions).
4. **States that cannot be explained are forbidden** — unresolved states converge into a CASE.
5. The meaning of a synchronous response is fixed by contract.
6. Evidence is never added after the fact.
7. Lanes are **contracts about finality points and evidence**, not UX categories.
8. **H (sending-side over-limit)** is managed as a state; absolute over-limit is impossible by construction.
9. Crisis handling is an **institutionalised state transition**, not an exception path.
10. Single-truth integrity is held by a consensus log; under quorum loss, the system degrades to read-only.

Full text: [`docs/specs/20_method_design.md`](docs/specs/20_method_design.md).

### TradFi and DeFi in one vocabulary

Zenith expresses traditional rails (RTGS, DNS netting, Zengin retail, ISO 20022, FATF R.16) and newer primitives (HTLC, atomic multi-leg) **as coequal lanes on one state machine, not ledgers joined by a bridge**:

| Lane | Heritage | Finality primitive |
| --- | --- | --- |
| EXPRESS / STANDARD / BULK | TradFi (retail, Zengin) | H-reserve + netting |
| HIGH_VALUE | TradFi (central-bank RTGS) | Real-time gross settlement |
| DNS cycle | TradFi (clearing house) | End-of-day net position |
| HTLC / HTLC_AUTH | DeFi-native | Hash-lock + time-lock |
| GTID | Hybrid (atomic multi-leg) | All-or-nothing across legs |
| RTP | Hybrid (pull-based) | Name verification + authorisation |

Its focus is three things: (1) HTLC, GTID atomic multi-leg, RTGS, and DNS netting as coequal lanes inside one state machine; (2) atomic pairing of state transitions with FinalityLog writes plus single-trace-id lifecycle tracing; (3) a liquidity-cascade rulebook for DNS_HOLD written at the same fidelity as the code ([`docs/specs/10_requirements.md`](docs/specs/10_requirements.md)).

### The institutional layer

Alongside code and method, the repository includes **institutional and governance documents**: four-eyes approval and break-glass access, purpose codes (P01–P07) and data minimisation, the ordered DNS_HOLD response (initial communication, disclosure control, liquidity-providing-bank scheme, mutual contribution, last-resort central-bank funding), and WORM retention. Gathered in [`docs/specs/10_requirements.md`](docs/specs/10_requirements.md). A payment system does not land in society on technical specification alone.

### Getting hands on

Requires Node.js 18+, npm 8+, a Cloudflare account (free tier).

```bash
git clone https://github.com/pochatt/zenith-coordinator.git
cd zenith-coordinator && npm install
npm run db:migrate:local
npm run dev          # http://localhost:8787 (dashboard at root)
# To transact from the UI without a key (POST /api/* — transfers, HTLC, …), set
# ZC_ALLOW_UNAUTHENTICATED_UI = "true" in wrangler.toml [vars]. This is the one
# sanctioned keyless-UI path: off by default, same-origin only, logged per request,
# never in production.
npm run test         # full suite
```

Deploy: `wrangler login` → create D1/queue/R2 → `cp wrangler.toml.example wrangler.toml` (fill ids) → `npm run db:migrate:remote` → `npm run deploy` → `POST /internal/seed`.

### State machine, in code

Every state advance is routed through `transitionWithLog`, which issues the CAS UPDATE on `Transactions` and the INSERT into `FinalityLog` as a single D1 batch. The FinalityLog is a `prev_hash` hash-chain, audited across every chain by a daily cron that converges any break into a CASE. **There is no window in which the state moves forward without its paired audit entry.** See [`src/zc/orchestrator/state_machine.ts`](src/zc/orchestrator/state_machine.ts).

### Features

Lanes: EXPRESS (retail), STANDARD (name check + authorisation), HTLC (conditional escrow), HTLC_AUTH (payee-initiated authorisation, b on capture), RTP (pull/invoice), GTID (multi-party atomic, b on all legs), HIGH_VALUE (central-bank routed, RTGS final), BULK (end-of-day netting).

Cross-cutting: daily net settlement (DNS), TigerBeetle-style limit Durable Object, O(1) alias cache, Rafiki-style streaming micro-payments, HMAC-validated QR, alias resolution, FATF R.16 cross-border, name/account verification, ISO 20022 pacs.008 egress (FATF R.16 cross-border), EDI / rich data, signed delegation chains (Mandate), external-party signature verification (KeyRegistry: ECDSA P-256 / Ed25519, revocation, nonce replay protection), circuit breaker, **daily FinalityLog hash-chain audit (tamper detection → CASE)**, **single-owner rule (`Transactions.owner`: each transaction is movable by exactly one party — DNS cycle / settlement venue / chain-watcher set — structurally eliminating the timeout-sweep two-ledger divergence; handoffs are recorded in the FinalityLog)**, SSE event stream. Full endpoint reference: [`docs/specs/32_api_contracts.md`](docs/specs/32_api_contracts.md).

**Expressive layer (`src/exploratory/`):** kept *deliberately separate* from the operational features above — it has no bearing on settlement correctness and explores only *how* a sequence of states can be shown to a person, with `/theater` and `/sky` visualisations. This is the hobbyist corner; please don't read it as a feature on par with the operational ones.

### Status and limits, stated plainly

A personal reference implementation, not for production.

- Signing and keys: ZC's own egress signing can move to an **asymmetric key** — set `ZC_SIGNING_KEY_*` and ZC signs egress with a private key (ECDSA P-256 / Ed25519); participants verify against ZC's `KeyRegistry` public key (`owner_type='ZC'`, `src/shared/zc_signature.ts`). The private key never leaves ZC, rotates per `key_id`, and is governed by the `docs/specs/10_requirements.md` §3.3.4 KeyRegistry controls (four-eyes registration/revocation). When unset it falls back to the legacy single HMAC-SHA256, and the verifier (bank ingress) **dual-accepts** asymmetric vs HMAC by the presence of an `X-ZC-Key-Id` header for staged migration. Signatures *from* external parties (participants, attesters, agents, Watchers) are verified against the same `KeyRegistry` public keys, including validity window, revocation, timestamp skew, and (`key_id`, `nonce`) replay protection. Transport TLS/mTLS, encryption at rest, and regulatory controls are out of scope. **Query authorization is implemented** — purpose codes, a party check that makes another participant's transactions indistinguishable from absent, an access audit log, and participant identity bound to a `KeyRegistry` credential by a request signature. **Enforcement is keyed on registry state, not on the caller's headers**: a bank with a registered key cannot downgrade to asserting its id by omitting one, so the rollout proceeds participant by participant ([`docs/specs/32_api_contracts.md` § 照会の認可](docs/specs/32_api_contracts.md#query-authorization)).
- Performance figures are dev-environment observations, not production claims.
- Single-truth integrity is realised the simple way, on D1 (single-node SQLite). Of design principle 10, the **degradation half (the control side) is implemented**: quorum-health evaluation, automatic read-only degradation on quorum loss (`QUORUM_LOSS_READONLY`), enforcement at the write primitives, automatic recovery, and an audit trail on the GLOBAL chain (`src/zc/platform/{quorum,system_mode}.ts`, `/internal/system-mode/quorum-report`, `test/zc/quorum.test.ts`). What is **not** implemented is the storage side — the distributed consensus log itself: single-node D1 has no multi-replica quorum to observe. Production backs the log with a distributed SQL with consensus built in (Google Spanner / Amazon Aurora DSQL / CockroachDB / YugabyteDB) and feeds *its* membership health into `reconcileQuorum` (the enforcement wiring then holds as-is); a single-node PostgreSQL does not meet the quorum requirement on its own (it would need a clustered/HA setup). Guarantees: [`docs/specs/30_internal_design.md` §6 consistency model](docs/specs/30_internal_design.md#consistency-model); porting contract: [§7 portability](docs/specs/30_internal_design.md#portability).
- Most normative requirements are now implemented: the DNS_HOLD igs_mode hierarchy (RINGFENCED_PLUS promotion, `dns_recovery_reserve` computation, `igs_throttle_budget` fairness control, a priority Defer queue), the Bulk LSM optimiser (lexicographic objective, adoption-rationale evidence, fallbacks), general N:M GTID fan-in/out (single- and multi-currency balanced N×M), record correction (`MisrecordCorrected`: time-window + four-eyes + evidence), HTLC AND/OR condition composition, signed delegation chains (Mandate: parent/child scope narrowing, cycle guard), cross-chain finality classification (public=probabilistic / private=deterministic) with quantum-risk metadata, intraday DNS cutoffs, and FinalityCosign extension to GTID/DNS chains with a mandatory-cosign policy. Cross-currency FX (Icebreaker-style conduit decomposition with shared-hashlock PvP) is implemented too ([`docs/specs/30_internal_design.md`](docs/specs/30_internal_design.md)). What remains is institutional (reserve formula, LSM objective, condition-template proposal process, chain-classification authority, anchor distribution), optional FX extensions (`docs/specs/30_internal_design.md` §17.4: dynamic limits, rounding-profit attribution, dispute flow), and automatic EOD ingest of CBT signed finality. See [`docs/specs/30_internal_design.md`](docs/specs/30_internal_design.md#s10-roadmap) § 10.

The intent is **something to argue with**, not something to replace anything. The questions worth arguing: **who operates this layer, how it connects to existing RTGS/clearing rails, and who bears the migration cost.**

### License

MIT — see [LICENSE](LICENSE). Use it in whatever form suits you. Questions and discussion: [GitHub Issues](https://github.com/pochatt/zenith-coordinator/issues).

**One exception, deliberately more permissive:** [`docs/disclosure/CORE_DISCLOSURE.md`](docs/disclosure/CORE_DISCLOSURE.md)
is released under **CC0 1.0** (public domain dedication). It is a *defensive publication*: it states, in
construction-by-construction form, what this system's core actually is, so that **no one can take it out of
the public domain**. The core in one sentence: this design **explicitly gives up on making interbank
settlement an atomic transaction**, and instead guarantees that *divergence happens, but every divergence is
detected within a bounded time, attributed, and presented as one and the same explanation to every party.*
It is written in the form of a Japanese patent application (specification, claims, abstract, drawings) —
not to assert rights, but because prior art gets compared claim against claim, so the disclosure side reads
better and gets cited more when it is written the same way. Twenty-six embodiments and claims 1-70 are placed
in the public domain; anyone may implement them. The author's patent non-assertion declaration is in
[`NOTICE`](NOTICE) — CC0 1.0 does not waive patent rights, so the declaration is what closes that gap. Among the disclosures: conditionality (HTLC) and
multi-leg atomicity (GTID) compose **without a bridge** because they occupy **disjoint segments of one
transaction state machine** — conditionality sits *before* the decision (`HTLC_LOCKED` is a `TxState`
value), multi-leg atomicity *at* it (legs enter directly at `DECIDED_TO_SETTLE`). They answer different
questions, so they stack rather than compete.

> This repository and its accompanying documents are a work of fiction; they do not represent any real organisation, system, or way of working.
