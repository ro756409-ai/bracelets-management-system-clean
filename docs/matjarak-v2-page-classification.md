# Matjarak V2 — تصنيف الصفحات القديمة (KEEP / MERGE / REDESIGN / HIDE / REMOVE-LATER)

> قاعدة: **مفيش حذف في V2.** كل route لسه شغّال (backward compat). التصنيف بيحدد مصير كل
> صفحة في التجربة الجديدة. الحالات:
> - **KEEP**: تفضل كما هي، وجهة/تبويب في V2.
> - **MERGE**: تندمج داخل workspace موحّد (الصفحة تبقى تبويب/قسم، مش وجهة مستقلة).
> - **REDESIGN**: محتاجة إعادة بناء UX داخل الـworkspace (مرحلة تالية، الـAPI ثابت).
> - **HIDE**: تتشال من التنقّل الأساسي، تروح «المزيد»/داخل workspace (الـroute شغّال).
> - **REMOVE-LATER**: مرشحة للإزالة بعد Finance V2/موافقة — **مش دلوقتي**.

## الطلبات (Orders workspace)
| صفحة/route | تصنيف | مكانها في V2 |
|-----------|-------|--------------|
| `/orders` | REDESIGN | قلب Orders workspace |
| `/bosta-orders` | MERGE | تبويب داخل الطلبات |
| `/returns` | MERGE | تبويب (adminOnly) |
| `/duplicates` | MERGE→HIDE | تبويب/أداة (adminOnly) |
| `/printed-orders` | MERGE | تبويب |
| `/scan-orders` | KEEP | إجراء تشغيلي (QR) |

## التشغيل (Operations)
| `/preparation` | REDESIGN | قلب Operations |
| `/today-shipments` | MERGE | تبويب |
| `/shipping-schedule` | MERGE | تبويب |

## المخزون (Inventory)
| `/inventory` | REDESIGN | قلب Inventory |
| `/goods-receipt` | MERGE | تبويب (inventory_costing.view) |
| `/stocktake` | KEEP | تبويب (متبني V2 بالفعل) |
| `/stock-transfer` | HIDE | route شغّال؛ مغطّى بـ«مرتجعات الورشة» |
| `/workshop-returns` | MERGE | تبويب (adminOnly) |

## الفريق (Team)
| `/employees` | REDESIGN | قلب Team (متبني V2 جزئيًا: business picker) |
| الأدوار/الصلاحيات | REDESIGN(جديد) | تبويب داخل Team (يستخدم rolePermission endpoints الحالية) |

## التقارير (Reports)
| `/reports` | KEEP/REDESIGN | وجهة التقارير |
| `/merge-logs` | HIDE | «المزيد» (adminOnly) |

## الإعدادات / التكاملات (Settings)
| `/businesses` | KEEP | إدارة الأنشطة |
| `/sales-channels` | MERGE | تبويب إعدادات |
| `/webhook-settings` | MERGE | تبويب تكاملات |

## أدوات/سجلّات (More)
| `/print-logs` `/scan-logs` `/activity-log` | HIDE | «المزيد» |

## الحسابات (FROZEN — شوف accounting-archive-inventory.md)
| `/accounting` وكل شاشاته (`/treasury` `/expenses` `/collections` `/daily-collections` `/daily-ledger` `/payroll` `/salary-profiles` `/salary-preparation` `/closings` `/advertising` `/shipping-finance` `/supplier-statements` `/accounting-settings`) | REMOVE-LATER (FROZEN) | رابط واحد هادي في «المزيد» (accounting.view). **مش REDESIGN، مش REMOVE الآن** — لحد Finance V2 |
| `/accountant` (مساحة المحاسب) | KEEP (FROZEN) | مسار دور accountant — لا يُمَس |

## لوحات الموظفين (portal — employee_token)
| `/employee-dashboard` `/warehouse-dashboard` `/manager-dashboard` `/facebook-entry` | KEEP | بوابة منفصلة (cookie مختلف)، role-based redirect |
