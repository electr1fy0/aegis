# Verification record

Baseline verified on 24 October 2026; the forty workflow improvements were reviewed and reverified on 25 October 2026 using Python 3.14.7, Bun 1.4.2, and the locked project dependencies on macOS ARM64.

## Completed checks

The verification commands and Chromium scenarios cover the review fixes and the workflow improvements. Dependency audits completed without known vulnerabilities on 24 October; the regular dependency locks are unchanged. See `REVIEW.md` for the original findings and `IMPROVEMENTS.md` for the forty implemented changes.

| Check | Result |
| --- | --- |
| Backend/API/engine/evaluation tests | 223 passed |
| Backend statement coverage | 2,843 / 2,843; 100% |
| Backend branch coverage | 950 / 950; 100% |
| Frontend interaction/unit tests | 337 passed |
| Frontend statement coverage | 2,057 / 2,057; 100% |
| Frontend branch coverage | 1,545 / 1,545; 100% |
| Frontend function coverage | 538 / 538; 100% |
| Frontend line coverage | 1,746 / 1,746; 100% |
| Strict TypeScript, including test/config files | Passed |
| Vite client and SSR production builds | Passed |
| Built server handler requests | `/dashboard`, `/report`, `/evaluation`, `/about`: HTTP 200 |
| Playwright Chromium smoke | 2 passed: 24-step replay, intake, review, audit, evaluation, drafts, receipts, notes, titles, reset, undo, history, safe export and responsive views; no browser console errors |
| Ruff lint and formatting | Passed; enforced by `make verify` |
| Locked Python dependencies (`pip-audit`) | No known vulnerabilities |
| Locked frontend dependencies (`bun audit`) | No known vulnerabilities |

Backend coverage includes every application module and the fixture generator. Frontend coverage includes all source modules, raw component primitives, route glue, and generated route registration. Test files are excluded; no application coverage suppression pragmas were added. The concise coverage figures are saved in `evaluation/results/verification.json`.

The backend suite includes real SQLite/FastAPI integration tests and five cross-language tests that execute the frontend's actual grouping request builder with Bun before posting its output to the API. The latter validate confirm, reject, move, merge and split, including expected incident versions and audit outcomes.

## Reviewed regressions

The review and tests caught and fixed:

- Original report text being normalised at the API boundary.
- Resource cleanup after application lifespan and startup failure.
- Evidence history interfering with correction operations.
- Conflicts and rejection constraints becoming stale after split or merge.
- Late analysis overriding a coordinator's decision.
- Concurrent writes producing inconsistent snapshots or incident summaries.
- New reports attaching to resolved incidents and disappearing from the active queue.
- Commit failures or interrupts leaving a transaction without rollback.
- Old polling results overwriting a successful coordinator mutation.
- Forms silently using versions the coordinator had not reviewed.
- Conflict reopening reusing an old version and the previous reason.
- Request timeouts failing to cover response-body reads.
- An incomplete confirmation payload missing its target incident.
- Late responses from another exercise switching the currently selected event.
- Retried submissions changing their captured observation time or submission identity.
- Saved receipt data referring to a different exercise or malformed display IDs.
- Source links attributing reasons to the wrong report pair.
- Report analysis events being mislabeled as coordinator decisions.
- Long queue rows overlapping after the desktop workspace was bounded.
- Spreadsheet exports interpreting formula-leading coordinator text as formulas.

## Measured replay and evaluation

The real API replay retained 24 reports in 8 incident groups, exposed 3 opposing report-pair conflicts, and recorded 50 audit entries. All six explicit evaluation checks passed.

The ordinary environment uses the clearly labelled lexical fallback. On the fixed 60-report synthetic regression set it measured precision 1.000, recall 0.621212, F1 0.766355, zero false merge pairs, 25 missed pairs, and 100% review rate. See `evaluation/results/latest.json` for the complete measured result and limitations.

The separate locked semantic environment executed real 384-dimensional offline MiniLM inference at model commit `1110a243fdf4706b3f48f1d95db1a4f5529b4d41`. Its unchanged conservative grouping policy measured precision 1.000, recall 0.030303, F1 0.058824, zero false merge pairs and 64 missed pairs on the same fixture. Semantic mode therefore remains optional. `evaluation/results/semantic.json` records the real run; no thresholds were tuned against test labels.

Read-only preflight and both-service startup/shutdown were exercised. SQLite online backup and restore to a new path preserved the test database's two events, 24 reports and 51 audit records. Desktop, laptop, mobile and print views were inspected; the mobile workspace had no horizontal overflow.

## Environmental limits

- The earlier implementation environment denied local sockets and browser IPC. Those restrictions did not apply to this review: the real Chromium test has now passed against both running services.
- The exact remote shadcn initialization command failed at package-registry DNS resolution. The official preset was decoded from its cached registry; official Nova source and self-hosted Figtree were used to implement the requested configuration.
- The original verification run preceded Git initialization; the project is now versioned on the `main` branch.
- Two third-party deprecation warnings remain in the backend test harness: Starlette's HTTPX TestClient compatibility path and an AnyIO alias. They were not suppressed. No failing application check or unclosed SQLite resource warning remained in the final run.

Full source coverage records execution of the included code paths; it does not prove that arbitrary inputs are bug-free or that a synthetic prototype is operationally validated.

## Flat UI review

The interface uses solid neutral surfaces, a single blue action color, grouped summary counts, a list-based queue, and simpler inspector sections. Report intake, About and Evaluation use the same restrained hierarchy. Existing shadcn primitives remain unchanged. Application styles contain no custom gradients, shadows, glows or backdrop blur.

All 337 frontend tests pass with 100% statement, branch, function and line coverage; both Chromium workflows, TypeScript and production builds pass. Browser checks at 390, 1280 and 1440 pixels found no horizontal overflow, custom visual effects or map-label collisions. Mobile navigation keeps visible labels, and export menus remain above the laptop inspector. The unit-test timeout is ten seconds to accommodate longer multi-step interactions; assertions and coverage thresholds are unchanged.
