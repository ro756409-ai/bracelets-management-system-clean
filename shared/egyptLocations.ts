/**
 * Egypt's 27 governorates and their cities/markaz — one source of truth.
 *
 * Why this file exists: the confirmation employee's governorate dropdown read from
 * `accountingV2.configurationListForBusinesses("governorate")`, a per-business
 * configuration table. Nobody had populated it, so the dropdown rendered empty and
 * the employee could not set a governorate at all. And the city field was free text,
 * so the same place arrived spelled five different ways and the Bosta export had to
 * guess.
 *
 * The configured list still wins when a business has curated one (a merchant who only
 * ships to Cairo and Giza should see two options, not twenty-seven). This is the
 * fallback underneath it, and the source for cities either way.
 *
 * Names match the canonical spellings already used by shared/facebookOrderParser.ts —
 * the parser writes `orders.governorate` from the same list, so a parsed order opens
 * in the edit modal with its governorate already selected instead of blank.
 *
 * City lists cover the markaz/qism level a courier actually needs. They are not
 * exhaustive down to the village, which is why `isKnownCity()` exists and why the UI
 * keeps a free-text escape hatch for an address the list does not name.
 */

export type Governorate = {
  /** Canonical Arabic name — the value stored in `orders.governorate`. */
  name: string;
  /** Cities / markaz within the governorate, stored in `orders.city`. */
  cities: readonly string[];
};

export const EGYPT_GOVERNORATES: readonly Governorate[] = [
  {
    name: "القاهرة",
    cities: [
      "مدينة نصر", "مصر الجديدة", "المعادي", "حلوان", "المقطم", "التجمع الخامس",
      "الشروق", "بدر", "العبور", "الرحاب", "مدينتي", "شبرا", "روض الفرج",
      "الساحل", "الزيتون", "حدائق القبة", "عين شمس", "المطرية", "الزاوية الحمراء",
      "السيدة زينب", "مصر القديمة", "الخليفة", "الدرب الأحمر", "الأزبكية",
      "باب الشعرية", "الموسكي", "الجمالية", "الوايلي", "منشية ناصر", "البساتين",
      "دار السلام", "طرة", "المرج", "السلام", "النزهة", "وسط البلد", "الزمالك",
      "جاردن سيتي", "15 مايو",
    ],
  },
  {
    name: "الجيزة",
    cities: [
      "الدقي", "العجوزة", "المهندسين", "الهرم", "فيصل", "6 أكتوبر", "الشيخ زايد",
      "بولاق الدكرور", "إمبابة", "الوراق", "أوسيم", "كرداسة", "أبو النمرس",
      "البدرشين", "الحوامدية", "العياط", "الصف", "أطفيح", "منشأة القناطر",
      "الواحات البحرية", "المنيب", "حدائق الأهرام", "المريوطية",
    ],
  },
  {
    name: "الإسكندرية",
    cities: [
      "سموحة", "سيدي جابر", "المنتزه", "ميامي", "العصافرة", "المندرة", "أبو قير",
      "سيدي بشر", "لوران", "جليم", "ستانلي", "كامب شيزار", "الإبراهيمية",
      "محطة الرمل", "المنشية", "العطارين", "كرموز", "محرم بك", "باكوس",
      "فيكتوريا", "العجمي", "برج العرب", "الدخيلة", "المكس", "أمرية",
      "الورديان", "المعمورة", "خورشيد",
    ],
  },
  {
    name: "الدقهلية",
    cities: [
      "المنصورة", "طلخا", "ميت غمر", "دكرنس", "أجا", "منية النصر", "السنبلاوين",
      "الكردي", "بني عبيد", "المنزلة", "تمي الأمديد", "الجمالية", "شربين",
      "المطرية", "بلقاس", "ميت سلسيل", "جمصة", "محلة دمنة", "نبروه",
    ],
  },
  {
    name: "الشرقية",
    cities: [
      "الزقازيق", "بلبيس", "منيا القمح", "أبو حماد", "ههيا", "أبو كبير",
      "فاقوس", "الإبراهيمية", "ديرب نجم", "كفر صقر", "أولاد صقر", "الحسينية",
      "صان الحجر", "مشتول السوق", "القنايات", "العاشر من رمضان", "القرين",
      "أنشاص", "الصالحية الجديدة",
    ],
  },
  {
    name: "القليوبية",
    cities: [
      "بنها", "شبرا الخيمة", "قليوب", "الخانكة", "كفر شكر", "طوخ", "قها",
      "العبور", "الخصوص", "شبين القناطر", "القناطر الخيرية", "أبو زعبل",
      "مسطرد", "بهتيم",
    ],
  },
  {
    name: "الغربية",
    cities: [
      "طنطا", "المحلة الكبرى", "كفر الزيات", "زفتى", "السنطة", "قطور",
      "بسيون", "سمنود",
    ],
  },
  {
    name: "المنوفية",
    cities: [
      "شبين الكوم", "منوف", "سرس الليان", "أشمون", "الباجور", "قويسنا",
      "بركة السبع", "تلا", "الشهداء", "السادات",
    ],
  },
  {
    name: "البحيرة",
    cities: [
      "دمنهور", "كفر الدوار", "رشيد", "إدكو", "أبو المطامير", "أبو حمص",
      "الدلنجات", "المحمودية", "الرحمانية", "إيتاي البارود", "حوش عيسى",
      "شبراخيت", "كوم حمادة", "بدر", "وادي النطرون", "النوبارية الجديدة",
    ],
  },
  {
    name: "كفر الشيخ",
    cities: [
      "كفر الشيخ", "دسوق", "فوه", "مطوبس", "بلطيم", "الحامول", "بيلا",
      "الرياض", "سيدي سالم", "قلين", "سيدي غازي", "برج البرلس",
    ],
  },
  {
    name: "دمياط",
    cities: [
      "دمياط", "دمياط الجديدة", "رأس البر", "فارسكور", "الزرقا", "السرو",
      "الروضة", "كفر البطيخ", "عزبة البرج", "كفر سعد",
    ],
  },
  {
    name: "بورسعيد",
    cities: [
      "بورسعيد", "بورفؤاد", "العرب", "حي الزهور", "حي الضواحي", "حي المناخ",
      "حي الشرق", "حي الجنوب",
    ],
  },
  {
    name: "الإسماعيلية",
    cities: [
      "الإسماعيلية", "فايد", "القنطرة شرق", "القنطرة غرب", "التل الكبير",
      "أبو صوير", "القصاصين الجديدة", "نفيشة",
    ],
  },
  {
    name: "السويس",
    cities: ["السويس", "الأربعين", "عتاقة", "الجناين", "فيصل", "عين السخنة"],
  },
  {
    name: "الفيوم",
    cities: [
      "الفيوم", "الفيوم الجديدة", "طامية", "سنورس", "إطسا", "إبشواي",
      "يوسف الصديق",
    ],
  },
  {
    name: "بني سويف",
    cities: [
      "بني سويف", "بني سويف الجديدة", "الواسطى", "ناصر", "إهناسيا",
      "ببا", "الفشن", "سمسطا",
    ],
  },
  {
    name: "المنيا",
    cities: [
      "المنيا", "المنيا الجديدة", "العدوة", "مغاغة", "بني مزار", "مطاي",
      "سمالوط", "المدينة الفكرية", "ملوي", "دير مواس", "أبو قرقاص",
    ],
  },
  {
    name: "أسيوط",
    cities: [
      "أسيوط", "أسيوط الجديدة", "ديروط", "منفلوط", "القوصية", "أبنوب",
      "أبو تيج", "الغنايم", "ساحل سليم", "البداري", "صدفا",
    ],
  },
  {
    name: "سوهاج",
    cities: [
      "سوهاج", "سوهاج الجديدة", "أخميم", "أخميم الجديدة", "البلينا",
      "المراغة", "المنشاة", "دار السلام", "جرجا", "جهينة الغربية",
      "ساقلته", "طما", "طهطا", "الكوثر",
    ],
  },
  {
    name: "قنا",
    cities: [
      "قنا", "قنا الجديدة", "أبو تشت", "نجع حمادي", "دشنا", "الوقف",
      "قفط", "نقادة", "فرشوط", "قوص",
    ],
  },
  {
    name: "الأقصر",
    cities: [
      "الأقصر", "الأقصر الجديدة", "إسنا", "طيبة الجديدة", "الزينية",
      "البياضية", "القرنة", "أرمنت", "الطود",
    ],
  },
  {
    name: "أسوان",
    cities: [
      "أسوان", "أسوان الجديدة", "دراو", "كوم أمبو", "نصر النوبة", "كلابشة",
      "إدفو", "الرديسية", "البصيلية", "السباعية", "أبو سمبل السياحية",
    ],
  },
  {
    name: "البحر الأحمر",
    cities: [
      "الغردقة", "رأس غارب", "سفاجا", "القصير", "مرسى علم", "الشلاتين",
      "حلايب", "الدهار", "سهل حشيش", "الجونة",
    ],
  },
  {
    name: "الوادي الجديد",
    cities: ["الخارجة", "الداخلة", "الفرافرة", "باريس", "بلاط"],
  },
  {
    name: "مطروح",
    cities: [
      "مرسى مطروح", "الحمام", "العلمين", "الضبعة", "النجيلة", "سيدي براني",
      "السلوم", "سيوة", "مارينا", "الساحل الشمالي",
    ],
  },
  {
    name: "شمال سيناء",
    cities: ["العريش", "الشيخ زويد", "رفح", "بئر العبد", "الحسنة", "نخل"],
  },
  {
    name: "جنوب سيناء",
    cities: [
      "الطور", "شرم الشيخ", "دهب", "نويبع", "طابا", "سانت كاترين",
      "أبو رديس", "أبو زنيمة", "رأس سدر",
    ],
  },
] as const;

/** Canonical governorate names, in the order they should appear in a dropdown. */
export const GOVERNORATE_NAMES: readonly string[] = EGYPT_GOVERNORATES.map(
  g => g.name
);

const BY_NAME = new Map(EGYPT_GOVERNORATES.map(g => [g.name, g]));

/**
 * Cities of a governorate. Returns `[]` for an unknown or empty name rather than
 * throwing — the caller is a dropdown that renders "اختر المحافظة أولاً" in that case,
 * and an order imported years ago may carry a governorate spelling this list predates.
 */
export function citiesOf(governorate: string | null | undefined): readonly string[] {
  if (!governorate) return [];
  return BY_NAME.get(governorate.trim())?.cities ?? [];
}

export function isKnownGovernorate(name: string | null | undefined): boolean {
  return !!name && BY_NAME.has(name.trim());
}

/**
 * Whether a city belongs to a governorate. Used to decide if a stored city should stay
 * selected when the modal opens, or be shown as a free-text value the list does not cover.
 */
export function isKnownCity(
  governorate: string | null | undefined,
  city: string | null | undefined
): boolean {
  if (!city) return false;
  return citiesOf(governorate).includes(city.trim());
}
