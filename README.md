# Tijara OS

منصة SaaS متعددة المؤسسات لتسيير المحلات (جزارة/مشوي/مطعم، ميكانيكا، إنذار وحريق…). **نموذج تجريبي (staging): مصادقة وAPI وواجهة ويب (عربي/فرنسي). لا بيانات حقيقية بعد.**

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
انظر `docs/DEPLOYMENT.md` (فصل خدمة الترحيل عن التشغيل، مدير المنصة الأول، النسخ الاحتياطي، شروط البيانات الحقيقية).
