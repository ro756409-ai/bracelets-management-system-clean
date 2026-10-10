import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { router, type authenticatedProcedure } from "./_core/trpc";
import { tenantPermissionsForRole, isOwnerRole, type Permission } from "./permissions";
import * as svc from "./messaging.service";
import { REACTIONS } from "../shared/messagingSpec";

/**
 * مسارات مركز الرسائل (tRPC) — نفس التعريف يُركَّب مرتين:
 *   • `messages`               → هوية جلسة الويب (ctx.employee + ctx.tenantId من createContext).
 *   • `employeePortal.messages` → هوية كوكي البوابة فقط (لا تتأثر بجلسة مالك مفتوحة في نفس المتصفح).
 *
 * القواعد:
 *   • الفاعل (tenant/الموظف) من الجلسة فقط؛ كل المدخلات strict فلا tenantId/employeeId من العميل.
 *   • الصلاحيات تُقرأ من الـDB في **كل طلب** (الافتراضي + تجاوزات الشركة) — السحب يسري من الطلب التالي.
 *     جلسة الأدمن الصناعية لا تمنح شيئًا هنا (عكس permissionProcedure): الحكم لدور الموظف الفعلي.
 *   • messages.use شرط كل إجراء؛ voice/announce/manage_groups فوقه حسب الإجراء.
 *   • messages.view_private: لدور المالك فقط وبمنح صريح (مقفولة افتراضيًا) — يُمرَّر للخدمة كقيمة منطقية،
 *     والخدمة تتحقق مجددًا من دور المالك في الـDB.
 *   • العلم معطّل: status/conversations/since تُرجع { enabled: false }؛ الباقي PRECONDITION_FAILED من الخدمة.
 */
export type MessagingIdentity = (ctx: any) => svc.MessagingActor;

export type MessagingPermsResolved = svc.MessagingPerms & { use: boolean };
export async function resolveMessagingPerms(tenantId: number, role: string | null | undefined): Promise<MessagingPermsResolved> {
  const granted = new Set<Permission>(await tenantPermissionsForRole(tenantId, role));
  return {
    use: granted.has("messages.use"),
    voice: granted.has("messages.voice"),
    announce: granted.has("messages.announce"),
    manageGroups: granted.has("messages.manage_groups"),
    viewPrivate: granted.has("messages.view_private") && isOwnerRole(role),
  };
}

const forbidden = (message = "ليس لديك صلاحية لتنفيذ هذا الإجراء") => new TRPCError({ code: "FORBIDDEN", message });
const ID = z.number().int().positive();

export function buildMessagingRouter(base: typeof authenticatedProcedure, identity: MessagingIdentity) {
  /** الفاعل + الصلاحيات من الـDB؛ messages.use إلزامية، و`extra` إن طُلبت. */
  const gated = (extra?: keyof svc.MessagingPerms) => base.use(async ({ ctx, next }) => {
    const actor = identity(ctx);
    const perms = await resolveMessagingPerms(actor.tenantId, actor.role);
    if (!perms.use) throw forbidden("الرسائل غير متاحة لك");
    if (extra && !perms[extra]) throw forbidden();
    return next({ ctx: { ...ctx, messaging: { actor, perms } } });
  });
  const use = gated();
  const m = (ctx: any) => ctx.messaging as { actor: svc.MessagingActor; perms: MessagingPermsResolved };

  return router({
    /** حالة المركز وصلاحياتي (بلا شرط messages.use — لتقرر الواجهة الإظهار). */
    status: base.query(async ({ ctx }) => {
      const actor = identity(ctx);
      const perms = await resolveMessagingPerms(actor.tenantId, actor.role);
      return { enabled: svc.messagingEnabled(), permissions: perms };
    }),
    bootstrap: use.mutation(async ({ ctx }) => svc.ensureDefaults(m(ctx).actor)),
    conversations: use.query(async ({ ctx }) => {
      if (!svc.messagingEnabled()) return { enabled: false as const };
      return { enabled: true as const, ...(await svc.listConversations(m(ctx).actor, m(ctx).perms)) };
    }),
    since: use.input(z.object({ cursor: z.number().int().min(0) }).strict()).query(async ({ ctx, input }) => {
      if (!svc.messagingEnabled()) return { enabled: false as const };
      return { enabled: true as const, ...(await svc.changesSince(m(ctx).actor, input.cursor)) };
    }),
    directory: use.query(async ({ ctx }) => svc.directory(m(ctx).actor)),
    read: use.input(svc.readInput).query(async ({ ctx, input }) => svc.readMessages(m(ctx).actor, m(ctx).perms, input)),
    send: use.input(svc.sendInput).mutation(async ({ ctx, input }) => svc.sendMessage(m(ctx).actor, m(ctx).perms, input)),
    edit: use.input(svc.editInput).mutation(async ({ ctx, input }) => svc.editMessage(m(ctx).actor, input)),
    remove: use.input(z.object({ messageId: ID }).strict()).mutation(async ({ ctx, input }) => svc.deleteMessage(m(ctx).actor, input)),
    history: use.input(z.object({ messageId: ID }).strict()).query(async ({ ctx, input }) => svc.messageHistory(m(ctx).actor, m(ctx).perms, input)),
    react: use.input(z.object({ messageId: ID, reaction: z.enum(REACTIONS) }).strict()).mutation(async ({ ctx, input }) => svc.react(m(ctx).actor, input)),
    markRead: use.input(z.object({ conversationId: ID, messageId: ID }).strict()).mutation(async ({ ctx, input }) => svc.markRead(m(ctx).actor, input, m(ctx).perms)),
    ack: use.input(z.object({ messageId: ID }).strict()).mutation(async ({ ctx, input }) => svc.ackAnnouncement(m(ctx).actor, input)),
    startDirect: use.input(z.object({ employeeId: ID }).strict()).mutation(async ({ ctx, input }) => svc.startDirect(m(ctx).actor, input)),
    createGroup: gated("manageGroups").input(svc.groupInput).mutation(async ({ ctx, input }) => svc.createGroup(m(ctx).actor, m(ctx).perms, input)),
    announcementReads: gated("announce").input(z.object({ messageId: ID }).strict()).query(async ({ ctx, input }) => svc.announcementReads(m(ctx).actor, m(ctx).perms, input)),
  });
}

/** هوية الويب: صف الموظف من createContext (نشط) ونفس tenant الجلسة. */
export const webMessagingIdentity: MessagingIdentity = ctx => {
  const emp = ctx.employee;
  if (!emp || ctx.tenantId == null || emp.tenantId !== ctx.tenantId) throw forbidden("تعذّر تحديد الموظف");
  return { tenantId: ctx.tenantId, employeeId: emp.id, role: emp.role ?? null, businessId: emp.businessId ?? null };
};
/** هوية البوابة: كوكي الموظف فقط (employeePortalProcedure يحقن ctx.employee النشط). */
export const portalMessagingIdentity: MessagingIdentity = ctx => {
  const emp = ctx.employee;
  if (!emp || emp.tenantId == null) throw new TRPCError({ code: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً" });
  return { tenantId: emp.tenantId, employeeId: emp.id, role: emp.role ?? null, businessId: emp.businessId ?? null };
};
