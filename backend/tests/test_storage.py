from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from backend.aegis.storage import SQLiteStore, StorageError, iso, utc_now


class ReviewEngine:
    def __init__(self, fail: bool = False) -> None:
        self.fail = fail

    def assess_priority(self, reports: list[dict[str, Any]]) -> dict[str, Any]:
        if self.fail:
            raise RuntimeError("review engine failed")
        if any("urgent" in report["text"].casefold() for report in reports):
            priority = "P0"
        else:
            priority = "P2"
        return {"priority": priority, "reason": "Reviewed evidence.", "review_reasons": []}

    def detect_conflicts(self, reports: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if self.fail:
            raise RuntimeError("conflict engine failed")
        claims = [claim for report in reports for claim in report.get("claims", [])]
        if len(claims) < 2 or claims[0]["value"] == claims[1]["value"]:
            return []
        return [
            {
                "field": claims[0]["field"],
                "report_ids": [reports[0]["id"], reports[-1]["id"]],
                "values": [claims[0]["value"], claims[1]["value"]],
                "spans": [claims[0]["span"], claims[1]["span"]],
                "reason": "Opposing source statements.",
            }
        ]


def analysis(
    *,
    category: str = "other",
    claims: list[dict[str, str]] | None = None,
    reasons: list[str] | None = None,
    embedding: list[float] | None = None,
) -> dict[str, Any]:
    return {
        "category": category,
        "claims": claims or [],
        "review_reasons": reasons or [],
        "embedding": embedding,
        "model_revision": "test-model",
    }


def assessment(priority: str = "P2", reasons: list[str] | None = None) -> dict[str, Any]:
    return {
        "priority": priority,
        "reason": f"Policy says {priority}.",
        "review_reasons": reasons or [],
    }


def complete_report(
    store: SQLiteStore,
    text: str,
    key: str,
    *,
    event_id: str | None = None,
    zone_id: str | None = "stage",
    claims: list[dict[str, str]] | None = None,
    target: str | None = None,
    evidence: list[dict[str, Any]] | None = None,
    priority: str = "P2",
) -> tuple[dict[str, Any], dict[str, Any]]:
    event = store.get_event(event_id) if event_id else store.current_event()
    assert event is not None
    report, _receipt_incident, duplicate = store.create_report_receipt(
        event_id=event["id"],
        text=text,
        zone_id=zone_id,
        sublocation=None,
        reported_at=datetime(2026, 10, 24, 12, 0, tzinfo=UTC),
        idempotency_key=key,
    )
    assert not duplicate
    report, incident = store.finalize_analysis(
        report["id"],
        analysis(
            claims=claims,
            reasons=["Provisional grouping only; coordinator confirmation remains required."],
        ),
        target,
        evidence or [],
        assessment(priority),
        [],
    )
    return report, incident


def review_request(
    action: str,
    report_ids: list[str],
    expected_versions: dict[str, int],
    *,
    target: str | None = None,
    incident_ids: list[str] | None = None,
    reason: str = "Coordinator reviewed evidence.",
) -> dict[str, Any]:
    return {
        "action": action,
        "report_ids": report_ids,
        "incident_ids": incident_ids or [],
        "target_incident_id": target,
        "reason": reason,
        "expected_versions": expected_versions,
    }


def expected(incident: dict[str, Any]) -> dict[str, int]:
    return {incident["id"]: incident["version"]}


def test_utc_serialization_initial_event_reopen_and_audit(tmp_path: Path) -> None:
    assert iso(None) is None
    assert iso("2026-10-24T00:00:00+00:00") == "2026-10-24T00:00:00+00:00"
    assert iso(datetime(2026, 10, 24, 1, 0)).endswith("+00:00")
    before = utc_now()
    assert before.tzinfo == UTC
    path = tmp_path / "nested" / "state.sqlite3"
    store = SQLiteStore(path)
    initial = store.current_event()
    assert initial is not None and initial["exercise"] is True
    secondary = store.create_event("Private exercise", "Etc/UTC", False, "priority-v2")
    assert store.current_event() == secondary
    audit = store.audit_for_event(secondary["id"])
    assert audit[0]["action"] == "event.created"
    assert audit[0]["before"] is None and audit[0]["after"]["name"] == "Private exercise"
    store.close()
    reopened = SQLiteStore(path)
    assert reopened.current_event()["id"] == secondary["id"]
    assert reopened.get_event(initial["id"])["exercise"] is True
    reopened.close()


def test_sql_migration_executor_skips_empty_statements_and_rejects_incomplete_sql(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = sqlite3.connect(":memory:")
    monkeypatch.setattr("backend.aegis.storage.sqlite3.complete_statement", lambda _sql: True)
    SQLiteStore._execute_script_tx(connection, "  \n")
    monkeypatch.setattr("backend.aegis.storage.sqlite3.complete_statement", lambda _sql: False)
    with pytest.raises(sqlite3.OperationalError, match="incomplete SQL"):
        SQLiteStore._execute_script_tx(connection, "SELECT 1;")
    connection.close()


def test_pending_report_bounds_and_retry_guard_paths() -> None:
    store = SQLiteStore(":memory:")
    for invalid_limit in (0, -1, True, 1.5, "2"):
        with pytest.raises(ValueError, match="positive integer"):
            store.pending_reports(invalid_limit)  # type: ignore[arg-type]

    report, incident, _ = store.create_report_receipt(
        event_id=store.current_event()["id"],
        text="Pending retry target",
        zone_id=None,
        sublocation=None,
        reported_at=None,
        idempotency_key="pending-retry-guard",
    )
    assert [row["id"] for row in store.pending_reports(1)] == [report["id"]]
    retried, retry_incident = store.prepare_report_retry(report["id"], incident["version"])
    assert retried["analysis_status"] == "pending"
    assert retry_incident["id"] == incident["id"]
    assert store.audit_for_event(incident["event_id"])[-1]["action"] == (
        "report.analysis_retry_started"
    )

    complete, complete_incident = complete_report(
        store, "Completed report", "completed-retry-guard"
    )
    with pytest.raises(StorageError) as completed:
        store.prepare_report_retry(complete["id"], complete_incident["version"])
    assert completed.value.code == "analysis_not_retryable"

    orphan, orphan_incident, _ = store.create_report_receipt(
        event_id=incident["event_id"],
        text="Receipt with a missing incident",
        zone_id=None,
        sublocation=None,
        reported_at=None,
        idempotency_key="retry-missing-incident",
    )
    store.connection.execute("PRAGMA foreign_keys=OFF")
    store.connection.execute("DELETE FROM incidents WHERE id=?", (orphan_incident["id"],))
    store.connection.execute("PRAGMA foreign_keys=ON")
    with pytest.raises(StorageError) as missing_incident:
        store.prepare_report_retry(orphan["id"], orphan_incident["version"])
    assert missing_incident.value.status_code == 404
    store.close()


def test_memory_storage_receipt_idempotency_and_event_errors() -> None:
    store = SQLiteStore(":memory:")
    event = store.current_event()
    first, incident, duplicate = store.create_report_receipt(
        event_id=event["id"],
        text="raw  source\n",
        zone_id=None,
        sublocation=None,
        reported_at=None,
        idempotency_key="key",
        source="form",
    )
    assert duplicate is False
    assert first["text"] == "raw  source\n"
    assert first["analysis_status"] == "pending" and first["embedding"] is None
    assert incident["review_required"] is True
    again, same_incident, duplicate = store.create_report_receipt(
        event_id=event["id"],
        text="raw  source\n",
        zone_id=None,
        sublocation=None,
        reported_at=None,
        idempotency_key="key",
        source="form",
    )
    assert duplicate is True and again["id"] == first["id"]
    assert same_incident["id"] == incident["id"]
    with pytest.raises(StorageError, match="idempotency"):
        store.create_report_receipt(
            event_id=event["id"],
            text="changed",
            zone_id=None,
            sublocation=None,
            reported_at=None,
            idempotency_key="key",
            source="form",
        )
    with pytest.raises(StorageError) as missing_event:
        store.create_report_receipt(
            event_id="absent",
            text="x",
            zone_id=None,
            sublocation=None,
            reported_at=None,
            idempotency_key="x",
        )
    assert missing_event.value.status_code == 404
    assert store.get_report("absent") is None
    assert len(store.reports_for_event(event["id"])) == 1
    assert len(store.get_groups_for_event(event["id"])) == 1
    assert store.rejection_pairs(event["id"]) == set()
    with pytest.raises(StorageError):
        store.snapshot_data("absent")
    store.close()


def test_resolved_incidents_are_not_candidates_but_remain_in_snapshot() -> None:
    store = SQLiteStore(":memory:")
    report, incident = complete_report(store, "A resolved source report", "resolved-source")
    event_id = report["event_id"]
    assert [group["id"] for group in store.get_groups_for_event(event_id)] == [incident["id"]]

    store.update_status(
        incident["id"], "resolved", "Coordinator closed this incident.", incident["version"]
    )

    assert store.get_groups_for_event(event_id) == []
    with store.transaction() as conn:
        assert store._groups_for_event_tx(conn, event_id, "pending-report") == []
    snapshot = store.snapshot_data(event_id)
    assert len(snapshot["incidents"]) == 1
    assert snapshot["incidents"][0]["id"] == incident["id"]
    assert snapshot["incidents"][0]["status"] == "resolved"
    store.close()


def test_internal_report_conversion_and_non_not_found_errors_are_not_suppressed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = SQLiteStore(":memory:")
    report, incident = complete_report(store, "internal conversion", "internal")
    with store._lock:
        row = store.connection.execute(
            "SELECT r.*,m.incident_id,m.confirmed,a.model_revision,a.embedding_json,a.claims_json "
            "FROM reports r JOIN memberships m ON m.report_id=r.id "
            "JOIN report_analysis a ON a.report_id=r.id WHERE r.id=?",
            (report["id"],),
        ).fetchone()
    assert "embedding" not in store._report_dict(row, include_embedding=False)
    monkeypatch.setattr(
        store,
        "_report_tx",
        lambda *_: (_ for _ in ()).throw(
            StorageError(503, "storage_error", "Unexpected report storage failure.")
        ),
    )
    with pytest.raises(StorageError) as report_error:
        store.get_report(report["id"])
    assert report_error.value.status_code == 503
    monkeypatch.setattr(
        store,
        "_incident_tx",
        lambda *_: (_ for _ in ()).throw(
            StorageError(503, "storage_error", "Unexpected incident storage failure.")
        ),
    )
    with pytest.raises(StorageError) as incident_error:
        store.get_incident(incident["id"])
    assert incident_error.value.status_code == 503
    store.close()


def test_selected_report_storage_error_propagates(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = SQLiteStore(":memory:")
    engine = ReviewEngine()
    report, source = complete_report(store, "one member", "source")
    _, candidate = complete_report(store, "candidate member", "candidate")
    original_report_tx = store._report_tx

    def fail_selected_report(conn: Any, report_id: str) -> Any:
        if report_id == report["id"]:
            raise StorageError(503, "storage_error", "Selected report storage failed.")
        return original_report_tx(conn, report_id)

    monkeypatch.setattr(store, "_report_tx", fail_selected_report)
    with pytest.raises(StorageError) as selected_error:
        store.apply_grouping_review(
            review_request(
                "move",
                [report["id"]],
                {source["id"]: source["version"], candidate["id"]: candidate["version"]},
                target=candidate["id"],
            ),
            engine,
        )
    assert selected_error.value.status_code == 503
    monkeypatch.setattr(store, "_report_tx", original_report_tx)
    store.close()


def test_receipt_transaction_rolls_back_on_exception() -> None:
    store = SQLiteStore(":memory:")
    event_id = store.current_event()["id"]
    with pytest.raises(ValueError), store.transaction() as conn:
        conn.execute(
            "INSERT INTO events(id,name,timezone,exercise,policy_version,created_at) VALUES(?,?,?,?,?,?)",
            ("rolled-back", "Rollback", "UTC", 1, "p", iso(utc_now())),
        )
        raise ValueError("cancel transaction")
    assert store.get_event("rolled-back") is None
    assert store.get_event(event_id) is not None
    store.close()


def test_transaction_rolls_back_when_commit_fails() -> None:
    class CommitFailureConnection:
        def __init__(self, connection: sqlite3.Connection) -> None:
            self.connection = connection

        def execute(self, *args: Any, **kwargs: Any) -> sqlite3.Cursor:
            return self.connection.execute(*args, **kwargs)

        def commit(self) -> None:
            raise sqlite3.OperationalError("simulated commit failure")

        def rollback(self) -> None:
            self.connection.rollback()

    store = SQLiteStore(":memory:")
    connection = store.connection
    store.connection = CommitFailureConnection(connection)  # type: ignore[assignment]
    try:
        with (
            pytest.raises(sqlite3.OperationalError, match="simulated commit failure"),
            store.transaction() as conn,
        ):
            conn.execute(
                "INSERT INTO events(id,name,timezone,exercise,policy_version,created_at) "
                "VALUES(?,?,?,?,?,?)",
                ("commit-failure", "Commit failure", "UTC", 1, "p", iso(utc_now())),
            )
    finally:
        store.connection = connection
    assert connection.execute("SELECT id FROM events WHERE id='commit-failure'").fetchone() is None
    assert not connection.in_transaction
    store.close()


def test_transaction_rolls_back_on_keyboard_interrupt() -> None:
    store = SQLiteStore(":memory:")
    with pytest.raises(KeyboardInterrupt), store.transaction() as conn:
        conn.execute(
            "INSERT INTO events(id,name,timezone,exercise,policy_version,created_at) "
            "VALUES(?,?,?,?,?,?)",
            ("interrupted", "Interrupted", "UTC", 1, "p", iso(utc_now())),
        )
        raise KeyboardInterrupt
    assert store.get_event("interrupted") is None
    assert not store.connection.in_transaction
    store.close()


def test_finalize_analysis_attach_evidence_and_failed_fallback() -> None:
    store = SQLiteStore(":memory:")
    event_id = store.current_event()["id"]
    first_report, first = complete_report(store, "First report", "first")
    evidence = [
        {
            "report_id": "will-be-replaced",
            "candidate_report_id": first_report["id"],
            "semantic_score": 0.8,
            "location_score": 1.0,
            "time_score": 0.9,
            "category_score": 0.7,
            "total_score": 0.84,
            "decision": "attach",
            "reasons": ["same sublocation"],
            "missing_fields": [],
        }
    ]
    # Set the incoming report ID after the receipt exists.
    incoming, singleton, _ = store.create_report_receipt(
        event_id=event_id,
        text="Second urgent report",
        zone_id="stage",
        sublocation="north",
        reported_at=datetime(2026, 10, 24, 12, 1, tzinfo=UTC),
        idempotency_key="second",
    )
    evidence[0]["report_id"] = incoming["id"]
    finalized, combined = store.finalize_analysis(
        incoming["id"],
        analysis(embedding=[0.0, 1.0]),
        first["id"],
        evidence,
        assessment("P0"),
        [],
    )
    assert finalized["analysis_status"] == "complete"
    assert finalized["incident_id"] == first["id"]
    assert combined["priority"] == "P0"
    assert combined["version"] > first["version"]
    assert len(combined["report_ids"]) == 2
    assert combined["evidence"][0]["report_id"] == incoming["id"]
    assert store.get_incident(singleton["id"]) is None
    repeated, unchanged = store.finalize_analysis(
        incoming["id"],
        analysis(),
        None,
        [],
        assessment(),
        [],
    )
    assert repeated["analysis_status"] == "complete" and unchanged["id"] == first["id"]

    failed, failed_singleton, _ = store.create_report_receipt(
        event_id=event_id,
        text="Failed, danger fire",
        zone_id=None,
        sublocation=None,
        reported_at=None,
        idempotency_key="failure",
    )
    failed_report, failed_incident = store.fail_pending_analysis(
        failed["id"],
        "ModelUnavailable",
        {"priority": "P0", "reason": "Danger rule.", "review_reasons": []},
    )
    assert failed_report["analysis_status"] == "failed"
    assert failed_incident["priority"] == "P0"
    assert "Analysis failed; coordinator review required" in failed_incident["review_reasons"]
    default_failed, _, _ = store.create_report_receipt(
        event_id=event_id,
        text="No engine",
        zone_id=None,
        sublocation=None,
        reported_at=None,
        idempotency_key="failure-default",
    )
    _, default_incident = store.fail_pending_analysis(default_failed["id"], "TypeError")
    assert default_incident["priority"] == "UNASSESSED"
    assert failed_singleton["id"] != default_incident["id"]
    store.close()


def test_finalize_invalid_target_and_rebuild_remaining_source_members() -> None:
    store = SQLiteStore(":memory:")
    event_id = store.current_event()["id"]
    keep, _keep_incident = complete_report(store, "Keep source", "keep")
    pending, pending_incident, _ = store.create_report_receipt(
        event_id=event_id,
        text="Pending source member",
        zone_id=None,
        sublocation=None,
        reported_at=None,
        idempotency_key="pending",
    )
    # Place a second report in the pending report's initial singleton so its finalization leaves a source member.
    with store.transaction() as conn:
        conn.execute(
            "UPDATE memberships SET incident_id=? WHERE report_id=?",
            (pending_incident["id"], keep["id"]),
        )
    target_report, target = complete_report(store, "Target group", "target")
    final, target_after = store.finalize_analysis(
        pending["id"],
        analysis(),
        target["id"],
        [],
        assessment(),
        [],
    )
    assert final["incident_id"] == target["id"]
    source_after = store.get_incident(pending_incident["id"])
    assert source_after is not None and source_after["report_ids"] == [keep["id"]]
    assert set(target_after["report_ids"]) == {pending["id"], target_report["id"]}

    unmatched, unmatched_incident, _ = store.create_report_receipt(
        event_id=event_id,
        text="Unmatched target",
        zone_id=None,
        sublocation=None,
        reported_at=None,
        idempotency_key="unmatched",
    )
    finalized, fallback_incident = store.finalize_analysis(
        unmatched["id"],
        analysis(),
        "missing-target",
        [],
        assessment(),
        [],
    )
    assert finalized["incident_id"] == unmatched_incident["id"]
    assert fallback_incident["id"] == unmatched_incident["id"]
    # Cover an unchanged rebuild with no model assessment or conflict pass.
    with store.transaction() as conn:
        store._rebuild_incident_tx(conn, unmatched_incident["id"], None, None, increment=False)
    store.close()


def test_finalize_revalidates_choice_rejection_and_human_membership() -> None:
    class DecisionEngine(ReviewEngine):
        def __init__(self, decision: Any) -> None:
            super().__init__()
            self.decision = decision
            self.choose_calls = 0

        def choose_group(self, *_args: Any) -> Any:
            self.choose_calls += 1
            return self.decision

    store = SQLiteStore(":memory:")
    event_id = store.current_event()["id"]
    anchor_report, anchor = complete_report(store, "Anchor", "anchor")
    pending, pending_incident, _ = store.create_report_receipt(
        event_id=event_id,
        text="Pending report",
        zone_id="stage",
        sublocation=None,
        reported_at=None,
        idempotency_key="pending",
    )
    invalid_engine = DecisionEngine(
        {"incident_id": "missing", "evidence": [], "review_reasons": []}
    )
    finalized, kept = store.finalize_analysis(
        pending["id"],
        analysis(),
        anchor["id"],
        [],
        assessment(),
        [],
        engine=invalid_engine,
        receipt_incident_id=pending_incident["id"],
    )
    assert finalized["incident_id"] == pending_incident["id"]
    assert "candidate changed before analysis completed" in " ".join(kept["review_reasons"])

    rejected_pending, rejected_singleton, _ = store.create_report_receipt(
        event_id=event_id,
        text="Rejected pending",
        zone_id="stage",
        sublocation=None,
        reported_at=None,
        idempotency_key="rejected-pending",
    )
    with store.transaction() as conn:
        conn.execute(
            "INSERT INTO rejections(event_id,report_id,incident_id,actor,reason,created_at) VALUES(?,?,?,?,?,?)",
            (
                event_id,
                rejected_pending["id"],
                anchor["id"],
                "coordinator",
                "No grouping.",
                iso(utc_now()),
            ),
        )
    rejecting_engine = DecisionEngine(
        {"incident_id": anchor["id"], "evidence": [], "review_reasons": []}
    )
    rejected_report, rejected_group = store.finalize_analysis(
        rejected_pending["id"],
        analysis(),
        anchor["id"],
        [],
        assessment(),
        [],
        engine=rejecting_engine,
        receipt_incident_id=rejected_singleton["id"],
    )
    assert rejected_report["incident_id"] == rejected_singleton["id"]
    assert any(
        "coordinator rejection blocks" in reason.casefold()
        for reason in rejected_group["review_reasons"]
    )

    moved, original, _ = store.create_report_receipt(
        event_id=event_id,
        text="Human moved while pending",
        zone_id="stage",
        sublocation=None,
        reported_at=None,
        idempotency_key="human-moved",
    )
    with store.transaction() as conn:
        conn.execute(
            "UPDATE memberships SET incident_id=? WHERE report_id=?", (anchor["id"], moved["id"])
        )
        conn.execute("DELETE FROM incidents WHERE id=?", (original["id"],))
    non_dict_engine = DecisionEngine([])
    human_report, human_incident = store.finalize_analysis(
        moved["id"],
        analysis(),
        None,
        [
            {
                "report_id": moved["id"],
                "candidate_report_id": anchor_report["id"],
                "decision": "attach",
                "reasons": [],
                "missing_fields": [],
            }
        ],
        assessment(),
        [],
        engine=non_dict_engine,
        receipt_incident_id=original["id"],
    )
    assert non_dict_engine.choose_calls == 0
    assert human_report["incident_id"] == anchor["id"]
    assert human_incident["evidence"][0]["decision"] == "suggest"
    assert any(
        "Coordinator changed the incident" in reason for reason in human_incident["review_reasons"]
    )
    store.close()


@pytest.mark.parametrize(
    "decision",
    [
        [],
        {"incident_id": None, "evidence": {}, "review_reasons": []},
    ],
)
def test_finalize_rejects_malformed_matcher_results_without_losing_receipt(decision: Any) -> None:
    class DecisionEngine(ReviewEngine):
        def choose_group(self, *_args: Any) -> Any:
            return decision

    store = SQLiteStore(":memory:")
    event_id = store.current_event()["id"]
    report, incident, _ = store.create_report_receipt(
        event_id=event_id,
        text="Pending malformed",
        zone_id=None,
        sublocation=None,
        reported_at=None,
        idempotency_key="malformed",
    )
    with pytest.raises(TypeError):
        store.finalize_analysis(
            report["id"],
            analysis(),
            None,
            [],
            assessment(),
            [],
            engine=DecisionEngine(),
            receipt_incident_id=incident["id"],
        )
    assert store.get_report(report["id"])["analysis_status"] == "pending"
    store.close()


def test_finalize_recomputes_remaining_and_target_groups_inside_transaction() -> None:
    class DecisionEngine(ReviewEngine):
        def __init__(self, target_id: str) -> None:
            super().__init__()
            self.target_id = target_id

        def choose_group(self, *_args: Any) -> dict[str, Any]:
            return {"incident_id": self.target_id, "evidence": [], "review_reasons": []}

    store = SQLiteStore(":memory:")
    event_id = store.current_event()["id"]
    _anchor, target = complete_report(store, "Anchor urgent", "anchor")
    retained, _ = complete_report(store, "Retained source member", "retained", target=target["id"])
    pending, source, _ = store.create_report_receipt(
        event_id=event_id,
        text="Incoming urgent report",
        zone_id="stage",
        sublocation=None,
        reported_at=None,
        idempotency_key="incoming",
    )
    with store.transaction() as conn:
        conn.execute(
            "UPDATE memberships SET incident_id=? WHERE report_id=?", (source["id"], retained["id"])
        )
    target_before = store.get_incident(target["id"])
    source_before = store.get_incident(source["id"])
    final, target_after = store.finalize_analysis(
        pending["id"],
        analysis(),
        target["id"],
        [],
        assessment(),
        [],
        engine=DecisionEngine(target["id"]),
        receipt_incident_id=source["id"],
    )
    assert final["incident_id"] == target["id"]
    assert target_after["suggested_priority"] == "P0"
    assert target_after["version"] == target_before["version"] + 1
    source_after = store.get_incident(source["id"])
    assert source_after is not None
    assert source_after["report_ids"] == [retained["id"]]
    assert source_after["version"] == source_before["version"] + 1
    store.close()


def test_conflict_upsert_history_and_review_versioning() -> None:
    store = SQLiteStore(":memory:")
    report_a, incident = complete_report(
        store,
        "Blocked source",
        "blocked",
        claims=[{"field": "exit_access", "value": "blocked", "span": "blocked"}],
    )
    report_b, singleton = complete_report(
        store,
        "Clear source",
        "clear",
        claims=[{"field": "exit_access", "value": "clear", "span": "clear"}],
    )
    conflict_data = {
        "field": "exit_access",
        "report_ids": [report_a["id"], report_b["id"]],
        "values": ["blocked", "clear"],
        "spans": ["blocked", "clear"],
    }
    # Attach a report and save a persistent conflict by invoking the rebuild within a transaction.
    with store.transaction() as conn:
        conn.execute(
            "UPDATE memberships SET incident_id=? WHERE report_id=?",
            (incident["id"], report_b["id"]),
        )
        store._rebuild_incident_tx(
            conn,
            incident["id"],
            assessment(),
            [conflict_data],
            increment=True,
        )
    current = store.get_incident(incident["id"])
    conflict = current["conflicts"][0]
    assert conflict["status"] == "unresolved"
    event_id = incident["event_id"]
    version = current["version"]
    assert (
        store.review_conflict(conflict["id"], "resolved", "Coordinator clarified.", version)
        == event_id
    )
    resolved_incident = store.get_incident(incident["id"])
    assert resolved_incident["conflicts"][0]["status"] == "resolved"
    assert "Conflicting or changing reports need review" not in resolved_incident["review_reasons"]
    reopened_event = store.review_conflict(
        conflict["id"], "unresolved", "New account needs review.", resolved_incident["version"]
    )
    assert reopened_event == event_id
    reopened = store.get_incident(incident["id"])
    assert reopened["review_required"] is True
    store.review_conflict(
        conflict["id"], "unresolved", "Repeated review state.", reopened["version"]
    )
    repeated = store.get_incident(incident["id"])
    assert repeated["review_reasons"].count("Conflicting or changing reports need review") == 1
    with pytest.raises(StorageError) as stale:
        store.review_conflict(conflict["id"], "resolved", "Stale call.", version)
    assert stale.value.code == "stale_version"
    with pytest.raises(StorageError):
        store.review_conflict("absent", "resolved", "Missing.", 1)
    # A conflict with an orphaned incident is retained but returns a safe missing-resource error.
    with store.transaction() as conn:
        conn.execute("DELETE FROM memberships WHERE incident_id=?", (incident["id"],))
        conn.execute("DELETE FROM incidents WHERE id=?", (incident["id"],))
    with pytest.raises(StorageError, match="Conflict incident"):
        store.review_conflict(conflict["id"], "resolved", "Missing owner.", 1)
    assert store.get_incident(singleton["id"]) is not None
    store.close()


def test_grouping_conflict_reconcile_without_note_and_empty_helpers() -> None:
    store = SQLiteStore(":memory:")
    report_a, incident = complete_report(
        store,
        "Blocked",
        "blocked",
        claims=[{"field": "exit_access", "value": "blocked", "span": "blocked"}],
    )
    report_b, _ = complete_report(
        store,
        "Clear",
        "clear",
        claims=[{"field": "exit_access", "value": "clear", "span": "clear"}],
        target=incident["id"],
    )
    conflict = {
        "field": "exit_access",
        "report_ids": [report_a["id"], report_b["id"]],
        "values": ["blocked", "clear"],
        "spans": ["blocked", "clear"],
    }
    with store.transaction() as conn:
        store._rebuild_incident_tx(conn, incident["id"], assessment(), [conflict], increment=True)
        store._rebuild_incident_tx(
            conn, incident["id"], assessment(), [], increment=True, reconcile_conflicts=True
        )
        empty_id = store._create_review_incident_tx(conn, incident["event_id"], [report_a])
        conn.execute("DELETE FROM memberships WHERE report_id=?", (report_a["id"],))
        store._rebuild_incident_tx(conn, empty_id, assessment(), [], increment=True)
        assert store._rejections_for_incidents_tx(conn, incident["event_id"], set()) == []
    current = store.get_incident(incident["id"])
    assert current["conflicts"][0]["status"] == "resolved"
    assert current["conflicts"][0]["reason"] == "Coordinator changed report grouping."
    store.close()


def test_status_priority_and_conflict_reasons_are_audited() -> None:
    store = SQLiteStore(":memory:")
    _, incident = complete_report(store, "Base", "one")
    version = incident["version"]
    store.update_priority(incident["id"], "P0", "Higher attention.", version)
    overridden = store.get_incident(incident["id"])
    assert overridden["priority"] == "P0" and overridden["override_reason"] == "Higher attention."
    with pytest.raises(StorageError) as stale:
        store.update_priority(incident["id"], "P2", "Outdated.", version)
    assert stale.value.code == "stale_version"
    store.update_status(
        incident["id"], "monitoring", "Coordinator monitoring.", overridden["version"]
    )
    monitored = store.get_incident(incident["id"])
    assert monitored["status"] == "monitoring"
    with pytest.raises(StorageError):
        store.update_status("absent", "resolved", "Missing.", 1)
    with pytest.raises(StorageError):
        store.update_priority("absent", "P1", "Missing.", 1)
    actions = [entry["action"] for entry in store.audit_for_event(incident["event_id"])]
    assert "incident.priority_overridden" in actions and "incident.status_changed" in actions
    store.close()


def test_grouping_review_all_actions_constraints_and_audit() -> None:
    store = SQLiteStore(":memory:")
    engine = ReviewEngine()
    first_report, first_incident = complete_report(store, "First", "first")
    second_report, second_incident = complete_report(store, "Second", "second")
    _, event_id = store.get_event(first_report["event_id"]), first_report["event_id"]

    event, target = store.apply_grouping_review(
        review_request(
            "confirm",
            [second_report["id"]],
            {
                first_incident["id"]: first_incident["version"],
                second_incident["id"]: second_incident["version"],
            },
            target=first_incident["id"],
        ),
        engine,
    )
    assert event == event_id and target == first_incident["id"]
    confirmed = store.get_incident(first_incident["id"])
    assert len(confirmed["report_ids"]) == 2
    provisional = "Provisional grouping only; coordinator confirmation remains required."
    assert provisional not in store.get_report(second_report["id"])["review_reasons"]
    assert provisional in store.get_report(first_report["id"])["review_reasons"]
    assert provisional in confirmed["review_reasons"]

    # Rejection of an existing membership creates a fresh singleton and persists the negative constraint.
    event, rejected_id = store.apply_grouping_review(
        review_request(
            "reject", [second_report["id"]], expected(confirmed), target=first_incident["id"]
        ),
        engine,
    )
    rejected = store.get_incident(rejected_id)
    assert rejected["report_ids"] == [second_report["id"]]
    assert (second_report["id"], first_incident["id"]) in store.rejection_pairs(event_id)
    with pytest.raises(StorageError, match="already recorded"):
        store.apply_grouping_review(
            review_request(
                "reject",
                [second_report["id"]],
                {
                    rejected_id: rejected["version"],
                    first_incident["id"]: store.get_incident(first_incident["id"])["version"],
                },
                target=first_incident["id"],
            ),
            engine,
        )

    # Move a report into the first incident, then split it back out while retaining audit history.
    _, event = store.apply_grouping_review(
        review_request(
            "move",
            [second_report["id"]],
            {
                rejected_id: rejected["version"],
                first_incident["id"]: store.get_incident(first_incident["id"])["version"],
            },
            target=first_incident["id"],
        ),
        engine,
    )
    combined = store.get_incident(first_incident["id"])
    assert len(combined["report_ids"]) == 2
    _, split_id = store.apply_grouping_review(
        review_request(
            "split", [second_report["id"]], expected(combined), target=first_incident["id"]
        ),
        engine,
    )
    split = store.get_incident(split_id)
    assert split["report_ids"] == [second_report["id"]]
    remaining = store.get_incident(first_incident["id"])
    assert remaining["report_ids"] == [first_report["id"]]

    _, merged_id = store.apply_grouping_review(
        review_request(
            "merge",
            [],
            {first_incident["id"]: remaining["version"], split_id: split["version"]},
            target=first_incident["id"],
            incident_ids=[first_incident["id"], split_id],
        ),
        engine,
    )
    assert merged_id == first_incident["id"]
    merged = store.get_incident(merged_id)
    assert len(merged["report_ids"]) == 2
    assert store.get_incident(split_id) is None
    actions = [entry["action"] for entry in store.audit_for_event(event_id)]
    assert {
        "grouping.confirm",
        "grouping.reject",
        "grouping.move",
        "grouping.split",
        "grouping.merge",
    } <= set(actions)
    store.close()


def test_grouping_review_invalid_stale_noop_cross_event_and_rollback() -> None:
    store = SQLiteStore(":memory:")
    engine = ReviewEngine()
    first_report, first = complete_report(store, "First", "first")
    second_report, second = complete_report(store, "Second", "second")
    with pytest.raises(StorageError) as missing_report:
        store.apply_grouping_review(
            review_request("move", ["absent"], {}, target=first["id"]), engine
        )
    assert missing_report.value.status_code == 404
    with pytest.raises(StorageError, match="exactly"):
        store.apply_grouping_review(
            review_request("move", [second_report["id"]], {}, target=first["id"]), engine
        )
    with pytest.raises(StorageError, match="changed"):
        store.apply_grouping_review(
            review_request(
                "move",
                [second_report["id"]],
                {first["id"]: first["version"], second["id"]: second["version"] - 1},
                target=first["id"],
            ),
            engine,
        )
    # A move to the same incident is a no-op even while the membership is provisional.
    same_move = review_request("move", [first_report["id"]], expected(first), target=first["id"])
    with pytest.raises(StorageError, match="not change"):
        store.apply_grouping_review(same_move, engine)
    # A first confirmation changes state; a repeat confirmation is a no-op.
    store.apply_grouping_review(
        review_request("confirm", [first_report["id"]], expected(first), target=first["id"]), engine
    )
    confirmed = store.get_incident(first["id"])
    with pytest.raises(StorageError, match="not change"):
        store.apply_grouping_review(
            review_request(
                "confirm", [first_report["id"]], expected(confirmed), target=first["id"]
            ),
            engine,
        )
    # Splitting the whole singleton and omitting action targets are rejected.
    second_current = store.get_incident(second["id"])
    with pytest.raises(StorageError, match="entire incident"):
        store.apply_grouping_review(
            review_request(
                "split", [second_report["id"]], expected(second_current), target=second["id"]
            ),
            engine,
        )
    with pytest.raises(StorageError, match="requires target"):
        store.apply_grouping_review(
            review_request("confirm", [first_report["id"]], expected(confirmed)), engine
        )
    with pytest.raises(StorageError, match="requires target"):
        store.apply_grouping_review(
            review_request("reject", [second_report["id"]], expected(second_current)), engine
        )
    with pytest.raises(StorageError, match="at least two"):
        store.apply_grouping_review(
            review_request(
                "merge", [], expected(first), incident_ids=[first["id"]], target=first["id"]
            ),
            engine,
        )
    with pytest.raises(StorageError, match="one of the selected"):
        store.apply_grouping_review(
            review_request(
                "merge",
                [],
                {first["id"]: confirmed["version"], second["id"]: second_current["version"]},
                incident_ids=[first["id"], second["id"]],
                target="elsewhere",
            ),
            engine,
        )
    # A failed deterministic recomputation rolls memberships and audit back atomically.
    before_audit = store.audit_for_event(first["event_id"])
    failing_engine = ReviewEngine(fail=True)
    with pytest.raises(RuntimeError, match="failed"):
        store.apply_grouping_review(
            review_request(
                "move",
                [second_report["id"]],
                {
                    confirmed["id"]: confirmed["version"],
                    second_current["id"]: second_current["version"],
                },
                target=confirmed["id"],
            ),
            failing_engine,
        )
    assert store.get_report(second_report["id"])["incident_id"] == second_current["id"]
    assert store.audit_for_event(first["event_id"]) == before_audit
    store.close()


def test_grouping_review_merge_reject_split_event_and_version_errors() -> None:
    store = SQLiteStore(":memory:")
    engine = ReviewEngine()
    report_one, one = complete_report(store, "one", "one")
    report_two, two = complete_report(store, "two", "two")
    event_two = store.create_event("second event")
    report_three, three = complete_report(store, "three", "three", event_id=event_two["id"])
    with pytest.raises(StorageError, match="one event"):
        store.apply_grouping_review(
            review_request(
                "merge",
                [],
                {one["id"]: one["version"], three["id"]: three["version"]},
                incident_ids=[one["id"], three["id"]],
                target=one["id"],
            ),
            engine,
        )
    with pytest.raises(StorageError, match="one event"):
        store.apply_grouping_review(
            review_request(
                "move",
                [report_one["id"], report_three["id"]],
                {one["id"]: one["version"], three["id"]: three["version"]},
                target=one["id"],
            ),
            engine,
        )
    with pytest.raises(StorageError, match="not found"):
        store.apply_grouping_review(
            review_request(
                "move",
                [report_two["id"]],
                {two["id"]: two["version"], "missing": 1},
                target="missing",
            ),
            engine,
        )
    with pytest.raises(StorageError, match="same event"):
        store.apply_grouping_review(
            review_request(
                "move",
                [report_two["id"]],
                {two["id"]: two["version"], three["id"]: three["version"]},
                target=three["id"],
            ),
            engine,
        )
    # Rejection of one member from a multi-source selection is invalid and has no partial effects.
    pair_report, _ = complete_report(
        store, "pair", "pair", event_id=one["event_id"], target=one["id"]
    )
    pair_incident = store.get_incident(one["id"])
    with pytest.raises(StorageError, match="one incident"):
        store.apply_grouping_review(
            review_request(
                "reject",
                [report_two["id"], pair_report["id"]],
                {two["id"]: two["version"], one["id"]: pair_incident["version"]},
                target=one["id"],
            ),
            engine,
        )
    with pytest.raises(StorageError, match="one incident"):
        store.apply_grouping_review(
            review_request(
                "split",
                [report_two["id"], pair_report["id"]],
                {
                    two["id"]: store.get_incident(two["id"])["version"],
                    one["id"]: pair_incident["version"],
                },
                target=one["id"],
            ),
            engine,
        )
    with pytest.raises(StorageError, match="must match the source"):
        store.apply_grouping_review(
            review_request(
                "split",
                [pair_report["id"]],
                {
                    one["id"]: pair_incident["version"],
                    two["id"]: store.get_incident(two["id"])["version"],
                },
                target=two["id"],
                incident_ids=[one["id"]],
            ),
            engine,
        )
    with pytest.raises(StorageError, match="changed"):
        store.apply_grouping_review(
            review_request(
                "move", [report_two["id"]], {two["id"]: two["version"] - 1}, target=two["id"]
            ),
            engine,
        )
    store.close()


def test_grouping_review_rejects_empty_merge_targets() -> None:
    store = SQLiteStore(":memory:")
    engine = ReviewEngine()
    report, _active = complete_report(store, "active", "active")
    empty_event = store.create_event("empty group event")
    empty_report, empty, _ = store.create_report_receipt(
        event_id=empty_event["id"],
        text="pending",
        zone_id=None,
        sublocation=None,
        reported_at=None,
        idempotency_key="empty",
    )
    # Retire the membership by moving it to a real incident, preserving an empty source row.
    active_empty = store.create_event("active empty event")
    _other_report, other = complete_report(store, "other", "other", event_id=active_empty["id"])
    _, real_other = complete_report(store, "other second", "other-2", event_id=active_empty["id"])
    with store.transaction() as conn:
        conn.execute("DELETE FROM memberships WHERE report_id=?", (empty_report["id"],))
        conn.execute(
            "UPDATE incidents SET event_id=?,display_id=? WHERE id=?",
            (active_empty["id"], "I-000003", empty["id"]),
        )
        conn.execute(
            "UPDATE incidents SET event_id=?,display_id=? WHERE id=?",
            (active_empty["id"], "I-000004", other["id"]),
        )
        conn.execute(
            "UPDATE incidents SET event_id=?,display_id=? WHERE id=?",
            (active_empty["id"], "I-000005", real_other["id"]),
        )
        conn.execute(
            "UPDATE display_counters SET last_value=5 WHERE event_id=? AND entity='incident'",
            (active_empty["id"],),
        )
    with pytest.raises(StorageError, match="Empty incidents"):
        store.apply_grouping_review(
            review_request(
                "merge",
                [],
                {empty["id"]: empty["version"], other["id"]: other["version"]},
                incident_ids=[empty["id"], other["id"]],
                target=other["id"],
            ),
            engine,
        )
    assert store.get_report(report["id"]) is not None
    store.close()


def test_split_target_validation_and_rejecting_the_only_current_member() -> None:
    store = SQLiteStore(":memory:")
    engine = ReviewEngine()
    first_report, group = complete_report(store, "first", "first")
    second_report, _ = complete_report(store, "second", "second", target=group["id"])
    current = store.get_incident(group["id"])
    _, split_id = store.apply_grouping_review(
        review_request(
            "split",
            [second_report["id"]],
            expected(current),
            target=group["id"],
            incident_ids=[group["id"]],
        ),
        engine,
    )
    assert split_id != group["id"]
    third_report, _ = complete_report(store, "third", "third", target=group["id"])
    other_report, other = complete_report(store, "other group", "other", event_id=group["event_id"])
    current_group = store.get_incident(group["id"])
    current_other = store.get_incident(other["id"])
    with pytest.raises(StorageError, match="must be the source"):
        store.apply_grouping_review(
            review_request(
                "split",
                [first_report["id"]],
                {group["id"]: current_group["version"], other["id"]: current_other["version"]},
                target=other["id"],
                incident_ids=[other["id"]],
            ),
            engine,
        )

    solo, solo_group = complete_report(store, "solo", "solo", event_id=group["event_id"])
    _, rejected_id = store.apply_grouping_review(
        review_request("reject", [solo["id"]], expected(solo_group), target=solo_group["id"]),
        engine,
    )
    assert rejected_id != solo_group["id"]
    assert store.get_incident(solo_group["id"]) is None
    assert store.get_incident(rejected_id)["report_ids"] == [solo["id"]]
    assert store.get_report(other_report["id"]) is not None
    assert store.get_report(third_report["id"]) is not None
    store.close()


def test_rejection_cannot_target_an_empty_incident() -> None:
    store = SQLiteStore(":memory:")
    engine = ReviewEngine()
    report, source = complete_report(store, "source", "source")
    _, empty, _ = store.create_report_receipt(
        event_id=source["event_id"],
        text="temporary",
        zone_id=None,
        sublocation=None,
        reported_at=None,
        idempotency_key="empty",
    )
    with store.transaction() as conn:
        conn.execute("DELETE FROM memberships WHERE incident_id=?", (empty["id"],))
    with pytest.raises(StorageError, match="empty incident"):
        store.apply_grouping_review(
            review_request(
                "reject",
                [report["id"]],
                {source["id"]: source["version"], empty["id"]: empty["version"]},
                target=empty["id"],
            ),
            engine,
        )
    store.close()


def test_merge_uses_first_target_by_default_and_rejects_reports_from_other_event() -> None:
    store = SQLiteStore(":memory:")
    engine = ReviewEngine()
    left_report, left = complete_report(store, "left", "left")
    right_report, right = complete_report(store, "right", "right")
    second_event = store.create_event("second")
    other_report, other = complete_report(
        store, "other event report", "other", event_id=second_event["id"]
    )
    with pytest.raises(StorageError, match="Reports and incidents"):
        store.apply_grouping_review(
            review_request(
                "merge",
                [other_report["id"]],
                {left["id"]: left["version"], right["id"]: right["version"]},
                incident_ids=[left["id"], right["id"]],
                target=left["id"],
            ),
            engine,
        )
    event_id, target_id = store.apply_grouping_review(
        review_request(
            "merge",
            [],
            {left["id"]: left["version"], right["id"]: right["version"]},
            incident_ids=[left["id"], right["id"]],
            target=None,
        ),
        engine,
    )
    assert target_id == left["id"] and event_id == left_report["event_id"]
    assert set(store.get_incident(left["id"])["report_ids"]) == {
        left_report["id"],
        right_report["id"],
    }
    assert store.get_incident(other["id"])["report_ids"] == [other_report["id"]]
    store.close()


def test_grouping_merge_migrates_rejections_and_audits_constraints() -> None:
    store = SQLiteStore(":memory:")
    engine = ReviewEngine()
    rejected_report, rejected_group = complete_report(store, "Rejected candidate", "candidate")
    source_report, source = complete_report(store, "Source group", "source")
    _, target = complete_report(store, "Target group", "target")
    store.apply_grouping_review(
        review_request(
            "reject",
            [rejected_report["id"]],
            {rejected_group["id"]: rejected_group["version"], source["id"]: source["version"]},
            target=source["id"],
            reason="Keep the candidate separate.",
        ),
        engine,
    )
    event_id = source_report["event_id"]
    assert (rejected_report["id"], source["id"]) in store.rejection_pairs(event_id)
    rejected_group_current = store.get_incident(rejected_group["id"])
    target_current = store.get_incident(target["id"])
    store.apply_grouping_review(
        review_request(
            "reject",
            [rejected_report["id"]],
            {
                rejected_group["id"]: rejected_group_current["version"],
                target["id"]: target_current["version"],
            },
            target=target["id"],
            reason="Also keep this pairing separate.",
        ),
        engine,
    )
    current_source = store.get_incident(source["id"])
    current_target = store.get_incident(target["id"])
    store.apply_grouping_review(
        review_request(
            "merge",
            [],
            {source["id"]: current_source["version"], target["id"]: current_target["version"]},
            incident_ids=[source["id"], target["id"]],
            target=target["id"],
            reason="Merge the remaining reports.",
        ),
        engine,
    )
    pairs = store.rejection_pairs(event_id)
    assert (rejected_report["id"], source["id"]) not in pairs
    assert (rejected_report["id"], target["id"]) in pairs
    merge_audit = next(
        item
        for item in reversed(store.audit_for_event(event_id))
        if item["action"] == "grouping.merge"
    )
    assert any(
        pair["incident_id"] == source["id"] and pair["reason"] == "Keep the candidate separate."
        for pair in merge_audit["before"]["rejections"]
    )
    assert any(
        pair["incident_id"] == target["id"]
        and "Keep the candidate separate." in pair["reason"]
        and "Also keep this pairing separate." in pair["reason"]
        for pair in merge_audit["after"]["rejections"]
    )
    assert len(store.get_incident(target["id"])["report_ids"]) == 2
    store.close()


def test_demo_session_cursor_persistence_conflict_and_missing() -> None:
    store = SQLiteStore(":memory:")
    session = store.create_demo_session("edge", 1)
    assert store.get_demo_session(session["session_id"]) == session
    assert store.get_demo_session_for_event(session["event_id"]) == session
    advanced = store.advance_demo_cursor(session["session_id"], 0)
    assert advanced["cursor"] == 1
    exhausted = store.advance_demo_cursor(session["session_id"], 1)
    assert exhausted == advanced
    with pytest.raises(StorageError) as stale:
        store.advance_demo_cursor(session["session_id"], 0)
    assert stale.value.code == "stale_session"
    with pytest.raises(StorageError):
        store.advance_demo_cursor("absent", 0)
    assert store.get_demo_session("absent") is None
    assert store.get_demo_session_for_event("absent") is None
    store.close()


def test_private_storage_helpers_dominant_zone_rank_title_and_empty_rebuild() -> None:
    store = SQLiteStore(":memory:")
    assert store._title(" ".join(["word"] * 40)).endswith("...")
    assert store._title("  short  ") == "short"
    assert store._dominant_zone([]) is None
    assert store._dominant_zone([{"zone_id": None}, {"zone_id": "stage"}]) == "stage"
    assert store._priority_rank("P0") < store._priority_rank("P1") < store._priority_rank("P2")
    assert store._priority_rank("unknown") == store._priority_rank("UNASSESSED")
    store.current_event()
    with store.transaction() as conn:
        store._rebuild_incident_tx(conn, "absent", assessment(), [], increment=True)
    store.close()


def test_additive_migration_backfills_event_local_display_ids_and_preserves_data(
    tmp_path: Path,
) -> None:
    path = tmp_path / "legacy.sqlite3"
    legacy = sqlite3.connect(path)
    legacy.executescript(
        """
        CREATE TABLE events (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
            timezone TEXT NOT NULL, exercise INTEGER NOT NULL, policy_version TEXT NOT NULL,
            created_at TEXT NOT NULL);
        CREATE TABLE incidents (
            id TEXT PRIMARY KEY, event_id TEXT NOT NULL, title TEXT NOT NULL, zone_id TEXT,
            suggested_priority TEXT NOT NULL, priority_reason TEXT NOT NULL, status TEXT NOT NULL,
            review_required INTEGER NOT NULL, review_reasons_json TEXT NOT NULL,
            version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            override_priority TEXT, override_reason TEXT);
        CREATE TABLE reports (
            id TEXT PRIMARY KEY, event_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
            payload_fingerprint TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL,
            zone_id TEXT, sublocation TEXT, category TEXT, reported_at TEXT,
            received_at TEXT NOT NULL, analysis_status TEXT NOT NULL,
            review_reasons_json TEXT NOT NULL, UNIQUE(event_id,idempotency_key));
        """
    )
    timestamp = "2026-10-24T12:00:00+00:00"
    legacy.execute(
        "INSERT INTO events(id,name,timezone,exercise,policy_version,created_at) "
        "VALUES('legacy-event','Legacy exercise','UTC',1,'priority-v1',?)",
        (timestamp,),
    )
    legacy.execute(
        "INSERT INTO incidents(id,event_id,title,zone_id,suggested_priority,priority_reason,"
        "status,review_required,review_reasons_json,version,created_at,updated_at,"
        "override_priority,override_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            "legacy-incident",
            "legacy-event",
            "Legacy title",
            None,
            "P2",
            "Old policy result",
            "open",
            0,
            "[]",
            1,
            timestamp,
            timestamp,
            None,
            None,
        ),
    )
    legacy.execute(
        "INSERT INTO reports(id,event_id,idempotency_key,payload_fingerprint,text,source,"
        "zone_id,sublocation,category,reported_at,received_at,analysis_status,review_reasons_json) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            "legacy-report",
            "legacy-event",
            "legacy-key",
            "legacy-fingerprint",
            "Original report text",
            "form",
            None,
            None,
            None,
            None,
            timestamp,
            "failed",
            "[]",
        ),
    )
    legacy.commit()
    legacy.close()

    store = SQLiteStore(path, create_event=False)
    assert store.get_event("legacy-event")["name"] == "Legacy exercise"
    assert tuple(
        store.connection.execute(
            "SELECT text,display_id FROM reports WHERE id='legacy-report'"
        ).fetchone()
    ) == ("Original report text", "R-000001")
    assert tuple(
        store.connection.execute(
            "SELECT title,display_id,original_title,title_override FROM incidents "
            "WHERE id='legacy-incident'"
        ).fetchone()
    ) == ("Legacy title", "I-000001", "Legacy title", 0)
    with store.transaction() as conn:
        store._migrate_display_ids_and_notes_tx(conn)
    receipt, incident, duplicate = store.create_report_receipt(
        event_id="legacy-event",
        text="New receipt",
        zone_id=None,
        sublocation=None,
        reported_at=None,
        idempotency_key="new-key",
    )
    assert not duplicate
    assert receipt["display_id"] == "R-000002"
    assert incident["display_id"] == "I-000002"
    with pytest.raises(sqlite3.IntegrityError), store.transaction() as conn:
        conn.execute("UPDATE reports SET display_id='R-000001' WHERE id=?", (receipt["id"],))
    with pytest.raises(sqlite3.IntegrityError), store.transaction() as conn:
        conn.execute("UPDATE incidents SET display_id='I-000001' WHERE id=?", (incident["id"],))
    next_event = store.create_event("Another event")
    next_report, next_incident, _ = store.create_report_receipt(
        event_id=next_event["id"],
        text="Independent numbering",
        zone_id=None,
        sublocation=None,
        reported_at=None,
        idempotency_key="independent-key",
    )
    assert next_report["display_id"] == "R-000001"
    assert next_incident["display_id"] == "I-000001"
    assert store.events()[0]["id"] == next_event["id"]
    assert [
        row["version"]
        for row in store.connection.execute(
            "SELECT version FROM schema_migrations ORDER BY version"
        )
    ] == [1, 2]
    store.close()


def test_incident_notes_custom_title_evidence_time_and_rebuild_preservation() -> None:
    store = SQLiteStore(":memory:")
    first, incident = complete_report(store, "Original automatic title", "title-first")
    expected_version = incident["version"]
    event_id = store.update_incident_title(
        incident["id"], "Coordinator title", "Clarify the event name.", expected_version
    )
    titled = store.get_incident(incident["id"])
    assert event_id == incident["event_id"]
    assert titled["title"] == "Coordinator title"
    assert titled["original_title"] == "Original automatic title"
    assert titled["title_override"] is True
    note_event = store.add_incident_note(
        incident["id"], "Keep reports together for review.", titled["version"]
    )
    noted = store.get_incident(incident["id"])
    assert note_event == incident["event_id"]
    assert noted["notes"][0]["text"] == "Keep reports together for review."
    second, second_receipt, _ = store.create_report_receipt(
        event_id=incident["event_id"],
        text="A second account for the same event",
        zone_id="hall",
        sublocation=None,
        reported_at=None,
        idempotency_key="title-second",
    )
    evidence = {
        "report_id": second["id"],
        "candidate_report_id": first["id"],
        "semantic_score": 0.8,
        "location_score": 1.0,
        "time_score": 0.7,
        "category_score": 0.9,
        "total_score": 0.85,
        "decision": "suggest",
        "reasons": ["A coordinator should review this match."],
        "missing_fields": [],
    }
    finalized, rebuilt = store.finalize_analysis(
        second["id"],
        analysis(),
        incident["id"],
        [evidence],
        assessment(),
        [],
    )
    assert finalized["display_id"] == "R-000002"
    assert second_receipt["display_id"] == "I-000002"
    assert rebuilt["title"] == "Coordinator title"
    assert rebuilt["original_title"] == "Original automatic title"
    assert rebuilt["notes"] == noted["notes"]
    assert rebuilt["evidence"][0]["created_at"]
    audit_actions = [entry["action"] for entry in store.audit_for_event(incident["event_id"])]
    assert "incident.title_changed" in audit_actions
    assert "incident.note_added" in audit_actions
    store.close()


def test_incident_notes_survive_a_merge_and_keep_their_audit_history() -> None:
    store = SQLiteStore(":memory:")
    event_id = store.current_event()["id"]
    _, source = complete_report(store, "Source report", "note-merge-source", event_id=event_id)
    _, target = complete_report(store, "Target report", "note-merge-target", event_id=event_id)
    store.add_incident_note(source["id"], "Retain this source note.", source["version"])
    source = store.get_incident(source["id"])
    target = store.get_incident(target["id"])
    store.apply_grouping_review(
        review_request(
            "merge",
            [],
            {source["id"]: source["version"], target["id"]: target["version"]},
            incident_ids=[source["id"], target["id"]],
            target=target["id"],
            reason="Keep the incident context together.",
        ),
        ReviewEngine(),
    )
    merged = store.get_incident(target["id"])
    assert merged["notes"][0]["text"] == "Retain this source note."
    assert any(
        item["action"] == "incident.note_added" and item["entity_id"] == source["id"]
        for item in store.audit_for_event(event_id)
    )
    store.close()


def test_incident_notes_follow_rejected_replacement_and_title_history_is_audited() -> None:
    store = SQLiteStore(":memory:")
    report, source = complete_report(store, "Rejected report", "rejected-note-source")
    store.update_incident_title(
        source["id"], "Coordinator's original context", "Keep the human title.", source["version"]
    )
    source = store.get_incident(source["id"])
    store.add_incident_note(
        source["id"], "Keep this note with the reviewed report.", source["version"]
    )
    source = store.get_incident(source["id"])

    _, replacement_id = store.apply_grouping_review(
        review_request(
            "reject",
            [report["id"]],
            expected(source),
            target=source["id"],
            reason="Start a new review group.",
        ),
        ReviewEngine(),
    )

    replacement = store.get_incident(replacement_id)
    assert replacement_id != source["id"]
    assert replacement["notes"][0]["text"] == "Keep this note with the reviewed report."
    assert store.get_incident(source["id"]) is None
    grouping_audit = next(
        item
        for item in reversed(store.audit_for_event(source["event_id"]))
        if item["action"] == "grouping.reject"
    )
    historical_source = grouping_audit["before"]["incidents"][source["id"]]
    assert historical_source["title"] == "Coordinator's original context"
    assert historical_source["original_title"] == source["original_title"]
    assert historical_source["notes"][0]["text"] == "Keep this note with the reviewed report."
    store.close()


def test_reject_without_replacement_cannot_delete_the_only_source_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = SQLiteStore(":memory:")
    report, source = complete_report(store, "Rejected source", "reject-no-replacement")
    _, target = complete_report(store, "Existing candidate", "reject-existing-target")
    store.add_incident_note(source["id"], "Keep the source context.", source["version"])
    source = store.get_incident(source["id"])

    def no_replacement(*_args: Any, **_kwargs: Any) -> None:
        return None

    def move_to_existing(
        conn: sqlite3.Connection,
        report_ids: list[str],
        _target_id: str,
        actor: str,
        confirmed: bool,
    ) -> None:
        for report_id in report_ids:
            conn.execute(
                "UPDATE memberships SET incident_id=?,confirmed=?,created_by=? WHERE report_id=?",
                (target["id"], int(confirmed), actor, report_id),
            )

    monkeypatch.setattr(store, "_create_review_incident_tx", no_replacement)
    monkeypatch.setattr(store, "_move_reports_tx", move_to_existing)
    with pytest.raises(StorageError) as replacement_required:
        store.apply_grouping_review(
            review_request(
                "reject",
                [report["id"]],
                expected(source),
                target=source["id"],
                reason="Exercise the missing replacement guard.",
            ),
            ReviewEngine(),
        )
    assert replacement_required.value.code == "replacement_required"
    after_rollback = store.get_incident(source["id"])
    assert after_rollback is not None
    assert after_rollback["notes"][0]["text"] == "Keep the source context."
    assert store.get_report(report["id"])["incident_id"] == source["id"]
    store.close()


def test_incident_notes_follow_an_empty_source_during_analysis_rebuild() -> None:
    store = SQLiteStore(":memory:")
    event_id = store.current_event()["id"]
    _, target = complete_report(store, "Existing target", "pending-note-target", event_id=event_id)
    report, source_receipt, _ = store.create_report_receipt(
        event_id=event_id,
        text="A second pending report",
        zone_id=None,
        sublocation=None,
        reported_at=None,
        idempotency_key="pending-note-new",
    )
    store.add_incident_note(
        source_receipt["id"], "Move this with the pending receipt.", source_receipt["version"]
    )
    target = store.get_incident(target["id"])
    store.finalize_analysis(
        report["id"],
        analysis(),
        target["id"],
        [],
        assessment(),
        [],
    )
    assert store.get_incident(source_receipt["id"]) is None
    rebuilt_target = store.get_incident(target["id"])
    assert [note["text"] for note in rebuilt_target["notes"]] == [
        "Move this with the pending receipt."
    ]
    store.close()


def test_priority_override_review_marker_tracks_new_evidence_reset_and_undo() -> None:
    store = SQLiteStore(":memory:")
    _, incident = complete_report(store, "Initial evidence", "priority-review-base")
    store.update_priority(incident["id"], "P2", "Coordinator override.", incident["version"])
    _, high = complete_report(
        store,
        "Urgent evidence",
        "priority-review-high",
        event_id=incident["event_id"],
        target=incident["id"],
        priority="P0",
    )
    marker = "New higher-priority evidence after override needs review"
    assert marker in high["review_reasons"]
    current = store.get_incident(incident["id"])
    store.reset_priority(incident["id"], "Return to current policy priority.", current["version"])
    reset = store.get_incident(incident["id"])
    assert reset["override_reason"] is None
    assert marker not in reset["review_reasons"]
    reset_action = next(
        item
        for item in reversed(store.audit_for_event(incident["event_id"]))
        if item["action"] == "incident.priority_reset"
    )
    store.undo_decision(reset_action["id"], "Restore the prior override.", reset["version"])
    restored = store.get_incident(incident["id"])
    assert restored["priority"] == "P2"
    assert marker in restored["review_reasons"]
    store.close()


def test_priority_reset_and_guarded_compensating_undo() -> None:
    store = SQLiteStore(":memory:")
    _, incident = complete_report(store, "Undoable incident", "undo-base")
    with pytest.raises(StorageError) as missing_reset:
        store.reset_priority("missing", "Return to policy.", 1)
    assert missing_reset.value.status_code == 404
    with pytest.raises(StorageError) as no_override:
        store.reset_priority(incident["id"], "Return to policy.", incident["version"])
    assert no_override.value.code == "priority_not_overridden"
    store.update_priority(incident["id"], "P1", "Raise priority.", incident["version"])
    overridden = store.get_incident(incident["id"])
    priority_audit = next(
        item
        for item in reversed(store.audit_for_event(incident["event_id"]))
        if item["action"] == "incident.priority_overridden"
    )
    assert store.snapshot_data(incident["event_id"])["undoable_actions"] == [
        {
            "audit_id": priority_audit["id"],
            "incident_id": incident["id"],
            "action": "incident.priority_overridden",
            "expected_version": overridden["version"],
        }
    ]
    event_id = store.undo_decision(
        priority_audit["id"], "Restore the policy result.", overridden["version"]
    )
    restored = store.get_incident(incident["id"])
    assert event_id == incident["event_id"]
    assert restored["priority"] == restored["suggested_priority"]
    assert restored["override_reason"] is None
    assert store.snapshot_data(event_id)["undoable_actions"] == []
    store.update_priority(incident["id"], "P0", "Escalate pending review.", restored["version"])
    current = store.get_incident(incident["id"])
    store.reset_priority(incident["id"], "Use the current policy assessment.", current["version"])
    reset = store.get_incident(incident["id"])
    reset_audit = next(
        item
        for item in reversed(store.audit_for_event(event_id))
        if item["action"] == "incident.priority_reset"
    )
    store.undo_decision(reset_audit["id"], "Restore the previous override.", reset["version"])
    assert store.get_incident(incident["id"])["priority"] == "P0"
    undo_audit = store.audit_for_event(event_id)[-1]
    assert undo_audit["action"] == "incident.action_undone"
    assert undo_audit["after"]["undo_of_audit_id"] == reset_audit["id"]
    with pytest.raises(StorageError) as stale:
        store.undo_decision(reset_audit["id"], "Undo again.", reset["version"])
    assert stale.value.code in {"stale_version", "undo_unavailable"}

    current = store.get_incident(incident["id"])
    store.update_status(incident["id"], "acknowledged", "Coordinator confirms.", current["version"])
    status = store.get_incident(incident["id"])
    status_audit = next(
        item
        for item in reversed(store.audit_for_event(event_id))
        if item["action"] == "incident.status_changed"
    )
    store.undo_decision(status_audit["id"], "Return to the earlier status.", status["version"])
    assert store.get_incident(incident["id"])["status"] == "open"

    current = store.get_incident(incident["id"])
    store.update_status(
        incident["id"], "acknowledged", "Coordinator confirms again.", current["version"]
    )
    status = store.get_incident(incident["id"])
    status_audit = next(
        item
        for item in reversed(store.audit_for_event(event_id))
        if item["action"] == "incident.status_changed"
    )
    store.add_incident_note(incident["id"], "An intervening update.", status["version"])
    after_note = store.get_incident(incident["id"])
    assert store.snapshot_data(event_id)["undoable_actions"] == []
    with pytest.raises(StorageError) as intervening:
        store.undo_decision(status_audit["id"], "This is stale.", after_note["version"])
    assert intervening.value.code == "undo_unavailable"
    with pytest.raises(StorageError) as missing:
        store.undo_decision("missing", "Missing action.", after_note["version"])
    assert missing.value.status_code == 404
    received = next(
        item for item in store.audit_for_event(event_id) if item["action"] == "report.received"
    )
    with pytest.raises(StorageError) as unsupported:
        store.undo_decision(received["id"], "Wrong action.", after_note["version"])
    assert unsupported.value.code == "undo_unavailable"
    assert len(store.audit_for_event(event_id)) >= 8
    store.close()


def test_title_history_and_undo_reject_missing_or_corrupt_incident_state() -> None:
    store = SQLiteStore(":memory:")
    with pytest.raises(StorageError) as missing_title:
        store.update_incident_title("missing", "Valid title", "A valid reason.", 1)
    assert missing_title.value.status_code == 404

    _, incident = complete_report(store, "Generated title", "title-history")
    store.update_incident_title(
        incident["id"], "First human title", "Set the title.", incident["version"]
    )
    first = store.get_incident(incident["id"])
    store.update_incident_title(
        incident["id"], "Second human title", "Refine the title.", first["version"]
    )
    second = store.get_incident(incident["id"])
    assert second["title"] == "Second human title"
    assert second["original_title"] == "Generated title"

    event_id = incident["event_id"]
    store.update_status(incident["id"], "acknowledged", "Ready to close.", second["version"])
    status = store.get_incident(incident["id"])
    audit = next(
        item
        for item in reversed(store.audit_for_event(event_id))
        if item["action"] == "incident.status_changed"
    )
    with store.transaction() as conn:
        conn.execute("UPDATE audit_events SET before_json='null' WHERE id=?", (audit["id"],))
    with pytest.raises(StorageError) as corrupt:
        store.undo_decision(audit["id"], "Undo malformed history.", status["version"])
    assert corrupt.value.code == "undo_unavailable"

    with store.transaction() as conn:
        conn.execute(
            "UPDATE audit_events SET before_json=? WHERE id=?",
            ('{"status":"open"}', audit["id"]),
        )
        conn.execute("UPDATE incidents SET version=version+1 WHERE id=?", (incident["id"],))
    stale = store.get_incident(incident["id"])
    with pytest.raises(StorageError) as mismatch:
        store.undo_decision(audit["id"], "Undo stale history.", stale["version"])
    assert mismatch.value.code == "undo_unavailable"

    with store.transaction() as conn:
        conn.execute("DELETE FROM memberships WHERE incident_id=?", (incident["id"],))
        conn.execute("DELETE FROM incidents WHERE id=?", (incident["id"],))
    with pytest.raises(StorageError) as missing_incident:
        store.undo_decision(audit["id"], "Undo removed incident.", stale["version"])
    assert missing_incident.value.code == "undo_unavailable"

    with store.transaction() as conn:
        store._sync_priority_override_review_tx(conn, "missing")
    store.close()
