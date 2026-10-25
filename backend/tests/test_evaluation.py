from __future__ import annotations

import json
import math
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from backend.aegis import evaluation
from backend.aegis.engine import AnalysisEngine


def _report(
    report_id: str = "r1",
    text: str = "A person is waiting by the main stage.",
    *,
    zone_id: str | None = "stage",
    sublocation: str | None = "north aisle",
    reported_at: str | None = "2026-10-25T06:30:00Z",
) -> dict[str, object]:
    return {
        "id": report_id,
        "text": text,
        "zone_id": zone_id,
        "sublocation": sublocation,
        "reported_at": reported_at,
    }


class StubEngine:
    config_version = "stub-config-v1"

    def __init__(
        self,
        *,
        mode: str = "lexical",
        model_ready: bool = False,
        choice: str = "singleton",
        fail_analysis_for: str | None = None,
        malformed_analysis_for: str | None = None,
        fail_grouping_for: str | None = None,
        malformed_grouping_for: str | None = None,
        unknown_group_for: str | None = None,
        fail_health: bool = False,
        malformed_health: bool = False,
        fail_policy: bool = False,
        malformed_policy: bool = False,
        priority_override: str | None = None,
        fail_conflicts: bool = False,
        malformed_conflicts: bool = False,
        semantic_vectors: bool = True,
        lexical_fallback_for_text: str | None = None,
    ) -> None:
        self.mode = mode
        self.model_ready = model_ready
        self.choice = choice
        self.fail_analysis_for = fail_analysis_for
        self.malformed_analysis_for = malformed_analysis_for
        self.fail_grouping_for = fail_grouping_for
        self.malformed_grouping_for = malformed_grouping_for
        self.unknown_group_for = unknown_group_for
        self.fail_health = fail_health
        self.malformed_health = malformed_health
        self.fail_policy = fail_policy
        self.malformed_policy = malformed_policy
        self.priority_override = priority_override
        self.fail_conflicts = fail_conflicts
        self.malformed_conflicts = malformed_conflicts
        self.semantic_vectors = semantic_vectors
        self.lexical_fallback_for_text = lexical_fallback_for_text

    def health(self) -> dict[str, object] | None:
        if self.fail_health:
            raise RuntimeError("health failure")
        if self.malformed_health:
            return None
        return {
            "status": "ready" if self.model_ready else "degraded",
            "engine": self.mode,
            "model_ready": self.model_ready,
            "model_revision": "stub-model-v1" if self.model_ready else None,
        }

    def analyze_report(
        self,
        text: str,
        *,
        zone_id: str | None = None,
        sublocation: str | None = None,
        reported_at: str | None = None,
    ) -> dict[str, object] | None:
        if text == self.fail_analysis_for:
            raise RuntimeError("analysis failure")
        if text == self.malformed_analysis_for:
            return None
        semantic_available = self.mode == "semantic" and self.semantic_vectors
        is_lexical_fallback = text == self.lexical_fallback_for_text
        embedding = [1.0, 0.0] if semantic_available else None
        model_revision = "stub-model-v1" if embedding is not None else None
        if semantic_available and is_lexical_fallback:
            model_revision = "lexical-hash-v1"
        reasons = ["review this report"] if zone_id is None or reported_at is None else []
        return {
            "category": "other",
            "claims": [],
            "priority": "UNASSESSED",
            "priority_reason": "Stub policy.",
            "review_reasons": reasons,
            "embedding": embedding,
            "model_revision": model_revision,
        }

    def choose_group(
        self, incoming: dict[str, object], groups: list[dict[str, object]]
    ) -> dict[str, object] | None:
        report_id = str(incoming["id"])
        if report_id == self.fail_grouping_for:
            raise RuntimeError("grouping failure")
        if report_id == self.malformed_grouping_for:
            return None
        if report_id == self.unknown_group_for:
            return {"incident_id": "not-a-known-group", "review_reasons": []}
        if self.choice == "attach" and groups:
            return {"incident_id": groups[0]["id"], "review_reasons": ["provisional"]}
        if self.choice == "malformed":
            return []
        return {"incident_id": None, "review_reasons": []}

    def assess_priority(self, reports: list[dict[str, object]]) -> dict[str, str] | None:
        if self.fail_policy:
            raise RuntimeError("policy failure")
        if self.malformed_policy:
            return None
        if self.priority_override is not None:
            return {"priority": self.priority_override}
        text = " ".join(str(report.get("text", "")) for report in reports).casefold()
        if "unresponsive" in text:
            return {"priority": "P0"}
        if "may have a problem" in text:
            return {"priority": "UNASSESSED"}
        if "no flames or smoke" in text:
            return {"priority": "UNASSESSED"}
        return {"priority": "P1"}

    def detect_conflicts(self, reports: list[dict[str, object]]) -> list[dict[str, str]] | None:
        if self.fail_conflicts:
            raise RuntimeError("conflict failure")
        if self.malformed_conflicts:
            return None
        text = " ".join(str(report.get("text", "")) for report in reports).casefold()
        if "will not open" in text and "clear again" in text:
            return [{"field": "exit_access"}]
        return []


def _write_split(directory: Path, inputs: object, labels: object) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "test_inputs.json").write_text(json.dumps(inputs), encoding="utf-8")
    (directory / "test_labels.json").write_text(json.dumps(labels), encoding="utf-8")


def _minimal_split() -> tuple[dict[str, object], dict[str, object]]:
    inputs: dict[str, object] = {
        "dataset_version": "unit-v1",
        "split": "test",
        "reports": [_report()],
    }
    labels: dict[str, object] = {
        "dataset_version": "unit-v1",
        "split": "test",
        "report_groups": {"r1": "g1"},
        "groups": [{"id": "g1", "report_ids": ["r1"]}],
        "policy_cases": {},
        "conflict_groups": [],
        "review_groups": [],
    }
    return inputs, labels


class MetricAndParsingTests(unittest.TestCase):
    def test_tokens_jaccard_and_timestamp_parsing(self) -> None:
        self.assertEqual(evaluation._token_set("THE, A and the!"), set())
        self.assertEqual(evaluation._jaccard("the a", "or and"), 0.0)
        self.assertAlmostEqual(evaluation._jaccard("red bag", "red bag"), 1.0)
        self.assertIsNone(evaluation._parse_time(None))
        self.assertIsNone(evaluation._parse_time(""))
        self.assertIsNone(evaluation._parse_time("not a timestamp"))
        self.assertIsNone(evaluation._parse_time("2026-10-25T06:30:00"))
        self.assertIsNotNone(evaluation._parse_time("2026-10-25T06:30:00Z"))

    def test_context_relation_requires_same_known_zone_and_nearby_known_time(self) -> None:
        base = _report()
        self.assertEqual(evaluation._context_relation(base, base), (True, False))
        self.assertEqual(
            evaluation._context_relation(base, _report(zone_id="hall")), (False, False)
        )
        self.assertEqual(evaluation._context_relation(base, _report(zone_id=None)), (False, True))
        self.assertEqual(
            evaluation._context_relation(base, _report(reported_at=None)), (False, True)
        )
        self.assertEqual(
            evaluation._context_relation(base, _report(reported_at="2026-10-25T07:00:00Z")),
            (False, False),
        )

    def test_metric_counts_pairs_and_handles_no_pair_denominators(self) -> None:
        report_ids = ["a", "b", "c"]
        truth = {"a": "g1", "b": "g1", "c": "g2"}
        predicted = {"a": "p1", "b": "p1", "c": "p1"}
        result = evaluation._metric_row("method", report_ids, truth, predicted, {"a"})
        self.assertEqual(result["false_merges"], 2)
        self.assertEqual(result["missed_pairs"], 0)
        self.assertAlmostEqual(result["precision"], 1 / 3, places=6)
        self.assertAlmostEqual(result["review_rate"], 1 / 3, places=6)
        empty = evaluation._metric_row("empty", [], {}, {}, set())
        self.assertEqual(
            (empty["precision"], empty["recall"], empty["f1"], empty["review_rate"]), (0, 0, 0, 0)
        )
        singleton = evaluation._metric_row(
            "singleton", ["x", "y"], {"x": "x", "y": "y"}, {"x": "x", "y": "y"}, set()
        )
        self.assertEqual(singleton["f1"], 0)

    def test_vector_validation_cosine_and_availability(self) -> None:
        self.assertIsNone(evaluation._as_vector(None))
        self.assertIsNone(evaluation._as_vector("not a vector"))
        self.assertIsNone(evaluation._as_vector({"x": 1}))
        self.assertIsNone(evaluation._as_vector([object()]))
        self.assertIsNone(evaluation._as_vector([math.inf]))
        self.assertEqual(evaluation._as_vector([3, 4]), (3.0, 4.0))
        self.assertIsNone(evaluation._cosine({}, {}))
        self.assertIsNone(evaluation._cosine({"embedding": [1, 0]}, {"embedding": [1, 0, 0]}))
        self.assertIsNone(evaluation._cosine({"embedding": [0, 0]}, {"embedding": [1, 0]}))
        self.assertEqual(evaluation._cosine({"embedding": [1, 0]}, {"embedding": [1, 0]}), 1.0)
        self.assertFalse(evaluation._all_embeddings_available([]))
        self.assertFalse(evaluation._all_embeddings_available([{}]))
        self.assertFalse(
            evaluation._all_embeddings_available(
                [
                    {"embedding": [1, 0]},
                    {"embedding": [1, 0, 0]},
                ]
            )
        )
        self.assertTrue(
            evaluation._all_embeddings_available(
                [
                    {"embedding": [1, 0]},
                    {"embedding": [0, 1]},
                ]
            )
        )
        self.assertTrue(
            evaluation._all_embeddings_match_revision(
                [
                    {"embedding": [1, 0], "model_revision": "model-v1"},
                    {"embedding": [0, 1], "model_revision": "model-v1"},
                ],
                "model-v1",
            )
        )
        self.assertFalse(
            evaluation._all_embeddings_match_revision(
                [{"embedding": [1, 0], "model_revision": "lexical-hash-v1"}],
                "model-v1",
            )
        )
        self.assertFalse(
            evaluation._all_embeddings_match_revision(
                [{"embedding": [1, 0], "model_revision": "model-v1"}], None
            )
        )

    def test_percentile_and_health_helpers(self) -> None:
        self.assertIsNone(evaluation._percentile([], 0.5))
        self.assertEqual(evaluation._percentile([3.0, 1.0, 2.0], 0.5), 2.0)
        self.assertEqual(evaluation._percentile([3.0, 1.0, 2.0], 0.95), 3.0)
        self.assertEqual(evaluation._engine_mode({}), "unknown")
        self.assertEqual(evaluation._engine_mode({"engine": " Semantic "}), "semantic")
        self.assertEqual(evaluation._engine_mode({"engine": 4}), "unknown")
        self.assertEqual(evaluation._model_name({"model_revision": "rev"}, "semantic"), "rev")
        self.assertEqual(evaluation._model_name({}, "lexical"), "none (engine mode: lexical)")
        self.assertEqual(
            evaluation._observed_model({}, "lexical", [{}, {"model_revision": "lexical-hash-v1"}]),
            ("lexical-hash-v1", "lexical"),
        )
        self.assertEqual(
            evaluation._observed_model(
                {},
                "semantic",
                [
                    {"model_revision": "all-MiniLM-L6-v2"},
                    {"model_revision": "lexical-hash-v1"},
                ],
            ),
            ("mixed revisions: all-MiniLM-L6-v2, lexical-hash-v1", "mixed"),
        )
        self.assertEqual(
            evaluation._observed_model({}, "semantic", [{}]),
            ("none (engine mode: semantic)", "semantic"),
        )
        self.assertEqual(evaluation._as_review_reasons("bad"), [])
        self.assertEqual(
            evaluation._as_review_reasons([" ", "needs review", 5]), ["needs review", "5"]
        )
        self.assertEqual(evaluation._as_review_reasons(("ok",)), ["ok"])

    def test_comparator_attaches_reviews_ambiguity_and_respects_context(self) -> None:
        reports = [
            _report("a", "red bag near the stage"),
            _report("b", "red bag near the stage", reported_at="2026-10-25T06:31:00Z"),
            _report("c", "red bag near the stage", zone_id=None),
        ]
        predictions, reviews = evaluation._run_comparator(
            reports,
            lambda left, right: 1.0,
            0.5,
            require_context=True,
        )
        self.assertEqual(predictions["b"], predictions["a"])
        self.assertNotEqual(predictions["c"], predictions["a"])
        self.assertIn("c", reviews)
        unrelated, unrelated_reviews = evaluation._run_comparator(
            [reports[0], _report("d", "unrelated phrase", zone_id=None)],
            lambda left, right: 0.1,
            0.5,
            require_context=True,
        )
        self.assertNotEqual(unrelated["d"], unrelated["a"])
        self.assertNotIn("d", unrelated_reviews)
        attach_with_uncertain_alternative, mixed_reviews = evaluation._run_comparator(
            [reports[0], _report("m", "red bag near the stage", zone_id=None), reports[1]],
            lambda left, right: 1.0,
            0.5,
            require_context=True,
        )
        self.assertEqual(
            attach_with_uncertain_alternative["b"], attach_with_uncertain_alternative["a"]
        )
        self.assertIn("b", mixed_reviews)
        no_similarity, no_similarity_reviews = evaluation._run_comparator(
            [_report("e"), _report("f")],
            lambda left, right: None,
            0.5,
            require_context=True,
        )
        self.assertNotEqual(no_similarity["e"], no_similarity["f"])
        self.assertFalse(no_similarity_reviews)
        close_reports = [
            _report("x", "red bag near stage"),
            _report("y", "blue bag near hall", zone_id="hall"),
            _report("z", "green bag near stage"),
        ]
        close_predictions, close_reviews = evaluation._run_comparator(
            close_reports,
            lambda left, right: 0.9 if left["id"] == "z" else 0.0,
            0.8,
            require_context=False,
        )
        self.assertNotEqual(close_predictions["z"], close_predictions["x"])
        self.assertIn("z", close_reviews)


class DatasetValidationTests(unittest.TestCase):
    def test_valid_split_loads_and_ground_truth_stays_outside_reports(self) -> None:
        version, reports, labels = evaluation._load_split()
        self.assertEqual(version, "aegis-synthetic-2026-10-v1")
        self.assertEqual(len(reports), 60)
        self.assertEqual(len(set(labels["report_groups"].values())), 20)
        self.assertNotIn("incident_family", reports[0])

    def test_load_split_wraps_io_json_and_unicode_failures(self) -> None:
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.object(evaluation, "_DATA_DIR", Path(temporary)),
        ):
            with self.assertRaisesRegex(RuntimeError, "Unable to load"):
                evaluation._load_split()
            (Path(temporary) / "test_inputs.json").write_text("{", encoding="utf-8")
            (Path(temporary) / "test_labels.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "Unable to load"):
                evaluation._load_split()
            (Path(temporary) / "test_inputs.json").write_bytes(b"\xff")
            with self.assertRaisesRegex(RuntimeError, "Unable to load"):
                evaluation._load_split()

    def test_load_split_rejects_invalid_document_shapes_and_ids(self) -> None:
        valid_inputs, valid_labels = _minimal_split()
        bad_cases: list[tuple[object, object, str]] = [
            ([], valid_labels, "JSON objects"),
            (valid_inputs, [], "JSON objects"),
            ({**valid_inputs, "dataset_version": ""}, valid_labels, "mismatched dataset versions"),
            ({**valid_inputs, "split": "dev"}, valid_labels, "not both marked"),
            ({**valid_inputs, "reports": {}}, valid_labels, "invalid report or label collections"),
            ({**valid_inputs, "reports": [4]}, valid_labels, "non-object report"),
            (
                {**valid_inputs, "reports": [_report("", "x")]},
                valid_labels,
                "missing or duplicate report ID",
            ),
            ({**valid_inputs, "reports": [_report("r1", "  ")]}, valid_labels, "has no text"),
            (valid_inputs, {**valid_labels, "report_groups": {}}, "cover exactly"),
            (
                valid_inputs,
                {**valid_labels, "report_groups": {"r1": []}},
                "invalid incident-family ID",
            ),
            (valid_inputs, {**valid_labels, "groups": [{"id": []}]}, "invalid incident-family ID"),
            (valid_inputs, {**valid_labels, "groups": []}, "group index does not match"),
        ]
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.object(evaluation, "_DATA_DIR", Path(temporary)),
        ):
            for inputs, labels, message in bad_cases:
                with self.subTest(message=message):
                    _write_split(Path(temporary), inputs, labels)
                    with self.assertRaisesRegex(ValueError, message):
                        evaluation._load_split()

    def test_load_split_rejects_duplicate_ids_and_invalid_report_text(self) -> None:
        inputs, labels = _minimal_split()
        duplicate_inputs = {**inputs, "reports": [_report("r1"), _report("r1", "second")]}
        duplicate_labels = {**labels, "report_groups": {"r1": "g1"}}
        blank_text_inputs = {**inputs, "reports": [_report("r1", " ")]}
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.object(evaluation, "_DATA_DIR", Path(temporary)),
        ):
            _write_split(Path(temporary), duplicate_inputs, duplicate_labels)
            with self.assertRaisesRegex(ValueError, "missing or duplicate"):
                evaluation._load_split()
            for value in (None, 3):
                with self.subTest(value=value):
                    _write_split(
                        Path(temporary), {**inputs, "reports": [_report("r1", value)]}, labels
                    )
                    with self.assertRaisesRegex(ValueError, "has no text"):
                        evaluation._load_split()
            _write_split(Path(temporary), blank_text_inputs, labels)
            with self.assertRaisesRegex(ValueError, "has no text"):
                evaluation._load_split()


class EnginePathTests(unittest.TestCase):
    def test_run_engine_analysis_grouping_success_and_error_fallbacks(self) -> None:
        reports = [
            _report("r1", "normal"),
            _report("r2", "normal"),
            _report("r3", "analysis-error"),
            _report("r4", "bad-analysis"),
            _report("r5", "group-error"),
            _report("r6", "bad-group"),
            _report("r7", "unknown-group"),
        ]
        engine = StubEngine(
            choice="attach",
            fail_analysis_for="analysis-error",
            malformed_analysis_for="bad-analysis",
            fail_grouping_for="r5",
            malformed_grouping_for="r6",
            unknown_group_for="r7",
        )
        failures: list[str] = []
        predictions, reviews, prepared, latencies = evaluation._run_engine(
            engine, reports, failures
        )
        self.assertEqual(len(predictions), len(reports))
        self.assertEqual(len(prepared), len(reports))
        self.assertEqual(len(latencies), len(reports))
        self.assertEqual(predictions["r2"], predictions["r1"])
        self.assertEqual(predictions["r3"], "engine-002")
        self.assertEqual(predictions["r4"], "engine-003")
        self.assertIn("r3", reviews)
        self.assertIn("r4", reviews)
        self.assertIn("r5", reviews)
        self.assertIn("r6", reviews)
        self.assertIn("r7", reviews)
        self.assertGreaterEqual(len(failures), 5)

    def test_run_engine_accepts_none_review_reasons_and_singletons(self) -> None:
        engine = StubEngine(choice="singleton")
        predictions, reviews, prepared, latencies = evaluation._run_engine(
            engine,
            [_report("r1")],
            [],
        )
        self.assertEqual(predictions, {"r1": "engine-001"})
        self.assertEqual(reviews, set())
        self.assertEqual(prepared[0]["id"], "r1")
        self.assertEqual(len(latencies), 1)

    def test_policy_conflict_and_incomplete_checks_cover_pass_fail_and_errors(self) -> None:
        labels = {
            "report_groups": {"p": "positive", "n": "negative", "i": "incomplete", "c": "conflict"},
            "policy_cases": {"positive": "P0", "negative": "NOT_P0"},
            "conflict_groups": ["conflict"],
            "review_groups": ["incomplete"],
        }
        prepared = [
            {"id": "p", "text": "unresponsive"},
            {"id": "n", "text": "No flames or smoke at the exit"},
            {"id": "i", "text": "may have a problem", "review_reasons": ["review"]},
            {"id": "c", "text": "will not open; clear again"},
        ]
        passing = StubEngine()
        policy = evaluation._ground_truth_policy_checks(passing, labels, prepared, [])
        self.assertTrue(policy[0]["passed"])
        self.assertTrue(policy[1]["passed"])
        self.assertTrue(evaluation._conflict_check(passing, labels, prepared, [])["passed"])
        self.assertTrue(evaluation._incomplete_check(passing, labels, prepared, [])["passed"])
        failures: list[str] = []
        broken = StubEngine(
            fail_policy=True, malformed_conflicts=True, fail_conflicts=False, malformed_policy=True
        )
        self.assertFalse(
            all(
                item["passed"]
                for item in evaluation._ground_truth_policy_checks(
                    broken, labels, prepared, failures
                )
            )
        )
        self.assertFalse(evaluation._conflict_check(broken, labels, prepared, failures)["passed"])
        self.assertFalse(evaluation._incomplete_check(broken, labels, prepared, failures)["passed"])
        self.assertTrue(failures)
        unavailable_policy = evaluation._ground_truth_policy_checks(None, labels, prepared, [])
        self.assertFalse(unavailable_policy[1]["passed"])
        self.assertFalse(evaluation._conflict_check(None, labels, prepared, [])["passed"])
        self.assertFalse(evaluation._incomplete_check(None, labels, prepared, [])["passed"])
        malformed_failures: list[str] = []
        malformed = StubEngine(malformed_policy=True)
        self.assertFalse(
            all(
                item["passed"]
                for item in evaluation._ground_truth_policy_checks(
                    malformed, labels, prepared, malformed_failures
                )
            )
        )
        self.assertFalse(
            evaluation._incomplete_check(malformed, labels, prepared, malformed_failures)["passed"]
        )
        self.assertTrue(any("must return a dictionary" in item for item in malformed_failures))
        no_review_labels = {
            "report_groups": {"p": "incomplete"},
            "review_groups": ["incomplete"],
        }
        no_review_prepared = [{"id": "p", "text": "routine item", "review_reasons": []}]
        self.assertFalse(
            evaluation._incomplete_check(
                StubEngine(priority_override="P1"),
                no_review_labels,
                no_review_prepared,
                [],
            )["passed"]
        )

    def test_engine_method_names_never_call_lexical_fallback_semantic(self) -> None:
        lexical_name, lexical_limitations = evaluation._format_engine_method("lexical", False)
        self.assertEqual(lexical_name, "Aegis contextual lexical (degraded)")
        self.assertTrue(lexical_limitations)
        self.assertEqual(
            evaluation._format_engine_method("degraded", True)[0],
            "Aegis contextual lexical (degraded)",
        )
        self.assertEqual(
            evaluation._format_engine_method("semantic", True)[0], "Aegis semantic + context"
        )
        mixed_name, mixed_limitations = evaluation._format_engine_method("mixed", True)
        self.assertEqual(mixed_name, "Aegis mixed model + context")
        self.assertTrue(mixed_limitations)
        unknown_name, unknown_limitations = evaluation._format_engine_method("unknown", None)
        self.assertEqual(unknown_name, "Aegis engine (unknown)")
        self.assertTrue(unknown_limitations)


class EvaluationEntryPointTests(unittest.TestCase):
    def _all_check_names(self, result: dict[str, object]) -> set[str]:
        return {str(check["name"]) for check in result["checks"]}  # type: ignore[index]

    def test_run_evaluation_returns_exact_shape_and_reports_truthful_lexical_mode(self) -> None:
        result = evaluation.run_evaluation(AnalysisEngine(model_loader=lambda: None))
        self.assertEqual(
            set(result),
            {
                "dataset_version",
                "model",
                "config_version",
                "generated_at",
                "results",
                "checks",
                "latency",
                "limitations",
                "failures",
                "error_examples",
                "workload",
            },
        )
        self.assertEqual(result["dataset_version"], "aegis-synthetic-2026-10-v1")
        self.assertEqual(result["model"], "lexical-hash-v1")
        methods = [row["method"] for row in result["results"]]
        self.assertIn("Lexical Jaccard baseline", methods)
        self.assertIn("Aegis contextual lexical (degraded)", methods)
        self.assertFalse(any("Semantic" in method for method in methods))
        self.assertNotIn("Aegis contextual lexical (forced fallback)", methods)
        self.assertIn("lexical/degraded mode", " ".join(result["limitations"]))
        self.assertIn("not production engine paths or calibrated probabilities", " ".join(result["limitations"]))
        self.assertEqual(
            self._all_check_names(result),
            {
                "all reports retained",
                "held-out fixture cardinality",
                "explicit P0 policy cases",
                "negated or hypothetical cases avoid P0",
                "contradictory or changing reports stay visible",
                "incomplete reports remain reviewable",
            },
        )
        self.assertTrue(result["checks"][0]["passed"])
        self.assertIsNotNone(result["latency"]["p50_ms"])
        self.assertIsNotNone(result["latency"]["p95_ms"])
        self.assertEqual(result["failures"], [])

    def test_semantic_mode_adds_embedding_baseline_only_with_real_vectors(self) -> None:
        with patch(
            "backend.aegis.engine._load_local_sentence_transformer",
            side_effect=AssertionError("forced lexical comparison must not load MiniLM"),
        ):
            semantic = evaluation.run_evaluation(StubEngine(mode="semantic", model_ready=True))
        self.assertIn("Semantic cosine baseline", [row["method"] for row in semantic["results"]])
        self.assertIn("Aegis semantic + context", [row["method"] for row in semantic["results"]])
        self.assertIn(
            "Aegis contextual lexical (forced fallback)",
            [row["method"] for row in semantic["results"]],
        )
        self.assertTrue(
            any("same ordered raw reports" in item for item in semantic["limitations"])
        )
        self.assertEqual(semantic["failures"], [])
        missing_vectors = evaluation.run_evaluation(
            StubEngine(mode="semantic", model_ready=True, semantic_vectors=False)
        )
        self.assertNotIn(
            "Semantic cosine baseline", [row["method"] for row in missing_vectors["results"]]
        )
        self.assertNotIn(
            "Aegis contextual lexical (forced fallback)",
            [row["method"] for row in missing_vectors["results"]],
        )
        self.assertTrue(
            any("valid embedding from the reported semantic revision" in item for item in missing_vectors["limitations"])
        )

    def test_diagnostic_semantic_comparator_uses_lexical_context_eligibility(self) -> None:
        original = evaluation._run_comparator
        policies: list[tuple[Any, float, bool]] = []

        def record_policy(reports, scorer, threshold, *, require_context):
            policies.append((scorer, threshold, require_context))
            return original(reports, scorer, threshold, require_context=require_context)

        with patch.object(evaluation, "_run_comparator", side_effect=record_policy):
            result = evaluation.run_evaluation(StubEngine(mode="semantic", model_ready=True))
        self.assertEqual(len(policies), 2)
        self.assertIs(policies[1][0], evaluation._cosine)
        self.assertEqual(policies[0][1], evaluation._LEXICAL_THRESHOLD)
        self.assertEqual([policy[2] for policy in policies], [True, True])
        self.assertEqual(policies[1][1], evaluation._SEMANTIC_THRESHOLD)
        self.assertTrue(any("fixed at 0.78" in item for item in result["limitations"]))

    def test_mixed_semantic_and_lexical_provenance_omits_paired_semantic_rows(self) -> None:
        semantic = evaluation.run_evaluation(
            StubEngine(
                mode="semantic",
                model_ready=True,
                lexical_fallback_for_text=(
                    "A person could be in trouble somewhere in the venue; "
                    "no further details were provided."
                ),
            )
        )
        methods = [row["method"] for row in semantic["results"]]
        self.assertIn("Aegis mixed model + context", methods)
        self.assertNotIn("Semantic cosine baseline", methods)
        self.assertNotIn("Aegis contextual lexical (forced fallback)", methods)
        self.assertTrue(semantic["model"].startswith("mixed revisions:"))
        self.assertTrue(any("only 59 of 60 reports" in item for item in semantic["limitations"]))

    def test_forced_lexical_initialization_failure_is_not_hidden(self) -> None:
        with patch.dict(sys.modules, {"backend.aegis.engine": None}):
            result = evaluation.run_evaluation(StubEngine(mode="semantic", model_ready=True))
        methods = [row["method"] for row in result["results"]]
        self.assertIn("Aegis semantic + context", methods)
        self.assertNotIn("Aegis contextual lexical (forced fallback)", methods)
        self.assertTrue(any("Unable to initialize forced lexical" in item for item in result["failures"]))
        self.assertTrue(
            any("forced-lexical production comparison could not be initialized" in item for item in result["limitations"])
        )

    def test_lexical_or_unknown_engine_mode_is_named_without_semantic_claim(self) -> None:
        unknown = evaluation.run_evaluation(StubEngine(mode="experimental", model_ready=None))  # type: ignore[arg-type]
        methods = [row["method"] for row in unknown["results"]]
        self.assertIn("Aegis engine (experimental)", methods)
        self.assertFalse(any("Semantic" in method for method in methods))
        forced_degraded = evaluation.run_evaluation(StubEngine(mode="semantic", model_ready=False))
        self.assertIn(
            "Aegis contextual lexical (degraded)",
            [row["method"] for row in forced_degraded["results"]],
        )
        self.assertNotIn(
            "Semantic cosine baseline", [row["method"] for row in forced_degraded["results"]]
        )

    def test_engine_failure_paths_preserve_reports_and_return_lexical_only(self) -> None:
        failed_health = evaluation.run_evaluation(StubEngine(fail_health=True))
        self.assertEqual(
            [row["method"] for row in failed_health["results"]], ["Lexical Jaccard baseline"]
        )
        self.assertIsNone(failed_health["latency"]["p50_ms"])
        self.assertTrue(
            any("Engine health failed" in failure for failure in failed_health["failures"])
        )
        malformed_health = evaluation.run_evaluation(StubEngine(malformed_health=True))
        self.assertTrue(
            any(
                "health must return a dictionary" in failure
                for failure in malformed_health["failures"]
            )
        )
        self.assertTrue(malformed_health["checks"][0]["passed"])
        self.assertTrue(
            any(
                "only the explicit lexical baseline" in item
                for item in failed_health["limitations"]
            )
        )

    def test_engine_item_failures_are_recorded_without_losing_retention(self) -> None:
        result = evaluation.run_evaluation(
            StubEngine(
                fail_analysis_for="A person could be in trouble somewhere in the venue; no further details were provided.",
                fail_grouping_for="test-003",
            )
        )
        self.assertTrue(result["checks"][0]["passed"])
        self.assertTrue(any("Analysis failed" in failure for failure in result["failures"]))
        self.assertTrue(any("Grouping failed" in failure for failure in result["failures"]))
        self.assertGreaterEqual(result["results"][1]["review_rate"], 1 / 60)

    def test_missing_engine_import_returns_no_fabricated_engine_metrics(self) -> None:
        with patch.dict(sys.modules, {"backend.aegis.engine": None}):
            result = evaluation.run_evaluation()
        self.assertEqual([row["method"] for row in result["results"]], ["Lexical Jaccard baseline"])
        self.assertIsNone(result["latency"]["p95_ms"])
        self.assertTrue(
            any("Unable to initialize AnalysisEngine" in failure for failure in result["failures"])
        )
        self.assertTrue(
            any("Aegis analysis was unavailable" in item for item in result["limitations"])
        )

    def test_missing_evaluation_data_returns_contract_shape_with_failure(self) -> None:
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.object(evaluation, "_DATA_DIR", Path(temporary)),
        ):
            result = evaluation.run_evaluation(StubEngine())
        self.assertEqual(result["dataset_version"], "unavailable")
        self.assertEqual(result["results"], [])
        self.assertIsNone(result["latency"]["p50_ms"])
        self.assertFalse(result["checks"][0]["passed"])
        self.assertTrue(result["failures"])

    def test_wrong_fixture_cardinality_is_visible_as_a_limitation(self) -> None:
        inputs, labels = _minimal_split()
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.object(evaluation, "_DATA_DIR", Path(temporary)),
        ):
            _write_split(Path(temporary), inputs, labels)
            result = evaluation.run_evaluation(StubEngine())
        cardinality = next(
            check for check in result["checks"] if check["name"] == "held-out fixture cardinality"
        )
        self.assertFalse(cardinality["passed"])
        self.assertTrue(any("cardinality differs" in item for item in result["limitations"]))

    def test_engine_policy_conflict_and_analysis_errors_are_visible(self) -> None:
        result = evaluation.run_evaluation(
            StubEngine(fail_policy=True, fail_conflicts=True),
        )
        self.assertTrue(any("Priority policy check failed" in item for item in result["failures"]))
        self.assertTrue(any("Conflict check failed" in item for item in result["failures"]))
        self.assertFalse(
            next(
                check for check in result["checks"] if check["name"] == "explicit P0 policy cases"
            )["passed"]
        )

    def test_lazy_engine_initialization_success_uses_the_public_engine_contract(self) -> None:
        with patch("backend.aegis.engine.AnalysisEngine", return_value=StubEngine()):
            result = evaluation.run_evaluation()
        self.assertEqual(result["config_version"], "stub-config-v1")
        self.assertIn(
            "Aegis contextual lexical (degraded)", [row["method"] for row in result["results"]]
        )


if __name__ == "__main__":
    unittest.main()
