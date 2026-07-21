import { createConnection } from 'mysql2/promise';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }

const conn = await createConnection(url);
await conn.execute(`CREATE TABLE IF NOT EXISTS print_logs (
  id int AUTO_INCREMENT NOT NULL,
  printType enum('shipping_sheet','labels') NOT NULL DEFAULT 'shipping_sheet',
  orderIds text NOT NULL,
  orderCount int NOT NULL,
  printedBy int NOT NULL,
  printedByName varchar(100) NOT NULL,
  notes text,
  createdAt timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT print_logs_id PRIMARY KEY(id)
)`);
console.log('✅ print_logs table created');
await conn.end();
