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
1. **Owner:** final approval to merge the updated PR #23 (head `19bc95e`). After merge: CI on `main`, Railway deploy, `/ready` = merge SHA with 0 pending migrations, check `no_owner` alerts.
2. Then `TIJ-R02` Issue #19: review/integrate `astra/19-shop-modules@81b9095` against the new main (no duplicate module system).
3. Then `TIJ-F07` D3.
