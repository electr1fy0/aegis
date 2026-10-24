"""Maintenance never overwrites state and semantic readiness requires actual inference."""

import builtins
import json
import runpy
import sqlite3
import sys
from contextlib import closing
from types import SimpleNamespace

import pytest
from aegis import maintenance
from aegis.engine import AnalysisEngine
from aegis.model_config import MODEL_COMMIT, MODEL_FILES, MODEL_NAME, MODEL_REVISION


def create_database(path):
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.executescript(
            "CREATE TABLE events(id); CREATE TABLE reports(id); CREATE TABLE audit_events(id);"
            "INSERT INTO events VALUES ('exercise'); INSERT INTO reports VALUES ('original');"
            "INSERT INTO audit_events VALUES ('decision');"
        )


def test_consistent_backup_and_restore_refuse_overwrites(tmp_path, capsys):
    source, backup, restored = (tmp_path / name for name in ("live.db", "backup.db", "restored.db"))
    create_database(source)
    assert maintenance.backup_database(source, backup)["counts"]["reports"] == 1
    with pytest.raises(FileExistsError):
        maintenance.backup_database(source, backup)
    assert maintenance.main(["restore", str(backup), str(restored)]) == 0
    assert maintenance.inspect_database(restored) == {"events": 1, "reports": 1, "audit_events": 1}
    assert maintenance.main(["backup", str(source), str(restored)]) == 1
    assert "error" in capsys.readouterr().err
    with closing(sqlite3.connect(source)) as connection:
        assert connection.execute("SELECT id FROM reports").fetchone()[0] == "original"


def test_non_aegis_corrupt_and_missing_databases_are_rejected(tmp_path, monkeypatch):
    path = tmp_path / "other.db"
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute("CREATE TABLE unrelated(id)")
    with pytest.raises(ValueError, match="not an Aegis"):
        maintenance.inspect_database(path)
    with pytest.raises(sqlite3.OperationalError):
        maintenance.inspect_database(tmp_path / "missing.db")
    assert not (tmp_path / "missing.db").exists()
    fake = SimpleNamespace(
        execute=lambda _query: SimpleNamespace(fetchone=lambda: ("corrupt",)), close=lambda: None
    )
    monkeypatch.setattr(maintenance.sqlite3, "connect", lambda *_args, **_kwargs: fake)
    with pytest.raises(ValueError, match="integrity"):
        maintenance.inspect_database(path)


def test_failed_backup_removes_only_its_new_destination(tmp_path, monkeypatch):
    path = tmp_path / "new.db"
    monkeypatch.setattr(maintenance, "inspect_database", lambda _path: {})
    monkeypatch.setattr(
        maintenance.sqlite3,
        "connect",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(sqlite3.Error("failure")),
    )
    with pytest.raises(sqlite3.Error):
        maintenance.backup_database(tmp_path / "source.db", path)
    assert not path.exists()


def test_preflight_does_not_create_database_and_reports_actual_mode(tmp_path, monkeypatch):
    monkeypatch.setattr(maintenance.shutil, "which", lambda _name: "/bin/bun")
    engine = AnalysisEngine(model_loader=lambda: None)
    monkeypatch.setattr(maintenance, "AnalysisEngine", lambda: engine)
    path = tmp_path / "not-created.db"
    result = maintenance.preflight(path)
    assert result["ready"] is True
    assert result["matching"]["engine"] == "lexical"
    assert result["database_counts"] is None
    assert not path.exists()
    create_database(path)
    assert maintenance.preflight(path, engine)["database_state"] == "verified"
    monkeypatch.setattr(maintenance.shutil, "which", lambda _name: None)
    assert maintenance.main(["preflight", "--db", str(path)]) == 1


def test_model_prepare_downloads_exact_commit_and_verifies_offline_inference(monkeypatch):
    calls = []
    monkeypatch.setitem(
        sys.modules,
        "huggingface_hub",
        SimpleNamespace(snapshot_download=lambda **kwargs: calls.append(kwargs) or "/cache/pinned"),
    )
    monkeypatch.setattr(
        maintenance,
        "AnalysisEngine",
        lambda: SimpleNamespace(
            analyze_report=lambda _text: {"model_revision": MODEL_REVISION, "embedding": [1, 0]}
        ),
    )
    result = maintenance.prepare_model()
    assert calls == [
        {"repo_id": MODEL_NAME, "revision": MODEL_COMMIT, "allow_patterns": MODEL_FILES}
    ]
    assert result["offline_inference_verified"] is True
    assert result["dimensions"] == 2
    monkeypatch.setattr(
        maintenance,
        "AnalysisEngine",
        lambda: SimpleNamespace(analyze_report=lambda _text: {"model_revision": "lexical"}),
    )
    with pytest.raises(RuntimeError, match="offline semantic"):
        maintenance.prepare_model()
    original_import = builtins.__import__

    def missing_import(name, *args, **kwargs):
        if name == "huggingface_hub":
            raise ImportError("not installed")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", missing_import)
    with pytest.raises(RuntimeError, match=r"requirements-semantic\.lock"):
        maintenance.prepare_model()


def test_command_outputs_and_entrypoint(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(maintenance, "prepare_model", lambda: {"verified": True})
    assert maintenance.main(["prepare-model"]) == 0
    assert json.loads(capsys.readouterr().out)["verified"] is True
    monkeypatch.setattr(maintenance, "run_evaluation", lambda: {"results": []})
    assert maintenance.main(["evaluate"]) == 0
    output = tmp_path / "nested" / "evaluation.json"
    assert maintenance.main(["evaluate", "--output", str(output)]) == 0
    assert json.loads(output.read_text()) == {"results": []}
    monkeypatch.setattr(
        sys, "argv", ["maintenance", "preflight", "--db", str(tmp_path / "unused.db")]
    )
    monkeypatch.setattr(AnalysisEngine, "health", lambda _self: {"engine": "lexical"})
    monkeypatch.setattr(maintenance.shutil, "which", lambda _name: "/bin/bun")
    monkeypatch.delitem(sys.modules, "aegis.maintenance")
    with pytest.raises(SystemExit) as stopped:
        runpy.run_module("aegis.maintenance", run_name="__main__")
    assert stopped.value.code == 0
