# Aegis

An evidence-backed incident board for synthetic campus event exercises. Reports remain visible while a human coordinator reviews proposed groups, explicit priorities, conflicting accounts, and a persistent audit history.

This implements AI Innovate-A-Thon Topic 10. It does not contact emergency services or dispatch responders. The map and all bundled people/incidents are illustrative.

## Local development

Requirements: Python 3.14+, uv 0.12+, Bun 1.4+, and a modern browser.

```sh
python3 -m venv .venv
uv pip sync --python .venv/bin/python requirements-dev.lock
cd frontend
bun install --frozen-lockfile
```

Start the API from the repository root:

```sh
.venv/bin/python -m backend.aegis
```

In another terminal:

```sh
cd frontend
bun run dev
```

The API defaults to `http://127.0.0.1:8000`; the frontend development server proxies `/api` there. Use the URL printed by Vite. SQLite state persists at `runtime/aegis.sqlite3`. Override `AEGIS_DB_PATH`, `AEGIS_HOST`, and `AEGIS_PORT` explicitly in the shell if needed. The `.env.example` documents variables; the API does not silently load a local `.env` file.

After setup, `make dev` starts both services and `make preflight` checks local readiness without creating an exercise. See [maintenance commands](docs/MAINTENANCE.md) for verified backups, restore to a new path, and the separately locked semantic environment. SQLite upgrades are additive and versioned; existing exercises remain available through the header selector.

The default bind is local because this is a synthetic, single-coordinator prototype without production authentication. Requests validate the Host header, reject changes from untrusted browser origins, and require JSON for POST bodies. `AEGIS_ALLOWED_HOSTS` defaults to `localhost,127.0.0.1,::1`; set an explicit comma-separated list only for an intentionally configured host. Host checks are not authentication. Keep the app local until access control and an operational deployment policy are implemented.

## Frontend requirements

The requested initialization command is:

```sh
bunx --bun shadcn@latest init --preset b3PkSQ --template start
```

During the original implementation, outbound shell networking was blocked, so the CLI could not complete its download. The official cached registry decoded `b3PkSQ` as Nova style, neutral base, orange theme, neutral charts, Tabler icons, Figtree, inherited headings, default radius, subtle menu accent, and default-translucent menu colour. The frontend retains the upstream shadcn primitives, Nova styles, and self-hosted Figtree assets. The subsequent UI review uses solid neutral surfaces and blue actions, with no custom gradients, shadows, glows, or backdrop blur. See `frontend/components.json` and its bootstrap notes. No successful remote bootstrap is claimed.

## Matching modes

The engine attempts to load `sentence-transformers/all-MiniLM-L6-v2` from a local model cache. When its optional package or weights are unavailable, it uses an explicitly labelled, deterministic lexical-hash matcher. The dashboard exposes the active method and the evaluation labels its measurements accordingly.

To prepare the pinned semantic adapter on a connected development machine:

```sh
make semantic-setup
make evaluate-semantic
make backend-semantic
```

Preparation uses `.venv-semantic`, preserving the ordinary development environment. Check `/api/health` after starting that environment. The application loader itself uses local-only loading and an exact model commit. Real 384-dimensional offline MiniLM inference and the benchmark have been executed; the [semantic result](evaluation/results/semantic.json) performs worse than the lexical method under the current conservative gates, so semantic mode remains optional. See the [implementation and measurement record](docs/IMPROVEMENTS.md).

Similarity and composite scores are ranking signals, not calibrated probabilities. Priority comes from the documented exercise policy. Unknown information remains visible, and more reports do not establish that an account is true.

## Demonstration

1. Open the dashboard and start a fresh exercise replay.
2. Advance incoming reports and inspect the proposed incident groups.
3. Select an incident to inspect original text, matching evidence, and priority reasons.
4. Introduce an incomplete or conflicting report and review its flags.
5. Confirm or correct a group, record a reason, and inspect the audit entry.
6. Open evaluation to show measured outcomes and limitations.

The report form also accepts fresh synthetic wording. Replay executes the ordinary ingestion path; it does not supply expected incident labels to the matcher. Starting another exercise preserves the earlier event's history.

Open the compact Replay menu for scenario controls. Intake restores event-scoped drafts and stable submission retries; explicit time choices preserve unknown timing. The queue supports search, filters, keyboard navigation and related-report comparison. Notes, title edits, priority reset and eligible undo are audited. The Export menu provides a printable exercise brief and JSON/CSV with source references. [All forty workflow improvements](docs/IMPROVEMENTS.md) are mapped to their implemented behavior.

## Verification

Backend tests and the enforced 100% statement/branch coverage gate:

```sh
.venv/bin/python -m pytest --cov --cov-report=term-missing --cov-report=json:coverage.json
```

Frontend checks:

```sh
cd frontend
bun run build
bun run coverage
```

The backend coverage scope includes all application modules and the fixture generator. Frontend coverage includes every source module, including shadcn primitives and generated route registration; only test files are excluded. Test assertions cover malformed inputs, idempotency, stale edits, event boundaries, model failure, correction flows, conflict preservation, and source text retention.

Run lint, formatting checks, both coverage gates, and the production build together with `make verify`. CI also audits both dependency lockfiles for known vulnerabilities.

On a machine that permits local servers and Chromium, run the real browser smoke test:

```sh
cd frontend
bunx playwright install chromium
bun run e2e
```

The Playwright configuration starts both services with an isolated temporary database. Stop other services using ports 8000 or 3000 first. The CI workflow installs browsers and executes this smoke after the coverage/build gates.

The live browser smoke test has passed against both running services. See `docs/VERIFICATION.md` for the current verification record and `docs/REVIEW.md` for the review findings and matching tradeoff. Passing coverage measures execution of source branches; it does not prove absence of bugs or real-world suitability.

## Data and evaluation

The input JSON files and their ground-truth labels are separated. Runtime replay reads only `data/scenarios`; evaluation reads the labelled benchmark files in `data/evaluation`.

- Demo: 24 reports across 8 incident families.
- Development: 60 reports across 20 incident families.
- Test/regression benchmark: 60 reports across 20 distinct incident families.

These are small synthetic fixtures. Some categories and scenario structures recur between splits. Test failures discovered during review also become regression cases; the resulting figures should not be represented as an untouched real-world generalisation study. Report grouping precision/recall together with review rate and failure examples.

`GET /api/evaluation/latest` runs the local evaluator and caches its measured result for that application instance. Restart after changing the model or fixtures. The evaluator reports unavailable semantic inference as a limitation; it does not invent a semantic score table.

## Project references

- [Build plan](AEGIS_BUILD_PLAN.md)
- [API and module contract](docs/API_CONTRACT.md)
- [Sentence Transformers documentation](https://sbert.net/docs/sentence_transformer/usage/semantic_textual_similarity.html)
- [Official MiniLM model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)
- [shadcn CLI](https://ui.shadcn.com/docs/cli)

The contribution is the implemented coordination workflow and its evaluation: inspectable grouping, preservation of conflicting accounts, and reversible human decisions. Established embedding models and incident maps are acknowledged as prior techniques.
