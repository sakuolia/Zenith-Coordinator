/**
 * @file BIC ↔ bank_id mapping.
 *
 * Provides BIC-to-internal-ID resolution used when building ISO 20022
 * messages. The BIC mapping table is hardcoded for the mock; a production
 * system would query an external directory service.
 *
 * @module shared/routing
 */

// ---------------------------------------------------------------------------
// BIC ↔ bank_id mapping (fixed mock values)
// ---------------------------------------------------------------------------

/**
 * BIC code → internal bank_id mapping table.
 * Fixed values in the mock implementation. In production, refer to the DB or an external directory.
 */
const BIC_TO_BANK_ID: Record<string, string> = {
  // Domestic participating banks in Japan
  MHCBJPJT: "001", // Nagaoka Bank
  BOTKJPJT: "002", // Owari Bank
  SMTBJPJT: "003", // Kaga Bank
  RZSBJPJT: "004", // Hizen Bank
  HANGJPJT: "005", // Satsuma Bank
  SMBCJPJT: "006", // Echigo Bank
  YUKBJPJT: "007", // Sanuki Bank (international BIC)
  SFJPJPJT: "008", // Bingo Bank
  AOZOBJPJT: "009", // Awaji Bank
  OKHBJPJT: "010", // Hyuga Bank (tentative)
  HOKBJPJT: "011",
  TOHOJPJT: "012",
  CHUBJPJT: "013",
  HOKRJPJT: "014",
  HIRBJPJT: "015",
  SHKBJPJT: "016",
  FUKBJPJT: "017",
  KUMBJPJT: "018", // Osumi Bank
  KAGBJPJT: "019",
  OKNBJPJT: "020",
  // Major overseas banks (for cross-border)
  CHASUS33: "JPMC-US", // JP Morgan Chase (US)
  CITIUS33: "CITI-US", // Citibank (US)
  BOFAUS3N: "BOFA-US", // Bank of America (US)
  DEUTDEDB: "DEUT-DE", // Deutsche Bank (DE)
  BNPAFRPP: "BNPA-FR", // BNP Paribas (FR)
  HSBCHKHH: "HSBC-HK", // HSBC Hong Kong
};

/** bank_id → BIC mapping table (reverse lookup of BIC_TO_BANK_ID) */
const BANK_ID_TO_BIC: Record<string, string> = Object.fromEntries(
  Object.entries(BIC_TO_BANK_ID).map(([bic, id]) => [id, bic])
);

// ---------------------------------------------------------------------------
// BIC ↔ bank_id conversion
// ---------------------------------------------------------------------------

/**
 * Returns the internal bank_id from a BIC code.
 * Returns null if not present in the mapping.
 *
 * @param bic - SWIFT BIC code (8 or 11 characters)
 * @returns internal bank_id or null
 */
export function bicToBankId(bic: string): string | null {
  if (!bic) return null;
  // 11-character BIC (with branch code) is normalized to 8 characters for lookup
  const normalizedBic = bic.length === 11 ? bic.substring(0, 8) : bic;
  return BIC_TO_BANK_ID[normalizedBic.toUpperCase()] ?? null;
}

/**
 * Returns the BIC code from an internal bank_id.
 * Generates and returns a dummy BIC if not present in the mapping.
 *
 * @param bankId - internal bank_id (e.g. '001', '002')
 * @returns SWIFT BIC code (8 characters)
 */
export function bankIdToBic(bankId: string): string {
  if (!bankId) return "UNKNJPJT";
  const bic = BANK_ID_TO_BIC[bankId];
  if (bic) return bic;
  // If unregistered: generate a dummy BIC in ZXXXXXXT format
  // X = embeds the digits of bankId (up to 4 characters)
  const paddedId = bankId.slice(0, 4).padStart(4, "0");
  return `Z${paddedId}JPJT`;
}
