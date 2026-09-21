import {
  aiSegmentsSchema,
  AI_MAX_RETRIES,
  AI_MAX_SEGMENTS,
  AI_MAX_SEGMENT_CHARS,
  AI_TIMEOUT_MS,
  type AiSegment,
} from "../../shared/orderParse";
import { allowAiCall } from "./aiRateLimit";

/**
 * AI fallback لأجزاء سطر المنتج الغامضة — **بس**.
 *
 *   • الافتراضي `ORDER_PARSER_AI=none` → مفيش أي نداء خارجي (تحليل حتمي فقط).
 *   • `ORDER_PARSER_AI=anthropic` + `ANTHROPIC_API_KEY` → Messages API، موديل من
 *     `ORDER_PARSER_AI_MODEL` (افتراضي claude-haiku-4-5-20251001).
 *   • اللي بيتبعت: **نصوص أجزاء المنتج غير المحلولة فقط** (بحد أقصى AI_MAX_SEGMENTS ×
 *     AI_MAX_SEGMENT_CHARS) + أسماء أنواع الكتالوج كسياق. لا اسم ولا هاتف ولا عنوان ولا
 *     الرسالة الكاملة — المتصل مسؤول إنه يمرّر الأجزاء بس، والحارس هنا بيقصّ الطول.
 *   • المخرج Zod صارم (`aiSegmentsSchema`): نص وكمية وسعر وثقة — أي معرّف مرفوض.
 *   • timeout 6s وretry واحد؛ أي فشل → null والمتصل يكمل حتميًا. الصفحة ماتقفش.
 */

export type SegmentResolver = (
  segments: string[],
  catalogTerms: string[]
) => Promise<AiSegment[] | null>;

export interface ResolverConfig {
  provider: "none" | "anthropic";
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export function readResolverConfig(env: NodeJS.ProcessEnv = process.env): ResolverConfig {
  const provider = (env.ORDER_PARSER_AI ?? "none").trim().toLowerCase();
  return {
    provider: provider === "anthropic" && env.ANTHROPIC_API_KEY ? "anthropic" : "none",
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.ORDER_PARSER_AI_MODEL?.trim() || "claude-haiku-4-5-20251001",
  };
}

/** يقصّ المدخل لحدوده — ده الحارس الأخير قبل أي نداء خارجي. */
export function sanitizeSegments(segments: string[]): string[] {
  return segments
    .map(s => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, AI_MAX_SEGMENT_CHARS))
    .filter(Boolean)
    .slice(0, AI_MAX_SEGMENTS);
}

function buildPrompt(segments: string[], catalogTerms: string[]): string {
  return [
    "أنت تساعد في قراءة أجزاء من سطر «نوع المنتج» في طلب أساور. لكل جزء أعد JSON فقط بلا أي شرح:",
    '[{"segmentText":"<الجزء كما هو>","intendedText":"<اسم النوع المقصود من القائمة أو النص المنقّى>","quantity":<عدد أو null>,"unitPrice":<سعر مذكور أو null>,"confidence":<0..1>}]',
    "ممنوع إضافة أي مفاتيح أخرى. لا تخترع أسعارًا أو كميات غير مكتوبة.",
    `أسماء الأنواع المتاحة: ${catalogTerms.slice(0, 60).join(" | ")}`,
    `الأجزاء: ${JSON.stringify(segments)}`,
  ].join("\n");
}

async function callAnthropic(cfg: ResolverConfig, prompt: string): Promise<string> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey as string,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 800,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
    const body: any = await res.json();
    const text = Array.isArray(body?.content) ? body.content.map((c: any) => c?.text ?? "").join("") : "";
    return String(text);
  } finally {
    clearTimeout(timer);
  }
}

/** يستخرج أول مصفوفة JSON من نص النموذج ويتحقق منها بالـschema الصارمة. */
export function parseAiOutput(text: string): AiSegment[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    const r = aiSegmentsSchema.safeParse(parsed);
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export function createSegmentResolver(cfg: ResolverConfig = readResolverConfig()): SegmentResolver | null {
  if (cfg.provider !== "anthropic" || !cfg.apiKey) return null;
  return async (segments, catalogTerms) => {
    const clean = sanitizeSegments(segments);
    if (clean.length === 0) return [];
    const prompt = buildPrompt(clean, catalogTerms);
    for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt++) {
      try {
        const out = parseAiOutput(await callAnthropic(cfg, prompt));
        if (out) return out;
      } catch (err) {
        console.warn(`[orderParse:ai] attempt ${attempt + 1} failed:`, err instanceof Error ? err.message : err);
      }
    }
    return null;
  };
}

// ── اختيار المزوّد وقت التشغيل + حد الاستدعاء ──

let factoryOverride: (() => SegmentResolver | null) | null = null;
/** للاختبار فقط: يستبدل مصنع المزوّد (mock) بدل الاتصال بالبيئة. null = رجوع للبيئة. */
export function __setSegmentResolverFactoryForTests(f: (() => SegmentResolver | null) | null): void {
  factoryOverride = f;
}

/** المزوّد الفعلي (من البيئة أو الـmock) — null = حتمي فقط. */
export function activeSegmentResolver(): { resolver: SegmentResolver | null; provider: string | null } {
  if (factoryOverride) return { resolver: factoryOverride(), provider: "test" };
  const cfg = readResolverConfig();
  const resolver = createSegmentResolver(cfg);
  return { resolver, provider: resolver ? `${cfg.provider}:${cfg.model}` : null };
}

/**
 * يلفّ المزوّد بحد الاستدعاء لكل (موظف + نشاط): العدّ بيحصل **لحظة النداء الفعلي** بس
 * (يعني لما فيه أجزاء غير محلولة)، ولما الحد يتخطى بيرجع null والتحليل يكمل حتميًا.
 */
export function rateLimitedResolver(inner: SegmentResolver | null, key: string): SegmentResolver | null {
  if (!inner) return null;
  return async (segments, terms) => {
    if (!allowAiCall(key)) {
      console.warn(`[orderParse:ai] rate limit reached for ${key} — deterministic only`);
      return null;
    }
    return inner(segments, terms);
  };
}
