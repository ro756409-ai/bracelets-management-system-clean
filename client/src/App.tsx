import { CommandPalette } from "@/components/shared/CommandPalette";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch, Redirect } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Login from "./pages/Login";
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
  if (perms.includes("accounting.view")) return "/accounting";
  if (perms.includes("dashboard.view")) return "/dashboard";
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
}: {
  permission: string;
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  const { permissions, isLoading } = usePermissions();
  if (loading || isLoading) return null;
  const authed = Boolean(user) || permissions.length > 0;
  if (!authed) return <Home />;
  const allowed = user?.role === "admin" || permissions.includes(permission);
  if (!allowed) return <Redirect to={homeForPermissions(permissions)} />;
  return <DashboardLayout>{children}</DashboardLayout>;
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
    return <Redirect to="/accounting" />;
  }
  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/login"} component={Login} />
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
      {/* لوحات التشغيل: المحاسب (الموظف الوحيد غير الإداري بصلاحية مالية) بيتحوّل عنها
          للحسابات لو فتحها بالـURL — باقي أدوار التشغيل متأثرش. */}
      <Route path={"/employee-dashboard"}>
        <BlockFinancialUser><EmployeeDashboard /></BlockFinancialUser>
      </Route>
      <Route path={"/warehouse-dashboard"}>
        <BlockFinancialUser><WarehouseDashboard /></BlockFinancialUser>
      </Route>
      <Route path={"/manager-dashboard"}>
        <BlockFinancialUser><ManagerDashboard /></BlockFinancialUser>
      </Route>
      <Route path={"/today-shipments"}>
        <BlockFinancialUser><TodayShipments /></BlockFinancialUser>
      </Route>
      <Route path={"/shipping-schedule"}>
        <BlockFinancialUser><ShippingSchedule /></BlockFinancialUser>
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
      {/* صفحات الحسابات: التاب بيتحدد من المسار. كلها متحرسة بـFinancialRoute بصلاحية
          الصفحة — فبتفتح للمالك والمحاسب، وبيتحوّل عنها مين مالوش الصلاحية (المدير مثلاً).
          المسارات القديمة محفوظة عشان أي رابط قديم أو bookmark يفضل شغّال. */}
      <Route path="/accounting">
        <FinancialRoute permission="accounting.view"><Accounting /></FinancialRoute>
      </Route>
      <Route path="/treasury">
        <FinancialRoute permission="accounting.view"><Accounting /></FinancialRoute>
      </Route>
      <Route path="/expenses">
        <FinancialRoute permission="accounting.view"><Accounting /></FinancialRoute>
      </Route>
      <Route path="/collections">
        <FinancialRoute permission="accounting.view"><Accounting /></FinancialRoute>
      </Route>
      <Route path="/supplier-statements">
        <FinancialRoute permission="accounting.view"><Accounting /></FinancialRoute>
      </Route>
      <Route path="/salary-profiles">
        <FinancialRoute permission="payroll.view"><Accounting /></FinancialRoute>
      </Route>
      <Route path="/salary-preparation">
        <FinancialRoute permission="payroll.view"><SalaryPreparation /></FinancialRoute>
      </Route>
      <Route path="/payroll">
        <FinancialRoute permission="payroll.view"><Accounting /></FinancialRoute>
      </Route>
      <Route path="/closings">
        <FinancialRoute permission="accounting.view"><Accounting /></FinancialRoute>
      </Route>
      <Route path="/daily-ledger">
        <FinancialRoute permission="accounting.view"><DailyLedger /></FinancialRoute>
      </Route>
      <Route path="/goods-receipt">
        <FinancialRoute permission="inventory_costing.view"><GoodsReceipt /></FinancialRoute>
      </Route>
      <Route path="/stock-transfer">
        <FinancialRoute permission="inventory_costing.view"><StockTransfer /></FinancialRoute>
      </Route>
      <Route path="/workshop-returns">
        <FinancialRoute permission="inventory_costing.view"><WorkshopReturns /></FinancialRoute>
      </Route>
      <Route path="/daily-collections">
        <FinancialRoute permission="accounting.view"><Accounting /></FinancialRoute>
      </Route>
      <Route path="/advertising">
        <FinancialRoute permission="ad_spend.view"><Accounting /></FinancialRoute>
      </Route>
      <Route path="/accounting-settings">
        <FinancialRoute permission="accounting.view"><Accounting /></FinancialRoute>
      </Route>
      <Route path="/shipping-finance">
        <FinancialRoute permission="shipping_finance.view"><Accounting /></FinancialRoute>
      </Route>
      <Route path={"/facebook-entry"}>
        <BlockFinancialUser><FacebookEntry /></BlockFinancialUser>
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
            <Router />
          </TooltipProvider>
        </BusinessProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
