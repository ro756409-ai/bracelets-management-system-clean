import { useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import manifest from "../../../public/brand/partner-assets.json";

/**
 * شعارات الجهات الرسمية (المرحلة 6) — ملفات محلية فقط من `client/public/brand/partners/` مسجّلة في
 * `partner-assets.json` (الجهة، الملف، المصدر الرسمي، تاريخ التحميل، الصيغة الأصلية، الأبعاد).
 *   • لا إعادة رسم ولا تغيير ألوان/نسب: `<img>` بأبعاد ثابتة من الـmanifest (نسبة العرض محفوظة) → لا Layout Shift.
 *   • نسخة Light/Dark فقط عندما توفّرها الجهة رسميًا (Meta mono black/white) — تُبدَّل بـCSS `dark:` بلا سياق.
 *   • `decorative` = اسم الجهة مكتوب بجوار الشعار → `alt=""` + `aria-hidden`؛ وإلا `alt` باسم الجهة.
 *   • Fallback نصي محترم (اسم الجهة في رقاقة) عند غياب الملف أو فشل تحميله — لا صورة مكسورة.
 *   • `loading="lazy"` افتراضيًا؛ `eager` للشعارات الظاهرة فورًا.
 */
export type PartnerId = "bosta" | "easyorders" | "whatsapp" | "meta" | "facebook" | "instapay" | "vodafone_cash";
export type PartnerLogoSize = "xs" | "sm" | "md" | "lg";

type Variant = { file: string; width: number; height: number; format: string };
export type PartnerAsset = {
  id: PartnerId;
  name: string;
  nameAr: string;
  /** النسخة الافتراضية (تعمل فوق الفاتح والداكن) */
  light?: Variant;
  /** نسخة رسمية للداكن فقط إن وفّرتها الجهة */
  dark?: Variant;
  source: string;
  downloadedAt: string;
  originalFormat: string;
  note?: string;
};

export const PARTNER_ASSETS = (manifest as { partners: PartnerAsset[] }).partners;
export const PARTNERS_BY_ID: Record<PartnerId, PartnerAsset | undefined> = Object.fromEntries(PARTNER_ASSETS.map(p => [p.id, p])) as Record<PartnerId, PartnerAsset | undefined>;
export const PARTNER_IDS = ["bosta", "easyorders", "whatsapp", "meta", "facebook", "instapay", "vodafone_cash"] as const satisfies readonly PartnerId[];

/** الارتفاع بالبكسل لكل حجم؛ العرض يُشتق من نسبة الملف فتبقى الأبعاد ثابتة قبل التحميل */
export const PARTNER_LOGO_HEIGHT: Record<PartnerLogoSize, number> = { xs: 14, sm: 20, md: 28, lg: 40 };
export const PARTNER_BASE_PATH = "/brand/partners/";

export type PartnerLogoProps = {
  partner: PartnerId;
  size?: PartnerLogoSize;
  /** اسم الجهة مكتوب بجوار الشعار → الشعار زخرفي */
  decorative?: boolean;
  alt?: string;
  eager?: boolean;
  className?: string;
  /** يُرسم النص البديل بدل الشعار حتى لو الملف موجود (للاختبار/الأسطح غير المناسبة) */
  forceFallback?: boolean;
};

function dims(v: Variant, size: PartnerLogoSize) {
  const h = PARTNER_LOGO_HEIGHT[size];
  const w = Math.max(1, Math.round((v.width / v.height) * h));
  return { w, h };
}

export function PartnerLogo({ partner, size = "sm", decorative = false, alt, eager = false, className, forceFallback = false }: PartnerLogoProps) {
  const asset = PARTNERS_BY_ID[partner];
  const [failed, setFailed] = useState(false);
  const label = alt ?? asset?.nameAr ?? partner;

  if (!asset?.light || failed || forceFallback) {
    // بديل نصي محترم بأبعاد ثابتة: لا صورة مكسورة ولا قفزة في التخطيط
    const h = PARTNER_LOGO_HEIGHT[size];
    return (
      <span
        className={cn("inline-flex shrink-0 items-center justify-center rounded-[var(--radius-brand-sm)] border border-border bg-muted px-1.5 font-en text-[10px] font-semibold uppercase leading-none text-muted-foreground", className)}
        style={{ height: h, minWidth: h }}
        role={decorative ? undefined : "img"}
        aria-label={decorative ? undefined : label}
        aria-hidden={decorative ? "true" : undefined}
        data-testid={`partner-logo-${partner}`}
        data-fallback="true"
      >
        {asset?.name ?? partner}
      </span>
    );
  }

  const base = dims(asset.light, size);
  const common = {
    loading: eager ? ("eager" as const) : ("lazy" as const),
    decoding: "async" as const,
    draggable: false,
    onError: () => setFailed(true),
    alt: decorative ? "" : label,
    "aria-hidden": decorative ? ("true" as const) : undefined,
    style: { height: base.h } as CSSProperties,
  };
  const imgClass = "inline-block shrink-0 select-none object-contain";

  if (asset.dark) {
    const d = dims(asset.dark, size);
    return (
      <span className={cn("inline-flex shrink-0 items-center", className)} data-testid={`partner-logo-${partner}`} data-variants="light,dark" style={{ height: base.h }}>
        <img {...common} src={PARTNER_BASE_PATH + asset.light.file} width={base.w} height={base.h} className={cn(imgClass, "dark:hidden")} data-variant="light" />
        <img {...common} src={PARTNER_BASE_PATH + asset.dark.file} width={d.w} height={d.h} className={cn(imgClass, "hidden dark:inline-block")} data-variant="dark" />
      </span>
    );
  }
  return (
    <img
      {...common}
      src={PARTNER_BASE_PATH + asset.light.file}
      width={base.w}
      height={base.h}
      className={cn(imgClass, className)}
      data-testid={`partner-logo-${partner}`}
      data-variants="light"
    />
  );
}
