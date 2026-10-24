# Presentation outline

## 1. The coordination problem

Campus organisers receive overlapping and incomplete accounts. A long report stream does not tell a coordinator how many distinct situations need attention.

## 2. Aegis and its contribution

One board combines contextual grouping, source evidence, explicit priorities, conflicting accounts, and reversible human review. The contribution is the implemented integration and its evaluation.

## 3. Architecture and method

TanStack Start and shadcn frontend; FastAPI and SQLite backend. Persist the report, analyse it, propose an incident group, explain the priority, and let the coordinator decide. Present the actual lexical fallback measurements and the optional local MiniLM adapter separately.

## 4. Live demonstration

Use `docs/DEMO.md`. Show one duplicate family, one incomplete report, opposing exit accounts, and one audited human correction.

## 5. Evaluation

144 synthetic reports across the demo/development/test files. On the fixed 60-report regression set, contextual lexical grouping measured precision 1.000, recall 0.621 and F1 0.766, with 25 missed pairs and no false merge pairs. All reports still carry review flags in this degraded mode. Show the baseline and the actual limitations.

## 6. Human oversight and limitations

No dispatch, no hidden reports, no automatic conflict resolution, and no diagnostic claims. All records are synthetic. Explain the small dataset, narrow claim rules, missing real MiniLM execution, and the conservative matching tradeoff. The live Chromium workflow has passed.

## 7. Implemented and next

Implemented: incident board, form, evidence, policy, corrections, audit, replay, measured evaluation and automated checks. Next: a larger independent dataset, cached semantic model evaluation, real-device accessibility checks, access control and operational validation. SDG 11 is the primary intended alignment; health outcomes were not measured.
