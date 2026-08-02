import "dotenv/config";
import mysql from "mysql2/promise";

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is required");
const parsed = new URL(url);
if (!parsed.pathname.toLowerCase().includes("test"))
  throw new Error(
    "Refusing to use a database whose name does not contain 'test'"
  );
const connection = await mysql.createConnection(url);
const [rows] = await connection.query("SELECT DATABASE() AS name, 1 AS ok");
const requiredShape = [
  ["businesses", "accountingGoLiveAt"],
  ["orders", "projectedShippingCostSnapshot"],
  ["order_items", "projectedUnitCostSnapshot"],
  ["business_events", "idempotencyKey"],
  ["financial_accounts", "currentBalance"],
  ["inventory_balances", "movingAverageCost"],
  ["shipment_charge_snapshots", "orderId"],
  ["accounting_closings", "snapshotVersion"],
] as const;
const [columns] = await connection.query(`
  SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
`);
const available = new Set(
  (columns as Array<{ tableName: string; columnName: string }>).map(
    column => `${column.tableName}.${column.columnName}`
  )
);
const missing = requiredShape
  .map(([table, column]) => `${table}.${column}`)
  .filter(key => !available.has(key));
await connection.end();
if (missing.length > 0) {
  throw new Error(
    `Test database schema is not ready. Missing: ${missing.join(", ")}`
  );
}
console.log(
  JSON.stringify({ connected: true, database: (rows as any[])[0]?.name })
);
