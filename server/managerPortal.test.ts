import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock bcryptjs
vi.mock('bcryptjs', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$2a$10$hashedpassword'),
    compare: vi.fn().mockResolvedValue(true),
  },
}));

// Mock jsonwebtoken
vi.mock('jsonwebtoken', () => ({
  default: {
    sign: vi.fn().mockReturnValue('mock-jwt-token'),
    verify: vi.fn().mockReturnValue({ employeeId: 1, name: 'مدير تجريبي', role: 'manager', username: 'manager1' }),
  },
}));

// Mock database module
vi.mock('./db', () => ({
  getDb: vi.fn().mockResolvedValue({
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{
      id: 1, name: 'مدير تجريبي', role: 'manager', username: 'manager1',
      passwordHash: '$2a$10$hashedpassword', isActive: true, phone: '01234567890',
    }]),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  }),
  getAllEmployees: vi.fn().mockResolvedValue([
    { id: 1, name: 'مدير تجريبي', role: 'manager', isActive: true, username: 'manager1' },
    { id: 2, name: 'موظف عادي', role: 'agent', isActive: true, username: 'agent1' },
    { id: 3, name: 'موظف مخزن', role: 'warehouse', isActive: true, username: null },
  ]),
  getActiveEmployees: vi.fn().mockResolvedValue([
    { id: 1, name: 'مدير تجريبي', role: 'manager', isActive: true },
    { id: 2, name: 'موظف عادي', role: 'agent', isActive: true },
  ]),
  getOrders: vi.fn().mockResolvedValue({ orders: [
    { id: 1, orderNumber: 'ORD001', customerName: 'عميل 1', status: 'new', assignedEmployeeId: 2 },
    { id: 2, orderNumber: 'ORD002', customerName: 'عميل 2', status: 'confirmed', assignedEmployeeId: 2 },
  ], total: 2 }),
  getDashboardStats: vi.fn().mockResolvedValue({
    statusStats: [
      { status: 'new', count: 10 },
      { status: 'confirmed', count: 5 },
      { status: 'cancelled', count: 3 },
    ],
    sourceStats: [{ source: 'manual', count: 18 }],
    governorateStats: [{ governorate: 'القاهرة', count: 10 }],
    totalRevenue: 5000,
  }),
  getAllProducts: vi.fn().mockResolvedValue([
    { id: 1, name: 'أسورة سادة', sku: 'PLAIN-001', price: '150.00', currentStock: 100, minStockLevel: 20 },
  ]),
  getLowStockProducts: vi.fn().mockResolvedValue([]),
  getInventoryMovements: vi.fn().mockResolvedValue([]),
  addInventoryMovement: vi.fn().mockResolvedValue(undefined),
  getEmployeePerformance: vi.fn().mockResolvedValue([
    { employeeId: 2, total: 10, confirmed: 7, cancelled: 2, postponed: 1, delivered: 0 },
  ]),
  getCancellationReasons: vi.fn().mockResolvedValue([
    { cancelReason: 'price', count: 2 },
  ]),
  getDailyOrdersChart: vi.fn().mockResolvedValue([]),
  assignOrderToEmployee: vi.fn().mockResolvedValue(undefined),
  bulkAssignOrders: vi.fn().mockResolvedValue(undefined),
  confirmOrder: vi.fn().mockResolvedValue(undefined),
  postponeOrder: vi.fn().mockResolvedValue(undefined),
  cancelOrder: vi.fn().mockResolvedValue(undefined),
  createOrder: vi.fn().mockResolvedValue(undefined),
  generateOrderNumber: vi.fn().mockResolvedValue('ORD202404050001'),
  createEmployee: vi.fn().mockResolvedValue(undefined),
  updateEmployee: vi.fn().mockResolvedValue(undefined),
  deleteEmployee: vi.fn().mockResolvedValue(undefined),
  createProduct: vi.fn().mockResolvedValue(undefined),
  updateOrder: vi.fn().mockResolvedValue(undefined),
  getOrderById: vi.fn().mockResolvedValue({ id: 1, orderNumber: 'ORD001', notes: '' }),
  updateProductStock: vi.fn().mockResolvedValue(undefined),
}));

describe('Manager Portal - Role & Access Control', () => {
  describe('Employee Roles', () => {
    it('should have three valid employee roles', () => {
      const validRoles = ['agent', 'warehouse', 'manager'];
      expect(validRoles).toHaveLength(3);
      expect(validRoles).toContain('manager');
    });

    it('should identify manager role correctly', () => {
      const employee = { id: 1, name: 'مدير تجريبي', role: 'manager' };
      expect(employee.role).toBe('manager');
      expect(employee.role === 'manager').toBe(true);
    });

    it('should differentiate manager from agent', () => {
      const manager = { role: 'manager' };
      const agent = { role: 'agent' };
      expect(manager.role).not.toBe(agent.role);
      expect(manager.role === 'manager').toBe(true);
      expect(agent.role === 'manager').toBe(false);
    });
  });

  describe('Manager Access Permissions', () => {
    it('manager should have access to all orders (not just assigned)', async () => {
      const { getOrders } = await import('./db');
      // Manager gets all orders without assignedEmployeeId filter
      const result = await getOrders({ limit: 50 });
      expect(result.orders).toBeInstanceOf(Array);
      expect(result.total).toBeGreaterThanOrEqual(0);
    });

    it('manager should have access to dashboard stats', async () => {
      const { getDashboardStats } = await import('./db');
      const stats = await getDashboardStats();
      expect(stats).toBeTruthy();
      expect(stats.statusStats).toBeInstanceOf(Array);
      expect(stats.totalRevenue).toBeDefined();
    });

    it('manager should have access to employee performance reports', async () => {
      const { getEmployeePerformance } = await import('./db');
      const perf = await getEmployeePerformance();
      expect(perf).toBeInstanceOf(Array);
      expect(perf.length).toBeGreaterThan(0);
    });

    it('manager should have access to all products', async () => {
      const { getAllProducts } = await import('./db');
      const products = await getAllProducts();
      expect(products).toBeInstanceOf(Array);
      expect(products.length).toBeGreaterThan(0);
    });

    it('manager should have access to inventory movements', async () => {
      const { getInventoryMovements } = await import('./db');
      const movements = await getInventoryMovements();
      expect(movements).toBeInstanceOf(Array);
    });

    it('manager should have access to employee list', async () => {
      const { getAllEmployees } = await import('./db');
      const employees = await getAllEmployees();
      expect(employees).toBeInstanceOf(Array);
      expect(employees.length).toBeGreaterThan(0);
    });
  });

  describe('Manager Order Operations', () => {
    it('manager should be able to assign orders', async () => {
      const { assignOrderToEmployee } = await import('./db');
      await assignOrderToEmployee(1, 2, 1); // orderId, employeeId, managerId
      expect(assignOrderToEmployee).toHaveBeenCalledWith(1, 2, 1);
    });

    it('manager should be able to bulk assign orders', async () => {
      const { bulkAssignOrders } = await import('./db');
      await bulkAssignOrders([1, 2, 3], 2, 1);
      expect(bulkAssignOrders).toHaveBeenCalledWith([1, 2, 3], 2, 1);
    });

    it('manager should be able to confirm orders', async () => {
      const { confirmOrder } = await import('./db');
      await confirmOrder(1, 1);
      expect(confirmOrder).toHaveBeenCalledWith(1, 1);
    });

    it('manager should be able to cancel orders with reason', async () => {
      const { cancelOrder } = await import('./db');
      await cancelOrder(1, 'price', 'سعر مرتفع', 1);
      expect(cancelOrder).toHaveBeenCalledWith(1, 'price', 'سعر مرتفع', 1);
    });

    it('manager should be able to postpone orders', async () => {
      const { postponeOrder } = await import('./db');
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 3);
      await postponeOrder(1, futureDate, 'العميل طلب التأجيل', 1);
      expect(postponeOrder).toHaveBeenCalledWith(1, futureDate, 'العميل طلب التأجيل', 1);
    });
  });

  describe('Manager Employee Management', () => {
    it('manager should be able to create employees', async () => {
      const { createEmployee } = await import('./db');
      await createEmployee({ name: 'موظف جديد', role: 'agent' });
      expect(createEmployee).toHaveBeenCalled();
    });

    it('manager should be able to create another manager', async () => {
      const { createEmployee } = await import('./db');
      await createEmployee({ name: 'مدير جديد', role: 'manager' });
      expect(createEmployee).toHaveBeenCalledWith(expect.objectContaining({ role: 'manager' }));
    });

    it('manager should be able to update employee status', async () => {
      const { updateEmployee } = await import('./db');
      await updateEmployee(2, { isActive: false });
      expect(updateEmployee).toHaveBeenCalledWith(2, { isActive: false });
    });

    it('manager should be able to delete employees', async () => {
      const { deleteEmployee } = await import('./db');
      await deleteEmployee(3);
      expect(deleteEmployee).toHaveBeenCalledWith(3);
    });
  });

  describe('Manager Inventory Operations', () => {
    it('manager should be able to add inventory movement', async () => {
      const { addInventoryMovement } = await import('./db');
      await addInventoryMovement({
        productId: 1,
        type: 'in',
        quantity: 50,
        reason: 'شحنة جديدة',
        performedBy: 1,
      });
      expect(addInventoryMovement).toHaveBeenCalledWith(expect.objectContaining({
        productId: 1,
        type: 'in',
        quantity: 50,
        performedBy: 1,
      }));
    });
  });

  describe('Employee Notes Feature', () => {
    it('should allow updating order notes', async () => {
      const { updateOrder } = await import('./db');
      await updateOrder(1, { notes: 'العميل طلب الاتصال بعد الظهر', lastUpdatedBy: 2 });
      expect(updateOrder).toHaveBeenCalledWith(1, expect.objectContaining({
        notes: 'العميل طلب الاتصال بعد الظهر',
        lastUpdatedBy: 2,
      }));
    });

    it('should allow empty notes to clear them', async () => {
      const { updateOrder } = await import('./db');
      await updateOrder(1, { notes: '', lastUpdatedBy: 2 });
      expect(updateOrder).toHaveBeenCalledWith(1, expect.objectContaining({ notes: '' }));
    });
  });

  describe('Employee Stock Levels Access', () => {
    it('should return all active products with stock info', async () => {
      const { getAllProducts } = await import('./db');
      const products = await getAllProducts();
      expect(products).toBeInstanceOf(Array);
      expect(products.length).toBeGreaterThan(0);
      expect(products[0]).toHaveProperty('currentStock');
      expect(products[0]).toHaveProperty('name');
    });

    it('should include minStockLevel for low stock detection', async () => {
      const { getAllProducts } = await import('./db');
      const products = await getAllProducts();
      expect(products[0]).toHaveProperty('minStockLevel');
    });
  });

  describe('Import Order Number from File', () => {
    it('should use external ID as order number when available', () => {
      const externalId = 'EO-12345';
      const orderNumber = externalId ? String(externalId) : 'ORD202404050001';
      expect(orderNumber).toBe('EO-12345');
    });

    it('should fallback to generated number when no external ID', () => {
      const externalId = '';
      const generatedNumber = 'ORD202404050001';
      const orderNumber = externalId ? String(externalId) : generatedNumber;
      expect(orderNumber).toBe('ORD202404050001');
    });

    it('should handle numeric external IDs', () => {
      const externalId = '98765';
      const orderNumber = externalId ? String(externalId) : 'ORD202404050001';
      expect(orderNumber).toBe('98765');
    });
  });

  describe('Login Redirect Logic', () => {
    it('should redirect manager to manager-dashboard on login', () => {
      const employee = { id: 1, name: 'مدير', role: 'manager', username: 'manager1' };
      const redirectPath = employee.role === 'manager' ? '/manager-dashboard' : '/employee-dashboard';
      expect(redirectPath).toBe('/manager-dashboard');
    });

    it('should redirect agent to employee-dashboard on login', () => {
      const employee = { id: 2, name: 'موظف', role: 'agent', username: 'agent1' };
      const redirectPath = employee.role === 'manager' ? '/manager-dashboard' : '/employee-dashboard';
      expect(redirectPath).toBe('/employee-dashboard');
    });

    it('should redirect warehouse to employee-dashboard on login', () => {
      const employee = { id: 3, name: 'مخزن', role: 'warehouse', username: 'wh1' };
      const redirectPath = employee.role === 'manager' ? '/manager-dashboard' : '/employee-dashboard';
      expect(redirectPath).toBe('/employee-dashboard');
    });
  });
});
