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
            "UPDATE incidents SET event_id=? WHERE id=?", (active_empty["id"], empty["id"])
        )
        conn.execute(
            "UPDATE incidents SET event_id=? WHERE id=?", (active_empty["id"], other["id"])
        )
        conn.execute(
            "UPDATE incidents SET event_id=? WHERE id=?", (active_empty["id"], real_other["id"])
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
