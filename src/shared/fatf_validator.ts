/**
 * @file FATF Recommendation 16 (wire transfer) compliance validation.
 *
 * Validates that cross-border transactions above the threshold (JPY 150,000 /
 * USD 1,000 equivalent) carry the required originator and beneficiary
 * information mandated by the FATF Travel Rule.
 *
 * Key validations:
 * - Originator: name, account, plus at least one of address / national ID / DOB+birthplace
 * - Beneficiary: name and account
 * - Ordering & beneficiary institutions: bank ID, name, country (ISO 3166-1), optional BIC
 *
 * @module shared/fatf_validator
 */

import type { FatfR16Data, FatfParty, FatfInstitution } from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

import { FATF_THRESHOLD_JPY, EXCHANGE_RATE_TO_JPY, CURRENCY_DECIMAL_PLACES } from "./constants";

// ---------------------------------------------------------------------------
// FATF R16 applicability check
// ---------------------------------------------------------------------------

/**
 * Determine whether FATF Recommendation 16 applies to a transaction.
 *
 * Both conditions must be met:
 * 1. The transfer is cross-border
 * 2. The amount is >= USD 1,000 equivalent (JPY 150,000)
 *
 * @param amount        - Transaction amount, as an integer count of
 *   `currency`'s minor unit (e.g. USD 100.50 is `10050`) — see
 *   {@link CURRENCY_DECIMAL_PLACES}
 * @param currency      - ISO 4217 currency code (e.g. "JPY", "USD")
 * @param isCrossBorder - Whether this is a cross-border transfer
 * @returns `true` if FATF R16 compliance is required
 */
export function isFatfApplicable(
  amount: number,
  currency: string,
  isCrossBorder: boolean
): boolean {
  if (!isCrossBorder) return false;

  return toJpyEquivalent(amount, currency) >= FATF_THRESHOLD_JPY;
}

// ---------------------------------------------------------------------------
// FATF R16 required field validation
// ---------------------------------------------------------------------------

/**
 * Validate that all FATF R16 mandatory fields are present and well-formed.
 *
 * Checks:
 * - Originator: name, account, plus address OR national ID OR DOB+birthplace
 * - Beneficiary: name and account
 * - Ordering institution: bank ID, name, country code
 * - Beneficiary institution: bank ID, name, country code
 * - Consistency between `fatf16_applicable` and `is_cross_border` flags
 * - Optional intermediary institution fields if present
 *
 * @param data - The FATF R16 data block attached to a transaction
 * @returns `{ valid, errors }` -- errors array is empty on success
 */
export function validateFatfR16(data: FatfR16Data): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // originator validation
  const originatorErrors = validateOriginator(data.originator);
  errors.push(...originatorErrors);

  // beneficiary validation
  const beneficiaryErrors = validateBeneficiary(data.beneficiary);
  errors.push(...beneficiaryErrors);

  // ordering_institution validation
  const orderingErrors = validateInstitution(data.ordering_institution);
  orderingErrors.forEach((e) => errors.push(`ordering_institution: ${e}`));

  // beneficiary_institution validation
  const beneficiaryInstErrors = validateInstitution(data.beneficiary_institution);
  beneficiaryInstErrors.forEach((e) => errors.push(`beneficiary_institution: ${e}`));

  // Consistency check that the transaction is cross-border
  // NOTE: This validator checks consistency between fatf16_applicable and is_cross_border flags.
  // The fatf16_applicable flag should logically only be true when is_cross_border is true.
  // Amount threshold checking (JPY 150,000) occurs in ingress.ts, not here, so this validator
  // only ensures structural consistency, not amount-based applicability.
  if (data.fatf16_applicable && !data.is_cross_border) {
    errors.push("fatf16_applicable=true だが is_cross_border=false: 矛盾した設定です");
  }

  // Validation when an intermediary is present
  if (data.intermediary) {
    if (!data.intermediary.name || data.intermediary.name.trim().length === 0) {
      errors.push("intermediary.name: 仲介機関名は必須です");
    }
    if (!data.intermediary.country || data.intermediary.country.trim().length === 0) {
      errors.push("intermediary.country: 仲介機関の国コードは必須です");
    } else if (!isValidCountryCode(data.intermediary.country)) {
      errors.push(
        `intermediary.country: 無効な国コード '${data.intermediary.country}' (ISO 3166-1 alpha-2 が必要)`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// originator (remitter) information validation
// ---------------------------------------------------------------------------

/**
 * Validate originator (sender) information per FATF R16.
 *
 * Required: name, account_id.
 * At least one additional identifier: address, national_id, or date_of_birth + place_of_birth.
 *
 * @param party - Originator party data
 * @returns Array of error messages (empty if valid)
 */
function validateOriginator(party: FatfParty): string[] {
  const errors: string[] = [];
  const prefix = "originator";

  // Required fields
  if (!party.name || party.name.trim().length === 0) {
    errors.push(`${prefix}.name: 送金人氏名は必須です`);
  } else if (party.name.trim().length > 140) {
    errors.push(`${prefix}.name: 送金人氏名は140文字以内にしてください`);
  }

  if (!party.account_id || party.account_id.trim().length === 0) {
    errors.push(`${prefix}.account_id: 送金人口座番号は必須です`);
  }

  // One of the additional identifiers is required (address OR national ID number OR date of birth + place of birth)
  const hasAddress = Boolean(party.address?.trim());
  const hasNationalId = Boolean(party.national_id?.trim());
  const hasDob = Boolean(party.date_of_birth?.trim());
  const hasPob = Boolean(party.place_of_birth?.trim());
  const hasDobAndPob = hasDob && hasPob;

  if (!hasAddress && !hasNationalId && !hasDobAndPob) {
    errors.push(
      `${prefix}: 送金人の追加識別情報が不足しています。` +
        `住所(address)、国民識別番号(national_id)、` +
        `生年月日+出生地(date_of_birth + place_of_birth) のいずれか1つが必須です`
    );
  }

  // Date-of-birth format validation (YYYY-MM-DD)
  if (hasDob && party.date_of_birth) {
    if (!isValidDateFormat(party.date_of_birth)) {
      errors.push(`${prefix}.date_of_birth: YYYY-MM-DD 形式で入力してください (例: 1985-04-15)`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// beneficiary (recipient) information validation
// ---------------------------------------------------------------------------

/**
 * Validate beneficiary (recipient) information per FATF R16.
 *
 * Required: name and account_id.
 * Unlike originator, no additional identifiers are mandated by FATF R16.
 *
 * @param party - Beneficiary party data
 * @returns Array of error messages (empty if valid)
 */
function validateBeneficiary(party: FatfParty): string[] {
  const errors: string[] = [];
  const prefix = "beneficiary";

  if (!party.name || party.name.trim().length === 0) {
    errors.push(`${prefix}.name: 受取人氏名は必須です`);
  } else if (party.name.trim().length > 140) {
    errors.push(`${prefix}.name: 受取人氏名は140文字以内にしてください`);
  }

  if (!party.account_id || party.account_id.trim().length === 0) {
    errors.push(`${prefix}.account_id: 受取人口座番号は必須です`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// ordering/beneficiary institution validation
// ---------------------------------------------------------------------------

/**
 * Validate financial institution information per FATF R16.
 *
 * Required: bank_id, bank_name, and ISO 3166-1 alpha-2 country code.
 * Optional but recommended: SWIFT BIC (8 or 11 characters).
 *
 * @param inst - Institution data (ordering or beneficiary)
 * @returns Array of error messages (empty if valid)
 */
function validateInstitution(inst: FatfInstitution): string[] {
  const errors: string[] = [];

  if (!inst.bank_id || inst.bank_id.trim().length === 0) {
    errors.push("bank_id: 金融機関IDは必須です");
  }

  if (!inst.bank_name || inst.bank_name.trim().length === 0) {
    errors.push("bank_name: 金融機関名は必須です");
  }

  if (!inst.country || inst.country.trim().length === 0) {
    errors.push("country: 国コードは必須です");
  } else if (!isValidCountryCode(inst.country)) {
    errors.push(
      `country: 無効な国コード '${inst.country}' (ISO 3166-1 alpha-2 が必要, 例: JP, US, DE)`
    );
  }

  // Format validation when a BIC is present
  if (inst.bic) {
    if (!isValidBicFormat(inst.bic)) {
      errors.push(`bic: 無効な BIC フォーマット '${inst.bic}' (8文字または11文字が必要)`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Serialize / deserialize
// ---------------------------------------------------------------------------

/**
 * Serialize FatfR16Data to a JSON string for DB storage or transmission.
 *
 * @param data - FATF R16 data block
 * @returns JSON string
 */
export function serializeFatfData(data: FatfR16Data): string {
  return JSON.stringify(data);
}

// ---------------------------------------------------------------------------
// Additional utilities (exported)
// ---------------------------------------------------------------------------

/**
 * Convert an amount to JPY equivalent using fixed mock exchange rates.
 *
 * Used for FATF threshold checks and dashboard display.
 *
 * @param amount   - Transaction amount, as an integer count of `currency`'s
 *   minor unit (e.g. USD 100.50 is `10050`) — see
 *   {@link CURRENCY_DECIMAL_PLACES}
 * @param currency - ISO 4217 currency code
 * @returns Approximate JPY equivalent (rounded to nearest integer)
 */
export function toJpyEquivalent(amount: number, currency: string): number {
  const ccy = currency.toUpperCase();
  const rate = EXCHANGE_RATE_TO_JPY[ccy] ?? 150;
  const decimalPlaces = CURRENCY_DECIMAL_PLACES[ccy] ?? 2;
  return Math.round((amount / 10 ** decimalPlaces) * rate);
}

// ---------------------------------------------------------------------------
// Internal utilities (module-private)
// ---------------------------------------------------------------------------

/** Validate ISO 3166-1 alpha-2 country code format (regex only in mock). */
function isValidCountryCode(country: string): boolean {
  // Normalize to uppercase before validation (lowercase input is accepted, but normalized form is assumed)
  return /^[A-Z]{2}$/.test(country.toUpperCase());
}

/** Validate SWIFT BIC format: 4-char institution + 2-char country + 2-char location [+ 3-char branch]. */
function isValidBicFormat(bic: string): boolean {
  return /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic.toUpperCase());
}

/** Validate that a date string is in YYYY-MM-DD format and represents a real date. */
function isValidDateFormat(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const date = new Date(dateStr);
  return !Number.isNaN(date.getTime());
}

/** TypeScript type guard: checks that a parsed object has the minimum FatfR16Data shape. */
function isValidFatfR16Shape(obj: unknown): obj is FatfR16Data {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;

  // Required top-level keys
  const requiredKeys: (keyof FatfR16Data)[] = [
    "originator",
    "beneficiary",
    "ordering_institution",
    "beneficiary_institution",
    "is_cross_border",
    "fatf16_applicable",
  ];
  for (const key of requiredKeys) {
    if (!(key in o)) return false;
  }

  // originator / beneficiary are objects with name and account_id
  for (const partyKey of ["originator", "beneficiary"] as const) {
    const party = o[partyKey];
    if (typeof party !== "object" || party === null) return false;
    const p = party as Record<string, unknown>;
    if (typeof p.name !== "string") return false;
    if (typeof p.account_id !== "string") return false;
  }

  // ordering_institution / beneficiary_institution have bank_id, bank_name, country
  for (const instKey of ["ordering_institution", "beneficiary_institution"] as const) {
    const inst = o[instKey];
    if (typeof inst !== "object" || inst === null) return false;
    const i = inst as Record<string, unknown>;
    if (typeof i.bank_id !== "string") return false;
    if (typeof i.bank_name !== "string") return false;
    if (typeof i.country !== "string") return false;
  }

  return true;
}
