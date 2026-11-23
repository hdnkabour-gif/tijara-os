/** The permission catalog: the single list the role editor offers and the API accepts. */
export const PERMISSION_GROUPS: { id: string; permissions: string[] }[] = [
  { id: 'catalog', permissions: ['catalog.view', 'catalog.manage'] },
  { id: 'stock', permissions: ['stock.view', 'stock.receive', 'stock.adjust'] },
  { id: 'sales', permissions: ['sale.view', 'sale.create', 'sale.discount', 'sale.price_override', 'sale.void'] },
  { id: 'customers', permissions: ['customers.view', 'customers.manage'] },
  { id: 'team', permissions: ['users.manage', 'branches.view', 'branches.manage'] },
  { id: 'reports', permissions: ['report.view', 'report.view_profit', 'audit.view'] },
  { id: 'approvals', permissions: ['approvals.decide'] },
  { id: 'settings', permissions: ['settings.manage'] },
  { id: 'kitchen', permissions: ['kitchen.view','kitchen.manage'] },
  { id: 'purchases', permissions: ['purchases.view','purchases.manage'] },
  { id: 'cash', permissions: ['cash.view','cash.manage'] },
  { id: 'production', permissions: ['production.manage'] },
  { id: 'workshop', permissions: ['workshop.view','workshop.manage'] },
];
export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.permissions);
export const isPermission = (p: string) => ALL_PERMISSIONS.includes(p);
