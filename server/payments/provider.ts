import type { PaymentRow, VerifiedProviderEvent } from "../subscriptionBilling.service";

/**
 * طبقة مزوّدي الدفع للاشتراك — عقد واحد قابل للتوسعة. المزوّد **مابيقررش** مبلغ ولا مدة: الدفع (pending) بيتعمل على السيرفر
 * بمبلغ الخطة، والمزوّد بس بيحوّل العميل لصفحة الدفع الآمنة بتاعته، وبيرجّع حدث **متحقَّق التوقيع** بالنتيجة.
 *
 *  • لا تخزين بيانات بطاقة في أي مكان — صفحة الدفع عند المزوّد (hosted checkout).
 *  • verifyWebhook: يتحقق من التوقيع على **الـbody الخام** بمقارنة ثابتة الزمن + حد زمني ضد إعادة الإرسال، وإلا null (رفض).
 *  • الحدث المتحقَّق بيروح لـapplyProviderEvent (idempotent، يطابق المبلغ/العملة/المرجع، تحت قفل حساب الشركة).
 *  • Paymob / Fawry: BLOCKED — مفيش وثائق رسمية ولا Sandbox معتمد في المشروع؛ ممنوع اختراع endpoints أو صيغ توقيع.
 */
export type ProviderId = VerifiedProviderEvent["provider"];

export type CheckoutSession = { mode: "redirect"; redirectUrl: string; providerRef: string | null } | { mode: "mock"; providerRef: string };

export interface SubscriptionPaymentProvider {
  readonly id: ProviderId;
  /** جلسة دفع لدفع pending (المبلغ والعملة من الدفع نفسه — من السيرفر). */
  createCheckout(payment: PaymentRow, ctx: { returnUrl: string }): Promise<CheckoutSession>;
  /** body خام + headers ⇒ حدث متحقَّق، أو null لو التوقيع/الصيغة/الوقت غير صالح. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, now?: Date): VerifiedProviderEvent | null;
}

export class ProviderBlockedError extends Error {
  constructor(readonly provider: ProviderId) {
    super(`BLOCKED: مزوّد ${provider} غير مربوط — يحتاج وثائق رسمية + Sandbox معتمد + مفاتيح من حساب التاجر (لا تخمين)`);
    this.name = "ProviderBlockedError";
  }
}
