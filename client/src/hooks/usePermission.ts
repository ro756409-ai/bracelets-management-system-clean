import { trpc } from "@/lib/trpc";

/**
 * صلاحيات الجلسة الحالية، من السيرفر.
 *
 * الشاشة مابتستنتجش من الدور. لو كل شاشة حسبت بنفسها «الدور ده يعني يقدر»، بيبقى فيه
 * نسختين من قواعد الصلاحيات — واحدة في `permissions.ts` وواحدة مبعترة في الواجهة —
 * والاتنين بيفرقوا في يوم. الـhook ده بيقرا نفس القايمة اللي السيرفر بيحكم بيها.
 *
 * **الإخفاء في الواجهة مش أمان.** الحارس الحقيقي على الـendpoint نفسه
 * (`permissionProcedure`)؛ اللي هنا عشان المستخدم ما يكتبش تعديل ويستنى عشان ياخد رفض.
 */
export function usePermissions(): {
  permissions: string[];
  isLoading: boolean;
  has: (permission: string) => boolean;
} {
  const query = trpc.auth.myPermissions.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const permissions = query.data ?? [];
  return {
    permissions,
    isLoading: query.isLoading,
    has: (permission: string) => permissions.includes(permission as never),
  };
}

/** صلاحية واحدة — الشكل الأكثر استخدامًا. */
export function usePermission(permission: string): boolean {
  return usePermissions().has(permission);
}
