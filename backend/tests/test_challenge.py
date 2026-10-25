"""The development challenge runs production decisions and records failed cases honestly."""

import copy
import hashlib
import json
from types import SimpleNamespace

import pytest

from scripts import evaluate_challenge as challenge


@pytest.fixture
def challenge_file(tmp_path, monkeypatch):
    report = {
        "id": "left",
        "text": "The projector is broken at the west display row.",
        "zone_id": "hall",
        "sublocation": "west display row",
        "reported_at": "2026-10-25T12:00:00Z",
    }
    document = {
        "dataset_version": "tiny-development-challenge",
        "split": "challenge_dev",
        "cases": [
            {
                "id": "pair",
                "relationship": "same",
                "expected_action": "attach",
                "left": report,
                "right": {**report, "id": "right"},
            }
        ],
    }
    path = tmp_path / "challenge_dev.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    monkeypatch.setattr(challenge, "CHALLENGE_PATH", path)
    return path, document


def test_challenge_runs_production_grouping_in_both_directions(challenge_file):
    path, _document = challenge_file
    result = challenge.evaluate("lexical")
    assert result["data_sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert result["observed_report_count"] == 2
    assert result["observed_report_model_revisions"] == {"lexical-hash-v1": 2}
    assert result["analysis_failure_count"] == result["grouping_failure_count"] == 0
    assert result["summary"]["same_event"]["both_direction_auto_attach"] == 1
    directions = result["cases"][0]["directions"]
    assert directions["left_to_right"]["incoming_id"] == "left"
    assert directions["right_to_left"]["incoming_id"] == "right"
    for direction in directions.values():
        assert direction["auto_attached"] is True
        assert direction["evidence"][0]["report_id"] == direction["incoming_id"]


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda doc: doc.update(split="test"), "development-only"),
        (lambda doc: doc.update(cases=[]), "non-empty cases"),
        (lambda doc: doc["cases"].append(copy.deepcopy(doc["cases"][0])), "duplicate case"),
        (lambda doc: doc["cases"][0].update(relationship="unknown"), "invalid relationship"),
        (lambda doc: doc["cases"][0].update(expected_action="separate"), "inconsistent"),
        (lambda doc: doc["cases"][0]["right"].update(id="left"), "duplicate report"),
        (lambda doc: doc["cases"][0]["right"].update(zone_id="stage"), "matching zone"),
        (lambda doc: doc["cases"][0]["right"].update(text=" "), "invalid report"),
    ],
)
def test_challenge_rejects_wrong_split_invalid_labels_and_easy_context_negatives(
    challenge_file, change, message
):
    path, document = challenge_file
    change(document)
    path.write_text(json.dumps(document), encoding="utf-8")
    with pytest.raises(ValueError, match=message):
        challenge._load_challenge()


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("zone_id", None, "known context"),
        ("sublocation", " ", "known context"),
        ("reported_at", "invalid", "valid reported_at"),
        ("reported_at", "2026-10-25T12:00:00", "UTC offset"),
    ],
)
def test_equal_unknown_or_invalid_context_does_not_satisfy_challenge_protocol(
    challenge_file, field, value, message
):
    path, document = challenge_file
    for side in ("left", "right"):
        document["cases"][0][side][field] = value
    path.write_text(json.dumps(document), encoding="utf-8")
    with pytest.raises(ValueError, match=message):
        challenge._load_challenge()


def test_analysis_errors_remain_visible_and_do_not_count_as_matches(challenge_file, monkeypatch):
    def fail(*_args, **_kwargs):
        raise RuntimeError("offline inference failed")

    engine = SimpleNamespace(analyze_report=fail)
    monkeypatch.setattr(challenge, "_make_engine", lambda _mode: (engine, {}))
    result = challenge.evaluate("runtime")
    assert result["analysis_failure_count"] == 2
    assert result["cases"][0]["actual_action"] == "error"
    assert result["summary"]["same_event"]["both_direction_auto_attach"] == 0
    assert result["summary"]["same_event"]["candidate_recall_including_attach"] == 0


def test_grouping_failures_are_recorded_for_each_orientation(challenge_file, monkeypatch):
    from aegis.engine import AnalysisEngine

    engine = AnalysisEngine(model_loader=lambda: None)

    def fail(*_args, **_kwargs):
        raise RuntimeError("grouping failed")

    monkeypatch.setattr(engine, "choose_group", fail)
    monkeypatch.setattr(challenge, "_make_engine", lambda _mode: (engine, engine.health()))
    result = challenge.evaluate("runtime")
    assert result["analysis_failure_count"] == 0
    assert result["grouping_failure_count"] == 2
    assert {failure["direction"] for failure in result["grouping_failures"]} == {
        "left_to_right",
        "right_to_left",
    }
    assert result["summary"]["same_event"]["candidate_recall_including_attach"] == 0


@pytest.mark.parametrize("fail_first", [True, False])
def test_challenge_reports_observed_fallback_instead_of_initial_semantic_health(
    challenge_file, monkeypatch, fail_first
):
    from aegis.engine import LEXICAL_REVISION, MODEL_REVISION, AnalysisEngine

    class Encoder:
        calls = 0

        def encode(self, _texts, **_kwargs):
            self.calls += 1
            if fail_first or self.calls > 1:
                raise RuntimeError("inference unavailable")
            return [[1.0, 0.0]]

    engine = AnalysisEngine(model_loader=Encoder)
    monkeypatch.setattr(challenge, "_make_engine", lambda _mode: (engine, engine.health()))
    result = challenge.evaluate("runtime")
    assert result["initial_declared_model_revision"] == MODEL_REVISION
    assert result["observed_model_mode"] == ("lexical" if fail_first else "mixed")
    assert result["observed_report_model_revisions"][LEXICAL_REVISION] == (2 if fail_first else 1)
    assert result["observed_report_count"] == 2
    assert result["analysis_failure_count"] == 0
    assert "semantic_review" in result["thresholds"]
    assert "semantic_review_anchor_minimum" in result["thresholds"]
