"""Reproducible synthetic evaluation for Aegis report grouping.

Only the held-out test split is used by run_evaluation. The development labels
are retained separately and are never passed to the engine. Metrics are
pairwise: false_merges counts incorrect co-grouped report pairs, and
missed_pairs counts true same-incident pairs left apart.
"""

from __future__ import annotations

import json
import math
import re
import time
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from itertools import combinations
from pathlib import Path
from typing import Any

_DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "evaluation"
_SPLIT = "test"
_TOKEN_RE = re.compile(r"[a-z0-9]+")
_STOP_WORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "at",
        "by",
        "for",
        "from",
        "has",
        "have",
        "i",
        "in",
        "is",
        "it",
        "near",
        "of",
        "on",
        "or",
        "the",
        "there",
        "to",
        "was",
        "were",
        "with",
    }
)
_LEXICAL_THRESHOLD = 0.30
_SEMANTIC_THRESHOLD = 0.78
_AMBIGUITY_MARGIN = 0.08
_MAX_CONTEXT_GAP_SECONDS = 20 * 60
_EXPECTED_REPORTS = {"demo": 24, "dev": 60, "test": 60}
_EXPECTED_GROUPS = {"demo": 8, "dev": 20, "test": 20}


def _load_split(split: str = _SPLIT) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
    """Read test inputs and labels, validating their separated documents."""
    input_path = _DATA_DIR / f"{split}_inputs.json"
    label_path = _DATA_DIR / f"{split}_labels.json"
    try:
        inputs = json.loads(input_path.read_text(encoding="utf-8"))
        labels = json.loads(label_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Unable to load the {split} evaluation fixtures: {exc}") from exc

    if not isinstance(inputs, dict) or not isinstance(labels, dict):
        raise ValueError(f"The {split} evaluation documents must be JSON objects")
    version = inputs.get("dataset_version")
    if not isinstance(version, str) or not version or labels.get("dataset_version") != version:
        raise ValueError(f"The {split} inputs and labels have mismatched dataset versions")
    if inputs.get("split") != split or labels.get("split") != split:
        raise ValueError(f"The evaluation documents are not both marked as {split}")

    reports = inputs.get("reports")
    report_groups = labels.get("report_groups")
    groups = labels.get("groups")
    if (
        not isinstance(reports, list)
        or not isinstance(report_groups, dict)
        or not isinstance(groups, list)
    ):
        raise ValueError(
            f"The {split} evaluation documents have invalid report or label collections"
        )
    report_ids: list[str] = []
    for report in reports:
        if not isinstance(report, dict):
            raise ValueError(f"The {split} input contains a non-object report")
        report_id = report.get("id")
        if not isinstance(report_id, str) or not report_id or report_id in report_ids:
            raise ValueError(f"The {split} input contains a missing or duplicate report ID")
        if not isinstance(report.get("text"), str) or not report["text"].strip():
            raise ValueError(f"Evaluation report {report_id!r} has no text")
        report_ids.append(report_id)
    if set(report_groups) != set(report_ids):
        raise ValueError(f"The {split} labels must cover exactly the input report IDs")
    if any(not isinstance(group_id, str) or not group_id for group_id in report_groups.values()):
        raise ValueError(f"The {split} labels contain an invalid incident-family ID")
    declared_group_ids: set[str] = set()
    for group in groups:
        group_id = group.get("id") if isinstance(group, dict) else None
        if not isinstance(group_id, str) or not group_id:
            raise ValueError(f"The {split} group index contains an invalid incident-family ID")
        declared_group_ids.add(group_id)
    if declared_group_ids != set(report_groups.values()):
        raise ValueError(f"The {split} group index does not match report-family labels")
    return version, reports, labels


def _create_engine(engine: Any | None) -> tuple[Any | None, str | None]:
    if engine is not None:
        return engine, None
    try:
        from .engine import AnalysisEngine

        return AnalysisEngine(), None
    except Exception as exc:  # Import/model setup errors should appear in results.
        return None, f"Unable to initialize AnalysisEngine: {type(exc).__name__}: {exc}"


def _as_review_reasons(value: Any) -> list[str]:
    if not isinstance(value, (list, tuple)):
        return []
    return [str(reason) for reason in value if str(reason).strip()]


def _engine_mode(health: Mapping[str, Any]) -> str:
    mode = health.get("engine")
    if not isinstance(mode, str) or not mode.strip():
        return "unknown"
    return mode.strip().casefold()


def _model_name(health: Mapping[str, Any], mode: str) -> str:
    revision = health.get("model_revision")
    return (
        str(revision) if isinstance(revision, str) and revision else f"none (engine mode: {mode})"
    )


def _observed_model(
    health: Mapping[str, Any],
    mode: str,
    reports: Sequence[Mapping[str, Any]],
) -> tuple[str, str]:
    revisions = sorted(
        {
            revision
            for report in reports
            if isinstance((revision := report.get("model_revision")), str) and revision
        }
    )
    if len(revisions) == 1:
        observed_mode = "lexical" if revisions[0].startswith("lexical-") else mode
        return revisions[0], observed_mode
    if len(revisions) > 1:
        return "mixed revisions: " + ", ".join(revisions), "mixed"
    return _model_name(health, mode), mode


def _token_set(text: str) -> set[str]:
    return {token for token in _TOKEN_RE.findall(text.casefold()) if token not in _STOP_WORDS}


def _jaccard(left: str, right: str) -> float:
    left_tokens = _token_set(left)
    right_tokens = _token_set(right)
    union = left_tokens | right_tokens
    if not union:
        return 0.0
    return len(left_tokens & right_tokens) / len(union)


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(UTC)


def _context_relation(
    incoming: Mapping[str, Any], candidate: Mapping[str, Any]
) -> tuple[bool, bool]:
    """Return (compatible, missing required context) for the lexical baseline."""
    missing = False
    incoming_zone = incoming.get("zone_id")
    candidate_zone = candidate.get("zone_id")
    if not incoming_zone or not candidate_zone:
        missing = True
    elif incoming_zone != candidate_zone:
        return False, False

    incoming_time = _parse_time(incoming.get("reported_at"))
    candidate_time = _parse_time(candidate.get("reported_at"))
    if incoming_time is None or candidate_time is None:
        missing = True
    elif abs((incoming_time - candidate_time).total_seconds()) > _MAX_CONTEXT_GAP_SECONDS:
        return False, False
    return not missing, missing


def _metric_row(
    method: str,
    report_ids: Sequence[str],
    truth: Mapping[str, str],
    predictions: Mapping[str, str],
    review_ids: set[str],
) -> dict[str, Any]:
    true_pairs = false_pairs = missed_pairs = 0
    for left, right in combinations(report_ids, 2):
        same_truth = truth[left] == truth[right]
        same_prediction = predictions[left] == predictions[right]
        if same_truth and same_prediction:
            true_pairs += 1
        elif same_truth:
            missed_pairs += 1
        elif same_prediction:
            false_pairs += 1
    precision = true_pairs / (true_pairs + false_pairs) if true_pairs + false_pairs else 0.0
    recall = true_pairs / (true_pairs + missed_pairs) if true_pairs + missed_pairs else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    review_rate = len(review_ids.intersection(report_ids)) / len(report_ids) if report_ids else 0.0
    return {
        "method": method,
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "f1": round(f1, 6),
        "false_merges": false_pairs,
        "missed_pairs": missed_pairs,
        "review_rate": round(review_rate, 6),
    }


def _run_comparator(
    reports: Sequence[Mapping[str, Any]],
    scorer: Any,
    threshold: float,
    *,
    require_context: bool,
) -> tuple[dict[str, str], set[str]]:
    groups: list[dict[str, Any]] = []
    predictions: dict[str, str] = {}
    review_ids: set[str] = set()
    for report in reports:
        report_id = str(report["id"])
        candidates: list[tuple[float, dict[str, Any]]] = []
        missing_context = False
        near_threshold_scores: list[float] = []
        for group in groups:
            anchor = group["reports"][0]
            score = scorer(report, anchor)
            if score is None:
                continue
            if require_context:
                compatible, missing = _context_relation(report, anchor)
                if missing:
                    if score >= threshold - _AMBIGUITY_MARGIN:
                        missing_context = True
                    continue
                if not compatible:
                    continue
            if score >= threshold:
                candidates.append((score, group))
            elif require_context and score >= threshold - _AMBIGUITY_MARGIN:
                near_threshold_scores.append(score)
        candidates.sort(key=lambda item: (-item[0], item[1]["id"]))
        close_runner_up = (
            len(candidates) > 1 and candidates[0][0] - candidates[1][0] < _AMBIGUITY_MARGIN
        )
        if candidates and not close_runner_up:
            selected = candidates[0][1]
            selected["reports"].append(report)
            predictions[report_id] = selected["id"]
            if missing_context:
                review_ids.add(report_id)
            continue
        best_uncertain = bool(near_threshold_scores) if require_context else False
        if missing_context or best_uncertain or close_runner_up:
            review_ids.add(report_id)
        group_id = f"baseline-{len(groups) + 1:03d}"
        groups.append({"id": group_id, "reports": [report]})
        predictions[report_id] = group_id
    return predictions, review_ids


def _as_vector(value: Any) -> tuple[float, ...] | None:
    if value is None or isinstance(value, (str, bytes, Mapping)):
        return None
    try:
        vector = tuple(float(item) for item in value)
    except TypeError, ValueError, OverflowError:
        return None
    if not vector or any(not math.isfinite(item) for item in vector):
        return None
    return vector


def _cosine(left: Mapping[str, Any], right: Mapping[str, Any]) -> float | None:
    left_vector = _as_vector(left.get("embedding"))
    right_vector = _as_vector(right.get("embedding"))
    if left_vector is None or right_vector is None or len(left_vector) != len(right_vector):
        return None
    left_norm = math.sqrt(sum(value * value for value in left_vector))
    right_norm = math.sqrt(sum(value * value for value in right_vector))
    if left_norm == 0.0 or right_norm == 0.0:
        return None
    return sum(a * b for a, b in zip(left_vector, right_vector, strict=True)) / (
        left_norm * right_norm
    )


def _all_embeddings_available(reports: Sequence[Mapping[str, Any]]) -> bool:
    vectors = [_as_vector(report.get("embedding")) for report in reports]
    if not vectors or any(vector is None for vector in vectors):
        return False
    return len({len(vector) for vector in vectors if vector is not None}) == 1


def _run_engine(
    engine: Any,
    reports: Sequence[dict[str, Any]],
    failures: list[str],
) -> tuple[dict[str, str], set[str], list[dict[str, Any]], list[float]]:
    groups: list[dict[str, Any]] = []
    predictions: dict[str, str] = {}
    review_ids: set[str] = set()
    prepared: list[dict[str, Any]] = []
    latencies: list[float] = []
    for raw in reports:
        report_id = raw["id"]
        elapsed_start = time.perf_counter_ns()
        try:
            analysis = engine.analyze_report(
                raw["text"],
                zone_id=raw.get("zone_id"),
                sublocation=raw.get("sublocation"),
                reported_at=raw.get("reported_at"),
            )
            if not isinstance(analysis, dict):
                raise TypeError("analyze_report must return a dictionary")
            report = {**analysis, **raw}
            report["review_reasons"] = _as_review_reasons(analysis.get("review_reasons"))
        except Exception as exc:
            failures.append(f"Analysis failed for {report_id}: {type(exc).__name__}: {exc}")
            report = {**raw, "claims": [], "embedding": None, "review_reasons": ["analysis failed"]}
            review_ids.add(report_id)
            prepared.append(report)
            latencies.append((time.perf_counter_ns() - elapsed_start) / 1_000_000)
            group_id = f"engine-{len(groups) + 1:03d}"
            groups.append({"id": group_id, "reports": [report]})
            predictions[report_id] = group_id
            continue

        prepared.append(report)
        if report["review_reasons"]:
            review_ids.add(report_id)
        try:
            chosen = engine.choose_group(report, groups)
            if not isinstance(chosen, dict):
                raise TypeError("choose_group must return a dictionary")
            incident_id = chosen.get("incident_id")
            reasons = _as_review_reasons(chosen.get("review_reasons"))
            report["matching_reasons"] = reasons
            report["matching_evidence"] = chosen.get("evidence", [])
            if reasons:
                review_ids.add(report_id)
            selected = next((group for group in groups if group["id"] == incident_id), None)
            if incident_id is not None and selected is None:
                raise ValueError("choose_group returned an unknown incident_id")
            if selected is None:
                selected = {"id": f"engine-{len(groups) + 1:03d}", "reports": []}
                groups.append(selected)
            selected["reports"].append(report)
            predictions[report_id] = selected["id"]
        except Exception as exc:
            failures.append(f"Grouping failed for {report_id}: {type(exc).__name__}: {exc}")
            review_ids.add(report_id)
            group_id = f"engine-{len(groups) + 1:03d}"
            groups.append({"id": group_id, "reports": [report]})
            predictions[report_id] = group_id
        latencies.append((time.perf_counter_ns() - elapsed_start) / 1_000_000)
    return predictions, review_ids, prepared, latencies


def _percentile(values: Sequence[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = max(0, math.ceil(percentile * len(ordered)) - 1)
    return round(ordered[position], 3)


def _ground_truth_policy_checks(
    engine: Any | None,
    labels: Mapping[str, Any],
    prepared: Sequence[dict[str, Any]],
    failures: list[str],
) -> list[dict[str, Any]]:
    policy_cases = labels.get("policy_cases", {})
    report_groups = labels["report_groups"]
    expected_cases = [
        (group_id, expected) for group_id, expected in policy_cases.items() if expected == "P0"
    ]
    negative_cases = [
        (group_id, expected) for group_id, expected in policy_cases.items() if expected == "NOT_P0"
    ]
    policy_results: dict[str, str] = {}
    if engine is not None and callable(getattr(engine, "assess_priority", None)):
        for group_id, _expected in expected_cases + negative_cases:
            members = [report for report in prepared if report_groups.get(report["id"]) == group_id]
            try:
                assessment = engine.assess_priority(members)
                if not isinstance(assessment, dict):
                    raise TypeError("assess_priority must return a dictionary")
                policy_results[group_id] = str(assessment.get("priority", "UNASSESSED"))
            except Exception as exc:
                failures.append(
                    f"Priority policy check failed for {group_id}: {type(exc).__name__}: {exc}"
                )
    p0_pass = bool(expected_cases) and all(
        policy_results.get(group_id) == "P0" for group_id, _ in expected_cases
    )
    valid_policy_values = {"P0", "P1", "P2", "UNASSESSED"}
    negative_results_present = all(
        group_id in policy_results and policy_results[group_id] in valid_policy_values
        for group_id, _ in negative_cases
    )
    no_false_p0 = (
        bool(negative_cases)
        and negative_results_present
        and all(policy_results[group_id] != "P0" for group_id, _ in negative_cases)
    )
    p0_count = sum(policy_results.get(group_id) == "P0" for group_id, _ in expected_cases)
    negative_count = sum(
        group_id in policy_results
        and policy_results[group_id] in valid_policy_values
        and policy_results[group_id] != "P0"
        for group_id, _ in negative_cases
    )
    return [
        {
            "name": "explicit P0 policy cases",
            "passed": p0_pass,
            "detail": (
                f"P0 returned for {p0_count} of {len(expected_cases)} explicit danger cases."
            ),
        },
        {
            "name": "negated or hypothetical cases avoid P0",
            "passed": no_false_p0,
            "detail": (
                "No P0 returned for "
                f"{negative_count} "
                f"of {len(negative_cases)} negative-control groups."
            ),
        },
    ]


def _conflict_check(
    engine: Any | None,
    labels: Mapping[str, Any],
    prepared: Sequence[dict[str, Any]],
    failures: list[str],
) -> dict[str, Any]:
    expected_groups = labels.get("conflict_groups", [])
    report_groups = labels["report_groups"]
    found = 0
    if engine is not None and callable(getattr(engine, "detect_conflicts", None)):
        for group_id in expected_groups:
            members = [report for report in prepared if report_groups.get(report["id"]) == group_id]
            try:
                conflicts = engine.detect_conflicts(members)
                if not isinstance(conflicts, list):
                    raise TypeError("detect_conflicts must return a list")
                if conflicts:
                    found += 1
            except Exception as exc:
                failures.append(
                    f"Conflict check failed for {group_id}: {type(exc).__name__}: {exc}"
                )
    total = len(expected_groups)
    return {
        "name": "contradictory or changing reports stay visible",
        "passed": total > 0 and found == total,
        "detail": f"A conflict was returned for {found} of {total} labeled changing-report groups.",
    }


def _incomplete_check(
    engine: Any | None,
    labels: Mapping[str, Any],
    prepared: Sequence[dict[str, Any]],
    failures: list[str],
) -> dict[str, Any]:
    expected_groups = labels.get("review_groups", [])
    report_groups = labels["report_groups"]
    incomplete_reviews = 0
    if engine is not None and callable(getattr(engine, "assess_priority", None)):
        for group_id in expected_groups:
            members = [report for report in prepared if report_groups.get(report["id"]) == group_id]
            try:
                assessment = engine.assess_priority(members)
                if not isinstance(assessment, dict):
                    raise TypeError("assess_priority must return a dictionary")
                has_review_flag = any(report.get("review_reasons") for report in members)
                if assessment.get("priority") == "UNASSESSED" or has_review_flag:
                    incomplete_reviews += 1
            except Exception as exc:
                failures.append(
                    f"Incomplete-report check failed for {group_id}: {type(exc).__name__}: {exc}"
                )
    total = len(expected_groups)
    return {
        "name": "incomplete reports remain reviewable",
        "passed": total > 0 and incomplete_reviews == total,
        "detail": (
            f"{incomplete_reviews} of {total} labeled incomplete groups "
            "are unassessed or carry a review reason."
        ),
    }


def _format_engine_method(mode: str, model_ready: Any) -> tuple[str, list[str]]:
    limitations: list[str] = []
    if mode == "mixed":
        limitations.append(
            "The test run used more than one analysis model revision; no single semantic "
            "baseline is reported."
        )
        return "Aegis mixed model + context", limitations
    if "lexical" in mode or "degraded" in mode or model_ready is False:
        limitations.append(
            "The active Aegis engine used lexical/degraded mode; no semantic result is reported."
        )
        return "Aegis contextual lexical (degraded)", limitations
    if "semantic" in mode:
        return "Aegis semantic + context", limitations
    limitations.append(
        f"The engine mode '{mode}' was not identified as semantic; "
        "results retain the reported mode."
    )
    return f"Aegis engine ({mode})", limitations


def _error_examples(
    reports: Sequence[dict[str, Any]],
    truth: Mapping[str, str],
    predictions: Mapping[str, str],
    method: str,
) -> list[dict[str, Any]]:
    """Return bounded, real grouping mistakes rather than only runtime failures."""
    examples = []
    for left, right in combinations(reports, 2):
        left_id, right_id = left["id"], right["id"]
        expected = truth[left_id] == truth[right_id]
        predicted = predictions[left_id] == predictions[right_id]
        if expected == predicted:
            continue
        context = list(
            dict.fromkeys(
                left.get("matching_reasons", [])
                + right.get("matching_reasons", [])
                + left.get("review_reasons", [])
                + right.get("review_reasons", [])
            )
        )
        pair_reasons = [
            reason
            for evidence in right.get("matching_evidence", [])
            if evidence.get("candidate_report_id") == left_id
            for reason in evidence["reasons"]
        ]
        reasons = pair_reasons or [f"Report-level review context: {reason}" for reason in context]
        examples.append(
            {
                "kind": "missed_pair" if expected else "false_merge",
                "method": method,
                "report_ids": [left_id, right_id],
                "texts": [left["text"], right["text"]],
                "expected_same_incident": expected,
                "predicted_same_incident": predicted,
                "reasons": reasons,
            }
        )
        if len(examples) == 40:
            break
    return examples


def _review_workload(
    truth: Mapping[str, str], predictions: Mapping[str, str], review_ids: set[str]
) -> dict[str, Any]:
    """Count partition corrections with ground truth, without claiming observed operator time."""
    predicted_groups: dict[str, set[str]] = {}
    true_groups: dict[str, set[str]] = {}
    for report_id, predicted_id in predictions.items():
        true_id = truth[report_id]
        predicted_groups.setdefault(predicted_id, set()).add(true_id)
        true_groups.setdefault(true_id, set()).add(predicted_id)
    return {
        "reports": len(predictions),
        "review_reports": len(review_ids.intersection(predictions)),
        "proposed_groups": len(predicted_groups),
        "confirmation_groups": len(predicted_groups),
        "split_operations": sum(len(group) - 1 for group in predicted_groups.values()),
        "merge_operations": sum(len(group) - 1 for group in true_groups.values()),
        "basis": (
            "Synthetic ground-truth partition corrections: first separate each mixed group, "
            "then join fragments of each true incident. One confirmation per proposed group. "
            "These are idealized grouping operations, not measured clicks or operator time."
        ),
    }


def run_evaluation(engine: Any | None = None) -> dict[str, Any]:
    """Run the held-out test split and return the API's Evaluation shape.

    A semantic cosine baseline is included only when the active engine truthfully
    reports semantic mode and supplies usable embeddings. The engine result name
    reflects its reported mode, including lexical fallback. Without an engine,
    only the explicit lexical baseline is scored and latency is unavailable.
    """
    generated_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    failures: list[str] = []
    limitations = [
        "All reports and incident labels are synthetic; this small fixed test split does not "
        "establish operational accuracy.",
        "Grouping metrics count report pairs; latency is per-report analysis plus incremental "
        "grouping on this process and hardware.",
        "The lexical baseline uses token-set Jaccard similarity with simple zone/time gates; "
        "it is not TF-IDF.",
    ]
    try:
        dataset_version, raw_reports, labels = _load_split()
    except (OSError, RuntimeError, ValueError, TypeError) as exc:
        failures.append(f"Evaluation data unavailable: {type(exc).__name__}: {exc}")
        return {
            "dataset_version": "unavailable",
            "model": "unavailable",
            "config_version": "unavailable",
            "generated_at": generated_at,
            "results": [],
            "checks": [
                {
                    "name": "evaluation fixtures available",
                    "passed": False,
                    "detail": failures[-1],
                }
            ],
            "latency": {"p50_ms": None, "p95_ms": None},
            "limitations": limitations,
            "failures": failures,
        }

    active_engine, init_error = _create_engine(engine)
    if init_error:
        failures.append(init_error)
    health: dict[str, Any] = {}
    if active_engine is not None:
        try:
            raw_health = active_engine.health()
            if not isinstance(raw_health, dict):
                raise TypeError("health must return a dictionary")
            health = raw_health
        except Exception as exc:
            failures.append(f"Engine health failed: {type(exc).__name__}: {exc}")
            active_engine = None
    mode = _engine_mode(health) if active_engine is not None else "unavailable"
    model = _model_name(health, mode)
    config_version = (
        getattr(active_engine, "config_version", None) if active_engine is not None else None
    )
    if not isinstance(config_version, str) or not config_version:
        config_version = str(health.get("config_version") or "unreported")
        limitations.append("The active engine did not report a matching configuration version.")

    truth: dict[str, str] = labels["report_groups"]
    truth_group_count = len(set(truth.values()))
    if (
        len(raw_reports) != _EXPECTED_REPORTS[_SPLIT]
        or truth_group_count != _EXPECTED_GROUPS[_SPLIT]
    ):
        limitations.append("Fixture cardinality differs from the documented held-out split target.")
    prepared: list[dict[str, Any]]
    predictions: dict[str, str] = {}
    review_ids: set[str] = set()
    latencies: list[float] = []
    if active_engine is not None:
        predictions, review_ids, prepared, latencies = _run_engine(
            active_engine, raw_reports, failures
        )
    else:
        prepared = [
            dict(report, claims=[], embedding=None, review_reasons=["engine unavailable"])
            for report in raw_reports
        ]
        review_ids = {report["id"] for report in raw_reports}
        for index, report in enumerate(raw_reports, start=1):
            predictions[report["id"]] = f"unavailable-{index:03d}"
    model, mode = _observed_model(health, mode, prepared)

    report_ids = [report["id"] for report in raw_reports]
    lexical_predictions, lexical_reviews = _run_comparator(
        raw_reports,
        lambda left, right: _jaccard(left["text"], right["text"]),
        _LEXICAL_THRESHOLD,
        require_context=True,
    )
    results = [
        _metric_row(
            "Lexical Jaccard baseline", report_ids, truth, lexical_predictions, lexical_reviews
        )
    ]
    if active_engine is not None:
        engine_method, method_limitations = _format_engine_method(mode, health.get("model_ready"))
        limitations.extend(method_limitations)
        results.append(_metric_row(engine_method, report_ids, truth, predictions, review_ids))
        if "semantic" in mode and health.get("model_ready") is not False:
            if _all_embeddings_available(prepared):
                semantic_predictions, semantic_reviews = _run_comparator(
                    prepared,
                    _cosine,
                    _SEMANTIC_THRESHOLD,
                    require_context=False,
                )
                results.insert(
                    1,
                    _metric_row(
                        "Semantic cosine baseline",
                        report_ids,
                        truth,
                        semantic_predictions,
                        semantic_reviews,
                    ),
                )
            else:
                limitations.append(
                    "Semantic embeddings were not available for every test report; a separate "
                    "semantic baseline was not computed."
                )
    else:
        limitations.append(
            "Aegis analysis was unavailable; only the explicit lexical baseline was scored."
        )

    expected_policy_checks = _ground_truth_policy_checks(active_engine, labels, prepared, failures)
    conflict_check = _conflict_check(active_engine, labels, prepared, failures)
    incomplete_check = _incomplete_check(active_engine, labels, prepared, failures)
    checks = [
        {
            "name": "all reports retained",
            "passed": len(prepared) == len(raw_reports) and len(predictions) == len(raw_reports),
            "detail": (
                f"{len(prepared)} of {len(raw_reports)} input reports "
                "have a visible evaluation outcome."
            ),
        },
        {
            "name": "held-out fixture cardinality",
            "passed": len(raw_reports) == _EXPECTED_REPORTS[_SPLIT]
            and truth_group_count == _EXPECTED_GROUPS[_SPLIT],
            "detail": (
                f"{len(raw_reports)} reports across {truth_group_count} incident families; "
                "target is 60 reports and 20 families."
            ),
        },
        *expected_policy_checks,
        conflict_check,
        incomplete_check,
    ]
    return {
        "dataset_version": dataset_version,
        "model": model,
        "config_version": config_version,
        "generated_at": generated_at,
        "results": results,
        "checks": checks,
        "latency": {"p50_ms": _percentile(latencies, 0.5), "p95_ms": _percentile(latencies, 0.95)},
        "limitations": limitations,
        "failures": failures,
        "error_examples": (
            _error_examples(prepared, truth, predictions, engine_method)
            if active_engine is not None
            else []
        ),
        "workload": (
            _review_workload(truth, predictions, review_ids) if active_engine is not None else None
        ),
    }
