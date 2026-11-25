# TIJARA OS — handoff: PR #23 prepared on current main (2026-11-25)

**Record:** `TIJ-H-20261124-PR23-REBASE` • follows `TIJ-H-20261124-D2` (unchanged) • Scope: public-safe project metadata.
**Owner decision recorded:** option 2 — *prepare and re-verify PR #23 on current `main`; NOT a merge approval.* PR #23 stays **draft**.

## What was done (Claude Code, on `astra/20-merchant-privacy`)
- `7a2c481` merge of `main@24817e5` (D2) into the PR branch — no textual conflict; D2 kept intact.
- `cfe182c` migration renamed `015_support_privacy.sql` → **`016_support_privacy.sql`** (015 = D2 `015_public_menu.sql`, already applied on staging). Order on staging: …014 → 015 (applied) → 016 (pending).
- `19bc95e` **old platform-owned pilots** (`TIJ-R01` follow-up): shops whose only active owner is a platform account would become unreachable once platform accounts lose merchant access. Added `platform_tenants_without_owner()` (overview alert `no_owner`, 360° `needsOwner`) and `POST /platform/tenants/:id/first-owner` → `platform_assign_first_owner()`: creates ONE real owner, **only** for such shops (409 for any shop that already has a merchant owner, so the platform cannot use it to enter a shop), advisory lock, audited `tenant.owner_assigned`, nothing deleted, platform account still refused.

## Evidence (this round; earlier evidence reused, not repeated)
- **Head:** `19bc95e`. **CI:** [run 45522625465](https://github.com/hdnkabour-gif/tijara-os/actions/runs/45522625465) — PostgreSQL 16 ✅, PostgreSQL 18 ✅ (full suite incl. browser tests, on the integrated head).
- **Targeted local run:** 65 API tests (support, control, admin, api, orders, public/D2, first-owner, module boundaries) + 6 browser tests (E0b, E13, E19, E20, E21, E22) — all pass. Typecheck/build pass.
- **Mutation checks:** without the dispatcher allowlist for platform accounts → A7b/SA1/SA2/SA5 fail; without the "already has an owner" guard → FO1/FO2 fail.
- **Probe on D2 routes:** a platform admin, with or without an approved support grant, gets 400/403 on `/menu/*`, `/order-menu`, `/order-requests`, `/items/:id/menu|options`, `/tenant/plan|branding`; only `GET /support/diagnostics` is open (tenant id, plan, status).

## Security review result (current base)
- No business data (prices, invoices, profit, customers, stock) reachable by platform or support sessions; column grants on `users` are column-level since 002, so the 016 revokes are effective; `platform_audit` read only through the projecting definer function.
- **Remaining, not blocking this PR (separate decisions):** platform RBAC/MFA for platform operators; initial-password hand-over for new owners (no e-mail provider yet — owner must change it); infrastructure-level access (DB/backups/secrets) can still read data without app-layer encryption (`TIJ-R05`).

## Effect of migration 016 on staging (when merged)
- Platform accounts immediately stop using merchant memberships/sessions (no row deleted).
- Any staging shop created with "self owner" appears with the **`no_owner`** alert in the Control Center; assign its real owner from the 360° card. This list can only be read after deployment (no direct staging DB access from the agent).
- No data migration, no lock-heavy change; function replacements + grants only.

## Next
1. **Owner:** final approval to merge the updated PR #23 (head **`ef1fe72`**, see review round 2 below). After merge: CI on `main`, Railway deploy, `/ready` = merge SHA with 0 pending migrations, check `no_owner` alerts.
2. Then `TIJ-R02` Issue #19: review/integrate `astra/19-shop-modules@81b9095` against the new main (no duplicate module system).
3. Then `TIJ-F07` D3.

## Review round 2 — `TIJ-H-20261125-PR23-REVIEW` (follows `TIJ-H-20261124-PR23-REBASE`)
Independent review on `19bc95e` asked for changes (P1, P1, P2). Fixed in **`ef1fe72`**:
- **Eligibility narrowed** (overview, 360° card and write path share one predicate): active platform-admin owner **AND** no active merchant owner. A shop with no owner at all, or with a merely deactivated merchant owner, is **not** eligible.
- **No admin-chosen password:** the owner is created without a password; a single-use 60-minute claim link (hash only in DB) lets the owner choose it. Route disabled unless `OWNER_RECOVERY=claim-link` (staging opt-in; production off until a verified e-mail channel exists).
- **Atomic:** user + membership + claim + audit in one definer function under a per-shop lock; refusals create nothing. Audit records `ownerUserId`.
- **Evidence:** local 166/166; [CI run 45528247797](https://github.com/hdnkabour-gif/tijara-os/actions/runs/45528247797) pg16 ✅ pg18 ✅; FO1–FO3 + browser E23 (Arabic phone); mutation checks (drop platform-owner requirement → FO2 fails; drop write guard → FO1–FO3 fail). [PR comment](https://github.com/hdnkabour-gif/tijara-os/pull/23#issuecomment-7150007495).
- **Residual:** the operator sees the claim link while handing it over (single use, TTL, audited); old platform membership kept inert (no deletion).

## Release — `TIJ-H-20261125-PR23-RELEASE` (follows `TIJ-H-20261125-PR23-REVIEW`)
- PR #23 merged by the owner on 2026-11-25 14:42 UTC → `main@5df5c2e`. Independent review approved `ef1fe72` ([comment](https://github.com/hdnkabour-gif/tijara-os/pull/23#issuecomment-7162630157)); the Codex bot review did not run (usage limit), no finding.
- Main CI [run 45636940355](https://github.com/hdnkabour-gif/tijara-os/actions/runs/45636940355): pg16 ✅ pg18 ✅.
- Railway staging: migrator `5df5c2e` SUCCESS (016 applied), app `5df5c2e` deployed; `/ready` → `ready`, `version 5df5c2e`, `pendingMigrations 0`, `unprotectedTables 0`, `rlsBypassPossible false`.
- `OWNER_RECOVERY` **not set** on staging (recovery disabled) — enabling it needs an explicit owner decision for synthetic pilots only. Production: none; real data still blocked.
- Next: Issue #19 (integrate `astra/19-shop-modules@81b9095`), then D3.

## Issue #19 — `TIJ-H-20261125-I19` (follows `TIJ-H-20261125-PR23-RELEASE`; scope `TIJ-R02`)
- Draft [PR #25](https://github.com/hdnkabour-gif/tijara-os/pull/25), head `234c379`, branch `claude/19-shop-modules`. Astra's spec `astra/19-shop-modules@81b9095` cherry-picked (`5b1cdb0`), implemented on top — no second module system.
- Rule: plan feature/override ∩ shop-enabled module ∩ role ∩ branch; activity = default only. Migration **017** (`tenant_modules`, `orders` feature, defaults, safe backfill, trial ceiling).
- Also fixed: real shops start with an empty catalog (examples opt-in, refused on production unless `DEMO_CATALOG=on`); branch-scoped invoice list/detail, summary and sale cancellation.
- Evidence: local 179/179; [CI 45640248946](https://github.com/hdnkabour-gif/tijara-os/actions/runs/45640248946) pg16 ✅ pg18 ✅; mutation checks (module check, branch filter, role gain) each fail the suite.
- Deliberate test changes: PC2 (trial cannot get add-ons), salesToday as decimal string. Awaiting independent review + owner approval; then D3 (`TIJ-F07`).

## Independent review — `TIJ-H-20261125-I19-REVIEW` (follows `TIJ-H-20261125-I19`)

- **Status: REQUEST CHANGES on draft [PR #25](https://github.com/hdnkabour-gif/tijara-os/pull/25) exact head `234c3792585809d21bcc882d8b4f99569c5ae126`, base/main `5df5c2eaec427ac8b1b2b877c87ccf7173bab976`.** PG16/18 CI [45640248946](https://github.com/hdnkabour-gif/tijara-os/actions/runs/45640248946) SUCCESS; 179/179 local reported by Claude, not rerun. [Independent GitHub comment #7167140941](https://github.com/hdnkabour-gif/tijara-os/pull/25#issuecomment-7167140941). This is code-review feedback, **not a merge authorization**.
- **TIJ-R02a P1:** `src/public.ts` calls `shop()`, which checks only the effective `online` module; `POST /public/shops/:slug/orders` never checks effective `orders`. With online ON and orders OFF, the public form can still create D1 requests; the private staff inbox is hidden/403. Make checkout capability depend on both modules, and refuse new submissions at server/transaction boundaries (including pre-issued form tokens), while retaining existing records. Ensure `GET .../menu` no longer presents accepting-orders affordance while orders is OFF. Add targeted API regression for online=ON/orders=OFF and platform override.
- **TIJ-R02b P2:** `public/js/main.js` route `#/menu` is shown based solely on `catalog.view` rather than effective `online`, and related merchant menu endpoints in `src/menu.ts` remain callable with catalog/settings permissions. Agree on safe draft-editing policy vs operational module-off access; hide the online-menu navigation when disabled, and align API boundaries. Add AR/FR mobile 375px navigation and direct-API negative tests without disabling general product catalog editing.
- **No reimplementation requested:** Preserve all verified work on migration 017, branch invoice/cancellation guard, role grants, demo catalog and module toggles. Only fix these deltas, run targeted affected tests and required final head CI (PG16 + PG18). Do not merge or publish migration 017 before owner explicitly approves the updated head.
- **Staging evidence:** Railway app/migrator still `5df5c2e` SUCCESS, `/ready` matches, pending migrations 0. PR #25 changes not deployed; Production and real data remain not approved.
- **Next owner / handoff:** Claude Code fixes `TIJ-R02a/b` on PR #25, posts final SHA/CI/remaining risks, requests independent re-review. Continue D3 only once Issue #19 safely released. Preserve IDs and evidence.
- **Review round 1 (`TIJ-H-20261125-I19`, continued):** independent REQUEST CHANGES on `234c379` ([comment](https://github.com/hdnkabour-gif/tijara-os/pull/25#issuecomment-7167140941)) — P1 public ordering ignored a disabled `orders` module; P2 online menu routes/nav ignored `online`. Fixed in **`e0811f1`**: one effective check in the public shop lookup (menu offers no checkout, submissions 409 even with an earlier form token, pending orders kept + tracking, back in inbox on re-enable; platform override honoured); all `/menu/*` and merchant `/media/*` require `online`, `#/menu` follows modules, catalog stays core. Tests PM1/PM2 + E24 (AR 375 px, FR desktop); mutation checks; local 181/181; [CI 45648067077](https://github.com/hdnkabour-gif/tijara-os/actions/runs/45648067077) PG16 ✅ PG18 ✅. [Reply](https://github.com/hdnkabour-gif/tijara-os/pull/25#issuecomment-7167439257). Still draft; staging `5df5c2e`, migration 017 not applied.
