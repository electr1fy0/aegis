from __future__ import annotations

import importlib
import runpy
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from threading import Event
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.aegis import api as api_module
from backend.aegis.api import (
    APIError,
    _public_report,
    _require_current_event,
    _require_event,
    _scenario,
    _zones,
    create_app,
)
from backend.aegis.models import (
    ConflictReviewRequest,
    GroupingReviewRequest,
    IncidentNoteRequest,
    IncidentTitleRequest,
    IngestReportRequest,
    PriorityResetRequest,
    PriorityReviewRequest,
    RetryAnalysisRequest,
    StatusReviewRequest,
    UndoRequest,
)
from backend.aegis.storage import SQLiteStore


class FakeEngine:
    def __init__(self) -> None:
        self.fail_analysis = False
        self.fail_assessment = False
        self.fail_health = False
        self.bad_analysis = False
        self.bad_decision = False
        self.bad_target = False
        self.bad_evidence = False
        self.bad_assessment = False
        self.bad_conflicts = False

    def health(self) -> dict[str, Any]:
        if self.fail_health:
            raise RuntimeError("private engine failure")
        return {
            "status": "degraded",
            "engine": "lexical",
            "model_ready": False,
            "model_revision": None,
        }

    def analyze_report(
        self,
        text: str,
        zone_id: str | None = None,
        sublocation: str | None = None,
        reported_at: datetime | None = None,
    ) -> dict[str, Any]:
        if self.fail_analysis:
            raise RuntimeError("private model failure")
        if self.bad_analysis:
            return []  # type: ignore[return-value]
        claims = _claims(text)
        category = "blocked_exit" if any(c["field"] == "exit_access" for c in claims) else "other"
        return {
            "category": category,
            "claims": claims,
            "priority": "P1" if category == "blocked_exit" else "UNASSESSED",
            "priority_reason": "Fake exercise policy.",
            "review_reasons": [],
            "embedding": [1.0, 0.0],
            "model_revision": "fake-v1",
        }

    def choose_group(
        self,
        incoming: dict[str, Any],
        groups: list[dict[str, Any]],
        rejections: set[tuple[str, str]] | None = None,
    ) -> dict[str, Any]:
        if self.bad_decision:
            return []  # type: ignore[return-value]
        if self.bad_target:
            return {"incident_id": "forged", "evidence": [], "review_reasons": []}
        if self.bad_evidence:
            return {"incident_id": None, "evidence": {}, "review_reasons": []}
        if incoming["text"].startswith("ATTACH") and groups:
            group = groups[0]
            candidate = group["reports"][0]
            if (incoming["id"], group["id"]) in (rejections or set()):
                return {"incident_id": None, "evidence": [], "review_reasons": ["rejected"]}
            return {
                "incident_id": group["id"],
                "evidence": [
                    {
                        "report_id": incoming["id"],
                        "candidate_report_id": candidate["id"],
                        "semantic_score": 0.91,
                        "location_score": 1.0,
                        "time_score": 0.9,
                        "category_score": 1.0,
                        "total_score": 0.94,
                        "decision": "attach",
                        "reasons": ["same sublocation"],
                        "missing_fields": [],
                    }
                ],
                "review_reasons": [
                    "Provisional grouping only; coordinator confirmation remains required."
                ],
            }
        return {"incident_id": None, "evidence": [], "review_reasons": []}

    def assess_priority(self, reports: list[dict[str, Any]]) -> dict[str, Any]:
        if self.fail_assessment:
            raise RuntimeError("priority unavailable")
        if self.bad_assessment:
            return []  # type: ignore[return-value]
        text = " ".join(report.get("text", "") for report in reports).casefold()
        if "danger fire" in text or "fire now" in text:
            priority = "P0"
        elif "blocked" in text:
            priority = "P1"
        else:
            priority = "UNASSESSED"
        return {"priority": priority, "reason": "Fake exercise policy.", "review_reasons": []}

    def detect_conflicts(self, reports: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if self.bad_conflicts:
            return {}  # type: ignore[return-value]
        blocked = next(
            (r for r in reports if any(c["value"] == "blocked" for c in r.get("claims", []))), None
        )
        clear = next(
            (r for r in reports if any(c["value"] == "clear" for c in r.get("claims", []))), None
        )
        if blocked is None or clear is None:
            return []
        return [
            {
                "field": "exit_access",
                "report_ids": [blocked["id"], clear["id"]],
                "values": ["blocked", "clear"],
                "spans": ["exit is blocked", "exit is clear"],
            }
        ]


def _claims(text: str) -> list[dict[str, str]]:
    folded = text.casefold()
    if "blocked" in folded:
        return [{"field": "exit_access", "value": "blocked", "span": "exit is blocked"}]
    if "clear" in folded:
        return [{"field": "exit_access", "value": "clear", "span": "exit is clear"}]
    return []


@pytest.fixture
def system() -> Any:
    store = SQLiteStore(":memory:")
    engine = FakeEngine()
    app = create_app(store=store, engine=engine)
    with TestClient(app, base_url="http://localhost", raise_server_exceptions=False) as client:
        yield client, store, engine, app
    store.close()


def report_payload(text: str, key: str | None = None, **extra: Any) -> dict[str, Any]:
    return {"text": text, "idempotency_key": key or f"key-{text}", **extra}


def post_report(
    client: TestClient, text: str, key: str | None = None, **extra: Any
) -> dict[str, Any]:
    response = client.post("/api/reports", json=report_payload(text, key, **extra))
    assert response.status_code == 201, response.text
    return response.json()


def expected(incident: dict[str, Any]) -> dict[str, int]:
    return {incident["id"]: incident["version"]}


def test_health_current_event_empty_snapshot_and_lists(system: Any) -> None:
    client, store, _, _ = system
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json() == {
        "status": "degraded",
        "engine": "lexical",
        "model_ready": False,
        "model_revision": None,
    }
    current = client.get("/api/events/current").json()
    assert current["event"]["exercise"] is True
    assert len(current["zones"]) == 6
    initial = client.get("/api/snapshot").json()
    assert initial["counts"] == {"reports": 0, "incidents": 0, "review": 0, "conflicts": 0}
    assert initial["reports"] == [] and initial["incidents"] == [] and initial["audit"]
    assert client.get("/api/reports").json() == []
    assert client.get("/api/incidents").json() == []
    assert client.get("/api/audit").json() == initial["audit"]
    assert store.current_event()["id"] == initial["event"]["id"]
    second = store.create_event("Later event")
    assert [event["id"] for event in client.get("/api/events").json()] == [
        second["id"],
        initial["event"]["id"],
    ]


def test_ingest_preserves_raw_text_returns_typed_public_shape_and_duplicate(system: Any) -> None:
    client, _, _, _ = system
    raw = "  A person reports an exit is blocked.\n"
    first = client.post("/api/reports", json=report_payload(raw, "raw-key", zone_id="exit-a"))
    assert first.status_code == 201
    payload = first.json()
    assert payload["report"]["text"] == raw
    assert payload["report"]["analysis_status"] == "complete"
    assert "embedding" not in payload["report"]
    assert payload["incident"]["priority"] == "P1"
    assert payload["duplicate"] is False
    duplicate = client.post("/api/reports", json=report_payload(raw, "raw-key", zone_id="exit-a"))
    assert duplicate.status_code == 200
    assert duplicate.json()["duplicate"] is True
    snapshot = client.get("/api/snapshot").json()
    assert snapshot["counts"]["reports"] == 1
    assert snapshot["reports"][0]["text"] == raw
    assert [event["action"] for event in snapshot["audit"]].count("report.received") == 1


def test_ingest_idempotency_conflict_unknown_event_invalid_zone_and_validation(system: Any) -> None:
    client, _, _, _ = system
    first = post_report(client, "First text", "one")
    conflict = client.post("/api/reports", json=report_payload("Changed text", "one"))
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "idempotency_conflict"
    missing_event = client.post(
        "/api/reports", json=report_payload("new", "unknown-event", event_id="missing")
    )
    assert missing_event.status_code == 404
    unknown_zone = client.post("/api/reports", json=report_payload("new", "zone", zone_id="moon"))
    assert unknown_zone.status_code == 422
    assert unknown_zone.json()["error"]["code"] == "invalid_zone"
    blank_text = client.post("/api/reports", json=report_payload(" \n ", "blank"))
    assert blank_text.status_code == 422
    assert blank_text.json()["error"]["code"] == "validation_error"
    naive_time = client.post(
        "/api/reports", json=report_payload("new", "naive", reported_at="2026-10-24T12:00:00")
    )
    assert naive_time.status_code == 422
    malformed = client.post(
        "/api/reports", content="{not json", headers={"content-type": "application/json"}
    )
    assert malformed.status_code == 422
    assert "input" not in malformed.text
    assert first["report"]["id"] != ""


def test_failed_model_keeps_receipt_and_fallback_priority(system: Any) -> None:
    client, _, engine, _ = system
    engine.fail_analysis = True
    result = client.post("/api/reports", json=report_payload("Danger fire now at Exit A", "fail"))
    assert result.status_code == 201
    payload = result.json()
    assert payload["report"]["analysis_status"] == "failed"
    assert payload["incident"]["priority"] == "P0"
    assert payload["incident"]["review_required"] is True
    assert len(client.get("/api/reports").json()) == 1
    assert client.get("/api/audit").json()[-1]["action"] == "report.analysis_failed"


@pytest.mark.parametrize(
    "bad_field", ["analysis", "decision", "target", "evidence", "assessment", "conflicts"]
)
def test_malformed_or_failed_engine_path_keeps_a_failed_singleton(
    system: Any, bad_field: str
) -> None:
    client, _, engine, _ = system
    setattr(engine, f"bad_{bad_field}", True)
    response = client.post(
        "/api/reports", json=report_payload("Danger fire now", f"bad-{bad_field}")
    )
    assert response.status_code == 201
    assert response.json()["report"]["analysis_status"] == "failed"
    if bad_field == "assessment":
        assert response.json()["incident"]["priority"] == "UNASSESSED"
    else:
        assert response.json()["incident"]["priority"] == "P0"


def test_engine_fallback_failure_is_visible_unassessed_and_health_is_degraded(system: Any) -> None:
    client, _, engine, _ = system
    engine.fail_analysis = True
    engine.fail_assessment = True
    result = client.post("/api/reports", json=report_payload("Danger fire now", "all-fail")).json()
    assert result["report"]["analysis_status"] == "failed"
    assert result["incident"]["priority"] == "UNASSESSED"
    engine.fail_health = True
    assert client.get("/api/health").json() == {
        "status": "degraded",
        "engine": "unavailable",
        "model_ready": False,
        "model_revision": None,
    }


def test_attached_evidence_conflict_review_and_stale_conflict_version(system: Any) -> None:
    client, _, _, _ = system
    first = post_report(client, "Exit is blocked", "blocked", zone_id="exit-a")
    second = post_report(client, "ATTACH exit is clear", "clear", zone_id="exit-a")
    incident = second["incident"]
    assert incident["id"] == first["incident"]["id"]
    assert len(incident["report_ids"]) == 2
    assert incident["evidence"][0]["candidate_report_id"] == first["report"]["id"]
    assert len(incident["conflicts"]) == 1
    conflict = incident["conflicts"][0]
    assert conflict["status"] == "unresolved"
    resolution = client.post(
        f"/api/conflicts/{conflict['id']}/review",
        json={
            "status": "resolved",
            "reason": "Coordinator confirmed the exit status.",
            "expected_version": incident["version"],
        },
    )
    assert resolution.status_code == 200
    resolved = resolution.json()["incidents"][0]
    assert resolved["conflicts"][0]["status"] == "resolved"
    assert resolved["version"] == incident["version"] + 1
    stale = client.post(
        f"/api/conflicts/{conflict['id']}/review",
        json={
            "status": "unresolved",
            "reason": "Reopen old view.",
            "expected_version": incident["version"],
        },
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "stale_version"


def test_resolved_candidate_stays_history_and_new_severe_match_opens_an_incident(
    system: Any,
) -> None:
    client, _, _, _ = system
    medical = post_report(
        client,
        "A visitor has a painful ankle near the north medical tent.",
        "medical-before-resolution",
        zone_id="hall",
        sublocation="north medical tent",
        reported_at="2026-10-24T12:00:00Z",
    )
    old_incident = medical["incident"]
    resolved = client.post(
        f"/api/incidents/{old_incident['id']}/status",
        json={
            "status": "resolved",
            "reason": "Coordinator confirms the original injury report is closed.",
            "expected_version": old_incident["version"],
        },
    )
    assert resolved.status_code == 200, resolved.text

    new_report = post_report(
        client,
        "ATTACH danger fire now beside the north medical tent.",
        "severe-after-resolution",
        zone_id="hall",
        sublocation="north medical tent",
        reported_at="2026-10-24T12:01:00Z",
    )
    assert new_report["report"]["analysis_status"] == "complete"
    assert new_report["report"]["id"] in new_report["incident"]["report_ids"]
    assert new_report["incident"]["id"] != old_incident["id"]
    assert new_report["incident"]["status"] == "open"
    assert new_report["incident"]["priority"] == "P0"

    snapshot = client.get("/api/snapshot").json()
    saved_incidents = {incident["id"]: incident for incident in snapshot["incidents"]}
    assert saved_incidents[old_incident["id"]]["status"] == "resolved"
    assert saved_incidents[new_report["incident"]["id"]]["status"] == "open"
    assert new_report["report"]["id"] not in saved_incidents[old_incident["id"]]["report_ids"]


def test_finalize_drops_candidate_resolved_after_initial_match_decision(system: Any) -> None:
    class PausingAssessmentEngine(FakeEngine):
        def __init__(self) -> None:
            super().__init__()
            self.assessment_started = Event()
            self.release_assessment = Event()
            self.paused_once = False

        def assess_priority(self, reports: list[dict[str, Any]]) -> dict[str, Any]:
            if not self.paused_once and any(
                item.get("text", "").startswith("ATTACH") for item in reports
            ):
                self.paused_once = True
                self.assessment_started.set()
                if not self.release_assessment.wait(timeout=10):
                    raise TimeoutError("test did not release candidate assessment")
            return super().assess_priority(reports)

    client, _, _, app = system
    engine = PausingAssessmentEngine()
    app.state.engine = engine
    medical = post_report(
        client,
        "A visitor has a painful ankle near the north medical tent.",
        "medical-before-finalize-race",
        zone_id="hall",
        sublocation="north medical tent",
        reported_at="2026-10-24T12:00:00Z",
    )
    old_incident = medical["incident"]
    payload = report_payload(
        "ATTACH danger fire now beside the north medical tent.",
        "severe-during-finalize-race",
        zone_id="hall",
        sublocation="north medical tent",
        reported_at="2026-10-24T12:01:00Z",
    )

    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(client.post, "/api/reports", json=payload)
        assert engine.assessment_started.wait(timeout=5)
        resolved = client.post(
            f"/api/incidents/{old_incident['id']}/status",
            json={
                "status": "resolved",
                "reason": "Coordinator closed the original report during analysis.",
                "expected_version": old_incident["version"],
            },
        )
        assert resolved.status_code == 200, resolved.text
        engine.release_assessment.set()
        created = pending.result(timeout=10)

    assert created.status_code == 201, created.text
    result = created.json()
    assert result["incident"]["id"] != old_incident["id"]
    assert result["incident"]["status"] == "open"
    assert result["incident"]["priority"] == "P0"
    snapshot = client.get("/api/snapshot").json()
    saved_incidents = {incident["id"]: incident for incident in snapshot["incidents"]}
    assert saved_incidents[old_incident["id"]]["status"] == "resolved"
    assert saved_incidents[result["incident"]["id"]]["report_ids"] == [result["report"]["id"]]


def test_human_grouping_actions_confirm_move_reject_split_and_merge(system: Any) -> None:
    client, store, _, _ = system
    one = post_report(client, "Base one", "one")
    two = post_report(client, "Separate two", "two")
    attached = post_report(client, "ATTACH second", "three")
    incident_one = attached["incident"]
    incident_two = next(
        item for item in client.get("/api/incidents").json() if item["id"] != incident_one["id"]
    )
    confirm = client.post(
        "/api/reviews/grouping",
        json={
            "action": "confirm",
            "report_ids": [attached["report"]["id"]],
            "target_incident_id": incident_one["id"],
            "reason": "Same report event.",
            "expected_versions": expected(incident_one),
        },
    )
    assert confirm.status_code == 200
    confirmed = next(
        item for item in confirm.json()["incidents"] if item["id"] == incident_one["id"]
    )
    assert (
        "Provisional grouping only; coordinator confirmation remains required."
        not in confirmed["review_reasons"]
    )
    moved = client.post(
        "/api/reviews/grouping",
        json={
            "action": "move",
            "report_ids": [attached["report"]["id"]],
            "target_incident_id": incident_two["id"],
            "reason": "Distinct location evidence.",
            "expected_versions": {
                incident_one["id"]: confirmed["version"],
                incident_two["id"]: incident_two["version"],
            },
        },
    )
    assert moved.status_code == 200
    current_two = next(
        item for item in moved.json()["incidents"] if item["id"] == incident_two["id"]
    )
    rejected = client.post(
        "/api/reviews/grouping",
        json={
            "action": "reject",
            "report_ids": [attached["report"]["id"]],
            "target_incident_id": incident_two["id"],
            "reason": "Different incident.",
            "expected_versions": expected(current_two),
        },
    )
    assert rejected.status_code == 200
    rejected_snapshot = rejected.json()
    new_incident = next(
        item
        for item in rejected_snapshot["incidents"]
        if attached["report"]["id"] in item["report_ids"]
    )
    assert new_incident["id"] != incident_two["id"]
    assert (attached["report"]["id"], incident_two["id"]) in store.rejection_pairs(
        incident_one["event_id"]
    )

    second_member = post_report(client, "ATTACH member", "four")
    member_ids = second_member["incident"]["report_ids"]
    member_incident = second_member["incident"]
    assert len(member_ids) >= 2
    selected = next(report_id for report_id in member_ids if report_id != member_ids[0])
    split = client.post(
        "/api/reviews/grouping",
        json={
            "action": "split",
            "report_ids": [selected],
            "target_incident_id": member_incident["id"],
            "reason": "Keep this report separate.",
            "expected_versions": expected(member_incident),
        },
    )
    assert split.status_code == 200
    separate = next(item for item in split.json()["incidents"] if selected in item["report_ids"])
    assert separate["id"] != member_incident["id"]
    # Merge is driven by incident IDs; report_ids is intentionally empty.
    left = next(item for item in split.json()["incidents"] if item["id"] == member_incident["id"])
    right = separate
    merged = client.post(
        "/api/reviews/grouping",
        json={
            "action": "merge",
            "report_ids": [],
            "incident_ids": [left["id"], right["id"]],
            "target_incident_id": left["id"],
            "reason": "Coordinator verified common event.",
            "expected_versions": {left["id"]: left["version"], right["id"]: right["version"]},
        },
    )
    assert merged.status_code == 200
    assert any(
        item["id"] == left["id"] and len(item["report_ids"]) >= 2
        for item in merged.json()["incidents"]
    )
    assert not any(item["id"] == right["id"] for item in merged.json()["incidents"])
    actions = [item["action"] for item in client.get("/api/audit").json()]
    for action in (
        "grouping.confirm",
        "grouping.move",
        "grouping.reject",
        "grouping.split",
        "grouping.merge",
    ):
        assert action in actions
    assert one["report"]["id"] in {item["id"] for item in client.get("/api/reports").json()}
    assert two["report"]["id"] in {item["id"] for item in client.get("/api/reports").json()}


def test_priority_status_missing_incident_and_stale_edits(system: Any) -> None:
    client, _, _, _ = system
    result = post_report(client, "Base", "base")
    incident = result["incident"]
    priority = client.post(
        f"/api/incidents/{incident['id']}/priority",
        json={
            "priority": "P2",
            "reason": "Coordinator override.",
            "expected_version": incident["version"],
        },
    )
    assert priority.status_code == 200
    changed = priority.json()["incidents"][0]
    assert changed["priority"] == "P2" and changed["override_reason"] == "Coordinator override."
    stale_priority = client.post(
        f"/api/incidents/{incident['id']}/priority",
        json={"priority": "P1", "reason": "Old override.", "expected_version": incident["version"]},
    )
    assert stale_priority.status_code == 409
    status = client.post(
        f"/api/incidents/{incident['id']}/status",
        json={
            "status": "acknowledged",
            "reason": "Coordinator acknowledged.",
            "expected_version": changed["version"],
        },
    )
    assert status.status_code == 200
    assert status.json()["incidents"][0]["status"] == "acknowledged"
    assert client.get(f"/api/incidents/{incident['id']}").json()["id"] == incident["id"]
    assert client.get("/api/incidents/missing").status_code == 404
    missing = client.post(
        "/api/incidents/missing/status",
        json={"status": "resolved", "reason": "No incident.", "expected_version": 1},
    )
    assert missing.status_code == 404


def test_high_risk_after_override_is_flagged_for_re_review(system: Any) -> None:
    client, _, _, _ = system
    first = post_report(client, "Base incident", "base")
    override = client.post(
        f"/api/incidents/{first['incident']['id']}/priority",
        json={
            "priority": "P2",
            "reason": "Human setting.",
            "expected_version": first["incident"]["version"],
        },
    ).json()["incidents"][0]
    high = post_report(client, "ATTACH Danger fire now", "high")
    assert high["incident"]["priority"] == "P2"
    assert high["incident"]["suggested_priority"] == "P0"
    assert (
        "New higher-priority evidence after override needs review"
        in high["incident"]["review_reasons"]
    )
    assert override["id"] == high["incident"]["id"]


def test_demo_session_uses_ordinary_ingest_persists_and_exhaustion_is_idempotent(
    system: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, store, _, _ = system
    original_event = store.current_event()["id"]
    fixture = {
        "text": "Demo report",
        "zone_id": "stage",
        "sublocation": None,
        "reported_at": "2026-10-24T12:00:00+00:00",
        "idempotency_key": "demo-only-1",
        "source": "replay",
    }
    fixtures_module = importlib.import_module("backend.aegis.fixtures")
    monkeypatch.setattr(fixtures_module, "get_scenario", lambda name: [dict(fixture)])
    started = client.post("/api/demo/session", json={"scenario": "demo"})
    assert started.status_code == 200
    start_snapshot = started.json()
    session = start_snapshot["replay"]
    assert session["cursor"] == 0 and session["total"] == 1
    assert start_snapshot["event"]["exercise"] is True
    advanced = client.post(f"/api/demo/session/{session['session_id']}/next", json={})
    assert advanced.status_code == 200
    payload = advanced.json()
    assert payload["replay"]["cursor"] == 1
    assert payload["reports"][0]["text"] == fixture["text"]
    assert payload["audit"][-1]["action"] == "report.analyzed"
    exhausted = client.post(f"/api/demo/session/{session['session_id']}/next", json={})
    assert exhausted.status_code == 200
    assert exhausted.json()["counts"] == payload["counts"]
    assert exhausted.json()["replay"]["cursor"] == 1
    assert store.get_event(original_event) is not None
    assert client.get(f"/api/snapshot?event_id={original_event}").json()["reports"] == []
    assert client.post("/api/demo/session/unknown/next", json={}).status_code == 404
    assert client.post("/api/demo/session", json={"scenario": "unknown"}).status_code == 422


def test_demo_fixture_mismatch_and_bad_scenario_data_return_safe_errors(
    system: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _, _, _ = system
    fixtures_module = importlib.import_module("backend.aegis.fixtures")
    fixture = {
        "text": "Demo report",
        "zone_id": None,
        "sublocation": None,
        "reported_at": None,
        "idempotency_key": "bad-event",
        "source": "form",
        "event_id": "other-event",
    }
    monkeypatch.setattr(fixtures_module, "get_scenario", lambda _: [fixture])
    session = client.post("/api/demo/session", json={"scenario": "edge"}).json()["replay"]
    mismatch = client.post(f"/api/demo/session/{session['session_id']}/next", json={})
    assert mismatch.status_code == 500
    assert mismatch.json()["error"]["code"] == "fixture_invalid"
    monkeypatch.undo()
    with pytest.raises(ValueError):
        _scenario("invalid")
    assert len(_zones()) == 6


def test_evaluation_success_cache_and_unavailable(
    system: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _, _, app = system
    result = {
        "dataset_version": "test",
        "model": "fake",
        "config_version": "v1",
        "generated_at": datetime.now(UTC).isoformat(),
        "results": [],
        "checks": [],
        "latency": {"p50_ms": 1.0, "p95_ms": 2.0},
        "limitations": ["synthetic"],
        "failures": [],
    }
    evaluation_module = importlib.import_module("backend.aegis.evaluation")
    calls = 0

    def run(_: Any) -> dict[str, Any]:
        nonlocal calls
        calls += 1
        return result

    monkeypatch.setattr(evaluation_module, "run_evaluation", run)
    assert client.get("/api/evaluation/latest").json()["dataset_version"] == "test"
    assert client.get("/api/evaluation/latest").json()["dataset_version"] == "test"
    assert calls == 1
    app.state.evaluation_cache = None
    monkeypatch.setattr(
        evaluation_module,
        "run_evaluation",
        lambda _: (_ for _ in ()).throw(RuntimeError("private")),
    )
    unavailable = client.get("/api/evaluation/latest")
    assert unavailable.status_code == 503
    assert unavailable.json()["error"]["code"] == "evaluation_unavailable"
    assert "private" not in unavailable.text


def test_evaluation_unusable_latency_is_an_explicit_503(
    system: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, _, _, app = system
    evaluation_module = importlib.import_module("backend.aegis.evaluation")
    monkeypatch.setattr(
        evaluation_module,
        "run_evaluation",
        lambda _: {
            "dataset_version": "test",
            "model": "unavailable",
            "config_version": "none",
            "generated_at": datetime.now(UTC).isoformat(),
            "results": [],
            "checks": [],
            "latency": {"p50_ms": None, "p95_ms": None},
            "limitations": [],
            "failures": ["engine unavailable"],
        },
    )
    app.state.evaluation_cache = None
    response = client.get("/api/evaluation/latest")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "evaluation_unavailable"


def test_errors_method_not_allowed_unknown_route_and_generic_failure(system: Any) -> None:
    client, store, _, app = system
    assert client.get("/api/no-such-path").json()["error"]["code"] == "not_found"
    method = client.put("/api/health")
    assert method.status_code == 405
    assert method.json()["error"]["code"] == "method_not_allowed"
    app.add_api_route(
        "/api/domain-error",
        lambda: (_ for _ in ()).throw(
            APIError(409, "test_conflict", "Expected conflict.", {"field": "name"})
        ),
        methods=["GET"],
    )
    domain_error = client.get("/api/domain-error")
    assert domain_error.json()["error"]["details"] == {"field": "name"}
    app.add_api_route(
        "/api/teapot", lambda: (_ for _ in ()).throw(StarletteHTTPException(418)), methods=["GET"]
    )
    teapot = client.get("/api/teapot")
    assert teapot.status_code == 418
    assert teapot.json()["error"]["code"] == "request_failed"
    original_store, original_engine = app.state.store, app.state.engine
    app.state.store = None
    assert client.get("/api/snapshot").status_code == 500
    app.state.store = original_store
    app.state.engine = None
    assert client.get("/api/health").status_code == 500
    app.state.engine = original_engine
    store.close()
    generic = client.get("/api/snapshot")
    assert generic.status_code == 500
    assert generic.json() == {
        "error": {"code": "internal_error", "message": "The request could not be completed."}
    }


def test_no_current_event_and_helper_errors() -> None:
    store = SQLiteStore(":memory:", create_event=False)
    app = create_app(store=store, engine=FakeEngine())
    with TestClient(app, base_url="http://localhost", raise_server_exceptions=False) as client:
        assert client.get("/api/events/current").status_code == 503
        assert client.get("/api/reports").status_code == 503
        with pytest.raises(APIError):
            _require_current_event(store)
        with pytest.raises(APIError):
            _require_event(store, "missing")
    store.close()


def test_app_owned_store_lifecycle_and_startup_failure_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = tmp_path / "owned.sqlite3"
    app = create_app(db_path=database, engine=FakeEngine())
    with TestClient(app, base_url="http://localhost"):
        assert app.state.store.current_event() is not None
        owned_store = app.state.store
    assert app.state.store is None
    with pytest.raises(sqlite3.ProgrammingError):
        owned_store.current_event()

    startup_app = create_app(db_path=tmp_path / "failed.sqlite3")
    original = api_module._engine_from_runtime

    def fail_engine() -> Any:
        raise RuntimeError("startup failed")

    monkeypatch.setattr(api_module, "_engine_from_runtime", fail_engine)
    with (
        pytest.raises(RuntimeError, match="startup failed"),
        TestClient(startup_app, base_url="http://localhost"),
    ):
        pass
    assert startup_app.state.store is None
    monkeypatch.setattr(api_module, "_engine_from_runtime", original)


def test_external_store_is_not_closed_and_factory_uses_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    injected = SQLiteStore(":memory:")
    app = create_app(db_path=tmp_path / "unused.sqlite3", engine=FakeEngine(), store=injected)
    with TestClient(app, base_url="http://localhost"):
        assert app.state.store is injected
    assert injected.current_event() is not None
    injected.close()

    monkeypatch.setenv("AEGIS_DB_PATH", str(tmp_path / "from-env.sqlite3"))
    env_app = create_app(db_path=None, engine=FakeEngine())
    with TestClient(env_app, base_url="http://localhost"):
        assert env_app.state.store.path == str(tmp_path / "from-env.sqlite3")
    assert not (tmp_path / "runtime" / "aegis.sqlite3").exists()


def test_model_validators_and_public_report_filtering() -> None:
    assert IngestReportRequest(text="  raw  ", idempotency_key=" key ").text == "  raw  "
    assert IngestReportRequest(text="raw", idempotency_key=" key ").idempotency_key == "key"
    assert (
        IngestReportRequest(text="raw", idempotency_key="key", sublocation=" ").sublocation is None
    )
    assert (
        IngestReportRequest(text="raw", idempotency_key="key", sublocation=" North ").sublocation
        == "North"
    )
    with pytest.raises(ValueError):
        IngestReportRequest(text="raw", idempotency_key=" ")
    with pytest.raises(ValueError):
        IngestReportRequest(text="raw", idempotency_key="key", reported_at="2026-10-24T00:00:00")
    with pytest.raises(ValueError):
        GroupingReviewRequest(action="confirm", report_ids=[], reason="valid", expected_versions={})
    with pytest.raises(ValueError):
        GroupingReviewRequest(
            action="merge", incident_ids=["one"], reason="valid", expected_versions={}
        )
    with pytest.raises(ValueError):
        GroupingReviewRequest(
            action="split", report_ids=["one", "one"], reason="valid", expected_versions={}
        )
    with pytest.raises(ValueError):
        GroupingReviewRequest(
            action="split", report_ids=["one"], reason="   ", expected_versions={}
        )
    assert (
        PriorityReviewRequest(priority="P0", reason="  note ", expected_version=1).reason == "note"
    )
    with pytest.raises(ValueError):
        PriorityReviewRequest(priority="P0", reason="   ", expected_version=1)
    assert StatusReviewRequest(status="open", reason="reason", expected_version=1).status == "open"
    with pytest.raises(ValueError):
        StatusReviewRequest(status="open", reason="   ", expected_version=1)
    assert (
        ConflictReviewRequest(status="resolved", reason="reason", expected_version=1).status
        == "resolved"
    )
    with pytest.raises(ValueError):
        ConflictReviewRequest(status="resolved", reason="   ", expected_version=1)
    assert IncidentNoteRequest(text="  Preserve this detail.  ", expected_version=1).text == (
        "Preserve this detail."
    )
    assert (
        IncidentTitleRequest(
            title="  Clear title  ", reason="  Clarify the incident.  ", expected_version=1
        ).title
        == "Clear title"
    )
    assert (
        PriorityResetRequest(reason="Return to policy.", expected_version=1).expected_version == 1
    )
    assert (
        UndoRequest(reason="Restore the previous state.", expected_version=1).expected_version == 1
    )
    assert RetryAnalysisRequest(expected_version=1).expected_version == 1
    for invalid in (
        lambda: IncidentNoteRequest(text="  ", expected_version=1),
        lambda: IncidentTitleRequest(title="  ", reason="Valid reason.", expected_version=1),
        lambda: IncidentTitleRequest(title="Valid", reason="  ", expected_version=1),
        lambda: IncidentTitleRequest(title="Valid", reason=" x ", expected_version=1),
        lambda: PriorityResetRequest(reason="  ", expected_version=1),
        lambda: PriorityResetRequest(reason=" x ", expected_version=1),
        lambda: UndoRequest(reason="  ", expected_version=1),
        lambda: UndoRequest(reason=" x ", expected_version=1),
        lambda: RetryAnalysisRequest(expected_version=True),
    ):
        with pytest.raises(ValueError):
            invalid()
    raw = {
        "id": "r",
        "event_id": "e",
        "text": "raw",
        "zone_id": None,
        "sublocation": None,
        "category": None,
        "reported_at": None,
        "received_at": "2026-10-24T00:00:00+00:00",
        "analysis_status": "complete",
        "incident_id": "i",
        "claims": [],
        "review_reasons": [],
        "embedding": [1],
        "model_revision": "internal",
        "source": "form",
        "confirmed": False,
    }
    assert set(_public_report(raw)) == {
        "id",
        "display_id",
        "event_id",
        "text",
        "zone_id",
        "sublocation",
        "category",
        "reported_at",
        "received_at",
        "analysis_status",
        "incident_id",
        "claims",
        "review_reasons",
        "model_revision",
        "confirmed",
    }


def test_public_report_revision_confirmation_and_evidence_time(system: Any) -> None:
    client, _, _, _ = system
    first = post_report(client, "Exit is blocked", "public-first", zone_id="exit-a")
    second = post_report(client, "ATTACH exit is clear", "public-second", zone_id="exit-a")
    assert first["report"]["display_id"] == "R-000001"
    assert first["incident"]["display_id"] == "I-000001"
    assert first["report"]["model_revision"] == "fake-v1"
    assert first["report"]["confirmed"] is False
    evidence = second["incident"]["evidence"][0]
    assert evidence["created_at"]
    assert second["report"]["model_revision"] == "fake-v1"
    current = second["incident"]
    confirmed = client.post(
        "/api/reviews/grouping",
        json={
            "action": "confirm",
            "report_ids": [second["report"]["id"]],
            "target_incident_id": current["id"],
            "reason": "Coordinator confirms this match.",
            "expected_versions": expected(current),
        },
    )
    assert confirmed.status_code == 200
    report = next(
        item for item in confirmed.json()["reports"] if item["id"] == second["report"]["id"]
    )
    assert report["confirmed"] is True


def test_incident_note_title_priority_reset_and_undo_routes(system: Any) -> None:
    client, _, _, _ = system
    created = post_report(client, "A report title", "action-routes")
    incident = created["incident"]
    title_response = client.post(
        f"/api/incidents/{incident['id']}/title",
        json={
            "title": "Coordinator title",
            "reason": "Use a clearer event label.",
            "expected_version": incident["version"],
        },
    )
    assert title_response.status_code == 200
    titled = next(
        item for item in title_response.json()["incidents"] if item["id"] == incident["id"]
    )
    assert titled["title"] == "Coordinator title"
    assert titled["original_title"] == "A report title"
    assert titled["title_override"] is True
    stale_title = client.post(
        f"/api/incidents/{incident['id']}/title",
        json={
            "title": "Old version",
            "reason": "This should be rejected.",
            "expected_version": incident["version"],
        },
    )
    assert stale_title.status_code == 409
    note_response = client.post(
        f"/api/incidents/{incident['id']}/notes",
        json={"text": "  Coordinator observation.  ", "expected_version": titled["version"]},
    )
    assert note_response.status_code == 200
    noted = next(item for item in note_response.json()["incidents"] if item["id"] == incident["id"])
    assert noted["notes"][0]["text"] == "Coordinator observation."
    blank_note = client.post(
        f"/api/incidents/{incident['id']}/notes",
        json={"text": "  ", "expected_version": noted["version"]},
    )
    assert blank_note.status_code == 422
    missing_note = client.post(
        "/api/incidents/missing/notes",
        json={"text": "A valid note.", "expected_version": 1},
    )
    assert missing_note.status_code == 404
    overridden = client.post(
        f"/api/incidents/{incident['id']}/priority",
        json={
            "priority": "P1",
            "reason": "Escalate for review.",
            "expected_version": noted["version"],
        },
    ).json()["incidents"][0]
    reset_response = client.post(
        f"/api/incidents/{incident['id']}/priority/reset",
        json={"reason": "Return to policy assessment.", "expected_version": overridden["version"]},
    )
    assert reset_response.status_code == 200
    reset_snapshot = reset_response.json()
    reset_incident = next(
        item for item in reset_snapshot["incidents"] if item["id"] == incident["id"]
    )
    assert reset_incident["priority"] == reset_incident["suggested_priority"]
    reset_audit = next(
        item
        for item in reversed(reset_snapshot["audit"])
        if item["action"] == "incident.priority_reset"
    )
    assert reset_snapshot["undoable_actions"] == [
        {
            "audit_id": reset_audit["id"],
            "incident_id": incident["id"],
            "action": "incident.priority_reset",
            "expected_version": reset_incident["version"],
        }
    ]
    undone = client.post(
        f"/api/audit/{reset_audit['id']}/undo",
        json={
            "reason": "Restore the coordinator override.",
            "expected_version": reset_incident["version"],
        },
    )
    assert undone.status_code == 200
    after_undo = next(item for item in undone.json()["incidents"] if item["id"] == incident["id"])
    assert after_undo["priority"] == "P1"
    assert undone.json()["audit"][-1]["action"] == "incident.action_undone"
    assert not undone.json()["undoable_actions"]
    unsupported_audit = next(
        item for item in undone.json()["audit"] if item["action"] == "event.created"
    )
    unsupported = client.post(
        f"/api/audit/{unsupported_audit['id']}/undo",
        json={"reason": "Try an unsupported action.", "expected_version": after_undo["version"]},
    )
    assert unsupported.status_code == 409
    reset_again = client.post(
        f"/api/incidents/{incident['id']}/priority/reset",
        json={"reason": "Return to policy again.", "expected_version": after_undo["version"]},
    )
    assert reset_again.status_code == 200
    reset_again_incident = next(
        item for item in reset_again.json()["incidents"] if item["id"] == incident["id"]
    )
    no_override = client.post(
        f"/api/incidents/{incident['id']}/priority/reset",
        json={
            "reason": "There is nothing to reset.",
            "expected_version": reset_again_incident["version"],
        },
    )
    assert no_override.status_code == 409


def test_failed_report_retry_preserves_human_membership_and_edits(system: Any) -> None:
    client, _, engine, _ = system
    base = post_report(client, "Base incident", "retry-base")
    engine.bad_analysis = True
    failed = post_report(client, "ATTACH pending account", "retry-report")
    assert failed["report"]["analysis_status"] == "failed"
    moved = client.post(
        "/api/reviews/grouping",
        json={
            "action": "move",
            "report_ids": [failed["report"]["id"]],
            "target_incident_id": base["incident"]["id"],
            "reason": "Coordinator groups these reports.",
            "expected_versions": {
                base["incident"]["id"]: base["incident"]["version"],
                failed["incident"]["id"]: failed["incident"]["version"],
            },
        },
    )
    assert moved.status_code == 200
    current = next(
        item for item in moved.json()["incidents"] if item["id"] == base["incident"]["id"]
    )
    titled = client.post(
        f"/api/incidents/{current['id']}/title",
        json={
            "title": "Human reviewed title",
            "reason": "Keep the coordinator title.",
            "expected_version": current["version"],
        },
    ).json()
    current = next(item for item in titled["incidents"] if item["id"] == current["id"])
    noted = client.post(
        f"/api/incidents/{current['id']}/notes",
        json={"text": "Keep the entered note.", "expected_version": current["version"]},
    ).json()
    current = next(item for item in noted["incidents"] if item["id"] == current["id"])
    priority = client.post(
        f"/api/incidents/{current['id']}/priority",
        json={
            "priority": "P1",
            "reason": "Keep human priority.",
            "expected_version": current["version"],
        },
    ).json()
    current = next(item for item in priority["incidents"] if item["id"] == current["id"])
    engine.bad_analysis = False
    retried = client.post(
        f"/api/reports/{failed['report']['id']}/retry",
        json={"expected_version": current["version"]},
    )
    assert retried.status_code == 200, retried.text
    snapshot = retried.json()
    report = next(item for item in snapshot["reports"] if item["id"] == failed["report"]["id"])
    incident = next(item for item in snapshot["incidents"] if item["id"] == current["id"])
    assert report["analysis_status"] == "complete"
    assert report["incident_id"] == current["id"]
    assert report["text"] == "ATTACH pending account"
    assert report["model_revision"] == "fake-v1"
    assert incident["title"] == "Human reviewed title"
    assert incident["notes"][0]["text"] == "Keep the entered note."
    assert incident["priority"] == "P1"
    assert snapshot["counts"]["reports"] == 2
    assert any(item["action"] == "report.analysis_retry_started" for item in snapshot["audit"])
    assert any(item["action"] == "report.analyzed" for item in snapshot["audit"])
    complete_retry = client.post(
        f"/api/reports/{failed['report']['id']}/retry",
        json={"expected_version": incident["version"]},
    )
    assert complete_retry.status_code == 409


def test_startup_pending_recovery_is_bounded_and_keeps_manual_changes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = SQLiteStore(":memory:")
    event = store.current_event()
    first, first_incident, _ = store.create_report_receipt(
        event_id=event["id"],
        text="Pending first report",
        zone_id="stage",
        sublocation=None,
        reported_at=None,
        idempotency_key="startup-first",
    )
    second, _second_incident, _ = store.create_report_receipt(
        event_id=event["id"],
        text="Pending second report",
        zone_id="hall",
        sublocation=None,
        reported_at=None,
        idempotency_key="startup-second",
    )
    store.update_incident_title(
        first_incident["id"],
        "Title entered before restart",
        "Keep coordinator title.",
        first_incident["version"],
    )
    titled = store.get_incident(first_incident["id"])
    store.add_incident_note(first_incident["id"], "Manual recovery note.", titled["version"])
    with store.transaction() as conn:
        conn.execute(
            "UPDATE reports SET received_at=? WHERE id=?",
            ("2026-10-24T00:00:00+00:00", first["id"]),
        )
        conn.execute(
            "UPDATE reports SET received_at=? WHERE id=?",
            ("2026-10-24T00:00:01+00:00", second["id"]),
        )
    monkeypatch.setattr(api_module, "STARTUP_RECOVERY_LIMIT", 1)
    app = create_app(store=store, engine=FakeEngine())
    with TestClient(app, base_url="http://localhost"):
        recovered = store.get_report(first["id"])
        left_pending = store.get_report(second["id"])
        assert recovered["analysis_status"] == "complete"
        assert recovered["incident_id"] == first_incident["id"]
        assert left_pending["analysis_status"] == "pending"
        incident = store.get_incident(first_incident["id"])
        assert incident["title"] == "Title entered before restart"
        assert incident["notes"][0]["text"] == "Manual recovery note."
    store.close()


def test_pending_report_can_be_explicitly_retried_and_startup_failure_is_contained(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = SQLiteStore(":memory:")
    engine = FakeEngine()
    event = store.current_event()
    app = create_app(store=store, engine=engine)
    with TestClient(app, base_url="http://localhost") as client:
        pending, incident, _ = store.create_report_receipt(
            event_id=event["id"],
            text="Pending explicit retry",
            zone_id="stage",
            sublocation=None,
            reported_at=None,
            idempotency_key="explicit-pending",
        )
        retried = client.post(
            f"/api/reports/{pending['id']}/retry",
            json={"expected_version": incident["version"]},
        )
        assert retried.status_code == 200
        assert retried.json()["reports"][0]["analysis_status"] == "complete"
        wrong = client.post(
            f"/api/reports/{pending['id']}/retry",
            json={"expected_version": incident["version"]},
        )
        assert wrong.status_code == 409
        missing = client.post(
            "/api/reports/missing/retry", json={"expected_version": incident["version"]}
        )
        assert missing.status_code == 404

    interrupted, _, _ = store.create_report_receipt(
        event_id=event["id"],
        text="Pending recovery error",
        zone_id="hall",
        sublocation=None,
        reported_at=None,
        idempotency_key="recovery-error",
    )
    monkeypatch.setattr(
        api_module,
        "_process_report_analysis",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("recovery failed")),
    )
    with TestClient(create_app(store=store, engine=engine), base_url="http://localhost") as client:
        assert client.get("/api/health").status_code == 200
    assert store.get_report(interrupted["id"])["analysis_status"] == "pending"
    store.close()


def test_module_main_uses_local_bind_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []
    uvicorn = importlib.import_module("uvicorn")
    monkeypatch.setattr(uvicorn, "run", lambda target, **kwargs: calls.append((target, kwargs)))
    monkeypatch.setenv("AEGIS_HOST", "127.0.0.1")
    monkeypatch.setenv("AEGIS_PORT", "8123")
    namespace = runpy.run_module("backend.aegis.__main__", run_name="__main__")
    assert namespace["main"] is not None
    assert calls == [
        ("backend.aegis.api:app", {"host": "127.0.0.1", "port": 8123, "reload": False})
    ]


def test_main_rejects_invalid_host_ports_and_logs_bind_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    module = importlib.import_module("backend.aegis.__main__")
    uvicorn = importlib.import_module("uvicorn")
    monkeypatch.setenv("AEGIS_HOST", "   ")
    monkeypatch.setenv("AEGIS_PORT", "8000")
    with pytest.raises(SystemExit, match="AEGIS_HOST"):
        module.main()
    monkeypatch.setenv("AEGIS_HOST", "127.0.0.1")
    for port in ("zero", "0", "65536"):
        monkeypatch.setenv("AEGIS_PORT", port)
        with pytest.raises(SystemExit, match="AEGIS_PORT"):
            module.main()
    monkeypatch.setenv("AEGIS_PORT", "8123")
    monkeypatch.setattr(
        uvicorn, "run", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("address used"))
    )
    with pytest.raises(SystemExit) as failure:
        module.main()
    assert failure.value.code == 1


def test_runtime_engine_factory_is_lazy() -> None:
    from backend.aegis.engine import AnalysisEngine

    assert isinstance(api_module._engine_from_runtime(), AnalysisEngine)
