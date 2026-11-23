// Arabic / French UI strings. Rendering always goes through textContent (never innerHTML).
const fr = {
  app: 'Tijara OS', loading: 'Chargement…', save: 'Enregistrer', cancel: 'Annuler', close: 'Fermer', create: 'Créer', add: 'Ajouter', remove: 'Retirer',
  email: 'E-mail', password: 'Mot de passe', newPassword: 'Nouveau mot de passe', currentPassword: 'Mot de passe actuel', name: 'Nom', phone: 'Téléphone',
  login: 'Se connecter', logout: 'Déconnexion', forgot: 'Mot de passe oublié ?', resetTitle: 'Choisir un mot de passe', resetDone: 'Mot de passe enregistré. Vous pouvez vous connecter.',
  forgotInfo: 'Si ce compte existe, un lien de réinitialisation sera envoyé par e-mail.', forgotProdNote: 'L’envoi d’e-mails n’est pas encore activé : contactez l’administrateur de la plateforme.',
  invalidCreds: 'Identifiants invalides.', chooseShop: 'Choisissez votre établissement', pwHint: '10 caractères minimum',
  nav_dashboard: 'Tableau de bord', nav_pos: 'Caisse', nav_items: 'Produits & services', nav_stock: 'Stock', nav_customers: 'Clients', nav_invoices: 'Factures', nav_users: 'Équipe', nav_platform: 'Plateforme',
  salesToday: 'Ventes du jour', invoicesToday: 'Factures du jour', receivables: 'Créances clients', lowStock: 'Stock le plus bas', quickActions: 'Actions rapides',
  sku: 'Référence', price: 'Prix', kind: 'Type', stockOnHand: 'En stock', reserved: 'Réservé', available: 'Disponible', unit: 'Unité',
  newItem: 'Nouveau produit / service', itemType: 'Type d’article',
  type_unit: 'Produit à la pièce', type_weighed: 'Produit pesé (kg)', type_batch: 'Produit avec lots / péremption', type_serial: 'Produit avec numéro de série', type_service: 'Service',
  sample: 'exemple', sampleNote: 'Les produits marqués « exemple » viennent du modèle de votre activité : modifiez leurs prix avant de vendre.',
  receive: 'Réception de stock', branch: 'Point de vente', item: 'Article', qty: 'Quantité', unitCost: 'Coût unitaire', batchNo: 'N° de lot', expiresAt: 'Date de péremption',
  serials: 'Numéros de série (un par ligne)', warrantyUntil: 'Garantie jusqu’au',
  pos_search: 'Rechercher…', cart: 'Panier', cartEmpty: 'Panier vide : touchez un article.', total: 'Total', payCash: 'Espèces', payCard: 'Carte', payTransfer: 'Virement', payCredit: 'À crédit',
  customer: 'Client', noCustomer: '— Client de passage —', amountPaid: 'Montant payé', due: 'Reste à payer', saleDone: 'Vente enregistrée', newSale: 'Nouvelle vente', invoice: 'Facture',
  weight: 'Poids / quantité', serialNo: 'N° de série', confirm: 'Valider', all: 'Tout', onlyProducts: 'Produits', onlyServices: 'Services',
  invoices: 'Factures', date: 'Date', status: 'État', paid: 'Payé', cancelSale: 'Annuler la vente', reason: 'Motif', handling: 'Sort du produit', handlingWaste: 'Perte (jeté)', handlingReturn: 'Retour en stock (accord requis)',
  cancelled: 'Vente annulée', void: 'annulée', issued: 'émise', creditLimit: 'Plafond de crédit', balance: 'Solde',
  users: 'Équipe', role: 'Rôle', branches: 'Points de vente', newUser: 'Nouveau collaborateur', allBranches: 'Tous',
  platform: 'Plateforme', shops: 'Établissements', newShop: 'Nouvel établissement', slug: 'Identifiant (slug)', plan: 'Formule', activities: 'Activités', ownerName: 'Nom du propriétaire', ownerEmail: 'E-mail du propriétaire', ownerPassword: 'Mot de passe initial',
  created: 'Établissement créé', itemsCount: 'Articles', usersCount: 'Utilisateurs',
  errNetwork: 'Erreur réseau', errGeneric: 'Une erreur est survenue', errForbidden: 'Action non autorisée', errStock: 'Stock insuffisant ou état invalide',
  language: 'Langue', demoNote: 'Environnement de test : n’entrez aucune donnée réelle.',
  demoBadge: 'BÊTA', workspaceNav: 'ESPACE DE TRAVAIL', platformWorkspace: 'Administration', platformIntro: 'Vos établissements, leurs activités et leurs équipes dans un seul espace.',
  shopsCount: 'Établissements', platformScope: 'Espace', platformScopeValue: 'Gestion des établissements',
  getStarted: 'Démarrage guidé', platformEmptyTitle: 'Votre premier établissement commence ici',
  platformEmptyDetail: 'Aucun établissement n’est encore créé. Configurez une activité avec des articles de démonstration pour découvrir le fonctionnement, sans utiliser de données réelles.',
  setupCreate: 'Créer l’établissement', setupActivities: 'Choisir les activités', setupDemo: 'Explorer en mode démo', startFirstShop: 'Créer le premier établissement',
  act_butcher: 'Boucherie', act_grill: 'Grillades', act_restaurant: 'Restaurant', act_grocery: 'Alimentation générale', act_equipment: 'Équipements et pièces', act_mechanic: 'Mécanique auto', act_security_systems: 'Alarme et incendie',
};
const ar = {
  app: 'تجارة', loading: 'جارٍ التحميل…', save: 'حفظ', cancel: 'إلغاء', close: 'إغلاق', create: 'إنشاء', add: 'إضافة', remove: 'إزالة',
  email: 'البريد الإلكتروني', password: 'كلمة المرور', newPassword: 'كلمة مرور جديدة', currentPassword: 'كلمة المرور الحالية', name: 'الاسم', phone: 'الهاتف',
  login: 'تسجيل الدخول', logout: 'تسجيل الخروج', forgot: 'نسيت كلمة المرور؟', resetTitle: 'اختيار كلمة مرور', resetDone: 'تم حفظ كلمة المرور. يمكنك الآن تسجيل الدخول.',
  forgotInfo: 'إذا كان الحساب موجوداً فسيُرسل رابط إعادة التعيين بالبريد.', forgotProdNote: 'إرسال البريد غير مفعّل بعد: تواصل مع مدير المنصة.',
  invalidCreds: 'بيانات الدخول غير صحيحة.', chooseShop: 'اختر المؤسسة', pwHint: '10 أحرف على الأقل',
  nav_dashboard: 'لوحة التحكم', nav_pos: 'نقطة البيع', nav_items: 'المنتجات والخدمات', nav_stock: 'المخزون', nav_customers: 'العملاء', nav_invoices: 'الفواتير', nav_users: 'الفريق', nav_platform: 'المنصة',
  salesToday: 'مبيعات اليوم', invoicesToday: 'فواتير اليوم', receivables: 'ديون العملاء', lowStock: 'أقل المخزون', quickActions: 'إجراءات سريعة',
  sku: 'المرجع', price: 'السعر', kind: 'النوع', stockOnHand: 'في المخزون', reserved: 'محجوز', available: 'المتاح', unit: 'الوحدة',
  newItem: 'منتج / خدمة جديدة', itemType: 'نوع الصنف',
  type_unit: 'منتج بالقطعة', type_weighed: 'منتج بالوزن (كلغ)', type_batch: 'منتج بدفعات وصلاحية', type_serial: 'منتج برقم تسلسلي', type_service: 'خدمة',
  sample: 'مثال', sampleNote: 'المنتجات الموسومة «مثال» جاءت من قالب نشاطك: عدّل أسعارها قبل البيع.',
  receive: 'استلام مخزون', branch: 'نقطة البيع', item: 'الصنف', qty: 'الكمية', unitCost: 'تكلفة الوحدة', batchNo: 'رقم الدفعة', expiresAt: 'تاريخ الانتهاء',
  serials: 'الأرقام التسلسلية (رقم في كل سطر)', warrantyUntil: 'الضمان حتى',
  pos_search: 'بحث…', cart: 'السلة', cartEmpty: 'السلة فارغة: المس صنفاً.', total: 'المجموع', payCash: 'نقداً', payCard: 'بطاقة', payTransfer: 'تحويل', payCredit: 'بالآجل',
  customer: 'العميل', noCustomer: '— زبون عابر —', amountPaid: 'المبلغ المدفوع', due: 'المتبقي', saleDone: 'تم تسجيل البيع', newSale: 'بيع جديد', invoice: 'فاتورة',
  weight: 'الوزن / الكمية', serialNo: 'الرقم التسلسلي', confirm: 'تأكيد', all: 'الكل', onlyProducts: 'منتجات', onlyServices: 'خدمات',
  invoices: 'الفواتير', date: 'التاريخ', status: 'الحالة', paid: 'المدفوع', cancelSale: 'إلغاء البيع', reason: 'السبب', handling: 'مصير المنتج', handlingWaste: 'تالف (يُطرح)', handlingReturn: 'إرجاع للمخزون (يلزم إذن)',
  cancelled: 'أُلغي البيع', void: 'ملغاة', issued: 'صادرة', creditLimit: 'سقف الدين', balance: 'الرصيد',
  users: 'الفريق', role: 'الدور', branches: 'نقاط البيع', newUser: 'موظف جديد', allBranches: 'الكل',
  platform: 'المنصة', shops: 'المؤسسات', newShop: 'مؤسسة جديدة', slug: 'المعرّف (slug)', plan: 'الباقة', activities: 'الأنشطة', ownerName: 'اسم المالك', ownerEmail: 'بريد المالك', ownerPassword: 'كلمة المرور الأولية',
  created: 'تم إنشاء المؤسسة', itemsCount: 'الأصناف', usersCount: 'المستخدمون',
  errNetwork: 'خطأ في الشبكة', errGeneric: 'حدث خطأ', errForbidden: 'إجراء غير مسموح', errStock: 'المخزون غير كافٍ أو الحالة غير صالحة',
  language: 'اللغة', demoNote: 'بيئة تجريبية: لا تُدخل أي بيانات حقيقية.',
  demoBadge: 'تجريبي', workspaceNav: 'مساحة العمل', platformWorkspace: 'إدارة المنصة', platformIntro: 'كل المؤسسات والأنشطة والفرق في مساحة واحدة.',
  shopsCount: 'المؤسسات', platformScope: 'المساحة', platformScopeValue: 'إدارة المؤسسات',
  getStarted: 'بداية موجّهة', platformEmptyTitle: 'ابدأ بإنشاء أول مؤسسة',
  platformEmptyDetail: 'لم تُنشأ أي مؤسسة بعد. اختر النشاط وأنشئ أصنافاً تجريبية لاكتشاف طريقة العمل، دون إدخال بيانات حقيقية.',
  setupCreate: 'إنشاء المؤسسة', setupActivities: 'اختيار الأنشطة', setupDemo: 'التجربة ببيانات افتراضية', startFirstShop: 'إنشاء المؤسسة الأولى',
  act_butcher: 'جزارة', act_grill: 'مشوي', act_restaurant: 'مطعم', act_grocery: 'مواد غذائية', act_equipment: 'معدات وقطع غيار', act_mechanic: 'ميكانيكا السيارات', act_security_systems: 'أنظمة الإنذار والحريق',
};
const dicts = { fr, ar };
let lang = 'fr';
try { const s = localStorage.getItem('lang'); lang = s === 'ar' || s === 'fr' ? s : (navigator.language || '').startsWith('ar') ? 'ar' : 'fr'; } catch { /* storage may be blocked */ }
export const getLang = () => lang;
export function setLang(l) {
  lang = l;
  try { localStorage.setItem('lang', l); } catch { /* non-sensitive preference only */ }
  document.documentElement.lang = l; document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
}
export const t = (k) => dicts[lang][k] ?? dicts.fr[k] ?? k;
setLang(lang);

export function money(v) {
  const n = Number(v) || 0;
  return new Intl.NumberFormat(lang === 'ar' ? 'ar-MA-u-nu-latn' : 'fr-MA', { style: 'currency', currency: 'MAD', minimumFractionDigits: 2 }).format(n);
}
export const qtyFmt = (v) => new Intl.NumberFormat(lang === 'ar' ? 'ar-MA-u-nu-latn' : 'fr-MA', { maximumFractionDigits: 3 }).format(Number(v) || 0);
export const dateFmt = (v) => new Date(v).toLocaleString(lang === 'ar' ? 'ar-MA-u-nu-latn' : 'fr-MA', { dateStyle: 'short', timeStyle: 'short' });

export const uom = (u) => (lang === 'ar' ? ({ kg: 'كلغ', g: 'غ', l: 'لتر', unit: 'قطعة' }[u] ?? u) : (u === 'unit' ? 'pièce' : u));
