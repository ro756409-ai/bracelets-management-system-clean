import { ClipboardCheck } from "lucide-react";
import { AccCard } from "./ui";

/** الجرد — placeholder في P2؛ التنفيذ الحقيقي (جداول + اعتماد يحرّك المخزون) في P2-C. */
export default function AccStocktake() {
  return (
    <AccCard className="flex flex-col items-center justify-center gap-3 py-14 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-100">
        <ClipboardCheck className="h-7 w-7 text-slate-400" />
      </div>
      <h3 className="text-lg font-bold text-slate-800">الجرد — قيد التجهيز</h3>
      <p className="max-w-md text-sm text-slate-500">
        هتقدر تبدأ جردة وتدخل العدد الفعلي وتشوف الفرق والقيمة، وكل جردة تتحفظ كسجل مستقل.
        اعتماد الفروق على المخزون هيكون بخطوة تأكيد واضحة عشان مايتغيّرش رصيد بالغلط.
      </p>
    </AccCard>
  );
}
