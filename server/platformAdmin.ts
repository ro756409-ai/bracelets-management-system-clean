/**
 * Platform Admin — إدارة طلبات تسجيل التجار (Phase 3.4). REST تحت /api/platform، محمي بالكامل
 * بـrequirePlatformAdmin (جلسة المنصة المستقلة فقط). القبول ذرّي (transaction في db.ts).
 */
import { Router, type Express, type Response } from "express";
import {
  listSignupRequests,
  getSignupRequestById,
  approveSignupRequest,
  rejectSignupRequest,
  addPlatformAuditLog,
} from "./db";
import {
  requirePlatformAdmin,
  isOriginAllowed,
  clientIp,
  type PlatformRequest,
} from "./platformAuth";

const STATUSES = ["pending", "approved", "rejected"] as const;
type Status = (typeof STATUSES)[number];

function denyOrigin(res: Response) {
  return res.status(403).json({ success: false, error: "مصدر غير مسموح" });
}

export function registerPlatformAdminRoutes(app: Express) {
  const router = Router();

  // كل المسارات تحت الحارس — جلسة Platform Admin فقط.
  router.use(requirePlatformAdmin);

  // GET /api/platform/signup-requests?status=pending|approved|rejected
  router.get("/signup-requests", async (req, res) => {
    const status = req.query.status as string | undefined;
    const filter = STATUSES.includes(status as Status) ? (status as Status) : undefined;
    const rows = await listSignupRequests(filter); // بلا passwordHash (safe columns)
    return res.json({ requests: rows });
  });

  // GET /api/platform/signup-requests/:id
  router.get("/signup-requests/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    const row = await getSignupRequestById(id);
    if (!row) return res.status(404).json({ error: "الطلب غير موجود" });
    return res.json({ request: row });
  });

  // POST /api/platform/signup-requests/:id/approve
  router.post("/signup-requests/:id/approve", async (req, res) => {
    if (!isOriginAllowed(req)) return denyOrigin(res);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    const admin = (req as PlatformRequest).platformAdmin!;
    const result = await approveSignupRequest(id, admin.id);
    if (!result.ok) {
      const code = result.code === "not_found" ? 404 : 409;
      await addPlatformAuditLog({
        platformAdminId: admin.id, action: "approve_failed",
        targetType: "signup_request", targetId: id,
        details: JSON.stringify({ code: result.code }), ipAddress: clientIp(req),
      });
      return res.status(code).json({ success: false, error: result.message });
    }
    await addPlatformAuditLog({
      platformAdminId: admin.id, action: "approve",
      targetType: "signup_request", targetId: id,
      details: JSON.stringify({ tenantId: result.tenantId, businessId: result.businessId, employeeId: result.employeeId }),
      ipAddress: clientIp(req),
    });
    return res.json({ success: true, tenantId: result.tenantId, businessId: result.businessId });
  });

  // POST /api/platform/signup-requests/:id/reject  { reason? }
  router.post("/signup-requests/:id/reject", async (req, res) => {
    if (!isOriginAllowed(req)) return denyOrigin(res);
    if (!req.is("application/json") && req.body && Object.keys(req.body).length)
      return res.status(415).json({ success: false, error: "نوع المحتوى غير مدعوم" });
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: "معرّف غير صالح" });
    const admin = (req as PlatformRequest).platformAdmin!;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 1000) : undefined;
    const result = await rejectSignupRequest(id, admin.id, reason);
    if (!result.ok) {
      const code = result.code === "not_found" ? 404 : 409;
      return res.status(code).json({ success: false, error: result.code === "not_found" ? "الطلب غير موجود" : "الطلب تمت معالجته بالفعل" });
    }
    await addPlatformAuditLog({
      platformAdminId: admin.id, action: "reject",
      targetType: "signup_request", targetId: id,
      details: JSON.stringify({ hasReason: Boolean(reason) }), ipAddress: clientIp(req),
    });
    return res.json({ success: true });
  });

  app.use("/api/platform", router);
}
