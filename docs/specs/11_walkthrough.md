# Walkthrough — もし Zenith があったら（口座振替の場合）

> このリポジトリの構想を、技術仕様の文章ではなく **生活の場面** から眺めるための短い案内です。
> 本シナリオは構想を直感的に伝えるための例示であり、実装の細部や、口座振替契約の改定・信用情報への影響・再請求の取り扱いといった制度上の論点はすべて省略しています。

---

## 日本語

### 設定：電気代の口座振替

A さんは電気代（毎月 9,800 円）を口座振替で支払っています。今月、給与日が後ろ倒しになった都合で、振替日に口座残高が不足してしまいました。

ありふれた場面です。

### いま、何が起きるか（現状）

| 日付 | 出来事 | A さんが知っていること |
| --- | --- | --- |
| 4月10日 | 電気会社が銀行に振替依頼ファイルを送付 | （知らない） |
| 4月27日 | 振替日。残高不足で不能。銀行は不能ファイルを電気会社に返送 | （知らない） |
| 5月2日 | 電気会社から「振替不能・再請求のお知らせ」のハガキが A さんの郵便受けに届く | はじめて、引落が失敗していたことを知る |
| 5月3日 | A さんは電気会社に電話。担当者は「契約により、5月13日に再度引き落とします」と回答 | 次にいつ引き落とされるかを、ようやく知る |
| 5月13日 | 再引落。今度は成功。 | 数日後の通帳記帳で確認 |

この例では、失敗から成立まで **16 日**かかっています。この間、A さんが得られるのは断片的な情報だけです。電気会社のサポート、銀行のコールセンター、A さん自身、それぞれが見ている情報も時刻もばらばらです。

### Zenith があると、何が変わるか

```
RECEIVED → PRECHECKED →（残高不足）→ DECIDED_CANCEL → CANCELLED
                              ↓（A さんが「いま払う」を選択）
                          新規 TX → ... → SETTLED
```

| 日付・時刻 | 出来事 | A さん側の画面 | 電気会社側の画面 |
| --- | --- | --- | --- |
| 4月10日 | 電気会社が RTP（請求）を起票。`TX-EBL-2026-04-A` が払い出され `RECEIVED` で受理 | 「4月27日 9,800円 引き落とし予定」 | 「請求登録済み・27日に引き落とし」 |
| 4月20日 | A さんは銀行アプリで予定を見て、給与遅れを思い出す | 「あ、今月は残高が足りないかも」 | （変化なし） |
| 4月27日 09:00:00 | Zenith が `PRECHECKED` まで進めるが、H予約（`H_RESERVED` への遷移）に失敗＝残高不足。`DECIDED_CANCEL`、`reason_code='INSUFFICIENT_FUNDS'` を FinalityLog に記録 | 数秒以内に「電気代 9,800円 残高不足で不成立（TX-EBL-2026-04-A）」 | 同時刻に「不成立。理由: 残高不足」 |
| 4月27日 09:00:05 | A さんの銀行アプリと電気会社のサービス画面に **同じタイムライン** が表示される | 「次回再請求は契約により 5月13日 09:00」「いま払う／待つ」 | 「再請求は 5月13日 09:00」 |
| 4月27日 14:00 | A さんは「いま払う」を選択。別口座から振り込み、新しい `TX-EBL-2026-04-A-RE1` が `SETTLED` に到達 | 「電気代 9,800円 完了（14:00:08）」 | SSE で即時通知。利用停止予定リストから除外 |
| 後日、問い合わせ | A さんが「信用情報に影響しないか」を電気会社のコールセンターに問い合わせる | コールセンター担当者は `TX-EBL-2026-04-A` を入力し、A さんと **同じ画面、同じ時刻、同じ理由コード** を見ながら回答できる | 同上 |

失敗から成立まで **数時間** です。A さんも、電気会社のサポートも、A さんの銀行のコールセンターも、**同じ取引番号で、同じ説明** を見ています。

### 何が起きていないか — そこに気づくことが大事

- 「払ったつもりだったのに止められた」という事故が起きていません。
- 「ハガキが届くまで気づかなかった」という時差が消えています。
- 「電気会社に何度電話しても、結局よくわからない」という対応コストが消えています。
- 「振替不能のお知らせ」のハガキを刷って郵送する必要がなくなっています。
- 銀行のコールセンターも、電気会社のサポートも、それぞれ別々に状況を再構成する手間が消えています。

これは派手な革新ではありません。**ただ、説明できる状態の連なりがそこにある、というだけ** のことです。それでも効果は確実です。この種の小さな摩擦は、利用者・事業者・銀行のいずれにとっても毎日たくさん起きているものだからこそ、それが軽くなる意味は大きいのです。

### この絵に対応する Zenith の中身

- **レーン**：受取人発起のプル型なので RTP レーン（`src/zc/lanes/rtp.ts`）。事前承認とリトライ規約は、電気会社と銀行のあいだの契約条件として固定される。
- **状態の連なり**：`RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE → PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED → SETTLED`。残高不足の場合は `PRECHECKED → DECIDED_CANCEL → CANCELLED` に分岐し、`reason_code` が FinalityLog に追記される。RTP レーンは当日 Attempt で支払人の承認が得られたのち、Standard 相当の Decision/Execution 経路（この汎用の状態列）へ合流するため、上表は RTP 固有の Attempt 概念のあとに続く共通の状態列を示している（`10_requirements.md` §1.2.1・`20_method_design.md` §2.2.3 と整合）。
- **唯一の正**：A さんの銀行アプリも、電気会社のシステムも、コールセンターの管理画面も、すべて FinalityLog という **同じ追記専用ログ** から派生したビューを見ている。「言った／言わない」がない。
- **制度**：再請求の頻度・許容回数、利用停止に至る基準、不能時の表示文言は [`10_requirements.md`](10_requirements.md) のレイヤーに置く。Zenith が提供するのは状態と証跡であり、利用停止の判断は電気会社が行い、解約・差押は契約と法令に従って参加者が行う。

---

## English

### Setting: a household electric bill on direct debit

A pays the monthly electric bill (¥9,800) by direct debit. This month, payday slips backward, and on the debit date the account balance is short.

A perfectly ordinary scene.

### What happens today

| Date | Event | What A knows |
| --- | --- | --- |
| Apr 10 | The utility sends the debit request file to the bank | (nothing) |
| Apr 27 | Debit date. Insufficient funds. The bank returns a non-collection file | (nothing) |
| May 2 | A postcard from the utility — "Your direct debit failed; we will retry" — arrives in A's mailbox | First moment A learns the debit failed |
| May 3 | A calls the utility. The agent: "Per your contract, we'll retry on May 13" | A finally learns when the next attempt is |
| May 13 | Retry. This time it succeeds. | A sees it days later when checking the passbook |

In this example, sixteen days from failure to completion. During those days A holds only fragments. Customer support at the utility, the bank's call centre, and A themselves look at different snapshots at different times.

### With Zenith in place

```
RECEIVED → PRECHECKED →(insufficient funds)→ DECIDED_CANCEL → CANCELLED
                                    ↓ (A chooses "pay now")
                                new TX → ... → SETTLED
```

| Time | Event | What A sees | What the utility sees |
| --- | --- | --- | --- |
| Apr 10 | The utility files a Request-to-Pay. `TX-EBL-2026-04-A` is issued and accepted as `RECEIVED` | "¥9,800 will be debited on Apr 27" | "Request registered; debit on the 27th" |
| Apr 20 | A glances at the bank app and remembers payday is late | "I might be short this month" | (no change) |
| Apr 27 09:00:00 | Zenith reaches `PRECHECKED` but fails to reserve H (the transition to `H_RESERVED`) for insufficient funds. `DECIDED_CANCEL` with `reason_code='INSUFFICIENT_FUNDS'` is appended to the FinalityLog | Within seconds: "Electric bill ¥9,800 — failed, insufficient funds (TX-EBL-2026-04-A)" | At the same instant: "Failed. Reason: insufficient funds" |
| Apr 27 09:00:05 | A's bank app and the utility's service screen show the **same timeline** | "Next attempt under the contract: May 13 09:00 — Pay now / Wait" | "Retry: May 13 09:00" |
| Apr 27 14:00 | A taps "Pay now". A new `TX-EBL-2026-04-A-RE1` reaches `SETTLED` via a transfer from another account | "Electric bill ¥9,800 — completed (14:00:08)" | Instant SSE notification; the account is removed from the pending-suspension list |
| Days later | A calls the utility wondering if the failed attempt will affect their credit profile | The agent enters `TX-EBL-2026-04-A` and looks at **the same screen, the same timestamps, the same reason code** as A | The same |

Hours, not weeks, from failure to completion. A, the utility's support, and the bank's call centre all read **the same explanation under the same transaction id**.

### What is *not* happening — and why noticing matters

- No "I thought it was paid, but service was cut off" accidents.
- No two-week delay between the failure and the customer learning of it.
- No "I called the utility three times and still didn't understand" support cost.
- No printed and mailed paper notice.
- No separate reconstruction of the situation by the bank's call centre, the utility's support, and the customer in three different ways.

This is not a flashy innovation. It is simply that **an explicable sequence of states is now present**. Even so, the everyday small friction that bank, utility, and customer absorb in large volumes becomes measurably lighter for all three.

### What this picture maps to inside Zenith

- **Lane**: payee-initiated pull, so the RTP lane (`src/zc/lanes/rtp.ts`). Authorisation and retry policy are contract-driven, fixed in the agreement between the utility and the bank.
- **State sequence**: `RECEIVED → PRECHECKED → H_RESERVED → DECIDED_TO_SETTLE → PAYER_EXEC_CONFIRMED → PAYEE_EXEC_CONFIRMED → SETTLED`. On insufficient funds, the row branches `PRECHECKED → DECIDED_CANCEL → CANCELLED`, with `reason_code` appended to the FinalityLog. Because the RTP lane, once the payer approves within a same-day Attempt, merges into the Standard-equivalent Decision/Execution path (this generic state sequence), the table above shows the common state sequence that follows the RTP-specific Attempt concept (consistent with `10_requirements.md` §1.2.1 and `20_method_design.md` §2.2.3).
- **Single source of truth**: A's bank app, the utility's system, and the call-centre screen all derive their view from the same append-only FinalityLog. No "he-said / she-said".
- **Institution**: retry frequency, retry limit, the threshold for service suspension, and the wording shown on failure are part of the policy layer in [`10_requirements.md`](10_requirements.md). Zenith supplies state and evidence; the utility decides whether to suspend service; cancellations and attachments are executed by participants under contract and law.
