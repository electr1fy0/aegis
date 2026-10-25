"""Evaluate Aegis on the separate, development-only hard-negative challenge set.

This script intentionally reads only data/evaluation/challenge_dev.json. It runs
normal AnalysisEngine.analyze_report and choose_group calls in both pair
orientations, then compares their outputs with the challenge labels.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
CHALLENGE_PATH = ROOT / "data" / "evaluation" / "challenge_dev.json"


def _load_challenge() -> tuple[dict[str, Any], str]:
    raw_bytes = CHALLENGE_PATH.read_bytes()
    payload = json.loads(raw_bytes)
    if not isinstance(payload, dict) or payload.get("split") != "challenge_dev":
        raise ValueError("Expected the development-only challenge_dev document")
    if not isinstance(payload.get("dataset_version"), str) or not payload["dataset_version"]:
        raise ValueError("Challenge document is missing dataset_version")
    cases = payload.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ValueError("Challenge document must contain non-empty cases")

    seen_ids: set[str] = set()
    allowed_relationships = {"same", "different", "underdetermined"}
    expected_actions = {"same": "attach", "different": "separate", "underdetermined": "review"}
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError("Challenge contains a non-object case")
        case_id = case.get("id")
        relationship = case.get("relationship")
        if not isinstance(case_id, str) or not case_id or case_id in seen_ids:
            raise ValueError("Challenge contains a missing or duplicate case ID")
        seen_ids.add(case_id)
        if relationship not in allowed_relationships:
            raise ValueError(f"Challenge case {case_id} has an invalid relationship")
        if case.get("expected_action") != expected_actions[relationship]:
            raise ValueError(f"Challenge case {case_id} has an inconsistent expected_action")
        left, right = case.get("left"), case.get("right")
        if not isinstance(left, dict) or not isinstance(right, dict):
            raise ValueError(f"Challenge case {case_id} must have left and right reports")
        if any(
            left.get(key) != right.get(key) for key in ("zone_id", "sublocation", "reported_at")
        ):
            raise ValueError(
                f"Challenge case {case_id} must have matching zone, sublocation, and time"
            )
        for report in (left, right):
            if any(
                not isinstance(report.get(key), str) or not report[key].strip()
                for key in ("id", "text", "zone_id", "sublocation", "reported_at")
            ):
                raise ValueError(
                    f"Challenge case {case_id} contains an invalid report: non-empty report "
                    "text and known context are required"
                )
            timestamp = report["reported_at"].strip()
            if timestamp.endswith("Z"):
                timestamp = timestamp[:-1] + "+00:00"
            try:
                parsed_timestamp = datetime.fromisoformat(timestamp)
            except ValueError as exc:
                raise ValueError(
                    f"Challenge case {case_id} must contain a valid reported_at timestamp"
                ) from exc
            if parsed_timestamp.tzinfo is None or parsed_timestamp.utcoffset() is None:
                raise ValueError(f"Challenge case {case_id} reported_at must include a UTC offset")
            if report["id"] in seen_ids:
                raise ValueError(f"Challenge contains a duplicate report ID: {report['id']}")
            seen_ids.add(report["id"])
    return payload, hashlib.sha256(raw_bytes).hexdigest()


def _make_engine(mode: str) -> tuple[Any, dict[str, Any]]:
    from aegis.engine import AnalysisEngine

    engine = AnalysisEngine(model_loader=lambda: None) if mode == "lexical" else AnalysisEngine()
    health = engine.health()
    return engine, health


def _analyse(engine: Any, report: dict[str, Any]) -> dict[str, Any]:
    analysis = engine.analyze_report(
        report["text"],
        zone_id=report.get("zone_id"),
        sublocation=report.get("sublocation"),
        reported_at=report.get("reported_at"),
    )
    if not isinstance(analysis, dict):
        raise TypeError("analyze_report returned a non-object")
    return {**analysis, **report}


def _direction_result(
    engine: Any, incoming: dict[str, Any], candidate: dict[str, Any]
) -> dict[str, Any]:
    group_id = f"challenge-{candidate['id']}"
    groups = [{"id": group_id, "reports": [candidate]}]
    decision = engine.choose_group(incoming, groups)
    if not isinstance(decision, dict):
        raise TypeError("choose_group returned a non-object")
    evidence = decision.get("evidence")
    if not isinstance(evidence, list):
        evidence = []
    pair_evidence = [
        item
        for item in evidence
        if isinstance(item, dict)
        and item.get("report_id") == incoming["id"]
        and item.get("candidate_report_id") == candidate["id"]
    ]
    attached = decision.get("incident_id") == group_id
    has_suggest_evidence = any(item.get("decision") == "suggest" for item in pair_evidence)
    has_attach_evidence = any(item.get("decision") == "attach" for item in pair_evidence)
    if attached:
        action = "attach"
    elif has_suggest_evidence:
        action = "suggest"
    else:
        action = "separate"
    return {
        "incoming_id": incoming["id"],
        "candidate_id": candidate["id"],
        "action": action,
        "auto_attached": attached,
        "suggest_evidence": has_suggest_evidence,
        "attach_evidence": has_attach_evidence,
        "review_reasons": decision.get("review_reasons", []),
        "evidence": pair_evidence,
    }


def _case_outcome(
    case: dict[str, Any], left_to_right: dict[str, Any], right_to_left: dict[str, Any]
) -> dict[str, Any]:
    directions = [left_to_right, right_to_left]
    expected = case["expected_action"]
    relation = case["relationship"]
    any_attach = any(item["auto_attached"] for item in directions)
    both_attach = all(item["auto_attached"] for item in directions)
    any_suggest = any(item["suggest_evidence"] for item in directions)
    any_candidate = any(item["suggest_evidence"] or item["attach_evidence"] for item in directions)
    return {
        "id": case["id"],
        "relationship": relation,
        "expected_action": expected,
        "evidence_type": case.get("evidence_type"),
        "actual_action": (
            "attach"
            if both_attach
            else "attach_one_way"
            if any_attach
            else "suggest"
            if any_suggest
            else "separate"
        ),
        "any_direction_attached": any_attach,
        "both_directions_attached": both_attach,
        "has_suggest_evidence": any_suggest,
        "has_candidate_evidence_including_attach": any_candidate,
        "directions": {"left_to_right": left_to_right, "right_to_left": right_to_left},
    }


def _metrics(outcomes: list[dict[str, Any]]) -> dict[str, Any]:
    by_relationship: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for outcome in outcomes:
        by_relationship[outcome["relationship"]].append(outcome)

    def count(relation: str, predicate: Any) -> int:
        return sum(bool(predicate(item)) for item in by_relationship.get(relation, []))

    same = by_relationship.get("same", [])
    different = by_relationship.get("different", [])
    ambiguous = by_relationship.get("underdetermined", [])
    false_diff_attach = count("different", lambda item: item["any_direction_attached"])
    ambiguous_auto_attach = count("underdetermined", lambda item: item["any_direction_attached"])
    same_both_attach = count("same", lambda item: item["both_directions_attached"])
    same_either_attach = count("same", lambda item: item["any_direction_attached"])
    same_suggest = count("same", lambda item: item["has_suggest_evidence"])
    diff_suggest = count("different", lambda item: item["has_suggest_evidence"])
    ambiguous_suggest = count("underdetermined", lambda item: item["has_suggest_evidence"])
    same_candidate = count("same", lambda item: item["has_candidate_evidence_including_attach"])
    diff_candidate = count(
        "different", lambda item: item["has_candidate_evidence_including_attach"]
    )
    ambiguous_candidate = count(
        "underdetermined", lambda item: item["has_candidate_evidence_including_attach"]
    )
    total = len(outcomes)
    return {
        "case_count": total,
        "by_expected_action": {
            "attach": len(same),
            "separate": len(different),
            "review": len(ambiguous),
        },
        "same_event": {
            "both_direction_auto_attach": same_both_attach,
            "both_direction_attach_recall": same_both_attach / len(same) if same else None,
            "either_direction_auto_attach": same_either_attach,
            "either_direction_attach_recall": same_either_attach / len(same) if same else None,
            "suggest_evidence_cases": same_suggest,
            "suggest_evidence_recall": same_suggest / len(same) if same else None,
            "candidate_recall_including_attach": same_candidate / len(same) if same else None,
        },
        "different_event_safety": {
            "false_attachment_cases": false_diff_attach,
            "false_attachment_directions": sum(
                int(result["auto_attached"])
                for item in different
                for result in item["directions"].values()
            ),
            "false_suggestion_cases": diff_suggest,
            "different_event_candidate_cases_including_attach": diff_candidate,
        },
        "underdetermined_safety": {
            "unjustified_auto_attach_cases": ambiguous_auto_attach,
            "unjustified_auto_attach_directions": sum(
                int(result["auto_attached"])
                for item in ambiguous
                for result in item["directions"].values()
            ),
            "human_review_candidate_cases": ambiguous_suggest,
            "underdetermined_candidate_cases_including_attach": ambiguous_candidate,
        },
        "non_same_safety": {
            "identifiable_false_attachment_cases": false_diff_attach,
            "underdetermined_unjustified_attachment_cases": ambiguous_auto_attach,
            "total_non_same_auto_attach_cases": false_diff_attach + ambiguous_auto_attach,
            "false_identifiable_different_suggestion_cases": diff_suggest,
            "underdetermined_human_review_candidate_cases": ambiguous_suggest,
        },
        "total_directional_evaluations": sum(len(item.get("directions", {})) for item in outcomes),
    }


def evaluate(mode: str) -> dict[str, Any]:
    # Add backend to sys.path only for this repository-local script.
    sys.path.insert(0, str(ROOT / "backend"))
    payload, data_hash = _load_challenge()
    engine, health = _make_engine(mode)
    cache: dict[str, dict[str, Any]] = {}
    analysis_errors: dict[str, str] = {}
    analysis_ms: dict[str, float] = {}

    # Analyze each unique report once using the ordinary engine method. Pair
    # grouping is then evaluated both ways from these unchanged report objects.
    all_reports = [report for case in payload["cases"] for report in (case["left"], case["right"])]
    for report in all_reports:
        started = time.perf_counter_ns()
        try:
            cache[report["id"]] = _analyse(engine, report)
        except Exception as exc:  # Preserve failures in the result rather than skipping cases.
            analysis_errors[report["id"]] = f"{type(exc).__name__}: {exc}"
        analysis_ms[report["id"]] = (time.perf_counter_ns() - started) / 1_000_000

    outcomes = []
    grouping_errors: list[dict[str, str]] = []
    grouping_evaluations = 0
    grouping_elapsed_ms = 0.0
    for case in payload["cases"]:
        left_id, right_id = case["left"]["id"], case["right"]["id"]
        if left_id in analysis_errors or right_id in analysis_errors:
            error = (
                analysis_errors.get(left_id) or analysis_errors.get(right_id) or "analysis failed"
            )
            outcomes.append(
                {
                    "id": case["id"],
                    "relationship": case["relationship"],
                    "expected_action": case["expected_action"],
                    "evidence_type": case.get("evidence_type"),
                    "actual_action": "error",
                    "any_direction_attached": False,
                    "both_directions_attached": False,
                    "has_suggest_evidence": False,
                    "has_candidate_evidence_including_attach": False,
                    "error": error,
                    "directions": {},
                }
            )
            continue
        directions: dict[str, dict[str, Any]] = {}
        for direction, incoming_id, candidate_id in (
            ("left_to_right", left_id, right_id),
            ("right_to_left", right_id, left_id),
        ):
            grouping_evaluations += 1
            started = time.perf_counter_ns()
            try:
                directions[direction] = _direction_result(
                    engine, cache[incoming_id], cache[candidate_id]
                )
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"
                grouping_errors.append(
                    {"case_id": case["id"], "direction": direction, "error": error}
                )
                directions[direction] = {
                    "incoming_id": incoming_id,
                    "candidate_id": candidate_id,
                    "action": "error",
                    "auto_attached": False,
                    "suggest_evidence": False,
                    "attach_evidence": False,
                    "review_reasons": [],
                    "evidence": [],
                    "error": error,
                }
            finally:
                grouping_elapsed_ms += (time.perf_counter_ns() - started) / 1_000_000
        outcomes.append(
            _case_outcome(case, directions["left_to_right"], directions["right_to_left"])
        )

    from aegis import engine as engine_module

    elapsed_analysis = sum(analysis_ms.values())
    observed_revisions = Counter(str(report.get("model_revision")) for report in cache.values())
    return {
        "scope": "challenge_dev only; no held-out evaluation files are read",
        "dataset_version": payload["dataset_version"],
        "challenge_purpose": payload.get("purpose"),
        "label_policy": payload.get("label_policy"),
        "data_sha256": data_hash,
        "engine_mode_requested": mode,
        "initial_engine_health": health,
        "engine_config_version": getattr(engine, "config_version", None),
        "initial_declared_model_revision": health.get("model_revision"),
        "observed_model_mode": (
            "semantic"
            if set(observed_revisions) == {engine_module.MODEL_REVISION}
            else "lexical"
            if set(observed_revisions) == {engine_module.LEXICAL_REVISION}
            else "mixed"
            if observed_revisions
            else "none"
        ),
        "observed_model_revision": (
            next(iter(observed_revisions))
            if len(observed_revisions) == 1
            and next(iter(observed_revisions)) == engine_module.MODEL_REVISION
            else None
        ),
        "observed_report_model_revisions": dict(observed_revisions),
        "observed_report_count": len(cache),
        "thresholds": {
            "semantic_attach": engine_module._ATTACH_THRESHOLD,
            "semantic_suggest": engine_module._SUGGEST_THRESHOLD,
            "semantic_anchor_minimum": engine_module._ANCHOR_SEMANTIC_MINIMUM,
            "semantic_review": engine_module._SEMANTIC_REVIEW_THRESHOLD,
            "semantic_review_anchor_minimum": engine_module._SEMANTIC_REVIEW_ANCHOR_MINIMUM,
            "lexical_attach": engine_module._LEXICAL_ATTACH_THRESHOLD,
            "lexical_suggest": engine_module._LEXICAL_SUGGEST_THRESHOLD,
            "lexical_anchor_minimum": engine_module._LEXICAL_ANCHOR_MINIMUM,
            "runner_up_margin": engine_module._RUNNER_UP_MARGIN,
        },
        "summary": _metrics(outcomes),
        "analysis_failure_count": len(analysis_errors),
        "analysis_failures": analysis_errors,
        "grouping_failure_count": len(grouping_errors),
        "grouping_failures": grouping_errors,
        "timing_ms": {
            "analysis_total": round(elapsed_analysis, 3),
            "analysis_per_report_mean": (
                round(elapsed_analysis / len(analysis_ms), 3) if analysis_ms else None
            ),
            "grouping_total": round(grouping_elapsed_ms, 3),
            "grouping_evaluations": grouping_evaluations,
        },
        "cases": outcomes,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=("runtime", "lexical"),
        default="runtime",
        help="Use the normal runtime engine (default) or force its lexical fallback.",
    )
    parser.add_argument("--output", type=Path, help="Write JSON here instead of stdout.")
    args = parser.parse_args()
    result = evaluate(args.mode)
    encoded = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    if args.output is not None:
        args.output.write_text(encoded, encoding="utf-8")
    else:
        sys.stdout.write(encoded)
    return 1 if result["analysis_failure_count"] or result["grouping_failure_count"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
