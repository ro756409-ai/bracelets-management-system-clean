import { ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/shared";
import { PermissionSettings } from "@/components/PermissionSettings";

/** صفحة المالك لمنح الصلاحيات — مستقلة عن صفحات المحاسبة المجمّدة. */
export default function PermissionsPage() {
  return (
    <div className="space-y-4 pb-24 sm:pb-6" dir="rtl">
      <PageHeader title="صلاحيات الأدوار" description="ما يستطيع كل دور فعله — بما فيه دفتر الحسابات" icon={<ShieldCheck className="h-5 w-5" />} />
      <PermissionSettings />
    </div>
  );
}
