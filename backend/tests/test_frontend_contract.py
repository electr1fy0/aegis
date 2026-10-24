"""Exercise the exported TypeScript grouping helper against the real HTTP API."""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from aegis.api import create_app
from aegis.engine import AnalysisEngine
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
REPORTED_AT = "2026-10-25T10:00:00+00:00"
BUN = shutil.which("bun")
BUN_HELPER = r"""
import { createGroupingReviewInput } from "./frontend/src/pages/dashboard-page.tsx";

const request = JSON.parse(await Bun.stdin.text());
const result = createGroupingReviewInput(
  request.mode,
  request.incident,
  request.allIncidents,
  request.reportIds,
  request.targetIncidentId,
  request.mergeIncidentIds,
  request.reason,
);
console.log(JSON.stringify(result));
"""


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    app = create_app(db_path=tmp_path / "frontend-contract.sqlite3", engine=AnalysisEngine())
    with TestClient(app, base_url="http://localhost") as test_client:
        yield test_client


def submit(client: TestClient, text: str, key: str, zone: str, sublocation: str) -> dict[str, Any]:
    response = client.post(
        "/api/reports",
        json={
            "text": text,
            "zone_id": zone,
            "sublocation": sublocation,
            "reported_at": REPORTED_AT,
            "idempotency_key": key,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def snapshot(client: TestClient) -> dict[str, Any]:
    response = client.get("/api/snapshot")
    assert response.status_code == 200, response.text
    return response.json()


def incident_for(state: dict[str, Any], report_id: str) -> dict[str, Any]:
    report = next(item for item in state["reports"] if item["id"] == report_id)
    return next(item for item in state["incidents"] if item["id"] == report["incident_id"])


def build_frontend_input(
    *,
    mode: str,
    incident: dict[str, Any],
    all_incidents: list[dict[str, Any]],
    report_ids: list[str],
    target_incident_id: str,
    merge_incident_ids: list[str],
    reason: str,
) -> dict[str, Any]:
    assert BUN is not None, "Bun is required to validate the frontend grouping helper."
    payload = {
        "mode": mode,
        "incident": incident,
        "allIncidents": all_incidents,
        "reportIds": report_ids,
        "targetIncidentId": target_incident_id,
        "mergeIncidentIds": merge_incident_ids,
        "reason": reason,
    }
    process = subprocess.run(
        [BUN, "-e", BUN_HELPER],
        cwd=ROOT,
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=True,
        timeout=30,
    )
    return json.loads(process.stdout)


@pytest.mark.parametrize("action", ["confirm", "reject", "move", "merge", "split"])
def test_frontend_grouping_input_is_accepted_by_real_api(
    action: str,
    client: TestClient,
) -> None:
    assert BUN is not None, "Bun is required to validate the frontend grouping helper."

    matching_text = "A white backpack is on the bench beside the north Exit A doorway."
    first = submit(client, matching_text, "first-match", "exit-a", "north doorway")
    second = submit(client, matching_text, "second-match", "exit-a", "north doorway")
    separate = submit(
        client,
        "The food court refrigerator is leaking water beside the kitchen door.",
        "separate-incident",
        "food",
        "kitchen door",
    )

    before = snapshot(client)
    source = incident_for(before, first["report"]["id"])
    assert incident_for(before, second["report"]["id"])["id"] == source["id"]
    other = incident_for(before, separate["report"]["id"])
    assert other["id"] != source["id"]

    report_ids = [] if action == "merge" else [second["report"]["id"]]
    merge_ids = [source["id"], other["id"]] if action == "merge" else []
    target_id = other["id"] if action in {"move", "merge"} else source["id"]
    reason = f"Frontend helper {action} integration decision."
    request = build_frontend_input(
        mode=action,
        incident=source,
        all_incidents=before["incidents"],
        report_ids=report_ids,
        target_incident_id=target_id,
        merge_incident_ids=merge_ids,
        reason=reason,
    )

    affected_ids = {source["id"]}
    if action in {"move", "merge"}:
        affected_ids.add(other["id"])
    expected_versions = {
        incident["id"]: incident["version"]
        for incident in before["incidents"]
        if incident["id"] in affected_ids
    }
    assert request["expected_versions"] == expected_versions
    assert request["action"] == action
    assert request["reason"] == reason
    if action == "confirm":
        # This required field was absent from the old UI payload and made the
        # API reject the confirmation even though the button appeared to work.
        assert request["target_incident_id"] == source["id"]
    elif action in {"reject", "move", "merge"}:
        assert request["target_incident_id"] == target_id

    response = client.post("/api/reviews/grouping", json=request)
    assert response.status_code == 200, response.text
    after = response.json()
    assert any(entry["action"] == f"grouping.{action}" for entry in after["audit"])

    first_group = incident_for(after, first["report"]["id"])
    second_group = incident_for(after, second["report"]["id"])
    separate_group = incident_for(after, separate["report"]["id"])
    if action == "confirm":
        assert first_group["id"] == second_group["id"] == source["id"]
    elif action == "reject":
        assert first_group["id"] == source["id"]
        assert second_group["id"] != source["id"]
    elif action == "move":
        assert first_group["id"] == source["id"]
        assert second_group["id"] == separate_group["id"] == other["id"]
    elif action == "merge":
        assert first_group["id"] == second_group["id"] == separate_group["id"] == other["id"]
    else:
        assert first_group["id"] == source["id"]
        assert second_group["id"] not in {source["id"], other["id"]}
        assert separate_group["id"] == other["id"]
