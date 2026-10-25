"""SQLite persistence and transactional coordinator actions for Aegis."""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def utc_now() -> datetime:
    return datetime.now(UTC)


def iso(value: datetime | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _unjson(value: str | None, default: Any) -> Any:
    if value is None:
        return default
    return json.loads(value)


class StorageError(Exception):
    """Expected persistence or state-transition failure safe for API display."""

    def __init__(self, status_code: int, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


class SQLiteStore:
    """A single-connection SQLite store with serialized, explicit transactions."""

    def __init__(self, path: str | Path = "runtime/aegis.sqlite3", create_event: bool = True):
        self.path = str(path) if str(path) == ":memory:" else str(Path(path).expanduser().resolve())
        self._lock = threading.RLock()
        if self.path != ":memory:":
            Path(self.path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(
            self.path, isolation_level=None, check_same_thread=False, timeout=10
        )
        self.connection.row_factory = sqlite3.Row
        with self._lock:
            self.connection.execute("PRAGMA foreign_keys = ON")
            self.connection.execute("PRAGMA busy_timeout = 10000")
            if self.path != ":memory:":
                self.connection.execute("PRAGMA journal_mode = WAL")
            self._initialize_schema()
        if create_event:
            with self.transaction() as conn:
                if self.current_event() is None:
                    self._create_event_tx(
                        conn, "Aegis Synthetic Exercise", "UTC", True, "priority-v1", "system"
                    )

    def close(self) -> None:
        with self._lock:
            self.connection.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self.connection.execute("BEGIN IMMEDIATE")
            try:
                yield self.connection
                self.connection.commit()
            except BaseException:
                self.connection.rollback()
                raise

    def _initialize_schema(self) -> None:
        base_schema = """
            CREATE TABLE IF NOT EXISTS events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                timezone TEXT NOT NULL,
                exercise INTEGER NOT NULL CHECK (exercise IN (0, 1)),
                policy_version TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS incidents (
                id TEXT PRIMARY KEY,
                event_id TEXT NOT NULL REFERENCES events(id),
                title TEXT NOT NULL,
                zone_id TEXT,
                suggested_priority TEXT NOT NULL,
                priority_reason TEXT NOT NULL,
                status TEXT NOT NULL,
                review_required INTEGER NOT NULL,
                review_reasons_json TEXT NOT NULL,
                version INTEGER NOT NULL CHECK (version >= 1),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                override_priority TEXT,
                override_reason TEXT
            );
            CREATE INDEX IF NOT EXISTS incidents_event_idx ON incidents(event_id);
            CREATE TABLE IF NOT EXISTS reports (
                id TEXT PRIMARY KEY,
                event_id TEXT NOT NULL REFERENCES events(id),
                idempotency_key TEXT NOT NULL,
                payload_fingerprint TEXT NOT NULL,
                text TEXT NOT NULL,
                source TEXT NOT NULL,
                zone_id TEXT,
                sublocation TEXT,
                category TEXT,
                reported_at TEXT,
                received_at TEXT NOT NULL,
                analysis_status TEXT NOT NULL
                    CHECK (analysis_status IN ('pending', 'complete', 'failed')),
                review_reasons_json TEXT NOT NULL,
                UNIQUE(event_id, idempotency_key)
            );
            CREATE INDEX IF NOT EXISTS reports_event_idx ON reports(event_id, received_at);
            CREATE TABLE IF NOT EXISTS memberships (
                report_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
                incident_id TEXT NOT NULL REFERENCES incidents(id),
                confirmed INTEGER NOT NULL DEFAULT 0,
                created_by TEXT NOT NULL,
                evidence_id TEXT
            );
            CREATE INDEX IF NOT EXISTS memberships_incident_idx ON memberships(incident_id);
            CREATE TABLE IF NOT EXISTS report_analysis (
                report_id TEXT PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
                model_revision TEXT,
                embedding_json TEXT,
                claims_json TEXT NOT NULL,
                analyzed_at TEXT
            );
            CREATE TABLE IF NOT EXISTS match_evidence (
                id TEXT PRIMARY KEY,
                event_id TEXT NOT NULL REFERENCES events(id),
                incident_id TEXT NOT NULL,
                report_id TEXT NOT NULL REFERENCES reports(id),
                candidate_report_id TEXT NOT NULL,
                semantic_score REAL,
                location_score REAL,
                time_score REAL,
                category_score REAL,
                total_score REAL,
                decision TEXT NOT NULL,
                reasons_json TEXT NOT NULL,
                missing_fields_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS evidence_incident_idx ON match_evidence(incident_id);
            CREATE TABLE IF NOT EXISTS conflicts (
                id TEXT PRIMARY KEY,
                event_id TEXT NOT NULL REFERENCES events(id),
                incident_id TEXT NOT NULL,
                field TEXT NOT NULL,
                report_ids_json TEXT NOT NULL,
                values_json TEXT NOT NULL,
                spans_json TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('unresolved', 'resolved')),
                reason TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS conflicts_incident_idx ON conflicts(incident_id);
            CREATE TABLE IF NOT EXISTS review_decisions (
                id TEXT PRIMARY KEY,
                event_id TEXT NOT NULL REFERENCES events(id),
                action TEXT NOT NULL,
                report_ids_json TEXT NOT NULL,
                incident_ids_json TEXT NOT NULL,
                target_incident_id TEXT,
                reason TEXT NOT NULL,
                actor TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rejections (
                event_id TEXT NOT NULL REFERENCES events(id),
                report_id TEXT NOT NULL REFERENCES reports(id),
                incident_id TEXT NOT NULL,
                actor TEXT NOT NULL,
                reason TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY(event_id, report_id, incident_id)
            );
            CREATE TABLE IF NOT EXISTS audit_events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                event_id TEXT NOT NULL REFERENCES events(id),
                actor TEXT NOT NULL,
                action TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                reason TEXT,
                before_json TEXT,
                after_json TEXT,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS audit_event_idx ON audit_events(event_id, seq);
            CREATE TABLE IF NOT EXISTS demo_sessions (
                id TEXT PRIMARY KEY,
                event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
                scenario TEXT NOT NULL,
                cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
                total INTEGER NOT NULL CHECK (total >= 0),
                created_at TEXT NOT NULL
            );
            """
        self.connection.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
        )
        applied = {
            int(row["version"])
            for row in self.connection.execute("SELECT version FROM schema_migrations").fetchall()
        }
        if 1 not in applied:
            with self.transaction() as conn:
                self._execute_script_tx(conn, base_schema)
                conn.execute(
                    "INSERT INTO schema_migrations(version,applied_at) VALUES(1,?)",
                    (iso(utc_now()),),
                )
        if 2 not in applied:
            with self.transaction() as conn:
                self._migrate_display_ids_and_notes_tx(conn)
                conn.execute(
                    "INSERT INTO schema_migrations(version,applied_at) VALUES(2,?)",
                    (iso(utc_now()),),
                )

    @staticmethod
    def _execute_script_tx(conn: sqlite3.Connection, script: str) -> None:
        pending = ""
        for line in script.splitlines(keepends=True):
            pending += line
            if sqlite3.complete_statement(pending):
                statement = pending.strip()
                pending = ""
                if statement:
                    conn.execute(statement)
        if pending.strip():
            raise sqlite3.OperationalError("incomplete SQL in schema migration")

    @staticmethod
    def _table_columns_tx(conn: sqlite3.Connection, table: str) -> set[str]:
        return {str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})")}

    def _migrate_display_ids_and_notes_tx(self, conn: sqlite3.Connection) -> None:
        incident_columns = self._table_columns_tx(conn, "incidents")
        if "display_id" not in incident_columns:
            conn.execute("ALTER TABLE incidents ADD COLUMN display_id TEXT")
        if "original_title" not in incident_columns:
            conn.execute("ALTER TABLE incidents ADD COLUMN original_title TEXT")
        if "title_override" not in incident_columns:
            conn.execute(
                "ALTER TABLE incidents ADD COLUMN title_override INTEGER NOT NULL DEFAULT 0 "
                "CHECK (title_override IN (0,1))"
            )
        report_columns = self._table_columns_tx(conn, "reports")
        if "display_id" not in report_columns:
            conn.execute("ALTER TABLE reports ADD COLUMN display_id TEXT")
        conn.execute("UPDATE incidents SET original_title=title WHERE original_title IS NULL")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS display_counters ("
            "event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,"
            "entity TEXT NOT NULL CHECK (entity IN ('report','incident')),"
            "last_value INTEGER NOT NULL CHECK (last_value >= 0),"
            "PRIMARY KEY(event_id,entity))"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS incident_notes ("
            "id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), "
            "incident_id TEXT NOT NULL REFERENCES incidents(id), text TEXT NOT NULL, "
            "actor TEXT NOT NULL, created_at TEXT NOT NULL)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS incident_notes_incident_idx "
            "ON incident_notes(incident_id,created_at,id)"
        )
        for table, entity, prefix, order_by in (
            ("reports", "report", "R", "received_at,id"),
            ("incidents", "incident", "I", "created_at,id"),
        ):
            events = conn.execute(
                f"SELECT DISTINCT event_id FROM {table} ORDER BY event_id"
            ).fetchall()
            for event_row in events:
                event_id = event_row["event_id"]
                rows = conn.execute(
                    f"SELECT id FROM {table} WHERE event_id=? ORDER BY {order_by}", (event_id,)
                ).fetchall()
                for number, row in enumerate(rows, start=1):
                    conn.execute(
                        f"UPDATE {table} SET display_id=? WHERE id=? AND display_id IS NULL",
                        (f"{prefix}-{number:06d}", row["id"]),
                    )
                conn.execute(
                    "INSERT INTO display_counters(event_id,entity,last_value) VALUES(?,?,?) "
                    "ON CONFLICT(event_id,entity) DO UPDATE SET last_value=max("
                    "display_counters.last_value,excluded.last_value)",
                    (event_id, entity, len(rows)),
                )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS reports_event_display_id_uq "
            "ON reports(event_id,display_id) WHERE display_id IS NOT NULL"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS incidents_event_display_id_uq "
            "ON incidents(event_id,display_id) WHERE display_id IS NOT NULL"
        )

    def create_event(
        self,
        name: str,
        timezone: str = "UTC",
        exercise: bool = True,
        policy_version: str = "priority-v1",
        actor: str = "system",
    ) -> dict[str, Any]:
        with self.transaction() as conn:
            return self._create_event_tx(conn, name, timezone, exercise, policy_version, actor)

    def _create_event_tx(
        self,
        conn: sqlite3.Connection,
        name: str,
        timezone: str,
        exercise: bool,
        policy_version: str,
        actor: str,
    ) -> dict[str, Any]:
        event = {
            "id": str(uuid.uuid4()),
            "name": name,
            "timezone": timezone,
            "exercise": exercise,
            "created_at": iso(utc_now()),
            "policy_version": policy_version,
        }
        conn.execute(
            "INSERT INTO events(id,name,timezone,exercise,policy_version,created_at) "
            "VALUES(?,?,?,?,?,?)",
            (
                event["id"],
                event["name"],
                event["timezone"],
                int(exercise),
                event["policy_version"],
                event["created_at"],
            ),
        )
        self._audit_tx(conn, event["id"], actor, "event.created", event["id"], None, None, event)
        return event

    def get_event(self, event_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.connection.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
            return self._event_dict(row) if row else None

    def current_event(self) -> dict[str, Any] | None:
        with self._lock:
            row = self.connection.execute(
                "SELECT * FROM events ORDER BY seq DESC LIMIT 1"
            ).fetchone()
            return self._event_dict(row) if row else None

    def events(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.connection.execute("SELECT * FROM events ORDER BY seq DESC").fetchall()
            return [self._event_dict(row) for row in rows]

    @staticmethod
    def _event_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "name": row["name"],
            "timezone": row["timezone"],
            "exercise": bool(row["exercise"]),
            "created_at": row["created_at"],
            "policy_version": row["policy_version"],
        }

    @staticmethod
    def _next_display_id_tx(conn: sqlite3.Connection, event_id: str, entity: str) -> str:
        prefix = {"report": "R", "incident": "I"}[entity]
        row = conn.execute(
            "SELECT last_value FROM display_counters WHERE event_id=? AND entity=?",
            (event_id, entity),
        ).fetchone()
        if row is None:
            number = 1
            conn.execute(
                "INSERT INTO display_counters(event_id,entity,last_value) VALUES(?,?,?)",
                (event_id, entity, number),
            )
        else:
            number = int(row["last_value"]) + 1
            conn.execute(
                "UPDATE display_counters SET last_value=? WHERE event_id=? AND entity=?",
                (number, event_id, entity),
            )
        return f"{prefix}-{number:06d}"

    def create_report_receipt(
        self,
        *,
        event_id: str,
        text: str,
        zone_id: str | None,
        sublocation: str | None,
        reported_at: datetime | str | None,
        idempotency_key: str,
        source: str = "form",
    ) -> tuple[dict[str, Any], dict[str, Any], bool]:
        reported_at_value = iso(reported_at)
        fingerprint = _json(
            {
                "text": text,
                "zone_id": zone_id,
                "sublocation": sublocation,
                "reported_at": reported_at_value,
                "source": source,
            }
        )
        with self.transaction() as conn:
            event_row = conn.execute("SELECT id FROM events WHERE id=?", (event_id,)).fetchone()
            if event_row is None:
                raise StorageError(404, "not_found", "Event was not found.")
            existing = conn.execute(
                "SELECT id,payload_fingerprint FROM reports WHERE event_id=? AND idempotency_key=?",
                (event_id, idempotency_key),
            ).fetchone()
            if existing is not None:
                if existing["payload_fingerprint"] != fingerprint:
                    raise StorageError(
                        409,
                        "idempotency_conflict",
                        "This idempotency key was already used with a different report payload.",
                    )
                report = self._report_tx(conn, existing["id"])
                incident = self._incident_tx(conn, report["incident_id"])
                return report, incident, True

            timestamp = iso(utc_now())
            report_id = str(uuid.uuid4())
            incident_id = str(uuid.uuid4())
            report_display_id = self._next_display_id_tx(conn, event_id, "report")
            incident_display_id = self._next_display_id_tx(conn, event_id, "incident")
            reasons = ["Analysis pending"]
            incident = {
                "id": incident_id,
                "display_id": incident_display_id,
                "event_id": event_id,
                "title": self._title(text),
                "zone_id": zone_id,
                "suggested_priority": "UNASSESSED",
                "priority_reason": "Analysis has not completed.",
                "status": "open",
                "review_required": True,
                "review_reasons": reasons,
                "version": 1,
                "created_at": timestamp,
                "updated_at": timestamp,
                "override_priority": None,
                "override_reason": None,
                "original_title": self._title(text),
                "title_override": False,
            }
            conn.execute(
                "INSERT INTO "
                "incidents(id,event_id,title,zone_id,suggested_priority,priority_reason,"
                "status,review_required,review_reasons_json,version,created_at,updated_at,"
                "display_id,original_title,title_override) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    incident_id,
                    event_id,
                    incident["title"],
                    zone_id,
                    "UNASSESSED",
                    incident["priority_reason"],
                    "open",
                    1,
                    _json(reasons),
                    1,
                    timestamp,
                    timestamp,
                    incident_display_id,
                    incident["original_title"],
                    0,
                ),
            )
            conn.execute(
                "INSERT INTO "
                "reports(id,event_id,idempotency_key,payload_fingerprint,text,source,zone_id,"
                "sublocation,category,reported_at,received_at,analysis_status,review_reasons_json,"
                "display_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    report_id,
                    event_id,
                    idempotency_key,
                    fingerprint,
                    text,
                    source,
                    zone_id,
                    sublocation,
                    None,
                    reported_at_value,
                    timestamp,
                    "pending",
                    _json(reasons),
                    report_display_id,
                ),
            )
            conn.execute(
                "INSERT INTO memberships(report_id,incident_id,confirmed,created_by) "
                "VALUES(?,?,0,?)",
                (report_id, incident_id, source),
            )
            conn.execute(
                "INSERT INTO "
                "report_analysis(report_id,model_revision,embedding_json,claims_json,analyzed_at) "
                "VALUES(?,NULL,NULL,?,NULL)",
                (report_id, _json([])),
            )
            report = self._report_tx(conn, report_id)
            self._audit_tx(
                conn,
                event_id,
                source,
                "report.received",
                report_id,
                None,
                None,
                {"report": report, "incident_id": incident_id},
            )
            return report, self._incident_tx(conn, incident_id), False

    @staticmethod
    def _title(text: str) -> str:
        compact = " ".join(text.split())
        if len(compact) <= 96:
            return compact
        return compact[:93].rstrip() + "..."

    def _report_tx(self, conn: sqlite3.Connection, report_id: str) -> dict[str, Any]:
        row = conn.execute(
            "SELECT r.*,m.incident_id,m.confirmed,a.model_revision,"
            "a.embedding_json,a.claims_json "
            "FROM reports r JOIN memberships m ON m.report_id=r.id "
            "JOIN report_analysis a ON a.report_id=r.id WHERE r.id=?",
            (report_id,),
        ).fetchone()
        if row is None:
            raise StorageError(404, "not_found", "Report was not found.")
        return self._report_dict(row, include_embedding=True)

    def _report_dict(self, row: sqlite3.Row, include_embedding: bool = False) -> dict[str, Any]:
        report = {
            "id": row["id"],
            "display_id": row["display_id"],
            "event_id": row["event_id"],
            "text": row["text"],
            "zone_id": row["zone_id"],
            "sublocation": row["sublocation"],
            "category": row["category"],
            "reported_at": row["reported_at"],
            "received_at": row["received_at"],
            "analysis_status": row["analysis_status"],
            "incident_id": row["incident_id"],
            "claims": _unjson(row["claims_json"], []),
            "review_reasons": _unjson(row["review_reasons_json"], []),
            "model_revision": row["model_revision"],
            "confirmed": bool(row["confirmed"]),
        }
        if include_embedding:
            report["embedding"] = _unjson(row["embedding_json"], None)
            report["source"] = row["source"]
        return report

    def get_report(self, report_id: str) -> dict[str, Any] | None:
        with self._lock:
            try:
                return self._report_tx(self.connection, report_id)
            except StorageError as exc:
                if exc.status_code == 404:
                    return None
                raise

    def reports_for_event(self, event_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.connection.execute(
                "SELECT r.*,m.incident_id,m.confirmed,a.model_revision,"
                "a.embedding_json,a.claims_json "
                "FROM reports r JOIN memberships m ON m.report_id=r.id "
                "JOIN report_analysis a ON a.report_id=r.id WHERE r.event_id=? ORDER BY "
                "r.received_at,r.id",
                (event_id,),
            ).fetchall()
            return [self._report_dict(row, include_embedding=True) for row in rows]

    def pending_reports(self, limit: int = 20) -> list[dict[str, Any]]:
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
            raise ValueError("limit must be a positive integer")
        with self._lock:
            rows = self.connection.execute(
                "SELECT id FROM reports WHERE analysis_status='pending' "
                "ORDER BY received_at,id LIMIT ?",
                (limit,),
            ).fetchall()
            return [self._report_tx(self.connection, row["id"]) for row in rows]

    def prepare_report_retry(
        self,
        report_id: str,
        expected_version: int,
        actor: str = "coordinator",
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """Authorize an explicit retry and leave the raw receipt in place."""
        with self.transaction() as conn:
            report = self._report_tx(conn, report_id)
            incident_row = conn.execute(
                "SELECT * FROM incidents WHERE id=?", (report["incident_id"],)
            ).fetchone()
            if incident_row is None:
                raise StorageError(404, "not_found", "Incident was not found.")
            self._check_version(incident_row, expected_version)
            if report["analysis_status"] == "complete":
                raise StorageError(
                    409,
                    "analysis_not_retryable",
                    "Completed report analysis cannot be retried.",
                )
            before = {
                "analysis_status": report["analysis_status"],
                "incident_id": report["incident_id"],
            }
            conn.execute("UPDATE reports SET analysis_status='pending' WHERE id=?", (report_id,))
            pending_report = self._report_tx(conn, report_id)
            self._audit_tx(
                conn,
                report["event_id"],
                actor,
                "report.analysis_retry_started",
                report_id,
                None,
                before,
                {"analysis_status": "pending", "incident_id": pending_report["incident_id"]},
            )
            return pending_report, self._incident_tx(conn, pending_report["incident_id"])

    def get_groups_for_event(self, event_id: str) -> list[dict[str, Any]]:
        with self._lock:
            incidents = self.connection.execute(
                "SELECT id FROM incidents WHERE event_id=? AND status!='resolved' ORDER BY "
                "created_at,id",
                (event_id,),
            ).fetchall()
            groups: list[dict[str, Any]] = []
            for incident in incidents:
                report_rows = self.connection.execute(
                    "SELECT r.*,m.incident_id,m.confirmed,a.model_revision,"
                    "a.embedding_json,a.claims_json "
                    "FROM reports r JOIN memberships m ON m.report_id=r.id "
                    "JOIN report_analysis a ON a.report_id=r.id WHERE m.incident_id=? "
                    "ORDER BY r.received_at,r.id",
                    (incident["id"],),
                ).fetchall()
                groups.append(
                    {
                        "id": incident["id"],
                        "reports": [self._report_dict(row, True) for row in report_rows],
                    }
                )
            return groups

    def rejection_pairs(self, event_id: str) -> set[tuple[str, str]]:
        with self._lock:
            return self._rejection_pairs_tx(self.connection, event_id)

    def _rejection_pairs_tx(self, conn: sqlite3.Connection, event_id: str) -> set[tuple[str, str]]:
        rows = conn.execute(
            "SELECT report_id,incident_id FROM rejections WHERE event_id=?", (event_id,)
        ).fetchall()
        return {(row["report_id"], row["incident_id"]) for row in rows}

    def _groups_for_event_tx(
        self, conn: sqlite3.Connection, event_id: str, exclude_incident_id: str
    ) -> list[dict[str, Any]]:
        incidents = conn.execute(
            "SELECT id FROM incidents WHERE event_id=? AND status!='resolved' AND id!=? "
            "ORDER BY created_at,id",
            (event_id, exclude_incident_id),
        ).fetchall()
        groups = []
        for incident in incidents:
            reports = [
                report
                for report in self._reports_for_incident_tx(conn, incident["id"])
                if report["analysis_status"] == "complete"
            ]
            if reports:
                groups.append({"id": incident["id"], "reports": reports})
        return groups

    def finalize_analysis(
        self,
        report_id: str,
        analysis: dict[str, Any],
        target_incident_id: str | None,
        evidence: list[dict[str, Any]],
        assessment: dict[str, Any],
        conflicts: list[dict[str, Any]],
        failure: str | None = None,
        *,
        engine: Any | None = None,
        receipt_incident_id: str | None = None,
        preserve_membership: bool = False,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        with self.transaction() as conn:
            report = self._report_tx(conn, report_id)
            if report["analysis_status"] != "pending":
                incident = self._incident_tx(conn, report["incident_id"])
                return report, incident
            old_incident_id = report["incident_id"]
            event_id = report["event_id"]
            analysis = dict(analysis)
            evidence = list(evidence)
            human_changed_membership = (
                preserve_membership
                or (receipt_incident_id is not None and old_incident_id != receipt_incident_id)
                or bool(report.get("confirmed"))
                or (
                    receipt_incident_id is not None
                    and self._incident_tx(conn, old_incident_id)["version"] > 1
                )
            )
            if engine is not None and failure is None and not human_changed_membership:
                current_groups = self._groups_for_event_tx(conn, event_id, old_incident_id)
                decision = engine.choose_group(
                    {**report, **analysis}, current_groups, self._rejection_pairs_tx(conn, event_id)
                )
                if not isinstance(decision, dict):
                    raise TypeError("choose_group must return a dictionary")
                target_incident_id = decision.get("incident_id")
                if target_incident_id is not None and all(
                    group["id"] != target_incident_id for group in current_groups
                ):
                    target_incident_id = None
                    decision["review_reasons"] = [
                        *list(decision.get("review_reasons", [])),
                        "The selected candidate changed before analysis completed; retain a "
                        "singleton for review.",
                    ]
                rejection_pairs = self._rejection_pairs_tx(conn, event_id)
                if target_incident_id is not None and (
                    (report_id, target_incident_id) in rejection_pairs
                    or (target_incident_id, report_id) in rejection_pairs
                ):
                    target_incident_id = None
                    decision["review_reasons"] = [
                        *list(decision.get("review_reasons", [])),
                        "A coordinator rejection blocks this report-to-incident pairing.",
                    ]
                decision_evidence = decision.get("evidence", [])
                if not isinstance(decision_evidence, list):
                    raise TypeError("choose_group evidence must be a list")
                evidence = decision_evidence
                analysis["review_reasons"] = list(
                    dict.fromkeys(
                        list(analysis.get("review_reasons", []))
                        + list(decision.get("review_reasons", []))
                    )
                )
            elif human_changed_membership and failure is None:
                target_incident_id = old_incident_id
                analysis["review_reasons"] = list(
                    dict.fromkeys(
                        [
                            *list(analysis.get("review_reasons", [])),
                            "Coordinator changed the incident while analysis was pending; "
                            "review the completed analysis.",
                        ]
                    )
                )
                evidence = [
                    {
                        **item,
                        "decision": "suggest",
                        "reasons": list(
                            dict.fromkeys(
                                [
                                    *list(item.get("reasons", [])),
                                    "Coordinator membership decision took precedence over this "
                                    "pending analysis.",
                                ]
                            )
                        ),
                    }
                    for item in evidence
                ]
            target_row = None
            if target_incident_id is not None:
                target_row = conn.execute(
                    "SELECT * FROM incidents WHERE id=? AND event_id=?",
                    (target_incident_id, event_id),
                ).fetchone()
                if target_row is None:
                    target_incident_id = None
            if target_incident_id is None:
                target_incident_id = old_incident_id
            now = iso(utc_now())
            status = "failed" if failure is not None else "complete"
            review_reasons = list(dict.fromkeys(analysis.get("review_reasons", [])))
            if failure is not None:
                review_reasons.append("Analysis failed; coordinator review required")
            if target_incident_id != old_incident_id:
                conn.execute(
                    "UPDATE memberships SET incident_id=?,confirmed=0,created_by=? WHERE "
                    "report_id=?",
                    (target_incident_id, "engine", report_id),
                )
            conn.execute(
                "UPDATE reports SET category=?,analysis_status=?,review_reasons_json=? WHERE id=?",
                (analysis.get("category"), status, _json(review_reasons), report_id),
            )
            conn.execute(
                "UPDATE report_analysis SET "
                "model_revision=?,embedding_json=?,claims_json=?,analyzed_at=? "
                "WHERE report_id=?",
                (
                    analysis.get("model_revision"),
                    _json(analysis.get("embedding"))
                    if analysis.get("embedding") is not None
                    else None,
                    _json(analysis.get("claims", [])),
                    now,
                    report_id,
                ),
            )
            if target_incident_id != old_incident_id:
                count = conn.execute(
                    "SELECT count(*) AS n FROM memberships WHERE incident_id=?", (old_incident_id,)
                ).fetchone()["n"]
                if count == 0:
                    conn.execute(
                        "UPDATE incident_notes SET incident_id=? WHERE incident_id=?",
                        (target_incident_id, old_incident_id),
                    )
                    conn.execute("DELETE FROM incidents WHERE id=?", (old_incident_id,))
                else:
                    old_assessment = None
                    old_conflicts = None
                    if engine is not None and failure is None:
                        old_reports = self._reports_for_incident_tx(conn, old_incident_id)
                        old_assessment = engine.assess_priority(old_reports)
                        old_conflicts = engine.detect_conflicts(old_reports)
                    self._rebuild_incident_tx(
                        conn, old_incident_id, old_assessment, old_conflicts, increment=True
                    )
            if engine is not None and failure is None:
                current_reports = self._reports_for_incident_tx(conn, target_incident_id)
                assessment = engine.assess_priority(current_reports)
                conflicts = engine.detect_conflicts(current_reports)
            elif failure is not None:
                # A coordinator may have moved the pending receipt into a live group.
                # A fallback assessment of that receipt must not downgrade its other members.
                current = conn.execute(
                    "SELECT suggested_priority,priority_reason FROM incidents WHERE id=?",
                    (target_incident_id,),
                ).fetchone()
                if self._priority_rank(current["suggested_priority"]) < self._priority_rank(
                    assessment["priority"]
                ):
                    assessment = {
                        **assessment,
                        "priority": current["suggested_priority"],
                        "reason": current["priority_reason"],
                    }
            self._rebuild_incident_tx(
                conn,
                target_incident_id,
                assessment,
                conflicts,
                increment=True,
                add_review_reasons=review_reasons,
            )
            for item in evidence:
                self._insert_evidence_tx(conn, event_id, target_incident_id, item, now)
            final_report = self._report_tx(conn, report_id)
            incident = self._incident_tx(conn, target_incident_id)
            self._audit_tx(
                conn,
                event_id,
                report["source"],
                "report.analysis_failed" if failure else "report.analyzed",
                report_id,
                failure,
                {"incident_id": old_incident_id, "analysis_status": "pending"},
                {
                    "incident_id": target_incident_id,
                    "analysis_status": status,
                    "review_reasons": review_reasons,
                },
            )
            return final_report, incident

    def fail_pending_analysis(
        self,
        report_id: str,
        message: str,
        fallback_assessment: dict[str, Any] | None = None,
        *,
        preserve_membership: bool = False,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """Turn a stored pending receipt into a visible failed singleton."""
        assessment = fallback_assessment or {
            "priority": "UNASSESSED",
            "reason": "Analysis failed; coordinator review required.",
            "review_reasons": ["Analysis failed; coordinator review required"],
        }
        return self.finalize_analysis(
            report_id,
            {
                "category": None,
                "claims": [],
                "embedding": None,
                "model_revision": None,
                "review_reasons": ["Analysis unavailable"],
            },
            None,
            [],
            assessment,
            [],
            failure=message,
            preserve_membership=preserve_membership,
        )

    def _insert_evidence_tx(
        self,
        conn: sqlite3.Connection,
        event_id: str,
        incident_id: str,
        evidence: dict[str, Any],
        timestamp: str,
    ) -> None:
        conn.execute(
            "INSERT INTO match_evidence(id,event_id,incident_id,report_id,candidate_report_id,"
            "semantic_score,location_score,time_score,category_score,total_score,decision,reasons_json,"
            "missing_fields_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                str(uuid.uuid4()),
                event_id,
                incident_id,
                evidence["report_id"],
                evidence["candidate_report_id"],
                evidence.get("semantic_score"),
                evidence.get("location_score"),
                evidence.get("time_score"),
                evidence.get("category_score"),
                evidence.get("total_score"),
                evidence.get("decision", "separate"),
                _json(evidence.get("reasons", [])),
                _json(evidence.get("missing_fields", [])),
                timestamp,
            ),
        )

    def _rebuild_incident_tx(
        self,
        conn: sqlite3.Connection,
        incident_id: str,
        assessment: dict[str, Any] | None,
        conflicts: list[dict[str, Any]] | None,
        *,
        increment: bool,
        add_review_reasons: list[str] | None = None,
        reconcile_conflicts: bool = False,
        conflict_resolution_reason: str | None = None,
    ) -> None:
        row = conn.execute("SELECT * FROM incidents WHERE id=?", (incident_id,)).fetchone()
        if row is None:
            return
        reports = self._reports_for_incident_tx(conn, incident_id)
        if assessment is None:
            assessment = {
                "priority": row["suggested_priority"],
                "reason": row["priority_reason"],
                "review_reasons": [],
            }
        report_reasons = [reason for report in reports for reason in report["review_reasons"]]
        review_reasons = list(dict.fromkeys(report_reasons + assessment.get("review_reasons", [])))
        if add_review_reasons:
            review_reasons = list(dict.fromkeys(review_reasons + add_review_reasons))
        unresolved = 0
        if conflicts is not None:
            active_conflict_ids = {
                self._conflict_id(incident_id, conflict) for conflict in conflicts
            }
            if reconcile_conflicts:
                stale_rows = conn.execute(
                    "SELECT id FROM conflicts WHERE incident_id=? AND status='unresolved'",
                    (incident_id,),
                ).fetchall()
                now = iso(utc_now())
                resolution = "Coordinator changed report grouping."
                if conflict_resolution_reason:
                    resolution += f" Reason: {conflict_resolution_reason}"
                for stale in stale_rows:
                    if stale["id"] not in active_conflict_ids:
                        conn.execute(
                            "UPDATE conflicts SET status='resolved',reason=?,updated_at=? "
                            "WHERE id=?",
                            (resolution, now, stale["id"]),
                        )
            for conflict in conflicts:
                self._upsert_conflict_tx(conn, row["event_id"], incident_id, conflict)
        unresolved = conn.execute(
            "SELECT count(*) AS n FROM conflicts WHERE incident_id=? AND status='unresolved'",
            (incident_id,),
        ).fetchone()["n"]
        if unresolved:
            review_reasons = list(
                dict.fromkeys([*review_reasons, "Conflicting or changing reports need review"])
            )
        suggested = assessment.get("priority", row["suggested_priority"])
        zone_id = self._dominant_zone(reports)
        generated_title = self._title(reports[0]["text"]) if reports else row["title"]
        title = row["title"] if row["title_override"] else generated_title
        original_title = row["original_title"] or generated_title
        if not row["title_override"]:
            original_title = generated_title
        version = int(row["version"]) + int(increment)
        now = iso(utc_now())
        conn.execute(
            "UPDATE incidents SET "
            "title=?,original_title=?,zone_id=?,suggested_priority=?,priority_reason=?,review_required=?,"
            "review_reasons_json=?,version=?,updated_at=? WHERE id=?",
            (
                title,
                original_title,
                zone_id,
                suggested,
                assessment.get("reason", ""),
                int(bool(review_reasons) or bool(unresolved)),
                _json(review_reasons),
                version,
                now,
                incident_id,
            ),
        )
        self._sync_priority_override_review_tx(conn, incident_id)

    def _sync_priority_override_review_tx(self, conn: sqlite3.Connection, incident_id: str) -> None:
        row = conn.execute(
            "SELECT override_priority,suggested_priority,review_reasons_json FROM incidents "
            "WHERE id=?",
            (incident_id,),
        ).fetchone()
        if row is None:
            return
        marker = "New higher-priority evidence after override needs review"
        reasons = _unjson(row["review_reasons_json"], [])
        if row["override_priority"] is not None and self._priority_rank(
            row["suggested_priority"]
        ) < self._priority_rank(row["override_priority"]):
            reasons = list(dict.fromkeys([*reasons, marker]))
        else:
            reasons = [reason for reason in reasons if reason != marker]
        unresolved = conn.execute(
            "SELECT count(*) AS n FROM conflicts WHERE incident_id=? AND status='unresolved'",
            (incident_id,),
        ).fetchone()["n"]
        conn.execute(
            "UPDATE incidents SET review_reasons_json=?,review_required=? WHERE id=?",
            (_json(reasons), int(bool(reasons) or bool(unresolved)), incident_id),
        )

    @staticmethod
    def _priority_rank(priority: str) -> int:
        order = {"P0": 0, "P1": 1, "P2": 2, "UNASSESSED": 3}
        return order.get(priority, 3)

    @staticmethod
    def _dominant_zone(reports: list[dict[str, Any]]) -> str | None:
        zones = [report["zone_id"] for report in reports if report.get("zone_id")]
        return zones[0] if zones else None

    def _upsert_conflict_tx(
        self, conn: sqlite3.Connection, event_id: str, incident_id: str, conflict: dict[str, Any]
    ) -> None:
        report_ids = list(conflict.get("report_ids", []))
        conflict_id = self._conflict_id(incident_id, conflict)
        existing = conn.execute(
            "SELECT status,reason FROM conflicts WHERE id=?", (conflict_id,)
        ).fetchone()
        status = existing["status"] if existing else "unresolved"
        reason = (
            existing["reason"]
            if existing
            else conflict.get("reason", "Opposing reports require coordinator review.")
        )
        conn.execute(
            "INSERT INTO "
            "conflicts(id,event_id,incident_id,field,report_ids_json,values_json,"
            "spans_json,status,reason,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
            "report_ids_json=excluded.report_ids_json,values_json=excluded.values_json,"
            "spans_json=excluded.spans_json,updated_at=excluded.updated_at",
            (
                conflict_id,
                event_id,
                incident_id,
                conflict["field"],
                _json(report_ids),
                _json(conflict.get("values", [])),
                _json(conflict.get("spans", [])),
                status,
                reason,
                iso(utc_now()),
            ),
        )

    @staticmethod
    def _conflict_id(incident_id: str, conflict: dict[str, Any]) -> str:
        fingerprint = _json(
            {
                "incident_id": incident_id,
                "field": conflict["field"],
                "report_ids": sorted(conflict.get("report_ids", [])),
                "values": conflict.get("values", []),
            }
        )
        return str(uuid.uuid5(uuid.NAMESPACE_URL, fingerprint))

    def _reports_for_incident_tx(
        self, conn: sqlite3.Connection, incident_id: str
    ) -> list[dict[str, Any]]:
        rows = conn.execute(
            "SELECT r.*,m.incident_id,m.confirmed,a.model_revision,"
            "a.embedding_json,a.claims_json "
            "FROM reports r JOIN memberships m ON m.report_id=r.id "
            "JOIN report_analysis a ON a.report_id=r.id WHERE m.incident_id=? ORDER BY "
            "r.received_at,r.id",
            (incident_id,),
        ).fetchall()
        return [self._report_dict(row, True) for row in rows]

    def incidents_for_event(self, event_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.connection.execute(
                "SELECT id FROM incidents WHERE event_id=? ORDER BY created_at,id", (event_id,)
            ).fetchall()
            return [self._incident_tx(self.connection, row["id"]) for row in rows]

    def get_incident(self, incident_id: str) -> dict[str, Any] | None:
        with self._lock:
            try:
                return self._incident_tx(self.connection, incident_id)
            except StorageError as exc:
                if exc.status_code == 404:
                    return None
                raise

    def _incident_tx(self, conn: sqlite3.Connection, incident_id: str) -> dict[str, Any]:
        row = conn.execute("SELECT * FROM incidents WHERE id=?", (incident_id,)).fetchone()
        if row is None:
            raise StorageError(404, "not_found", "Incident was not found.")
        report_ids = [
            item["report_id"]
            for item in conn.execute(
                "SELECT report_id FROM memberships WHERE incident_id=? ORDER BY report_id",
                (incident_id,),
            ).fetchall()
        ]
        evidence_rows = conn.execute(
            "SELECT e.* FROM match_evidence e JOIN memberships m ON m.report_id=e.report_id "
            "WHERE m.incident_id=? ORDER BY e.created_at,e.id",
            (incident_id,),
        ).fetchall()
        conflict_rows = conn.execute(
            "SELECT * FROM conflicts WHERE incident_id=? ORDER BY updated_at,id", (incident_id,)
        ).fetchall()
        priority = row["override_priority"] or row["suggested_priority"]
        return {
            "id": row["id"],
            "display_id": row["display_id"],
            "event_id": row["event_id"],
            "title": row["title"],
            "zone_id": row["zone_id"],
            "priority": priority,
            "suggested_priority": row["suggested_priority"],
            "priority_reason": row["priority_reason"],
            "status": row["status"],
            "review_required": bool(row["review_required"]),
            "review_reasons": _unjson(row["review_reasons_json"], []),
            "report_ids": report_ids,
            "evidence": [
                {
                    "report_id": item["report_id"],
                    "candidate_report_id": item["candidate_report_id"],
                    "semantic_score": item["semantic_score"],
                    "location_score": item["location_score"],
                    "time_score": item["time_score"],
                    "category_score": item["category_score"],
                    "total_score": item["total_score"],
                    "decision": item["decision"],
                    "reasons": _unjson(item["reasons_json"], []),
                    "missing_fields": _unjson(item["missing_fields_json"], []),
                    "created_at": item["created_at"],
                }
                for item in evidence_rows
            ],
            "conflicts": [
                {
                    "id": item["id"],
                    "field": item["field"],
                    "report_ids": _unjson(item["report_ids_json"], []),
                    "values": _unjson(item["values_json"], []),
                    "spans": _unjson(item["spans_json"], []),
                    "status": item["status"],
                    "reason": item["reason"],
                }
                for item in conflict_rows
            ],
            "version": row["version"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "override_reason": row["override_reason"],
            "notes": [
                {
                    "id": item["id"],
                    "text": item["text"],
                    "actor": item["actor"],
                    "created_at": item["created_at"],
                }
                for item in conn.execute(
                    "SELECT id,text,actor,created_at FROM incident_notes WHERE incident_id=? "
                    "ORDER BY created_at,id",
                    (incident_id,),
                ).fetchall()
            ],
            "original_title": row["original_title"],
            "title_override": bool(row["title_override"]),
        }

    def audit_for_event(self, event_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.connection.execute(
                "SELECT * FROM audit_events WHERE event_id=? ORDER BY seq", (event_id,)
            ).fetchall()
            return [self._audit_dict(row) for row in rows]

    @staticmethod
    def _audit_dict(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "seq": row["seq"],
            "event_id": row["event_id"],
            "actor": row["actor"],
            "action": row["action"],
            "entity_id": row["entity_id"],
            "reason": row["reason"],
            "before": _unjson(row["before_json"], None),
            "after": _unjson(row["after_json"], None),
            "created_at": row["created_at"],
        }

    def _audit_tx(
        self,
        conn: sqlite3.Connection,
        event_id: str,
        actor: str,
        action: str,
        entity_id: str,
        reason: str | None,
        before: Any,
        after: Any,
    ) -> None:
        conn.execute(
            "INSERT INTO "
            "audit_events(id,event_id,actor,action,entity_id,reason,"
            "before_json,after_json,created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (
                str(uuid.uuid4()),
                event_id,
                actor,
                action,
                entity_id,
                reason,
                _json(before) if before is not None else None,
                _json(after) if after is not None else None,
                iso(utc_now()),
            ),
        )

    def snapshot_data(self, event_id: str) -> dict[str, Any]:
        with self._lock:
            self.connection.execute("BEGIN")
            try:
                event_row = self.connection.execute(
                    "SELECT * FROM events WHERE id=?", (event_id,)
                ).fetchone()
                if event_row is None:
                    raise StorageError(404, "not_found", "Event was not found.")
                event = self._event_dict(event_row)
                reports = self.reports_for_event(event_id)
                incidents = self.incidents_for_event(event_id)
                audit = self.audit_for_event(event_id)
                undoable_actions = self._undoable_actions_tx(self.connection, event_id)
            except Exception:
                self.connection.rollback()
                raise
            else:
                self.connection.commit()
        return {
            "event": event,
            "reports": reports,
            "incidents": incidents,
            "audit": audit,
            "undoable_actions": undoable_actions,
        }

    def _undoable_actions_tx(self, conn: sqlite3.Connection, event_id: str) -> list[dict[str, Any]]:
        incidents = conn.execute(
            "SELECT * FROM incidents WHERE event_id=? ORDER BY created_at,id", (event_id,)
        ).fetchall()
        result = []
        allowed = {
            "incident.priority_overridden",
            "incident.priority_reset",
            "incident.status_changed",
        }
        for incident in incidents:
            latest = conn.execute(
                "SELECT id,action,after_json FROM audit_events WHERE event_id=? AND entity_id=? "
                "ORDER BY seq DESC LIMIT 1",
                (event_id, incident["id"]),
            ).fetchone()
            if latest is None or latest["action"] not in allowed:
                continue
            after = _unjson(latest["after_json"], None)
            if not isinstance(after, dict) or after.get("version") != incident["version"]:
                continue
            result.append(
                {
                    "audit_id": latest["id"],
                    "incident_id": incident["id"],
                    "action": latest["action"],
                    "expected_version": int(incident["version"]),
                }
            )
        return result

    def add_incident_note(
        self,
        incident_id: str,
        text: str,
        expected_version: int,
        actor: str = "coordinator",
    ) -> str:
        with self.transaction() as conn:
            row = conn.execute("SELECT * FROM incidents WHERE id=?", (incident_id,)).fetchone()
            if row is None:
                raise StorageError(404, "not_found", "Incident was not found.")
            self._check_version(row, expected_version)
            before = self._incident_tx(conn, incident_id)
            now = iso(utc_now())
            note = {
                "id": str(uuid.uuid4()),
                "text": text,
                "actor": actor,
                "created_at": now,
            }
            conn.execute(
                "INSERT INTO incident_notes(id,event_id,incident_id,text,actor,created_at) "
                "VALUES(?,?,?,?,?,?)",
                (note["id"], row["event_id"], incident_id, text, actor, now),
            )
            conn.execute(
                "UPDATE incidents SET version=version+1,updated_at=? WHERE id=?",
                (now, incident_id),
            )
            after = self._incident_tx(conn, incident_id)
            self._audit_tx(
                conn,
                row["event_id"],
                actor,
                "incident.note_added",
                incident_id,
                text,
                before,
                after,
            )
            return row["event_id"]

    def update_incident_title(
        self,
        incident_id: str,
        title: str,
        reason: str,
        expected_version: int,
        actor: str = "coordinator",
    ) -> str:
        with self.transaction() as conn:
            row = conn.execute("SELECT * FROM incidents WHERE id=?", (incident_id,)).fetchone()
            if row is None:
                raise StorageError(404, "not_found", "Incident was not found.")
            self._check_version(row, expected_version)
            before = self._incident_tx(conn, incident_id)
            original_title = row["original_title"] or row["title"]
            if not row["title_override"]:
                original_title = row["title"]
            now = iso(utc_now())
            conn.execute(
                "UPDATE incidents SET title=?,original_title=?,title_override=1,version=version+1,"
                "updated_at=? WHERE id=?",
                (title, original_title, now, incident_id),
            )
            after = self._incident_tx(conn, incident_id)
            self._audit_tx(
                conn,
                row["event_id"],
                actor,
                "incident.title_changed",
                incident_id,
                reason,
                before,
                after,
            )
            return row["event_id"]

    def reset_priority(
        self,
        incident_id: str,
        reason: str,
        expected_version: int,
        actor: str = "coordinator",
    ) -> str:
        with self.transaction() as conn:
            row = conn.execute("SELECT * FROM incidents WHERE id=?", (incident_id,)).fetchone()
            if row is None:
                raise StorageError(404, "not_found", "Incident was not found.")
            self._check_version(row, expected_version)
            if row["override_priority"] is None:
                raise StorageError(
                    409, "priority_not_overridden", "There is no priority override to reset."
                )
            before = self._incident_tx(conn, incident_id)
            now = iso(utc_now())
            conn.execute(
                "UPDATE incidents SET override_priority=NULL,override_reason=NULL,"
                "version=version+1,"
                "updated_at=? WHERE id=?",
                (now, incident_id),
            )
            self._sync_priority_override_review_tx(conn, incident_id)
            after = self._incident_tx(conn, incident_id)
            self._audit_tx(
                conn,
                row["event_id"],
                actor,
                "incident.priority_reset",
                incident_id,
                reason,
                before,
                after,
            )
            return row["event_id"]

    def undo_decision(
        self,
        audit_id: str,
        reason: str,
        expected_version: int,
        actor: str = "coordinator",
    ) -> str:
        with self.transaction() as conn:
            action_row = conn.execute(
                "SELECT * FROM audit_events WHERE id=?", (audit_id,)
            ).fetchone()
            if action_row is None:
                raise StorageError(404, "not_found", "Audit action was not found.")
            if action_row["action"] not in {
                "incident.priority_overridden",
                "incident.priority_reset",
                "incident.status_changed",
            }:
                raise StorageError(409, "undo_unavailable", "This action cannot be undone.")
            latest = conn.execute(
                "SELECT id FROM audit_events WHERE event_id=? AND entity_id=? "
                "ORDER BY seq DESC LIMIT 1",
                (action_row["event_id"], action_row["entity_id"]),
            ).fetchone()
            if latest is None or latest["id"] != audit_id:
                raise StorageError(
                    409, "undo_unavailable", "This action is no longer the latest change."
                )
            row = conn.execute(
                "SELECT * FROM incidents WHERE id=? AND event_id=?",
                (action_row["entity_id"], action_row["event_id"]),
            ).fetchone()
            if row is None:
                raise StorageError(409, "undo_unavailable", "The incident no longer exists.")
            self._check_version(row, expected_version)
            before_action = _unjson(action_row["before_json"], None)
            after_action = _unjson(action_row["after_json"], None)
            if (
                not isinstance(before_action, dict)
                or not isinstance(after_action, dict)
                or after_action.get("version") != int(row["version"])
            ):
                raise StorageError(
                    409, "undo_unavailable", "The incident changed after this action."
                )
            before = self._incident_tx(conn, row["id"])
            now = iso(utc_now())
            if action_row["action"] == "incident.status_changed":
                conn.execute(
                    "UPDATE incidents SET status=?,version=version+1,updated_at=? WHERE id=?",
                    (before_action["status"], now, row["id"]),
                )
            else:
                previous_reason = before_action.get("override_reason")
                previous_priority = (
                    before_action.get("priority") if previous_reason is not None else None
                )
                conn.execute(
                    "UPDATE incidents SET override_priority=?,override_reason=?,version=version+1,"
                    "updated_at=? WHERE id=?",
                    (previous_priority, previous_reason, now, row["id"]),
                )
                self._sync_priority_override_review_tx(conn, row["id"])
            after = self._incident_tx(conn, row["id"])
            self._audit_tx(
                conn,
                row["event_id"],
                actor,
                "incident.action_undone",
                row["id"],
                reason,
                before,
                {"incident": after, "undo_of_audit_id": audit_id},
            )
            return row["event_id"]

    def update_priority(
        self,
        incident_id: str,
        priority: str,
        reason: str,
        expected_version: int,
        actor: str = "coordinator",
    ) -> None:
        with self.transaction() as conn:
            row = conn.execute("SELECT * FROM incidents WHERE id=?", (incident_id,)).fetchone()
            if row is None:
                raise StorageError(404, "not_found", "Incident was not found.")
            self._check_version(row, expected_version)
            before = self._incident_tx(conn, incident_id)
            now = iso(utc_now())
            conn.execute(
                "UPDATE incidents SET "
                "override_priority=?,override_reason=?,version=version+1,updated_at=? WHERE "
                "id=?",
                (priority, reason, now, incident_id),
            )
            self._sync_priority_override_review_tx(conn, incident_id)
            after = self._incident_tx(conn, incident_id)
            self._audit_tx(
                conn,
                row["event_id"],
                actor,
                "incident.priority_overridden",
                incident_id,
                reason,
                before,
                after,
            )

    def update_status(
        self,
        incident_id: str,
        status: str,
        reason: str,
        expected_version: int,
        actor: str = "coordinator",
    ) -> None:
        with self.transaction() as conn:
            row = conn.execute("SELECT * FROM incidents WHERE id=?", (incident_id,)).fetchone()
            if row is None:
                raise StorageError(404, "not_found", "Incident was not found.")
            self._check_version(row, expected_version)
            before = self._incident_tx(conn, incident_id)
            now = iso(utc_now())
            conn.execute(
                "UPDATE incidents SET status=?,version=version+1,updated_at=? WHERE id=?",
                (status, now, incident_id),
            )
            after = self._incident_tx(conn, incident_id)
            self._audit_tx(
                conn,
                row["event_id"],
                actor,
                "incident.status_changed",
                incident_id,
                reason,
                before,
                after,
            )

    @staticmethod
    def _check_version(row: sqlite3.Row, expected_version: int) -> None:
        if int(row["version"]) != expected_version:
            raise StorageError(
                409,
                "stale_version",
                "This item changed since you opened it. Refresh and retry.",
                {"expected_version": expected_version, "current_version": int(row["version"])},
            )

    def review_conflict(
        self,
        conflict_id: str,
        status: str,
        reason: str,
        expected_version: int,
        actor: str = "coordinator",
    ) -> str:
        with self.transaction() as conn:
            conflict = conn.execute("SELECT * FROM conflicts WHERE id=?", (conflict_id,)).fetchone()
            if conflict is None:
                raise StorageError(404, "not_found", "Conflict was not found.")
            incident = conn.execute(
                "SELECT * FROM incidents WHERE id=?", (conflict["incident_id"],)
            ).fetchone()
            if incident is None:
                raise StorageError(404, "not_found", "Conflict incident was not found.")
            self._check_version(incident, expected_version)
            before = {
                "status": conflict["status"],
                "reason": conflict["reason"],
                "incident_version": int(incident["version"]),
            }
            now = iso(utc_now())
            conn.execute(
                "UPDATE conflicts SET status=?,reason=?,updated_at=? WHERE id=?",
                (status, reason, now, conflict_id),
            )
            unresolved = conn.execute(
                "SELECT count(*) AS n FROM conflicts WHERE incident_id=? AND status='unresolved'",
                (conflict["incident_id"],),
            ).fetchone()["n"]
            review_reasons = _unjson(incident["review_reasons_json"], [])
            if status == "resolved" and not unresolved:
                review_reasons = [
                    r for r in review_reasons if r != "Conflicting or changing reports need review"
                ]
            elif (
                status == "unresolved"
                and "Conflicting or changing reports need review" not in review_reasons
            ):
                review_reasons.append("Conflicting or changing reports need review")
            conn.execute(
                "UPDATE incidents SET "
                "review_reasons_json=?,review_required=?,version=version+1,updated_at=? WHERE "
                "id=?",
                (
                    _json(review_reasons),
                    int(bool(review_reasons) or bool(unresolved)),
                    now,
                    conflict["incident_id"],
                ),
            )
            after = {
                "status": status,
                "reason": reason,
                "incident_version": int(incident["version"]) + 1,
            }
            self._audit_tx(
                conn,
                incident["event_id"],
                actor,
                "conflict.reviewed",
                conflict_id,
                reason,
                before,
                after,
            )
            return incident["event_id"]

    def apply_grouping_review(
        self,
        request: dict[str, Any],
        engine: Any,
        actor: str = "coordinator",
    ) -> tuple[str, str | None]:
        """Apply a human grouping decision, recompute summaries, and audit atomically."""
        action = request["action"]
        report_ids = request["report_ids"]
        reason = request["reason"]
        target_id = request.get("target_incident_id")
        requested_incident_ids = request.get("incident_ids", [])
        expected_versions = request["expected_versions"]
        with self.transaction() as conn:
            if action == "merge":
                if len(requested_incident_ids) < 2:
                    raise StorageError(
                        422, "invalid_action", "Merge requires at least two incident IDs."
                    )
                if target_id is None:
                    target_id = requested_incident_ids[0]
                if target_id not in requested_incident_ids:
                    raise StorageError(
                        422, "invalid_action", "Merge target must be one of the selected incidents."
                    )
                incident_events = {
                    row["event_id"]
                    for incident_id in requested_incident_ids
                    if (
                        row := conn.execute(
                            "SELECT event_id FROM incidents WHERE id=?", (incident_id,)
                        ).fetchone()
                    )
                }
                if len(incident_events) != 1:
                    raise StorageError(422, "invalid_action", "Incidents must belong to one event.")
                event_id = next(iter(incident_events))
                report_rows = self._selected_reports_tx(conn, report_ids) if report_ids else []
                if any(row["event_id"] != event_id for row in report_rows):
                    raise StorageError(
                        422, "invalid_action", "Reports and incidents must belong to one event."
                    )
                current_memberships = {
                    row["report_id"]: row["incident_id"]
                    for row in conn.execute(
                        "SELECT report_id,incident_id FROM memberships WHERE incident_id IN "
                        f"({','.join('?' for _ in requested_incident_ids)})",
                        requested_incident_ids,
                    ).fetchall()
                }
                source_ids = set(requested_incident_ids)
                affected = set(requested_incident_ids)
            else:
                report_rows = self._selected_reports_tx(conn, report_ids)
                event_ids = {row["event_id"] for row in report_rows}
                if len(event_ids) != 1:
                    raise StorageError(422, "invalid_action", "Reports must belong to one event.")
                event_id = next(iter(event_ids))
                current_memberships = {
                    row["report_id"]: row["incident_id"]
                    for row in conn.execute(
                        "SELECT report_id,incident_id FROM memberships WHERE report_id IN "
                        f"({','.join('?' for _ in report_ids)})",
                        report_ids,
                    ).fetchall()
                }
                source_ids = set(current_memberships.values())
                affected = set(source_ids)
                if target_id:
                    affected.add(target_id)
                if action == "split" and requested_incident_ids:
                    affected.update(requested_incident_ids)
            audit_membership_ids = set(current_memberships)
            confirmed_before = self._membership_confirmed_tx(conn, audit_membership_ids)
            self._validate_incidents_tx(conn, affected, event_id)
            if action == "reject" and target_id is None:
                raise StorageError(422, "invalid_action", "reject requires target_incident_id.")
            if action == "reject" and target_id not in source_ids:
                candidate_count = conn.execute(
                    "SELECT count(*) AS n FROM memberships WHERE incident_id=?", (target_id,)
                ).fetchone()["n"]
                if candidate_count == 0:
                    raise StorageError(
                        422,
                        "invalid_action",
                        "An empty incident cannot be rejected as a candidate.",
                    )
            supplied_ids = set(expected_versions)
            if supplied_ids != affected:
                raise StorageError(
                    422,
                    "invalid_versions",
                    "expected_versions must include exactly the affected incidents.",
                    {"required_incident_ids": sorted(affected)},
                )
            before_rows: dict[str, dict[str, Any]] = {}
            for incident_id in sorted(affected):
                incident_row = conn.execute(
                    "SELECT * FROM incidents WHERE id=?", (incident_id,)
                ).fetchone()
                self._check_version(incident_row, expected_versions[incident_id])
                before_rows[incident_id] = self._incident_tx(conn, incident_id)
            before_rejections = self._rejections_for_incidents_tx(conn, event_id, affected)

            if action in {"confirm", "move"}:
                if target_id is None:
                    raise StorageError(
                        422, "invalid_action", f"{action} requires target_incident_id."
                    )
                confirmed_rows = {
                    row["report_id"]: bool(row["confirmed"])
                    for row in conn.execute(
                        "SELECT report_id,confirmed FROM memberships WHERE report_id IN "
                        f"({','.join('?' for _ in report_ids)})",
                        report_ids,
                    ).fetchall()
                }
                all_already_done = all(
                    current_memberships[report_id] == target_id for report_id in report_ids
                )
                if action == "confirm":
                    all_already_done = all_already_done and all(confirmed_rows.values())
                if all_already_done:
                    raise StorageError(
                        422, "invalid_action", "This grouping action would not change the state."
                    )
            if action == "split":
                if len(source_ids) != 1:
                    raise StorageError(
                        422, "invalid_action", "Split reports must come from one incident."
                    )
                source_id = next(iter(source_ids))
                selected_count = conn.execute(
                    "SELECT count(*) AS n FROM memberships WHERE incident_id=? AND report_id IN ("
                    + ",".join("?" for _ in report_ids)
                    + ")",
                    [source_id, *report_ids],
                ).fetchone()["n"]
                source_count = conn.execute(
                    "SELECT count(*) AS n FROM memberships WHERE incident_id=?", (source_id,)
                ).fetchone()["n"]
                if selected_count == source_count:
                    raise StorageError(
                        422,
                        "invalid_action",
                        "Splitting the entire incident would not change the grouping.",
                    )
            if action == "merge":
                for incident_id in requested_incident_ids:
                    member_count = conn.execute(
                        "SELECT count(*) AS n FROM memberships WHERE incident_id=?", (incident_id,)
                    ).fetchone()["n"]
                    if member_count == 0:
                        raise StorageError(
                            422, "invalid_action", "Empty incidents cannot be merged."
                        )
            if action == "reject" and target_id not in source_ids:
                already_rejected = conn.execute(
                    "SELECT count(*) AS n FROM rejections WHERE event_id=? AND incident_id=? "
                    "AND report_id IN (" + ",".join("?" for _ in report_ids) + ")",
                    [event_id, target_id, *report_ids],
                ).fetchone()["n"]
                if already_rejected == len(report_ids):
                    raise StorageError(
                        422, "invalid_action", "This rejection was already recorded."
                    )

            provisional_reason = (
                "Provisional grouping only; coordinator confirmation remains required."
            )
            reviews_to_clear = (
                audit_membership_ids if action in {"confirm", "merge"} else set(report_ids)
            )
            for report_id in reviews_to_clear:
                report_row = conn.execute(
                    "SELECT review_reasons_json FROM reports WHERE id=?", (report_id,)
                ).fetchone()
                reasons = _unjson(report_row["review_reasons_json"], [])
                cleared = [item for item in reasons if item != provisional_reason]
                if cleared != reasons:
                    conn.execute(
                        "UPDATE reports SET review_reasons_json=? WHERE id=?",
                        (_json(cleared), report_id),
                    )

            new_incident_id: str | None = None
            if action in {"confirm", "move"}:
                self._move_reports_tx(conn, report_ids, target_id, actor, confirmed=True)
                conn.execute(
                    "DELETE FROM rejections WHERE event_id=? AND incident_id=? AND report_id IN ("
                    + ",".join("?" for _ in report_ids)
                    + ")",
                    [event_id, target_id, *report_ids],
                )
            elif action == "reject":
                if target_id in source_ids:
                    if len(source_ids) != 1:
                        raise StorageError(
                            422, "invalid_action", "Rejected members must come from one incident."
                        )
                    new_incident_id = self._create_review_incident_tx(conn, event_id, report_rows)
                    self._move_reports_tx(conn, report_ids, new_incident_id, actor, confirmed=False)
                for report_id in report_ids:
                    conn.execute(
                        "INSERT INTO "
                        "rejections(event_id,report_id,incident_id,actor,reason,created_at) "
                        "VALUES(?,?,?,?,?,?) ON CONFLICT(event_id,report_id,incident_id) DO "
                        "UPDATE SET "
                        "actor=excluded.actor,reason=excluded.reason,created_at=excluded.created_at",
                        (event_id, report_id, target_id, actor, reason, iso(utc_now())),
                    )
            elif action == "merge":
                new_incident_id = target_id
                merge_report_ids = [
                    row["report_id"]
                    for row in conn.execute(
                        "SELECT m.report_id FROM memberships m WHERE m.incident_id IN "
                        f"({','.join('?' for _ in requested_incident_ids)})",
                        requested_incident_ids,
                    ).fetchall()
                ]
                self._move_reports_tx(conn, merge_report_ids, target_id, actor, confirmed=True)
                conn.execute(
                    "DELETE FROM rejections WHERE event_id=? AND incident_id=? AND report_id IN ("
                    + ",".join("?" for _ in merge_report_ids)
                    + ")",
                    [event_id, target_id, *merge_report_ids],
                )
                for incident_id in requested_incident_ids:
                    if incident_id != target_id:
                        conn.execute(
                            "UPDATE incident_notes SET incident_id=? WHERE incident_id=?",
                            (target_id, incident_id),
                        )
                        conn.execute("DELETE FROM incidents WHERE id=?", (incident_id,))
            else:  # split
                if requested_incident_ids and target_id and target_id not in requested_incident_ids:
                    raise StorageError(
                        422, "invalid_action", "Split target must match the source incident."
                    )
                if target_id is not None and target_id not in source_ids:
                    raise StorageError(
                        422, "invalid_action", "Split target must be the source incident."
                    )
                new_incident_id = self._create_review_incident_tx(conn, event_id, report_rows)
                self._move_reports_tx(conn, report_ids, new_incident_id, actor, confirmed=True)

            if action in {"split", "reject"} and new_incident_id:
                for source_id in source_ids:
                    # Constraints against the original group also apply to its new part.
                    conn.execute(
                        "INSERT OR IGNORE INTO rejections "
                        "SELECT event_id,report_id,?,actor,reason,created_at FROM rejections "
                        "WHERE event_id=? AND incident_id=? AND report_id NOT IN "
                        "(SELECT report_id FROM memberships WHERE incident_id=?)",
                        (new_incident_id, event_id, source_id, new_incident_id),
                    )
                    remaining = self._reports_for_incident_tx(conn, source_id)
                    pairs = [(item["id"], new_incident_id) for item in remaining]
                    pairs.extend((report_id, source_id) for report_id in report_ids)
                    conn.executemany(
                        "INSERT OR IGNORE INTO rejections "
                        "(event_id,report_id,incident_id,actor,reason,created_at) "
                        "VALUES(?,?,?,?,?,?)",
                        [
                            (event_id, report_id, incident_id, actor, reason, iso(utc_now()))
                            for report_id, incident_id in pairs
                        ],
                    )

            empty_sources = [
                incident_id
                for incident_id in source_ids
                if conn.execute(
                    "SELECT count(*) AS n FROM memberships WHERE incident_id=?", (incident_id,)
                ).fetchone()["n"]
                == 0
            ]
            for incident_id in empty_sources:
                if (action in {"confirm", "move"} and target_id and incident_id != target_id) or (
                    action == "merge" and incident_id != target_id
                ):
                    self._migrate_rejections_tx(conn, event_id, incident_id, target_id)
                    conn.execute(
                        "UPDATE incident_notes SET incident_id=? WHERE incident_id=?",
                        (target_id, incident_id),
                    )
                else:
                    if new_incident_id is None:
                        raise StorageError(
                            409,
                            "replacement_required",
                            "An emptied incident needs a replacement before it can be removed.",
                        )
                    conn.execute(
                        "UPDATE incident_notes SET incident_id=? WHERE incident_id=?",
                        (new_incident_id, incident_id),
                    )
                conn.execute("DELETE FROM incidents WHERE id=?", (incident_id,))

            if action in {"confirm", "move", "merge"}:
                # Explicitly approved membership supersedes constraints within that group,
                # including constraints just migrated from a removed source incident.
                conn.execute(
                    "DELETE FROM rejections WHERE event_id=? AND incident_id=? "
                    "AND report_id IN (SELECT report_id FROM memberships WHERE incident_id=?)",
                    (event_id, target_id, target_id),
                )

            affected_after = set(affected)
            if new_incident_id and new_incident_id not in affected_after:
                affected_after.add(new_incident_id)
            live_ids: list[str] = []
            for incident_id in affected_after:
                exists = conn.execute(
                    "SELECT id FROM incidents WHERE id=?", (incident_id,)
                ).fetchone()
                if exists is None:
                    continue
                reports = self._reports_for_incident_tx(conn, incident_id)
                assessment = engine.assess_priority(reports)
                generated_conflicts = engine.detect_conflicts(reports)
                self._rebuild_incident_tx(
                    conn,
                    incident_id,
                    assessment,
                    generated_conflicts,
                    increment=True,
                    reconcile_conflicts=True,
                    conflict_resolution_reason=reason,
                )
                live_ids.append(incident_id)
            conn.execute(
                "INSERT INTO "
                "review_decisions(id,event_id,action,report_ids_json,incident_ids_json,"
                "target_incident_id,reason,actor,created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    str(uuid.uuid4()),
                    event_id,
                    action,
                    _json(report_ids),
                    _json(sorted(affected)),
                    new_incident_id or target_id,
                    reason,
                    actor,
                    iso(utc_now()),
                ),
            )
            after_rows = {
                incident_id: self._incident_tx(conn, incident_id) for incident_id in live_ids
            }
            after_rejections = self._rejections_for_incidents_tx(conn, event_id, affected_after)
            confirmed_after = self._membership_confirmed_tx(conn, audit_membership_ids)
            self._audit_tx(
                conn,
                event_id,
                actor,
                f"grouping.{action}",
                new_incident_id or target_id or report_ids[0],
                reason,
                {
                    "incidents": before_rows,
                    "memberships": current_memberships,
                    "membership_confirmed": confirmed_before,
                    "rejections": before_rejections,
                },
                {
                    "incidents": after_rows,
                    "memberships": {
                        report_id: self._membership_incident_tx(conn, report_id)
                        for report_id in audit_membership_ids
                    },
                    "membership_confirmed": confirmed_after,
                    "rejections": after_rejections,
                },
            )
            return event_id, new_incident_id or target_id

    def _selected_reports_tx(
        self, conn: sqlite3.Connection, report_ids: list[str]
    ) -> list[dict[str, Any]]:
        result = []
        for report_id in report_ids:
            try:
                result.append(self._report_tx(conn, report_id))
            except StorageError as exc:
                if exc.status_code == 404:
                    raise StorageError(
                        404, "not_found", "One or more reports were not found."
                    ) from exc
                raise
        return result

    def _validate_incidents_tx(
        self, conn: sqlite3.Connection, incident_ids: set[str], event_id: str
    ) -> None:
        for incident_id in incident_ids:
            row = conn.execute(
                "SELECT event_id FROM incidents WHERE id=?", (incident_id,)
            ).fetchone()
            if row is None:
                raise StorageError(404, "not_found", "Incident was not found.")
            if row["event_id"] != event_id:
                raise StorageError(
                    422, "invalid_action", "Incidents must belong to the same event."
                )

    def _move_reports_tx(
        self,
        conn: sqlite3.Connection,
        report_ids: list[str],
        target_id: str,
        actor: str,
        confirmed: bool,
    ) -> None:
        for report_id in report_ids:
            conn.execute(
                "UPDATE memberships SET incident_id=?,confirmed=?,created_by=? WHERE report_id=?",
                (target_id, int(confirmed), actor, report_id),
            )

    def _create_review_incident_tx(
        self, conn: sqlite3.Connection, event_id: str, reports: list[dict[str, Any]]
    ) -> str:
        incident_id = str(uuid.uuid4())
        display_id = self._next_display_id_tx(conn, event_id, "incident")
        now = iso(utc_now())
        first = reports[0]
        conn.execute(
            "INSERT INTO "
            "incidents(id,event_id,title,zone_id,suggested_priority,priority_reason,status,"
            "review_required,review_reasons_json,version,created_at,updated_at,display_id,"
            "original_title,title_override) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                incident_id,
                event_id,
                self._title(first["text"]),
                first.get("zone_id"),
                "UNASSESSED",
                "Coordinator created a group; priority is being reviewed.",
                "open",
                1,
                _json(["Coordinator grouping needs review"]),
                1,
                now,
                now,
                display_id,
                self._title(first["text"]),
                0,
            ),
        )
        return incident_id

    def _membership_incident_tx(self, conn: sqlite3.Connection, report_id: str) -> str:
        row = conn.execute(
            "SELECT incident_id FROM memberships WHERE report_id=?", (report_id,)
        ).fetchone()
        return row["incident_id"]

    def _membership_confirmed_tx(
        self, conn: sqlite3.Connection, report_ids: set[str]
    ) -> dict[str, bool]:
        if not report_ids:
            return {}
        rows = conn.execute(
            "SELECT report_id,confirmed FROM memberships WHERE report_id IN ("
            + ",".join("?" for _ in report_ids)
            + ")",
            sorted(report_ids),
        ).fetchall()
        return {row["report_id"]: bool(row["confirmed"]) for row in rows}

    def _rejections_for_incidents_tx(
        self, conn: sqlite3.Connection, event_id: str, incident_ids: set[str]
    ) -> list[dict[str, Any]]:
        if not incident_ids:
            return []
        rows = conn.execute(
            "SELECT report_id,incident_id,actor,reason,created_at FROM rejections "
            "WHERE event_id=? AND incident_id IN (" + ",".join("?" for _ in incident_ids) + ") "
            "ORDER BY incident_id,report_id",
            [event_id, *sorted(incident_ids)],
        ).fetchall()
        return [dict(row) for row in rows]

    def _migrate_rejections_tx(
        self, conn: sqlite3.Connection, event_id: str, source_id: str, target_id: str
    ) -> None:
        rows = conn.execute(
            "SELECT report_id,actor,reason,created_at FROM rejections WHERE event_id=? AND "
            "incident_id=?",
            (event_id, source_id),
        ).fetchall()
        for row in rows:
            existing = conn.execute(
                "SELECT actor,reason,created_at FROM rejections WHERE event_id=? AND "
                "report_id=? AND incident_id=?",
                (event_id, row["report_id"], target_id),
            ).fetchone()
            if existing is None:
                conn.execute(
                    "INSERT INTO "
                    "rejections(event_id,report_id,incident_id,actor,reason,created_at) "
                    "VALUES(?,?,?,?,?,?)",
                    (
                        event_id,
                        row["report_id"],
                        target_id,
                        row["actor"],
                        row["reason"],
                        row["created_at"],
                    ),
                )
            else:
                reasons = list(dict.fromkeys([existing["reason"], row["reason"]]))
                conn.execute(
                    "UPDATE rejections SET reason=? WHERE event_id=? AND report_id=? AND "
                    "incident_id=?",
                    (" | ".join(reasons), event_id, row["report_id"], target_id),
                )
        conn.execute(
            "DELETE FROM rejections WHERE event_id=? AND incident_id=?", (event_id, source_id)
        )

    def create_demo_session(self, scenario: str, total: int) -> dict[str, Any]:
        with self.transaction() as conn:
            event = self._create_event_tx(
                conn, f"Aegis Synthetic Exercise — {scenario}", "UTC", True, "priority-v1", "system"
            )
            session = {
                "session_id": str(uuid.uuid4()),
                "event_id": event["id"],
                "cursor": 0,
                "total": total,
                "scenario": scenario,
            }
            conn.execute(
                "INSERT INTO demo_sessions(id,event_id,scenario,cursor,total,created_at) "
                "VALUES(?,?,?,?,?,?)",
                (session["session_id"], session["event_id"], scenario, 0, total, iso(utc_now())),
            )
            self._audit_tx(
                conn,
                event["id"],
                "coordinator",
                "demo.session_started",
                session["session_id"],
                None,
                None,
                session,
            )
            return session

    def get_demo_session(self, session_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.connection.execute(
                "SELECT * FROM demo_sessions WHERE id=?", (session_id,)
            ).fetchone()
            if row is None:
                return None
            return {
                "session_id": row["id"],
                "event_id": row["event_id"],
                "cursor": row["cursor"],
                "total": row["total"],
                "scenario": row["scenario"],
            }

    def get_demo_session_for_event(self, event_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.connection.execute(
                "SELECT * FROM demo_sessions WHERE event_id=?", (event_id,)
            ).fetchone()
            if row is None:
                return None
            return {
                "session_id": row["id"],
                "event_id": row["event_id"],
                "cursor": row["cursor"],
                "total": row["total"],
                "scenario": row["scenario"],
            }

    def advance_demo_cursor(self, session_id: str, expected_cursor: int) -> dict[str, Any]:
        with self.transaction() as conn:
            row = conn.execute("SELECT * FROM demo_sessions WHERE id=?", (session_id,)).fetchone()
            if row is None:
                raise StorageError(404, "not_found", "Demo session was not found.")
            if int(row["cursor"]) != expected_cursor:
                raise StorageError(409, "stale_session", "The replay advanced. Refresh and retry.")
            if expected_cursor >= int(row["total"]):
                return {
                    "session_id": row["id"],
                    "event_id": row["event_id"],
                    "cursor": row["cursor"],
                    "total": row["total"],
                    "scenario": row["scenario"],
                }
            conn.execute("UPDATE demo_sessions SET cursor=cursor+1 WHERE id=?", (session_id,))
            updated = conn.execute(
                "SELECT * FROM demo_sessions WHERE id=?", (session_id,)
            ).fetchone()
            return {
                "session_id": updated["id"],
                "event_id": updated["event_id"],
                "cursor": updated["cursor"],
                "total": updated["total"],
                "scenario": updated["scenario"],
            }
