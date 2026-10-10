import { useEffect, useMemo, useState } from "react";
import { BookOpen, ShieldCheck, Lock } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { SectionCard, StatusBadge, LoadingSkeleton, ErrorState, PermissionDeniedState } from "@/components/shared";
import { toast } from "sonner";
import { permissionLabel, roleLabel } from "@shared/permissionLabels";

/**
 * صلاحيات الأدوار (tenant_role_permissions) — للمالك. تعرض كل الصلاحيات بأسماء عربية، ومنها دفتر
 * الحسابات V3 (`ledger.*`). ما هو «للمالك فقط» (إعادة فتح الشهر/التفعيل) يُعرض معطّلًا لغير المالك
 * لأن السيرفر لا يمنحه حتى مع override. الإخفاء/التعطيل هنا تسهيل؛ الحكم على السيرفر.
 * المرحلة 7F (عرض فقط): نفس الاستعلام والحفظ (permissionConfiguration / rolePermissionSave) ونفس
 * invalidate لـauth.myPermissions فور الحفظ؛ صفوف 44px، حالات Loading/Error/Denied، وبلا ألوان خام.
 */
// messages.view_private: اطلاع المالك على المحادثات الخاصة — مقفولة لكل دور غير المالك (السيرفر يرفض المنح).
const OWNER_ONLY = new Set(["ledger.period.reopen", "ledger.activate", "messages.view_private"]);

export function PermissionSettings() {
  const utils = trpc.useUtils();
  const configuration = trpc.accountingV2.permissionConfiguration.useQuery(undefined, { retry: false });
  const [role, setRole] = useState("");
  const save = trpc.accountingV2.rolePermissionSave.useMutation({
    onSuccess: async () => { toast.success("تم حفظ الصلاحية"); await utils.accountingV2.permissionConfiguration.invalidate(); await utils.auth.myPermissions.invalidate(); },
    onError: error => toast.error(error.message),
  });
  useEffect(() => { if (!role && configuration.data?.roles[0]) setRole(configuration.data.roles[0].role); }, [configuration.data, role]);
  const effective = useMemo(() => {
    const defaults = new Set(configuration.data?.roles.find(row => row.role === role)?.defaultPermissions ?? []);
    for (const override of configuration.data?.overrides.filter(row => row.role === role) ?? [])
      override.isAllowed ? defaults.add(override.permission as any) : defaults.delete(override.permission as any);
    return defaults;
  }, [configuration.data, role]);
  if (configuration.error?.data?.code === "FORBIDDEN") return <PermissionDeniedState message="منح الصلاحيات للمالك فقط." />;
  if (configuration.isLoading) return <LoadingSkeleton variant="form" rows={6} />;
  if (configuration.error) return <ErrorState message={configuration.error.message} onRetry={() => configuration.refetch()} />;
  const ledgerPerms = (configuration.data?.permissions ?? []).filter(p => p.startsWith("ledger."));
  const otherPerms = (configuration.data?.permissions ?? []).filter(p => !p.startsWith("ledger."));
  const ownerRole = role === "super_admin";
  const overridesCount = configuration.data?.overrides.filter(row => row.role === role).length ?? 0;
  const Row = ({ permission }: { permission: string }) => {
    const locked = OWNER_ONLY.has(permission) && !ownerRole;
    const checked = effective.has(permission as any) && !locked;
    return (
      <label className={`flex min-h-11 items-center justify-between gap-3 rounded-[var(--radius-brand-md)] border border-border p-3 text-sm transition-colors duration-[var(--duration-fast)] ${checked ? "bg-accent/40" : "bg-card"} ${locked ? "opacity-70" : ""}`} data-testid={`perm-${permission}`}>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">{locked && <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}<span className="truncate">{permissionLabel(permission)}</span></span>
          <span className="block font-mono text-[11px] text-muted-foreground" dir="ltr">{permission}</span>
        </span>
        <Switch
          checked={checked}
          disabled={save.isPending || locked}
          aria-label={permissionLabel(permission)}
          onCheckedChange={isAllowed => save.mutate({ role: role as any, permission: permission as any, isAllowed })}
        />
      </label>
    );
  };
  return (
    <div className="space-y-4" dir="rtl" data-testid="permission-settings">
      <SectionCard title={<span className="inline-flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" /> صلاحيات الأدوار</span>} description="الصلاحيات تُحفظ فورًا وتسري على الجلسات بعد التحديث التالي — الحكم النهائي على السيرفر.">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 sm:max-w-xs">
            <Label htmlFor="perm-role" className="mb-1 block text-xs text-muted-foreground">الدور</Label>
            <select id="perm-role" className="h-11 w-full rounded-[var(--radius-brand-md)] border border-input bg-background px-3 text-sm md:h-9" value={role} onChange={event => setRole(event.target.value)} data-testid="perm-role">
              {configuration.data?.roles.map(row => <option key={row.role} value={row.role}>{roleLabel(row.role)}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2 pb-1">
            {ownerRole ? <StatusBadge status="owner" label="المالك — كل الصلاحيات" tone="primary" size="sm" icon={<ShieldCheck className="h-3 w-3" aria-hidden="true" />} /> : <StatusBadge status="overrides" label={overridesCount > 0 ? `${overridesCount.toLocaleString("ar-EG")} تخصيص لهذا الدور` : "الافتراضي"} tone={overridesCount > 0 ? "info" : "neutral"} size="sm" icon={null} />}
          </div>
        </div>
      </SectionCard>

      <SectionCard title={<span className="inline-flex items-center gap-2"><BookOpen className="h-4 w-4" aria-hidden="true" /> دفتر الحسابات (V3)</span>} testId="perm-ledger">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{ledgerPerms.map(p => <Row key={p} permission={p} />)}</div>
        {!ownerRole && <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground"><Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> إعادة فتح الشهر والتفعيل للمالك فقط ولا يُمنحان لأي دور آخر.</p>}
      </SectionCard>

      <SectionCard title="باقي الصلاحيات" testId="perm-other">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{otherPerms.map(p => <Row key={p} permission={p} />)}</div>
      </SectionCard>
    </div>
  );
}
