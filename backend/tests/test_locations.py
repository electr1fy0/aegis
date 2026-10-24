"""Configured location equivalents cannot bridge different event zones."""

from aegis.engine import AnalysisEngine
from aegis.locations import canonical_sublocation


def test_location_equivalents_are_scoped_and_do_not_rewrite_unknown_values():
    assert canonical_sublocation(None, "hall") is None
    assert canonical_sublocation("inner door", "hall") == "inner doorway"
    assert canonical_sublocation("inner door", "stage") == "inner door"
    assert canonical_sublocation("inner door", None) == "inner door"
    assert canonical_sublocation("south door", "hall") != canonical_sublocation(
        "north door", "hall"
    )


def test_alias_matching_preserves_reporter_wording_and_respects_other_zones():
    engine = AnalysisEngine(model_loader=lambda: None)
    text = "A visitor with a blue jacket has a painful wrist at the inner doorway."
    analysis = engine.analyze_report(text, "hall", "inner doorway", "2026-10-25T10:00:00Z")
    original = {
        "id": "original",
        "text": text,
        "zone_id": "hall",
        "sublocation": "inner doorway",
        "reported_at": "2026-10-25T10:00:00Z",
        **analysis,
    }
    incoming = {**original, "id": "incoming", "sublocation": "inner door"}
    groups = [{"id": "existing", "reports": [original]}]
    assert engine.choose_group(incoming, groups)["incident_id"] == "existing"
    assert incoming["sublocation"] == "inner door"
    assert engine.choose_group({**incoming, "zone_id": "stage"}, groups)["incident_id"] is None
