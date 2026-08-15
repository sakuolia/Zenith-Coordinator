/**
 * @file Unit tests for src/shared/validator.ts
 *
 * All validators are pure functions — no D1 or external dependencies needed.
 */
import { describe, it, expect } from "vitest";
import {
  validatePaymentInitiated,
  validateHtlcCreate,
  validateHtlcClaim,
  validateGtidRegister,
  validateRtpRequest,
} from "../../src/shared/validator";

// ---------------------------------------------------------------------------
// validatePaymentInitiated
// ---------------------------------------------------------------------------

function validPayment() {
  return {
    schema_version: "1.0" as const,
    txid: "TX-abc123",
    idempotency_key: "idem-001",
    lane: "EXPRESS" as const,
    amount: { value: 10000, currency: "JPY" as const },
    payer: { bank_id: "001", account_hash: "0010000001" },
    payee: { bank_id: "002", account_hash: "0020000001" },
    purpose: "P2P" as const,
  };
}

describe("validatePaymentInitiated", () => {
  it("passes for a well-formed request", () => {
    expect(validatePaymentInitiated(validPayment()).ok).toBe(true);
  });

  it("rejects wrong schema_version", () => {
    const res = validatePaymentInitiated({ ...validPayment(), schema_version: "2.0" as any });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_SCHEMA_VERSION");
  });

  it("rejects txid not starting with TX-", () => {
    const res = validatePaymentInitiated({ ...validPayment(), txid: "BAD-001" });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_TXID");
  });

  it("rejects missing idempotency_key", () => {
    const res = validatePaymentInitiated({ ...validPayment(), idempotency_key: "" });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  it("rejects invalid lane", () => {
    const res = validatePaymentInitiated({ ...validPayment(), lane: "INSTANT" as any });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_LANE");
  });

  it("rejects amount.value of 0", () => {
    const res = validatePaymentInitiated({
      ...validPayment(),
      amount: { value: 0, currency: "JPY" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_AMOUNT");
  });

  it("rejects fractional amount", () => {
    const res = validatePaymentInitiated({
      ...validPayment(),
      amount: { value: 100.5, currency: "JPY" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_AMOUNT");
  });

  it("rejects non-JPY currency", () => {
    const res = validatePaymentInitiated({
      ...validPayment(),
      amount: { value: 100, currency: "USD" as any },
    });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_CURRENCY");
  });

  it("rejects missing payer bank_id", () => {
    const req = validPayment();
    req.payer.bank_id = "";
    const res = validatePaymentInitiated(req);
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("MISSING_PAYER");
  });

  it("rejects missing payee bank_id", () => {
    const req = validPayment();
    req.payee.bank_id = "";
    const res = validatePaymentInitiated(req);
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("MISSING_PAYEE");
  });

  it("rejects invalid purpose", () => {
    const res = validatePaymentInitiated({ ...validPayment(), purpose: "GIFT" as any });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_PURPOSE");
  });

  it("accepts all valid lane types", () => {
    const lanes = ["EXPRESS", "STANDARD", "BULK", "DEFERRED", "RTP", "HTLC", "HIGH_VALUE"] as const;
    for (const lane of lanes) {
      expect(validatePaymentInitiated({ ...validPayment(), lane }).ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// validateHtlcCreate
// ---------------------------------------------------------------------------

function validHtlc() {
  return {
    htlc_id: "HTLC-abc",
    hashlock: "a".repeat(64),
    timelock: new Date(Date.now() + 86400_000).toISOString(),
    amount: { value: 5000, currency: "JPY" as const },
    payer_account_hash: "0010000001",
    payee_account_hash: "0020000001",
    payer_bank_id: "001",
    payee_bank_id: "002",
    idempotency_key: "htlc-idem-001",
  };
}

describe("validateHtlcCreate", () => {
  it("passes for a well-formed request", () => {
    expect(validateHtlcCreate(validHtlc()).ok).toBe(true);
  });

  it("rejects htlc_id not starting with HTLC-", () => {
    const res = validateHtlcCreate({ ...validHtlc(), htlc_id: "TX-001" });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_HTLC_ID");
  });

  it("rejects non-hex hashlock", () => {
    const res = validateHtlcCreate({ ...validHtlc(), hashlock: "zzzz" });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_HASHLOCK");
  });

  it("accepts empty hashlock (server auto-generates)", () => {
    expect(validateHtlcCreate({ ...validHtlc(), hashlock: "" }).ok).toBe(true);
  });

  it("rejects invalid timelock (not RFC3339)", () => {
    const res = validateHtlcCreate({ ...validHtlc(), timelock: "not-a-date" });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_TIMELOCK");
  });

  it("rejects zero amount", () => {
    const res = validateHtlcCreate({ ...validHtlc(), amount: { value: 0, currency: "JPY" } });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_AMOUNT");
  });

  it("rejects payer_account_hash not 10 digits", () => {
    const res = validateHtlcCreate({ ...validHtlc(), payer_account_hash: "123" });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_PAYER_ACCOUNT");
  });
});

// ---------------------------------------------------------------------------
// validateHtlcClaim
// ---------------------------------------------------------------------------

describe("validateHtlcClaim", () => {
  it("passes for a valid claim", () => {
    const res = validateHtlcClaim({
      htlc_id: "HTLC-001",
      preimage: "deadbeef01234567",
      idempotency_key: "claim-001",
    });
    expect(res.ok).toBe(true);
  });

  it("rejects missing htlc_id", () => {
    const res = validateHtlcClaim({ preimage: "deadbeef", idempotency_key: "k" });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("MISSING_HTLC_ID");
  });

  it("rejects non-hex preimage", () => {
    const res = validateHtlcClaim({ htlc_id: "HTLC-1", preimage: "xyz!@#", idempotency_key: "k" });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_PREIMAGE");
  });

  it("rejects missing idempotency_key", () => {
    const res = validateHtlcClaim({ htlc_id: "HTLC-1", preimage: "abcd1234", idempotency_key: "" });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("MISSING_IDEMPOTENCY_KEY");
  });
});

// ---------------------------------------------------------------------------
// validateGtidRegister
// ---------------------------------------------------------------------------

describe("validateGtidRegister", () => {
  const validLegs = [
    {
      leg_id: "L1",
      role: "PAYER",
      bank_id: "001",
      account_hash: "0010000001",
      amount: { value: 1000, currency: "JPY" },
    },
    {
      leg_id: "L2",
      role: "PAYEE",
      bank_id: "002",
      account_hash: "0020000001",
      amount: { value: 1000, currency: "JPY" },
    },
  ];

  it("passes with 2 valid legs", () => {
    expect(validateGtidRegister({ gtid: "GT-001", legs: validLegs, idempotency_key: "k" }).ok).toBe(
      true
    );
  });

  it("rejects gtid not starting with GT-", () => {
    const res = validateGtidRegister({ gtid: "TX-001", legs: validLegs, idempotency_key: "k" });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_GTID");
  });

  it("rejects fewer than 2 legs", () => {
    const res = validateGtidRegister({
      gtid: "GT-001",
      legs: [validLegs[0]],
      idempotency_key: "k",
    });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_LEGS");
  });

  it("rejects leg with missing bank_id", () => {
    const bad = [{ ...validLegs[0], bank_id: "" }, validLegs[1]];
    const res = validateGtidRegister({ gtid: "GT-001", legs: bad, idempotency_key: "k" });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_LEG");
  });

  it("rejects leg with zero amount", () => {
    const bad = [{ ...validLegs[0], amount: { value: 0, currency: "JPY" } }, validLegs[1]];
    const res = validateGtidRegister({ gtid: "GT-001", legs: bad, idempotency_key: "k" });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_LEG_AMOUNT");
  });
});

// ---------------------------------------------------------------------------
// validateRtpRequest
// ---------------------------------------------------------------------------

describe("validateRtpRequest", () => {
  it("passes for a valid RTP request", () => {
    const res = validateRtpRequest({
      rtp_id: "RTP-001",
      payee_bank_id: "001",
      payer_bank_id: "002",
      amount: { value: 3000, currency: "JPY" },
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      idempotency_key: "rtp-k-001",
    });
    expect(res.ok).toBe(true);
  });

  it("rejects rtp_id not starting with RTP-", () => {
    const res = validateRtpRequest({
      rtp_id: "REQ-001",
      payee_bank_id: "001",
      payer_bank_id: "002",
      amount: { value: 1000, currency: "JPY" },
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
      idempotency_key: "k",
    });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_RTP_ID");
  });

  it("rejects invalid expires_at", () => {
    const res = validateRtpRequest({
      rtp_id: "RTP-001",
      payee_bank_id: "001",
      payer_bank_id: "002",
      amount: { value: 1000, currency: "JPY" },
      expires_at: "bad-date",
      idempotency_key: "k",
    });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe("INVALID_EXPIRES_AT");
  });
});
