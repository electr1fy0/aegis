from __future__ import annotations

import math
from typing import Any

from aegis.engine import LEXICAL_REVISION, AnalysisEngine
from aegis.model_config import MODEL_REVISION

NOW = "2026-10-25T12:00:00Z"


def report(
    report_id: str,
    text: str,
    embedding: list[float] | None,
    *,
    model_revision: str | None = MODEL_REVISION,
    zone_id: str | None = "hall",
    sublocation: str | None = "north doorway",
    reported_at: str | None = NOW,
    category: str | None = "medical",
) -> dict[str, Any]:
    return {
        "id": report_id,
        "text": text,
        "embedding": embedding,
        "model_revision": model_revision,
        "zone_id": zone_id,
        "sublocation": sublocation,
        "reported_at": reported_at,
        "category": category,
    }


def vector_at(cosine: float) -> list[float]:
    return [cosine, math.sqrt(1 - cosine**2)]


def test_dense_pair_keeps_usable_signal_when_both_texts_have_no_lexical_tokens() -> None:
    engine = AnalysisEngine(lambda: None)
    evidence = engine.score_pair(
        report("incoming", "!!!", [1.0, 0.0]),
        report("candidate", "???", [1.0, 0.0]),
    )

    assert evidence["semantic_score"] == 1.0
    assert evidence["total_score"] == 1.0
    assert any(
        "lexical-hash text similarity is unavailable" in reason for reason in evidence["reasons"]
    )
    assert "semantic" not in evidence["missing_fields"]


def test_zero_usable_route_signals_return_context_gaps_instead_of_a_candidate() -> None:
    engine = AnalysisEngine(lambda: None)
    incoming = report(
        "incoming",
        "!!!",
        None,
        model_revision=LEXICAL_REVISION,
        zone_id=None,
        sublocation=None,
        reported_at=None,
        category=None,
    )
    existing = report(
        "existing",
        "???",
        None,
        model_revision=LEXICAL_REVISION,
        zone_id=None,
        sublocation=None,
        reported_at=None,
        category=None,
    )

    result = engine.choose_group(incoming, [{"id": "group", "reports": [existing]}])

    assert result["incident_id"] is None
    assert len(result["evidence"]) == 1
    assert result["evidence"][0]["semantic_score"] is None
    assert result["evidence"][0]["total_score"] == 0.0
    assert {"location", "time", "category", "semantic"}.issubset(
        result["evidence"][0]["missing_fields"]
    )
    assert any("Known event time" in reason for reason in result["review_reasons"])


def test_rejected_top_group_is_excluded_before_the_remaining_route_is_ranked() -> None:
    engine = AnalysisEngine(lambda: None)
    incoming = report("incoming", "!!!", [1.0, 0.0])
    rejected_anchor = report("rejected-anchor", "???", [1.0, 0.0])
    eligible_anchor = report("eligible-anchor", "---", vector_at(0.8))

    result = engine.choose_group(
        incoming,
        [
            {"id": "rejected-group", "reports": [rejected_anchor]},
            {"id": "eligible-group", "reports": [eligible_anchor]},
        ],
        {("incoming", "rejected-group")},
    )

    assert result["incident_id"] == "eligible-group"
    by_group_evidence = {item["candidate_report_id"]: item for item in result["evidence"]}
    rejected = by_group_evidence["rejected-anchor"]
    eligible = by_group_evidence["eligible-anchor"]
    assert rejected["decision"] == "separate"
    assert any("coordinator rejection" in reason for reason in rejected["reasons"])
    assert eligible["decision"] == "attach"


def test_close_semantic_review_candidates_include_the_runner_up_and_margin_reason() -> None:
    engine = AnalysisEngine(lambda: None)
    incoming = report("incoming", "!!!", [1.0, 0.0])
    first = report("first", "???", vector_at(0.50))
    second = report("second", "---", vector_at(0.48))

    result = engine.choose_group(
        incoming,
        [
            {"id": "first-group", "reports": [first]},
            {"id": "second-group", "reports": [second]},
        ],
    )

    assert result["incident_id"] is None
    assert {
        item["candidate_report_id"] for item in result["evidence"] if item["decision"] == "suggest"
    } == {
        "first",
        "second",
    }
    assert any(
        "MiniLM candidate margin is below 0.08" in reason for reason in result["review_reasons"]
    )


def test_same_group_strict_routes_keep_one_coherent_selected_score_provenance() -> None:
    engine = AnalysisEngine(lambda: None)
    incoming = report(
        "incoming", "The west display screen is broken.", [1.0, 0.0], category="facility_issue"
    )
    existing = report(
        "existing",
        "The west display screen is broken.",
        [0.95, math.sqrt(1 - 0.95**2)],
        category="facility_issue",
    )

    result = engine.choose_group(incoming, [{"id": "same-incident", "reports": [existing]}])

    evidence = result["evidence"][0]
    assert result["incident_id"] == "same-incident"
    assert evidence["decision"] == "attach"
    assert evidence["total_score"] == 1.0
    assert (
        sum(
            "This candidate uses the independent local lexical-hash route" in reason
            for reason in evidence["reasons"]
        )
        == 1
    )
    assert not any(
        "This candidate uses the pinned MiniLM route" in reason for reason in evidence["reasons"]
    )


def test_group_rank_uses_pair_evidence_from_members_after_the_fourth() -> None:
    engine = AnalysisEngine(lambda: None)
    incoming = report("incoming", "!!!", [1.0, 0.0])
    members = [report(f"member-{index}", "???", [1.0, 0.0]) for index in range(4)]
    members.append(report("member-4", "---", vector_at(0.2)))

    result = engine.choose_group(incoming, [{"id": "large-group", "reports": members}])

    evidence = result["evidence"][0]
    assert result["incident_id"] == "large-group"
    assert evidence["total_score"] == 1.0
    assert any(
        "Candidate group rank score 0.896 is the mean of all 5 semantic pair composites" in reason
        for reason in evidence["reasons"]
    )


def test_explicit_distinct_event_keeps_pair_evidence_separate() -> None:
    engine = AnalysisEngine(lambda: None)
    incoming = report(
        "incoming",
        "This is a different incident: a medical concern at the north doorway.",
        [1.0, 0.0],
    )
    existing = report("existing", "A medical concern is reported at the north doorway.", [1.0, 0.0])

    result = engine.choose_group(incoming, [{"id": "existing-group", "reports": [existing]}])

    assert result["incident_id"] is None
    assert result["evidence"][0]["decision"] == "separate"
    assert any(
        "different incident or event" in reason for reason in result["evidence"][0]["reasons"]
    )


def test_legacy_facility_category_without_an_affirmative_fault_stays_unassessed() -> None:
    result = AnalysisEngine(lambda: None).assess_priority(
        [
            {
                "id": "legacy-report",
                "text": "A projector is installed at the hall entrance.",
                "category": "facility_issue",
                "zone_id": "hall",
            }
        ]
    )

    assert result["priority"] == "UNASSESSED"
    assert "no affirmative facility fault" in result["reason"]


def test_mixed_revision_with_no_lexical_signal_explains_why_no_candidate_was_ranked() -> None:
    engine = AnalysisEngine(lambda: None)
    incoming = report("incoming", "!!!", [1.0, 0.0])
    old_vector = report(
        "old-vector",
        "???",
        [1.0, 0.0],
        model_revision=LEXICAL_REVISION,
    )

    result = engine.choose_group(incoming, [{"id": "mixed-group", "reports": [old_vector]}])

    assert result["incident_id"] is None
    assert result["evidence"][0]["semantic_score"] is None
    assert any("different revision" in reason for reason in result["review_reasons"])


def test_strict_route_winners_for_different_groups_force_coordinator_review() -> None:
    engine = AnalysisEngine(lambda: None)
    incoming = report("incoming", "The display is broken.", [1.0, 0.0])
    lexical_leader = report("lexical-anchor", "The display is broken.", vector_at(0.8))
    semantic_leader = report(
        "semantic-anchor",
        "A visitor needs help by the north doorway.",
        [1.0, 0.0],
    )

    result = engine.choose_group(
        incoming,
        [
            {"id": "lexical-group", "reports": [lexical_leader]},
            {"id": "semantic-group", "reports": [semantic_leader]},
        ],
    )

    assert result["incident_id"] is None
    assert {item["decision"] for item in result["evidence"]} == {"suggest"}
    assert any("do not establish one incident" in reason for reason in result["review_reasons"])


def test_different_review_route_suggestions_are_explained_without_a_strict_winner() -> None:
    engine = AnalysisEngine(lambda: None)
    incoming = report("incoming", "The display is broken.", [1.0, 0.0])
    lexical_candidate = report("lexical-anchor", "The display is broken.", vector_at(0.50))
    semantic_candidate = report(
        "semantic-anchor",
        "A visitor needs help by the north doorway.",
        vector_at(0.55),
    )

    result = engine.choose_group(
        incoming,
        [
            {"id": "lexical-group", "reports": [lexical_candidate]},
            {"id": "semantic-group", "reports": [semantic_candidate]},
        ],
    )

    assert result["incident_id"] is None
    assert {
        item["candidate_report_id"] for item in result["evidence"] if item["decision"] == "suggest"
    } == {
        "lexical-anchor",
        "semantic-anchor",
    }
    assert any(
        "review suggestions point to different incidents" in reason
        for reason in result["review_reasons"]
    )


def test_semantic_candidate_below_review_threshold_remains_a_reviewable_singleton() -> None:
    engine = AnalysisEngine(lambda: None)
    incoming = report("incoming", "!!!", [1.0, 0.0])
    candidate = report("candidate", "???", vector_at(0.30))

    result = engine.choose_group(incoming, [{"id": "low-score", "reports": [candidate]}])

    assert result["incident_id"] is None
    assert result["evidence"][0]["decision"] == "separate"
    assert any(
        "Best MiniLM candidate score is below 0.65" in reason for reason in result["review_reasons"]
    )


def test_low_lexical_score_on_a_mixed_revision_candidate_keeps_the_degraded_mode_visible() -> None:
    engine = AnalysisEngine(lambda: None)
    incoming_text = "incident " + " ".join(f"lefttoken{i}" for i in range(5))
    candidate_text = "incident " + " ".join(f"righttoken{i}" for i in range(5))
    incoming = report(
        "incoming",
        incoming_text,
        [1.0, 0.0],
        model_revision=MODEL_REVISION,
        zone_id=None,
        category=None,
    )
    candidate = report(
        "candidate",
        candidate_text,
        [1.0, 0.0],
        model_revision=LEXICAL_REVISION,
        zone_id=None,
        category=None,
    )

    result = engine.choose_group(incoming, [{"id": "mixed-group", "reports": [candidate]}])

    assert result["incident_id"] is None
    assert result["evidence"][0]["decision"] == "separate"
    assert any(
        "Best lexical candidate score is below 0.33" in reason
        for reason in result["review_reasons"]
    )
    assert any("mixed-revision candidate" in reason for reason in result["review_reasons"])
