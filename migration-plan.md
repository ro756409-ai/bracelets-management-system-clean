# Multi-Business Migration Plan

## Current State
- **Orders**: 4,554
- **Products**: 9 (all bracelets)
- **Employees**: 11
- **Inventory Movements**: 3,704
- **Returns**: 0

### Current Tables
1. users, employees, products, orders, inventoryMovements
2. webhookLogs, mergeLogs, returns, broadcastMessages
3. tasks, printLogs, activityLogs

### Current Routers (16)
system, auth, seed, employees, products, orders, employeePortal, duplicates, facebookEntry, webhook, reports, broadcast, returns, tasks, printLogs, activityLog

### Current Pages (26)
Dashboard, Orders, Employees, Inventory, Reports, Returns, Duplicates, Preparation, PrintLogs, ActivityLog, MergeLogs, WebhookSettings, TodayShipments, ShippingSchedule, EmployeeLogin, EmployeeDashboard, WarehouseDashboard, ManagerDashboard, FacebookEntry, AgentWorkspace, OrderDetails, Home, NotFound, ComponentShowcase

## Migration Strategy

### Phase 1: Schema Changes
1. **New table: `businesses`** — id, name, slug, isActive, createdAt
2. **Add `businessId` to**: products, orders, employees, inventoryMovements, returns, printLogs, activityLogs, broadcastMessages, tasks, webhookLogs, mergeLogs
3. **New table: `categories`** — id, businessId, name, isActive
4. **Add `categoryId` to products**
5. **New table: `warehouses`** — id, businessId, name, isActive
6. **Add `warehouseId` to inventoryMovements**

### Phase 2: Safe SQL Migration
1. Create businesses table
2. INSERT default business (Accessories, id=1)
3. INSERT new business (Furniture, id=2)
4. ALTER all tables to add businessId with DEFAULT 1
5. UPDATE all existing rows to businessId=1
6. Create categories, warehouses tables
7. INSERT default warehouse per business

### Phase 3: Backend Changes
- Add business CRUD router
- Modify ALL db.ts functions to accept optional businessId filter
- Modify ALL routers to pass businessId from context/input
- Add businessId to employee schema for role-based filtering

### Phase 4: Frontend Changes
- Add BusinessContext with switcher in sidebar/header
- Pass businessId to all queries
- Filter dashboard stats by business
- Filter orders, products, inventory by business

### Files to Modify
- drizzle/schema.ts (add tables + columns)
- server/db.ts (add businessId to all queries)
- server/routers.ts (add business router + filter all procedures)
- client/src/contexts/BusinessContext.tsx (NEW)
- client/src/components/DashboardLayout.tsx (add switcher)
- client/src/pages/Dashboard.tsx
- client/src/pages/Orders.tsx
- client/src/pages/Inventory.tsx
- client/src/pages/Products section in Inventory
- client/src/pages/Reports.tsx
- client/src/pages/Employees.tsx
- client/src/pages/EmployeeDashboard.tsx
- client/src/pages/WarehouseDashboard.tsx
- client/src/pages/ManagerDashboard.tsx
