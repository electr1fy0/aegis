from __future__ import annotations

from typing import Any

from backend.aegis.engine import LEXICAL_REVISION, AnalysisEngine
from backend.aegis.model_config import MODEL_REVISION

NOW = "2026-10-25T12:00:00Z"


def analyzed_report(
    engine: AnalysisEngine,
    report_id: str,
    text: str,
    *,
    zone_id: str = "hall",
    sublocation: str = "west display row",
    reported_at: str = NOW,
    embedding: list[float] | None = None,
    model_revision: str | None = None,
) -> dict[str, Any]:
    analysis = engine.analyze_report(text, zone_id, sublocation, reported_at)
    report = {
        "id": report_id,
        "text": text,
        "zone_id": zone_id,
        "sublocation": sublocation,
        "reported_at": reported_at,
        **analysis,
    }
    if embedding is not None:
        report["embedding"] = embedding
    if model_revision is not None:
        report["model_revision"] = model_revision
    return report


def test_bare_display_location_is_not_a_facility_fault_but_broken_display_is() -> None:
    engine = AnalysisEngine(lambda: None)
    waiting = engine.analyze_report(
        "A visitor is waiting by the west display row.", "hall", "west display row", NOW
    )
    assert waiting["category"] == "other"
    assert waiting["priority"] == "UNASSESSED"

    broken = engine.analyze_report(
        "The west display screen is broken.", "hall", "west display row", NOW
    )
    assert broken["category"] == "facility_issue"
    assert broken["priority"] == "P2"
    assert "“broken”" in broken["priority_reason"]
    assert "“display”" not in broken["priority_reason"]


def test_facility_fault_extraction_respects_negation_and_hypothetical_language() -> None:
    engine = AnalysisEngine(lambda: None)
    for text in (
        "The west display is not broken.",
        "Hypothetically, the west display is broken.",
    ):
        result = engine.analyze_report(text, "hall", "west display row", NOW)
        assert result["category"] == "other"
        assert result["priority"] == "UNASSESSED"

    outage = engine.analyze_report(
        "There is a power failure in the ticket lane.", "hall", "ticket lane", NOW
    )
    assert outage["category"] == "facility_issue"
    assert outage["priority"] == "P2"
    assert "power failure" in outage["priority_reason"]


def test_possessive_ankle_injury_is_supported_without_one_word_medical_inference() -> None:
    engine = AnalysisEngine(lambda: None)
    ankle = engine.analyze_report(
        "Asha, wearing a yellow vest, twisted her ankle at the west display row.",
        "hall",
        "west display row",
        NOW,
    )
    assert ankle["category"] == "medical"
    assert ankle["priority"] == "P1"

    for text in (
        "The first aid kit is empty at the display row.",
        "The first aid station is beside the hall entrance.",
    ):
        result = engine.analyze_report(text, "hall", "display row", NOW)
        assert result["category"] == "other"
        assert result["priority"] == "UNASSESSED"


def test_names_and_capitalized_locations_do_not_infer_missing_person_claims() -> None:
    engine = AnalysisEngine(lambda: None)
    for text in (
        "Arun has not come back to Sam.",
        "The projector has not come back to Stage.",
    ):
        result = engine.analyze_report(text, "hall", "display row", NOW)
        assert result["category"] == "other"
        assert result["claims"] == []


def test_form_zone_contradicted_by_report_text_requires_review_before_attachment() -> None:
    engine = AnalysisEngine(lambda: None)
    incoming = analyzed_report(
        engine,
        "incoming",
        "Exit B is blocked by a cart at the west doorway.",
        zone_id="exit-a",
        sublocation="west doorway",
    )
    existing = analyzed_report(
        engine,
        "existing",
        "Exit A is blocked by a cart at the west doorway.",
        zone_id="exit-a",
        sublocation="west doorway",
    )

    result = engine.choose_group(incoming, [{"id": "exit-a-incident", "reports": [existing]}])
    assert result["incident_id"] is None
    assert any(
        "names a different known zone" in reason for reason in result["evidence"][0]["reasons"]
    )
    assert result["evidence"][0]["decision"] == "suggest"


def test_opposing_exit_updates_with_same_identity_remain_groupable_for_conflict_review() -> None:
    engine = AnalysisEngine(lambda: None)
    blocked = analyzed_report(
        engine,
        "blocked",
        "Exit A is blocked by a fallen barrier at the north doorway.",
        zone_id="exit-a",
        sublocation="north doorway",
    )
    clear = analyzed_report(
        engine,
        "clear",
        "Exit A is clear now at the same north doorway after staff moved the barrier.",
        zone_id="exit-a",
        sublocation="north doorway",
    )

    assert {claim["value"] for claim in blocked["claims"] + clear["claims"]} == {
        "blocked",
        "clear",
    }
    result = engine.choose_group(blocked, [{"id": "exit-a-incident", "reports": [clear]}])
    assert result["incident_id"] == "exit-a-incident"
    assert result["evidence"][0]["decision"] == "attach"
    assert any(
        "Potential conflicting or changing accounts" in reason
        and "blocked" in reason
        and "clear" in reason
        for reason in result["evidence"][0]["reasons"]
    )
    assert any(
        "Potential conflicting or changing accounts" in reason
        for reason in result["review_reasons"]
    )


def test_split_candidate_keeps_supported_cross_report_conflict_visible() -> None:
    engine = AnalysisEngine(lambda: None)
    blocked = analyzed_report(
        engine,
        "blocked-report",
        "The inner doorway is blocked.",
        zone_id="exit-a",
        sublocation="inner doorway",
        embedding=[1.0, 0.0],
        model_revision=MODEL_REVISION,
    )
    clear = analyzed_report(
        engine,
        "clear-report",
        "The inner doorway is clear now.",
        zone_id="exit-a",
        sublocation="inner doorway",
        embedding=[0.0, 1.0],
        model_revision=MODEL_REVISION,
    )
    blocked["category"] = "blocked_exit"
    clear["category"] = "blocked_exit"
    blocked_claims = [{"field": "exit_access", "value": "blocked", "span": "doorway is blocked"}]
    clear_claims = [{"field": "exit_access", "value": "clear", "span": "doorway is clear"}]
    blocked["claims"] = blocked_claims
    clear["claims"] = clear_claims

    result = engine.choose_group(blocked, [{"id": "candidate", "reports": [clear]}])

    assert result["incident_id"] is None
    evidence = result["evidence"][0]
    warning = next(
        reason
        for reason in evidence["reasons"]
        if "Potential conflicting or changing accounts" in reason
    )
    assert "blocked-report" in warning and "clear-report" in warning
    assert warning in result["review_reasons"]
    assert blocked["claims"] == blocked_claims
    assert clear["claims"] == clear_claims


def test_open_doorway_claim_supports_resolution_without_inferencing_negated_clear() -> None:
    engine = AnalysisEngine(lambda: None)
    clear = engine.analyze_report(
        "The inner doorway is open again.", "exit-a", "inner doorway", NOW
    )
    negated = engine.analyze_report(
        "The inner doorway is not open.", "exit-a", "inner doorway", NOW
    )

    assert clear["claims"] == [
        {"field": "exit_access", "value": "clear", "span": "doorway is open"}
    ]
    assert negated["claims"] == []


def test_mixed_group_fallback_does_not_disable_weak_dense_anchor_veto() -> None:
    engine = AnalysisEngine(lambda: None)
    # The lexical text is an exact match for both members. The first pair has a
    # valid but weak MiniLM cosine; a later fallback member must not erase that
    # anchor-level evidence or make the lexical route auto-attach.
    incoming = analyzed_report(
        engine,
        "incoming",
        "The west display is broken.",
        embedding=[1.0, 0.0],
        model_revision=MODEL_REVISION,
    )
    weak_anchor = analyzed_report(
        engine,
        "weak-anchor",
        "The west display is broken.",
        embedding=[0.4, 0.916515],
        model_revision=MODEL_REVISION,
    )
    fallback_member = analyzed_report(
        engine,
        "fallback-member",
        "The west display is broken.",
        model_revision=LEXICAL_REVISION,
    )

    result = engine.choose_group(
        incoming, [{"id": "display-incident", "reports": [weak_anchor, fallback_member]}]
    )
    assert result["incident_id"] is None
    assert any("anchor corroboration" in reason for reason in result["evidence"][0]["reasons"])


def test_same_group_route_suggestions_report_one_coherent_score_with_alternate() -> None:
    engine = AnalysisEngine(lambda: None)
    text = "The west display screen is broken."
    incoming = analyzed_report(
        engine,
        "incoming",
        text,
        embedding=[1.0, 0.0],
        model_revision=MODEL_REVISION,
    )
    existing = analyzed_report(
        engine,
        "existing",
        text,
        embedding=[0.55, 0.835165],
        model_revision=MODEL_REVISION,
    )

    result = engine.choose_group(incoming, [{"id": "incident", "reports": [existing]}])
    evidence = result["evidence"][0]
    assert result["incident_id"] is None
    assert evidence["decision"] == "suggest"
    assert evidence["total_score"] == 0.7075
    assert any(
        "independent lexical route also proposed" in reason for reason in evidence["reasons"]
    )
    assert any("selected semantic route" in reason for reason in evidence["reasons"])
    assert not any("selected lexical route" in reason for reason in evidence["reasons"])


def test_group_rank_score_and_anchor_pair_total_are_both_explained() -> None:
    engine = AnalysisEngine(lambda: None)
    text = "The west display screen is broken."
    incoming = analyzed_report(
        engine,
        "incoming",
        text,
        embedding=[1.0, 0.0],
        model_revision=MODEL_REVISION,
    )
    anchor = analyzed_report(
        engine,
        "anchor",
        text,
        embedding=[0.55, 0.835165],
        model_revision=MODEL_REVISION,
    )
    stronger_member = analyzed_report(
        engine,
        "member",
        text,
        embedding=[0.9, 0.43589],
        model_revision=MODEL_REVISION,
    )

    result = engine.choose_group(
        incoming, [{"id": "incident", "reports": [anchor, stronger_member]}]
    )
    evidence = result["evidence"][0]
    assert result["incident_id"] is None
    assert evidence["total_score"] == 0.7075
    assert any(
        "Candidate group rank score 0.821" in reason
        and "mean of all 2 semantic pair composites" in reason
        and "total_score remains the anchor pair composite" in reason
        for reason in evidence["reasons"]
    )


def test_late_weak_members_contribute_to_group_rank_mean() -> None:
    engine = AnalysisEngine(lambda: None)
    text = "The west display screen is broken."
    incoming = analyzed_report(
        engine,
        "incoming",
        text,
        embedding=[1.0, 0.0],
        model_revision=MODEL_REVISION,
    )
    strong_members = [
        analyzed_report(
            engine,
            f"strong-{index}",
            text,
            embedding=[0.9, 0.43589],
            model_revision=MODEL_REVISION,
        )
        for index in range(4)
    ]
    late_weak_members = [
        analyzed_report(
            engine,
            f"weak-{index}",
            text,
            embedding=[0.55, 0.835165],
            model_revision=MODEL_REVISION,
        )
        for index in range(2)
    ]
    alternative = analyzed_report(
        engine,
        "alternative",
        text,
        embedding=[0.95, 0.31225],
        model_revision=MODEL_REVISION,
    )

    result = engine.choose_group(
        incoming,
        [
            {"id": "many-members", "reports": strong_members + late_weak_members},
            {"id": "balanced-match", "reports": [alternative]},
        ],
    )

    assert result["incident_id"] == "balanced-match"
    assert any(
        item["candidate_report_id"] == "alternative" and item["decision"] == "attach"
        for item in result["evidence"]
    )
    assert all(
        item["decision"] != "attach"
        for item in result["evidence"]
        if item["candidate_report_id"].startswith(("strong-", "weak-"))
    )


def test_close_semantic_review_margin_keeps_runner_up_visible() -> None:
    engine = AnalysisEngine(lambda: None)
    text = "The west display screen is broken."
    incoming = analyzed_report(
        engine,
        "incoming",
        text,
        embedding=[1.0, 0.0],
        model_revision=MODEL_REVISION,
    )
    best = analyzed_report(
        engine,
        "best-report",
        text,
        embedding=[0.6, 0.8],
        model_revision=MODEL_REVISION,
    )
    runner = analyzed_report(
        engine,
        "runner-report",
        text,
        embedding=[0.55, 0.835165],
        model_revision=MODEL_REVISION,
    )

    result = engine.choose_group(
        incoming,
        [
            {"id": "best", "reports": [best]},
            {"id": "runner", "reports": [runner]},
        ],
    )

    assert result["incident_id"] is None
    by_report = {item["candidate_report_id"]: item for item in result["evidence"]}
    assert by_report["best-report"]["decision"] == "suggest"
    assert by_report["runner-report"]["decision"] == "suggest"
    assert any("close runner-up is shown" in reason for reason in result["review_reasons"])


def test_close_semantic_runner_up_is_visible_without_vetoing_lexical_winner() -> None:
    engine = AnalysisEngine(lambda: None)
    text = "The west display screen is broken."
    incoming = analyzed_report(
        engine,
        "incoming",
        text,
        embedding=[1.0, 0.0],
        model_revision=MODEL_REVISION,
    )
    lexical_winner = analyzed_report(
        engine,
        "lexical-winner",
        text,
        embedding=[0.75, 0.661438],
        model_revision=MODEL_REVISION,
    )
    semantic_runner = analyzed_report(
        engine,
        "semantic-runner",
        "A broken screen is on display along the west row.",
        embedding=[0.7, 0.714143],
        model_revision=MODEL_REVISION,
    )

    result = engine.choose_group(
        incoming,
        [
            {"id": "lexical-group", "reports": [lexical_winner]},
            {"id": "semantic-runner-group", "reports": [semantic_runner]},
        ],
    )

    assert result["incident_id"] == "lexical-group"
    by_report = {item["candidate_report_id"]: item for item in result["evidence"]}
    assert by_report["lexical-winner"]["decision"] == "attach"
    assert by_report["semantic-runner"]["decision"] == "suggest"
    assert any("close runner-up remains visible" in reason for reason in result["review_reasons"])
