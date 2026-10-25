"""Explicit local maintenance commands; normal application startup never downloads models."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
from contextlib import closing
from pathlib import Path
from typing import Any

from .engine import AnalysisEngine
from .evaluation import run_evaluation
from .fixtures import get_scenario
from .model_config import MODEL_COMMIT, MODEL_FILES, MODEL_NAME, MODEL_REVISION


def inspect_database(path: Path) -> dict[str, int]:
    """Inspect an existing Aegis database without creating or migrating it."""
    source = path.expanduser().resolve()
    with closing(sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True)) as connection:
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Database integrity check failed.")
        tables = {
            row[0]
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        if not {"events", "reports", "audit_events"}.issubset(tables):
            raise ValueError("This is not an Aegis database.")
        return {
            table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            for table in ("events", "reports", "audit_events")
        }


def backup_database(source: Path, destination: Path) -> dict[str, Any]:
    """Use SQLite's online backup API; refuse to overwrite any destination."""
    source = source.expanduser().resolve()
    destination = destination.expanduser().resolve()
    inspect_database(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("xb"):
        pass
    try:
        with (
            closing(sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True)) as original,
            closing(sqlite3.connect(destination)) as copy,
        ):
            original.backup(copy)
        counts = inspect_database(destination)
    except BaseException:
        destination.unlink()
        raise
    return {"path": str(destination), "counts": counts}


def preflight(
    database: Path, engine: Any | None = None, *, require_semantic: bool = False
) -> dict[str, Any]:
    """Read local readiness without creating exercise state."""
    database = database.expanduser().resolve()
    engine = engine if engine is not None else AnalysisEngine()
    scenarios = {name: len(get_scenario(name)) for name in ("demo", "busy", "edge")}
    counts = inspect_database(database) if database.exists() else None
    bun = shutil.which("bun")
    semantic_verified = False
    if require_semantic:
        probe = engine.analyze_report("Synthetic readiness check at the exhibition hall.")
        semantic_verified = probe["model_revision"] == MODEL_REVISION
    return {
        "ready": bun is not None and (not require_semantic or semantic_verified),
        "python": sys.version.split()[0],
        "bun": bun,
        "database": str(database),
        "database_counts": counts,
        "database_state": "verified" if counts is not None else "will be created on startup",
        "scenarios": scenarios,
        "matching": engine.health(),
        "semantic_required": require_semantic,
        "semantic_inference_verified": semantic_verified,
        "pinned_model": MODEL_REVISION,
        "note": "Lexical mode is supported; semantic inference requires the pinned local model.",
    }


def prepare_model() -> dict[str, Any]:
    """Download pinned inference artifacts explicitly, then test offline loading."""
    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        raise RuntimeError(
            "Install requirements-semantic.lock before preparing the model."
        ) from exc
    path = snapshot_download(repo_id=MODEL_NAME, revision=MODEL_COMMIT, allow_patterns=MODEL_FILES)
    engine = AnalysisEngine()
    result = engine.analyze_report("Synthetic observation at the exhibition hall.")
    if result["model_revision"] != MODEL_REVISION:
        raise RuntimeError("The pinned model was cached but offline semantic inference failed.")
    return {
        "path": str(path),
        "model_revision": MODEL_REVISION,
        "offline_inference_verified": True,
        "dimensions": len(result["embedding"]),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("backup", "restore"):
        subparser = commands.add_parser(command, help="Copy a verified database to a NEW path.")
        subparser.add_argument("source", type=Path)
        subparser.add_argument("destination", type=Path)
    check = commands.add_parser(
        "preflight", help="Check fixtures, database and actual matching mode."
    )
    check.add_argument(
        "--db", type=Path, default=Path(os.getenv("AEGIS_DB_PATH", "runtime/aegis.sqlite3"))
    )
    check.add_argument(
        "--require-semantic",
        action="store_true",
        help="Require real offline inference with the pinned model before starting a demo.",
    )
    commands.add_parser("prepare-model", help="Download the explicitly pinned optional model.")
    evaluate = commands.add_parser("evaluate", help="Run the real local evaluation.")
    evaluate.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command in {"backup", "restore"}:
            result = backup_database(args.source, args.destination)
        elif args.command == "preflight":
            result = preflight(args.db, require_semantic=args.require_semantic)
        elif args.command == "prepare-model":
            result = prepare_model()
        else:
            result = run_evaluation()
            if args.output is not None:
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result, indent=2))
        return 1 if args.command == "preflight" and not result["ready"] else 0
    except (OSError, sqlite3.Error, RuntimeError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
