/**
 * Creates the first owner/admin account, only if no manager (admin-equivalent)
 * account exists yet. Safe to run repeatedly — it's a no-op once an admin
 * already exists.
 *
 * Usage:
 *   INITIAL_ADMIN_USERNAME=owner INITIAL_ADMIN_PASSWORD=... INITIAL_ADMIN_EMAIL=owner@example.com \
 *     pnpm seed:admin
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../server/db";
import { employees } from "../drizzle/schema";
import { ADMIN_TIER_ROLES } from "../server/permissions";

async function main() {
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  const email = process.env.INITIAL_ADMIN_EMAIL;

  if (!username || !password) {
    console.error("[seed-admin] INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD are required.");
    process.exit(1);
  }

  const db = await getDb();
  if (!db) {
    console.error("[seed-admin] Database not available — check DATABASE_URL.");
    process.exit(1);
  }

  const existingAdmins = await db.select().from(employees).where(inArray(employees.role, ADMIN_TIER_ROLES)).limit(1);
  if (existingAdmins.length > 0) {
    console.log(`[seed-admin] An admin-tier account already exists (${existingAdmins[0].username ?? existingAdmins[0].name}) — skipping.`);
    process.exit(0);
  }

  const existingUsername = await db.select().from(employees).where(eq(employees.username, username)).limit(1);
  if (existingUsername.length > 0) {
    console.error(`[seed-admin] Username "${username}" is already taken by a non-manager account — skipping.`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await db.insert(employees).values({
    name: "Owner",
    username,
    email: email || null,
    passwordHash,
    role: "manager",
    isActive: true,
  });

  console.log(`[seed-admin] Admin account created: ${username}`);
  process.exit(0);
}

main().catch(err => {
  console.error("[seed-admin] Failed:", err);
  process.exit(1);
});
