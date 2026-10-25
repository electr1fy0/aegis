# Presentation outline

## 1. The coordination problem

Campus organisers receive overlapping and incomplete accounts. A long report stream does not tell a coordinator how many distinct situations need attention.

## 2. Aegis and its contribution

One board combines contextual grouping, source evidence, explicit priorities, conflicting accounts, and reversible human review. The contribution is the implemented integration and its evaluation.

## 3. Architecture and method

TanStack Start and shadcn frontend; FastAPI and SQLite backend. Persist the report, analyse it, propose an incident group, explain the priority, and let the coordinator decide. The pinned local MiniLM and lexical routes are scored independently; real offline inference is verified before demo startup. Show source-cited evidence and the active mode.

## 4. Live demonstration

Use `docs/DEMO.md`. Show one duplicate family, one incomplete report, opposing exit accounts, and one audited human correction.

## 5. Evaluation

144 original synthetic reports across demo/development/test, plus a 48-pair development challenge. On the fixed 60-report regression set, hybrid MiniLM recall improved from 0.030 to 0.197, with precision 1.000; lexical recall remains higher at 0.652. On the harder context-matched development challenge, hybrid grouped 12/18 duplicate cases with 0/18 distinct-case false attachments, versus lexical's 17/18 duplicates and 15/18 false attachments. Both cover all duplicate cases as candidates. Show the conservative lexical control, four underdetermined hybrid attachments and noisy suggestions. These are development and synthetic regression measurements, not operational accuracy.

## 6. Human oversight and limitations

No dispatch, no hidden reports, no automatic conflict resolution, and no diagnostic claims. All records are synthetic. Explain the small dataset, narrow claim rules, observed grouping failures and conservative matching tradeoff. Real offline MiniLM, API ingestion and coordinator conflict review have passed; passing component checks does not prove correct automatic membership.

## 7. Implemented and next

Implemented: incident board, form, hybrid evidence, policy, corrections, audit, replay, fair evaluation and automated checks. A tested small reranker was rejected because it did not improve the useful tradeoff. Next: a larger independent dataset, real-device accessibility checks, access control and operational validation. SDG 11 is the primary intended alignment; health outcomes were not measured.
