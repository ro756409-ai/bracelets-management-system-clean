import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerLocalAuthRoutes } from "../localAuth";
import { registerImportRoutes, registerWhatsAppImportRoutes } from "../importExcel";
import { registerExportRoutes } from "../exportExcel";
import { registerWebhookRoutes } from "../easyorderWebhook";
import { registerBostaWebhookRoutes } from "../bostaWebhook";
import { registerBostaAwbRoutes } from "../bosta.service";
import employeeAuthRouter from "../employeeAuth";
import cookieParser from "cookie-parser";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { startMaintenanceScheduler } from "../scheduler";
import { registerEvidenceUploadRoutes } from "../evidenceUpload";
import {
  logError,
  makeHealthHandler,
  requestIdMiddleware,
  type RequestWithId,
} from "../observability";
import { getDb } from "../db";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // Cookie parser for employee sessions
  app.use(cookieParser());
  // معرّف طلب/ربط لكل request — بدري عشان يغطّي كل المسارات.
  app.use(requestIdMiddleware);
  // صحّة عامة — للـload balancer/المراقبة. مفيش بيانات حسّاسة.
  app.get("/api/health", makeHealthHandler(getDb));
  registerEvidenceUploadRoutes(app);
  // Local owner/admin auth (POST /api/auth/login)
  registerLocalAuthRoutes(app);
  // Excel import routes
  registerImportRoutes(app);
  registerWhatsAppImportRoutes(app);
  // Excel export routes
  registerExportRoutes(app);
  // Easy Order Webhook routes
  registerWebhookRoutes(app);
  // Bosta Webhook routes
  registerBostaWebhookRoutes(app);
  // Bosta AWB (official shipping label) print/download routes
  registerBostaAwbRoutes(app);
  // Employee auth routes
  app.use("/api/employee", employeeAuthRouter);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      // تسجيل خطأ منظّم بالمعرّفات الآمنة بس — مفيش input/أسرار. الأخطاء المتوقّعة
      // (مدخلات غلط، صلاحيات) مابتتسجّلش كضجيج؛ بس الأعطال الحقيقية للسيرفر.
      onError({ error, path, type, ctx, req }) {
        if (error.code !== "INTERNAL_SERVER_ERROR") return;
        const anyCtx = ctx as any;
        logError({
          requestId: (req as RequestWithId)?.requestId,
          path: `${type} ${path ?? "?"}`,
          code: error.code,
          tenantId: anyCtx?.tenantId ?? null,
          userId: anyCtx?.user?.id ?? null,
          employeeId: anyCtx?.employee?.id ?? null,
          message: error.message,
        });
      },
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
  startMaintenanceScheduler();
}

startServer().catch(console.error);
