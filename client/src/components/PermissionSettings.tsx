import { useEffect, useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { permissionLabel, roleLabel } from "@shared/permissionLabels";

/**
 * صلاحيات الأدوار (tenant_role_permissions) — للمالك. تعرض كل الصلاحيات بأسماء عربية، ومنها دفتر
 * الحسابات V3 (`ledger.*`). ما هو «للمالك فقط» (إعادة فتح الشهر/التفعيل) يُعرض معطّلًا لغير المالك
 * لأن السيرفر لا يمنحه حتى مع override. الإخفاء/التعطيل هنا تسهيل؛ الحكم على السيرفر.
 */
const OWNER_ONLY = new Set(["ledger.period.reopen", "ledger.activate"]);

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
  if (configuration.error?.data?.code === "FORBIDDEN") return null;
  const ledgerPerms = (configuration.data?.permissions ?? []).filter(p => p.startsWith("ledger."));
  const otherPerms = (configuration.data?.permissions ?? []).filter(p => !p.startsWith("ledger."));
  const ownerRole = role === "super_admin";
  const Row = ({ permission }: { permission: string }) => {
    const locked = OWNER_ONLY.has(permission) && !ownerRole;
    return (
      <label className="flex min-h-11 items-center justify-between gap-3 rounded-lg border p-3 text-sm" data-testid={`perm-${permission}`}>
        <span className="min-w-0">
          <span className="block">{permissionLabel(permission)}</span>
          <span className="block font-mono text-[11px] text-muted-foreground" dir="ltr">{permission}</span>
        </span>
        <Switch checked={effective.has(permission as any) && !locked} disabled={save.isPending || locked}
          onCheckedChange={isAllowed => save.mutate({ role: role as any, permission: permission as any, isAllowed })} />
      </label>
    );
  };
  return (
    <Card dir="rtl">
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-5 w-5 text-rose-700" /> صلاحيات الأدوار</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <select className="h-11 w-full max-w-xs rounded-md border bg-background px-3 text-sm" value={role} onChange={event => setRole(event.target.value)} data-testid="perm-role">
          {configuration.data?.roles.map(row => <option key={row.role} value={row.role}>{roleLabel(row.role)}</option>)}
        </select>
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">دفتر الحسابات (V3)</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{ledgerPerms.map(p => <Row key={p} permission={p} />)}</div>
          {!ownerRole && <p className="text-xs text-muted-foreground">إعادة فتح الشهر والتفعيل للمالك فقط ولا يُمنحان لأي دور آخر.</p>}
        </section>
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">باقي الصلاحيات</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{otherPerms.map(p => <Row key={p} permission={p} />)}</div>
        </section>
      </CardContent>
    </Card>
  );
}
