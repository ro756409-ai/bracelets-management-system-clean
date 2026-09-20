import { CommandPalette } from "@/components/shared/CommandPalette";
import { EmployeeScopeGuard } from "@/components/EmployeeScopeGuard";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch, Redirect } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Register from "./pages/Register";
import PlatformAdminLogin from "./pages/platform/PlatformAdminLogin";
import PlatformAdmin from "./pages/platform/PlatformAdmin";
import Dashboard from "./pages/Dashboard";
import Orders from "./pages/Orders";
import DailyLedger from "./pages/DailyLedger";
import GoodsReceipt from "./pages/GoodsReceipt";
import StockTransfer from "./pages/StockTransfer";
import WorkshopReturns from "./pages/WorkshopReturns";
import Advertising from "./pages/Advertising";
import DailyCollections from "./pages/DailyCollections";
import SalaryPreparation from "./pages/SalaryPreparation";
import SalaryProfiles from "./pages/SalaryProfiles";
import SupplierStatements from "./pages/SupplierStatements";
import AgentWorkspace from "./pages/AgentWorkspace";
import Employees from "./pages/Employees";
import Inventory from "./pages/Inventory";
import Reports from "./pages/Reports";
import EmployeeLogin from "./pages/EmployeeLogin";
import EmployeeDashboard from "./pages/EmployeeDashboard";
import ManagerDashboard from "./pages/ManagerDashboard";
import TodayShipments from "./pages/TodayShipments";
import ShippingSchedule from "./pages/ShippingSchedule";
import TodayShipmentsWorkspace from "./pages/operations/TodayShipmentsWorkspace";
import ShippingScheduleWorkspace from "./pages/operations/ShippingScheduleWorkspace";
import WebhookSettings from "./pages/WebhookSettings";
import MergeLogs from "./pages/MergeLogs";
import Returns from "./pages/Returns";
import Duplicates from "./pages/Duplicates";
import FacebookEntry from "./pages/FacebookEntry";
import Preparation from "./pages/Preparation";
import PrintLogs from "./pages/PrintLogs";
import ScanOrders from "./pages/ScanOrders";
import ActivityLog from "./pages/ActivityLog";
import WarehouseDashboard from "./pages/WarehouseDashboard";
import OrderDetails from "./pages/OrderDetails";
import SalesChannels from "./pages/SalesChannels";
import Businesses from "./pages/Businesses";
import PrintedOrders from "./pages/PrintedOrders";
import ScanLogs from "./pages/ScanLogs";
import BostaOrders from "./pages/BostaOrders";
import Accounting from "./pages/Accounting";
import AccountantWorkspace from "./pages/AccountantWorkspace";
import AccountingDisabled from "./pages/AccountingDisabled";
import Stocktake from "./pages/Stocktake";
import DashboardLayout from "./components/DashboardLayout";
import { useAuth } from "./_core/hooks/useAuth";
import { usePermissions } from "./hooks/usePermission";
import { BusinessProvider } from "./contexts/BusinessContext";

function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Home />;
  return <DashboardLayout>{children}</DashboardLayout>;
}

/** أنسب صفحة هبوط لجلسة حسب صلاحياتها — بيتستخدم لما نطرد حد من صفحة مالوش حق فيها. */
function homeForPermissions(perms: string[]): string {
  // النظام المحاسبي مجمّد: المحاسب (accounting.view وبس، غير المالك) بيروح صفحة «قيد
  // التطوير» الآمنة بدل مساحة الحسابات. المالك admin بيعدّي الحُرّاس فمابيوصلش هنا.
  if (perms.includes("dashboard.view")) return "/dashboard";
  if (perms.includes("accounting.view")) return "/accounting-disabled";
  return "/employee-dashboard";
}

/**
 * صفحة مالية: بتفتح للمالك، أو لأي موظف **عنده الصلاحية دي فعليًا** (المحاسب).
 *
 * مش زي `ProtectedLayout` اللي بيشترط جلسة مالك — عشان المحاسب (موظف غير إداري،
 * `auth.me` بيرجّعله null) يقدر يفتح الحسابات. القايمة بتتقري من `usePermissions`
 * (نفس مصدر السيرفر)، والبيانات نفسها جاية من `permissionProcedure` اللي بيصرّح له.
 * ده توجيه واجهة فوق الحارس الحقيقي على الـendpoints — مش بديل عنه.
 *
 * المدير (صلاحياته من غير المالي) بيتحوّل بره الصفحات المالية بدل ما يشوف قشرة فاضية
 * بأخطاء — وده أنضف من السلوك القديم.
 */
function FinancialRoute({
  permission,
  children,
  bare = false,
}: {
  permission: string;
  children: React.ReactNode;
  /** `bare`: الصفحة بترندر layout بتاعها بنفسها (مساحة المحاسب) — من غير DashboardLayout. */
  bare?: boolean;
}) {
  const { user, loading } = useAuth();
  const { permissions, isLoading } = usePermissions();
  if (loading || isLoading) return null;
  const authed = Boolean(user) || permissions.length > 0;
  if (!authed) return <Home />;
  const allowed = user?.role === "admin" || permissions.includes(permission);
  if (!allowed) return <Redirect to={homeForPermissions(permissions)} />;
  return bare ? <>{children}</> : <DashboardLayout>{children}</DashboardLayout>;
}

/**
 * حارس صفحات التشغيل (لوحات الموظفين): المحاسب هو الموظف الوحيد غير الإداري اللي معاه
 * `accounting.view`، فلو وصل صفحة تشغيل أوردرات/تأكيدات بالـURL بيتحوّل للحسابات.
 *
 * الحجب مقصور عليه بالظبط: المالك (`admin`) بيعدّي، وباقي أدوار التشغيل (تأكيدات/إدخال/
 * مخزن...) مالهاش `accounting.view` فمتأثرش. مش مجرد إخفاء من الـsidebar.
 */
function BlockFinancialUser({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { permissions, isLoading } = usePermissions();
  if (isLoading) return null;
  if (user?.role !== "admin" && permissions.includes("accounting.view")) {
    // النظام المحاسبي مجمّد: المحاسب بيتحوّل لصفحة «قيد التطوير» الآمنة بدل مساحة الحسابات.
    return <Redirect to="/accounting-disabled" />;
  }
  return <>{children}</>;
}

/**
 * حارس لوحة التأكيدات (/employee-dashboard): مقصورة على أدوار التأكيد/المتابعة. موظف الإدخال
 * (`orders.create` من غير أي `orders.confirm`/`orders.update`/`dashboard.view`) بيتحوّل
 * لشاشة الإدخال. باقي الأدوار (تأكيد/مشاهدة/مخزن...) بتعدّي زي ما هي — من غير انحدار.
 * ده توجيه واجهة فوق الحُرّاس الحقيقية على الـendpoints (`requireEmployeePermission`).
 */
function EmployeeDashboardGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { permissions, isLoading } = usePermissions();
  if (isLoading) return null;
  const isDataEntryOnly =
    user?.role !== "admin" &&
    permissions.includes("orders.create") &&
    !permissions.includes("orders.confirm") &&
    !permissions.includes("orders.update") &&
    !permissions.includes("dashboard.view");
  if (isDataEntryOnly) return <Redirect to="/facebook-entry" />;
  return <>{children}</>;
}

/**
 * حارس شاشة الإدخال اليدوي (/facebook-entry): مقصورة على من يملك `orders.create`. أي جلسة
 * أخرى (تأكيد/مشاهدة...) بتتحوّل للوحة التأكيدات. المالك (admin) بيعدّي.
 */
function OrderCreateGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { permissions, isLoading } = usePermissions();
  if (isLoading) return null;
  if (user?.role !== "admin" && !permissions.includes("orders.create")) {
    return <Redirect to="/employee-dashboard" />;
  }
  return <>{children}</>;
}

/**
 * شاشات الشحن (شحنات اليوم / جدول الشحن) ليها جمهورين على **نفس الـroute**:
 *   • جلسة الداشبورد (المالك/المدير — `auth.me` فيه user): تبويب داخل Operations workspace
 *     تحت DashboardLayout، بيقرا من `operations.*` (مش محتاج كوكي employee_token).
 *   • غير كده (موظف الشحن من /employee-login): صفحة البوابة زي ما هي بالظبط.
 * قبل كده التبويب كان بيفتح صفحة البوابة للمالك فتطرده لـ/employee-login.
 */
function OperationsRoute({ workspace, portal }: { workspace: React.ReactNode; portal: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <DashboardLayout>{workspace}</DashboardLayout>;
  return <>{portal}</>;
}

function Router() {
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/login"} component={Login} />
      <Route path={"/signup"} component={Register} />
      {/* لوحة إدارة المنصة — مصادقة مستقلة (كوكي المنصة)، بعيدة عن حُرّاس تينانت العملاء. */}
      <Route path={"/platform-admin/login"} component={PlatformAdminLogin} />
      <Route path={"/platform-admin"} component={PlatformAdmin} />
      <Route path={"/dashboard"}>
        <ProtectedLayout><Dashboard /></ProtectedLayout>
      </Route>
      <Route path={"/orders"}>
        <ProtectedLayout><Orders /></ProtectedLayout>
      </Route>
      <Route path={"/workspace"}>
        <ProtectedLayout><AgentWorkspace /></ProtectedLayout>
      </Route>
      <Route path={"/employees"}>
        <ProtectedLayout><Employees /></ProtectedLayout>
      </Route>
      <Route path={"/inventory"}>
        <ProtectedLayout><Inventory /></ProtectedLayout>
      </Route>
      <Route path={"/reports"}>
        <ProtectedLayout><Reports /></ProtectedLayout>
      </Route>
      <Route path={"/employee-login"} component={EmployeeLogin} />
      {/* النظام المحاسبي مجمّد: /accountant وكل المسارات المحاسبية بتعرض صفحة «قيد التطوير»
          الآمنة لأي دور (بما فيهم المالك) — لا بيانات تشغيلية ولا مالية. */}
      <Route path={"/accountant"}>
        <AccountingDisabled />
      </Route>
      {/* لوحات التشغيل: المحاسب (الموظف الوحيد غير الإداري بصلاحية مالية) بيتحوّل عنها
          للحسابات لو فتحها بالـURL — باقي أدوار التشغيل متأثرش. */}
      <Route path={"/employee-dashboard"}>
        <BlockFinancialUser>
          <EmployeeDashboardGuard>
            <EmployeeDashboard />
          </EmployeeDashboardGuard>
        </BlockFinancialUser>
      </Route>
      <Route path={"/warehouse-dashboard"}>
        <BlockFinancialUser><WarehouseDashboard /></BlockFinancialUser>
      </Route>
      <Route path={"/manager-dashboard"}>
        <BlockFinancialUser><ManagerDashboard /></BlockFinancialUser>
      </Route>
      <Route path={"/today-shipments"}>
        <BlockFinancialUser><OperationsRoute workspace={<TodayShipmentsWorkspace />} portal={<TodayShipments />} /></BlockFinancialUser>
      </Route>
      <Route path={"/shipping-schedule"}>
        <BlockFinancialUser><OperationsRoute workspace={<ShippingScheduleWorkspace />} portal={<ShippingSchedule />} /></BlockFinancialUser>
      </Route>
      <Route path={"/webhook-settings"}>
        <ProtectedLayout><WebhookSettings /></ProtectedLayout>
      </Route>
      <Route path={"/merge-logs"}>
        <ProtectedLayout><MergeLogs /></ProtectedLayout>
      </Route>
      <Route path={"/returns"}>
        <ProtectedLayout><Returns /></ProtectedLayout>
      </Route>
      <Route path={"/duplicates"}>
        <ProtectedLayout><Duplicates /></ProtectedLayout>
      </Route>
      <Route path={"/preparation"}>
        <ProtectedLayout><Preparation /></ProtectedLayout>
      </Route>
      <Route path={"/print-logs"}>
        <ProtectedLayout><PrintLogs /></ProtectedLayout>
      </Route>
      <Route path="/activity-log">
        <ProtectedLayout><ActivityLog /></ProtectedLayout>
      </Route>
      <Route path="/order/:id">
        <ProtectedLayout><OrderDetails /></ProtectedLayout>
      </Route>
      <Route path="/sales-channels">
        <ProtectedLayout><SalesChannels /></ProtectedLayout>
      </Route>
      <Route path="/businesses">
        <ProtectedLayout><Businesses /></ProtectedLayout>
      </Route>
      <Route path="/printed-orders">
        <ProtectedLayout><PrintedOrders /></ProtectedLayout>
      </Route>
      <Route path="/scan-logs">
        <ProtectedLayout><ScanLogs /></ProtectedLayout>
      </Route>
      <Route path="/bosta-orders">
        <ProtectedLayout><BostaOrders /></ProtectedLayout>
      </Route>
      {/* النظام المحاسبي مجمّد (قرار: إعادة بناء لاحقًا). كل مساراته القديمة محفوظة عشان أي
          رابط/bookmark مايكسرش، لكن بتعرض صفحة «قيد التطوير» الآمنة بدل الشاشات المالية —
          لأي دور. القراءات/الكتابات المحاسبية متوقّفة على السيرفر برضه. مسارات المخزون
          (goods-receipt/stocktake/stock-transfer/workshop-returns) **مش** متأثرة. */}
      <Route path="/accounting"><AccountingDisabled /></Route>
      <Route path="/treasury"><AccountingDisabled /></Route>
      <Route path="/expenses"><AccountingDisabled /></Route>
      <Route path="/collections"><AccountingDisabled /></Route>
      <Route path="/supplier-statements"><AccountingDisabled /></Route>
      <Route path="/salary-profiles"><AccountingDisabled /></Route>
      <Route path="/salary-preparation"><AccountingDisabled /></Route>
      <Route path="/payroll"><AccountingDisabled /></Route>
      <Route path="/closings"><AccountingDisabled /></Route>
      <Route path="/daily-ledger"><AccountingDisabled /></Route>
      <Route path="/goods-receipt">
        <FinancialRoute permission="inventory_costing.view"><GoodsReceipt /></FinancialRoute>
      </Route>
      {/* الجرد — صفحة مستقلة للمالك/المدير تحت DashboardLayout، بتعيد استخدام AccStocktake.
          نفس حارس /goods-receipt (inventory_costing.view، غير مالي) فالمدير بيوصلها. */}
      <Route path="/stocktake">
        <FinancialRoute permission="inventory_costing.view"><Stocktake /></FinancialRoute>
      </Route>
      <Route path="/stock-transfer">
        <FinancialRoute permission="inventory_costing.view"><StockTransfer /></FinancialRoute>
      </Route>
      <Route path="/workshop-returns">
        <FinancialRoute permission="inventory_costing.view"><WorkshopReturns /></FinancialRoute>
      </Route>
      <Route path="/daily-collections"><AccountingDisabled /></Route>
      <Route path="/advertising"><AccountingDisabled /></Route>
      <Route path="/accounting-settings"><AccountingDisabled /></Route>
      <Route path="/shipping-finance"><AccountingDisabled /></Route>
      <Route path="/accounting-disabled"><AccountingDisabled /></Route>
      <Route path={"/facebook-entry"}>
        <BlockFinancialUser>
          <OrderCreateGuard><FacebookEntry /></OrderCreateGuard>
        </BlockFinancialUser>
      </Route>
      <Route path={"/scan-orders"}>
        <ProtectedLayout><ScanOrders /></ProtectedLayout>
      </Route>
      <Route path={"/404"} component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <BusinessProvider>
          <TooltipProvider>
            <Toaster />
            {/* Mounted at the root so ⌘K works from every screen, including ones that
                render their own layout — navigation shortcuts that only work in some
                places are worse than none, because you stop trusting them. */}
            <CommandPalette />
            {/* أي تغيير في هوية موظف الجلسة (دخول/خروج/انتهاء) بيمسح cache الاستعلامات
                ومسودات الحسابات التانية — مركّب هنا عشان مايعتمدش على إن كل موضع
                تسجيل خروج يفتكر ينضّف. */}
            <EmployeeScopeGuard />
            <Router />
          </TooltipProvider>
        </BusinessProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
