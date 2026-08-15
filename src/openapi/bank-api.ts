/**
 * @file Bank API OpenAPI 3.0.3 specification (YAML as TypeScript string constant).
 *
 * Covers all Bank Mock endpoints across five tag groups:
 *   - **zc-ingress** (10 endpoints): Internal commands received from Zenith Coordinator
 *   - **customer** (8 endpoints): Customer-facing account & transfer management
 *   - **teller** (12 endpoints): Bank staff operations (cash, accounts, journals, audit)
 *   - **filters** (4 endpoints): Payment filter CRUD for incoming credit screening
 *
 * Served at `GET /bank-api.yaml` by the Worker router.
 *
 * @module openapi/bank-api
 * @version 2.0.0
 */
const bankApiYaml = `openapi: 3.0.3
info:
  title: Zenith Bank API
  version: 2.0.0
  description: |
    Bank Mock が提供する4種類のAPI群。

    ## ZC→Bank Ingress API（13本）
    Zenith Coordinator から受信する内部コマンド。すべて POST で冪等性保証済み。
    ZC の egress 署名は二重受け（X-ZC-Key-Id の有無で非対称署名／HMAC-SHA256 を判別）。

    ## Bank Customer API（8本）
    顧客向けの口座残高照会・取引履歴・振込・承認管理。
    ヘッダー X-Bank-Id + X-Customer-Id で認証（モック）。

    ## Bank Teller API（12本）
    行員向けの現金入出金・口座管理・仕訳照会・別段預金解消・監査ログ。
    ヘッダー X-Bank-Id + X-Teller-Id で認証（モック）。

    ## Payment Filters API（4本）
    着金フィルタ（送信元ブロック・金額上限・EDIパターン・承認要求）の CRUD。
    顧客が自身の口座に対して設定する。

  contact:
    name: Zenith Mock Project
  license:
    name: MIT

servers:
  - url: /
    description: Cloudflare Workers

tags:
  - name: zc-ingress
    description: ZC→Bank Ingress API（署名必須・二重受け・13本）
  - name: customer
    description: 顧客向けAPI（X-Bank-Id + X-Customer-Id）
  - name: teller
    description: 行員向けAPI（X-Bank-Id + X-Teller-Id）
  - name: filters
    description: 着金フィルタ管理API（X-Bank-Id + X-Customer-Id）

# ==========================================================================
# ZC→Bank Ingress API (10 endpoints)
# ==========================================================================
paths:
  /bank/{bankId}/zc-ingress/reserve-funds:
    post:
      tags: [zc-ingress]
      summary: 資金予約（H_RESERVED確保要求）
      description: |
        SuspenseDetails に RESERVED レコードを作成し、顧客口座の
        available_balance を減少させる。冪等キーは request_id。
      operationId: reserveFunds
      parameters:
        - $ref: '#/components/parameters/bankId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ReserveFundsRequest'
      responses:
        "200":
          description: 予約結果
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ReserveFundsResponse'

  /bank/{bankId}/zc-ingress/execute-debit:
    post:
      tags: [zc-ingress]
      summary: a実行指示（PayerExecRequested準拠）
      description: |
        SuspenseDetails を RESERVED → COMMITTED に変更し、
        顧客口座 → 別段預金 の仕訳（BankJournals）を記録する。
        a証憑（bank_proof_ref）を生成して返す。
      operationId: executeDebit
      parameters:
        - $ref: '#/components/parameters/bankId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ExecuteDebitRequest'
      responses:
        "200":
          description: Debit 実行結果
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ExecuteDebitResponse'

  /bank/{bankId}/zc-ingress/execute-credit:
    post:
      tags: [zc-ingress]
      summary: b実行指示（PayeeExecRequested）
      description: |
        Hard Landing: ZCS → 別段預金 仕訳を記録。
        Soft Landing: 別段預金 → 顧客口座 即時入金。
        着金フィルタ評価（SENDER_BLOCK / AMOUNT_LIMIT / REQUIRE_APPROVAL 等）
        により Custody 発生時は別段預金に留め custody_detail を返す。
      operationId: executeCredit
      parameters:
        - $ref: '#/components/parameters/bankId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ExecuteCreditRequest'
      responses:
        "200":
          description: Credit 実行結果
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ExecuteCreditResponse'

  /bank/{bankId}/zc-ingress/release-reserve:
    post:
      tags: [zc-ingress]
      summary: 資金予約解放
      description: |
        SuspenseDetails を RESERVED → RELEASED に変更し、
        顧客口座の available_balance を復元する。
        キャンセル・タイムアウト時に ZC から呼び出される。
      operationId: releaseReserve
      parameters:
        - $ref: '#/components/parameters/bankId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [request_id, txid, reservation_ref]
              properties:
                request_id: { type: string }
                txid: { type: string }
                reservation_ref: { type: string }
      responses:
        "200":
          description: 解放結果
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: string, example: RELEASED }
                  reservation_ref: { type: string }

  /bank/{bankId}/zc-ingress/authority-check:
    post:
      tags: [zc-ingress]
      summary: AML・制裁スクリーニング
      description: |
        仕向銀行側で実施する AML/CFT スクリーニング。
        モック実装では常に OK を返す。
      operationId: authorityCheck
      parameters:
        - $ref: '#/components/parameters/bankId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [request_id, txid, check_type]
              properties:
                request_id: { type: string }
                txid: { type: string }
                check_type: { type: string, enum: [INITIAL, RECHECK] }
                vault_ref: { type: string }
      responses:
        "200":
          description: スクリーニング結果
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: string, enum: [OK, NG] }
                  reason_code: { type: string }

  /bank/{bankId}/zc-ingress/name-check:
    post:
      tags: [zc-ingress]
      summary: 名義確認
      description: |
        受取人口座の名義を確認する。account_hash から口座を特定し、
        PSPR 登録名と BankAccounts.customer_name を照合する。
      operationId: nameCheck
      parameters:
        - $ref: '#/components/parameters/bankId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [request_id, txid, account_hash]
              properties:
                request_id: { type: string }
                txid: { type: string }
                pspr_ref: { type: string }
                account_hash: { type: string }
      responses:
        "200":
          description: 名義確認結果
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: string, enum: [MATCH, MISMATCH] }
                  reason_code: { type: string }

  /bank/{bankId}/zc-ingress/leg-ready-check:
    post:
      tags: [zc-ingress]
      summary: GTID leg レディネス確認
      description: |
        GTID 協調取引の各 leg について、参加銀行側の準備状況
        （残高充足・口座状態）を確認する。SuspenseDetails は作成しない。
      operationId: legReadyCheck
      parameters:
        - $ref: '#/components/parameters/bankId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [request_id, gtid, leg_id, role, amount, account_hash]
              properties:
                request_id: { type: string }
                gtid: { type: string }
                leg_id: { type: string }
                role: { type: string, enum: [PAYER, PAYEE] }
                amount: { $ref: '#/components/schemas/Amount' }
                account_hash: { type: string }
      responses:
        "200":
          description: レディネス確認結果
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: string, enum: [OK, NG] }
                  reason_code: { type: string }

  /bank/{bankId}/zc-ingress/account-verify:
    post:
      tags: [zc-ingress]
      summary: 口座確認（存在確認 + 名義照合）
      description: |
        target_account_hash で口座を検索し、存在確認と名義照合を行う。
        名義照合には Levenshtein 距離（閾値3）を使用し、
        EXACT_MATCH / CLOSE_MATCH / MISMATCH / NOT_FOUND を返す。
      operationId: accountVerify
      parameters:
        - $ref: '#/components/parameters/bankId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/AccountVerifyIngressRequest'
      responses:
        "200":
          description: 口座確認結果
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/AccountVerifyIngressResponse'

  /bank/{bankId}/zc-ingress/credit-notify:
    post:
      tags: [zc-ingress]
      summary: 着金通知（決済完了後の入金記帳通知）
      description: |
        DNS/IGS 決済完了後、受取銀行に入金を通知する。
        別段預金 → 顧客口座 の仕訳を記録し、着金フィルタを評価する。
        Custody 発生時は別段預金に留める。
      operationId: creditNotify
      parameters:
        - $ref: '#/components/parameters/bankId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreditNotifyIngressRequest'
      responses:
        "200":
          description: 着金通知結果
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: string, enum: [OK, CUSTODY] }
                  reason_code: { type: string }

  /bank/{bankId}/zc-ingress/rtp-notify:
    post:
      tags: [zc-ingress]
      summary: Request-to-Pay 通知（支払人銀行への請求通知）
      description: |
        受取人銀行が発行した RTP リクエストを、支払人銀行に通知する。
        PaymentApprovalRequests に PENDING レコードを作成し、
        顧客の承認待ちとする。
      operationId: rtpNotify
      parameters:
        - $ref: '#/components/parameters/bankId'
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/RtpNotifyIngressRequest'
      responses:
        "200":
          description: RTP 通知結果
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: string, enum: [OK, ERROR] }
                  reason_code: { type: string }

# ==========================================================================
# Customer API (8 endpoints)
# ==========================================================================
  /bank/{bankId}/v1/me/accounts:
    get:
      tags: [customer]
      summary: 口座一覧
      description: 顧客が保有する全口座（CLOSED除外）の一覧と残高を返す。
      operationId: getMyAccounts
      parameters:
        - $ref: '#/components/parameters/bankId'
      security:
        - customerAuth: []
      responses:
        "200":
          description: 口座一覧
          content:
            application/json:
              schema:
                type: object
                properties:
                  accounts:
                    type: array
                    items: { $ref: '#/components/schemas/AccountSummary' }

  /bank/{bankId}/v1/me/accounts/{accountId}/balance:
    get:
      tags: [customer]
      summary: 残高照会
      description: |
        指定口座の残高を返す。balance は BankJournals の SUM、
        available_balance は未決済予約（SuspenseDetails RESERVED）を差し引いた額。
      operationId: getMyBalance
      parameters:
        - $ref: '#/components/parameters/bankId'
        - $ref: '#/components/parameters/accountId'
      security:
        - customerAuth: []
      responses:
        "200":
          description: 残高
          content:
            application/json:
              schema:
                type: object
                properties:
                  account_id: { type: string }
                  balance: { type: integer }
                  available_balance: { type: integer }
                  currency: { type: string, example: JPY }
                  as_of: { type: string, format: date-time }
        "404":
          $ref: '#/components/responses/NotFound'

  /bank/{bankId}/v1/me/accounts/{accountId}/transactions:
    get:
      tags: [customer]
      summary: 取引履歴
      description: |
        指定口座の仕訳を取引履歴として返す。
        txid / date_from / date_to によるフィルタリングが可能。
      operationId: getMyTransactions
      parameters:
        - $ref: '#/components/parameters/bankId'
        - $ref: '#/components/parameters/accountId'
        - name: limit
          in: query
          schema: { type: integer, default: 20 }
        - name: txid
          in: query
          description: 取引ID前方一致検索
          schema: { type: string }
        - name: date_from
          in: query
          description: 開始日 (YYYY-MM-DD)
          schema: { type: string, format: date }
        - name: date_to
          in: query
          description: 終了日 (YYYY-MM-DD)
          schema: { type: string, format: date }
      security:
        - customerAuth: []
      responses:
        "200":
          description: 取引履歴
          content:
            application/json:
              schema:
                type: object
                properties:
                  transactions:
                    type: array
                    items: { $ref: '#/components/schemas/TransactionHistoryEntry' }

  /bank/{bankId}/v1/me/transfers:
    post:
      tags: [customer]
      summary: 振込実行（全ZCレーン対応）
      description: |
        顧客からの振込リクエストを受け付け、ZC の POST /api/transfers を
        内部呼び出しする。EXPRESS / STANDARD / BULK / DEFERRED /
        HIGH_VALUE / RTP の各レーンに対応。
      operationId: postMyTransfer
      parameters:
        - $ref: '#/components/parameters/bankId'
      security:
        - customerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CustomerTransferRequest'
      responses:
        "200":
          description: 振込受付成功
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: string }
                  txid: { type: string }
                  state: { type: string }
        "400":
          $ref: '#/components/responses/BadRequest'

  /bank/{bankId}/v1/me/transfers/{txid}:
    get:
      tags: [customer]
      summary: 振込状態照会
      description: 送金元銀行として、指定取引の現在状態を返す。
      operationId: getMyTransferStatus
      parameters:
        - $ref: '#/components/parameters/bankId'
        - name: txid
          in: path
          required: true
          schema: { type: string }
      security:
        - customerAuth: []
      responses:
        "200":
          description: 振込状態
          content:
            application/json:
              schema:
                type: object
                properties:
                  txid: { type: string }
                  state: { type: string }
                  reason_code: { type: string }
                  amount_value: { type: integer }
                  amount_currency: { type: string }
                  created_at: { type: string, format: date-time }
                  updated_at: { type: string, format: date-time }
        "404":
          $ref: '#/components/responses/NotFound'

  /bank/{bankId}/v1/me/approvals:
    get:
      tags: [customer]
      summary: 着金承認リクエスト一覧
      description: |
        着金フィルタ（REQUIRE_APPROVAL）でホールドされた着金の
        承認リクエスト一覧を返す。status パラメータで PENDING / APPROVED / REJECTED
        をフィルタ可能。
      operationId: getMyApprovals
      parameters:
        - $ref: '#/components/parameters/bankId'
        - name: account_id
          in: query
          description: 口座IDでフィルタ
          schema: { type: string }
        - name: status
          in: query
          description: 承認ステータスでフィルタ（デフォルト PENDING）
          schema: { type: string, enum: [PENDING, APPROVED, REJECTED], default: PENDING }
      security:
        - customerAuth: []
      responses:
        "200":
          description: 承認リクエスト一覧
          content:
            application/json:
              schema:
                type: object
                properties:
                  approvals:
                    type: array
                    items: { $ref: '#/components/schemas/ApprovalRequest' }

  /bank/{bankId}/v1/me/approvals/{approvalId}/respond:
    post:
      tags: [customer]
      summary: 着金承認/拒否
      description: |
        PENDING 状態の承認リクエストに対して承認（approved: true）
        または拒否（approved: false）を返す。承認時は ZC に
        ZC_RESUME_CREDIT キューメッセージを送信し、着金処理を再開する。
      operationId: respondToApproval
      parameters:
        - $ref: '#/components/parameters/bankId'
        - name: approvalId
          in: path
          required: true
          schema: { type: string }
      security:
        - customerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [approved]
              properties:
                approved: { type: boolean, description: true=承認, false=拒否 }
                reason: { type: string, description: 拒否理由（任意） }
      responses:
        "200":
          description: 承認/拒否結果
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: string, enum: [APPROVED, REJECTED] }
                  txid: { type: string }
        "400":
          $ref: '#/components/responses/BadRequest'

# ==========================================================================
# Teller API (12 endpoints)
# ==========================================================================
  /bank/{bankId}/v1/teller/cash/deposit:
    post:
      tags: [teller]
      summary: 現金入金
      description: |
        顧客口座に現金を入金する。Cash口座(-)→顧客口座(+) のゼロサム仕訳を記録。
      operationId: cashDeposit
      parameters:
        - $ref: '#/components/parameters/bankId'
      security:
        - tellerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [account_id, amount]
              properties:
                account_id: { type: string }
                amount: { type: integer, minimum: 1 }
                description: { type: string }
      responses:
        "200":
          description: 入金成功
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: string, example: OK }
                  account_id: { type: string }
                  new_balance: { type: integer }
                  currency: { type: string, example: JPY }

  /bank/{bankId}/v1/teller/cash/withdrawal:
    post:
      tags: [teller]
      summary: 現金払い戻し
      description: |
        顧客口座から現金を払い戻す。顧客口座(-)→Cash口座(+) のゼロサム仕訳を記録。
        残高不足時は 400 エラー。
      operationId: cashWithdrawal
      parameters:
        - $ref: '#/components/parameters/bankId'
      security:
        - tellerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [account_id, amount]
              properties:
                account_id: { type: string }
                amount: { type: integer, minimum: 1 }
                description: { type: string }
      responses:
        "200":
          description: 払い戻し成功
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: string, example: OK }
                  account_id: { type: string }
                  new_balance: { type: integer }
                  currency: { type: string, example: JPY }
        "400":
          $ref: '#/components/responses/BadRequest'

  /bank/{bankId}/v1/teller/accounts:
    get:
      tags: [teller]
      summary: 口座一覧（行員用）
      description: 当該銀行の全口座を一覧表示する（システム口座含む）。
      operationId: tellerListAccounts
      parameters:
        - $ref: '#/components/parameters/bankId'
      security:
        - tellerAuth: []
      responses:
        "200":
          description: 口座一覧（全種別）
          content:
            application/json:
              schema:
                type: object
                properties:
                  accounts:
                    type: array
                    items: { $ref: '#/components/schemas/AccountSummary' }
    post:
      tags: [teller]
      summary: 口座開設
      description: |
        新規顧客口座を開設する。account_type は SAVINGS / CURRENT。
        initial_deposit 指定時は開設と同時に Cash 入金仕訳を生成。
      operationId: createAccount
      parameters:
        - $ref: '#/components/parameters/bankId'
      security:
        - tellerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [customer_name, account_type]
              properties:
                customer_name: { type: string }
                account_type: { type: string, enum: [SAVINGS, CURRENT, CORPORATE] }
                initial_deposit: { type: integer, minimum: 0 }
      responses:
        "201":
          description: 口座開設成功
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: string, example: CREATED }
                  account_id: { type: string }
                  bank_id: { type: string }
                  account_type: { type: string }
                  customer_name: { type: string }

  /bank/{bankId}/v1/teller/accounts/batch:
    post:
      tags: [teller]
      summary: 口座一括作成（最大200件）
      description: |
        最大200口座を一括作成する。各口座に initial_deposit を指定可能。
        D1 batch でアトミックに実行される。
        シミュレーター大規模初期化で使用。
      operationId: batchCreateAccounts
      parameters:
        - $ref: '#/components/parameters/bankId'
      security:
        - tellerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [accounts]
              properties:
                accounts:
                  type: array
                  maxItems: 200
                  items:
                    type: object
                    required: [customer_name]
                    properties:
                      customer_name: { type: string }
                      account_type: { type: string, enum: [SAVINGS, CURRENT], default: SAVINGS }
                      initial_deposit: { type: integer, minimum: 0 }
      responses:
        "201":
          description: 一括作成成功
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: string, example: BATCH_CREATED }
                  count: { type: integer }
                  created:
                    type: array
                    items:
                      type: object
                      properties:
                        account_id: { type: string }
                        bank_id: { type: string }
                        customer_name: { type: string }
                        initial_deposit: { type: integer }
        "400":
          $ref: '#/components/responses/BadRequest'

  /bank/{bankId}/v1/teller/accounts/{accountId}:
    patch:
      tags: [teller]
      summary: 口座ステータス変更
      description: |
        口座の status を NORMAL / FROZEN / CLOSING_HOLD / CLOSED に変更する。
        FROZEN → NORMAL の凍結解除、NORMAL → CLOSED の口座閉鎖等。
      operationId: updateAccountStatus
      parameters:
        - $ref: '#/components/parameters/bankId'
        - $ref: '#/components/parameters/accountId'
      security:
        - tellerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [status]
              properties:
                status: { type: string, enum: [NORMAL, FROZEN, CLOSING_HOLD, CLOSED] }
                reason: { type: string }
      responses:
        "200":
          description: 更新成功

  /bank/{bankId}/v1/teller/accounts/{accountId}/journals:
    get:
      tags: [teller]
      summary: 仕訳照会（口座別）
      description: 指定口座の仕訳一覧を返す。
      operationId: getAccountJournals
      parameters:
        - $ref: '#/components/parameters/bankId'
        - $ref: '#/components/parameters/accountId'
      security:
        - tellerAuth: []
      responses:
        "200":
          description: 仕訳一覧
          content:
            application/json:
              schema:
                type: object
                properties:
                  journals:
                    type: array
                    items: { $ref: '#/components/schemas/JournalEntry' }

  /bank/{bankId}/v1/teller/journals:
    get:
      tags: [teller]
      summary: 全仕訳帳照会
      description: |
        当該銀行の全仕訳を照会する。account_id / from / to / limit で
        フィルタリング可能。最大500件。
      operationId: getAllJournals
      parameters:
        - $ref: '#/components/parameters/bankId'
        - name: account_id
          in: query
          description: 口座IDでフィルタ
          schema: { type: string }
        - name: from
          in: query
          description: 開始日 (YYYY-MM-DD)
          schema: { type: string, format: date }
        - name: to
          in: query
          description: 終了日 (YYYY-MM-DD)
          schema: { type: string, format: date }
        - name: limit
          in: query
          description: 取得件数上限（デフォルト200、最大500）
          schema: { type: integer, default: 200, maximum: 500 }
      security:
        - tellerAuth: []
      responses:
        "200":
          description: 仕訳一覧
          content:
            application/json:
              schema:
                type: object
                properties:
                  journals:
                    type: array
                    items: { $ref: '#/components/schemas/JournalEntry' }
                  count: { type: integer }

  /bank/{bankId}/v1/teller/suspense:
    get:
      tags: [teller]
      summary: 別段預金一覧
      description: |
        SuspenseDetails の一覧を返す。status / txid でフィルタ可能。
        最大200件。
      operationId: listSuspense
      parameters:
        - $ref: '#/components/parameters/bankId'
        - name: status
          in: query
          description: ステータスフィルタ (RESERVED / COMMITTED / RELEASED)
          schema: { type: string }
        - name: txid
          in: query
          description: 取引IDで部分一致検索
          schema: { type: string }
      security:
        - tellerAuth: []
      responses:
        "200":
          description: 別段預金一覧
          content:
            application/json:
              schema:
                type: object
                properties:
                  suspense:
                    type: array
                    items: { $ref: '#/components/schemas/SuspenseDetail' }
                  count: { type: integer }

  /bank/{bankId}/v1/teller/suspense/{suspenseId}/resolve:
    post:
      tags: [teller]
      summary: 別段預金収束（Custody解消等）
      description: |
        Custody 状態の別段預金を指定口座に振り替えて収束させる。
        別段預金(-)→顧客口座(+) の仕訳を記録し、SuspenseDetails を
        COMMITTED → SETTLED に更新。
      operationId: resolveSuspense
      parameters:
        - $ref: '#/components/parameters/bankId'
        - name: suspenseId
          in: path
          required: true
          schema: { type: string }
      security:
        - tellerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [target_account_id]
              properties:
                target_account_id: { type: string, description: 振替先口座ID }
                reason: { type: string }
      responses:
        "200":
          description: 収束成功

  /bank/{bankId}/v1/teller/batch/status:
    get:
      tags: [teller]
      summary: バッチ処理状態照会
      description: 直近のバッチ処理（EOD・DNS清算等）の実行状態を返す。
      operationId: getBatchStatus
      parameters:
        - $ref: '#/components/parameters/bankId'
      security:
        - tellerAuth: []
      responses:
        "200":
          description: バッチ状態

  /bank/{bankId}/v1/teller/audit-log:
    get:
      tags: [teller]
      summary: 監査ログ照会
      description: |
        BankAuditLog の一覧を返す。txid でフィルタ可能。
        ZC→Bank Ingress コマンドの実行履歴（成功/失敗・理由コード）を確認できる。
      operationId: getAuditLog
      parameters:
        - $ref: '#/components/parameters/bankId'
        - name: txid
          in: query
          description: 取引IDでフィルタ
          schema: { type: string }
        - name: limit
          in: query
          description: 取得件数上限（デフォルト100）
          schema: { type: integer, default: 100 }
      security:
        - tellerAuth: []
      responses:
        "200":
          description: 監査ログ一覧
          content:
            application/json:
              schema:
                type: object
                properties:
                  audit_log:
                    type: array
                    items: { $ref: '#/components/schemas/AuditLogEntry' }

# ==========================================================================
# Payment Filters API (4 endpoints)
# ==========================================================================
  /bank/{bankId}/v1/filters:
    get:
      tags: [filters]
      summary: 着金フィルタ一覧
      description: |
        設定済みの着金フィルタ一覧を返す。account_id でフィルタ可能。
        フィルタ種別: SENDER_BLOCK / SENDER_BANK_BLOCK / AMOUNT_LIMIT /
        EDI_PATTERN / REQUIRE_APPROVAL
      operationId: listFilters
      parameters:
        - $ref: '#/components/parameters/bankId'
        - name: account_id
          in: query
          description: 口座IDでフィルタ
          schema: { type: string }
      security:
        - customerAuth: []
      responses:
        "200":
          description: フィルタ一覧
          content:
            application/json:
              schema:
                type: object
                properties:
                  filters:
                    type: array
                    items: { $ref: '#/components/schemas/PaymentFilter' }
    post:
      tags: [filters]
      summary: 着金フィルタ作成
      description: |
        新しい着金フィルタを作成する。execute-credit 時に着金を
        自動ブロック・金額制限・承認要求等の条件を設定できる。
      operationId: createFilter
      parameters:
        - $ref: '#/components/parameters/bankId'
      security:
        - customerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateFilterRequest'
      responses:
        "201":
          description: フィルタ作成成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PaymentFilter'

  /bank/{bankId}/v1/filters/{filterId}:
    delete:
      tags: [filters]
      summary: 着金フィルタ削除
      operationId: deleteFilter
      parameters:
        - $ref: '#/components/parameters/bankId'
        - name: filterId
          in: path
          required: true
          schema: { type: string }
      security:
        - customerAuth: []
      responses:
        "200":
          description: 削除成功
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: string, example: DELETED }
                  filter_id: { type: string }
        "404":
          $ref: '#/components/responses/NotFound'
    patch:
      tags: [filters]
      summary: 着金フィルタ有効/無効切替
      operationId: updateFilter
      parameters:
        - $ref: '#/components/parameters/bankId'
        - name: filterId
          in: path
          required: true
          schema: { type: string }
      security:
        - customerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                is_active: { type: boolean, description: true=有効, false=無効 }
      responses:
        "200":
          description: 更新成功
          content:
            application/json:
              schema:
                type: object
                properties:
                  result: { type: string, example: UPDATED }
                  filter_id: { type: string }
        "404":
          $ref: '#/components/responses/NotFound'

# ==========================================================================
# Components
# ==========================================================================
components:
  parameters:
    bankId:
      name: bankId
      in: path
      required: true
      description: 銀行コード（001〜020）
      schema: { type: string, example: "001" }
    accountId:
      name: accountId
      in: path
      required: true
      description: 口座ID
      schema: { type: string }

  securitySchemes:
    customerAuth:
      type: apiKey
      in: header
      name: X-Customer-Id
      description: "顧客ID（モック用・認証なし）。X-Bank-Id ヘッダーも必要。"
    tellerAuth:
      type: apiKey
      in: header
      name: X-Teller-Id
      description: "行員ID（モック用・認証なし）。X-Bank-Id ヘッダーも必要。"

  responses:
    BadRequest:
      description: バリデーションエラー
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorResponse' }
    NotFound:
      description: リソースが見つかりません
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorResponse' }
    Conflict:
      description: 状態競合
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorResponse' }

  schemas:
    ErrorResponse:
      type: object
      properties:
        error: { type: string }
        reason_code: { type: string }

    Amount:
      type: object
      required: [value, currency]
      properties:
        value: { type: integer, description: 金額（整数、最小単位）, example: 10000 }
        currency: { type: string, description: 通貨コード, example: JPY }

    AccountSummary:
      type: object
      properties:
        account_id: { type: string }
        customer_name: { type: string }
        account_type: { type: string, enum: [SAVINGS, CURRENT, CORPORATE, SUSPENSE, NOSTRO, ZCS, BOJ, CASH] }
        status: { type: string, enum: [NORMAL, FROZEN, CLOSING_HOLD, CLOSED] }
        balance: { type: integer }
        currency: { type: string, example: JPY }

    TransactionHistoryEntry:
      type: object
      description: 取引明細行（仕訳ベース）
      properties:
        journal_id: { type: string }
        amount: { type: integer, description: 正=入金、負=出金 }
        tx_type: { type: string }
        tx_group_id: { type: string }
        description: { type: string }
        value_date: { type: string, format: date }
        created_at: { type: string, format: date-time }
        display_label: { type: string, description: UI表示用ラベル（レーン・目的別） }

    JournalEntry:
      type: object
      properties:
        journal_id: { type: string }
        bank_id: { type: string }
        account_id: { type: string }
        amount: { type: integer, description: 正=貸方、負=借方 }
        tx_type: { type: string }
        tx_group_id: { type: string }
        description: { type: string }
        value_date: { type: string, format: date }
        created_at: { type: string, format: date-time }

    SuspenseDetail:
      type: object
      description: 別段預金（SuspenseDetails テーブル行）
      properties:
        suspense_id: { type: string }
        bank_id: { type: string }
        txid: { type: string }
        account_id: { type: string }
        amount: { type: integer }
        status: { type: string, enum: [RESERVED, COMMITTED, SETTLED, RELEASED, CUSTODY] }
        reservation_ref: { type: string }
        custody_reason: { type: string }
        created_at: { type: string, format: date-time }
        updated_at: { type: string, format: date-time }

    AuditLogEntry:
      type: object
      description: 銀行監査ログエントリ
      properties:
        log_id: { type: string }
        bank_id: { type: string }
        txid: { type: string }
        request_id: { type: string }
        command: { type: string, description: Ingress コマンド名 }
        status: { type: string, enum: [OK, NG] }
        reason_code: { type: string }
        amount: { type: integer }
        account_id: { type: string }
        details_json: { type: string, description: JSON文字列（追加情報） }
        occurred_at: { type: string, format: date-time }

    ApprovalRequest:
      type: object
      description: 着金承認リクエスト
      properties:
        approval_id: { type: string }
        bank_id: { type: string }
        account_id: { type: string }
        txid: { type: string }
        filter_id: { type: string }
        amount: { type: integer }
        sender_bank_id: { type: string }
        sender_name: { type: string }
        status: { type: string, enum: [PENDING, APPROVED, REJECTED, EXPIRED] }
        created_at: { type: string, format: date-time }
        responded_at: { type: string, format: date-time }

    PaymentFilter:
      type: object
      description: 着金フィルタ設定
      properties:
        filter_id: { type: string }
        bank_id: { type: string }
        account_id: { type: string }
        filter_type:
          type: string
          enum: [SENDER_BLOCK, SENDER_BANK_BLOCK, AMOUNT_LIMIT, EDI_PATTERN, REQUIRE_APPROVAL]
        action:
          type: string
          enum: [BLOCK, HOLD_CONFIRM]
          description: BLOCK=即拒否, HOLD_CONFIRM=顧客承認待ち
        condition_json: { type: string, description: フィルタ条件（JSON文字列） }
        is_active: { type: boolean }
        created_at: { type: string, format: date-time }

    CreateFilterRequest:
      type: object
      required: [account_id, filter_type, action]
      properties:
        account_id: { type: string }
        filter_type:
          type: string
          enum: [SENDER_BLOCK, SENDER_BANK_BLOCK, AMOUNT_LIMIT, EDI_PATTERN, REQUIRE_APPROVAL]
        action:
          type: string
          enum: [BLOCK, HOLD_CONFIRM]
        condition:
          type: object
          description: |
            フィルタ種別に応じた条件。
            SENDER_BLOCK: { sender_account_id: string }
            SENDER_BANK_BLOCK: { sender_bank_id: string }
            AMOUNT_LIMIT: { max_amount: number }
            EDI_PATTERN: { field: string, pattern: string }
            REQUIRE_APPROVAL: { min_amount?: number }

    CustomerTransferRequest:
      type: object
      required: [amount, payee_bank_id, payee_account_hash, lane, purpose, idempotency_key]
      properties:
        amount: { $ref: '#/components/schemas/Amount' }
        payee_bank_id: { type: string }
        payee_account_hash: { type: string }
        payee_account_id: { type: string, description: payee_account_hash のエイリアス }
        lane:
          type: string
          enum: [EXPRESS, STANDARD, BULK, DEFERRED, HIGH_VALUE, RTP]
        purpose:
          type: string
          enum: [MERCHANT, P2P, BILL, SALARY, REFUND]
        idempotency_key: { type: string }
        pspr_ref: { type: string, description: PSPR登録参照（任意） }

    ReserveFundsRequest:
      type: object
      required: [request_id, txid, amount, account_hash]
      properties:
        request_id: { type: string }
        txid: { type: string }
        amount: { $ref: '#/components/schemas/Amount' }
        account_hash: { type: string }

    ReserveFundsResponse:
      type: object
      properties:
        result: { type: string, enum: [RESERVED, ERROR] }
        reservation_ref: { type: string }
        reason_code: { type: string }

    ExecuteDebitRequest:
      type: object
      required: [request_id, txid, amount, decision_proof_ref, h_reservation, execution_deadline]
      properties:
        request_id: { type: string }
        txid: { type: string }
        amount: { $ref: '#/components/schemas/Amount' }
        decision_proof_ref: { type: string }
        h_reservation:
          type: object
          properties:
            reservation_id: { type: string }
            mode: { type: string, example: RESERVED }
        execution_deadline: { type: string, format: date-time }

    ExecuteDebitResponse:
      type: object
      properties:
        result: { type: string, example: OK }
        bank_proof_ref: { $ref: '#/components/schemas/BankProofRef' }

    ExecuteCreditRequest:
      type: object
      required: [request_id, txid, amount, decision_proof_ref]
      properties:
        request_id: { type: string }
        txid: { type: string }
        amount: { $ref: '#/components/schemas/Amount' }
        decision_proof_ref: { type: string }
        payee_account_hash: { type: string }
        payer_bank_id: { type: string }
        payer_name_masked: { type: string }
        purpose: { type: string }
        edi_summary: { type: string }

    ExecuteCreditResponse:
      type: object
      properties:
        result: { type: string, example: OK }
        bank_proof_ref: { $ref: '#/components/schemas/BankProofRef' }

    BankProofRef:
      type: object
      properties:
        issuer_bank_id: { type: string }
        proof_type: { type: string, enum: [PAYER_EXEC_PROOF, PAYEE_EXEC_PROOF] }
        proof_id: { type: string }
        recorded_at: { type: string, format: date-time }
        custody_detail:
          type: object
          nullable: true
          properties:
            is_custody: { type: boolean }
            reason_code: { type: string }
            custody_account_ref: { type: string }

    AccountVerifyIngressRequest:
      type: object
      required: [request_id, verification_id, target_account_hash]
      properties:
        request_id: { type: string }
        verification_id: { type: string }
        target_account_hash: { type: string, description: 確認対象口座ID }
        target_account_name: { type: string, description: 照合対象名義（Levenshtein距離で比較） }

    AccountVerifyIngressResponse:
      type: object
      properties:
        result: { type: string, enum: [EXACT_MATCH, CLOSE_MATCH, MISMATCH, NOT_FOUND] }
        account_exists: { type: boolean }
        name_match_score: { type: number, description: Levenshtein距離（0=完全一致） }

    CreditNotifyIngressRequest:
      type: object
      required: [request_id, notification_id, txid, payee_account_hash, amount, payer_bank_id]
      properties:
        request_id: { type: string }
        notification_id: { type: string }
        txid: { type: string }
        payee_account_hash: { type: string }
        amount: { $ref: '#/components/schemas/Amount' }
        payer_bank_id: { type: string }
        payer_name_masked: { type: string }
        purpose: { type: string }
        edi_summary: { type: string, description: EDI要約情報（任意） }

    RtpNotifyIngressRequest:
      type: object
      required: [request_id, rtp_id, payee_bank_id, payer_bank_id, amount, expires_at]
      properties:
        request_id: { type: string }
        rtp_id: { type: string }
        payee_bank_id: { type: string }
        payer_bank_id: { type: string }
        amount: { $ref: '#/components/schemas/Amount' }
        expires_at: { type: string, format: date-time }
        payee_name: { type: string }
        description: { type: string }
`;

export default bankApiYaml;
