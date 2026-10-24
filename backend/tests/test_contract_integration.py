"""Cross-layer API contract tests against the real engine and SQLite store."""

from __future__ import annotations

from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event, Lock
from typing import Any

import pytest
from aegis.api import create_app
from aegis.engine import AnalysisEngine
from aegis.storage import SQLiteStore
from fastapi.testclient import TestClient

REPORTED_AT = "2026-10-25T10:00:00+00:00"


class PausingEngine:
    """Delegates real decisions while exposing two deterministic concurrency windows."""

    def __init__(self) -> None:
        self.real = AnalysisEngine()
        self.waiting = Event()
        self.resume = Event()
        self._lock = Lock()
        self._pause_analysis = False
        self._pause_choice = False

    def __getattr__(self, name: str) -> Any:
        return getattr(self.real, name)

    def pause_next_analysis_then_fail(self) -> None:
        with self._lock:
            self._pause_analysis = True
        self.waiting.clear()
        self.resume.clear()

    def pause_next_choice(self) -> None:
        with self._lock:
            self._pause_choice = True
        self.waiting.clear()
        self.resume.clear()

    def analyze_report(self, text: str, **kwargs: Any) -> dict[str, Any]:
        with self._lock:
            should_pause = self._pause_analysis
            if should_pause:
                self._pause_analysis = False
        if should_pause:
            self.waiting.set()
            if not self.resume.wait(timeout=10):
                raise TimeoutError(
                    "Timed out waiting for the integration test to release analysis."
                )
            raise RuntimeError("synthetic inference failure after receipt persistence")
        return self.real.analyze_report(text, **kwargs)

    def choose_group(
        self,
        incoming: dict[str, Any],
        groups: list[dict[str, Any]],
        rejections: set[tuple[str, str]] | None = None,
    ) -> dict[str, Any]:
        result = self.real.choose_group(incoming, groups, rejections)
        with self._lock:
            should_pause = self._pause_choice
            if should_pause:
                self._pause_choice = False
        if should_pause:
            self.waiting.set()
            if not self.resume.wait(timeout=10):
                raise TimeoutError(
                    "Timed out waiting for the integration test to release grouping."
                )
        return result


class PausingSnapshotStore(SQLiteStore):
    """Pause once after the report query to force a concurrent grouping write."""

    def __init__(self, path: Path) -> None:
        self.reports_read = Event()
        self.resume_snapshot = Event()
        self._pause_reports_query = False
        self._pause_lock = Lock()
        super().__init__(path)

    def pause_after_next_report_read(self) -> None:
        with self._pause_lock:
            self._pause_reports_query = True
        self.reports_read.clear()
        self.resume_snapshot.clear()

    def reports_for_event(self, event_id: str) -> list[dict[str, Any]]:
        reports = super().reports_for_event(event_id)
        with self._pause_lock:
            should_pause = self._pause_reports_query
            if should_pause:
                self._pause_reports_query = False
        if should_pause:
            self.reports_read.set()
            if not self.resume_snapshot.wait(timeout=10):
                raise TimeoutError(
                    "Timed out waiting for the integration test to release the snapshot."
                )
        return reports


@pytest.fixture
def system(tmp_path: Path) -> Iterator[tuple[TestClient, Any, AnalysisEngine]]:
    """Run the actual API and engine against an isolated, file-backed SQLite database."""
    engine = AnalysisEngine()
    app = create_app(db_path=tmp_path / "aegis.sqlite3", engine=engine)
    with TestClient(app, base_url="http://localhost") as client:
        yield client, app, engine


def submit(
    client: TestClient,
    text: str,
    key: str,
    *,
    zone: str | None = "exit-a",
    sublocation: str | None = "north doorway",
    reported_at: str | None = REPORTED_AT,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "text": text,
        "idempotency_key": key,
    }
    if zone is not None:
        payload["zone_id"] = zone
    if sublocation is not None:
        payload["sublocation"] = sublocation
    if reported_at is not None:
        payload["reported_at"] = reported_at
    response = client.post("/api/reports", json=payload)
    assert response.status_code in {200, 201}, response.text
    return response.json()


def snapshot(client: TestClient, event_id: str | None = None) -> dict[str, Any]:
    params = {"event_id": event_id} if event_id is not None else None
    response = client.get("/api/snapshot", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def incident_for(state: dict[str, Any], report_id: str) -> dict[str, Any]:
    report = next(report for report in state["reports"] if report["id"] == report_id)
    return next(
        incident for incident in state["incidents"] if incident["id"] == report["incident_id"]
    )


def review_grouping(
    client: TestClient,
    *,
    action: str,
    report_ids: list[str],
    target_incident_id: str | None = None,
    incident_ids: list[str] | None = None,
    reason: str = "Coordinator reviewed the source reports.",
) -> dict[str, Any]:
    before = snapshot(client)
    incident_map = {incident["id"]: incident for incident in before["incidents"]}
    affected = {
        next(report["incident_id"] for report in before["reports"] if report["id"] == report_id)
        for report_id in report_ids
    }
    selected_incidents = incident_ids or []
    if action == "merge":
        affected.update(selected_incidents)
    if target_incident_id is not None:
        affected.add(target_incident_id)
    body = {
        "action": action,
        "report_ids": report_ids,
        "incident_ids": selected_incidents,
        "target_incident_id": target_incident_id,
        "reason": reason,
        "expected_versions": {
            incident_id: incident_map[incident_id]["version"] for incident_id in affected
        },
    }
    response = client.post("/api/reviews/grouping", json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_report_retry_is_idempotent_mismatch_conflicts_and_raw_text_survives(
    system: tuple[TestClient, Any, AnalysisEngine],
) -> None:
    client, _app, _engine = system
    raw = "  Exit A is blocked by a fallen barrier.\n  The north doorway is crowded.  "
    payload = {
        "text": raw,
        "zone_id": "exit-a",
        "sublocation": "north doorway",
        "reported_at": REPORTED_AT,
        "idempotency_key": "retry-me",
        "source": "form",
    }

    first = client.post("/api/reports", json=payload)
    assert first.status_code == 201, first.text
    first_receipt = first.json()
    assert first_receipt["duplicate"] is False
    assert first_receipt["report"]["text"] == raw
    assert first_receipt["report"]["analysis_status"] == "complete"

    retry = client.post("/api/reports", json=payload)
    assert retry.status_code in {200, 201}, retry.text
    retry_receipt = retry.json()
    assert retry_receipt["duplicate"] is True
    assert retry_receipt["report"]["id"] == first_receipt["report"]["id"]

    mismatch = client.post("/api/reports", json={**payload, "text": "A different report."})
    assert mismatch.status_code == 409
    assert mismatch.json()["error"]["code"] == "idempotency_conflict"

    current = snapshot(client)
    assert len(current["reports"]) == 1
    assert current["reports"][0]["text"] == raw
    assert current["counts"]["reports"] == 1
    receipt_audits = [entry for entry in current["audit"] if entry["action"] == "report.received"]
    analysis_audits = [entry for entry in current["audit"] if entry["action"] == "report.analyzed"]
    assert len(receipt_audits) == 1
    assert len(analysis_audits) == 1


def test_conflicting_claims_remain_open_and_split_resolves_only_the_stale_pair(
    system: tuple[TestClient, Any, AnalysisEngine],
) -> None:
    client, _app, _engine = system
    blocked = submit(
        client, "Exit A is blocked at the north doorway by a fallen barrier.", "blocked"
    )
    clear = submit(client, "Exit A is clear and accessible at the north doorway.", "clear")
    event_id = blocked["report"]["event_id"]

    combined = review_grouping(
        client,
        action="confirm",
        report_ids=[clear["report"]["id"]],
        target_incident_id=blocked["incident"]["id"],
    )
    incident = incident_for(combined, blocked["report"]["id"])
    assert set(incident["report_ids"]) == {blocked["report"]["id"], clear["report"]["id"]}
    assert incident["status"] == "open"
    assert incident["review_required"] is True
    assert any(claim["value"] == "blocked" for claim in blocked["report"]["claims"])
    assert any(claim["value"] == "clear" for claim in clear["report"]["claims"])
    conflict = next(
        conflict for conflict in incident["conflicts"] if conflict["field"] == "exit_access"
    )
    assert conflict["status"] == "unresolved"
    assert set(conflict["report_ids"]) == {blocked["report"]["id"], clear["report"]["id"]}
    assert {"blocked", "clear"} == set(conflict["values"])

    # A coordinator correction splits the reports. The conflict's history stays
    # visible on the old incident but can no longer remain unresolved there.
    split = review_grouping(
        client,
        action="split",
        report_ids=[clear["report"]["id"]],
        target_incident_id=incident["id"],
        reason="These observations concern separate doorways.",
    )
    remaining = incident_for(split, blocked["report"]["id"])
    moved = incident_for(split, clear["report"]["id"])
    assert remaining["id"] != moved["id"]
    historical = next(item for item in remaining["conflicts"] if item["id"] == conflict["id"])
    assert historical["status"] == "resolved"
    assert "These observations concern separate doorways." in historical["reason"]
    assert remaining["status"] == "open"

    audit = client.get("/api/audit", params={"event_id": event_id}).json()
    assert [entry["seq"] for entry in audit] == sorted(entry["seq"] for entry in audit)
    assert any(entry["action"] == "grouping.confirm" for entry in audit)
    assert any(entry["action"] == "grouping.split" for entry in audit)
    assert any(entry["action"] == "report.analyzed" for entry in audit)


def test_rejected_candidate_is_persisted_and_old_membership_does_not_return_after_restart(
    tmp_path: Path,
) -> None:
    """A rejection is durable and a later ingest never silently moves the rejected report back."""
    db_path = tmp_path / "rejections.sqlite3"
    engine = AnalysisEngine()
    text = "A white backpack is on the bench beside the north Exit A doorway."
    app = create_app(db_path=db_path, engine=engine)
    with TestClient(app, base_url="http://localhost") as client:
        anchor = submit(client, text, "anchor")
        rejected = submit(client, text, "rejected")
        original_incident_id = anchor["incident"]["id"]
        state = review_grouping(
            client,
            action="reject",
            report_ids=[rejected["report"]["id"]],
            target_incident_id=original_incident_id,
            reason="The backpack reports describe separate items.",
        )
        first_group = incident_for(state, anchor["report"]["id"])
        rejected_group = incident_for(state, rejected["report"]["id"])
        assert first_group["id"] != rejected_group["id"]
        event_id = anchor["report"]["event_id"]
        assert (rejected["report"]["id"], original_incident_id) in app.state.store.rejection_pairs(
            event_id
        )
    reopened_app = create_app(db_path=db_path, engine=engine)
    with TestClient(reopened_app, base_url="http://localhost") as reopened:
        persisted = snapshot(reopened, event_id)
        assert incident_for(persisted, anchor["report"]["id"])["id"] == original_incident_id
        assert incident_for(persisted, rejected["report"]["id"])["id"] != original_incident_id
        assert (
            rejected["report"]["id"],
            original_incident_id,
        ) in reopened_app.state.store.rejection_pairs(event_id)

        # A subsequent ordinary report still uses the real matcher and cannot
        # rewrite an earlier coordinator decision as an ingestion side effect.
        submit(reopened, text, "later-copy")
        after_later_ingest = snapshot(reopened, event_id)
        assert (
            incident_for(after_later_ingest, rejected["report"]["id"])["id"] != original_incident_id
        )
        rejected_rows = [
            entry for entry in after_later_ingest["audit"] if entry["action"] == "grouping.reject"
        ]
        assert len(rejected_rows) == 1


def test_rejection_constraint_follows_a_merged_incident_to_its_survivor(
    system: tuple[TestClient, Any, AnalysisEngine],
) -> None:
    client, app, _engine = system
    text = "A white backpack is on the bench beside the north Exit A doorway."
    anchor = submit(client, text, "merge-anchor")
    rejected = submit(client, text, "merge-rejected")
    source_id = anchor["incident"]["id"]
    rejected_state = review_grouping(
        client,
        action="reject",
        report_ids=[rejected["report"]["id"]],
        target_incident_id=source_id,
        reason="The backpack reports describe separate items.",
    )
    assert incident_for(rejected_state, rejected["report"]["id"])["id"] != source_id

    separate = submit(
        client,
        "The food court refrigerator is leaking water beside the kitchen door.",
        "merge-destination",
        zone="food",
        sublocation="kitchen door",
    )
    destination_id = separate["incident"]["id"]
    assert destination_id != source_id
    merged = review_grouping(
        client,
        action="merge",
        report_ids=[anchor["report"]["id"], separate["report"]["id"]],
        incident_ids=[source_id, destination_id],
        target_incident_id=destination_id,
        reason="Coordinator merged the exercise groups.",
    )
    assert incident_for(merged, anchor["report"]["id"])["id"] == destination_id
    assert incident_for(merged, separate["report"]["id"])["id"] == destination_id
    assert incident_for(merged, rejected["report"]["id"])["id"] != destination_id
    assert (rejected["report"]["id"], destination_id) in app.state.store.rejection_pairs(
        anchor["report"]["event_id"]
    )


def test_human_confirmation_clears_only_the_selected_membership_flag(
    system: tuple[TestClient, Any, AnalysisEngine],
) -> None:
    client, _app, _engine = system
    text = "A white backpack is on the bench beside the north Exit A doorway."
    anchor = submit(client, text, "confirm-anchor")
    attached = submit(client, text, "confirm-member")
    another_attached = submit(client, text, "confirm-another-member")
    incident_id = anchor["incident"]["id"]
    assert attached["incident"]["id"] == incident_id
    assert another_attached["incident"]["id"] == incident_id
    provisional_flag = "Provisional grouping only; coordinator confirmation remains required."
    assert provisional_flag in attached["report"]["review_reasons"]
    assert provisional_flag in another_attached["report"]["review_reasons"]

    confirmed = review_grouping(
        client,
        action="confirm",
        report_ids=[attached["report"]["id"]],
        target_incident_id=incident_id,
        reason="Coordinator confirmed this report belongs to the group.",
    )
    confirmed_reports = {
        item["id"]: item
        for item in confirmed["reports"]
        if item["id"]
        in {anchor["report"]["id"], attached["report"]["id"], another_attached["report"]["id"]}
    }
    incident = next(item for item in confirmed["incidents"] if item["id"] == incident_id)
    assert len(confirmed_reports) == 3
    assert provisional_flag not in confirmed_reports[attached["report"]["id"]]["review_reasons"]
    assert provisional_flag in confirmed_reports[another_attached["report"]["id"]]["review_reasons"]
    assert provisional_flag in incident["review_reasons"]


def test_merge_split_and_stale_version_conflict_keep_memberships_atomic(
    system: tuple[TestClient, Any, AnalysisEngine],
) -> None:
    client, _app, _engine = system
    lift = submit(
        client,
        "The food court lift is broken beside the kitchen entrance.",
        "lift",
        zone="food",
        sublocation="kitchen entrance",
    )
    bag = submit(
        client,
        "A visitor lost a green backpack near the main stage.",
        "bag",
        zone="stage",
        sublocation="east seating",
    )
    screen = submit(
        client,
        "The registration desk display screen is flickering.",
        "screen",
        zone="registration",
        sublocation="west desk",
    )
    before = snapshot(client)
    first = incident_for(before, lift["report"]["id"])
    second = incident_for(before, bag["report"]["id"])
    third = incident_for(before, screen["report"]["id"])
    assert len({first["id"], second["id"], third["id"]}) == 3

    merged = review_grouping(
        client,
        action="merge",
        report_ids=[lift["report"]["id"], bag["report"]["id"]],
        incident_ids=[first["id"], second["id"]],
        target_incident_id=first["id"],
        reason="Coordinator linked the two exercise reports.",
    )
    assert incident_for(merged, lift["report"]["id"])["id"] == first["id"]
    assert incident_for(merged, bag["report"]["id"])["id"] == first["id"]
    assert incident_for(merged, screen["report"]["id"])["id"] == third["id"]
    assert second["id"] not in {item["id"] for item in merged["incidents"]}

    split = review_grouping(
        client,
        action="split",
        report_ids=[bag["report"]["id"]],
        target_incident_id=first["id"],
        reason="The backpack report is a separate event.",
    )
    assert incident_for(split, lift["report"]["id"])["id"] == first["id"]
    assert incident_for(split, bag["report"]["id"])["id"] not in {first["id"], third["id"]}
    assert incident_for(split, screen["report"]["id"])["id"] == third["id"]
    assert len(split["reports"]) == 3
    assert any(entry["action"] == "grouping.merge" for entry in split["audit"])
    assert any(entry["action"] == "grouping.split" for entry in split["audit"])

    current = incident_for(split, lift["report"]["id"])
    changed = client.post(
        f"/api/incidents/{current['id']}/status",
        json={
            "status": "monitoring",
            "reason": "Coordinator is monitoring the combined report.",
            "expected_version": current["version"],
        },
    )
    assert changed.status_code == 200, changed.text
    before_stale_attempt = snapshot(client)
    stale_merge = client.post(
        "/api/reviews/grouping",
        json={
            "action": "merge",
            "report_ids": [lift["report"]["id"], screen["report"]["id"]],
            "incident_ids": [current["id"], third["id"]],
            "target_incident_id": current["id"],
            "reason": "Stale edit must not alter the groups.",
            "expected_versions": {current["id"]: current["version"], third["id"]: third["version"]},
        },
    )
    assert stale_merge.status_code == 409
    assert stale_merge.json()["error"]["code"] == "stale_version"
    after_stale_attempt = snapshot(client)
    assert {report["id"]: report["incident_id"] for report in after_stale_attempt["reports"]} == {
        report["id"]: report["incident_id"] for report in before_stale_attempt["reports"]
    }
    assert len(after_stale_attempt["audit"]) == len(before_stale_attempt["audit"])


def test_noop_move_and_full_singleton_split_are_rejected_without_audit_mutation(
    system: tuple[TestClient, Any, AnalysisEngine],
) -> None:
    client, _app, _engine = system
    report = submit(
        client,
        "An attendee left a folded coat at the registration desk.",
        "single",
        zone="registration",
        sublocation="west desk",
    )
    state = snapshot(client)
    incident = incident_for(state, report["report"]["id"])
    baseline_audit = len(state["audit"])

    split = client.post(
        "/api/reviews/grouping",
        json={
            "action": "split",
            "report_ids": [report["report"]["id"]],
            "target_incident_id": incident["id"],
            "reason": "Splitting the whole group should be rejected.",
            "expected_versions": {incident["id"]: incident["version"]},
        },
    )
    assert split.status_code == 422, split.text
    assert "error" in split.json()
    after_split = snapshot(client)
    assert after_split["reports"][0]["incident_id"] == incident["id"]
    assert (
        next(item for item in after_split["incidents"] if item["id"] == incident["id"])["version"]
        == incident["version"]
    )
    assert len(after_split["audit"]) == baseline_audit

    move = client.post(
        "/api/reviews/grouping",
        json={
            "action": "move",
            "report_ids": [report["report"]["id"]],
            "target_incident_id": incident["id"],
            "reason": "Moving to the current group should be rejected.",
            "expected_versions": {incident["id"]: incident["version"]},
        },
    )
    assert move.status_code == 422, move.text
    assert "error" in move.json()
    after_move = snapshot(client)
    assert after_move["reports"][0]["incident_id"] == incident["id"]
    assert (
        next(item for item in after_move["incidents"] if item["id"] == incident["id"])["version"]
        == incident["version"]
    )
    assert len(after_move["audit"]) == baseline_audit


def test_priority_override_survives_new_risk_and_conflict_does_not_close_incident(
    system: tuple[TestClient, Any, AnalysisEngine],
) -> None:
    client, _app, _engine = system
    issue = submit(
        client,
        "A small water leak is beside the north doorway at Exit A.",
        "leak",
    )
    incident_id = issue["incident"]["id"]
    before = snapshot(client)
    incident = next(item for item in before["incidents"] if item["id"] == incident_id)
    assert incident["suggested_priority"] == "P2"

    overridden = client.post(
        f"/api/incidents/{incident_id}/priority",
        json={
            "priority": "P2",
            "reason": "Coordinator keeps this at standard review.",
            "expected_version": incident["version"],
        },
    )
    assert overridden.status_code == 200, overridden.text
    after_override = overridden.json()
    overridden_incident = next(
        item for item in after_override["incidents"] if item["id"] == incident_id
    )
    resolved = client.post(
        f"/api/incidents/{incident_id}/status",
        json={
            "status": "resolved",
            "reason": "Coordinator resolved the earlier leak report.",
            "expected_version": overridden_incident["version"],
        },
    )
    assert resolved.status_code == 200, resolved.text
    severe = submit(
        client,
        "Smoke from a fire is spreading by the north doorway at Exit A; people are trapped.",
        "smoke",
    )
    latest = snapshot(client)
    severe_incident = incident_for(latest, severe["report"]["id"])
    if severe_incident["id"] != incident_id:
        latest = review_grouping(
            client,
            action="confirm",
            report_ids=[severe["report"]["id"]],
            target_incident_id=incident_id,
            reason="Coordinator associated the newer danger report.",
        )
        severe_incident = incident_for(latest, severe["report"]["id"])

    assert severe_incident["id"] == incident_id
    assert severe_incident["suggested_priority"] == "P0"
    assert severe_incident["priority"] == "P2"
    assert severe_incident["override_reason"] == "Coordinator keeps this at standard review."
    assert (
        "New higher-priority evidence after override needs review"
        in severe_incident["review_reasons"]
    )
    assert severe_incident["status"] == "resolved"
    assert severe_incident["review_required"] is True
    assert any(entry["action"] == "incident.priority_overridden" for entry in latest["audit"])


def test_pending_singleton_is_not_used_to_attach_a_second_concurrent_report(
    tmp_path: Path,
) -> None:
    engine = PausingEngine()
    engine.pause_next_analysis_then_fail()
    app = create_app(db_path=tmp_path / "pending-anchor.sqlite3", engine=engine)
    text = "A white backpack is on the bench beside the north Exit A doorway."
    first_payload = {
        "text": text,
        "zone_id": "exit-a",
        "sublocation": "north doorway",
        "reported_at": REPORTED_AT,
        "idempotency_key": "pending-first",
    }
    second_payload = {**first_payload, "idempotency_key": "pending-second"}
    with (
        TestClient(app, base_url="http://localhost") as client,
        ThreadPoolExecutor(max_workers=1) as executor,
    ):
        first_request = executor.submit(client.post, "/api/reports", json=first_payload)
        try:
            assert engine.waiting.wait(timeout=5), (
                "The first inference did not reach its pause point."
            )
            second = client.post("/api/reports", json=second_payload)
            assert second.status_code == 201, second.text
            engine.resume.set()
            first = first_request.result(timeout=5)
        finally:
            engine.resume.set()

        assert first.status_code == 201, first.text
        failed = first.json()["report"]
        analyzed = second.json()["report"]
        assert failed["analysis_status"] == "failed"
        assert analyzed["analysis_status"] == "complete"
        assert failed["incident_id"] != analyzed["incident_id"]
        state = snapshot(client)
        failed_incident = next(
            incident for incident in state["incidents"] if incident["id"] == failed["incident_id"]
        )
        assert failed_incident["report_ids"] == [failed["id"]]


def test_late_analysis_result_cannot_override_a_coordinator_rejection(
    tmp_path: Path,
) -> None:
    engine = PausingEngine()
    app = create_app(db_path=tmp_path / "pending-rejection.sqlite3", engine=engine)
    text = "A white backpack is on the bench beside the north Exit A doorway."
    with (
        TestClient(app, base_url="http://localhost") as client,
        ThreadPoolExecutor(max_workers=1) as executor,
    ):
        anchor = submit(client, text, "rejection-race-anchor")
        target_id = anchor["incident"]["id"]
        engine.pause_next_choice()
        payload = {
            "text": text,
            "zone_id": "exit-a",
            "sublocation": "north doorway",
            "reported_at": REPORTED_AT,
            "idempotency_key": "rejection-race-incoming",
        }
        late_request = executor.submit(client.post, "/api/reports", json=payload)
        try:
            assert engine.waiting.wait(timeout=5), "Grouping did not reach its pause point."
            pending_state = snapshot(client)
            incoming = next(
                report
                for report in pending_state["reports"]
                if report["analysis_status"] == "pending"
            )
            review_grouping(
                client,
                action="reject",
                report_ids=[incoming["id"]],
                target_incident_id=target_id,
                reason="The coordinator rejected this candidate pairing.",
            )
            engine.resume.set()
            late_response = late_request.result(timeout=5)
        finally:
            engine.resume.set()

        assert late_response.status_code == 201, late_response.text
        final_state = snapshot(client)
        final_report = next(item for item in final_state["reports"] if item["id"] == incoming["id"])
        assert final_report["incident_id"] != target_id
        assert (incoming["id"], target_id) in app.state.store.rejection_pairs(
            anchor["report"]["event_id"]
        )


def test_snapshot_keeps_report_memberships_and_incident_rows_consistent(
    tmp_path: Path,
) -> None:
    store = PausingSnapshotStore(tmp_path / "snapshot-race.sqlite3")
    app = create_app(store=store, engine=AnalysisEngine())
    try:
        with (
            TestClient(app, base_url="http://localhost") as client,
            ThreadPoolExecutor(max_workers=2) as executor,
        ):
            exit_report = submit(
                client,
                "Exit A is blocked by a temporary barrier at the north doorway.",
                "snapshot-exit",
                zone="exit-a",
                sublocation="north doorway",
            )
            food_report = submit(
                client,
                "The food court refrigerator is leaking water beside the kitchen door.",
                "snapshot-food",
                zone="food",
                sublocation="kitchen door",
            )
            before = snapshot(client)
            exit_incident = incident_for(before, exit_report["report"]["id"])
            food_incident = incident_for(before, food_report["report"]["id"])
            assert exit_incident["id"] != food_incident["id"]

            merge_payload = {
                "action": "merge",
                "report_ids": [exit_report["report"]["id"], food_report["report"]["id"]],
                "incident_ids": [exit_incident["id"], food_incident["id"]],
                "target_incident_id": exit_incident["id"],
                "reason": "Coordinator merged the groups during the snapshot read.",
                "expected_versions": {
                    exit_incident["id"]: exit_incident["version"],
                    food_incident["id"]: food_incident["version"],
                },
            }
            store.pause_after_next_report_read()
            snapshot_request = executor.submit(client.get, "/api/snapshot")
            try:
                assert store.reports_read.wait(timeout=5), (
                    "Snapshot did not reach the report query."
                )
                merge_started = Event()
                merge_finished = Event()

                def merge_groups() -> Any:
                    merge_started.set()
                    result = client.post("/api/reviews/grouping", json=merge_payload)
                    merge_finished.set()
                    return result

                merge_request = executor.submit(merge_groups)
                assert merge_started.wait(timeout=5)
                merge_finished_before_snapshot = merge_finished.wait(timeout=1)
                store.resume_snapshot.set()
                response = snapshot_request.result(timeout=5)
                merge_response = merge_request.result(timeout=5)
            finally:
                store.resume_snapshot.set()

            assert response.status_code == 200, response.text
            assert not merge_finished_before_snapshot
            assert merge_response.status_code == 200, merge_response.text
            state = response.json()
            incident_ids = {incident["id"] for incident in state["incidents"]}
            assert all(report["incident_id"] in incident_ids for report in state["reports"])
            assert all(
                set(incident["report_ids"]).issubset({report["id"] for report in state["reports"]})
                for incident in state["incidents"]
            )
    finally:
        store.close()


def test_concurrent_replay_next_advances_once_and_keeps_one_receipt(
    tmp_path: Path,
) -> None:
    engine = PausingEngine()
    app = create_app(db_path=tmp_path / "concurrent-replay.sqlite3", engine=engine)
    with (
        TestClient(app, base_url="http://localhost") as client,
        ThreadPoolExecutor(max_workers=2) as executor,
    ):
        started = client.post("/api/demo/session", json={"scenario": "demo"})
        assert started.status_code == 200, started.text
        replay = started.json()["replay"]
        engine.pause_next_analysis_then_fail()
        path = f"/api/demo/session/{replay['session_id']}/next"
        slow_next = executor.submit(client.post, path, json={})
        try:
            assert engine.waiting.wait(timeout=5), "Replay analysis did not reach its pause point."
            concurrent_next = client.post(path, json={})
            assert concurrent_next.status_code == 200, concurrent_next.text
            concurrent_state = concurrent_next.json()
            assert concurrent_state["replay"]["cursor"] == 1
            assert len(concurrent_state["reports"]) == 1
            engine.resume.set()
            slow_response = slow_next.result(timeout=5)
        finally:
            engine.resume.set()

        assert slow_response.status_code == 409
        assert slow_response.json()["error"]["code"] == "stale_session"
        final_state = snapshot(client, replay["event_id"])
        assert final_state["replay"]["cursor"] == 1
        assert len(final_state["reports"]) == 1
        assert final_state["reports"][0]["analysis_status"] == "failed"
        assert sum(entry["action"] == "report.received" for entry in final_state["audit"]) == 1
        assert (
            sum(entry["action"] == "report.analysis_failed" for entry in final_state["audit"]) == 1
        )


def test_inference_failure_returns_durable_failed_receipt_and_audit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine = AnalysisEngine()
    calls = 0

    def fail_analysis(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        raise RuntimeError("synthetic local model failure")

    monkeypatch.setattr(engine, "analyze_report", fail_analysis)
    app = create_app(db_path=tmp_path / "failed-analysis.sqlite3", engine=engine)
    raw = "  Reporter says the display is flickering.  "
    with TestClient(app, base_url="http://localhost") as client:
        receipt = client.post(
            "/api/reports",
            json={
                "text": raw,
                "zone_id": "registration",
                "sublocation": "west desk",
                "reported_at": REPORTED_AT,
                "idempotency_key": "inference-failure",
            },
        )
        assert receipt.status_code == 201, receipt.text
        first = receipt.json()
        assert first["duplicate"] is False
        assert first["report"]["text"] == raw
        assert first["report"]["analysis_status"] == "failed"
        assert first["report"]["incident_id"] == first["incident"]["id"]
        assert first["incident"]["priority"] == "P2"
        assert first["incident"]["review_required"] is True

        retry = client.post(
            "/api/reports",
            json={
                "text": raw,
                "zone_id": "registration",
                "sublocation": "west desk",
                "reported_at": REPORTED_AT,
                "idempotency_key": "inference-failure",
            },
        )
        assert retry.status_code in {200, 201}
        assert retry.json()["duplicate"] is True
        assert calls == 1

        stored = client.get("/api/reports").json()
        assert len(stored) == 1
        assert stored[0]["text"] == raw
        audit = client.get("/api/audit").json()
        assert any(entry["action"] == "report.received" for entry in audit)
        failure = next(entry for entry in audit if entry["action"] == "report.analysis_failed")
        assert failure["entity_id"] == first["report"]["id"]


def test_demo_event_is_separate_and_snapshot_and_evaluation_follow_contract_schema(
    system: tuple[TestClient, Any, AnalysisEngine],
) -> None:
    client, _app, _engine = system
    original = submit(
        client,
        "The lift is broken in the exhibition hall.",
        "prior-event",
        zone="hall",
        sublocation="north wall",
    )
    old_event_id = original["report"]["event_id"]
    previous = snapshot(client, old_event_id)
    assert set(previous) == {
        "event",
        "zones",
        "incidents",
        "reports",
        "audit",
        "counts",
        "health",
        "replay",
    }
    assert set(previous["counts"]) == {"reports", "incidents", "review", "conflicts"}
    assert {"status", "engine", "model_ready", "model_revision"} == set(previous["health"])
    assert previous["reports"][0]["event_id"] == old_event_id
    assert previous["reports"][0]["text"] == "The lift is broken in the exhibition hall."
    assert {zone["id"] for zone in previous["zones"]} == {
        "stage",
        "exit-a",
        "exit-b",
        "food",
        "registration",
        "hall",
    }

    started = client.post("/api/demo/session", json={"scenario": "demo"})
    assert started.status_code == 200, started.text
    replay = started.json()["replay"]
    assert replay["cursor"] == 0
    assert replay["total"] > 0
    assert replay["event_id"] != old_event_id
    fresh = client.get("/api/snapshot").json()
    assert fresh["event"]["id"] == replay["event_id"]
    assert fresh["reports"] == []

    advanced = client.post(f"/api/demo/session/{replay['session_id']}/next", json={})
    assert advanced.status_code == 200, advanced.text
    new_state = advanced.json()
    assert new_state["event"]["id"] == replay["event_id"]
    assert new_state["replay"]["cursor"] == 1
    assert len(new_state["reports"]) == 1
    assert new_state["reports"][0]["event_id"] == replay["event_id"]
    assert len(snapshot(client, old_event_id)["reports"]) == 1

    evaluation = client.get("/api/evaluation/latest")
    assert evaluation.status_code == 200, evaluation.text
    results = evaluation.json()
    assert set(results) == {
        "dataset_version",
        "model",
        "config_version",
        "generated_at",
        "results",
        "checks",
        "latency",
        "limitations",
        "failures",
    }
    assert results["dataset_version"]
    assert results["results"]
    assert all(
        set(result)
        == {"method", "precision", "recall", "f1", "false_merges", "missed_pairs", "review_rate"}
        for result in results["results"]
    )
    assert all(set(check) == {"name", "passed", "detail"} for check in results["checks"])
    assert set(results["latency"]) == {"p50_ms", "p95_ms"}
    assert results["latency"]["p50_ms"] > 0
    assert results["latency"]["p95_ms"] >= results["latency"]["p50_ms"]


def test_unavailable_engine_evaluation_returns_a_structured_503(tmp_path: Path) -> None:
    class UnavailableEngine:
        def health(self) -> dict[str, Any]:
            raise RuntimeError("internal engine diagnostic")

    app = create_app(
        db_path=tmp_path / "unavailable-evaluation.sqlite3", engine=UnavailableEngine()
    )
    with TestClient(app, base_url="http://localhost", raise_server_exceptions=False) as client:
        response = client.get("/api/evaluation/latest")
    assert response.status_code == 503, response.text
    assert response.json()["error"]["code"] == "evaluation_unavailable"
    assert "internal engine diagnostic" not in response.text
