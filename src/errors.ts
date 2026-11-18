export class DomainError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'DomainError'; }
}
export const insufficientStock = (m: string) => new DomainError('INSUFFICIENT_STOCK', m);
export const conflict = (m: string) => new DomainError('CONFLICT', m);
export const forbidden = (m: string) => new DomainError('FORBIDDEN', m);
export const invalidState = (m: string) => new DomainError('INVALID_STATE', m);
export const validation = (m: string) => new DomainError('VALIDATION', m);
