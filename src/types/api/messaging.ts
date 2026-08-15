/**
 * @file api/messaging.ts — Cloudflare Queue message types, FinalityLog event
 *       types, and the common error response shape.
 * @module types/api/messaging
 */

export type QueueMessageType =
  | "ZC_BANK_RESERVE"
  | "ZC_BANK_DEBIT"
  | "ZC_BANK_CREDIT"
  | "ZC_BANK_RELEASE"
  | "ZC_BANK_AUTH_CHECK"
  | "ZC_BANK_NAME_CHECK"
  | "ZC_BANK_LEG_READY"
  | "ZC_STATE_ADVANCE"
  | "ZC_TIMEOUT_CHECK"
  | "ZC_RESUME_CREDIT"
  | "ZC_IGS_CALLBACK";

export interface QueueMessage {
  type: QueueMessageType;
  payload: unknown;
  txid?: string;
  gtid?: string;
  attempt: number;
  enqueued_at: string;
}

export type FinalityEventType =
  | "PaymentInitiated"
  | "PreCheckPassed"
  | "PreCheckFailed"
  | "HReserved"
  | "DecidedToSettle"
  | "DecidedCancel"
  | "PayerExecConfirmed"
  | "PayeeExecConfirmed"
  | "Settled"
  | "Suspended"
  | "FailedExecution"
  | "Cancelled"
  | "HtlcCreated"
  | "HtlcLocked"
  | "HtlcFulfillRequested"
  | "HtlcFulfillRequestedByAttestation"
  | "HtlcClaimRejected"
  | "HtlcCancelled"
  | "CrossChainLocked"
  | "OnchainProofObserved"
  | "GtidRegistered"
  | "GtidDecided"
  | "GtidDecidedCancel"
  | "GtidCancelled"
  | "GtidLegDecidedToSettle"
  | "GtidSettled"
  | "RtpRequested"
  | "RtpAccepted"
  | "RtpDeclined"
  | "DnsKicked"
  | "DnsSettled"
  | "DnsHoldRequested"
  | "DnsHoldActivated"
  | "DnsResumed"
  | "DnsRingfencePromoted"
  | "DnsIntradayCutoff"
  | "IgsDeferred"
  | "IgsDeferResumed"
  | "LsmRunCommitted"
  | "LsmRunFallback"
  | "MisrecordCorrected"
  | "HtlcConditionsEvaluated"
  | "OnchainFinalityClassified"
  | "FinalityCosigned"
  | "FilterRejected"
  | "FilterPending"
  | "ApprovalGranted"
  | "ApprovalDenied"
  | "HtlcAuthRequested"
  | "HtlcAuthApproved"
  | "HtlcAuthDeclined"
  | "HtlcCaptured"
  | "HtlcVoided"
  | "FinalityChainAuditFailed"
  | "NoDebitRecordedProofSubmitted"
  /** Payee-bank proof that the credit is physically impossible — the sole
   *  cause-of-action that opens the Reversal gate (docs/specs/10_requirements.md §4.3.0 第1層). */
  | "CreditFailedProofSubmitted"
  | "HUnlockAuthorized"
  | "CounterpartyWindowClosed"
  | "CounterpartyWindowReopened"
  | "IgsRingfenceResumed"
  | "BenefitAttested"
  | "PurposeRestrictedCapture"
  | "SettlementProofAccepted"
  | "OnchainQuorumPending"
  | "WatcherEquivocationDetected"
  // 単一所有者則 (single-owner rule) handoffs — docs/specs/30_internal_design.md §5 単一所有者則
  | "OwnershipTransferred"
  | "OwnershipReclaimed"
  | "IgsRetryRecovered"
  // Closed-domain access control (audited to the GLOBAL chain,
  // docs/specs/10_requirements.md §3.3.2.2.1.1)
  | "DataAccessViolationDetected"
  | "ClosedDomainAccessGranted"
  // System mode transitions (audited to the GLOBAL chain)
  | "SystemBcpActivated"
  | "SystemBcpDeactivated"
  | "SystemQuorumLossActivated"
  | "SystemQuorumLossCleared";

export interface ErrorResponse {
  error: string;
  reason_code?: string;
  txid?: string;
}
