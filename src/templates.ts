import type { ItemDef } from './catalog.js';

export interface ActivityTemplate { id: string; label: { ar: string; fr: string }; items: ItemDef[] }
const kg = (sku: string, name: string, price: number, extra: Partial<ItemDef> = {}): ItemDef =>
  ({ sku, name, kind: 'goods', trackQuantity: true, fulfillment: 'stock', baseUom: 'kg', price, ...extra });
const unit = (sku: string, name: string, price: number, extra: Partial<ItemDef> = {}): ItemDef =>
  ({ sku, name, kind: 'goods', trackQuantity: true, fulfillment: 'stock', baseUom: 'unit', price, ...extra });
const service = (sku: string, name: string, price: number): ItemDef =>
  ({ sku, name, kind: 'service', trackQuantity: false, fulfillment: 'none', baseUom: 'unit', price });

/** Starter catalogs: example products so a new shop can try a full sale in minutes. Prices are EXAMPLES the owner must edit. */
export const ACTIVITIES: ActivityTemplate[] = [
  { id: 'butcher', label: { ar: 'جزارة', fr: 'Boucherie' }, items: [
    kg('BUT-BOEUF', 'Viande de bœuf', 120, { batchTracking: 'optional' }), kg('BUT-AGNEAU', 'Viande d’agneau', 140, { batchTracking: 'optional' }),
    kg('BUT-POULET', 'Poulet', 35), kg('BUT-KEFTA', 'Kefta', 110) ] },
  { id: 'grill', label: { ar: 'مشوي', fr: 'Grillades' }, items: [ service('GRL-CUISSON', 'Cuisson grillade (par kg)', 20), unit('GRL-BROCH', 'Brochette', 12, { trackQuantity: false, fulfillment: 'none' }) ] },
  { id: 'restaurant', label: { ar: 'مطعم', fr: 'Restaurant' }, items: [
    unit('RES-PLAT', 'Plat du jour', 60, { trackQuantity: false, fulfillment: 'none' }), unit('RES-BOISSON', 'Boisson', 10, { trackQuantity: false, fulfillment: 'none' }) ] },
  { id: 'grocery', label: { ar: 'مواد غذائية', fr: 'Alimentation générale' }, items: [
    unit('EPI-LAIT', 'Lait 1L', 8, { batchTracking: 'required' }), unit('EPI-HUILE', 'Huile 1L', 18), kg('EPI-SUCRE', 'Sucre', 7) ] },
  { id: 'equipment', label: { ar: 'معدات وقطع غيار', fr: 'Équipements et pièces' }, items: [
    unit('EQP-POMPE', 'Pompe à eau', 1200, { serialTracking: true }), unit('EQP-TUYAU', 'Tuyau (mètre)', 15), service('EQP-INSTALL', 'Installation', 250) ] },
  { id: 'mechanic', label: { ar: 'ميكانيكا السيارات', fr: 'Mécanique auto' }, items: [
    unit('MEC-FILTRE', 'Filtre à huile', 60), unit('MEC-PLAQ', 'Plaquettes de frein', 220), service('MEC-VIDANGE', 'Vidange', 150), service('MEC-MO', 'Main-d’œuvre (heure)', 120) ] },
  { id: 'security_systems', label: { ar: 'أنظمة الإنذار والحريق', fr: 'Alarme et incendie' }, items: [
    unit('SEC-DETECT', 'Détecteur de fumée', 450, { serialTracking: true }), unit('SEC-CENTRALE', 'Centrale d’alarme', 2200, { serialTracking: true }),
    unit('SEC-EXTINCT', 'Extincteur', 380, { serialTracking: true }), service('SEC-INSTALL', 'Installation', 300), service('SEC-MAINT', 'Visite de maintenance', 400) ] },
];
export const activityIds = ACTIVITIES.map((a) => a.id);
