import { brandInitial } from "@shared/branding";

/**
 * هوية النشاط المرئية: اللوجو لو موجود، وإلا أول حرف من اسم البراند.
 * الاسم واللوجو من قاعدة البيانات (`businesses.activeList`) — مفيش أي اسم مكتوب هنا.
 */
export function BusinessAvatar({
  name,
  logoUrl,
  className = "h-9 w-9",
  textClassName = "text-base",
}: {
  name: string | null | undefined;
  logoUrl: string | null | undefined;
  className?: string;
  textClassName?: string;
}) {
  const label = (name ?? "").trim() || "نشاط";
  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={label}
        title={label}
        className={`${className} shrink-0 rounded-full object-cover bg-white`}
        data-testid="business-logo"
      />
    );
  }
  return (
    <div
      className={`${className} shrink-0 rounded-full bg-gradient-to-br from-primary to-primary-dark flex items-center justify-center text-white font-bold ${textClassName}`}
      role="img"
      aria-label={label}
      title={label}
      data-testid="business-initial"
    >
      {brandInitial(label)}
    </div>
  );
}
