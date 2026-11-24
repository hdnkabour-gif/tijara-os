// Arabic / French UI strings. Rendering always goes through textContent (never innerHTML).
const fr = {
  app: 'Tijara OS', loading: 'Chargement…', save: 'Enregistrer', cancel: 'Annuler', close: 'Fermer', create: 'Créer', add: 'Ajouter', remove: 'Retirer',
  email: 'E-mail', password: 'Mot de passe', newPassword: 'Nouveau mot de passe', currentPassword: 'Mot de passe actuel', name: 'Nom', phone: 'Téléphone',
  login: 'Se connecter', logout: 'Déconnexion', forgot: 'Mot de passe oublié ?', resetTitle: 'Choisir un mot de passe', resetDone: 'Mot de passe enregistré. Vous pouvez vous connecter.',
  forgotInfo: 'Si ce compte existe, un lien de réinitialisation sera envoyé par e-mail.', forgotProdNote: 'L’envoi d’e-mails n’est pas encore activé : contactez l’administrateur de la plateforme.',
  invalidCreds: 'Identifiants invalides.', chooseShop: 'Choisissez votre établissement', pwHint: '10 caractères minimum',
  nav_dashboard: 'Tableau de bord', nav_pos: 'Caisse', nav_items: 'Produits & services', nav_stock: 'Stock', nav_customers: 'Clients', nav_invoices: 'Factures', nav_users: 'Équipe', nav_platform: 'Plateforme',
  nav_vehicles: 'Véhicules', nav_workshop: 'Atelier & réparations', nav_reminders: 'Rappels entretien',
  nav_grill: 'Cuisine & grill', nav_suppliers: 'Fournisseurs & achats', nav_cashbook: 'Clôture de caisse', nav_transforms: 'Transformation',
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
  platform: 'Plateforme', shops: 'Établissements', newShop: 'Nouvel établissement', slug: 'Identifiant (slug)', plan: 'Formule', activities: 'Activités', ownerName: 'Nom du propriétaire', ownerEmail: 'E-mail du propriétaire', ownerPassword: 'Mot de passe initial', selfOwner: 'Gérer cet établissement pilote avec mon compte administrateur',
  created: 'Établissement créé', itemsCount: 'Articles', usersCount: 'Utilisateurs',
  errNetwork: 'Erreur réseau', errGeneric: 'Une erreur est survenue', errForbidden: 'Action non autorisée', errStock: 'Stock insuffisant ou état invalide',
  language: 'Langue', demoNote: 'Environnement de test : n’entrez aucune donnée réelle.',
  nav_orders: 'Commandes', nav_plan: 'Ma formule', controlCenter: 'Control Center', p_overview: 'Vue d’ensemble', p_shops: 'Commerces', p_audit: 'Journal plateforme', myShops: 'Ouvrir un commerce',
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
  nav_vehicles: 'السيارات', nav_workshop: 'الورشة والإصلاح', nav_reminders: 'تذكير بالصيانة',
  nav_grill: 'المطبخ والمشوي', nav_suppliers: 'الموردون والمشتريات', nav_cashbook: 'الصندوق', nav_transforms: 'تحويل اللحوم',
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
  platform: 'المنصة', shops: 'المؤسسات', newShop: 'مؤسسة جديدة', slug: 'المعرّف (slug)', plan: 'الباقة', activities: 'الأنشطة', ownerName: 'اسم المالك', ownerEmail: 'بريد المالك', ownerPassword: 'كلمة المرور الأولية', selfOwner: 'إدارة هذا المحل التجريبي بحساب مدير المنصة الحالي',
  created: 'تم إنشاء المؤسسة', itemsCount: 'الأصناف', usersCount: 'المستخدمون',
  errNetwork: 'خطأ في الشبكة', errGeneric: 'حدث خطأ', errForbidden: 'إجراء غير مسموح', errStock: 'المخزون غير كافٍ أو الحالة غير صالحة',
  language: 'اللغة', demoNote: 'بيئة تجريبية: لا تُدخل أي بيانات حقيقية.',
  nav_orders: 'الطلبات', nav_plan: 'باقتي', controlCenter: 'مركز التحكم', p_overview: 'نظرة عامة', p_shops: 'المحلات', p_audit: 'سجل المنصة', myShops: 'فتح محل',
  demoBadge: 'تجريبي', workspaceNav: 'مساحة العمل', platformWorkspace: 'إدارة المنصة', platformIntro: 'كل المؤسسات والأنشطة والفرق في مساحة واحدة.',
  shopsCount: 'المؤسسات', platformScope: 'المساحة', platformScopeValue: 'إدارة المؤسسات',
  getStarted: 'بداية موجّهة', platformEmptyTitle: 'ابدأ بإنشاء أول مؤسسة',
  platformEmptyDetail: 'لم تُنشأ أي مؤسسة بعد. اختر النشاط وأنشئ أصنافاً تجريبية لاكتشاف طريقة العمل، دون إدخال بيانات حقيقية.',
  setupCreate: 'إنشاء المؤسسة', setupActivities: 'اختيار الأنشطة', setupDemo: 'التجربة ببيانات افتراضية', startFirstShop: 'إنشاء المؤسسة الأولى',
  act_butcher: 'جزارة', act_grill: 'مشوي', act_restaurant: 'مطعم', act_grocery: 'مواد غذائية', act_equipment: 'معدات وقطع غيار', act_mechanic: 'ميكانيكا السيارات', act_security_systems: 'أنظمة الإنذار والحريق',
};

Object.assign(fr, {
  edit: 'Modifier', del: 'Supprimer', archive: 'Archiver', restore: 'Réactiver', actions: 'Actions', saved: 'Enregistré', deleted: 'Supprimé', yes: 'Oui', no: 'Non',
  confirmDelete: 'Supprimer définitivement ?', inUseHint: 'Cet élément a un historique : archivez-le au lieu de le supprimer.', archived: 'archivé', activeLabel: 'Actif',
  showArchived: 'Afficher les archivés', address: 'Adresse', notes: 'Notes', print: 'Imprimer', back: 'Retour',
  nav_roles: 'Rôles & permissions', nav_settings: 'Paramètres', nav_journal: 'Journal',
  role_owner: 'Propriétaire', role_manager: 'Gérant', role_cashier: 'Caissier',
  editUser: 'Modifier le collaborateur', resetPassword: 'Réinitialiser le mot de passe', deactivate: 'Désactiver', reactivate: 'Réactiver', inactive: 'inactif', userActive: 'actif',
  resetNote: 'Toutes les sessions de ce collaborateur seront fermées.', selfNote: 'Vous ne pouvez pas modifier votre propre rôle ni vous désactiver.',
  newRole: 'Nouveau rôle', roleCode: 'Nom du rôle (minuscules, chiffres, _)', permissions: 'Permissions', members: 'Membres', systemRole: 'rôle système', lockedRole: 'Ce rôle ne peut pas être modifié.',
  g_catalog: 'Produits', g_stock: 'Stock', g_sales: 'Ventes', g_customers: 'Clients', g_team: 'Équipe', g_reports: 'Rapports', g_approvals: 'Validations', g_settings: 'Paramètres',
  'p_catalog.view': 'Voir les produits', 'p_catalog.manage': 'Gérer les produits et services', 'p_stock.view': 'Voir le stock', 'p_stock.receive': 'Réceptionner du stock', 'p_stock.adjust': 'Ajuster le stock',
  'p_sale.view': 'Voir les ventes', 'p_sale.create': 'Vendre (caisse)', 'p_sale.discount': 'Accorder des remises', 'p_sale.price_override': 'Modifier un prix en caisse', 'p_sale.void': 'Annuler une vente',
  'p_customers.view': 'Voir les clients', 'p_customers.manage': 'Gérer les clients', 'p_users.manage': 'Gérer l’équipe et les rôles', 'p_branches.view': 'Voir les points de vente', 'p_branches.manage': 'Gérer les points de vente',
  'p_report.view': 'Voir le tableau de bord', 'p_report.view_profit': 'Voir les marges', 'p_audit.view': 'Voir le journal', 'p_approvals.decide': 'Valider les demandes', 'p_settings.manage': 'Gérer les paramètres du commerce',
  shopName: 'Nom du commerce', company: 'Informations légales (imprimées sur les factures)', legalName: 'Raison sociale', ice: 'ICE', ifNo: 'IF', rcNo: 'RC', footer: 'Message en pied de facture', phoneShop: 'Téléphone',
  branchesTitle: 'Points de vente', addBranch: 'Ajouter un point de vente', rename: 'Renommer',
  journalTitle: 'Journal des opérations', who: 'Par', what: 'Action', onWhat: 'Objet',
  invoiceTitle: 'Facture', customerLbl: 'Client', branchLbl: 'Point de vente', subtotal: 'Sous-total', paymentsLbl: 'Règlements', methodCash: 'Espèces', methodCard: 'Carte', methodTransfer: 'Virement', thanks: 'Merci de votre confiance.',
  qtyShort: 'Qté', puHt: 'Prix unitaire', totalLine: 'Total',
});
Object.assign(ar, {
  edit: 'تعديل', del: 'حذف', archive: 'أرشفة', restore: 'إعادة تفعيل', actions: 'إجراءات', saved: 'تم الحفظ', deleted: 'تم الحذف', yes: 'نعم', no: 'لا',
  confirmDelete: 'حذف نهائي؟', inUseHint: 'لهذا العنصر سجل عمليات: أرشفه بدل حذفه.', archived: 'مؤرشف', activeLabel: 'نشط',
  showArchived: 'إظهار المؤرشف', address: 'العنوان', notes: 'ملاحظات', print: 'طباعة', back: 'رجوع',
  nav_roles: 'الأدوار والصلاحيات', nav_settings: 'الإعدادات', nav_journal: 'سجل العمليات',
  role_owner: 'المالك', role_manager: 'المدير', role_cashier: 'الكاشير',
  editUser: 'تعديل الموظف', resetPassword: 'إعادة تعيين كلمة المرور', deactivate: 'تعطيل', reactivate: 'إعادة تفعيل', inactive: 'معطّل', userActive: 'نشط',
  resetNote: 'سيتم إغلاق جميع جلسات هذا الموظف.', selfNote: 'لا يمكنك تغيير دورك ولا تعطيل نفسك.',
  newRole: 'دور جديد', roleCode: 'اسم الدور (أحرف صغيرة وأرقام و _)', permissions: 'الصلاحيات', members: 'الأعضاء', systemRole: 'دور أساسي', lockedRole: 'لا يمكن تعديل هذا الدور.',
  g_catalog: 'المنتجات', g_stock: 'المخزون', g_sales: 'المبيعات', g_customers: 'العملاء', g_team: 'الفريق', g_reports: 'التقارير', g_approvals: 'الموافقات', g_settings: 'الإعدادات',
  'p_catalog.view': 'عرض المنتجات', 'p_catalog.manage': 'إدارة المنتجات والخدمات', 'p_stock.view': 'عرض المخزون', 'p_stock.receive': 'استلام المخزون', 'p_stock.adjust': 'تعديل المخزون',
  'p_sale.view': 'عرض المبيعات', 'p_sale.create': 'البيع (الكاشير)', 'p_sale.discount': 'منح خصومات', 'p_sale.price_override': 'تعديل السعر عند البيع', 'p_sale.void': 'إلغاء بيع',
  'p_customers.view': 'عرض العملاء', 'p_customers.manage': 'إدارة العملاء', 'p_users.manage': 'إدارة الفريق والأدوار', 'p_branches.view': 'عرض نقاط البيع', 'p_branches.manage': 'إدارة نقاط البيع',
  'p_report.view': 'عرض لوحة التحكم', 'p_report.view_profit': 'عرض الأرباح', 'p_audit.view': 'عرض سجل العمليات', 'p_approvals.decide': 'البتّ في الطلبات', 'p_settings.manage': 'إدارة إعدادات المحل',
  shopName: 'اسم المحل', company: 'المعلومات القانونية (تُطبع على الفواتير)', legalName: 'الاسم القانوني', ice: 'ICE', ifNo: 'IF', rcNo: 'RC', footer: 'عبارة أسفل الفاتورة', phoneShop: 'الهاتف',
  branchesTitle: 'نقاط البيع', addBranch: 'إضافة نقطة بيع', rename: 'إعادة تسمية',
  journalTitle: 'سجل العمليات', who: 'بواسطة', what: 'الإجراء', onWhat: 'الموضوع',
  invoiceTitle: 'فاتورة', customerLbl: 'العميل', branchLbl: 'نقطة البيع', subtotal: 'المجموع الفرعي', paymentsLbl: 'المدفوعات', methodCash: 'نقداً', methodCard: 'بطاقة', methodTransfer: 'تحويل', thanks: 'شكراً لثقتكم.',
  qtyShort: 'الكمية', puHt: 'سعر الوحدة', totalLine: 'المجموع',
});
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
/** A calendar day 'YYYY-MM-DD' (no time, no timezone shift). */
export const dayFmt = (v) => (v ? new Date(`${String(v).slice(0, 10)}T12:00:00Z`).toLocaleDateString(lang === 'ar' ? 'ar-MA-u-nu-latn' : 'fr-MA', { timeZone: 'UTC' }) : '');
export const dateFmt = (v) => new Date(v).toLocaleString(lang === 'ar' ? 'ar-MA-u-nu-latn' : 'fr-MA', { dateStyle: 'short', timeStyle: 'short' });

export const uom = (u) => (lang === 'ar' ? ({ kg: 'كلغ', g: 'غ', l: 'لتر', unit: 'قطعة' }[u] ?? u) : (u === 'unit' ? 'pièce' : u));

export const roleLabel = (n) => { const v = t('role_' + n); return v === 'role_' + n ? n : v; };
