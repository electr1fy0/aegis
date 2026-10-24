# Project review — 24 October 2026

Reviewed the local API, SQLite transactions, matching and priority engine, fixture/evaluation pipeline, frontend request and review flows, dependency locks, CI, and real browser workflow. The review found defects despite the pre-existing 100% coverage gates. Corrections are applied in the workspace and covered by regression tests.

| Finding | Correction |
| --- | --- |
| Pending analysis could discard a coordinator's priority or status change when automatically attaching the report elsewhere. | Finalization preserves incidents changed by the coordinator while analysis was pending. |
| Failure of a pending receipt moved into an existing incident could downgrade that incident using only the failed report's fallback assessment. | Failure handling retains stronger existing risk evidence. |
| Splits and merges could hide matching evidence under old or deleted incident identities. | Evidence is retrieved through the originating report's current membership while retaining its original comparison. |
| A merge's audit entry omitted member confirmations and its resulting report memberships when the request contained only incident IDs. | Before/after audit data covers every affected report. |
| Merged memberships retained provisional warnings; rejected internal pairings could survive an explicit approval. | Merge confirmation clears provisional grouping warnings and internal rejection constraints after constraint migration. |
| A split could lose existing rejection constraints or let pending analysis recreate the separation. | External constraints carry to the new group and reciprocal constraints preserve the coordinator's separation. |
| Shared context alone could automatically join unrelated lexical reports with zero text similarity. | Version 2 requires at least 0.05 lexical anchor similarity, in addition to the existing context, score, and margin gates. |
| One fallback comparison could relax the semantic anchor's gates for an entire mixed-model group. | The anchor comparison determines which matching gates apply. |
| Curly-apostrophe negation could turn “isn’t unconscious” into a P0 assertion; “isn’t breathing” was missed. | Contraction patterns accept both apostrophe forms and preserve the original evidence spans. |
| Equipment names such as “fire extinguisher” and “smoke machine” could trigger immediate danger by themselves. | Named equipment is excluded from that keyword trigger; separate affirmative danger still triggers P0. |
| Finite embeddings at extreme scales could overflow or underflow normalization. | Vectors are scaled before calculating their magnitude. |
| Tilde database paths created one directory but opened a different literal path. | The same expanded absolute path is used throughout. |
| Replay creation committed its new event before saving the session. Failure could replace the current event with an incomplete replay. | Event, session, and their audit records now commit or roll back together. Initial event creation is also serialized. |
| Concurrent first evaluation requests could repeat the entire evaluation. | Cache initialization is serialized with a lock. |
| A model that loaded successfully but failed on every inference could have its lexical vectors labelled as semantic evaluation. | Observed lexical model revisions override the initial health label, and no semantic baseline is presented for fallback vectors. |
| Local binding alone did not block cross-site mutations or DNS rebinding requests. | Raw Host validation, browser origin checks, JSON-only POSTs, and non-caching API responses are enforced. Explicit host configuration is documented. |
| Invalid Unicode and UTC date overflow could reach storage and return server errors. Optimistic versions accepted booleans or coerced numeric strings. | Validation rejects those inputs before any write and bounds grouping IDs and version maps. |
| The move form displayed a destination while its controlled value was empty. | An explicit destination placeholder now matches the form state. |
| The browser smoke test stopped on an ambiguous Operations link. | The locator requires an exact accessible name; the smoke also asserts no uncaught browser errors. |
| Configured Python lint rules were not enforced and reported 242 violations. | Imports, unused values, formatting, iteration, and long expressions were corrected. A pinned Ruff version is installed with development dependencies and enforced by `make verify`. |

Dependency audits identified affected versions of Vitest's mocker, Undici, and Certifi. Updated Vitest and its coverage provider to 4.1.12, Undici to 7.30.1, and Certifi to 2026.10.23. Both dependency audits now report no known vulnerabilities; CI runs them on future changes. Sources: [Vitest advisory](https://github.com/advisories/GHSA-qxg6-89mg-rqv8), [Undici advisory](https://github.com/advisories/GHSA-xjj6-f33q-929c), [Certifi advisory](https://github.com/certifi/python-certifi/security/advisories/GHSA-6q48-6c7w-9gw2).

The text-evidence requirement makes lexical grouping more conservative. On the same 60-report synthetic regression fixture, precision remains 1.000, while recall changes from 0.909091 to 0.621212 and F1 from 0.952381 to 0.766355. Missed report pairs increase from 6 to 25; false merge pairs remain zero. The previous results benefited from allowing matches supported only by shared context. Reports remain visible for manual grouping, and this small regression set does not establish generalization. The updated executable measurements are in `evaluation/results/latest.json`.

The project remains a local synthetic prototype. User authentication and operational deployment are outside its documented scope. The actual MiniLM model weights were unavailable, so real semantic inference is not claimed. The deterministic policy still has a narrow English vocabulary. Two upstream Starlette/AnyIO deprecation warnings remain visible in the Python test harness; they are not suppressed. See `VERIFICATION.md` for the checks actually executed.
