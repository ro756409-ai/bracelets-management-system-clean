import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Wallet } from "lucide-react";

/** الاسم اللي التاجر بيشوفه لما مايكونش عنده أكتر من خزنة. */
export const DEFAULT_TREASURY_LABEL = "الخزنة الرئيسية";

export type PaymentAccount = { id: number; name: string; isActive: boolean };

/**
 * «الفلوس هتخرج منين».
 *
 * التاجر عنده خزنة واحدة. القايمة اللي بتخليه يختار منها واحد كانت بتطلب منه قرار
 * مالوش معنى — وأسوأ من كده: لو مانشأش حساب مالي (وهو مش عارف يعني إيه)، القايمة
 * بتطلع فاضية والدفع بيقف عند رسالة محاسبية مش مفهومة.
 *
 * فالقايمة بتظهر **بس** لو فيه فعلًا أكتر من خزنة. غير كده التاجر بيقرا سطر واحد بيقول
 * الفلوس هتخرج من فين، والسيرفر بيحلّها لـ«الخزنة الرئيسية» وبيعملها لو لسه مش موجودة.
 *
 * `value` بيرجع `undefined` لما مافيش اختيار — وده اللي بيتبعت للسيرفر بالظبط: غياب
 * الحساب معناه «الافتراضي» مش «فشل تحقق».
 */
export function PaymentSource({
  accounts,
  value,
  onChange,
}: {
  accounts: PaymentAccount[];
  value: string;
  onChange: (next: string) => void;
}) {
  const active = accounts.filter(account => account.isActive);

  if (active.length <= 1) {
    return (
      <div className="space-y-1">
        <Label>الفلوس هتخرج من</Label>
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <Wallet className="h-4 w-4 shrink-0 text-emerald-700" />
          <span>{active[0]?.name ?? DEFAULT_TREASURY_LABEL}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Label>الفلوس هتخرج من *</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder="اختار الخزنة" />
        </SelectTrigger>
        <SelectContent>
          {active.map(account => (
            <SelectItem key={account.id} value={String(account.id)}>
              {account.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * الحساب اللي يتبعت للسيرفر — أو `undefined` يعني «الخزنة الرئيسية».
 *
 * لما يكون فيه خزنة واحدة بس، بنبعت `undefined` حتى لو الخزنة دي ليها id معروف: كده
 * السيرفر هو اللي بيقرر، ومايبقاش فيه فرق في السلوك بين تاجر لسه ماعملش حساب وتاجر
 * عنده واحد.
 */
export function paymentSourceId(
  accounts: PaymentAccount[],
  value: string
): number | undefined {
  const active = accounts.filter(account => account.isActive);
  if (active.length <= 1) return undefined;
  return value ? Number(value) : undefined;
}

/** القايمة ظاهرة ولسه مااتختارش منها حاجة — الحالة الوحيدة اللي بتوقف الدفع. */
export function paymentSourceMissing(
  accounts: PaymentAccount[],
  value: string
): boolean {
  return accounts.filter(account => account.isActive).length > 1 && !value;
}
