/**
 * الهوية البصرية — نقطة استيراد واحدة (المرحلة 6).
 *   • `BrandMark`/`BrandLogo`: علامة «متجرك» الحالية (placeholder معتمد مؤقتًا — الشعار النهائي الرسمي غير موجود في المشروع؛ راجع client/src/assets/brand/README.md).
 *   • `PartnerLogo`: شعارات الجهات الرسمية من ملفات محلية + manifest.
 *   • `SectionIcon`: slots أيقونات الأقسام ثلاثية الأبعاد (placeholder حتى تصل الحزمة).
 */
export { BrandMark } from "../BrandMark";
export { BrandLogo, type BrandLogoProps, type BrandLogoSize, type BrandLogoVariant } from "../BrandLogo";
export { PartnerLogo, PARTNER_ASSETS, PARTNERS_BY_ID, PARTNER_IDS, PARTNER_LOGO_HEIGHT, PARTNER_BASE_PATH, type PartnerId, type PartnerLogoProps, type PartnerLogoSize, type PartnerAsset } from "./PartnerLogo";
export { SectionIcon, SECTION_ICONS, SECTION_ICON_PX, SECTION_ICON_BASE_PATH, type SectionIconId, type SectionIconSize, type SectionIconAsset } from "./SectionIcon";
