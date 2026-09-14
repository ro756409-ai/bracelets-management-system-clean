import type { ReactNode } from "react";
import { PageHeader } from "@/components/shared";
import { WorkspaceTabs } from "@/components/shell/WorkspaceTabs";
import type { NavLink } from "@/config/navigation";

/**
 * إطار الـWorkspace الموحّد لـMatjarak V2 — رأس واحد + تبويبات ثانوية + محتوى، بمسافات
 * ثابتة من الـtokens. ده الأساس اللي وجهات V2 (الطلبات/المخزون…) هتتبني عليه في المراحل
 * الجاية بدل ما كل صفحة تخترع رأسها وتباعدها.
 *
 * **بيعيد استخدام المكوّنات الموجودة** (PageHeader المشترك + WorkspaceTabs) — مفيش تكرار.
 * الرأس بياخد Primary action **واحد** بارز + إجراءات ثانوية هادية (تسلسل الأزرار الموحّد).
 * RTL افتراضي. لا API/backend/permissions/business-scope هنا — عرض بحت.
 */
export function WorkspaceShell({
  title,
  description,
  icon,
  /** الإجراء الأهم — واحد بس، بارز (Primary). */
  primaryAction,
  /** إجراءات ثانوية هادية (outline/ghost) أو overflow. */
  actions,
  /** تبويبات القسم (أبناء الوجهة من NavConfig) — بتظهر لو أكتر من واحد. */
  tabs,
  children,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  primaryAction?: ReactNode;
  actions?: ReactNode;
  tabs?: NavLink[];
  children: ReactNode;
}) {
  return (
    <div className="space-y-5" dir="rtl">
      <PageHeader
        title={title}
        description={description}
        icon={icon}
        primaryAction={primaryAction}
        actions={actions}
      />
      {tabs && tabs.length > 1 && <WorkspaceTabs tabs={tabs} />}
      <div className="space-y-4">{children}</div>
    </div>
  );
}
