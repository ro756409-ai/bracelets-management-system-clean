import mysql from "mysql2/promise";

/**
 * قاعدة اختبار مؤقتة = نسخة مخطط المشروع الحقيقي من قاعدة الاختبار المشتركة (SHOW CREATE TABLE — نفس الأنواع
 * والـcollation)، **بلا** جداول ledger_* / order_activity_events / attendance_* / msg_* / teams / team_memberships / team_task_operations وبلا
 * الفهرسين المركّبين — أي الحالة «قبل 0040/0041/0042/0043/0044» دائمًا، مهما طبّقت ملفات أخرى بالتوازي على قواعدها المؤقتة.
 * القاعدة المشتركة نفسها لا تُلمس (قراءة DDL فقط). الاسم يحتوي `_test_` (حارس المشروع).
 */
const EXCLUDED = (n: string) => n.startsWith("ledger_") || n.startsWith("attendance_") || n.startsWith("msg_") || n === "teams" || n === "team_memberships" || n === "team_task_operations" || n === "order_activity_events" || n.startsWith("_");
const stripCompositeIndexes = (ddl: string) =>
  ddl.split("\n").filter(l => !/`(businesses|employees)_tenant_id`/.test(l)).join("\n").replace(/,\n\)/, "\n)");

export type TempSchema = { name: string; url: string; raw: mysql.Connection; drop: () => Promise<void> };

export async function createTempSchema(label: string): Promise<TempSchema> {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) throw new Error("TEST_DATABASE_URL is required");
  if (!new URL(baseUrl).pathname.toLowerCase().includes("test")) throw new Error("Refusing: base database is not a test database");
  const name = `${label}_test_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(0, 60);
  const admin = await mysql.createConnection(baseUrl);
  try {
    const [tables] = (await admin.query("SHOW TABLES")) as any;
    const names: string[] = tables.map((r: any) => Object.values(r)[0] as string).filter((n: string) => !EXCLUDED(n));
    const ddl: string[] = [];
    for (const n of names) {
      try { const [r] = (await admin.query(`SHOW CREATE TABLE \`${n}\``)) as any; ddl.push(stripCompositeIndexes(r[0]["Create Table"])); }
      catch (e: any) { if (e?.code !== "ER_NO_SUCH_TABLE") throw e; }
    }
    await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    const u = new URL(baseUrl); u.pathname = `/${name}`;
    const url = u.toString();
    const raw = await mysql.createConnection(url);
    await raw.query("SET foreign_key_checks = 0");
    for (const stmt of ddl) await raw.query(stmt);
    await raw.query("SET foreign_key_checks = 1");
    return {
      name, url, raw,
      drop: async () => {
        try { await raw.end(); } catch { /* مغلق */ }
        const a = await mysql.createConnection(baseUrl);
        try { await a.query(`DROP DATABASE IF EXISTS \`${name}\``); } finally { await a.end(); }
      },
    };
  } finally {
    await admin.end();
  }
}
