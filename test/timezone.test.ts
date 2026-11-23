import { afterAll, describe, expect, it } from 'vitest';
import { localMidnight } from '../src/inventory.js';
import { shopToday } from '../src/http.js';
import { closeAll, runtime } from './helpers.js';

afterAll(closeAll);

describe('shop calendar days (Africa/Casablanca)', () => {
  it('TZ1: an expiry day starts at LOCAL midnight, whatever the offset of that date', async () => {
    // 2024-11-25: Casablanca was UTC+1, so the day began at 23:00 UTC the day before (UTC midnight would be 01:00 local)
    expect((await localMidnight(runtime, '2024-11-25')).toISOString()).toBe('2024-11-24T23:00:00.000Z');
    // 2024-03-20 (Ramadan): Casablanca was UTC+0
    expect((await localMidnight(runtime, '2024-03-20')).toISOString()).toBe('2024-03-20T00:00:00.000Z');
  });
  it('TZ2: "today" for the shop follows Casablanca, not UTC', () => {
    expect(shopToday(new Date('2024-11-24T23:30:00Z'))).toBe('2024-11-25');   // 00:30 in Casablanca
    expect(shopToday(new Date('2024-11-24T22:30:00Z'))).toBe('2024-11-24');
  });
});
