# خطة تحويل النظام للعمل Offline كتطبيق Desktop

## نظرة عامة

هذه الخطة لتحويل نظام إدارة الأساور النحاسية للعمل كتطبيق Desktop خاص بالموظفين باستخدام Electron، مع إمكانية العمل بدون إنترنت ومزامنة البيانات عند الاتصال.

---

## المرحلة 1: تجهيز البنية التحتية (أسبوع 1-2)

### 1.1 إعداد Electron Shell
- تثبيت `electron` و `electron-builder` في المشروع
- إنشاء `main.js` (العملية الرئيسية) لفتح نافذة BrowserWindow
- تحميل واجهة React الحالية داخل Electron
- إعداد auto-updater لتحديث التطبيق تلقائياً

### 1.2 قاعدة بيانات محلية (SQLite)
- استخدام `better-sqlite3` كقاعدة بيانات محلية
- إنشاء نفس schema الموجود حالياً في SQLite
- تخزين الأوردرات والمنتجات والموظفين محلياً

### 1.3 Local API Server
- تشغيل Express server محلي داخل Electron (port مخفي)
- نقل tRPC procedures للعمل مع SQLite محلياً
- الواجهة تتصل بـ `localhost` بدلاً من السيرفر الخارجي

---

## المرحلة 2: نظام المزامنة (أسبوع 3-4)

### 2.1 Sync Engine
- تصميم نظام Queue للعمليات المعلقة (Pending Operations)
- كل عملية (تأكيد/إلغاء/تعديل) تتخزن محلياً أولاً
- عند الاتصال بالإنترنت، يتم إرسال العمليات المعلقة للسيرفر الرئيسي

### 2.2 Conflict Resolution
- استخدام timestamps لحل التعارضات (Last Write Wins)
- الأوردرات المؤكدة من الموظف تأخذ أولوية
- تسجيل أي تعارضات في log منفصل للمراجعة

### 2.3 Data Pull
- عند الاتصال: جلب الأوردرات الجديدة الموزعة على الموظف
- مزامنة المنتجات والمخزون
- مزامنة الإشعارات والرسائل

---

## المرحلة 3: واجهة الموظف Offline (أسبوع 5-6)

### 3.1 تعديل بورتال الموظف
- إضافة مؤشر حالة الاتصال (Online/Offline)
- عرض عدد العمليات المعلقة
- تنبيه الموظف عند وجود بيانات غير مرسلة

### 3.2 وضع Offline
- الموظف يقدر يشوف أوردراته ويأكد/يلغي/يؤجل بدون إنترنت
- البيانات تتخزن محلياً وتتزامن لاحقاً
- منع العمليات التي تحتاج تحقق فوري (مثل خصم المخزون الحقيقي)

### 3.3 وضع Online
- مزامنة تلقائية كل 30 ثانية
- إشعار عند نجاح/فشل المزامنة
- إمكانية المزامنة اليدوية

---

## المرحلة 4: التوزيع والتثبيت (أسبوع 7)

### 4.1 Build & Package
- استخدام `electron-builder` لإنشاء installer لـ Windows
- إعداد code signing (اختياري)
- إنشاء portable version (بدون تثبيت)

### 4.2 Auto-Update
- استخدام `electron-updater` مع GitHub Releases أو S3
- التحديث التلقائي في الخلفية
- إشعار الموظف بالتحديثات الجديدة

### 4.3 التوزيع
- رفع الـ installer على رابط مباشر
- إرسال الرابط للموظفين
- دليل تثبيت بسيط

---

## البنية التقنية المقترحة

```
electron-app/
├── main.js                 ← Electron main process
├── preload.js              ← Bridge between main & renderer
├── local-server/
│   ├── index.ts            ← Express + tRPC (local)
│   ├── sqlite-db.ts        ← SQLite connection
│   ├── sync-engine.ts      ← Sync queue & conflict resolution
│   └── routers.ts          ← Same procedures (SQLite version)
├── client/                 ← Same React app (minor changes)
│   └── src/
│       ├── lib/trpc.ts     ← Points to localhost
│       └── components/
│           └── SyncStatus.tsx  ← Online/Offline indicator
├── package.json
└── electron-builder.yml    ← Build config
```

---

## التقنيات المطلوبة

| التقنية | الغرض |
|---------|-------|
| Electron 28+ | Shell للتطبيق |
| better-sqlite3 | قاعدة بيانات محلية |
| electron-builder | بناء وتوزيع |
| electron-updater | تحديثات تلقائية |
| node-cron (local) | مزامنة دورية |

---

## المخاطر والحلول

| المخاطر | الحل |
|---------|------|
| تعارض بيانات بين موظفين | Last Write Wins + Activity Log |
| فقدان بيانات محلية | Backup تلقائي للـ SQLite كل ساعة |
| حجم التطبيق كبير | تقليل dependencies + lazy loading |
| أمان البيانات المحلية | تشفير SQLite + حماية بكلمة مرور |

---

## الجدول الزمني المقدر

| المرحلة | المدة | الأولوية |
|---------|-------|----------|
| إعداد Electron Shell | أسبوع 1 | عالية |
| SQLite + Local Server | أسبوع 2 | عالية |
| Sync Engine | أسبوعين | عالية |
| واجهة Offline | أسبوعين | متوسطة |
| Build & Distribution | أسبوع | متوسطة |
| **الإجمالي** | **7 أسابيع** | - |

---

## البديل السريع: PWA (Progressive Web App)

لو مش محتاج تطبيق Desktop كامل، ممكن نحول النظام لـ PWA:
- يشتغل من المتصفح بدون تثبيت
- يدعم Offline عبر Service Worker
- أسرع في التنفيذ (أسبوعين بدل 7)
- لكن أقل في التحكم بالجهاز

---

## التوصية

**المرحلة الأولى:** ابدأ بـ PWA لأنها أسرع وأسهل في التوزيع
**المرحلة الثانية:** لو احتجت تحكم أكبر (طباعة مباشرة، ملفات محلية)، انتقل لـ Electron

---

*تم إعداد هذه الخطة في 3 مايو 2026*
