# Verification record

Verified on 24 October 2026 using Python 3.14.7, Bun 1.4.2, and the locked project dependencies on macOS ARM64.

## Completed checks

`make verify` and `bun run e2e` completed successfully after the review fixes. Dependency audits also completed without known vulnerabilities. See `REVIEW.md` for the findings and matching tradeoff.

| Check | Result |
| --- | --- |
| Backend/API/engine/evaluation tests | 196 passed |
| Backend statement coverage | 2,414 / 2,414; 100% |
| Backend branch coverage | 844 / 844; 100% |
| Frontend interaction/unit tests | 140 passed |
| Frontend statement coverage | 834 / 834; 100% |
| Frontend branch coverage | 565 / 565; 100% |
| Frontend function coverage | 245 / 245; 100% |
| Frontend line coverage | 745 / 745; 100% |
| Strict TypeScript, including test/config files | Passed |
| Vite client and SSR production builds | Passed |
| Built server handler requests | `/dashboard`, `/report`, `/evaluation`, `/about`: HTTP 200 |
| Playwright Chromium smoke | Passed through all 24 replay steps, intake, review, audit and evaluation; no uncaught browser errors |
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

## Measured replay and evaluation

The real API replay retained 24 reports in 8 incident groups, exposed 3 opposing report-pair conflicts, and recorded 50 audit entries. All six explicit evaluation checks passed.

The active engine in this environment is the clearly labelled lexical fallback. On the fixed 60-report synthetic regression set it measured precision 1.000, recall 0.621212, F1 0.766355, zero false merge pairs, 25 missed pairs, and 100% review rate. See `evaluation/results/latest.json` for the complete measured result and limitations. MiniLM weights were unavailable; encoder injection tests do not establish that real MiniLM inference ran here.

## Environmental limits

- The earlier implementation environment denied local sockets and browser IPC. Those restrictions did not apply to this review: the real Chromium test has now passed against both running services.
- The exact remote shadcn initialization command failed at package-registry DNS resolution. The official preset was decoded from its cached registry; official Nova source and self-hosted Figtree were used to implement the requested configuration.
- The original verification run preceded Git initialization; the project is now versioned on the `main` branch.
- Two third-party deprecation warnings remain in the backend test harness: Starlette's HTTPX TestClient compatibility path and an AnyIO alias. They were not suppressed. No failing application check or unclosed SQLite resource warning remained in the final run.

Full source coverage records execution of the included code paths; it does not prove that arbitrary inputs are bug-free or that a synthetic prototype is operationally validated.
