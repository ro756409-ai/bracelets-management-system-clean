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
            <Router />
          </TooltipProvider>
        </BusinessProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
