// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import axe from "axe-core";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { StatusBadge } from "@/components/shared/StatusBadge";
import { Pagination } from "@/components/shared/Pagination";
import { UnderlineTabs } from "@/components/shared/UnderlineTabs";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/shared/States";
import { Drawer } from "@/components/shared/Drawer";

/**
 * Matjarak 2.0 — المرحلة 0: فحص إمكانية الوصول (axe-core) للمكونات المشتركة كما هي اليوم، بالاتجاهين.
 * jsdom لا يرسم ألوانًا، فقاعدة التباين هنا معطّلة (التباين مقيس من الـtokens في tokenContrast.test وفي المتصفح).
 * المشاكل الموجودة مسبقًا مسجّلة في KNOWN_BASELINE (قاعدة axe → عدد العناصر) — الجديد يُفشل الاختبار.
 */
afterEach(() => cleanup());
// jsdom بلا ResizeObserver (تحتاجه مكونات Radix مثل Checkbox/Switch) — بديل صامت للاختبار فقط.
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

async function audit(ui: ReactNode, dir: "rtl" | "ltr") {
  const { container } = render(<main dir={dir} lang={dir === "rtl" ? "ar" : "en"}><h1>فحص</h1>{ui}</main>);
  const r = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  void container;
  return Object.fromEntries(r.violations.map(v => [v.id, v.nodes.length]));
}

const FORMS = (
  <form>
    <Label htmlFor="n">اسم العميل</Label><Input id="n" />
    <Label htmlFor="t">ملاحظات</Label><Textarea id="t" />
    <div><Checkbox id="c" /><Label htmlFor="c">تأكيد</Label></div>
    <div><Switch id="s" aria-label="تفعيل" /></div>
    <RadioGroup aria-label="النوع" defaultValue="a"><RadioGroupItem value="a" id="ra" aria-label="أ" /><RadioGroupItem value="b" id="rb" aria-label="ب" /></RadioGroup>
    <Button type="submit">حفظ</Button>
  </form>
);
const DATA = (
  <>
    <Tabs defaultValue="a"><TabsList><TabsTrigger value="a">الكل</TabsTrigger><TabsTrigger value="b">مؤكد</TabsTrigger></TabsList><TabsContent value="a">محتوى</TabsContent></Tabs>
    <Table><TableHeader><TableRow><TableHead>الأوردر</TableHead><TableHead>المبلغ</TableHead></TableRow></TableHeader>
      <TableBody><TableRow><TableCell>1001</TableCell><TableCell>250</TableCell></TableRow></TableBody></Table>
    <Badge>جديد</Badge>
    <StatusBadge status="confirmed" /><StatusBadge status="cancelled" /><StatusBadge status="delivered" />
    <Alert><AlertTitle>تنبيه</AlertTitle><AlertDescription>وصف</AlertDescription></Alert>
    <UnderlineTabs tabs={[{ key: "a", label: "الكل" }, { key: "b", label: "مؤكد" }]} value="a" onChange={() => {}} />
    <Pagination page={2} pageSize={20} total={95} onPageChange={() => {}} />
    <EmptyState title="لا توجد أوردرات" description="ابدأ بإضافة أوردر" />
    <ErrorState title="تعذر التحميل" onRetry={() => {}} />
    <LoadingSkeleton rows={2} />
  </>
);

/** موجود مسبقًا عند 23be803 — يُملأ من القياس الأول، والجديد يُفشل الاختبار. */
const KNOWN_BASELINE: Record<string, Record<string, number>> = {
  forms: {},
  data: {},
  dialog: {},
  sheet: {},
  drawer: {},
};

describe("♿ المرحلة 0 — axe على المكونات المشتركة (RTL وLTR)", () => {
  it("الفحص نفسه يعمل: حقل بلا اسم وزر بلا نص وصورة بلا بديل تُكتشف", async () => {
    const r = await audit(<><input /><button /><img src="x.png" /></>, "rtl");
    expect(Object.keys(r).sort()).toEqual(expect.arrayContaining(["button-name", "image-alt", "label"]));
  });
  for (const dir of ["rtl", "ltr"] as const) {
    it(`النماذج (${dir})`, async () => { expect(await audit(FORMS, dir)).toEqual(KNOWN_BASELINE.forms); });
    it(`الجداول والتبويبات والشارات والحالات (${dir})`, async () => { expect(await audit(DATA, dir)).toEqual(KNOWN_BASELINE.data); });
    it(`Dialog مفتوح (${dir})`, async () => {
      expect(await audit(<Dialog open><DialogContent><DialogTitle>تأكيد</DialogTitle><DialogDescription>هل أنت متأكد؟</DialogDescription><Button>نعم</Button></DialogContent></Dialog>, dir)).toEqual(KNOWN_BASELINE.dialog);
    });
    it(`Sheet مفتوح (${dir})`, async () => {
      expect(await audit(<Sheet open><SheetContent><SheetTitle>فلاتر</SheetTitle><SheetDescription>اختر</SheetDescription></SheetContent></Sheet>, dir)).toEqual(KNOWN_BASELINE.sheet);
    });
    it(`Drawer المشترك مفتوح (${dir})`, async () => {
      expect(await audit(<Drawer open onOpenChange={() => {}} title="تفاصيل الأوردر" description="وصف"><p>المحتوى</p></Drawer>, dir)).toEqual(KNOWN_BASELINE.drawer);
    });
  }
});
