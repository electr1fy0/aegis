"""Risk-focused coverage for Aegis analysis and conservative grouping."""

from __future__ import annotations

import builtins
import math
from datetime import UTC, datetime

import pytest
from aegis import engine as engine_module
from aegis.engine import (
    LEXICAL_DIMENSION,
    LEXICAL_REVISION,
    MODEL_REVISION,
    AnalysisEngine,
)


class StaticEncoder:
    def __init__(self, vectors: dict[str, list[float]] | None = None) -> None:
        self.vectors = vectors or {}
        self.calls: list[tuple[list[str], dict[str, object]]] = []

    def encode(self, texts: list[str], **kwargs: object) -> list[list[float]]:
        self.calls.append((texts, kwargs))
        return [self.vectors.get(text, [1.0, 0.0]) for text in texts]


class RaisingEncoder:
    def encode(self, texts: list[str], **kwargs: object) -> list[list[float]]:
        raise RuntimeError("offline model failure")


class ToListObject:
    def __init__(self, result: object, raises: bool = False) -> None:
        self.result = result
        self.raises = raises

    def tolist(self) -> object:
        if self.raises:
            raise RuntimeError("conversion failed")
        return self.result


def _aware_time(minutes: int = 0) -> str:
    return f"2026-10-26T09:{minutes:02d}:00Z"


def _report(
    report_id: str,
    *,
    text: str = "A medical incident is reported at the north door.",
    zone_id: str | None = "hall",
    sublocation: str | None = "north door",
    reported_at: str | None = _aware_time(),
    category: str | None = "medical",
    embedding: list[float] | None = None,
    model_revision: str | None = MODEL_REVISION,
    claims: list[dict[str, str]] | None = None,
) -> dict[str, object]:
    result: dict[str, object] = {
        "id": report_id,
        "event_id": "event-1",
        "text": text,
        "zone_id": zone_id,
        "sublocation": sublocation,
        "reported_at": reported_at,
        "category": category,
        "embedding": embedding if embedding is not None else [1.0, 0.0],
        "model_revision": model_revision,
    }
    if claims is not None:
        result["claims"] = claims
    return result


def _candidate_group(
    group_id: str = "incident-1",
    *,
    vector: list[float] | None = None,
    text: str = "A medical incident is reported at the north door.",
    zone_id: str | None = "hall",
    sublocation: str | None = "north door",
    reported_at: str | None = _aware_time(),
    category: str | None = "medical",
    members: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    reports = members or [
        _report(
            f"{group_id}-anchor",
            text=text,
            zone_id=zone_id,
            sublocation=sublocation,
            reported_at=reported_at,
            category=category,
            embedding=vector,
        )
    ]
    return {"id": group_id, "reports": reports}


def test_local_model_loader_is_network_disabled_and_import_failure_is_handled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, dict[str, object]]] = []

    def denied_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "sentence_transformers":
            raise ImportError("test environment has no optional model dependency")
        return original_import(name, *args, **kwargs)

    original_import = builtins.__import__
    monkeypatch.setattr(builtins, "__import__", denied_import)
    engine = AnalysisEngine()
    assert engine.health() == {
        "status": "degraded",
        "engine": "lexical",
        "model_ready": False,
        "model_revision": None,
    }
    assert engine._load_failed is True
    assert engine._ensure_encoder() is None
    assert calls == []


def test_local_model_loader_passes_local_files_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    received: dict[str, object] = {}

    class FakeSentenceTransformer:
        def __init__(self, model_name: str, **kwargs: object) -> None:
            received["name"] = model_name
            received.update(kwargs)

    monkeypatch.setitem(
        __import__("sys").modules,
        "sentence_transformers",
        type("FakeModule", (), {"SentenceTransformer": FakeSentenceTransformer}),
    )
    encoder = engine_module._load_local_sentence_transformer()
    assert isinstance(encoder, FakeSentenceTransformer)
    assert received == {
        "name": "sentence-transformers/all-MiniLM-L6-v2",
        "revision": engine_module.MODEL_COMMIT,
        "local_files_only": True,
        "trust_remote_code": False,
    }


def test_health_and_analysis_use_injected_semantic_encoder() -> None:
    encoder = StaticEncoder({"A fire is burning.": [3.0, 4.0]})
    engine = AnalysisEngine(lambda: encoder)
    assert engine.health()["engine"] == "semantic"
    result = engine.analyze_report(
        "A fire is burning.", "stage", "west lighting desk", _aware_time()
    )
    assert result["embedding"] == pytest.approx([0.6, 0.8])
    assert result["model_revision"] == MODEL_REVISION
    assert result["priority"] == "P0"
    assert result["claims"] == []
    assert encoder.calls[0][1] == {
        "convert_to_numpy": True,
        "normalize_embeddings": True,
        "show_progress_bar": False,
    }
    assert engine.health()["model_ready"] is True


@pytest.mark.parametrize("loader", [lambda: None, lambda: object()])
def test_invalid_model_loaders_degrade_without_raising(loader: object) -> None:
    engine = AnalysisEngine(loader)  # type: ignore[arg-type]
    report = engine.analyze_report("the and at")
    assert report["model_revision"] == LEXICAL_REVISION
    assert len(report["embedding"]) == LEXICAL_DIMENSION
    assert any("MiniLM is unavailable" in reason for reason in report["review_reasons"])
    assert engine.health()["engine"] == "lexical"


def test_inference_failure_uses_lexical_mode_then_recovers() -> None:
    class RecoveringEncoder:
        def __init__(self) -> None:
            self.calls = 0

        def encode(self, texts: list[str], **kwargs: object) -> list[list[float]]:
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("temporary inference failure")
            return [[0.0, 2.0]]

    encoder = RecoveringEncoder()
    engine = AnalysisEngine(lambda: encoder)
    failed = engine.analyze_report("A person is injured.")
    assert failed["model_revision"] == LEXICAL_REVISION
    assert engine.health()["engine"] == "lexical"
    succeeded = engine.analyze_report("A person is injured.")
    assert succeeded["model_revision"] == MODEL_REVISION
    assert succeeded["embedding"] == pytest.approx([0.0, 1.0])
    assert engine.health()["engine"] == "semantic"


def test_inference_invalid_vector_is_handled_as_lexical_fallback() -> None:
    engine = AnalysisEngine(lambda: StaticEncoder({"A person is hurt.": []}))
    result = engine.analyze_report("A person is hurt.")
    assert result["model_revision"] == LEXICAL_REVISION
    assert any("MiniLM is unavailable" in reason for reason in result["review_reasons"])


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (None, None),
        ([], None),
        (ToListObject([[3.0, 4.0]]), [0.6, 0.8]),
        (ToListObject([1.0, 2.0], raises=True), None),
        ([[]], None),
        ([1.0, 2.0], pytest.approx([1 / math.sqrt(5), 2 / math.sqrt(5)])),
        ([0.0, 0.0], None),
        ([float("nan"), 1.0], None),
        (["not-a-number"], None),
    ],
)
def test_vector_normalization_branches(value: object, expected: object) -> None:
    actual = engine_module._unit_vector(value)
    if expected is None:
        assert actual is None
    else:
        assert actual == expected


def test_timestamp_empty_string_and_invalid_text_are_missing() -> None:
    assert engine_module._parse_timestamp(" ") is None
    assert engine_module._parse_timestamp("not-a-time") is None
    assert engine_module._parse_timestamp(None) is None


def test_cosine_invalid_dimension_and_clamping() -> None:
    assert engine_module._cosine(None, [1.0]) is None
    assert engine_module._cosine([1.0], [1.0, 2.0]) is None
    assert engine_module._cosine([1.0, 0.0], [-1.0, 0.0]) == 0.0
    assert engine_module._cosine([1.0, 0.0], [1.0, 0.0]) == 1.0
    assert engine_module._cosine(ToListObject([1.0, 0.0]), [1.0, 0.0]) == 1.0


def test_lexical_vector_handles_empty_stopwords_negation_and_bigrams() -> None:
    assert engine_module._lexical_vector("!!!") is None
    stopword_vector = engine_module._lexical_vector("the and of")
    assert stopword_vector is not None
    assert len(stopword_vector) == LEXICAL_DIMENSION
    vector = engine_module._lexical_vector("not blocked exit")
    assert vector is not None
    assert sum(value != 0 for value in vector) >= 3


@pytest.mark.parametrize("text", [None, "", "   ", "x" * 4001])
def test_report_input_validation(text: object) -> None:
    engine = AnalysisEngine(lambda: None)
    if text is None:
        with pytest.raises(TypeError, match="text must be a string"):
            engine.analyze_report(text)  # type: ignore[arg-type]
    else:
        with pytest.raises(ValueError):
            engine.analyze_report(text)  # type: ignore[arg-type]


def test_report_analysis_extracts_claims_categories_priority_and_context() -> None:
    engine = AnalysisEngine(lambda: None)
    blocked = engine.analyze_report(
        "Exit A is blocked by a fallen sign frame.", "exit-a", "inner door", _aware_time()
    )
    assert blocked["category"] == "blocked_exit"
    assert blocked["priority"] == "P1"
    assert blocked["claims"] == [
        {"field": "exit_access", "value": "blocked", "span": "Exit A is blocked"}
    ]
    assert "EXIT-1" in blocked["priority_reason"]

    clear = engine.analyze_report("Exit A is clear now.", "exit-a", "inner door", _aware_time())
    assert clear["claims"] == [
        {"field": "exit_access", "value": "clear", "span": "Exit A is clear"}
    ]
    assert clear["priority"] == "UNASSESSED"

    medical = engine.analyze_report(
        "A visitor twisted an ankle.", "hall", "north aisle", _aware_time()
    )
    assert medical["category"] == "medical"
    assert medical["priority"] == "P1"

    missing_child = engine.analyze_report(
        "A child is missing.", "hall", "poster row", _aware_time()
    )
    assert missing_child["category"] == "missing_person"
    assert missing_child["priority"] == "P1"
    assert missing_child["claims"] == [
        {"field": "person_status", "value": "missing", "span": "missing"}
    ]

    missing_adult = engine.analyze_report(
        "An adult is missing.", "hall", "poster row", _aware_time()
    )
    assert missing_adult["priority"] == "UNASSESSED"

    facility = engine.analyze_report(
        "The water dispenser is leaking.", "food", "east station", _aware_time()
    )
    assert facility["category"] == "facility_issue"
    assert facility["priority"] == "P2"


@pytest.mark.parametrize(
    ("text", "expected_category", "expected_priority"),
    [
        ("No fire observed at the exit.", "other", "UNASSESSED"),
        ("No flames or smoke are visible by the fire door.", "other", "UNASSESSED"),
        (
            "No flames or smoke are present by the east fire door; the smell came from a hot display lamp.",
            "facility_issue",
            "P2",
        ),
        (
            "A report about burning odor was checked at the east door and nobody found smoke.",
            "other",
            "UNASSESSED",
        ),
        ("Fire not observed at the inner fire door.", "other", "UNASSESSED"),
        ("No smoke but flames are visible in the hall.", "other", "P0"),
        ("Fire Exit A is blocked.", "blocked_exit", "P1"),
        ("The fire door is closed; no smoke is present.", "other", "UNASSESSED"),
        ("Hypothetically, a fire starts in the hall.", "other", "UNASSESSED"),
        ("No one is unconscious at registration.", "other", "UNASSESSED"),
        ("The person is not unconscious.", "other", "UNASSESSED"),
        ("A person is not responsive.", "medical", "P0"),
        ("A person collapsed and is not responding.", "medical", "P0"),
        ("A child was separated from family and has not returned.", "missing_person", "P1"),
        ("The lower gate at Exit A will not swing open.", "blocked_exit", "P1"),
        ("Visitors are held up at a jammed bottom Exit A gate.", "blocked_exit", "P1"),
        ("A barrier panel has fallen across the lower Exit A opening.", "blocked_exit", "P1"),
        (
            "The bottom gate at Exit A is moving freely again and passage is open.",
            "blocked_exit",
            "UNASSESSED",
        ),
        ("A person may be injured by the stage.", "other", "UNASSESSED"),
        ("The projector lost its picture in the booth.", "facility_issue", "P2"),
        ("A phone is lost near the north poster row.", "other", "UNASSESSED"),
        ("An adult is missing.", "missing_person", "UNASSESSED"),
        ("A person is trapped behind a panel.", "other", "P0"),
        ("A weapon is reported by the main stage.", "other", "P0"),
    ],
)
def test_bounded_negation_hypothetical_and_hazard_policy(
    text: str, expected_category: str, expected_priority: str
) -> None:
    result = AnalysisEngine(lambda: None).analyze_report(text, "stage", "west side", _aware_time())
    assert result["category"] == expected_category
    assert result["priority"] == expected_priority
    if expected_priority == "P0":
        assert any("human review" in reason for reason in result["review_reasons"])
        assert "probability" not in result["priority_reason"].casefold()


def test_uncertain_claims_are_not_inferred_and_same_report_changes_are_preserved() -> None:
    engine = AnalysisEngine(lambda: None)
    uncertain = engine.analyze_report(
        "I cannot tell whether Exit A is blocked.", "exit-a", "inner door", _aware_time()
    )
    assert uncertain["claims"] == []
    assert any("Uncertain" in reason for reason in uncertain["review_reasons"])

    change = engine.analyze_report(
        "Exit A was blocked. Exit A is now clear.", "exit-a", "inner door", _aware_time()
    )
    assert [claim["value"] for claim in change["claims"]] == ["blocked", "clear"]
    assert any("opposing supported claims" in reason for reason in change["review_reasons"])

    duplicate = engine.analyze_report(
        "Exit A is blocked. Exit A is blocked.", "exit-a", "inner door", _aware_time()
    )
    assert len(duplicate["claims"]) == 1

    negated = engine.analyze_report(
        "The exit is not blocked.", "exit-a", "inner door", _aware_time()
    )
    assert negated["claims"] == []
    negated_missing = engine.analyze_report(
        "The person is not missing.", "hall", "north door", _aware_time()
    )
    assert negated_missing["claims"] == []


def test_report_context_offsets_unknown_zone_and_cross_zone_text() -> None:
    engine = AnalysisEngine(lambda: None)
    naive = engine.analyze_report("A light is broken.", "hall", None, "2026-10-26T09:00:00")
    assert any("no valid UTC offset" in reason for reason in naive["review_reasons"])
    assert any("broad-zone" in reason for reason in naive["review_reasons"])

    missing = engine.analyze_report("A light is broken.")
    assert any("unlocated review tray" in reason for reason in missing["review_reasons"])
    assert any("time is unknown" in reason for reason in missing["review_reasons"])

    conflicting_location = engine.analyze_report(
        "The issue is at Exit A.", "exit-b", "outer ramp", _aware_time()
    )
    assert any(
        "Text mentions exit-a" in reason for reason in conflicting_location["review_reasons"]
    )

    valid = engine.analyze_report(
        "A person is injured at Exit A.",
        "exit-a",
        "inner door",
        datetime(2026, 10, 26, 9, tzinfo=UTC),
    )
    assert not any("UTC offset" in reason for reason in valid["review_reasons"])


def test_category_and_entity_helper_variants() -> None:
    assert engine_module._category(None) is None
    assert engine_module._category("Medical Incident") == "medical"
    assert engine_module._category("unknown/other") == "other"
    assert engine_module._category("unrecognized") is None
    assert engine_module._category_compatibility(None, "medical") == (None, False, None)
    assert engine_module._category_compatibility("other", "medical") == (None, False, None)
    assert engine_module._category_compatibility("medical", "medical") == (1.0, False, None)
    assert engine_module._category_compatibility("blocked_exit", "facility_issue")[0] == 0.4
    assert engine_module._category_compatibility("medical", "missing_person")[1] is True

    assert engine_module._shared_entities("person in a red jacket", "person in a red jacket") == [
        "red jacket"
    ]
    assert engine_module._entity_conflicts("person in a red jacket", "person in a blue jacket") == [
        "jacket"
    ]
    assert (
        engine_module._entity_conflicts(
            "person in a red jacket and a black jacket", "person in a blue jacket"
        )
        == []
    )
    assert engine_module._shared_entities("student named Asha", "student named asha") == [
        "asha person_name"
    ]
    assert engine_module._extract_entities("Hypothetically, a person in a red jacket") == {}
    assert engine_module._extract_entities("No person in a red jacket was seen") == {}
    assert engine_module._extract_entities("Hypothetically, a student named Asha is missing") == {}
    assert engine_module._extract_entities("A student not named Asha is waiting") == {}
    assert engine_module._classify_category("A phone is lost.", []) == "other"
    assert engine_module._classify_category("The machine is not broken.", []) == "other"
    assert engine_module._classify_category("A guest went missing.", []) == "missing_person"


def test_score_pair_preserves_components_missing_fields_and_constraints() -> None:
    engine = AnalysisEngine(lambda: None)
    incoming = _report("new", text="A person in a red jacket is injured.")
    existing = _report("old", text="A person in a red jacket is injured.")
    evidence = engine.score_pair(incoming, existing)
    assert evidence["semantic_score"] == 1.0
    assert evidence["location_score"] == 1.0
    assert evidence["time_score"] == 1.0
    assert evidence["category_score"] == 1.0
    assert evidence["total_score"] == 1.0
    assert evidence["decision"] == "suggest"
    assert any("Shared described entity" in reason for reason in evidence["reasons"])
    assert evidence["missing_fields"] == []

    broad = engine.score_pair(
        _report("new", sublocation=None, text="A person is injured."),
        _report("old", sublocation=None, text="A person is injured."),
    )
    assert broad["location_score"] == 0.5
    assert "specific_location_or_entity" in broad["missing_fields"]

    mismatch = engine.score_pair(
        _report("new", zone_id="exit-a", sublocation="inner door"),
        _report("old", zone_id="exit-b", sublocation="outer ramp"),
    )
    assert mismatch["decision"] == "separate"
    assert any("Hard mismatch" in reason for reason in mismatch["reasons"])

    sublocation_mismatch = engine.score_pair(
        _report("new", sublocation="north door"),
        _report("old", sublocation="south door"),
    )
    assert sublocation_mismatch["decision"] == "separate"

    entity_mismatch = engine.score_pair(
        _report("new", text="A missing child in a red jacket."),
        _report("old", text="A missing child in a blue jacket."),
    )
    assert entity_mismatch["decision"] == "separate"
    assert any("described entities conflict" in reason for reason in entity_mismatch["reasons"])

    related_categories = engine.score_pair(
        _report("new", category="blocked_exit"),
        _report("old", category="facility_issue"),
    )
    assert any(
        "related but do not establish identity" in reason
        for reason in related_categories["reasons"]
    )

    time_mismatch = engine.score_pair(
        _report("new", reported_at=_aware_time(0)),
        _report("old", reported_at="2026-10-26T10:00:00Z"),
    )
    assert time_mismatch["time_score"] == 0.0
    assert time_mismatch["decision"] == "separate"


def test_score_pair_normalizes_offsets_and_uses_missing_person_window() -> None:
    engine = AnalysisEngine(lambda: None)
    offset = engine.score_pair(
        _report("new", reported_at="2026-10-26T15:00:00+05:30", category="missing_person"),
        _report("old", reported_at="2026-10-26T09:30:00Z", category="missing_person"),
    )
    assert offset["time_score"] == 1.0

    long_window = engine.score_pair(
        _report("new", reported_at="2026-10-26T09:00:00Z", category="missing_person"),
        _report("old", reported_at="2026-10-26T10:00:00Z", category="missing_person"),
    )
    assert long_window["time_score"] == 0.5

    default_window = engine.score_pair(
        _report("new", reported_at="2026-10-26T09:00:00Z"),
        _report("old", reported_at="2026-10-26T10:00:00Z"),
    )
    assert default_window["time_score"] == 0.0

    missing_time = engine.score_pair(
        _report("new", reported_at=None), _report("old", reported_at="not-a-time")
    )
    assert missing_time["time_score"] is None
    assert "time" in missing_time["missing_fields"]


def test_score_pair_degraded_semantics_and_invalid_inputs() -> None:
    engine = AnalysisEngine(lambda: None)
    lexical = engine.score_pair(
        _report("new", model_revision=LEXICAL_REVISION),
        _report("old", model_revision=LEXICAL_REVISION),
    )
    assert lexical["semantic_score"] == 1.0
    assert any("lexical-hash fallback" in reason for reason in lexical["reasons"])

    revision_mismatch = engine.score_pair(
        _report("new", model_revision=MODEL_REVISION),
        _report("old", model_revision=LEXICAL_REVISION),
    )
    assert revision_mismatch["semantic_score"] == 1.0

    bad_vectors = engine.score_pair(
        _report("new", embedding=[0.0, 0.0]),
        _report("old", embedding=[0.0, 0.0]),
    )
    assert bad_vectors["semantic_score"] == 1.0

    empty_incoming = _report("new", text="!!!")
    empty_existing = _report("old", text="???")
    empty_incoming["embedding"] = None
    empty_existing["embedding"] = None
    empty_text = engine.score_pair(empty_incoming, empty_existing)
    assert empty_text["semantic_score"] is None
    assert "semantic" in empty_text["missing_fields"]

    missing_context = engine.score_pair(
        _report("new", zone_id=None, sublocation="north door", reported_at=None, category="other"),
        _report(
            "old", zone_id="hall", sublocation="north door", reported_at=None, category="other"
        ),
    )
    assert missing_context["location_score"] == 0.8
    assert "location" in missing_context["missing_fields"]
    assert "time" in missing_context["missing_fields"]

    shared_entity_without_zone = engine.score_pair(
        _report("new", zone_id=None, sublocation=None, text="A child in a red jacket is missing."),
        _report(
            "old", zone_id="hall", sublocation=None, text="A child in a red jacket is missing."
        ),
    )
    assert shared_entity_without_zone["location_score"] is None
    assert "specific_location_or_entity" not in shared_entity_without_zone["missing_fields"]

    no_components_incoming = _report(
        "new", text="!!!", zone_id=None, sublocation=None, reported_at=None, category=None
    )
    no_components_existing = _report(
        "old", text="???", zone_id=None, sublocation=None, reported_at=None, category=None
    )
    no_components_incoming["embedding"] = None
    no_components_existing["embedding"] = None
    no_components = engine.score_pair(no_components_incoming, no_components_existing)
    assert no_components["total_score"] == 0.0

    with pytest.raises(TypeError, match="dictionaries"):
        engine.score_pair([], {})  # type: ignore[arg-type]


def test_choose_group_attaches_only_with_anchor_margin_and_context() -> None:
    engine = AnalysisEngine(lambda: None)
    incoming = _report("new")
    attached = engine.choose_group(incoming, [_candidate_group()])
    assert attached["incident_id"] == "incident-1"
    assert attached["evidence"][0]["decision"] == "attach"
    assert "Provisional grouping" in attached["review_reasons"][0]

    missing_time = engine.choose_group(_report("new", reported_at=None), [_candidate_group()])
    assert missing_time["incident_id"] is None
    assert any("Known event time" in reason for reason in missing_time["review_reasons"])

    broad_location = engine.choose_group(
        _report("new", sublocation=None, text="A medical incident is reported."),
        [_candidate_group(sublocation=None, text="A medical incident is reported.")],
    )
    assert broad_location["incident_id"] is None
    assert any(
        "specific shared sublocation" in reason for reason in broad_location["review_reasons"]
    )

    entity_context = engine.choose_group(
        _report(
            "new",
            sublocation=None,
            text="A child in a red jacket is missing.",
            category="missing_person",
        ),
        [
            _candidate_group(
                sublocation=None,
                text="A child in a red jacket is missing.",
                category="missing_person",
            )
        ],
    )
    assert entity_context["incident_id"] == "incident-1"


def test_choose_group_does_not_transitively_bridge_and_checks_all_members() -> None:
    engine = AnalysisEngine(lambda: None)
    incoming = _report("new", embedding=[1.0, 0.0])
    anchor = _report("anchor", embedding=[0.0, 1.0])
    member = _report("member", embedding=[1.0, 0.0])
    bridge = engine.choose_group(incoming, [{"id": "group", "reports": [anchor, member]}])
    assert bridge["incident_id"] is None
    assert any("Anchor similarity is insufficient" in reason for reason in bridge["review_reasons"])

    incompatible_member = _report("other-zone", zone_id="exit-b")
    incompatible = engine.choose_group(
        _report("new"),
        [{"id": "group", "reports": [_report("anchor"), incompatible_member]}],
    )
    assert incompatible["incident_id"] is None
    assert any("incompatibility" in reason for reason in incompatible["review_reasons"])


def test_choose_group_threshold_margin_rejections_and_bad_candidates() -> None:
    engine = AnalysisEngine(lambda: None)
    incoming = _report("new", embedding=[1.0, 0.0])
    below_threshold = engine.choose_group(
        incoming,
        [_candidate_group(vector=[0.72, math.sqrt(1 - 0.72**2)])],
    )
    assert below_threshold["incident_id"] is None
    assert any("below 0.82" in reason for reason in below_threshold["review_reasons"])

    ambiguous = engine.choose_group(
        incoming,
        [
            _candidate_group("a", vector=[1.0, 0.0]),
            _candidate_group("b", vector=[0.9, math.sqrt(1 - 0.9**2)]),
        ],
    )
    assert ambiguous["incident_id"] is None
    assert any("below 0.08" in reason for reason in ambiguous["review_reasons"])

    rejected = engine.choose_group(incoming, [_candidate_group()], {("new", "incident-1")})
    assert rejected["incident_id"] is None
    assert any("prior coordinator rejection" in reason for reason in rejected["review_reasons"])
    assert rejected["evidence"][0]["decision"] == "separate"

    reversed_rejection = engine.choose_group(
        incoming, [_candidate_group()], frozenset({("incident-1", "new")})
    )
    assert reversed_rejection["incident_id"] is None

    no_id = engine.choose_group(_report(""), [_candidate_group()])
    assert no_id["incident_id"] is None
    assert any("no stable ID" in reason for reason in no_id["review_reasons"])

    empty = engine.choose_group(incoming, [])
    assert any("No usable candidate" in reason for reason in empty["review_reasons"])
    invalid_candidates = engine.choose_group(
        incoming,
        [None, {"id": "", "reports": [_report("ignored")]}, {"id": "empty", "reports": []}],
    )
    assert any("No usable candidate" in reason for reason in invalid_candidates["review_reasons"])
    invalid_members = engine.choose_group(incoming, [{"id": "bad", "reports": [None]}])
    assert any("No usable candidate" in reason for reason in invalid_members["review_reasons"])

    missing_member_time = engine.choose_group(
        incoming,
        [
            _candidate_group(
                members=[
                    _report("anchor"),
                    _report("member", reported_at=None),
                ]
            )
        ],
    )
    assert missing_member_time["incident_id"] is None
    assert any("Known event time" in reason for reason in missing_member_time["review_reasons"])

    low_similarity_missing_time = engine.choose_group(
        _report("new", text="!!!", reported_at=None, embedding=[1.0, 0.0]),
        [
            _candidate_group(
                text="A different report describes another issue.",
                reported_at=None,
                vector=[0.0, 1.0],
            )
        ],
    )
    assert low_similarity_missing_time["incident_id"] is None

    with pytest.raises(TypeError, match="incoming report"):
        engine.choose_group([], [])  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="groups must be a list"):
        engine.choose_group(incoming, ())  # type: ignore[arg-type]
    with pytest.raises(TypeError, match="rejections must be a set"):
        engine.choose_group(incoming, [], [])  # type: ignore[arg-type]


def test_priority_assessment_keeps_highest_signal_and_conflicts() -> None:
    engine = AnalysisEngine(lambda: None)
    severe = _report("danger", text="A small fire is burning in a bin.", category="other")
    reassuring = _report("update", text="No fire is visible now.", category="other")
    assessment = engine.assess_priority([severe, reassuring])
    assert assessment["priority"] == "P0"
    assert "DANGER_FIRE_SMOKE" in assessment["reason"]

    conflict = engine.assess_priority(
        [
            _report(
                "blocked",
                text="Exit A is blocked.",
                category="blocked_exit",
                claims=[{"field": "exit_access", "value": "blocked", "span": "Exit A is blocked"}],
            ),
            _report(
                "clear",
                text="Exit A is clear.",
                category="blocked_exit",
                claims=[{"field": "exit_access", "value": "clear", "span": "Exit A is clear"}],
            ),
        ]
    )
    assert conflict["priority"] == "P1"
    assert any(
        "Conflicting or changing exit_access" in reason for reason in conflict["review_reasons"]
    )

    malformed = engine.assess_priority([None, {"text": "A lamp is broken."}])  # type: ignore[list-item]
    assert malformed["priority"] == "UNASSESSED"
    assert any("malformed report" in reason for reason in malformed["review_reasons"])
    assert engine.assess_priority([])["priority"] == "UNASSESSED"
    with pytest.raises(TypeError, match="reports must be a list"):
        engine.assess_priority(())  # type: ignore[arg-type]


def test_priority_assessment_uses_supplied_claims_and_report_review_reasons() -> None:
    engine = AnalysisEngine(lambda: None)
    report = _report(
        "report-7",
        text="A person is hurt.",
        category="medical",
        claims=[{"field": "unrecognized", "value": "x", "span": "x"}, None],  # type: ignore[list-item]
    )
    report["review_reasons"] = ["prior review", ""]
    report["priority"] = "P2"
    result = engine.assess_priority([report])
    assert result["priority"] == "P1"
    assert "prior review" in result["review_reasons"]

    extracted = engine.assess_priority([{"id": "weak", "text": "A person may be injured."}])
    assert extracted["priority"] == "UNASSESSED"
    assert any("Uncertain or hypothetical" in reason for reason in extracted["review_reasons"])

    invalid_claim_values = engine_module._priority_for_text(
        "A person is injured.",
        "medical",
        [None, {"field": None, "value": 7}],  # type: ignore[list-item]
        "hall",
    )
    assert invalid_claim_values[0] == "P1"


def test_conflict_detection_preserves_opposing_claims_and_ignores_bad_data() -> None:
    engine = AnalysisEngine(lambda: None)
    blocked = _report(
        "r1",
        claims=[{"field": "exit_access", "value": "blocked", "span": "Exit A is blocked"}],
    )
    clear = _report(
        "r2",
        claims=[{"field": "exit_access", "value": "clear", "span": "Exit A is clear"}],
    )
    conflicts = engine.detect_conflicts([blocked, clear])
    assert conflicts == [
        {
            "field": "exit_access",
            "report_ids": ["r1", "r2"],
            "values": ["blocked", "clear"],
            "spans": ["Exit A is blocked", "Exit A is clear"],
        }
    ]

    extracted = engine.detect_conflicts(
        [
            {"id": "r1", "text": "Exit A is blocked."},
            {"id": "r2", "text": "Exit A is clear."},
        ]
    )
    assert len(extracted) == 1
    assert engine.detect_conflicts([blocked, blocked]) == []
    assert engine.detect_conflicts([None, {"id": "r3", "claims": [None, {}]}]) == []
    assert engine.detect_conflicts([]) == []
    with pytest.raises(TypeError, match="reports must be a list"):
        engine.detect_conflicts(())  # type: ignore[arg-type]


def test_conflict_detection_avoids_duplicate_reversed_pairs() -> None:
    engine = AnalysisEngine(lambda: None)
    claims = [
        _report("a", claims=[{"field": "person_status", "value": "missing", "span": "missing"}]),
        _report("b", claims=[{"field": "person_status", "value": "found", "span": "found"}]),
        _report("b", claims=[{"field": "person_status", "value": "found", "span": "found again"}]),
        _report(
            "a", claims=[{"field": "person_status", "value": "missing", "span": "missing again"}]
        ),
    ]
    conflicts = engine.detect_conflicts(claims)
    assert len(conflicts) == 1


def test_lexical_fallback_uses_dev_calibrated_context_gates_for_grouping() -> None:
    engine = AnalysisEngine(lambda: None)
    incoming_text = "Someone with a painful wrist is seated beside the north posters."
    existing_text = "A guest stumbled near northern posters and says their wrist hurts."
    incoming_analysis = engine.analyze_report(
        incoming_text, "hall", "north poster row", _aware_time(1)
    )
    existing_analysis = engine.analyze_report(
        existing_text, "hall", "north poster row", _aware_time(0)
    )
    incoming = {
        "id": "new",
        "text": incoming_text,
        "zone_id": "hall",
        "sublocation": "north poster row",
        "reported_at": _aware_time(1),
        **incoming_analysis,
    }
    existing = {
        "id": "old",
        "text": existing_text,
        "zone_id": "hall",
        "sublocation": "north poster row",
        "reported_at": _aware_time(0),
        **existing_analysis,
    }

    assert incoming["model_revision"] == LEXICAL_REVISION
    assert engine.config_version == "semantic-context-v1+lexical-context-dev-v2+location-aliases-v1"
    evidence = engine.score_pair(incoming, existing)
    assert evidence["semantic_score"] < 0.82
    assert evidence["decision"] == "suggest"
    assert "Same reported sublocation: north poster row." in evidence["reasons"]

    decision = engine.choose_group(incoming, [{"id": "group-1", "reports": [existing]}])
    assert decision["incident_id"] == "group-1"
    assert decision["evidence"][0]["decision"] == "attach"
    assert any("lexical-context" in reason for reason in decision["evidence"][0]["reasons"])
