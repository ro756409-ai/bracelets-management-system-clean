# متجرك (Matjarak) - دليل النقل والتشغيل

## نظرة عامة

نظام إدارة متكامل لإدارة أوردرات الأساور النحاسية الطبية، يدعم عدة براندات (فرحات، عتبة، Nova، نحاسي، إلخ). يشمل:
- إدارة الأوردرات (إنشاء، تأكيد، تأجيل، إلغاء، شحن، تسليم)
- تكامل مع بوسطا للشحن
- تكامل مع EasyOrder لاستقبال الأوردرات تلقائياً
- نظام موظفين (agent، warehouse، manager، scanner، facebook_entry)
- مسح QR Code لتجهيز الأوردرات
- إدارة المخزون
- تقارير وإحصائيات
- كشف وإدارة المكررات
- نظام المرتجعات

---

## التقنيات المستخدمة (Tech Stack)

| الطبقة | التقنية |
|--------|---------|
| Frontend | React 19 + TypeScript + Tailwind CSS 4 |
| UI Components | shadcn/ui (Radix UI) |
| Routing | Wouter |
| State/Data | TanStack React Query + tRPC 11 |
| Backend | Express 4 + tRPC 11 |
| Database | MySQL (TiDB compatible) |
| ORM | Drizzle ORM |
| Auth (Admin) | Manus OAuth ⚠️ (يحتاج استبدال) |
| Auth (Employees) | JWT + bcrypt (مستقل - يشتغل بدون Manus) |
| QR Code | jsQR (قراءة) + qrcode (إنشاء) |
| Excel | xlsx + xlsx-js-style |
| Shipping | Bosta API |
| Build | Vite (frontend) + esbuild (backend) |
| Package Manager | pnpm |

---

## هيكل المشروع

```
bracelets_management_system/
├── client/                     # Frontend React App
│   ├── src/
│   │   ├── pages/              # 29 صفحة
│   │   │   ├── Dashboard.tsx           # لوحة التحكم الرئيسية
│   │   │   ├── Orders.tsx              # إدارة الأوردرات
│   │   │   ├── OrderDetails.tsx        # تفاصيل أوردر
│   │   │   ├── Employees.tsx           # إدارة الموظفين
│   │   │   ├── EmployeeDashboard.tsx   # داشبورد الموظف (QR Scanner)
│   │   │   ├── EmployeeLogin.tsx       # تسجيل دخول الموظفين
│   │   │   ├── ManagerDashboard.tsx    # داشبورد المدير
│   │   │   ├── AgentWorkspace.tsx      # مساحة عمل الموظف
│   │   │   ├── Preparation.tsx         # تجهيز الأوردرات
│   │   │   ├── ScanOrders.tsx          # مسح QR الأوردرات
│   │   │   ├── ScanLogs.tsx            # سجل المسحات
│   │   │   ├── Inventory.tsx           # المخزون
│   │   │   ├── Reports.tsx             # التقارير
│   │   │   ├── Returns.tsx             # المرتجعات
│   │   │   ├── Duplicates.tsx          # المكررات
│   │   │   ├── PrintedOrders.tsx       # المطبوعات
│   │   │   ├── PrintLogs.tsx           # سجل الطباعات
│   │   │   ├── ShippingSchedule.tsx    # جدول الشحن
│   │   │   ├── TodayShipments.tsx      # شحنات اليوم
│   │   │   ├── Businesses.tsx          # إدارة البراندات
│   │   │   ├── SalesChannels.tsx       # قنوات البيع
│   │   │   ├── ActivityLog.tsx         # سجل الأنشطة
│   │   │   ├── FacebookEntry.tsx       # إدخال أوردرات فيسبوك
│   │   │   ├── WarehouseDashboard.tsx  # داشبورد المخزن
│   │   │   └── WebhookSettings.tsx     # إعدادات Webhook
│   │   ├── components/         # مكونات مشتركة (shadcn/ui)
│   │   ├── contexts/           # React Contexts
│   │   ├── hooks/              # Custom Hooks
│   │   ├── lib/
│   │   │   └── trpc.ts         # tRPC client
│   │   ├── App.tsx             # Routes & Layout
│   │   └── main.tsx            # Entry point
│   └── index.html
├── server/                     # Backend
│   ├── _core/                  # Framework (لا تعدل)
│   │   ├── index.ts            # Express entry point
│   │   ├── env.ts              # Environment variables
│   │   ├── sdk.ts              # Manus OAuth ⚠️
│   │   ├── context.ts          # tRPC context
│   │   ├── llm.ts              # LLM integration
│   │   ├── notification.ts     # Owner notifications
│   │   └── vite.ts             # Vite dev middleware
│   ├── routers.ts              # tRPC procedures (الملف الرئيسي)
│   ├── db.ts                   # Database helpers
│   ├── storage.ts              # S3 storage helpers
│   ├── employeeAuth.ts         # Employee JWT auth (مستقل)
│   ├── bosta.service.ts        # Bosta shipping API
│   ├── bostaWebhook.ts         # Bosta webhook handler
│   ├── easyorderWebhook.ts     # EasyOrder webhook handler
│   ├── exportExcel.ts          # Excel export
│   ├── importExcel.ts          # Excel import
│   ├── shippingSchedules.ts    # Shipping schedules
│   ├── authMiddleware.ts       # Auth middleware
│   └── *.test.ts               # Unit tests (Vitest)
├── drizzle/                    # Database schema & migrations
│   ├── schema.ts               # Drizzle schema (المصدر الرئيسي)
│   └── *.sql                   # Migration files
├── shared/                     # Shared types & constants
└── scripts/                    # Utility scripts
```

---

## المتغيرات البيئية (Environment Variables)

### متغيرات أساسية (مطلوبة)

| المتغير | الوصف | مثال |
|---------|-------|------|
| `DATABASE_URL` | رابط MySQL/TiDB | `mysql://user:pass@host:3306/dbname?ssl={"rejectUnauthorized":true}` |
| `JWT_SECRET` | مفتاح توقيع JWT (admin + employees) | أي string عشوائي طويل |
| `PORT` | بورت السيرفر (اختياري) | `3000` |
| `NODE_ENV` | بيئة التشغيل | `development` أو `production` |

### متغيرات Bosta (للشحن)

| المتغير | الوصف |
|---------|-------|
| `BOSTA_API_KEY` | API Key من حساب بوسطا |
| `BOSTA_BASE_URL` | `https://app.bosta.co/api/v0` |
| `BOSTA_PICKUP_ADDRESS_ID` | ID عنوان الاستلام في بوسطا |
| `BOSTA_WEBHOOK_SECRET` | Secret للتحقق من webhooks بوسطا |

### متغيرات EasyOrder (Webhook)

| المتغير | الوصف |
|---------|-------|
| `EASYORDER_WEBHOOK_SECRET` | Secret للتحقق من webhooks EasyOrder |

### متغيرات Manus ⚠️ (تحتاج استبدال)

هذه المتغيرات خاصة بـ Manus Platform ولن تعمل خارجها:

| المتغير | الوصف | البديل |
|---------|-------|--------|
| `VITE_APP_ID` | Manus OAuth App ID | استبدل بـ auth provider آخر |
| `OAUTH_SERVER_URL` | Manus OAuth Server | استبدل بـ auth provider آخر |
| `VITE_OAUTH_PORTAL_URL` | Manus Login Portal | استبدل بـ login page خاصة |
| `OWNER_OPEN_ID` | Manus Owner ID | حدد admin user ID يدوياً |
| `OWNER_NAME` | اسم المالك | `احمد فرحات` |
| `BUILT_IN_FORGE_API_URL` | Manus LLM/Storage API | استبدل بـ OpenAI API أو S3 |
| `BUILT_IN_FORGE_API_KEY` | Manus API Key | استبدل بـ OpenAI/S3 keys |
| `VITE_FRONTEND_FORGE_API_URL` | Frontend API URL | غير مطلوب لو شلت LLM |
| `VITE_FRONTEND_FORGE_API_KEY` | Frontend API Key | غير مطلوب لو شلت LLM |

---

## تشغيل المشروع محلياً (Local Development)

### المتطلبات

- Node.js 22+
- pnpm 10+
- MySQL 8+ أو TiDB

### خطوات التشغيل

```bash
# 1. Clone the repo
git clone <repo-url>
cd bracelets_management_system

# 2. Install dependencies
pnpm install

# 3. Create .env file
cp .env.example .env
# Edit .env with your values

# 4. Setup database
# Create MySQL database first, then:
pnpm db:push

# 5. Run development server
pnpm dev

# Server will start on http://localhost:3000
```

### أوامر مفيدة

```bash
pnpm dev          # تشغيل development server
pnpm build        # بناء للإنتاج
pnpm start        # تشغيل production build
pnpm check        # TypeScript type checking
pnpm test         # تشغيل الاختبارات (Vitest)
pnpm db:push      # توليد وتطبيق migrations
```

---

## قاعدة البيانات (Database Schema)

### الجداول الرئيسية

| الجدول | الوصف |
|--------|-------|
| `users` | مستخدمي النظام (admin) |
| `employees` | الموظفين (agent, warehouse, manager, scanner, facebook_entry) |
| `businesses` | البراندات (فرحات، عتبة، Nova، إلخ) |
| `business_groups` | مجموعات البراندات |
| `products` | المنتجات |
| `product_variants` | متغيرات المنتجات (لون × مقاس) |
| `orders` | الأوردرات (الجدول الرئيسي) |
| `categories` | التصنيفات |
| `warehouses` | المخازن |
| `inventory_movements` | حركات المخزون |
| `sales_channels` | قنوات البيع |
| `returns` | المرتجعات |
| `scan_logs` | سجل مسح QR |
| `print_logs` | سجل الطباعات |
| `activity_logs` | سجل الأنشطة |
| `webhook_logs` | سجل Webhooks |
| `merge_logs` | سجل دمج المكررات |
| `broadcast_messages` | رسائل البث |
| `tasks` | المهام |
| `order_edit_logs` | سجل تعديلات الأوردرات |

### حالات الأوردر (Order Status Flow)

```
new → confirmed → preparing → shipped → delivered
  ↓       ↓          ↓
postponed  cancelled   returned
  ↓
no_answer
```

### أدوار الموظفين

| الدور | الصلاحيات |
|-------|-----------|
| `agent` | تأكيد/تأجيل/إلغاء الأوردرات |
| `warehouse` | تجهيز وطباعة الأوردرات |
| `manager` | كل صلاحيات agent + إدارة الموظفين |
| `scanner` | مسح QR فقط |
| `facebook_entry` | إدخال أوردرات من فيسبوك |

---

## API Endpoints

### tRPC Procedures (الرئيسية)

كل الـ API تحت `/api/trpc`:
- `orders.*` - CRUD أوردرات
- `employees.*` - إدارة موظفين
- `products.*` - إدارة منتجات
- `inventory.*` - إدارة مخزون
- `reports.*` - تقارير
- `admin.*` - عمليات إدارية
- `managerPortal.*` - بوابة المدير
- `system.*` - إعدادات النظام

### Webhooks

| Endpoint | الوصف |
|----------|-------|
| `POST /api/webhooks/easyorder` | استقبال أوردرات EasyOrder |
| `POST /api/webhooks/bosta` | تحديثات شحن بوسطا |

### Employee Auth

| Endpoint | الوصف |
|----------|-------|
| `POST /api/employee/login` | تسجيل دخول موظف |
| `POST /api/employee/logout` | تسجيل خروج |
| `GET /api/employee/me` | بيانات الموظف الحالي |

---

## ما يحتاج استبدال عند النقل

### 1. نظام Auth للأدمن (أولوية عالية)

الملفات المتأثرة:
- `server/_core/sdk.ts` - Manus OAuth كامل
- `server/_core/context.ts` - بناء context من session
- `client/src/contexts/AuthContext.tsx` - frontend auth state
- `client/src/const.ts` - `getLoginUrl()`

**البديل المقترح:** NextAuth.js أو Clerk أو Lucia Auth

### 2. Storage (أولوية متوسطة)

الملف: `server/storage.ts`

يستخدم Manus Forge API للرفع والتحميل. استبدله بـ:
- AWS S3 مباشرة (الـ SDK موجود أصلاً في dependencies)
- Cloudflare R2
- أو أي S3-compatible storage

### 3. LLM Integration (أولوية منخفضة)

الملف: `server/_core/llm.ts`

مستخدم فقط لو فيه ميزات AI. استبدله بـ OpenAI API مباشرة.

### 4. Notifications (أولوية منخفضة)

الملف: `server/_core/notification.ts`

يبعت notifications للمالك عبر Manus. استبدله بـ:
- Email (SendGrid/Resend)
- Telegram Bot
- أو أي notification service

### 5. Vite Plugin (أولوية منخفضة)

في `vite.config.ts`: شيل `vite-plugin-manus-runtime`

---

## ما يشتغل بدون تعديل

- ✅ نظام الموظفين (login/logout/permissions) - JWT مستقل
- ✅ كل الـ tRPC procedures
- ✅ تكامل بوسطا
- ✅ تكامل EasyOrder Webhook
- ✅ إدارة الأوردرات
- ✅ المخزون
- ✅ QR Scanner
- ✅ Excel import/export
- ✅ التقارير
- ✅ المرتجعات
- ✅ كشف المكررات

---

## Deployment Options

### Option 1: Railway
```bash
# railway.json or Procfile
web: pnpm start
```
- أضف MySQL addon
- أضف env vars

### Option 2: Render
- Web Service: `pnpm build && pnpm start`
- أضف MySQL database

### Option 3: VPS (DigitalOcean/Hetzner)
```bash
# PM2
pm2 start dist/index.js --name bracelets
```

### Option 4: Docker
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
EXPOSE 3000
CMD ["pnpm", "start"]
```

---

## ملاحظات مهمة

1. **الـ Employee Auth شغال مستقل** - مش محتاج Manus OAuth. الموظفين بيسجلوا دخول بـ username/password عادي.

2. **الـ Admin Auth محتاج استبدال** - لو مش محتاج admin panel فوري، ممكن تخلي الموظفين بدور `manager` يعملوا كل حاجة.

3. **قاعدة البيانات** - الـ schema متوافق مع MySQL 8+ و TiDB. استخدم `pnpm db:push` لتطبيق الـ migrations.

4. **الـ Webhooks** - محتاج domain ثابت عشان EasyOrder و Bosta يبعتوا عليه. استخدم ngrok للتطوير المحلي.

5. **الـ QR Scanner** - يحتاج HTTPS عشان الكاميرا تشتغل على الموبايل (إلا localhost).
