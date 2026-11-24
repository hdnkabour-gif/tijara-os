# TIJARA OS — knowledge sync & handoff (2026-11-24)

**Record:** `TIJ-H-20261124-D2` • Type: documentation-only checkpoint • Scope: public-safe project metadata.  
**Project:** `hdnkabour-gif/tijara-os` • **Baseline:** `main@24817e537daf8f61e85546c4216ee9f0d12973b5`.  
**Documentation branch:** `docs/project-control-v1` — this document is **not in main** until the documentation branch is reviewed/merged. No app code, DB, CI, configuration or deployments changed by this knowledge-sync task.

## Current VERIFIED source-control and staging evidence

- `TIJ-REL-D2-20261124`: [PR #24](https://github.com/hdnkabour-gif/tijara-os/pull/24) **merged**, head `8445b93a07f6c49ee9d4e3f742fb5d29829b3fa4`, merge/main `24817e537daf8f61e85546c4216ee9f0d12973b5`.
- `TIJ-T03`: main [CI run 45446817872](https://github.com/hdnkabour-gif/tijara-os/actions/runs/45446817872) SUCCESS on PostgreSQL 16 and 18. Prior PR [CI run 45446247240](https://github.com/hdnkabour-gif/tijara-os/actions/runs/45446247240) SUCCESS. Implementation report says **159/159 locally**; this number is report-derived, not a fresh local execution.
- `TIJ-T04`: Railway staging app deployment `89c6487f-0a64-4c1c-96b6-bf59aba96a3f` and migrator `7fe669f2-129e-4bff-b97f-2968fe8d0bdf`, both SUCCESS at main SHA; `/ready`: version `24817e5`, pending migrations `0`, unprotected tables `0`, RLS bypass possible `false`. Migration `015` applied in staging. This is readiness evidence, **not** a business-process acceptance test.
- `TIJ-F06` (D2, IMPLEMENTED/STAGING): merchant-published QR public menu and table links; AR/FR public mobile pages; dish details/ingredients/allergens/weight/serves/preparation, up to 8 photos + short video; fixed-portion priced options via existing Sales engine; server-priced online order requests to D1 inbox, private tracking without exposed customer name/phone; slot limits and order retry protection. Persistent media directory and form secret are configured on staging; never record secret values.
- `TIJ-T01` (D1 historical): [PR #18](https://github.com/hdnkabour-gif/tijara-os/pull/18) merged `427e567`, prior tests retained; superseded as *current deploy* by D2, **not repeated**.
- Existing architecture invariant `TIJ-D01/TIJ-D02`: one multi-tenant/RLS Sales and inventory ledger; platform admin handles SaaS metadata, not merchant financial/customer data by default; merchant role, plan, enabled module and branch permissions must all apply at API boundaries.

## Outstanding work — do not assume delivered

- `TIJ-R01` **P0 review gate**: [Issue #20](https://github.com/hdnkabour-gif/tijara-os/issues/20) platform/support privacy. [Draft PR #23](https://github.com/hdnkabour-gif/tijara-os/pull/23) at `d1238aa94291c74ad9b61e26eb97915210326cc4`, CI [run 45425853126](https://github.com/hdnkabour-gif/tijara-os/actions/runs/45425853126) SUCCESS on its PR head, **not merged**, base recorded against older main. Independent current-base security review and affected regression tests remain needed. Do not reproduce the fix blindly in D3.
- `TIJ-R02` **P0 scope gate**: [Issue #19](https://github.com/hdnkabour-gif/tijara-os/issues/19) activity/plan/owner enabled modules vs direct API/role/branch checks. Separate unmerged branch `astra/19-shop-modules@81b90951345953058d2f56aebdba6c2ffb1d173c`. Review and integrate against current main; do not duplicate existing D2 code.
- `TIJ-R03` **P1**: off-site DB + **media** backups and actual isolated restore are unproven; local backup scripts/CI do not satisfy live recovery evidence. Current staging media volume alone does not protect against volume loss.
- `TIJ-R04` **P1/P2**: no independently verified authenticated staging owner journey for publishing/uploading/ordering/acceptance since D2 (implementation report explicitly says not tested live with a shop account). No production environment or real-data authorization.
- `TIJ-R05` **P1**: owner must decide isolated production hosting, secure off-site storage, e-mail provider, official domain and repository visibility. Repo observed public; do not include real merchant/customer data in this branch.
- `TIJ-F07` D3 bookings/capacity, `TIJ-F08` D4 deliveries/settlements, `TIJ-F09` D5 consented notifications remain **PLANNED**, not current main. [Issue #11](https://github.com/hdnkabour-gif/tijara-os/issues/11) is their canonical scope; [Issue #22](https://github.com/hdnkabour-gif/tijara-os/issues/22) extends D2 with verified hostnames/custom domains, not yet completed.
- D2 photo/video cards are implemented; **do not recreate the photo upload, QR menu or order inbox**. Future merchant branding must use authorized real media, not depict generated photos as real inventory.

## Evidence reuse / execution boundary

This checkpoint only read Space project records, GitHub and Railway metadata plus staging `/ready`. **No tests rerun**; no code/DB/env/config changes; no PR merge/release approval. Re-run only targeted changed-scope regression and required final-head CI when PR #23/#19 or D3 modifies relevant code/schema/permissions. Evidence hierarchy: GitHub commit → CI named runs → Railway deployment → live readiness → authenticated business UAT → separate real-data approval.

## Next owner / task claim

**`TIJ-H-20261124-D2`** • Coordinator: knowledge reconciliation complete.  
**Recommended next executor:** Claude Code (on scoped branch), with independent reviewer Astra/Codex. First rebase/review **#23 privacy** and **#19 module/activity isolation** against `main@24817e5` without overlapping active edits; decide exact priorities and test impact. D3 can be scoped after those constraints are preserved (Issue #11), but **must not silently close P0 items**. For every PR record current base/head, files, review threads, affected tests and run IDs, merge/auto-deploy effect, actual staging SHA and rollback. Handoff new facts into the *private* Project Control Center; do not claim production readiness without R2 isolated restore including media and owner acceptance.

### Stable links
- [README — coordination protocol](./README.md)
- [Release status on main](../../docs/RELEASE_STATUS.md) (may lag, verify `main` before editing)
- [Issue #14 — broader release decisions](https://github.com/hdnkabour-gif/tijara-os/issues/14)
- [Issue #11 — omnichannel D3–D5](https://github.com/hdnkabour-gif/tijara-os/issues/11)
