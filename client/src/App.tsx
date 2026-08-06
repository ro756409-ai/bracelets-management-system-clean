import { CommandPalette } from "@/components/shared/CommandPalette";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
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
import SalaryPreparation from "./pages/SalaryPreparation";
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
import { BusinessProvider } from "./contexts/BusinessContext";

function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Home />;
  return <DashboardLayout>{children}</DashboardLayout>;
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
      <Route path={"/employee-dashboard"} component={EmployeeDashboard} />
      <Route path={"/warehouse-dashboard"} component={WarehouseDashboard} />
      <Route path={"/manager-dashboard"} component={ManagerDashboard} />
      <Route path={"/today-shipments"} component={TodayShipments} />
      <Route path={"/shipping-schedule"} component={ShippingSchedule} />
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
      {/* الأربعة بيرندروا نفس الصفحة — التاب بيتحدد من المسار. المسارات القديمة
          محفوظة عشان أي رابط قديم أو bookmark يفضل شغّال. */}
      <Route path="/accounting">
        <ProtectedLayout><Accounting /></ProtectedLayout>
      </Route>
      <Route path="/treasury">
        <ProtectedLayout><Accounting /></ProtectedLayout>
      </Route>
      <Route path="/expenses">
        <ProtectedLayout><Accounting /></ProtectedLayout>
      </Route>
      <Route path="/collections">
        <ProtectedLayout><Accounting /></ProtectedLayout>
      </Route>
      <Route path="/salary-preparation">
        <ProtectedLayout><SalaryPreparation /></ProtectedLayout>
      </Route>
      <Route path="/payroll">
        <ProtectedLayout><Accounting /></ProtectedLayout>
      </Route>
      <Route path="/closings">
        <ProtectedLayout><Accounting /></ProtectedLayout>
      </Route>
      <Route path="/daily-ledger">
        <ProtectedLayout><DailyLedger /></ProtectedLayout>
      </Route>
      <Route path="/goods-receipt">
        <ProtectedLayout><GoodsReceipt /></ProtectedLayout>
      </Route>
      <Route path="/stock-transfer">
        <ProtectedLayout><StockTransfer /></ProtectedLayout>
      </Route>
      <Route path="/workshop-returns">
        <ProtectedLayout><WorkshopReturns /></ProtectedLayout>
      </Route>
      <Route path="/accounting-settings">
        <ProtectedLayout><Accounting /></ProtectedLayout>
      </Route>
      <Route path="/shipping-finance">
        <ProtectedLayout><Accounting /></ProtectedLayout>
      </Route>
      <Route path={"/facebook-entry"} component={FacebookEntry} />
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
