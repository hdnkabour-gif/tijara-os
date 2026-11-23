import type pg from 'pg';

/** Shops live on Moroccan local days. Offsets (UTC+1, UTC+0, Ramadan changes) come from the tz database, never hard-coded. */
export const SHOP_TZ = 'Africa/Casablanca';

/** Today's calendar day in the shop's timezone, 'YYYY-MM-DD'. */
export const shopToday = (at: Date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: SHOP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

/** The instant a local calendar day begins in the shop's timezone. */
export async function localMidnight(c: pg.PoolClient | pg.Client | pg.Pool, day: string, tz = SHOP_TZ): Promise<Date> {
  return (await c.query(`SELECT ($1::date::timestamp AT TIME ZONE $2) AS t`, [day, tz])).rows[0].t as Date;
}
