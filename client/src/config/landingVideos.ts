/**
 * فيديوهات الصفحة الرئيسية — YouTube **Unlisted** فقط. كل خانة فاضية (youtubeId = null) لحد ما المالك يرفع الفيديو الحقيقي
 * ويحط معرّفه هنا؛ الخانة الفاضية بتعرض بديل مصمم (مش رابط وهمي ولا صورة مزيفة).
 *  • youtubeId: الـ11 حرف من رابط يوتيوب (watch?v=XXXXXXXXXXX). أي قيمة غير صالحة = كأنها فاضية.
 *  • cover: صورة غلاف حقيقية من النظام (لقطة من حساب عرض ببيانات تجريبية) تحت client/public/landing/ — null = بديل CSS.
 *  • التشغيل من youtube-nocookie.com وبعد ضغط المستخدم بس (مفيش تحميل لطرف تالت قبل الضغط).
 * سكريبتات الفيديو نفسها مؤجلة (خارج النطاق).
 */
export type VideoSlot = "hero" | "walkthrough" | "orders" | "inventory" | "integrations";
export type LandingVideo = {
  slot: VideoSlot;
  youtubeId: string | null;
  cover: string | null;
  title: { ar: string; en: string };
  description: { ar: string; en: string };
};

export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
export const validYoutubeId = (id: string | null | undefined): string | null => (id && YOUTUBE_ID_RE.test(id) ? id : null);
export const youtubeEmbedUrl = (id: string) => `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1`;
export const validCover = (src: string | null | undefined): string | null => (src && /^\/landing\/[A-Za-z0-9_-]+\.(webp|png|jpe?g)$/.test(src) ? src : null);

export const LANDING_VIDEOS: readonly LandingVideo[] = [
  { slot: "hero", youtubeId: null, cover: null,
    title: { ar: "متجرك في دقيقتين", en: "Matjarak in two minutes" },
    description: { ar: "جولة سريعة من الأوردر لحد الشحن.", en: "A quick tour from order to shipment." } },
  { slot: "walkthrough", youtubeId: null, cover: null,
    title: { ar: "جولة كاملة في النظام", en: "Full system walkthrough" },
    description: { ar: "الإعداد، الفريق، والقنوات.", en: "Setup, team and channels." } },
  { slot: "orders", youtubeId: null, cover: null,
    title: { ar: "الأوردرات والتأكيد", en: "Orders and confirmation" },
    description: { ar: "من وصول الأوردر لحد تأكيده وتجهيزه.", en: "From an incoming order to confirmation and preparation." } },
  { slot: "inventory", youtubeId: null, cover: null,
    title: { ar: "المخزون والجرد", en: "Stock and stocktakes" },
    description: { ar: "الحجز والخصم والمرتجعات والجرد.", en: "Reservation, deduction, returns and stocktakes." } },
  { slot: "integrations", youtubeId: null, cover: null,
    title: { ar: "Easy Order وبوسطة", en: "Easy Order and Bosta" },
    description: { ar: "ربط القنوات وإرسال الشحنات وطباعة البوالص.", en: "Connecting channels, sending shipments and printing waybills." } },
];

export const videoForSlot = (slot: VideoSlot, list: readonly LandingVideo[] = LANDING_VIDEOS) => list.find(v => v.slot === slot) ?? null;
