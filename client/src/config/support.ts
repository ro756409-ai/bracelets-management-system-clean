/**
 * قنوات الدعم — من متغيرات البناء (مش أسرار): VITE_SUPPORT_WHATSAPP (رقم دولي أرقام بس، مثال 2010xxxxxxxx) و
 * VITE_SUPPORT_EMAIL. مش متضبطة ⇒ الروابط مابتظهرش خالص (مفيش رقم أو بريد وهمي).
 */
export type SupportContact = { whatsappUrl: string | null; email: string | null };

export function supportFromEnv(env: { VITE_SUPPORT_WHATSAPP?: string; VITE_SUPPORT_EMAIL?: string }): SupportContact {
  const phone = (env.VITE_SUPPORT_WHATSAPP ?? "").trim();
  const email = (env.VITE_SUPPORT_EMAIL ?? "").trim();
  return {
    whatsappUrl: /^[1-9][0-9]{7,14}$/.test(phone) ? `https://wa.me/${phone}` : null,
    email: /^[^\s@<>"]+@[^\s@<>"]+\.[A-Za-z]{2,}$/.test(email) ? email : null,
  };
}

export const SUPPORT: SupportContact = supportFromEnv(import.meta.env as any);
