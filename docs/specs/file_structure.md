# Zenith Payment System - Repository File Structure

このドキュメントでは、Zenith Payment System モック実装のディレクトリ構造とその役割を説明します。本プロジェクトは Cloudflare Workers, D1 (SQLite), Queues, R2 というサーバーレススタックを用いた TypeScript バックエンドと、Alpine.js + Tailwind CSS を用いて構成されたフロントエンドを内包しています。

> **バイリンガル注記**: 旧 `file_structure.en.md`（英語版）は削除され、その内容は本ファイル末尾の [English](#english) 節に統合されました。日本語（本節）と英語（English 節）は同じツリーを二言語で説明します。
>
> **docs/specs/ 構成注記**: 設計書は「深さ（工程）別」に再編されています。**要件定義 → 処理方式設計 → 内部設計** の3層を本体（`10_` / `20_` / `30_`）とし、テーブル定義と API 契約はその参照別紙（`31_` / `32_`）、読み物ウォークスルーは要件定義の別紙（`11_`）です。旧ファイル（`zenith_public.md`／`zenith_policy.md`／`architecture.md`／`fx.md`／`legacy_adapter.md`／`schema.md`／`api-contracts.md`／`walkthrough.md`）はすべてこの体系へ畳み込まれ、単独ファイルとしては存在しません。クロスカレンシーFXとレガシー勘定系アダプタは独立ファイルではなく、各層の章として収録し（要件=`10_`／処理方式=`20_`／内部=`30_`）、機能の全体像は各章冒頭の「機能別索引」から辿れます。

## ディレクトリ・ファイル構成概要

```text
/
├── .wrangler/          # (自動生成) Cloudflare Wranglerのローカル実行環境データ（ローカルD1のデータベースファイル等を含む）
│
├── migrations/         # データベーススキーマ（D1 SQLite）のマイグレーションスクリプト群
│   └── 0001_consolidated_schema.sql        # 統合スキーマ（唯一の正）。旧 0001〜0042 を最終形に畳んだ全テーブル定義・索引・初期シードデータ。スキーマ変更はこの 1 ファイルを直接編集する
│
├── docs/                # ドキュメント群（仕様書・設計ドキュメントと技術公開書）
│   ├── specs/                              # 仕様書・設計ドキュメント（深さ別: 要件定義→処理方式設計→内部設計）
│   │   ├── 10_requirements.md              # 【要件定義書】目的・業務スコープ・関係主体・制度/ガバナンス要件・規制・非機能要件（FX/アダプタの要件を含む）
│   │   ├── 11_walkthrough.md               # └ 要件定義の別紙: 主要フロー（送金の一生）のウォークスルー（読み物・日英併記）
│   │   ├── 20_method_design.md             # 【処理方式設計書】全体アーキ・業務フロー・状態遷移・整合性/ファイナリティ・運用/障害・移行・試験（FX/アダプタの処理方式を含む）
│   │   ├── 30_internal_design.md           # 【内部設計書】実装規約・単一所有者則・移植契約・I/F契約・メッセージ定義・アルゴリズム詳細（FX/アダプタの内部設計を含む）
│   │   ├── 31_schema.md                    # └ 内部設計の別紙: データベーステーブルの詳細スキーマと関係（テーブル定義の SoT）
│   │   ├── 32_api_contracts.md             # └ 内部設計の別紙: API I/F仕様・JSONスキーマ・エラーカタログ
│   │   └── file_structure.md               # ［本ファイル］ディレクトリ構造の解説（日英併記）
│   └── disclosure/                         # 技術公開書（防衛的公開。CC0。版で管理し、旧版を消さない）
│       ├── CORE_DISCLOSURE.md             # 出願書類一式（日本出願様式。明細書・特許請求の範囲・要約書・図面）。これ以外のものを置かない
│       └── US_APPLICATION.md              # 米国実務の様式で書き下ろした対応稿（CORE_DISCLOSURE.md の逐語訳ではない）
│
├── src/                # バックエンド・フロントエンドのソースコード（素の Cloudflare Workers fetch ハンドラ）
│   ├── index.ts                            # Worker エントリーポイント（default fetch/queue/scheduled・CORS・静的配信・DO re-export）。HTTP ルータ本体は router/ に分離
│   ├── html.d.ts                           # `.html` を文字列としてインポートするための型宣言
│   ├── types.ts                            # 全型定義の単一バレル（下記 types/ を re-export）
│   │
│   ├── router/                             # HTTP パスルータ（index.ts から分離）
│   │   ├── zc.ts                           # /api/* ルータ（handleZcApi。FX ルートも含む）
│   │   ├── bank.ts                         # /bank/:id/* ルータ（handleBankApi）
│   │   └── internal.ts                     # /internal/* ルータ（seed・cron・DNS 管理）
│   │
│   ├── types/                              # 型定義モジュール（`src/types.ts` 経由で参照）
│   │   ├── primitives.ts                   # `Env` / `Amount` / `BankProofRef` / FATF データ型
│   │   ├── states.ts                       # ステート文字列ユニオン（`TxState` / `HtlcState` / `GtidState` / `DnsState`）
│   │   ├── api/                            # HTTP 入出力型・Queue メッセージ型をドメイン別に分割
│   │   │   ├── index.ts                    # api/ バレル（下記を re-export）
│   │   │   ├── bank-ingress.ts             # ZC→Bank コマンド I/O 型
│   │   │   ├── transfers.ts                # 送金/GTID/RTP 系リクエスト・レスポンス型
│   │   │   ├── htlc.ts                     # HTLC / HTLC-Auth I/O 型
│   │   │   ├── directory.ts                # 名義/エイリアス解決 I/O 型
│   │   │   ├── customer.ts                 # 顧客向けバンキング API 型
│   │   │   ├── filter.ts                   # AML/フィルタ I/O 型
│   │   │   ├── richdata.ts                 # リッチ/構造化データ I/O 型
│   │   │   ├── iso20022.ts                 # ISO 20022 メッセージ型
│   │   │   └── messaging.ts                # Queue メッセージ・イベント型
│   │   └── rows/                           # D1 行型をドメイン別に分割
│   │       ├── index.ts                    # rows/ バレル（下記を re-export）
│   │       ├── core.ts                     # `Transactions` / `Participants` / `BankAccounts` 等の中核行
│   │       ├── lanes.ts                    # レーン系行（GTID・HTLC 等）
│   │       ├── settlement.ts               # DNS/IGS/H 系行
│   │       ├── finality.ts                 # FinalityLog / アンカー系行
│   │       ├── events.ts                   # TxEventLog / ストリーム系行
│   │       ├── directory.ts                # 名義/エイリアス系行
│   │       ├── richdata.ts                 # リッチデータ系行
│   │       ├── cases.ts                    # CASE / Reversal 系行
│   │       ├── security.ts                 # KeyRegistry / 署名・クォーラム系行
│   │       └── bank.ts                     # 銀行モック側（元帳・別段預金・レガシー）行
│   │
│   ├── shared/                             # ZC/銀行で共用のユーティリティ
│   │   ├── constants.ts                    # システム定数・設定値
│   │   ├── errors.ts                       # DomainError / errorResponse / reason_code → category 写像（HTTP & retry の SoT）
│   │   ├── logger.ts                       # newRequestLogger（1イベント1JSON、X-Request-Id、PII 自動 redaction）
│   │   ├── hmac.ts                         # HMAC-SHA256 署名・検証（Web Crypto）
│   │   ├── secret_rotation.ts              # 共有 HMAC の期限付きローテーション重複窓（署名は現行鍵のみ／検証は期限まで旧鍵も受理）
│   │   ├── api_auth.ts                     # /api/* の外周認証判定（資格情報のみ。鍵なし経路は ZC_ALLOW_UNAUTHENTICATED_UI の明示的 opt-in）
│   │   ├── idempotency.ts                  # Idempotency-Key 制御（acquire / resolve / complete）
│   │   ├── iso20022.ts                     # ISO 20022 pacs.008 生成（FATF R.16 クロスボーダー）
│   │   ├── routing.ts                      # ルーティング・BIC/bank_id マッピング
│   │   ├── fatf_validator.ts               # FATF R.16 コンプライアンス検証
│   │   ├── proof.ts                        # BankProofRef/SettlementProofRef 生成・信頼検証
│   │   ├── request-id.ts                   # 決定論的リクエストID生成
│   │   ├── validator.ts                    # ZC Ingress API ペイロードのスキーマ検証（VALID_CURRENCIES 含む）
│   │   ├── external_signature.ts           # 外部主体の署名検証（ECDSA P-256/Ed25519、KeyRegistry）
│   │   ├── zc_signature.ts                 # ZC 自身の送信署名（非対称。KeyRegistry の ZC 公開鍵で参加行が検証。旧 HMAC 共有鍵の置換）
│   │   ├── attestation.ts                  # 署名付き「条件成立」表明の記録・鮮度検証（ConditionTemplate/Attestation）
│   │   ├── attestation_quorum.ts           # ConditionTemplate Attestation の k-of-n クォーラム・equivocation 検査（Watcher と同型の信頼最小化）
│   │   ├── operator_quorum.ts              # 署名観測の n-of-m クォーラム・equivocation ポリシー（テーブル非依存の共通実装。distinct operator 単位）
│   │   ├── mandate.ts                      # 委任（Mandate）チェーンの登録・検証
│   │   ├── watcher.ts                      # 外部レール確定イベントの観測記録（WatcherObservation）
│   │   ├── central_bank.ts                 # 中央銀行決済レジストリ＋トークン化中銀預金(CBT)口座モデル（通貨別中銀ファイナリティ、settlementAccountId）
│   │   └── entity_state_log.ts             # EntityStateLog（非Transactionエンティティの状態遷移履歴）追記
│   │
│   ├── cron/                               # Cron トリガーで起動するバッチ処理
│   │   ├── eod.ts                          # EOD 8 ステップ（DNS kick/settle・利息計上・残高スナップショット等）
│   │   └── timeout_sweep.ts                # 1 分毎の停滞取引・HTLC タイムロック・GTID 失効・FX ロック払戻（sweepExpiredFxLocks, step 16）
│   │
│   ├── dashboard/                          # 運用フロントエンド（静的HTMLとして Worker から Serve される）
│   │   ├── index.html                      # ZC（基盤）の全体の稼働状況やダッシュボード画面（/, /dashboard）
│   │   ├── console.html                    # 銀行および基盤向けのオペレーションコンソール（/console）
│   │   └── bank-app.html                   # エンドユーザー（銀行ユーザー）向けのモックアプリ（/bank-app）
│   │
│   ├── exploratory/                        # 表現レイヤー（運用機能と分離・決済コアに非関与）
│   │   └── ui/                             # 表現レイヤーの静的HTML
│   │       ├── theater.html                # Settlement Theater — 状態遷移アニメーション（/theater, /theatre）
│   │       └── sky.html                    # Sky モード — システム俯瞰ビュー（/sky）
│   │
│   ├── openapi/                            # OpenAPI 形式での API スキーマ生成
│   │   ├── zc-api.ts                       # ZC Core API のスキーマ（fx タグ含む）
│   │   └── bank-api.ts                     # 銀行モック API のスキーマ
│   │
│   ├── zc/                                 # Zenith Coordinator（決済基盤）のコアドメインロジック
│   │   │                                   #   直下のドメインモジュールは用途別サブフォルダにグループ化。
│   │   │                                   #   大型モジュールは「薄いバレル + 同名サブフォルダ」で機能分割（既存の htlc_auth/・rtp/ に倣う）
│   │   ├── ingress.ts                      # 基盤側の送金受付 API バレル（下記 ingress/ を re-export。/api/*・/internal/*）
│   │   ├── ingress/                        # Ingress ハンドラの機能分割（ドメイン別）
│   │   │   ├── _shared.ts                  # json / jsonError 応答ヘルパ
│   │   │   ├── transfers.ts                # transfers / gtid / rtp / authorize / cancel / resume 起票系
│   │   │   ├── htlc.ts                     # HTLC create / claim / attest / conditions / cross-chain
│   │   │   ├── htlc_auth.ts                # HTLC-Auth request / approve / capture / void / whitelist
│   │   │   ├── collection.ts               # 継続収納（口座振替）契約・予告・ラダー・追加認可・照会の HTTP ハンドラ
│   │   │   ├── admin.ts                    # 参加行・参加者管理 + シードデータ
│   │   │   └── sim.ts                      # シミュレータ大規模セットアップ（20 行 × 200 口座）
│   │   ├── orchestrator.ts                 # Queue consumer 本体（processQueueMessage が orchestrator/* を呼び分け。ZC_BANK_LEG_READY で advanceGtid）
│   │   ├── orchestrator/                   # 非同期ワーカーの分割実装
│   │   │   ├── state_machine.ts            # ALLOWED_TRANSITIONS / isValidTransition（TxState 全遷移の Single Source of Truth）
│   │   │   ├── gtid_state_machine.ts       # GtidState レベルの遷移バリデータ（GTID 版の遷移 SoT。state_machine.ts と対称）
│   │   │   ├── finality.ts                 # FinalityLog 追記・取消・SUSPENDED 確定
│   │   │   ├── bank_hub.ts                 # ZC→銀行 内部呼び出しハブ（Circuit Breaker ゲート適用）
│   │   │   └── gtid.ts                     # GTID 多脚ファイナライズ判定（checkAndFinalizeGtid が FxTransfers.status を更新）
│   │   │
│   │   ├── lanes/                          # 個別レーン（送金の性質ごとの処理）の実装
│   │   │   ├── _helpers.ts                 # 共通プリミティブ（transitionWithLog: ALLOWED_TRANSITIONS 検証 + CAS+FinalityLog の atomic batch、cancelInFlightTx: TOCTOU安全な取消順）
│   │   │   ├── _mandate_precheck.ts        # 委任権限（Mandate）の精査共通モジュール（mandatePrecheckOrSuspend）。EXPRESS/STANDARD/HIGH_VALUE/BULK が利用
│   │   │   ├── _authority_check.ts         # AML/制裁 Authority Check の共通ステップ。判定不能（回路OPEN 等）は PRECHECKED に留置して T_auth を開始（fail-closed）
│   │   │   ├── _reserve_funds.ts           # H予約 → H_RESERVED → 銀行 reserve-funds の共通3ステップ流動性コミット（EXPRESS/STANDARD 共有）
│   │   │   ├── _decide_and_enqueue.ts      # H_RESERVED → DECIDED_TO_SETTLE 確定の共通化（決定/ファイナリティ証跡・DNS付与・H LOCKED化・ZC_BANK_DEBIT enqueue）
│   │   │   ├── express.ts                  # Fast-track 店舗決済等（H 予約で即時確定）
│   │   │   ├── standard.ts                 # 名義確認・オーソリを伴う標準の一般送金
│   │   │   ├── bulk.ts                     # 一括決済・LSM キューイング
│   │   │   ├── highvalue.ts                # 日銀 RTGS 決済を介在する高額送金（H 予約スキップ）
│   │   │   ├── htlc.ts                     # HTLC レーン バレル（下記 htlc/ を re-export）
│   │   │   ├── htlc/                       # HTLC 機能分割（Hash Time-Lock）
│   │   │   │   ├── create.ts               # createHtlc / lockHtlc（RECEIVED → HTLC_LOCKED）
│   │   │   │   ├── claim.ts                # claimHtlc / claimHtlcByAttestation / claimHtlcByConditions
│   │   │   │   ├── crosschain.ts           # recordCrossChainLock / recordOnchainFulfillment（クロスチェーンHTLC）
│   │   │   │   ├── cancel.ts               # cancelHtlc（全フェーズ共通）
│   │   │   │   └── _fulfill.ts             # settleAfterPreimage コア（HtlcFulfillResult）
│   │   │   ├── htlc_auth.ts                # HTLC Auth バレル（受取側起点オーソリ）
│   │   │   ├── htlc_auth/                  # HTLC Auth 機能分割
│   │   │   │   ├── whitelist.ts            # 加盟店ホワイトリスト管理（register / revoke / list）
│   │   │   │   ├── request.ts              # 受取側オーソリリクエスト + 送金側 decline
│   │   │   │   ├── approve.ts              # 送金側承認（preimage 生成 + canonical RECEIVED → HTLC_LOCKED）
│   │   │   │   ├── capture.ts              # 受取側キャプチャ + ボイド
│   │   │   │   └── query.ts                # オーソリ参照（list / get）
│   │   │   ├── gtid.ts                     # GTID レーン バレル（下記 gtid/ を re-export）
│   │   │   ├── gtid/                       # GTID（グローバル ID による原子・多脚決済）機能分割
│   │   │   │   ├── legs.ts                 # leg 正規化（fan-out / fan-in / 一般 N×M → 1:1）純関数
│   │   │   │   ├── register.ts             # registerGtid（GT_RECEIVED + LEG_REGISTERED）
│   │   │   │   └── advance.ts              # advanceGtid / recoverStuckPrecheckedGtid / finalizeGtidCancelled（reserveH は PAYER 脚のみ）
│   │   │   ├── rtp.ts                      # RTP バレル
│   │   │   └── rtp/                        # RTP 機能分割
│   │   │       ├── register.ts             # RTP 請求作成・支払人通知
│   │   │       ├── respond.ts              # 支払人 accept / decline
│   │   │       └── query.ts                # RTP 参照・期限切れ cron sweep
│   │   │
│   │   ├── finality/                       # FinalityLog の正本性・改ざん検知
│   │   │   ├── finality_chain.ts           # FinalityLog の SHA-256 ハッシュチェーン計算・検証
│   │   │   ├── finality_anchor.ts          # チェーンのアンカー作成・包含検証・参加行副署
│   │   │   ├── watermark.ts                # 照会応答の watermark / watermark_detail（チェーン別の反映位置。TX:/GT:/DNS: キー）
│   │   │   ├── finality_audit.ts           # 全チェーンの断絶検知（日次バッチ＋手動実行）
│   │   │   ├── onchain_finality.ts         # クロスチェーン確定種別分類 + 量子リスク証跡
│   │   │   └── misrecord.ts                # MisrecordCorrected（唯一の超例外・誤記録訂正）
│   │   │
│   │   ├── settlement/                     # ネット/グロス清算（acyclic: cycle → settle → reserve）
│   │   │   ├── dns.ts                      # DNS バレル（下記 dns/ を re-export）
│   │   │   ├── dns/                        # 日次ネット清算（DNS）機能分割
│   │   │   │   ├── reserve.ts              # BOJ 不足額 / 復旧リザーブ算定・RINGFENCED_PLUS
│   │   │   │   ├── settle.ts               # settleDns ネットポジション清算実行
│   │   │   │   ├── cycle.ts                # kick / resume / hold / 日内カットオフ / getOrCreateDnsCycle
│   │   │   │   ├── admission.ts            # checkIgsAdmission ゲート（IgsAdmissionDecision）
│   │   │   │   ├── query.ts                # status / net-position / BOJ-position / hold_detail（閉域）参照
│   │   │   │   └── disclosure.ts           # public_message_id（公式発表テンプレID）と HOLD 時の開示コンテキスト解決
│   │   │   ├── dns_cycle_id.ts             # DNSサイクル識別子 `DNS-{CCY}-YYYYMMDD-NN` の生成・解析
│   │   │   ├── igs.ts                      # 高額送金等のプレファンド制約即時清算（BOJ-Net）
│   │   │   └── igs_hold.ts                 # DNS hold 時の IGS 受入支援（throttle 予算等）
│   │   │
│   │   ├── liquidity/                      # 流動性・限度管理
│   │   │   ├── h_model.ts                  # H-limit（二者間ネット送信上限）予約・解放（reserveH。通貨別 ParticipantCurrencyLimits）
│   │   │   ├── h_unlock.ts                 # H_locked 解放（NoDebitRecordedProof / HUnlockAuthorize）
│   │   │   └── bulk_lsm.ts                 # Bulk/Deferred LSM（流動性節約）最適化
│   │   │
│   │   ├── directory/                      # 名義/エイリアス/受取先の解決
│   │   │   ├── als.ts                      # Mojaloop風 アカウントエイリアス解決(KVキャッシュ)
│   │   │   ├── proxy.ts                    # Proxy（電話番号・メール・マイナ等）解決
│   │   │   ├── pspr.ts                     # Pre-Shared Payment Reference 登録・参照
│   │   │   ├── account_verify.ts           # 事前口座照会・名義確認
│   │   │   └── qr.ts                       # QR コード（動的・静的）の発行ロジック
│   │   │
│   │   ├── richdata/                       # リッチ/構造化データ
│   │   │   ├── edi.ts                      # ZEDI（企業間データ）
│   │   │   ├── richdata.ts                 # リッチデータ（金融コアと商流データの分離）
│   │   │   └── cross_border.ts             # クロスボーダー送金・FATF 勧告対応
│   │   │
│   │   ├── events/                         # イベント追記・配信・通知
│   │   │   ├── trace.ts                    # TxEventLog 追記（状態遷移・銀行呼出・監査証跡）
│   │   │   ├── stream.ts                   # 銀行向け SSE（TX_STATE_CHANGED / CREDIT_RECEIVED / RTP_RECEIVED）
│   │   │   ├── stream_rafiki.ts            # Rafiki風ストリーミング決済 WebSocket/DOバッファ
│   │   │   └── credit_notify.ts            # 受取銀行への入金通知（指数バックオフ再送）
│   │   │
│   │   ├── cases/                          # 例外処理
│   │   │   ├── case.ts                     # CASE（紛争・例外）管理 OPEN→IN_PROGRESS→RESOLVED/ESCALATED
│   │   │   └── reversal.ts                 # Reversal（ファイナリティ後の救済別取引）
│   │   │
│   │   ├── collection/                     # 継続収納（口座振替。specs: 10_requirements.md §3.2.8／20_method_design.md §2.2.7）
│   │   │   ├── mandate.ts                  # DebitMandate（継続収納契約）の登録・上限変更・失効。モードは払出行プロファイルから導出し降格を明示
│   │   │   ├── budget.ts                   # 累計枠の単一行 CAS 予約（窓のロールオーバー同梱・上限は契約から相関副問合せ）
│   │   │   ├── notice.ts                   # 収納予告と事前登録ラダー（費目正規化・凍結後は不利益変更のみ拒否）
│   │   │   ├── execute.ts                  # 振替日の発火・充当順序（辞書式）・試行系列・確定期限の掃引
│   │   │   ├── reauth.ts                   # 追加認可（単発認可。無応答は拒否＝ラダー全体を終了）
│   │   │   └── query.ts                    # 契約単位ビュー（予定を含む）・顧客の許可一覧・勘定系プロファイル公開
│   │   │
│   │   ├── platform/                       # 横断プリミティブ
│   │   │   ├── circuit_breaker.ts          # 参加行ヘルス監視と段階的遮断・再開
│   │   │   ├── system_mode.ts              # ZC全体のBCP縮退モード（NORMAL/BCP_READONLY）
│   │   │   ├── quorum.ts                   # コンセンサスクォーラム健全性と設計原則10の縮退（クォーラム喪失時 read-only）
│   │   │   ├── operating_window.ts         # 参加行の稼働ウィンドウ判定（24/365）
│   │   │   ├── vault.ts                    # 短期機密データ貯蔵（AML 評価・PII・TTL 管理）
│   │   │   ├── purpose.ts                  # 利用目的コード（P01〜P07）と閉域アクセスの実時間遮断・監査
│   │   │   ├── access.ts                   # 照会の認可（要件 S-5/S-7）：主体解決・目的コードゲート・当事者判定・アクセス監査台帳
│   │   │   ├── access_routes.ts            # 当事者スコープの照会経路表と、公開読み取りの明示的な除外一覧
│   │   │   ├── condition_expr.ts           # HTLC ConditionTemplate の AND/OR 合成評価
│   │   │   ├── ledger_predicate.ts         # ZC 自身の確定済み FinalityLog に対して解決する条件（自 ledger 状態の条件評価）
│   │   │   └── metrics.ts                  # 権威状態から算出する運用オブザーバビリティ（collectOperationalMetrics）
│   │   │
│   │   ├── query/                          # 参照・説明可能性
│   │   │   ├── query.ts                    # Transaction 参照 API（Appendix E.6 QueryResponse）
│   │   │   ├── explain.ts                  # GET /api/transactions/:txid/explain（理由付き timeline + 改ざん検知）
│   │   │   ├── story.ts                    # GET /api/transactions/:txid/story（ナラティブ + Mermaid + 健全性）
│   │   │   └── simulate.ts                 # プログラマビリティ・プリミティブの読み取り専用ドライラン（condition_expr / mandate を副作用なしで評価）
│   │   │
│   │   ├── fx/                             # クロスカレンシー FX（specs: 20_method_design.md／30_internal_design.md の FX 章）
│   │   │   ├── rates.ts                    # 整数固定小数レート演算（RATE_SCALE=1e8、BigInt、forward=floor/backward=ceil、composeRates）
│   │   │   ├── quotes.ts                   # FxQuotes マーケットプレイス（upsert / 取下げ / 期限内一覧）
│   │   │   ├── routing.ts                  # 最良経路エンジン（直接＋単一中間通貨ブリッジ、payer/payee 建て、findBestRoute）
│   │   │   ├── transfer.ts                 # FXP 導管 GTID 構築・initiateFxTransfer（経路→脚・見積生存確認・FxTransfers 記録）
│   │   │   ├── htlc.ts                     # FX 専用 HTLC（lock/claim/refund・FxLegLocks・段階タイムロック・sweepExpiredFxLocks）
│   │   │   └── api.ts                      # FX HTTP ハンドラ（rates / quote / transfers / claim / refund / status）
│   │   └── rtp.ts                          # 互換バレル（lanes/rtp を re-export）
│   │
│   └── bank/                               # モックにおける参加銀行側のAPIとロジック処理
│       ├── ingress.ts                      # 銀行側受信のディスパッチャ（/bank/*。下記 ingress/ のハンドラへ振り分け + HMAC 検証）
│       ├── ingress/                        # ZC→Bank コマンドハンドラの機能分割
│       │   ├── _shared.ts                  # auditLog / checkIdempotency / saveResponse 共通ヘルパ
│       │   ├── reserve.ts                  # reserve-funds / release-reserve / leg-ready-check
│       │   ├── execute.ts                  # execute-debit / execute-credit / debit-settled
│       │   ├── verify.ts                   # authority-check / name-check / account-verify
│       │   ├── notify.ts                   # credit-notify / rtp-notify
│       │   └── admin.ts                    # initialize-bank / cleanup-bank
│       ├── teller_api.ts                   # ZC からの口座状態・残高照会等（テラー用）
│       ├── customer_api.ts                 # エンドユーザー（バンキングアプリ等）向け API
│       ├── ledger.ts                       # モック銀行の残高計算・ゼロサム複式仕訳コア（amount_currency）
│       ├── suspense.ts                     # リザーブおよび別段預金等の中間口座処理
│       ├── filter.ts                       # AML/制裁リスト等の仮フィルタリング実装
│       └── legacy/                         # レガシー勘定系（勘定系）連携のモックとアダプタ
│           ├── legacy_core.ts              # 意図的に敵対的なレガシー勘定系モック（バッチ・非冪等・予約不可等の非親和性を再現）
│           ├── adapter.ts                  # 対外接続系アダプタ（13コマンドを能力プロファイルで翻訳、6つのレガシー親和策）
│           └── reconcile.ts                # 三方向レコンサイル（core vs shadow vs outbox。ドリフトを CASE に収束）
│
├── test/               # vitest テスト群（in-memory SQLite で src/ と並走する統合テスト）
│   ├── helpers/
│   │   └── d1-mock.ts                      # MockD1Database ファクトリ（better-sqlite3 + SCHEMA_MIGRATIONS）
│   ├── shared/                             # shared/ 層の単体テスト
│   │   ├── errors.test.ts                  # DomainError / errorResponse / カテゴリ写像
│   │   ├── logger.test.ts                  # 構造化ログ shape / PII redaction / child baggage
│   │   ├── hmac.test.ts                    # HMAC-SHA256 検証
│   │   ├── secret_rotation.test.ts         # 共有 HMAC 重複窓が期限で閉じること（期限なしの旧鍵は無効）
│   │   ├── validator.test.ts               # ZC ingress payload バリデータ
│   │   ├── fatf_validator.test.ts          # FATF R.16 検証
│   │   ├── external_signature.test.ts      # 外部署名検証（ECDSA P-256/Ed25519・KeyRegistry・リプレイ防止）
│   │   ├── zc_signature.test.ts            # ZC 自身の非対称送信署名
│   │   ├── attestation.test.ts             # ConditionTemplate whitelist / Attestation 検証・鮮度
│   │   ├── operator_quorum.test.ts         # n-of-m クォーラム・equivocation ポリシー
│   │   ├── mandate.test.ts                 # 委任チェーンの登録・検証
│   │   ├── watcher.test.ts                 # WatcherObservation 記録・冪等性
│   │   ├── central_bank.test.ts            # 中銀決済レジストリ / CBT 口座モデル
│   │   ├── entity_state_log.test.ts        # EntityStateLog 追記
│   │   └── proof.test.ts                   # BankProofRef/SettlementProofRef 生成・信頼検証
│   ├── bank/
│   │   ├── ledger.test.ts                  # 複式仕訳ゼロサム不変条件
│   │   ├── currency_dimension.test.ts      # 通貨次元（多通貨元帳）不変条件
│   │   ├── customer_api.test.ts            # 顧客向けバンキング API
│   │   ├── custody_auto_release.test.ts    # 別段預金の自動解放（凍結/閉鎖/不明口座宛着金）
│   │   └── legacy/
│   │       └── adversarial.test.ts         # レガシーアダプタ vs 敵対的 legacy_core
│   ├── cron/
│   │   ├── auth_timeout.test.ts            # T_auth: Authority Check の応答待ちを PRECHECKED_SUSPENDED へ（判定不能で通さない）
│   │   ├── pending_since.test.ts           # 期限は付随的な書込み（CASE 起票・EDI 連携）で先送りされない
│   │   ├── precheck_timeout.test.ts        # T_precheck: RECEIVED のまま滞留した取引の掃引
│   │   └── timeout_sweep.test.ts           # タイムアウト掃引（停滞・HTLC・GTID・FX ロック）
│   ├── integration/                        # レーン横断統合テスト
│   │   ├── balance_invariants.test.ts      # 各レーン仕訳ゼロサム + 顧客口座 Δ 確認（GTID 2×2 逆順含む）
│   │   ├── idempotency_replay.test.ts      # 同一 idempotency_key 再送で 1 行のみ
│   │   ├── queue_retry_policy.test.ts      # DomainError category × msg.retry()/ack() 写像
│   │   ├── ingress_commands.test.ts        # ZC→Bank 13 コマンドの往復（呼び手が組んだ電文→実物の受け手→呼び手のマッピング）
│   │   ├── htlc_recheck_unavailable.test.ts # AML 再照会が判定不能なら claim を拒否（決済せず・状態も変えず・証跡は残す）
│   │   ├── htlc_cancel_balance.test.ts     # TIMELOCK_EXPIRED / 直接 cancel で payer suspense が戻ること
│   │   ├── concurrent_races.test.ts        # await 境界のインターリーブ（FX claim 対 refund/sweep 等の相互排他）
│   │   ├── cosign_enforcement.test.ts      # 副署強制
│   │   ├── cosign_router.test.ts           # 副署ルーティング
│   │   ├── zc_egress_signing.test.ts       # ZC 送信署名の E2E
│   │   ├── fx_settlement.test.ts           # FX 実顧客残高での E2E（SETTLED 連動）
│   │   ├── portability_conformance.test.ts # ポータビリティ適合性
│   │   ├── simulate_endpoints.test.ts      # /simulate 系エンドポイント
│   │   ├── chaos_adversarial.test.ts       # 敵対的カオス
│   │   ├── chaos_cross_chain.test.ts       # クロスチェーン・カオス
│   │   ├── chaos_delivery.test.ts          # 配信/再送カオス
│   │   ├── chaos_dns.test.ts               # DNS カオス
│   │   ├── chaos_eod.test.ts               # EOD カオス
│   │   ├── chaos_fx.test.ts                # FX 敵対的シナリオ8種（部分/二重決済なし）
│   │   ├── chaos_gtid.test.ts              # GTID カオス（多通貨脚含む）
│   │   ├── chaos_nasty.test.ts             # 複合悪条件カオス
│   │   └── chaos_reversal.test.ts          # Reversal カオス
│   ├── invariants/                         # 静的/構造不変条件テスト
│   │   ├── ownership.test.ts               # モジュール所有境界
│   │   ├── pending_since.test.ts           # タイマが「無関係な書込みで動く列」を読まないことの静的固定
│   │   ├── worker_bindings.test.ts         # Env の資源バインドが wrangler.toml.example に宣言されているか
│   │   ├── api_auth.test.ts                # /api/* は資格情報でのみ通す（Origin 欠落を同一オリジンと見なさない）
│   │   ├── foreign_keys.test.ts            # 外部キー整合
│   │   ├── finality_coverage.test.ts       # FinalityLog カバレッジ
│   │   ├── ingress_seam.test.ts            # ZC→Bank ingress 接合部の構造検査（電文型の単一宣言・レジストリと dispatch の一致）
│   │   ├── case_dedup.test.ts              # CASE 重複起票の判定（未解決＝OPEN/IN_PROGRESS/ESCALATED）が一箇所に閉じているか
│   │   ├── query_access.test.ts            # 照会の認可（要件 S-5/S-7）：目的コード遮断・当事者判定・監査台帳・未分類の読み取り経路の検出
│   │   ├── schema_doc_drift.test.ts        # スキーマ ↔ ドキュメントのドリフト検知
│   │   ├── spec_refs.test.ts               # docs/specs/ のドリフトガード（節参照の解決・リンク・値域↔型定義・PR-* 台帳・reason_code カタログ↔REASON_CODE_CATEGORY・cmd/event↔監査語彙の突合・file_structure ↔ ツリー）
│   │   ├── dashboard_secret_guard.test.ts  # ダッシュボードのシークレット露出防止
│   │   └── dashboard_ui_hardening.test.ts  # ダッシュボード UI ハードニング
│   └── zc/                                 # ZC レーン・横断プリミティブ
│       ├── lane_invariants.test.ts         # 静的解析：helper 回避の生 SQL / FinalityEventType 未登録 / テスト漏れを検出
│       ├── lane_helpers.test.ts            # transitionWithLog / cancelInFlightTx / insertTxWithLog の並列・TOCTOU
│       ├── atomic_finality.test.ts         # CAS + FinalityLog の atomic batch / event_seq 単調性
│       ├── ingress_handlers.test.ts        # Ingress ハンドラ群
│       ├── orchestrator.test.ts            # キューハンドラディスパッチ
│       ├── finality_chain.test.ts          # SHA-256 ハッシュチェーン検証
│       ├── finality_anchor.test.ts         # アンカー作成・包含検証・参加行副署
│       ├── finality_audit.test.ts          # FinalityLog 全チェーンの断絶検知バッチ
│       ├── finality_cosign_extension.test.ts # ファイナリティ副署拡張
│       ├── onchain_finality.test.ts        # クロスチェーン確定種別分類 + 量子リスク
│       ├── misrecord.test.ts               # MisrecordCorrected 誤記録訂正
│       ├── express.test.ts                 # EXPRESS レーン
│       ├── standard.test.ts                # STANDARD レーン
│       ├── highvalue.test.ts               # HIGH_VALUE レーン
│       ├── hv_threshold_escalation.test.ts # HIGH_VALUE 自動エスカレーション閾値（PR-HV-THRESHOLD の解決順位）
│       ├── bulk.test.ts                    # BULK レーン
│       ├── bulk_lsm.test.ts                # Bulk/Deferred LSM
│       ├── rtp.test.ts                     # RTP レーン
│       ├── gtid.test.ts                    # GTID レーン
│       ├── gtid_leg_provenance.test.ts     # 受付時の脚正規化が書き換えた leg_id の由来（origin_leg_id）
│       ├── igs_settlement_status.test.ts   # 照会応答が中銀決済の HOLD と不成立を区別する（external_settlement）
│       ├── gtid_state_machine.test.ts      # GtidState 遷移バリデータ
│       ├── htlc.test.ts                    # HTLC レーン
│       ├── htlc_conditions.test.ts         # HTLC ConditionTemplate 条件
│       ├── htlc_programmability.test.ts    # HTLC プログラマビリティ
│       ├── htlc_cross_chain.test.ts        # クロスチェーンHTLC（HTLC_ONCHAIN_PENDING）
│       ├── htlc_crosschain_quorum.test.ts  # クロスチェーンHTLC のクォーラム
│       ├── htlc_attestation_claim.test.ts  # アテステーションによるHTLC fulfillment
│       ├── htlc_auth_canonical.test.ts     # HTLC-Auth 正準フロー
│       ├── htlc_auth_regression.test.ts    # HTLC-Auth リグレッション
│       ├── htlc_auth_benefit.test.ts       # 給付行政（対象者該当性アテステーション・使途制限）
│       ├── mandate_precheck.test.ts        # EXPRESS/STANDARD の Mandate プレチェック
│       ├── collection_budget.test.ts      # 累計枠の単一行 CAS（並行競合・暦月境界・消尽型と リセット型の分離・上限変更が消費を洗浄しないこと）
│       ├── collection_lifecycle.test.ts   # 予告・ラダー排他・確定の非対称性（期限前の不足は失敗ではない）・充当順序・凍結の非対称性・無応答は拒否
│       ├── h_model.test.ts                 # H 予約
│       ├── h_unlock.test.ts                # H_locked 解放（NoDebitRecordedProof / HUnlockAuthorize）
│       ├── multi_currency.test.ts          # マルチ通貨 H-Model / PvP（異通貨GTID）
│       ├── dns.test.ts                     # DNS サイクル
│       ├── dns_intraday.test.ts            # DNS 日内カットオフ
│       ├── dns_cycle_id.test.ts            # DNSサイクル識別子 `DNS-{CCY}-YYYYMMDD-NN` の生成・解析
│       ├── igs_hold.test.ts                # DNS hold 時の IGS 受入
│       ├── fx_rates.test.ts                # FX レート演算（floor/ceil/compose）
│       ├── fx_routing.test.ts              # FX 最良経路（直接/ブリッジ・数値検証）
│       ├── fx_transfer.test.ts             # FX 導管 GTID 構築・initiate
│       ├── fx_htlc.test.ts                 # FX HTLC（lock/claim/refund・誤secret・冪等・sweep）
│       ├── fx_api.test.ts                  # FX HTTP API
│       ├── ledger_predicate.test.ts        # 自 ledger 条件評価
│       ├── circuit_breaker.test.ts         # CLOSED/OPEN/HALF_OPEN 遷移 + metrics + Adapter 不通の別値化
│       ├── case_sla.test.ts                # CASE 期限と Auto-Progress→Manual-Only 昇格
│       ├── case_aggregation.test.ts        # CASE 集約（1原因1件）と二次エスカレーション
│       ├── quorum.test.ts                  # コンセンサスクォーラム健全性・縮退
│       ├── metrics.test.ts                 # 運用メトリクス収集
│       ├── system_mode.test.ts             # BCP縮退モード（NORMAL/BCP_READONLY）
│       ├── operating_window.test.ts        # 参加行の稼働ウィンドウ判定
│       ├── express_operating_window.test.ts # 相手行ウィンドウ待ち（PRECHECKED_SUSPENDED）と再開
│       ├── daily_limit.test.ts             # 参加行 daily_amount_limit のリセット
│       ├── reversal.test.ts                # Reversal 起票・APPROVAL_REQUIRED ガード
│       ├── reversal_gate.test.ts           # Reversal 三層ゲート第1層（CREDIT_FAILED_PROOF）と口座都合の排除
│       ├── dns_hold_detail.test.ts         # DNS_HOLD 閉域照会の認可（全拒否が404）・目的コード遮断・public_message_id
│       ├── query_freshness.test.ts         # freshness_level が測るのは Read Model の遅れ（取引の古さではない）
│       ├── query_watermark_detail.test.ts  # watermark_detail が読み取り元チェーンを漏れなく列挙（GT/DNS 集約の再現性）
│       ├── account_verify.test.ts          # 事前口座照会・名義確認
│       ├── directory_als_proxy.test.ts     # ALS / Proxy 解決
│       ├── qr.test.ts                      # QR 発行
│       ├── richdata_edi.test.ts            # リッチデータ / ZEDI
│       ├── cross_border.test.ts            # クロスボーダー・FATF R.16
│       ├── explain.test.ts                 # /explain timeline + 改ざん検知
│       ├── story.test.ts                   # /story narrative + health verdict
│       └── stream_rafiki.test.ts           # Rafiki風ストリーミング決済
│
├── README.md                               # リポジトリ概要
├── test.json                               # ローカル動作確認用の試験ペイロード
├── package.json                            # Node.js 依存関係定義（wrangler, vitest, better-sqlite3 等。Web フレームワークは使わず素の Workers fetch ハンドラ）
├── package-lock.json                       # 依存関係のロックファイル
├── biome.json                              # Biome（lint / format）設定
├── tsconfig.json                           # TypeScript コンパイル設定
├── tsconfig.test.json                      # テスト用 TypeScript 設定
├── vitest.config.ts                        # vitest 設定
└── wrangler.toml.example                   # Cloudflare Workers のデプロイ・バインディング定義のひな型（D1, Queue, R2, Cron 等）。実ファイル wrangler.toml は Git 管理外
```

## システムの動作について

- **エントリーポイント**: `src/index.ts` は default の `fetch`/`queue`/`scheduled`・CORS・ダッシュボードの静的配信・Durable Object の re-export を担います。HTTP パスごとのルーティング（`/api/*`・`/bank/*`・`/internal/*`）は `src/router/` の各ルータ（`handleZcApi`/`handleBankApi`/`handleInternal`）へ委譲します。すべての応答には `X-Request-Id` が採番されます。
- **データベース**: Cloudflare D1 (SQLite) を利用し、`migrations/` のスキーマを適用して初期化とスキーマ維持を行います。スキーマは統合済みの `0001_consolidated_schema.sql` 1 本に集約されており、これが唯一の正です。スキーマ変更はこのファイルを直接編集し、新しい連番ファイルは作りません。`test/helpers/d1-mock.ts#SCHEMA_MIGRATIONS` はこの 1 本を毎回新規適用します。FX 関連の 3 テーブル（`FxQuotes` / `FxTransfers` / `FxLegLocks`）もこの 1 ファイル内で定義されています。
- **ドメイン分割**: ZC（中央基盤）のコアは `src/zc/` に、参加銀行のモックは `src/bank/`（レガシー勘定系連携は `src/bank/legacy/`）に分かれます。両者から呼ばれる純粋ユーティリティは `src/shared/` に集約しています。レーンによる `Transactions` 更新は必ず `src/zc/lanes/_helpers.ts`（`transitionWithLog` / `cancelInFlightTx` / `insertTxWithLog`）を経由します。生の `UPDATE`/`INSERT` は `test/zc/lane_invariants.test.ts` が静的に禁止しています。
- **非同期処理**: Queue consumer（`src/zc/orchestrator.ts` とその配下の `orchestrator/`）が状態遷移の実行役となります。`src/cron/` は EOD 清算とタイムアウト掃引（HTLC/GTID/FX ロック含む）を担当します。
- **型定義の単一化**: 型はすべて `src/types.ts` から公開され、実体は `src/types/` 配下に分割されています。プリミティブ（`primitives.ts`）とステートユニオン（`states.ts`）は単一ファイルに、HTTP 入出力型は `src/types/api/` に、D1 行型は `src/types/rows/` に、それぞれドメイン別サブモジュール（各 `index.ts` バレル）として置かれます。利用側は常に `src/types.ts` からのみインポートします。
- **横断プリミティブ**: `src/zc/platform/` はサーキットブレーカ・BCP システムモード・コンセンサスクォーラム縮退（`quorum.ts`、設計原則10）・稼働ウィンドウ・条件式評価・自 ledger 条件（`ledger_predicate.ts`）・運用メトリクス（`metrics.ts`）など、レーン横断のプリミティブをまとめて収めます。信頼最小化のためのクォーラム/equivocation 検査は `src/shared/operator_quorum.ts`・`attestation_quorum.ts` に共通化されています。
- **クロスカレンシー FX**: `src/zc/fx/`（レート演算・見積市場・最良経路・FXP 導管 GTID・任意の HTLC 束ね）が `docs/specs/20_method_design.md`（FX処理方式）・`docs/specs/30_internal_design.md`（FX内部設計）を実装します。通貨別の中銀ファイナリティは `src/shared/central_bank.ts`（トークン化中銀預金 CBT）に接地します。
- **フロントエンドダッシュボード**: `src/dashboard/`（運用UI: index / console / bank-app）と `src/exploratory/ui/`（表現レイヤー: theater / sky）内の HTML ファイルは、Alpine.js と Tailwind CSS で書かれた SPA 的なフロント実装です。Worker が `Response(htmlString)` として静的に配信します。表現レイヤー（`src/exploratory/`）は決済コアの正しさに関与しない実験的なコードとして分離してあります。
- **テスト**: `test/` は `src/` のディレクトリ構成をおおよそミラーしています（`shared/`・`bank/`（`legacy/` 含む）・`cron/`・`integration/`・`invariants/`・`zc/`）。`test/helpers/d1-mock.ts` が提供する in-memory SQLite（better-sqlite3）を用いた統合テストとして動作します。`integration/chaos_*` は敵対的シナリオを、`invariants/` は静的・構造不変条件（外部キー・所有境界・スキーマ↔ドキュメントのドリフト等）を固定します。

---

## English

> **Note**: This section is the merged content of the former `file_structure.en.md` (now deleted). It is the English-language counterpart of the Japanese sections above and describes the same tree. The specs are organised **by depth**: the three core books are Requirements (`10_`) → Method design (`20_`) → Internal design (`30_`), with table definitions and API contracts as their reference annexes (`31_`, `32_`) and the narrative walkthrough as an annex to the requirements book (`11_`). The former standalone files (`zenith_public.md`, `zenith_policy.md`, `architecture.md`, `fx.md`, `legacy_adapter.md`, `schema.md`, `api-contracts.md`, `walkthrough.md`) were all folded into this scheme and no longer exist. Cross-currency FX and the legacy core-banking adapter are not separate files: each is carried as chapters across the three depth books (requirements = `10_`, method = `20_`, internal = `30_`), and a "feature index" at the top of those chapters lets you follow one feature end to end.

# Repository File Structure (English)

This document describes the directory layout and responsibilities within the Zenith Payment System mock implementation. The project comprises a TypeScript backend built on Cloudflare Workers, D1 (SQLite), Queues, and R2, alongside a frontend crafted with Alpine.js and Tailwind CSS.

### Directory & File Overview

```text
/
├── .wrangler/          # (Auto-generated) Local Wrangler environment data, including local D1 database files
│
├── migrations/         # Database schema migrations for D1 SQLite
│   └── 0001_consolidated_schema.sql        # Consolidated schema (single source of truth): former 0001–0042 squashed into final-shape table definitions, indexes, and seed data. Schema changes edit this one file directly
│
├── docs/                # Documentation (specs + defensive-publication disclosure)
│   ├── specs/                               # Specifications & design docs (organised by depth: requirements → method design → internal design)
│   │   ├── 10_requirements.md              # [Requirements] purpose, business scope, actors, institutional/governance & regulatory & non-functional requirements (incl. FX/adapter requirements)
│   │   ├── 11_walkthrough.md               # └ Annex to requirements: end-to-end walkthrough of the main flows (narrative, bilingual)
│   │   ├── 20_method_design.md             # [Method/Basic design] architecture, business flows, state machines, consistency/finality, operations/resilience, migration, testing (incl. FX/adapter method design)
│   │   ├── 30_internal_design.md           # [Internal/Detailed design] implementation conventions, single-owner rule, portability contract, I/F contracts, message defs, algorithm detail (incl. FX/adapter internal design)
│   │   ├── 31_schema.md                    # └ Annex to internal design: detailed DB table schema & relations (SoT for table definitions)
│   │   ├── 32_api_contracts.md             # └ Annex to internal design: API contracts, JSON schemas, error catalog
│   │   └── file_structure.md               # Directory layout (this bilingual file; the former en.md is this English section)
│   └── disclosure/                         # Defensive publication (CC0; versioned, older versions are never deleted)
│       ├── CORE_DISCLOSURE.md             # The application itself and nothing else (Japanese filing form): specification, claims, abstract, drawings
│       └── US_APPLICATION.md              # US-practice counterpart draft (not a verbatim translation of CORE_DISCLOSURE.md)
│
├── src/                # Source code (plain Cloudflare Workers fetch handler — no web framework)
│   ├── index.ts                            # Worker entry point (default fetch/queue/scheduled, CORS, static serving, DO re-exports). HTTP path routers live in router/
│   ├── html.d.ts                           # Type declaration for importing .html as strings
│   ├── types.ts                            # Single barrel export of all type definitions (re-exports types/*)
│   │
│   ├── router/                             # HTTP path routers (extracted from index.ts)
│   │   ├── zc.ts                           # /api/* router (handleZcApi; includes FX routes)
│   │   ├── bank.ts                         # /bank/:id/* router (handleBankApi)
│   │   └── internal.ts                     # /internal/* router (seed, cron, DNS management)
│   │
│   ├── types/                              # Type definition modules (always import via src/types.ts)
│   │   ├── primitives.ts                   # Env, Amount, BankProofRef, FATF data types
│   │   ├── states.ts                       # State string unions (TxState, HtlcState, GtidState, DnsState)
│   │   ├── api/                            # HTTP I/O + Queue message types, split by domain (index.ts barrel + bank-ingress / transfers / htlc / directory / customer / filter / richdata / iso20022 / messaging)
│   │   └── rows/                           # D1 row types, split by domain (index.ts barrel + core / lanes / settlement / finality / events / directory / richdata / cases / security / bank)
│   │
│   ├── shared/                             # Cross-cutting utilities used by both ZC and Bank
│   │   ├── constants.ts                    # System constants & default thresholds
│   │   ├── errors.ts                       # DomainError / errorResponse / reason_code→category map (SoT for HTTP & retry)
│   │   ├── logger.ts                       # newRequestLogger (1 JSON line/event, X-Request-Id, PII auto-redaction)
│   │   ├── hmac.ts                         # HMAC-SHA256 signing & verification (Web Crypto)
│   │   ├── secret_rotation.ts              # Bounded rotation window for the shared HMAC secret (sign with current only; verify accepts the retiring key until its deadline)
│   │   ├── api_auth.ts                     # /api/* perimeter decision (credential only; the keyless path is an explicit ZC_ALLOW_UNAUTHENTICATED_UI opt-in)
│   │   ├── idempotency.ts                  # Idempotency-Key control (acquire / resolve / complete)
│   │   ├── iso20022.ts                     # ISO 20022 pacs.008 generation (FATF R.16 cross-border)
│   │   ├── routing.ts                      # Routing & BIC/bank_id mapping
│   │   ├── fatf_validator.ts               # FATF R.16 (travel rule) compliance validation
│   │   ├── proof.ts                        # BankProofRef/SettlementProofRef generation & trust verification
│   │   ├── request-id.ts                   # Deterministic request ID generation
│   │   ├── validator.ts                    # ZC Ingress API payload schema validation (VALID_CURRENCIES)
│   │   ├── external_signature.ts           # External-signer verification (ECDSA P-256/Ed25519, KeyRegistry)
│   │   ├── zc_signature.ts                 # ZC's OWN egress signing (asymmetric; participants verify ZC's public key in KeyRegistry; replaces the shared-HMAC scheme)
│   │   ├── attestation.ts                  # Signed "condition met" statement recording & freshness check (ConditionTemplate/Attestation)
│   │   ├── attestation_quorum.ts           # k-of-n quorum & equivocation check for ConditionTemplate Attestations (mirrors the Watcher trust-minimization)
│   │   ├── operator_quorum.ts              # Table-agnostic n-of-m quorum & equivocation policy (counts distinct operators, not keys)
│   │   ├── mandate.ts                      # Mandate (delegation chain) registration & validation
│   │   ├── watcher.ts                      # External-rail finality event recording (WatcherObservation)
│   │   ├── central_bank.ts                 # Central-bank settlement registry + tokenized central-bank-deposit (CBT) account model (per-currency finality, settlementAccountId)
│   │   └── entity_state_log.ts             # EntityStateLog (non-Transaction entity state history) append
│   │
│   ├── cron/                               # Batch jobs triggered by Cron
│   │   ├── eod.ts                          # EOD 8-step process (DNS kick/settle, interest accrual, balance snapshot, daily limit reset)
│   │   └── timeout_sweep.ts                # 1-minute sweep for stalled TXs, HTLC timelock expiry, GTID/RTP expiry, htlc-auth capture timeout, expired FX locks (sweepExpiredFxLocks, step 16)
│   │
│   ├── dashboard/                          # Operational frontend (static HTML served via Worker fetch)
│   │   ├── index.html                      # ZC operating status & main dashboard (/, /dashboard)
│   │   ├── console.html                    # Bank & operations console (/console)
│   │   └── bank-app.html                   # End-user banking app mock (/bank-app)
│   │
│   ├── exploratory/                        # Expressive layer (separate from operational features; no bearing on settlement)
│   │   └── ui/                             # Static HTML for the expressive layer
│   │       ├── theater.html                # Settlement Theater — animated state transitions (/theater, /theatre)
│   │       └── sky.html                    # Sky mode — system overview (/sky)
│   │
│   ├── openapi/                            # OpenAPI schemas
│   │   ├── zc-api.ts                       # ZC Core API schema (includes the fx tag)
│   │   └── bank-api.ts                     # Bank mock API schema
│   │
│   ├── zc/                                 # Zenith Coordinator core domain logic
│   │   │                                   #   Domain modules are grouped into purpose-named subfolders.
│   │   │                                   #   Large modules use a thin barrel + same-named subfolder (mirrors the existing htlc_auth/ and rtp/ split).
│   │   ├── ingress.ts                      # ZC ingress API barrel (re-exports ingress/; /api/*, /internal/*)
│   │   ├── ingress/                        # Ingress handlers split by domain
│   │   │   ├── _shared.ts                  # json / jsonError response helpers
│   │   │   ├── transfers.ts                # transfers / gtid / rtp / authorize / cancel / resume
│   │   │   ├── htlc.ts                     # HTLC create / claim / attest / conditions / cross-chain
│   │   │   ├── htlc_auth.ts                # HTLC-Auth request / approve / capture / void / whitelist
│   │   │   ├── collection.ts               # continuous collection: contract / notice / ladder / additional auth / views
│   │   │   ├── admin.ts                    # bank/participant management + seed data
│   │   │   └── sim.ts                      # large-scale simulator setup (20 banks × 200 accounts)
│   │   ├── orchestrator.ts                 # Queue consumer body (processQueueMessage dispatches to orchestrator/*; ZC_BANK_LEG_READY → advanceGtid)
│   │   ├── orchestrator/                   # Async worker subsystems
│   │   │   ├── state_machine.ts            # ALLOWED_TRANSITIONS / isValidTransition (single source of truth for every TxState edge)
│   │   │   ├── gtid_state_machine.ts       # GtidState transition validator (GTID-level graph SoT; symmetric to state_machine.ts)
│   │   │   ├── finality.ts                 # FinalityLog append, finalizeCancelledTx, suspendTx, atomic CAS+log batch primitives
│   │   │   ├── bank_hub.ts                 # ZC→Bank call hub (Circuit Breaker gated)
│   │   │   └── gtid.ts                     # GTID multi-leg finalization (checkAndFinalizeGtid updates FxTransfers.status)
│   │   │
│   │   ├── lanes/                          # Individual lane state machines
│   │   │   ├── _helpers.ts                 # transitionWithLog / cancelInFlightTx / insertTxWithLog — CAS+FinalityLog atomic batch primitives
│   │   │   ├── _mandate_precheck.ts        # Shared mandate (delegated-authority) precheck (mandatePrecheckOrSuspend). Used by EXPRESS/STANDARD/HIGH_VALUE/BULK
│   │   │   ├── _authority_check.ts         # Shared AML/sanctions Authority Check step. A non-verdict parks the tx in PRECHECKED and starts T_auth (fail-closed)
│   │   │   ├── _reserve_funds.ts           # Shared H-reserve → H_RESERVED → bank reserve-funds (3-step liquidity commit; EXPRESS/STANDARD)
│   │   │   ├── _decide_and_enqueue.ts      # Shared H_RESERVED → DECIDED_TO_SETTLE commit (mint proof refs, attach DNS cycle, H→LOCKED, enqueue ZC_BANK_DEBIT)
│   │   │   ├── express.ts                  # Fast-track retail settlements (synchronous Decision)
│   │   │   ├── standard.ts                 # Name-check + authorization-driven P2P transfers
│   │   │   ├── bulk.ts                     # Bulk batch processing (LSM optimiser; lexicographic objective)
│   │   │   ├── highvalue.ts                # High-value via BOJ RTGS (H-reserve skipped)
│   │   │   ├── htlc.ts                     # HTLC lane barrel (re-exports htlc/)
│   │   │   ├── htlc/                       # Hash-time-locked conditional settlements, split
│   │   │   │   ├── create.ts               # createHtlc / lockHtlc (RECEIVED → HTLC_LOCKED)
│   │   │   │   ├── claim.ts                # claimHtlc / claimHtlcByAttestation / claimHtlcByConditions
│   │   │   │   ├── crosschain.ts           # recordCrossChainLock / recordOnchainFulfillment (Theme A)
│   │   │   │   ├── cancel.ts               # cancelHtlc (shared by all phases)
│   │   │   │   └── _fulfill.ts             # settleAfterPreimage core (HtlcFulfillResult)
│   │   │   ├── htlc_auth.ts                # HTLC Auth barrel (payee-initiated auth/capture/void)
│   │   │   ├── htlc_auth/                  # HTLC Auth split into modules
│   │   │   │   ├── whitelist.ts            # Merchant whitelist (register / revoke / list)
│   │   │   │   ├── request.ts              # Payee auth request + payer decline
│   │   │   │   ├── approve.ts              # Payer approval (preimage gen + canonical RECEIVED → HTLC_LOCKED)
│   │   │   │   ├── capture.ts              # Payee capture + void
│   │   │   │   └── query.ts                # Auth list / get
│   │   │   ├── gtid.ts                     # GTID lane barrel (re-exports gtid/)
│   │   │   ├── gtid/                       # GTID multi-leg atomic settlement, split
│   │   │   │   ├── legs.ts                 # pure leg normalization (fan-out / fan-in / general N×M → 1:1)
│   │   │   │   ├── register.ts             # registerGtid (GT_RECEIVED + LEG_REGISTERED)
│   │   │   │   └── advance.ts              # advanceGtid / recoverStuckPrecheckedGtid / finalizeGtidCancelled (reserveH applies to PAYER legs only)
│   │   │   ├── rtp.ts                      # RTP barrel
│   │   │   └── rtp/                        # RTP split into modules
│   │   │       ├── register.ts             # RTP request creation, payer notification
│   │   │       ├── respond.ts              # Payer accept / decline
│   │   │       └── query.ts                # RTP query + expiry cron sweep
│   │   │
│   │   ├── finality/                       # FinalityLog integrity / tamper-evidence
│   │   │   ├── finality_chain.ts           # SHA-256 hash chain computation & verification
│   │   │   ├── finality_anchor.ts          # chain anchoring, inclusion verification, participant co-signing
│   │   │   ├── watermark.ts                # query-response watermark / watermark_detail (per-chain log positions; TX:/GT:/DNS: keys)
│   │   │   ├── finality_audit.ts           # scheduled chain-break detection (daily batch + manual run)
│   │   │   ├── onchain_finality.ts         # cross-chain finality classification + quantum-risk metadata
│   │   │   └── misrecord.ts                # MisrecordCorrected (the sole super-exception record correction)
│   │   │
│   │   ├── settlement/                     # Net / gross settlement (acyclic: cycle → settle → reserve)
│   │   │   ├── dns.ts                      # DNS barrel (re-exports dns/)
│   │   │   ├── dns/                        # Daily Net Settlement, split
│   │   │   │   ├── reserve.ts              # BOJ shortfall / recovery-reserve math, RINGFENCED_PLUS
│   │   │   │   ├── settle.ts               # settleDns net-position settlement run
│   │   │   │   ├── cycle.ts                # kick / resume / hold / intraday-cutoff / getOrCreateDnsCycle
│   │   │   │   ├── admission.ts            # checkIgsAdmission gate (IgsAdmissionDecision)
│   │   │   │   ├── query.ts                # read-only status / net-position / BOJ-position / closed-domain hold_detail
│   │   │   │   └── disclosure.ts           # public_message_id template ids + hold disclosure resolution
│   │   │   ├── dns_cycle_id.ts             # Canonical DNS cycle identifier `DNS-{CCY}-YYYYMMDD-NN`
│   │   │   ├── igs.ts                      # IGS (immediate gross settlement, BOJ-RTGS adapter)
│   │   │   └── igs_hold.ts                 # IGS admission support during a DNS hold (throttle budget, etc.)
│   │   │
│   │   ├── liquidity/                      # Liquidity & limit control
│   │   │   ├── h_model.ts                  # H-limit reservation (reserveH; per-currency ParticipantCurrencyLimits)
│   │   │   ├── h_unlock.ts                 # H_locked release (NoDebitRecordedProof / HUnlockAuthorize)
│   │   │   └── bulk_lsm.ts                 # Bulk/Deferred LSM (liquidity-saving) optimiser
│   │   │
│   │   ├── directory/                      # Identity / alias / payee resolution
│   │   │   ├── als.ts                      # Mojaloop-style account alias resolution (KV cache)
│   │   │   ├── proxy.ts                    # Proxy directory (phone / email / corporate ID alias resolution)
│   │   │   ├── pspr.ts                     # Pre-Shared Payment Reference (Express addressing)
│   │   │   ├── account_verify.ts           # Pre-settlement account verification (single + batch)
│   │   │   └── qr.ts                       # QR code issuance (static/dynamic + HMAC validation)
│   │   │
│   │   ├── richdata/                       # Rich / structured data
│   │   │   ├── edi.ts                      # ZEDI-style EDI rich-data storage
│   │   │   ├── richdata.ts                 # Rich data store (commercial metadata decoupled from financial core)
│   │   │   └── cross_border.ts             # Cross-border transfer + FATF R.16 travel-rule enforcement
│   │   │
│   │   ├── events/                         # Event append / streaming / notification
│   │   │   ├── trace.ts                    # TxEventLog append (detailed audit trail)
│   │   │   ├── stream.ts                   # SSE for banks (TX_STATE_CHANGED / CREDIT_RECEIVED / RTP_RECEIVED)
│   │   │   ├── stream_rafiki.ts            # Rafiki-style streaming micro-payments (WebSocket + Durable Object alarm)
│   │   │   └── credit_notify.ts            # Credit notification delivery (exponential backoff)
│   │   │
│   │   ├── cases/                          # Exception handling
│   │   │   ├── case.ts                     # CASE management (OPEN → IN_PROGRESS → RESOLVED/ESCALATED, auto-close)
│   │   │   └── reversal.ts                 # Reversal (post-finality remediation as separate STANDARD TX)
│   │   │
│   │   ├── collection/                     # Continuous collection / direct debit (specs: 10_requirements.md §3.2.8, 20_method_design.md §2.2.7)
│   │   │   ├── mandate.ts                  # DebitMandate register / cap change / revoke; mode derived from the payer bank's profile, demotion reported
│   │   │   ├── budget.ts                   # Single-row CAS budget reservation (window rollover in the same UPDATE; caps read from the contract)
│   │   │   ├── notice.ts                   # Advance notice + pre-registered ladder (charge-item normalisation; the freeze blocks only unfavourable amendments)
│   │   │   ├── execute.ts                  # Due-date firing, lexicographic allocation order, attempt series, deadline sweep
│   │   │   ├── reauth.ts                   # Additional authorisation (one-shot grant; silence is refusal and ends the ladder)
│   │   │   └── query.ts                    # Contract view including the future, "what I have authorised", published core profile
│   │   │
│   │   ├── platform/                       # Cross-cutting primitives
│   │   │   ├── circuit_breaker.ts          # CLOSED/OPEN/HALF_OPEN with observability metrics
│   │   │   ├── system_mode.ts              # ZC-wide BCP degradation mode (NORMAL/BCP_READONLY)
│   │   │   ├── quorum.ts                   # Consensus-quorum health & design-principle-10 degradation (read-only under quorum loss)
│   │   │   ├── operating_window.ts         # Participant operating-window evaluation (24/365)
│   │   │   ├── vault.ts                    # Short-term sensitive data storage (AML, PII, TTL-managed)
│   │   │   ├── purpose.ts                  # Purpose codes (P01–P07) + real-time closed-domain access blocking/audit
│   │   │   ├── access.ts                   # Query authorization (S-5/S-7): subject resolution, purpose gate, party check, access audit log
│   │   │   ├── access_routes.ts            # Party-scoped read route table + the explicit public-read exemption list
│   │   │   ├── condition_expr.ts           # AND/OR composition of HTLC ConditionTemplates
│   │   │   ├── ledger_predicate.ts         # Conditions resolved against ZC's own committed FinalityLog (own-ledger predicates)
│   │   │   └── metrics.ts                  # Operational observability derived from authoritative state (collectOperationalMetrics)
│   │   │
│   │   ├── query/                          # Read-side / explainability
│   │   │   ├── query.ts                    # Transaction query API (Appendix E.6 QueryResponse)
│   │   │   ├── explain.ts                  # GET /api/transactions/:txid/explain (timeline + integrity.chain_verified)
│   │   │   ├── story.ts                    # GET /api/transactions/:txid/story (narrative + Mermaid sequence + health verdict)
│   │   │   └── simulate.ts                 # Read-only dry-run of programmability primitives (condition_expr / mandate, side-effect-free)
│   │   │
│   │   ├── fx/                             # Cross-currency FX (specs: 20_method_design.md / 30_internal_design.md, FX chapters)
│   │   │   ├── rates.ts                    # Integer fixed-point rate arithmetic (RATE_SCALE=1e8, BigInt, forward=floor / backward=ceil, composeRates)
│   │   │   ├── quotes.ts                   # FxQuotes marketplace (upsert / withdraw / in-window listing)
│   │   │   ├── routing.ts                  # Best-route engine (direct + single-bridge, PAYER/PAYEE, findBestRoute)
│   │   │   ├── transfer.ts                 # FXP-conduit GTID construction + initiateFxTransfer (route→legs, quote liveness, FxTransfers facts)
│   │   │   ├── htlc.ts                     # FX-specific HTLC binding (lock/claim/refund, FxLegLocks, staggered timelocks, sweepExpiredFxLocks)
│   │   │   └── api.ts                      # FX HTTP handlers (rates / quote / transfers / claim / refund / status)
│   │   └── rtp.ts                          # compat barrel (re-exports lanes/rtp)
│   │
│   └── bank/                               # Mock participating bank APIs & ledger logic
│       ├── ingress.ts                      # Bank-side ingress dispatcher (/bank/:id/* — routes to ingress/ handlers + HMAC verify)
│       ├── ingress/                        # ZC→Bank command handlers (split by operation)
│       │   ├── _shared.ts                  # auditLog / checkIdempotency / saveResponse helpers
│       │   ├── reserve.ts                  # reserve-funds / release-reserve / leg-ready-check
│       │   ├── execute.ts                  # execute-debit / execute-credit / debit-settled
│       │   ├── verify.ts                   # authority-check / name-check / account-verify
│       │   ├── notify.ts                   # credit-notify / rtp-notify
│       │   └── admin.ts                    # initialize-bank / cleanup-bank
│       ├── teller_api.ts                   # Teller API (account status, journal queries)
│       ├── customer_api.ts                 # End-user banking app API
│       ├── ledger.ts                       # Zero-sum double-entry journal core (amount_currency)
│       ├── suspense.ts                     # Suspense & reserve account handling
│       ├── filter.ts                       # AML/sanctions filter + approval workflow
│       └── legacy/                         # Legacy core-banking (勘定系) integration mock & adapter
│           ├── legacy_core.ts              # Intentionally adversarial legacy core mock (batch, non-idempotent, cannot hold a reservation)
│           ├── adapter.ts                  # Legacy adapter fronting the hostile core (13-command ingress translated via a capability profile; six legacy-friendliness proposals)
│           └── reconcile.ts                # Three-way reconciliation (core vs shadow vs outbox; drift converged into a CASE)
│
├── test/               # vitest test suite (in-memory SQLite via better-sqlite3)
│   ├── helpers/
│   │   └── d1-mock.ts                      # MockD1Database factory + SCHEMA_MIGRATIONS list
│   ├── shared/                             # Cross-cutting unit tests
│   │   ├── errors.test.ts                  # DomainError / category mapping
│   │   ├── logger.test.ts                  # JSON shape / PII redaction / child baggage
│   │   ├── hmac.test.ts                    # HMAC-SHA256 verification
│   │   ├── secret_rotation.test.ts         # the shared-HMAC overlap window closes by the clock (a deadline-less previous key is ignored)
│   │   ├── validator.test.ts               # ZC ingress payload validator
│   │   ├── fatf_validator.test.ts          # FATF R.16 validation
│   │   ├── external_signature.test.ts      # External signature verification (ECDSA P-256/Ed25519, KeyRegistry, replay protection)
│   │   ├── zc_signature.test.ts            # ZC's own asymmetric egress signing
│   │   ├── attestation.test.ts             # ConditionTemplate whitelist / Attestation verification & freshness
│   │   ├── operator_quorum.test.ts         # n-of-m quorum & equivocation policy
│   │   ├── mandate.test.ts                 # Delegation chain registration & validation
│   │   ├── watcher.test.ts                 # WatcherObservation recording & idempotency
│   │   ├── central_bank.test.ts            # Central-bank registry / CBT account model
│   │   ├── entity_state_log.test.ts        # EntityStateLog append
│   │   └── proof.test.ts                   # BankProofRef/SettlementProofRef generation & trust verification
│   ├── bank/
│   │   ├── ledger.test.ts                  # Zero-sum invariants
│   │   ├── currency_dimension.test.ts      # Currency-dimension (multi-currency ledger) invariants
│   │   ├── customer_api.test.ts            # End-user banking API
│   │   ├── custody_auto_release.test.ts    # Suspense auto-release for frozen/closed/unknown payee accounts
│   │   └── legacy/
│   │       └── adversarial.test.ts         # Legacy adapter vs adversarial legacy_core
│   ├── cron/
│   │   ├── auth_timeout.test.ts            # T_auth: an Authority Check with no verdict is parked, then suspended — never passed
│   │   ├── pending_since.test.ts           # a deadline is not postponed by writes that say nothing about progress
│   │   ├── precheck_timeout.test.ts        # T_precheck: sweep of transactions stalled in RECEIVED
│   │   └── timeout_sweep.test.ts           # Timeout sweep (stalled / HTLC / GTID / FX locks)
│   ├── integration/                        # Cross-lane integration tests
│   │   ├── balance_invariants.test.ts      # Per-lane debit/credit/zero-sum + GTID 2×2 reverse-order coverage
│   │   ├── idempotency_replay.test.ts      # Same idempotency_key → single Transactions row
│   │   ├── queue_retry_policy.test.ts      # DomainError category × msg.retry()/ack() mapping
│   │   ├── ingress_commands.test.ts        # Round trip for each of the 13 ZC→Bank commands (caller-built payload → real handler → caller's mapping)
│   │   ├── htlc_recheck_unavailable.test.ts # a no-verdict AML recheck refuses the claim (no settlement, no state change, evidence recorded)
│   │   ├── htlc_cancel_balance.test.ts     # TIMELOCK_EXPIRED / direct cancel restores payer suspense
│   │   ├── concurrent_races.test.ts        # await-boundary interleaving (FX claim vs refund/sweep mutual exclusion, etc.)
│   │   ├── cosign_enforcement.test.ts      # Co-signature enforcement
│   │   ├── cosign_router.test.ts           # Co-signature routing
│   │   ├── zc_egress_signing.test.ts       # ZC egress signing E2E
│   │   ├── fx_settlement.test.ts           # FX E2E with real customer balances (SETTLED linkage)
│   │   ├── portability_conformance.test.ts # Portability conformance
│   │   ├── simulate_endpoints.test.ts      # /simulate endpoints
│   │   ├── chaos_adversarial.test.ts       # Adversarial chaos
│   │   ├── chaos_cross_chain.test.ts       # Cross-chain chaos
│   │   ├── chaos_delivery.test.ts          # Delivery/retry chaos
│   │   ├── chaos_dns.test.ts               # DNS chaos
│   │   ├── chaos_eod.test.ts               # EOD chaos
│   │   ├── chaos_fx.test.ts                # 8 adversarial FX scenarios (no partial/double settlement)
│   │   ├── chaos_gtid.test.ts              # GTID chaos (incl. multi-currency legs)
│   │   ├── chaos_nasty.test.ts             # Combined worst-case chaos
│   │   └── chaos_reversal.test.ts          # Reversal chaos
│   ├── invariants/                         # Static / structural invariant tests
│   │   ├── ownership.test.ts               # Module ownership boundaries
│   │   ├── pending_since.test.ts           # static guard: no timer reads a column an unrelated writer can move
│   │   ├── worker_bindings.test.ts         # every resource-typed Env binding is declared in wrangler.toml.example
│   │   ├── api_auth.test.ts                # /api/* admits credentials, not inferences (an absent Origin is not "same origin")
│   │   ├── foreign_keys.test.ts            # Foreign-key integrity
│   │   ├── finality_coverage.test.ts       # FinalityLog coverage
│   │   ├── ingress_seam.test.ts            # Structural guards on the ZC→Bank seam (single body declaration, registry↔dispatch agreement)
│   │   ├── case_dedup.test.ts              # The "is a CASE already open?" predicate (unresolved = OPEN/IN_PROGRESS/ESCALATED) is declared once
│   │   ├── query_access.test.ts            # Query authorization (S-5/S-7): purpose gate, party check, audit log, and detection of unclassified read routes
│   │   ├── schema_doc_drift.test.ts        # Schema ↔ documentation drift detection
│   │   ├── spec_refs.test.ts               # docs/specs/ drift guards (section-reference resolution, links, value domains vs type defs, PR-* ledger, reason_code catalog vs REASON_CODE_CATEGORY, cmd/event vs audit vocabularies, file_structure vs tree)
│   │   ├── dashboard_secret_guard.test.ts  # Dashboard secret-exposure guard
│   │   └── dashboard_ui_hardening.test.ts  # Dashboard UI hardening
│   └── zc/                                 # ZC lane + cross-cutting primitive tests
│       ├── lane_invariants.test.ts         # Static analysis: catches helper-bypassing raw SQL / unregistered FinalityEventType / missing tests
│       ├── lane_helpers.test.ts            # transitionWithLog / cancelInFlightTx / insertTxWithLog parallelism + TOCTOU
│       ├── atomic_finality.test.ts         # CAS + FinalityLog atomic batch / monotonic event_seq
│       ├── ingress_handlers.test.ts        # Ingress handlers
│       ├── orchestrator.test.ts            # Queue handler dispatch
│       ├── finality_chain.test.ts          # SHA-256 hash chain verification
│       ├── finality_anchor.test.ts         # Anchor creation, inclusion verification, participant co-signing
│       ├── finality_audit.test.ts          # Scheduled FinalityLog chain-break detection batch
│       ├── finality_cosign_extension.test.ts # Finality co-signing extension
│       ├── onchain_finality.test.ts        # Cross-chain finality classification + quantum-risk
│       ├── misrecord.test.ts               # MisrecordCorrected record correction
│       ├── express.test.ts                 # EXPRESS lane
│       ├── standard.test.ts                # STANDARD lane
│       ├── highvalue.test.ts               # HIGH_VALUE lane
│       ├── hv_threshold_escalation.test.ts # HIGH_VALUE auto-escalation threshold (PR-HV-THRESHOLD resolution order)
│       ├── bulk.test.ts                    # BULK lane
│       ├── bulk_lsm.test.ts                # Bulk/Deferred LSM
│       ├── rtp.test.ts                     # RTP lane
│       ├── gtid.test.ts                    # GTID lane
│       ├── gtid_leg_provenance.test.ts     # Provenance (origin_leg_id) of leg_ids rewritten by registration-time normalization
│       ├── igs_settlement_status.test.ts   # Query response separates a central-bank HOLD from a FAILED (external_settlement)
│       ├── gtid_state_machine.test.ts      # GtidState transition validator
│       ├── htlc.test.ts                    # HTLC lane
│       ├── htlc_conditions.test.ts         # HTLC ConditionTemplate conditions
│       ├── htlc_programmability.test.ts    # HTLC programmability
│       ├── htlc_cross_chain.test.ts        # Cross-chain HTLC (HTLC_ONCHAIN_PENDING)
│       ├── htlc_crosschain_quorum.test.ts  # Cross-chain HTLC quorum
│       ├── htlc_attestation_claim.test.ts  # HTLC fulfillment via attestation
│       ├── htlc_auth_canonical.test.ts     # HTLC-Auth canonical flow
│       ├── htlc_auth_regression.test.ts    # HTLC-Auth regression
│       ├── htlc_auth_benefit.test.ts       # Benefit administration (eligibility attestation, purpose restriction)
│       ├── mandate_precheck.test.ts        # Mandate precheck for EXPRESS/STANDARD
│       ├── collection_budget.test.ts      # Budget CAS: concurrency, month-boundary, exhaustion vs throttling, cap changes do not launder consumption
│       ├── collection_lifecycle.test.ts   # Notice, ladder exclusion, asymmetric finality, allocation order, freeze asymmetry, silence-is-refusal
│       ├── h_model.test.ts                 # H reservation
│       ├── h_unlock.test.ts                # H_locked release (NoDebitRecordedProof / HUnlockAuthorize)
│       ├── multi_currency.test.ts          # Multi-currency H-Model / PvP (cross-currency GTID)
│       ├── dns.test.ts                     # DNS cycle
│       ├── dns_intraday.test.ts            # DNS intraday cutoff
│       ├── dns_cycle_id.test.ts            # Canonical DNS cycle identifier `DNS-{CCY}-YYYYMMDD-NN` format/parse
│       ├── igs_hold.test.ts                # IGS admission during a DNS hold
│       ├── fx_rates.test.ts                # FX rate arithmetic (floor/ceil/compose)
│       ├── fx_routing.test.ts              # FX best route (direct/bridge, numeric checks)
│       ├── fx_transfer.test.ts             # FX conduit GTID construction + initiate
│       ├── fx_htlc.test.ts                 # FX HTLC (lock/claim/refund, wrong secret, idempotency, sweep)
│       ├── fx_api.test.ts                  # FX HTTP API
│       ├── ledger_predicate.test.ts        # Own-ledger predicate evaluation
│       ├── circuit_breaker.test.ts         # CLOSED/OPEN/HALF_OPEN transitions + metrics + adapter-outage distinction
│       ├── case_sla.test.ts                # CASE deadline and Auto-Progress→Manual-Only promotion
│       ├── case_aggregation.test.ts        # CASE aggregation (one cause, one CASE) & secondary escalation
│       ├── quorum.test.ts                  # Consensus-quorum health & degradation
│       ├── metrics.test.ts                 # Operational metrics collection
│       ├── system_mode.test.ts             # BCP degradation mode (NORMAL/BCP_READONLY)
│       ├── operating_window.test.ts        # Participant operating-window evaluation
│       ├── express_operating_window.test.ts # Counterparty-window-closed suspend (PRECHECKED_SUSPENDED) & resume
│       ├── daily_limit.test.ts             # Participant daily_amount_limit reset
│       ├── reversal.test.ts                # Reversal creation + APPROVAL_REQUIRED guard
│       ├── reversal_gate.test.ts           # Reversal gate layer 1 (CREDIT_FAILED_PROOF); account conditions are not causes
│       ├── dns_hold_detail.test.ts         # Closed-domain hold detail: every refusal is 404, purpose-code blocking, public_message_id
│       ├── query_freshness.test.ts         # freshness_level measures read-model lag, not transaction age
│       ├── query_watermark_detail.test.ts  # watermark_detail names every chain the answer was read from (GT/DNS reproducibility)
│       ├── account_verify.test.ts          # Pre-settlement account verification
│       ├── directory_als_proxy.test.ts     # ALS / Proxy resolution
│       ├── qr.test.ts                      # QR issuance
│       ├── richdata_edi.test.ts            # Rich data / ZEDI
│       ├── cross_border.test.ts            # Cross-border / FATF R.16
│       ├── explain.test.ts                 # /explain timeline + tamper detection
│       ├── story.test.ts                   # /story narrative + health verdict
│       └── stream_rafiki.test.ts           # Rafiki-style streaming micro-payments
│
├── README.md                               # Repository overview
├── test.json                               # Local test payloads
├── package.json                            # Node.js dependencies (wrangler, vitest, better-sqlite3 — no web framework)
├── package-lock.json                       # Dependency lockfile
├── biome.json                              # Biome (lint / format) configuration
├── tsconfig.json                           # TypeScript compilation config
├── tsconfig.test.json                      # Test TypeScript config
├── vitest.config.ts                        # vitest configuration
└── wrangler.toml.example                   # Template for the Cloudflare Workers deployment config (the real wrangler.toml is Git-ignored)
```

### System Operation

- **Entry Point**: `src/index.ts` holds the default `fetch`/`queue`/`scheduled` export, CORS, static dashboard serving, and the Durable Object re-exports; HTTP path routing (`/api/*`, `/bank/*`, `/internal/*`) is delegated to the routers in `src/router/` (`handleZcApi`/`handleBankApi`/`handleInternal`). Every response carries `X-Request-Id` for log correlation.
- **Database**: Cloudflare D1 (SQLite). The schema is a single consolidated file, `0001_consolidated_schema.sql`, kept as the sole source of truth. Schema changes **edit this file directly** (no new numbered files); `test/helpers/d1-mock.ts#SCHEMA_MIGRATIONS` keeps applying that one file fresh. The three FX tables (`FxQuotes` / `FxTransfers` / `FxLegLocks`) are defined in that same file. Note: because `wrangler d1 migrations apply` does not re-apply an already-applied file, an existing deployed DB would need a separate forward migration or rebuild — this reference impl assumes a fresh DB gets the full schema from the one file.
- **Domain Separation**: ZC core in `src/zc/`, bank mock in `src/bank/` (legacy core integration under `src/bank/legacy/`), shared utilities in `src/shared/`. Lane mutations to `Transactions` go through `src/zc/lanes/_helpers.ts` (`transitionWithLog` / `cancelInFlightTx` / `insertTxWithLog`) — direct `UPDATE`/`INSERT` is enforced-out by `test/zc/lane_invariants.test.ts`.
- **Async Processing**: Queue consumer (`src/zc/orchestrator.ts` and `orchestrator/`) executes state transitions. `src/cron/` handles EOD settlement and timeout sweeping (including HTLC/GTID/FX locks).
- **Single Type Export**: All types are exported from `src/types.ts`. Primitives (`primitives.ts`) and state unions (`states.ts`) are single files; HTTP I/O types live under `src/types/api/` and D1 row types under `src/types/rows/`, each split into per-domain submodules with an `index.ts` barrel.
- **Cross-cutting Primitives**: `src/zc/platform/` holds lane-agnostic primitives — circuit breaker, BCP system mode, consensus-quorum degradation (`quorum.ts`, design principle 10), operating windows, condition-expression evaluation, own-ledger predicates (`ledger_predicate.ts`), and operational metrics (`metrics.ts`). Trust-minimization quorum/equivocation checks are shared in `src/shared/operator_quorum.ts` and `attestation_quorum.ts`.
- **Cross-currency FX**: `src/zc/fx/` (rate arithmetic, quote marketplace, best-route engine, FXP-conduit GTID, optional HTLC binding) implements `docs/specs/20_method_design.md` (FX method design) and `docs/specs/30_internal_design.md` (FX internal design). Per-currency central-bank finality lands on `src/shared/central_bank.ts` (tokenized central-bank deposits, CBT).
- **Frontend**: HTML files in `src/dashboard/` (operational UI: index / console / bank-app) and `src/exploratory/ui/` (expressive layer: theater / sky) are Alpine.js + Tailwind CSS SPAs served statically as `Response(htmlString)` by the Worker fetch handler. The expressive layer (`src/exploratory/`) is kept separate as exploratory code with no bearing on settlement correctness.
- **Testing**: `test/` roughly mirrors `src/` (`shared/`, `bank/` incl. `legacy/`, `cron/`, `integration/`, `invariants/`, `zc/`). Integration tests use in-memory SQLite (better-sqlite3) with the full schema; `integration/chaos_*` exercise adversarial scenarios, and `invariants/` pin static/structural properties (foreign keys, ownership boundaries, schema↔doc drift). `lane_invariants.test.ts` performs source-level regex checks; `balance_invariants.test.ts` asserts double-entry zero-sum across every lane.
