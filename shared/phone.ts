/**
 * Central phone normalization utility for Egyptian mobile numbers.
 * Used by manual order creation/edit, Excel/WhatsApp import, the EasyOrder
 * webhook, order search, and duplicate detection so every write path in the
 * system stores phone numbers in the same canonical local format:
 * "01XXXXXXXXX" (11 digits).
 */

const ARABIC_INDIC_DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  // Eastern Arabic (Persian/Urdu) digit variants, seen occasionally in
  // pasted WhatsApp/Excel text alongside Arabic-Indic digits.
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

/** Converts Arabic-Indic and Eastern Arabic digits to ASCII 0-9. Leaves everything else untouched. */
export function toAsciiDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, d => ARABIC_INDIC_DIGITS[d] ?? d);
}

/**
 * Normalizes a raw phone string into a canonical Egyptian mobile number
 * ("01XXXXXXXXX"), or "" if no valid/usable number could be extracted.
 *
 * Handles: 01xxxxxxxxx, +201xxxxxxxxx, 00201xxxxxxxxx, Arabic-Indic digits,
 * spaces/dashes/parentheses/dots, and multiple numbers in one field
 * separated by common delimiters (only the first valid one is returned).
 */
export function normalizeEgyptianPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const asciiRaw = toAsciiDigits(raw);
  const parts = asciiRaw.split(/[*/\-,،\n\r|]+/);

  for (const part of parts) {
    let cleaned = part.replace(/[^0-9+]/g, "");
    if (cleaned.startsWith("+20")) cleaned = "0" + cleaned.slice(3);
    if (cleaned.startsWith("0020")) cleaned = "0" + cleaned.slice(4);
    if (cleaned.startsWith("20") && cleaned.length === 12) cleaned = "0" + cleaned.slice(2);

    if (/^01[0-9]{9}$/.test(cleaned)) return cleaned;

    const match = cleaned.match(/(01[0-9]{9})/);
    if (match) return match[1];
  }

  // Fallback: strip everything non-digit from the whole raw string and retry
  const allDigits = asciiRaw.replace(/[^0-9]/g, "");
  if (allDigits.startsWith("20") && allDigits.length === 12) {
    return "0" + allDigits.slice(2);
  }
  const fallbackMatch = allDigits.match(/(01[0-9]{9})/);
  if (fallbackMatch) return fallbackMatch[1];

  // Last resort: return raw digits if long enough to plausibly be a phone
  // number (e.g. a landline or non-Egyptian number), otherwise give up.
  const stripped = asciiRaw.replace(/[^0-9]/g, "");
  return stripped.length >= 7 ? stripped : "";
}

/** True if two raw phone strings normalize to the same non-empty number. */
export function egyptianPhonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeEgyptianPhone(a);
  const nb = normalizeEgyptianPhone(b);
  return na.length > 0 && na === nb;
}
