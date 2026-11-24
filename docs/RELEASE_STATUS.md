# TIJARA OS — release status

Short, factual log of what is merged, deployed and authorized. Update it in every PR that changes the release state.
Statuses per change: **code accepted → merged → staging validated → production validated → real data authorized**.

## Current state (2026-11-24)

| Item | State |
|---|---|
| `main` | `f9ec9db` (PR #17 merged). CI PG16 + PG18 green: [run 45396629489](https://github.com/hdnkabour-gif/tijara-os/actions/runs/45396629489) |
| Staging (Railway project `tijara-os-staging`, environment `staging`) | app + migrator run `f9ec9db`; `/ready`: `pendingMigrations 0`, `unprotectedTables 0`, `rlsBypassPossible false` |
| Migrations live on staging | 001 → 013 (011 on 2026-11-23; 012 and 013 on 2026-11-24; each logged by the migrator) |
| Production | **does not exist yet**. No separate project, database, domain or secrets. Nothing is "production validated". |
| Real data | **not authorized**. Blocked by the production gate below. |
| Repository visibility | **public** (owner action pending: Settings → General → Danger Zone → Private). History may already have been copied. |

## Releases

| PR | Content | Code | Merged | Staging | Production | Real data |
|---|---|---|---|---|---|---|
| #12 | grill/workshop integrity (reminders, mileage, multi-line, stable idempotency keys) | ✅ | ✅ `3d4f8b9` | ✅ `3d4f8b9` | — | — |
| #13 | PR-A: receipts with lot/expiry/serials, warranty end, vehicle owner/plate history, branch-scoped vehicles, Casablanca calendar days | ✅ | ✅ `a075212` | ✅ `a075212` + migration 011 | — | — |
| #15 | PR-B: platform Control Center vs shop workspace, 360° card, `Ma formule`, shop branding, backup status from recorded runs (migration 012) | ✅ | ✅ `e672fec` | ✅ `e672fec` + migration 012 | — | — |
| #16 | PR-C: owner-approved, time-limited, revocable support access; every support request journaled (migration 013) | ✅ | ✅ `c6c22b2` | ✅ with #17 | — | — |
| #17 | fix: long text / action groups widened phone screens; phone-width checks compared with the real screen width | ✅ | ✅ `f9ec9db` | ✅ `f9ec9db` | — | — |
| D1 | product options + order inbox (counter/phone/WhatsApp/table) accepted into the existing sales engine (migration 014) | in review | — | — | — | — |

## Known gaps and risks (open)

| Level | Item | Fix / next step |
|---|---|---|
| P1 | No production environment; staging is the only deployment | Create an isolated Railway project (own Postgres, volumes, secrets, domain). Needs the owner's Railway decision. |
| P1 | No off-site backup and no restore drill from it | Cloudflare R2 bucket + keys from the owner, scheduled encrypted `scripts/backup-job.sh`, restore into a disposable DB, record RPO/RTO. |
| P1 | Password recovery e-mail is not sent (no e-mail provider) | Choose a provider (owner), send reset links; until then the shop owner resets staff passwords. |
| P2 | `main` was red once (c6c22b2, E19 at 375 px) and Railway correctly did not deploy it; fixed by #17. Staging functional checks after deploy cover `/ready` and the login page only | A dedicated synthetic staging account (owner creates it; password never in chat) would allow an API smoke test after each deploy. |
| P2 | Cross-branch vehicle visit: an all-branch user must open the first job at the new branch | Intended (no plate lookup across branches for branch-limited staff). Revisit if the owner wants a supervised lookup. |
| P2 | Repository was public | Owner switches to private; rotate any secret that ever appeared (scan found none, only test passwords). |

## Production gate (all required before real data)

- [ ] Isolated production project + database (no demo data, no link to staging).
- [ ] Off-site encrypted backups (R2) on a schedule, and a restore from the off-site copy into a separate database, verified.
- [ ] Monitoring/alerts on errors and on failed backups; release log with SHA.
- [ ] Password recovery by e-mail; data-protection review (CNDP declaration, retention, access).
- [ ] Domain + HTTPS verified; access to Railway/R2 limited to named people.
- [ ] Merchant acceptance test on production with synthetic data, then the owner's written authorization for real data.
