# النشر على Railway (staging)

> بيئة **تجريبية بلا بيانات حقيقية**. الخادم لا يكشف نقاط أعمال (فقط `/health` و`/ready`).

| العنصر | القيمة |
|---|---|
| المشروع | `tijara-os-staging` (مشروع جديد منفصل؛ لم تُمس مشاريع أخرى في الحساب) |
| البيئة | `staging` |
| الخدمات | `Postgres` (قالب Railway الرسمي) و`tijara-os` (هذا المستودع عبر Dockerfile) |
| العنوان | https://tijara-os-staging.up.railway.app |
| المتغيرات | `DATABASE_URL` (مرجع لخدمة Postgres)، `APP_ENV=production`، وكلمات مرور الأدوار الثلاثة (عشوائية 48 حرفاً، مخزنة في Railway فقط) |

## ما تحقق منه على الإنترنت (فعلياً)
- بناء Docker ونشر ناجحان؛ سجل الإقلاع: تطبيق الترحيل، ثم `security posture OK: 3 non-bypass roles, all tenant tables FORCE RLS`.
- `GET /health` ← 200؛ `GET /ready` ← 200 (`rlsBypassPossible:false`, `unprotectedTables:0`, `migrated:true`)؛ أي مسار آخر ← 404.

## كيف نُشر
رُفعت شيفرة `git archive` (بلا `node_modules`/أسرار) عبر واجهة Railway، لأن المستودع على GitHub لم يكن قد أُنشئ بعد. **عند ربط GitHub** يُفضَّل تحويل الخدمة إلى النشر التلقائي من `main`.

## تحسينات مطلوبة قبل أي بيانات حقيقية
- الخدمة تحمل `DATABASE_URL` (مدير القاعدة) في بيئتها لأجل الترحيل؛ التطبيق نفسه يتصل بدور `app_runtime` فقط. الأفضل فصل الترحيل في مهمة منفصلة بحيث لا يوجد اعتماد المدير في خدمة التشغيل.
- نسخ احتياطي واختبار استعادة، ومراقبة، ودومين خاص، وبيئة production منفصلة.
- المصادقة وAPI الأعمال غير موجودة بعد.
