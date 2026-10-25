# Local development and maintenance

`make dev` starts the API and frontend together using the existing `.venv` and Bun. Ctrl-C or either service exiting stops both children. `make preflight` checks fixture loading, the database if it exists, Bun availability, and the actual local matcher. It does not create an exercise or download a model.

## Consistent backups and restore

```sh
.venv/bin/python -m backend.aegis.maintenance backup runtime/aegis.sqlite3 backups/exercise.sqlite3
.venv/bin/python -m backend.aegis.maintenance restore backups/exercise.sqlite3 runtime/restored.sqlite3
AEGIS_DB_PATH=runtime/restored.sqlite3 make backend
```

Both commands verify the source and copied database and refuse to overwrite any existing destination. Backup uses SQLite's online backup API so committed state is copied consistently, including WAL state. Restore creates a new database; stop the old service and explicitly select the restored path. Keep backups somewhere appropriate for the exercise data and do not commit them.

## Pinned optional semantic environment

```sh
make semantic-setup
make evaluate-semantic
make dev-semantic
```

Preparation installs the separately locked optional environment `.venv-semantic` and explicitly downloads only inference artifacts from `sentence-transformers/all-MiniLM-L6-v2` at commit `1110a243fdf4706b3f48f1d95db1a4f5529b4d41`. It then performs real inference through the application's offline loader and checks that the actual revision is semantic. Regular startup remains local-only and never downloads weights. Remote model code is disabled. `make evaluate-semantic` explicitly sets offline flags.

`make dev-semantic` first requires successful real inference with the pinned local model, then starts both the API and frontend with the semantic environment and offline flags. If inference falls back to lexical mode, the readiness check exits unsuccessfully before either server starts. Use `make backend-semantic` for the API alone, or `make dev` for ordinary development with an explicitly reported fallback when semantic dependencies are absent. The readiness check does not create exercise state.

The optional dependency lock is constrained by `requirements-dev.lock` to keep core API dependencies consistent. Regenerate it with:

```sh
uv pip compile pyproject.toml --extra semantic --constraint requirements-dev.lock -o requirements-semantic.lock
```

`make evaluate` measures the regular environment. The current lexical and semantic settings have different conservative gates; installing an encoder alone does not establish improved grouping quality. Keep the synthetic benchmark limitations alongside any comparison.

To save a fresh measured result:

```sh
.venv/bin/python -m backend.aegis.maintenance evaluate --output evaluation/results/local.json
```

The command reports real errors and matching mode. The evaluation output distinguishes runtime failures from grouping mistakes and labels ground-truth-derived correction counts as idealized operations, rather than observed operator time.
