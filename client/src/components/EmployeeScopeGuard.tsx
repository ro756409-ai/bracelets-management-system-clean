import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  EMPLOYEE_SESSION_KEY,
  readEmployeeScope,
  resetEmployeeClientState,
  scopeFingerprint,
} from "@/lib/employeeScope";

/**
 * حارس هوية الموظف — **مركّب في جذر التطبيق**.
 *
 * تسجيل الخروج متكرر في ٨ مواضع (لوحات مختلفة + مسارات انتهاء الجلسة)، وكل موضع فرصة
 * إن حد ينسى يمسح cache الاستعلامات. الحارس ده بيقيس **بصمة الحساب** بدل ما يعتمد على
 * إن كل موضع يفتكر: أول ما البصمة تتغيّر (دخول، خروج، انتهاء جلسة، أو حتى تعديل يدوي
 * في localStorage) بيمسح cache react-query كله ومسودات الحسابات التانية.
 *
 * بيراقب حدث `storage` كمان، فتسجيل الخروج من تاب تاني بينضّف التاب ده برضه.
 *
 * طبقة واجهة بحتة — العزل الحقيقي على السيرفر (`empScope` → نشاط الموظف). الحارس ده
 * بيمنع **عرض** بيانات حساب سابق من الـcache، مش بيمنح أي صلاحية.
 */
export function EmployeeScopeGuard() {
  const queryClient = useQueryClient();
  // أول قراءة بتسجّل البصمة الحالية من غير مسح — تحديث الصفحة العادي مايضيّعش الـcache.
  const last = useRef<string>(scopeFingerprint(readEmployeeScope()));

  useEffect(() => {
    const check = () => {
      const scope = readEmployeeScope();
      const fp = scopeFingerprint(scope);
      if (fp === last.current) return;
      last.current = fp;
      resetEmployeeClientState(queryClient, scope);
    };
    // تغيير من تاب تاني (خروج/دخول هناك).
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === EMPLOYEE_SESSION_KEY) check();
    };
    window.addEventListener("storage", onStorage);
    // تغيير في نفس التاب مابيطلّعش حدث storage، فبنسأل دوريًا بسعر تافه.
    const timer = window.setInterval(check, 1000);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.clearInterval(timer);
    };
  }, [queryClient]);

  return null;
}
