"""Synthetic replay fixtures used by the Aegis exercise API."""

from __future__ import annotations

import copy
import json
from datetime import datetime
from pathlib import Path
from typing import Any

ZONES: list[dict[str, Any]] = [
    {"id": "stage", "label": "Main Stage", "x": 230, "y": 180},
    {"id": "exit-a", "label": "Exit A", "x": 120, "y": 430},
    {"id": "exit-b", "label": "Exit B", "x": 820, "y": 430},
    {"id": "food", "label": "Food Court", "x": 720, "y": 180},
    {"id": "registration", "label": "Registration", "x": 470, "y": 430},
    {"id": "hall", "label": "Exhibition Hall", "x": 470, "y": 180},
]

_SCENARIO_NAMES = frozenset({"demo", "busy", "edge"})
_SCENARIO_DIR = Path(__file__).resolve().parents[2] / "data" / "scenarios"
_REPORT_KEYS = frozenset(
    {
        "text",
        "zone_id",
        "sublocation",
        "reported_at",
        "idempotency_key",
        "source",
    }
)
_ZONE_IDS = frozenset(zone["id"] for zone in ZONES)


def _read_scenario(name: str) -> list[dict[str, Any]]:
    """Load and validate one input-only replay file."""
    path = _SCENARIO_DIR / f"{name}.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Unable to load synthetic {name!r} scenario: {exc}") from exc

    if not isinstance(payload, dict) or payload.get("scenario") != name:
        raise RuntimeError(f"Synthetic {name!r} scenario has an invalid document header")
    reports = payload.get("reports")
    if not isinstance(reports, list):
        raise RuntimeError(f"Synthetic {name!r} scenario must contain a report list")

    checked: list[dict[str, Any]] = []
    idempotency_keys: set[str] = set()
    for index, report in enumerate(reports, start=1):
        if not isinstance(report, dict) or set(report) != _REPORT_KEYS:
            raise RuntimeError(f"Synthetic {name!r} report {index} has an invalid shape")
        if not isinstance(report["text"], str) or not report["text"].strip():
            raise RuntimeError(f"Synthetic {name!r} report {index} has no text")
        zone_id = report["zone_id"]
        if zone_id is not None and (not isinstance(zone_id, str) or zone_id not in _ZONE_IDS):
            raise RuntimeError(f"Synthetic {name!r} report {index} has an unknown zone")
        if report["sublocation"] is not None and not isinstance(report["sublocation"], str):
            raise RuntimeError(f"Synthetic {name!r} report {index} has an invalid sublocation")
        reported_at = report["reported_at"]
        if reported_at is not None:
            if not isinstance(reported_at, str):
                raise RuntimeError(f"Synthetic {name!r} report {index} has an invalid reported_at")
            try:
                parsed_at = datetime.fromisoformat(reported_at.replace("Z", "+00:00"))
            except ValueError as exc:
                raise RuntimeError(
                    f"Synthetic {name!r} report {index} has an invalid reported_at"
                ) from exc
            if parsed_at.tzinfo is None or parsed_at.utcoffset() is None:
                raise RuntimeError(
                    f"Synthetic {name!r} report {index} reported_at must include a UTC offset"
                )
        idempotency_key = report["idempotency_key"]
        if not isinstance(idempotency_key, str) or not idempotency_key.strip():
            raise RuntimeError(f"Synthetic {name!r} report {index} has no idempotency key")
        if idempotency_key in idempotency_keys:
            raise RuntimeError(f"Synthetic {name!r} report {index} repeats an idempotency key")
        idempotency_keys.add(idempotency_key)
        if report["source"] != "replay":
            raise RuntimeError(f"Synthetic {name!r} report {index} is not marked as replay input")
        checked.append(report)
    return checked


def get_scenario(name: str) -> list[dict[str, Any]]:
    """Return fresh replay report dictionaries for ``demo``, ``busy`` or ``edge``.

    Ground-truth labels are stored only in ``data/evaluation`` and are never
    returned to, or imported by, the runtime replay path.
    """
    if not isinstance(name, str) or name not in _SCENARIO_NAMES:
        raise ValueError("Unknown scenario; expected one of: demo, busy, edge")
    return copy.deepcopy(_read_scenario(name))
