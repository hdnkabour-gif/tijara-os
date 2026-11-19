# Tijara OS

منصة SaaS متعددة المؤسسات لتسيير المحلات (جزارة/مشوي/مطعم، ميكانيكا، إنذار وحريق…). **نموذج أولي: طبقة المجال وقاعدة البيانات فقط؛ لا واجهات ولا API للأعمال بعد.**

- `docs/PRODUCT_AND_ARCHITECTURE.md` — المنتج والمعمارية (v0.2)
- `docs/SHOPS_AND_DATA.md` — المحلات الثلاثة الأولى، البيانات، العزل، الفجوات
- `docs/TEST_STATUS.md` — حالة الاختبارات الفعلية والحدود المعروفة

## تشغيل محلي
```bash
./scripts/setup-db.sh                 # أدوار وقاعدة اختبار (يتطلب PostgreSQL محلياً)
npm install --include=dev             # NODE_ENV=production يتجاهل devDependencies
npm run typecheck && npm test
```

## النشر (Railway)
1. خدمة PostgreSQL + خدمة من هذا المستودع (يستعمل `Dockerfile` و`railway.json`).
2. متغيرات الخدمة: `DATABASE_URL` (مرجع لخدمة Postgres)، `APP_OWNER_PASSWORD`، `APP_RUNTIME_PASSWORD`، `APP_PLATFORM_PASSWORD` (عشوائية، ≥16 حرفاً، مختلفة).
3. عند كل نشر: `migrate` ينشئ الأدوار الثلاثة (بلا SUPERUSER ولا BYPASSRLS) ويطبق الترحيلات مرة واحدة ويتحقق من الأمان، ثم يبدأ الخادم.
4. `/health` للحياة، `/ready` يفشل (503) إن وُجد دور يتجاوز RLS أو جدول مؤسسة بلا RLS.
5. الخادم الحالي **لا يكشف أي نقطة أعمال**، فلا يمكن أن يسرّب بيانات محل.

> لا بيانات محلات حقيقية قبل: مصادقة، نسخ احتياطي واستعادة مجربة، تشفير الحقول الحساسة (انظر `docs/SHOPS_AND_DATA.md` القسم 8).
