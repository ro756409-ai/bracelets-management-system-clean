/**
 * Turns a customer phone number into a wa.me deep link.
 *
 * Reuses the existing Egyptian phone normalizer (shared/phone.ts — already the single
 * source of truth for order creation/edit, Excel/WhatsApp import, the EasyOrder webhook,
 * search, and duplicate detection) rather than re-parsing phone strings here.
 *
 * That normalizer accepts a few shapes it can't fully validate (e.g. a long non-Egyptian
 * digit string, kept as a last resort for search/duplicate-detection purposes). A WhatsApp
 * link needs a real Egyptian mobile number, so this layer adds the stricter check on top:
 * only an exact "01XXXXXXXXX" (11 digits) result is considered valid here.
 */
import { normalizeEgyptianPhone } from "@shared/phone";

const EGYPT_MOBILE_RE = /^01[0-9]{9}$/;

/**
 * Converts a raw phone string to the international-format digits wa.me expects
 * ("20" + the number without its leading 0), or null when the number is not a
 * plausible Egyptian mobile number.
 */
export function toWhatsAppNumber(phone: string | null | undefined): string | null {
  const normalized = normalizeEgyptianPhone(phone ?? "");
  if (!EGYPT_MOBILE_RE.test(normalized)) return null;
  return "20" + normalized.slice(1);
}

/**
 * Builds a full wa.me URL, or null when the phone number is invalid — callers use the
 * null case to disable the button rather than opening a broken link.
 */
export function buildWhatsAppUrl(phone: string | null | undefined, message?: string): string | null {
  const intlNumber = toWhatsAppNumber(phone);
  if (!intlNumber) return null;
  const url = `https://wa.me/${intlNumber}`;
  return message?.trim() ? `${url}?text=${encodeURIComponent(message.trim())}` : url;
}
