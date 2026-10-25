"""Evidence-oriented report analysis for the Aegis exercise prototype.

The semantic encoder is optional and is loaded lazily from the local Hugging
Face cache. If it cannot be loaded or an inference call fails, the engine uses
a deterministic hashed bag-of-words representation and exposes that degraded
mode in health and report explanations. Neither similarity nor the weighted
score is a probability.
"""

from __future__ import annotations

import hashlib
import itertools
import math
import re
import threading
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Sequence
from datetime import UTC, datetime
from typing import Any

from .locations import LOCATION_VERSION, canonical_sublocation
from .model_config import MODEL_COMMIT, MODEL_NAME, MODEL_REVISION

LEXICAL_REVISION = "lexical-hash-v1"
LEXICAL_DIMENSION = 512
HYBRID_CONFIG_VERSION = "hybrid-context-v2"
LEXICAL_CONFIG_VERSION = "lexical-context-dev-v2"
CONFIG_VERSION = f"{HYBRID_CONFIG_VERSION}+{LEXICAL_CONFIG_VERSION}+{LOCATION_VERSION}"

_SCORE_WEIGHTS = {
    "semantic": 0.65,
    "location": 0.20,
    "time": 0.10,
    "category": 0.05,
}
# Selected against development inputs and the frozen challenge_dev fixture only;
# see evaluation/results/hybrid-development.json. No held-out test data was used.
_ATTACH_THRESHOLD = 0.76
_SUGGEST_THRESHOLD = 0.65
_ANCHOR_SEMANTIC_MINIMUM = 0.62
_RUNNER_UP_MARGIN = 0.08
# Development-only fixtures with exact shared sublocation and compatible time
# had a minimum lexical composite ranking score of 0.332669 among same-family
# pairs. The 0.33 gate applies only with those specific context checks; it is
# not a calibrated semantic score or probability. The runtime never imports
# development labels.
_LEXICAL_ATTACH_THRESHOLD = 0.33
_LEXICAL_SUGGEST_THRESHOLD = 0.33
_LEXICAL_ANCHOR_MINIMUM = 0.05
# Semantic results are now scored independently from the lexical backstop. The
# review thresholds are intentionally separate from the automatic attachment
# thresholds; they may surface a candidate for coordinator review but cannot
# attach a report.
_SEMANTIC_REVIEW_THRESHOLD = _SUGGEST_THRESHOLD
_SEMANTIC_REVIEW_ANCHOR_MINIMUM = 0.20
_DEFAULT_WINDOW_SECONDS = 20 * 60
_MISSING_PERSON_WINDOW_SECONDS = 120 * 60

_CATEGORY_VALUES = {
    "medical",
    "missing_person",
    "blocked_exit",
    "facility_issue",
    "other",
}
_CATEGORY_ALIASES = {
    "medical incident": "medical",
    "missing person": "missing_person",
    "blocked exit": "blocked_exit",
    "facility issue": "facility_issue",
    "unknown": "other",
    "unknown/other": "other",
}
_KNOWN_ZONE_MENTIONS = {
    "stage": re.compile(r"\b(?:main\s+)?stage\b", re.IGNORECASE),
    "exit-a": re.compile(r"\bexit[\s-]*a\b", re.IGNORECASE),
    "exit-b": re.compile(r"\bexit[\s-]*b\b", re.IGNORECASE),
    "food": re.compile(r"\bfood\s+court\b", re.IGNORECASE),
    "registration": re.compile(r"\bregistration\b", re.IGNORECASE),
    "hall": re.compile(r"\b(?:exhibition\s+hall|hall)\b", re.IGNORECASE),
}

_WORD_RE = re.compile(r"[a-z0-9]+(?:['\u2019-][a-z0-9]+)?", re.IGNORECASE)
_TOKEN_STOP_WORDS = {
    "a",
    "an",
    "and",
    "at",
    "by",
    "for",
    "from",
    "in",
    "into",
    "of",
    "on",
    "the",
    "to",
    "with",
}

_HYPOTHETICAL_RE = re.compile(
    r"\b(?:hypothetical(?:ly)?|if|suppose|imagine|what\s+if|in\s+case\s+of|"
    r"pretend|training\s+scenario|practice\s+scenario|might|maybe|possibly|"
    r"could\s+be|may\s+be)\b",
    re.IGNORECASE,
)
_UNCERTAIN_RE = re.compile(
    r"\b(?:not\s+sure|cannot\s+tell|can['\u2019]t\s+tell|unclear\s+whether|"
    r"unsure\s+whether|maybe|possibly|might\s+be|could\s+be|I\s+think)\b",
    re.IGNORECASE,
)
_NEGATION_RE = re.compile(
    r"\b(?:no|nobody|none|not|never|without|isn['\u2019]t|aren['\u2019]t|wasn['\u2019]t|weren['\u2019]t|"
    r"didn['\u2019]t|don['\u2019]t|doesn['\u2019]t|can['\u2019]t|cannot|neither)\b(?:[\s,]+[\w'-]+){0,3}[\s,]*$",
    re.IGNORECASE,
)
_NEGATION_AFTER_RE = re.compile(
    r"^\s*(?:not\s+(?:seen|observed|real|present|there)|"
    r"no\s+(?:evidence|signs?)\s+of|wasn['\u2019]t\s+observed|was\s+not\s+observed)\b",
    re.IGNORECASE,
)
_NEGATION_CONTRAST_RE = re.compile(r"\b(?:but|however|yet|except|instead|only)\b", re.IGNORECASE)

_EXIT_BLOCKED_RE = re.compile(
    r"\b(?:exit|door(?:way)?|egress|way\s+out|gate|opening|ramp)(?:\s+(?!(?:is|was|looks|appears|remains|not|isn['\u2019]t|aren['\u2019]t|wasn['\u2019]t|weren['\u2019]t)\b)[a-z0-9-]+){0,2}\s+"
    r"(?:(?:is|was|looks|appears|remains)\s+(?:(?:now|again|still)\s+)?)?"
    r"(?:blocked|obstructed|unusable|jammed|stuck|impassable|narrowed|"
    r"cannot\s+get\s+past|can['\u2019]t\s+get\s+past|cannot\s+get\s+through|"
    r"can['\u2019]t\s+get\s+through|will\s+not\s+open|won['\u2019]t\s+open|"
    r"cannot\s+open|can['\u2019]t\s+open|will\s+not\s+swing\s+open|"
    r"won['\u2019]t\s+swing\s+open|stuck\s+shut)\b|"
    r"\b(?:exit|door(?:way)?|egress|way\s+out|gate|opening|ramp)\b[^.!?;\n]{0,80}\b"
    r"(?:blocked|obstructed|unusable|jammed|stuck|impassable|narrowed|"
    r"will\s+not\s+open|won['\u2019]t\s+open|cannot\s+open|can['\u2019]t\s+open|"
    r"will\s+not\s+swing\s+open|won['\u2019]t\s+swing\s+open|stuck\s+shut)\b|"
    r"\b(?:jammed|stuck|blocked|obstructed|unusable|narrowed)\b"
    r"[^.!?;\n]{0,80}\b(?:exit|door(?:way)?|egress|gate|opening|ramp)\b|"
    r"\b(?:barrier|panel|cart|trolley|object)\b[^.!?;\n]{0,80}\b"
    r"(?:across|blocking|blocks?)\b[^.!?;\n]{0,50}\b(?:exit|door(?:way)?|gate|opening|ramp)\b|"
    r"\b(?:blocked|obstructed)\s+(?:exit|door(?:way)?|egress|way\s+out|gate|opening|ramp)\b|"
    r"\b(?:parked\s+across|blocks?|blocking|obstructing|obstructed|"
    r"narrows?|narrowed)\b[^.!?;\n]{0,80}\b(?:exit|ramp|door(?:way)?|passage|walkway|route)\b",
    re.IGNORECASE,
)
_EXIT_CLEAR_RE = re.compile(
    r"\b(?:exit|door(?:way)?|egress|way\s+out|gate|opening|passage|ramp)(?:\s+(?!(?:is|was|looks|appears|remains|not|isn['\u2019]t|aren['\u2019]t|wasn['\u2019]t|weren['\u2019]t)\b)[a-z0-9-]+){0,2}\s+"
    r"(?:(?:is|was|looks|appears|remains)\s+(?:(?:now|again|still)\s+)?)?"
    r"(?:clear|open|unblocked|unobstructed|accessible|passable|moving\s+freely)\b|"
    r"\b(?:clear|open|unblocked|unobstructed|passable|moving\s+freely)\s+"
    r"(?:exit|door(?:way)?|egress|way\s+out|gate|opening|passage|ramp)\b",
    re.IGNORECASE,
)
_EXIT_NEGATED_BLOCK_RE = re.compile(
    r"\b(?:not|no\s+longer|isn['\u2019]t|aren['\u2019]t|wasn['\u2019]t|weren['\u2019]t)\s+"
    r"(?:blocked|obstructed|unusable|jammed|stuck|impassable|narrowed)\b",
    re.IGNORECASE,
)
_UNRESPONSIVE_RE = re.compile(
    r"\b(?:not\s+responding|not\s+responsive|not\s+conscious|"
    r"unresponsive|unconscious|not\s+breathing|isn['\u2019]t\s+breathing)\b",
    re.IGNORECASE,
)
_RESPONSIVE_RE = re.compile(r"\b(?:responsive|awake\s+and\s+alert|conscious)\b", re.IGNORECASE)
_PERSON_MISSING_RE = re.compile(
    r"\b(?:missing|lost|can['\u2019]t\s+locate|cannot\s+locate|can['\u2019]t\s+find|"
    r"cannot\s+find|unable\s+to\s+locate|last\s+seen|separated\s+from|"
    r"(?:has|have)\s+not\s+(?:returned|come\s+back)|not\s+(?:returned|come\s+back)|"
    r"didn['\u2019]t\s+return)\b",
    re.IGNORECASE,
)
_PERSON_FOUND_RE = re.compile(
    r"\b(?:found|located|reunited|back\s+with\s+(?:their\s+)?family)\b",
    re.IGNORECASE,
)
_PERSON_CONTEXT_RE = re.compile(
    r"\b(?:person|people|child|children|infant|toddler|guest|visitor|attendee|"
    r"student|adult|family|parent|mother|father|man|woman|boy|girl|someone|anyone|"
    r"elderly|senior)\b",
    re.IGNORECASE,
)
_HAZARD_RULES = (
    ("DANGER_FIRE_SMOKE", re.compile(r"\b(?:fire|smoke|flames?)\b", re.IGNORECASE)),
    (
        "DANGER_WEAPON_VIOLENCE",
        re.compile(
            r"\b(?:weapon|gun|knife|bomb|explosion|active\s+shooter|"
            r"assault|attack|violence)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "DANGER_TRAPPED_PERSON",
        re.compile(r"\b(?:trapped|pinned\s+under)\b", re.IGNORECASE),
    ),
    (
        "DANGER_UNRESPONSIVE_PERSON",
        _UNRESPONSIVE_RE,
    ),
)
_VULNERABILITY_RE = re.compile(
    r"\b(?:child|children|infant|toddler|elderly|senior|wheelchair|"
    r"mobility\s+needs|needs\s+medication|medication|disability|"
    r"dementia|cognitive\s+impairment)\b",
    re.IGNORECASE,
)
_MEDICAL_RE = re.compile(
    r"\b(?:medical\s+(?:incident|emergency|help)|injured|injury|hurt|hurts|"
    r"wounded|bleeding|sore|painful|in\s+pain|collapsed|unconscious|"
    r"unresponsive|not\s+responsive|not\s+breathing|ambulance|dizzy|"
    r"call(?:ing)?\s+(?:(?:a|the)\s+)?medic|medic(?:al)?\s+help|"
    r"(?:twisted|sprained)\s+(?:(?:my|his|her|their|someone['\u2019]s)\s+)?"
    r"(?:an?\s+)?(?:ankle|wrist)|fractured\s+(?:an?\s+)?(?:ankle|wrist|arm|leg))\b",
    re.IGNORECASE,
)
_FACILITY_OBJECT_RE = re.compile(
    r"\b(?:water|liquid|elevator|lift|air\s+conditioning|HVAC|toilet|restroom|"
    r"equipment|facility|fixture|projector|monitor|screen|display|printer|label|"
    r"handrail|rail|mat|raised\s+edge|walkway|passage|floor|lamp|fan|light|"
    r"ceiling|cooler|dispenser|counter|machine)\b",
    re.IGNORECASE,
)
_FACILITY_FAULT_RE = re.compile(
    r"\b(?:broken|break|leak(?:s|ed|ing)?|spilled|spill|spreading|puddle|wet|slick|"
    r"slippery|faulty|outage|power\s+failure|went\s+out|flickering|rattling|"
    r"fault|malfunction|damaged|cracked|loose|wobbly|wobbling|shaking|shakes|"
    r"loose|raised|folded|curled|crowded|narrowed|obstructing|obstructed|"
    r"blank|no\s+(?:image|picture)|lost\s+(?:its\s+)?(?:picture|signal|audio)|"
    r"will\s+not\s+open|won['\u2019]t\s+open|stuck\s+shut|hot)\b|"
    r"\b(?:power\s+failure|power\s+outage|water\s+leak|lighting\s+outage)\b",
    re.IGNORECASE,
)
_COLORED_ENTITY_RE = re.compile(
    r"\b(?P<color>red|blue|green|black|white|yellow|orange|purple|pink|"
    r"brown|gray|grey)\s+(?P<kind>jacket|shirt|coat|hoodie|backpack|"
    r"bag|hat|vest|bicycle|bike|car)\b",
    re.IGNORECASE,
)
_NAMED_ENTITY_RE = re.compile(
    r"\b(?:person|student|child|man|woman|boy|girl)\s+"
    r"(?:named|called)\s+(?P<name>[A-Z][a-z]{1,24})\b",
    re.IGNORECASE,
)
_EXPLICIT_DISTINCT_EVENT_RE = re.compile(
    r"\b(?:(?:another|different|new|separate)\s+(?:incident|event|emergency)|"
    r"(?:not|unrelated\s+to)\s+(?:the\s+same|this)\s+(?:incident|event)|"
    r"not\s+the\s+same\s+(?:incident|event))\b",
    re.IGNORECASE,
)


def _load_local_sentence_transformer() -> Any:
    """Load MiniLM without permitting a hub/network download."""
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(
        MODEL_NAME, revision=MODEL_COMMIT, local_files_only=True, trust_remote_code=False
    )


def _normalise_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalised = " ".join(value.casefold().strip().split())
    return normalised or None


def _parse_timestamp(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        candidate = value.strip()
        if not candidate:
            return None
        if candidate.endswith("Z"):
            candidate = candidate[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(candidate)
        except ValueError:
            return None
    else:
        return None

    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(UTC)


def _to_plain_sequence(value: Any) -> Any:
    if hasattr(value, "tolist"):
        try:
            value = value.tolist()
        except Exception:
            return None
    return value


def _unit_vector(value: Any) -> list[float] | None:
    sequence = _to_plain_sequence(value)
    if not isinstance(sequence, (list, tuple)) or not sequence:
        return None
    if len(sequence) == 1 and isinstance(sequence[0], (list, tuple)):
        sequence = _to_plain_sequence(sequence[0])
    if not isinstance(sequence, (list, tuple)) or not sequence:
        return None
    try:
        vector = [float(component) for component in sequence]
    except TypeError, ValueError, OverflowError:
        return None
    if not all(math.isfinite(component) for component in vector):
        return None
    scale = max(abs(component) for component in vector)
    if scale == 0.0:
        return None
    vector = [component / scale for component in vector]
    magnitude = math.sqrt(sum(component * component for component in vector))
    return [component / magnitude for component in vector]


def _cosine(left: Any, right: Any) -> float | None:
    left_vector = _unit_vector(left)
    right_vector = _unit_vector(right)
    if left_vector is None or right_vector is None:
        return None
    if len(left_vector) != len(right_vector):
        return None
    similarity = sum(a * b for a, b in zip(left_vector, right_vector, strict=True))
    return min(1.0, max(0.0, similarity))


def _lexical_vector(text: str) -> list[float] | None:
    tokens = [match.group(0).casefold().replace("\u2019", "'") for match in _WORD_RE.finditer(text)]
    if not tokens:
        return None
    features: Counter[str] = Counter()
    kept = [token for token in tokens if token not in _TOKEN_STOP_WORDS]
    for token in kept:
        features[f"word:{token}"] += 1.0
    for left, right in itertools.pairwise(kept):
        features[f"bigram:{left}_{right}"] += 1.5
    if not features:
        for token in tokens:
            features[f"word:{token}"] += 1.0

    vector = [0.0] * LEXICAL_DIMENSION
    for feature, count in features.items():
        digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
        bucket = int.from_bytes(digest, "big") % LEXICAL_DIMENSION
        vector[bucket] += 1.0 + math.log(count)
    return _unit_vector(vector)


def _nearby_clause(text: str, position: int) -> str:
    left_boundaries = [text.rfind(mark, 0, position) for mark in ".!?;\n"]
    left = max(left_boundaries) + 1
    right_candidates = [text.find(mark, position) for mark in ".!?;\n"]
    right_candidates = [candidate for candidate in right_candidates if candidate >= 0]
    right = min(right_candidates) if right_candidates else len(text)
    return text[left:right]


def _is_hypothetical(text: str, match: re.Match[str]) -> bool:
    clause = _nearby_clause(text, match.start())
    return _HYPOTHETICAL_RE.search(clause)


def _is_negated(text: str, match: re.Match[str]) -> bool:
    clause = _nearby_clause(text, match.start())
    left_boundaries = [text.rfind(mark, 0, match.start()) for mark in ".!?;\n"]
    local_start = match.start() - (max(left_boundaries) + 1)
    before = clause[:local_start]
    after = clause[local_start + (match.end() - match.start()) :]
    negation = _NEGATION_RE.search(before[-48:])
    if negation and not _NEGATION_CONTRAST_RE.search(negation.group(0)):
        return True
    return bool(_NEGATION_AFTER_RE.search(after[:48]))


def _phrase_is_uncertain(text: str, match: re.Match[str]) -> bool:
    clause = _nearby_clause(text, match.start())
    return bool(_UNCERTAIN_RE.search(clause) or _is_hypothetical(text, match))


def _has_person_context(text: str, match: re.Match[str]) -> bool:
    clause = _nearby_clause(text, match.start())
    return bool(_PERSON_CONTEXT_RE.search(clause))


def _facility_fault_match(text: str) -> re.Match[str] | None:
    """Return an affirmative fault cue tied to a facility object or clear outage."""
    for match in _FACILITY_FAULT_RE.finditer(text):
        if _is_negated(text, match) or _is_hypothetical(text, match):
            continue
        clause = _nearby_clause(text, match.start())
        standalone_fault = re.search(
            r"\b(?:puddle|outage|power\s+failure|power\s+outage|lighting\s+outage)\b",
            match.group(0),
            re.IGNORECASE,
        )
        if standalone_fault or _FACILITY_OBJECT_RE.search(clause):
            return match
    return None


def _claim_matches(
    text: str,
    pattern: re.Pattern[str],
    field: str,
    value: str,
) -> list[tuple[int, dict[str, str]]]:
    claims: list[tuple[int, dict[str, str]]] = []
    for match in pattern.finditer(text):
        if _is_hypothetical(text, match) or _phrase_is_uncertain(text, match):
            continue
        if field == "person_status" and not _has_person_context(text, match):
            continue
        if (
            field == "exit_access"
            and value == "blocked"
            and _EXIT_NEGATED_BLOCK_RE.search(match.group(0))
        ):
            continue
        if _is_negated(text, match):
            continue
        claims.append(
            (
                match.start(),
                {"field": field, "value": value, "span": match.group(0)},
            )
        )
    return claims


def _extract_claims(text: str) -> tuple[list[dict[str, str]], list[str]]:
    located: list[tuple[int, dict[str, str]]] = []
    for pattern, value in ((_EXIT_BLOCKED_RE, "blocked"), (_EXIT_CLEAR_RE, "clear")):
        located.extend(_claim_matches(text, pattern, "exit_access", value))

    # “Not responsive” is an explicit unresponsive observation because the
    # pattern includes “not”; “not unconscious” is negated by its preceding
    # “not” and is not evidence of either supported condition.
    located.extend(
        _claim_matches(
            text,
            _UNRESPONSIVE_RE,
            "reported_condition",
            "unresponsive",
        )
    )
    located.extend(_claim_matches(text, _RESPONSIVE_RE, "reported_condition", "responsive"))

    located.extend(_claim_matches(text, _PERSON_MISSING_RE, "person_status", "missing"))
    located.extend(_claim_matches(text, _PERSON_FOUND_RE, "person_status", "found"))

    located.sort(key=lambda item: item[0])
    claims: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for _, claim in located:
        key = (claim["field"], claim["value"], claim["span"].casefold())
        if key in seen:
            continue
        seen.add(key)
        claims.append(claim)

    review_reasons: list[str] = []
    if _UNCERTAIN_RE.search(text) or _HYPOTHETICAL_RE.search(text):
        review_reasons.append(
            "Uncertain or hypothetical wording needs human review; no claim was inferred from it."
        )
    values_by_field: dict[str, set[str]] = defaultdict(set)
    for claim in claims:
        values_by_field[claim["field"]].add(claim["value"])
    if any(len(values) > 1 for values in values_by_field.values()):
        review_reasons.append(
            "This report contains opposing supported claims; preserve both for review."
        )
    return claims, review_reasons


def _classify_category(text: str, claims: Sequence[dict[str, Any]]) -> str:
    claim_fields = {claim.get("field") for claim in claims}
    if "person_status" in claim_fields:
        return "missing_person"
    if "reported_condition" in claim_fields:
        return "medical"
    if "exit_access" in claim_fields:
        return "blocked_exit"

    for match in _MEDICAL_RE.finditer(text):
        if not _is_negated(text, match) and not _is_hypothetical(text, match):
            return "medical"
    for pattern in (_PERSON_MISSING_RE, _PERSON_FOUND_RE):
        for match in pattern.finditer(text):
            if (
                _has_person_context(text, match)
                and not _is_negated(text, match)
                and not _is_hypothetical(text, match)
            ):
                return "missing_person"
    if _facility_fault_match(text) is not None:
        return "facility_issue"
    return "other"


def _extract_entities(text: str) -> dict[str, set[str]]:
    entities: dict[str, set[str]] = defaultdict(set)
    for match in _COLORED_ENTITY_RE.finditer(text):
        if _is_hypothetical(text, match) or _is_negated(text, match):
            continue
        kind = match.group("kind").casefold()
        color = match.group("color").casefold().replace("grey", "gray")
        entities[kind].add(color)
    for match in _NAMED_ENTITY_RE.finditer(text):
        if _is_hypothetical(text, match) or _is_negated(text, match):
            continue
        entities["person_name"].add(match.group("name").casefold())
    return dict(entities)


def _shared_entities(left: str, right: str) -> list[str]:
    left_entities = _extract_entities(left)
    right_entities = _extract_entities(right)
    shared: list[str] = []
    for kind in sorted(left_entities.keys() & right_entities.keys()):
        shared.extend(
            f"{color} {kind}" for color in sorted(left_entities[kind] & right_entities[kind])
        )
    return shared


def _entity_conflicts(left: str, right: str) -> list[str]:
    left_entities = _extract_entities(left)
    right_entities = _extract_entities(right)
    conflicts: list[str] = []
    for kind in sorted(left_entities.keys() & right_entities.keys()):
        if (
            len(left_entities[kind]) == 1
            and len(right_entities[kind]) == 1
            and left_entities[kind].isdisjoint(right_entities[kind])
        ):
            conflicts.append(kind)
    return conflicts


def _category(value: Any) -> str | None:
    normalised = _normalise_text(value)
    if normalised is None:
        return None
    normalised = _CATEGORY_ALIASES.get(normalised, normalised)
    return normalised if normalised in _CATEGORY_VALUES else None


def _category_compatibility(left: Any, right: Any) -> tuple[float | None, bool, str | None]:
    left_category = _category(left)
    right_category = _category(right)
    if left_category is None or right_category is None:
        return None, False, None
    if left_category == "other" or right_category == "other":
        return None, False, None
    if left_category == right_category:
        return 1.0, False, None
    if {left_category, right_category} == {"blocked_exit", "facility_issue"}:
        return (
            0.4,
            False,
            "The exit and facility categories are related but do not establish identity.",
        )
    return 0.0, True, "Hard mismatch: the supported report categories are incompatible."


def _location_comparison(
    incoming: dict[str, Any], existing: dict[str, Any], shared_entity: bool
) -> tuple[float | None, bool, bool, list[str], list[str]]:
    reasons: list[str] = []
    missing: list[str] = []
    left_zone = _normalise_text(incoming.get("zone_id"))
    right_zone = _normalise_text(existing.get("zone_id"))
    left_sublocation = canonical_sublocation(
        _normalise_text(incoming.get("sublocation")), left_zone
    )
    right_sublocation = canonical_sublocation(
        _normalise_text(existing.get("sublocation")), right_zone
    )
    if left_zone is None or right_zone is None:
        missing.append("location")
        reasons.append("Reported zone is missing on at least one report.")
        same_sublocation = bool(
            left_sublocation and right_sublocation and left_sublocation == right_sublocation
        )
        if same_sublocation:
            reasons.append(f"Same reported sublocation despite a missing zone: {left_sublocation}.")
            return 0.8, False, True, reasons, missing
        return None, False, shared_entity, reasons, missing
    if left_zone != right_zone:
        return (
            0.0,
            True,
            False,
            [f"Hard mismatch: reported zones differ ({left_zone} vs {right_zone})."],
            missing,
        )

    if left_sublocation and right_sublocation:
        if left_sublocation != right_sublocation:
            return (
                0.0,
                True,
                False,
                [
                    "Hard mismatch: reported sublocations differ "
                    f"({left_sublocation} vs {right_sublocation})."
                ],
                missing,
            )
        reasons.append(f"Same reported sublocation: {left_sublocation}.")
        return 1.0, False, True, reasons, missing

    missing.append("specific_location")
    reasons.append(f"Same broad zone: {left_zone}.")
    if shared_entity:
        reasons.append("A matching specific entity description supplies identity context.")
    else:
        reasons.append("No shared specific sublocation or described entity is available.")
    return 0.5, False, False, reasons, missing


def _time_comparison(
    incoming: dict[str, Any], existing: dict[str, Any]
) -> tuple[float | None, bool, list[str], list[str]]:
    left_time = _parse_timestamp(incoming.get("reported_at"))
    right_time = _parse_timestamp(existing.get("reported_at"))
    reasons: list[str] = []
    missing: list[str] = []
    if left_time is None or right_time is None:
        missing.append("time")
        reasons.append("Reported event time is missing or has no UTC offset.")
        return None, False, reasons, missing
    delta_seconds = abs((left_time - right_time).total_seconds())
    left_category = _category(incoming.get("category"))
    right_category = _category(existing.get("category"))
    window_seconds = (
        _MISSING_PERSON_WINDOW_SECONDS
        if "missing_person" in {left_category, right_category}
        else _DEFAULT_WINDOW_SECONDS
    )
    if delta_seconds > window_seconds:
        minutes = delta_seconds / 60.0
        return (
            0.0,
            True,
            [
                "Hard mismatch: reports are outside the documented time window "
                f"({minutes:.1f} minutes apart)."
            ],
            missing,
        )
    minutes = delta_seconds / 60.0
    reasons.append(f"Reported event times are {minutes:.1f} minutes apart.")
    return max(0.0, 1.0 - delta_seconds / window_seconds), False, reasons, missing


def _weighted_score(components: dict[str, float | None]) -> float:
    available = [
        (_SCORE_WEIGHTS[name], value) for name, value in components.items() if value is not None
    ]
    if not available:
        return 0.0
    total_weight = sum(weight for weight, _ in available)
    return sum(weight * value for weight, value in available) / total_weight


def _mentions_other_zone(text: str, zone_id: Any) -> list[str]:
    supplied = _normalise_text(zone_id)
    mentioned = [zone for zone, pattern in _KNOWN_ZONE_MENTIONS.items() if pattern.search(text)]
    if supplied is None:
        return mentioned
    return [zone for zone in mentioned if zone != supplied]


def _priority_for_text(
    text: str,
    category: str,
    claims: Sequence[dict[str, Any]],
    zone_id: Any,
    report_id: Any = None,
) -> tuple[str, str, list[str]]:
    reasons: list[str] = []
    for rule_id, pattern in _HAZARD_RULES:
        for match in pattern.finditer(text):
            if rule_id == "DANGER_FIRE_SMOKE" and re.match(
                r"\s+(?:exit|door|extinguisher|alarm|detector|drill|machine)\b",
                text[match.end() :],
                re.IGNORECASE,
            ):
                continue
            if _is_negated(text, match) or _is_hypothetical(text, match):
                continue
            phrase = _nearby_clause(text, match.start()).strip()
            source = f" in report {report_id}" if report_id else ""
            reason = (
                f"P0 rule {rule_id}: source phrase “{phrase}”{source} alleges immediate danger; "
                "a human coordinator must review it now."
            )
            return "P0", reason, ["P0 immediate-danger evidence requires human review."]

    claim_values: dict[str, set[str]] = defaultdict(set)
    for claim in claims:
        if not isinstance(claim, dict):
            continue
        field = claim.get("field")
        value = claim.get("value")
        if isinstance(field, str) and isinstance(value, str):
            claim_values[field].add(value)
    if "exit_access" in claim_values and "blocked" in claim_values["exit_access"]:
        blocked = next(
            claim["span"]
            for claim in claims
            if claim.get("field") == "exit_access" and claim.get("value") == "blocked"
        )
        source = f" in report {report_id}" if report_id else ""
        return (
            "P1",
            f"P1 rule EXIT-1: reported exit blockage “{blocked}”{source}; urgent human review.",
            ["Reported blocked exit requires urgent human review."],
        )

    if category == "missing_person":
        if _VULNERABILITY_RE.search(text):
            phrase = _VULNERABILITY_RE.search(text)
            source = f" in report {report_id}" if report_id else ""
            return (
                "P1",
                "P1 rule PERSON-1: missing-person report includes vulnerability cue "
                f"“{phrase.group(0)}”{source}; urgent human review.",
                ["Potentially vulnerable missing person requires urgent human review."],
            )
        reasons.append(
            "Missing-person vulnerability is unspecified; keep the priority unassessed for review."
        )
        return (
            "UNASSESSED",
            "Rule U0: missing-person report has no supported vulnerability cue; human "
            "assessment required.",
            reasons,
        )

    if category == "medical":
        reasons.append("Medical report requires a human coordinator to assess urgency.")
        return (
            "P1",
            "P1 rule MED-1: supported medical concern without an explicit P0 phrase; urgent "
            "human review.",
            reasons,
        )

    if category == "facility_issue":
        fault = _facility_fault_match(text)
        if fault is None:
            return (
                "UNASSESSED",
                "Rule U0: no affirmative facility fault is supported; human assessment required.",
                ["Facility equipment or location was mentioned without a supported fault cue."],
            )
        has_location = bool(_normalise_text(zone_id))
        if has_location:
            phrase = fault.group(0)
            return (
                "P2",
                f"P2 rule FAC-1: facility issue “{phrase}” has a reporter-supplied zone; "
                "standard review.",
                [],
            )
        return (
            "UNASSESSED",
            "Rule U0: facility issue has no reporter-supplied zone; human assessment required.",
            ["Facility issue location is missing; priority needs human review."],
        )

    return (
        "UNASSESSED",
        "Rule U0: no supported affirmative priority rule matched; human assessment required.",
        ["No supported priority rule matched; human review is required."],
    )


def _report_text(report: dict[str, Any]) -> str:
    value = report.get("text")
    return value if isinstance(value, str) else ""


def _report_id(report: dict[str, Any]) -> str:
    value = report.get("id")
    return str(value) if value is not None else ""


def _pair_ambiguity_reasons(incoming: dict[str, Any], existing: dict[str, Any]) -> list[str]:
    """Find report-level conflicts that need review before auto-attachment."""
    texts = (_report_text(incoming), _report_text(existing))
    reasons: list[str] = []
    if any(_UNCERTAIN_RE.search(text) or _HYPOTHETICAL_RE.search(text) for text in texts):
        reasons.append(
            "Uncertain or hypothetical wording prevents automated incident identity; "
            "review this candidate."
        )
    if any(_EXPLICIT_DISTINCT_EVENT_RE.search(text) for text in texts):
        reasons.append(
            "The report text describes a distinct incident or event; do not attach automatically."
        )
    if any(
        _mentions_other_zone(text, report.get("zone_id"))
        for text, report in zip(texts, (incoming, existing), strict=True)
    ):
        reasons.append(
            "Report text names a different known zone than its form selection; "
            "review location before grouping."
        )
    return _dedupe(reasons)


class AnalysisEngine:
    """Analyse reports with optional local MiniLM and explainable context gates."""

    config_version = CONFIG_VERSION

    def __init__(self, model_loader: Callable[[], Any] | None = None) -> None:
        self._model_loader = model_loader or _load_local_sentence_transformer
        self._encoder: Any = None
        self._load_attempted = False
        self._load_failed = False
        self._inference_failed = False
        self._lock = threading.RLock()

    def _ensure_encoder(self) -> Any:
        with self._lock:
            if self._load_attempted:
                return self._encoder
            self._load_attempted = True
            try:
                encoder = self._model_loader()
                if encoder is None or not callable(getattr(encoder, "encode", None)):
                    raise TypeError("model loader did not provide an encoder")
            except Exception:
                self._load_failed = True
                self._encoder = None
                return None
            self._encoder = encoder
            self._load_failed = False
            return self._encoder

    def _embedding_for(self, text: str) -> tuple[list[float], str, bool]:
        encoder = self._ensure_encoder()
        if encoder is not None:
            try:
                with self._lock:
                    encoded = encoder.encode(
                        [text],
                        convert_to_numpy=True,
                        normalize_embeddings=True,
                        show_progress_bar=False,
                    )
                vector = _unit_vector(encoded)
                if vector is None:
                    raise ValueError("encoder returned an empty or invalid vector")
            except Exception:
                with self._lock:
                    self._inference_failed = True
                return _lexical_vector(text) or [], LEXICAL_REVISION, False
            with self._lock:
                self._inference_failed = False
            return vector, MODEL_REVISION, True
        return _lexical_vector(text) or [], LEXICAL_REVISION, False

    def health(self) -> dict[str, Any]:
        encoder = self._ensure_encoder()
        with self._lock:
            semantic_ready = encoder is not None and not self._inference_failed
        if semantic_ready:
            return {
                "status": "ready",
                "engine": "semantic",
                "model_ready": True,
                "model_revision": MODEL_REVISION,
            }
        return {
            "status": "degraded",
            "engine": "lexical",
            "model_ready": False,
            "model_revision": None,
        }

    def analyze_report(
        self,
        text: str,
        zone_id: str | None = None,
        sublocation: str | None = None,
        reported_at: str | datetime | None = None,
    ) -> dict[str, Any]:
        if not isinstance(text, str):
            raise TypeError("text must be a string")
        clean_text = text.strip()
        if not clean_text:
            raise ValueError("text must contain at least one non-whitespace character")
        if len(clean_text) > 4000:
            raise ValueError("text must not exceed 4000 characters")

        claims, review_reasons = _extract_claims(clean_text)
        category = _classify_category(clean_text, claims)
        priority, priority_reason, priority_reviews = _priority_for_text(
            clean_text, category, claims, zone_id
        )
        review_reasons.extend(priority_reviews)

        if not _normalise_text(zone_id):
            review_reasons.append(
                "Reported zone is unknown; keep this report in the unlocated review tray."
            )
        elif not _normalise_text(sublocation) and not _extract_entities(clean_text):
            review_reasons.append(
                "Only broad-zone location is known; specific location or entity evidence needs "
                "review."
            )
        if reported_at is None:
            review_reasons.append(
                "Reported event time is unknown; automated grouping needs review."
            )
        elif _parse_timestamp(reported_at) is None:
            review_reasons.append(
                "Reported event time has no valid UTC offset; automated grouping needs review."
            )
        if _mentions_other_zone(clean_text, zone_id):
            other_zones = ", ".join(sorted(set(_mentions_other_zone(clean_text, zone_id))))
            review_reasons.append(
                f"Text mentions {other_zones} while the form supplies {zone_id}; "
                "preserve both and review."
            )
        if category == "other":
            review_reasons.append(
                "No supported incident category was extracted; human review is required."
            )

        embedding, model_revision, semantic = self._embedding_for(clean_text)
        if not semantic:
            review_reasons.append(
                "MiniLM is unavailable for this analysis; lexical-hash similarity is a "
                "degraded ranking signal."
            )
        return {
            "category": category,
            "claims": claims,
            "priority": priority,
            "priority_reason": priority_reason,
            "review_reasons": _dedupe(review_reasons),
            "embedding": embedding,
            "model_revision": model_revision,
        }

    def _pair_analysis(
        self, incoming: dict[str, Any], existing: dict[str, Any]
    ) -> tuple[dict[str, Any], bool, bool, dict[str, Any]]:
        incoming_text = _report_text(incoming)
        existing_text = _report_text(existing)
        shared_entities = _shared_entities(incoming_text, existing_text)
        entity_conflicts = _entity_conflicts(incoming_text, existing_text)
        reasons: list[str] = []
        missing_fields: list[str] = []

        incoming_embedding = incoming.get("embedding")
        existing_embedding = existing.get("embedding")
        incoming_revision = incoming.get("model_revision")
        existing_revision = existing.get("model_revision")
        dense_available = (
            incoming_revision == MODEL_REVISION and existing_revision == MODEL_REVISION
        )
        dense_score = None
        if dense_available and incoming_embedding is not None and existing_embedding is not None:
            dense_score = _cosine(incoming_embedding, existing_embedding)
        lexical_score = _cosine(_lexical_vector(incoming_text), _lexical_vector(existing_text))

        location_score, location_hard, same_sublocation, location_reasons, location_missing = (
            _location_comparison(incoming, existing, bool(shared_entities))
        )
        reasons.extend(location_reasons)
        missing_fields.extend(location_missing)
        time_score, time_hard, time_reasons, time_missing = _time_comparison(incoming, existing)
        reasons.extend(time_reasons)
        missing_fields.extend(time_missing)
        category_score, category_hard, category_reason = _category_compatibility(
            incoming.get("category"), existing.get("category")
        )
        if category_score is None:
            missing_fields.append("category")
            reasons.append("A supported category is missing on at least one report.")
        elif category_reason:
            reasons.append(category_reason)
        if shared_entities:
            reasons.append("Shared described entity: " + ", ".join(shared_entities) + ".")
        if entity_conflicts:
            category_hard = True
            reasons.append(
                "Hard mismatch: described entities conflict for "
                + ", ".join(entity_conflicts)
                + "."
            )

        ambiguity_reasons = _pair_ambiguity_reasons(incoming, existing)
        reasons.extend(ambiguity_reasons)

        context_components = {
            "location": location_score,
            "time": time_score,
            "category": category_score,
        }
        lexical_total = _weighted_score({"semantic": lexical_score, **context_components})
        semantic_total = (
            _weighted_score({"semantic": dense_score, **context_components})
            if dense_score is not None
            else None
        )
        if dense_score is not None:
            semantic_score = dense_score
            total_score = semantic_total
            if lexical_score is not None:
                reasons.append(
                    "Text similarity uses pinned MiniLM cosine "
                    f"{dense_score:.3f}; the independent lexical-hash cosine is "
                    f"{lexical_score:.3f}."
                )
            else:
                reasons.append(
                    "Text similarity uses pinned MiniLM; lexical-hash text similarity is "
                    "unavailable."
                )
            reasons.append("Composite total_score uses pinned MiniLM plus the context components.")
        else:
            semantic_score = lexical_score
            total_score = lexical_total
            if lexical_score is not None:
                reasons.append(
                    "Text similarity uses the local lexical-hash fallback; stored vectors were not "
                    "compared across model revisions."
                )
            else:
                missing_fields.append("semantic")
                reasons.append(
                    "Text similarity is unavailable because one report has no usable text."
                )
            reasons.append("Composite total_score uses the local lexical-hash signal.")
        hard_incompatible = location_hard or time_hard or category_hard
        specifically_located = same_sublocation or bool(shared_entities)
        if not specifically_located:
            missing_fields.append("specific_location_or_entity")
        if len(context_components) + 1 > sum(
            value is not None for value in (semantic_score, *context_components.values())
        ):
            reasons.append(
                "Missing score components were omitted and available weights were renormalized."
            )
        if hard_incompatible:
            decision = "separate"
        elif total_score >= (
            _SUGGEST_THRESHOLD if dense_score is not None else _LEXICAL_SUGGEST_THRESHOLD
        ):
            decision = "suggest"
        else:
            decision = "separate"
        evidence = {
            "report_id": _report_id(incoming),
            "candidate_report_id": _report_id(existing),
            "semantic_score": _rounded(semantic_score),
            "location_score": _rounded(location_score),
            "time_score": _rounded(time_score),
            "category_score": _rounded(category_score),
            "total_score": _rounded(total_score),
            "decision": decision,
            "reasons": _dedupe(reasons),
            "missing_fields": _dedupe(missing_fields),
        }
        route_scores = {
            "dense_available": dense_score is not None,
            "dense_score": dense_score,
            "dense_total": semantic_total,
            "lexical_score": lexical_score,
            "lexical_total": lexical_total,
            "ambiguity_reasons": ambiguity_reasons,
            "revision_mismatch": incoming_revision != existing_revision,
            "explicit_distinct_event": any(
                _EXPLICIT_DISTINCT_EVENT_RE.search(text) for text in (incoming_text, existing_text)
            ),
        }
        return evidence, hard_incompatible, specifically_located, route_scores

    def score_pair(self, incoming: dict[str, Any], existing: dict[str, Any]) -> dict[str, Any]:
        """Return an inspectable pair score; it is a ranking signal, not a probability."""
        if not isinstance(incoming, dict) or not isinstance(existing, dict):
            raise TypeError("incoming and existing reports must be dictionaries")
        evidence, _, _, _ = self._pair_analysis(incoming, existing)
        return evidence

    def choose_group(
        self,
        incoming: dict[str, Any],
        groups: list[dict[str, Any]],
        rejections: set[tuple[str, str]] | None = None,
    ) -> dict[str, Any]:
        """Choose one conservative candidate without transitive group chaining."""
        if not isinstance(incoming, dict):
            raise TypeError("incoming report must be a dictionary")
        if not isinstance(groups, list):
            raise TypeError("groups must be a list")
        rejected_pairs = rejections if rejections is not None else set()
        if not isinstance(rejected_pairs, (set, frozenset)):
            raise TypeError("rejections must be a set of report/incident pairs")

        incoming_id = _report_id(incoming)
        all_evidence: list[dict[str, Any]] = []
        potential_conflict_review_reasons: list[str] = []
        lexical_candidates: list[dict[str, Any]] = []
        semantic_candidates: list[dict[str, Any]] = []
        semantic_review_candidates: list[dict[str, Any]] = []
        rejected_any = False
        missing_gate_any = False
        anchor_gate_any = False
        hard_mismatch_any = False
        mixed_revision_any = False

        def with_potential_conflicts(reasons: list[str]) -> list[str]:
            return _dedupe([*reasons, *potential_conflict_review_reasons])

        for group in groups:
            if not isinstance(group, dict):
                continue
            group_id_value = group.get("id")
            group_id = str(group_id_value) if group_id_value is not None else ""
            reports = group.get("reports")
            if not group_id or not isinstance(reports, list) or not reports:
                continue

            candidate_reports = [report for report in reports if isinstance(report, dict)]
            pair_results = [self._pair_analysis(incoming, report) for report in candidate_reports]
            if not pair_results:
                continue
            pair_evidence = [result[0] for result in pair_results]
            all_evidence.extend(pair_evidence)
            is_rejected = (incoming_id, group_id) in rejected_pairs or (
                group_id,
                incoming_id,
            ) in rejected_pairs
            if is_rejected:
                rejected_any = True
                for evidence in pair_evidence:
                    evidence["decision"] = "separate"
                    evidence["reasons"].append(
                        "A coordinator rejection blocks this report-to-incident pairing."
                    )
                continue

            hard_mismatch = any(result[1] for result in pair_results)
            hard_mismatch_any = hard_mismatch_any or hard_mismatch
            explicit_separation = any(
                result[3]["explicit_distinct_event"] for result in pair_results
            )
            if explicit_separation:
                for evidence in pair_evidence:
                    evidence["decision"] = "separate"
                    evidence["reasons"].append(
                        "A report explicitly describes a different incident or event; "
                        "the candidate group is not eligible."
                    )
                continue
            for candidate_report, result in zip(candidate_reports, pair_results, strict=True):
                evidence, hard, specifically_located, _ = result
                if hard or not specifically_located:
                    continue
                for conflict in self.detect_conflicts([incoming, candidate_report]):
                    report_ids = conflict["report_ids"]
                    values = conflict["values"]
                    spans = conflict["spans"]
                    warning = (
                        "Potential conflicting or changing accounts; compare report IDs "
                        f"{report_ids[0]} and {report_ids[1]}: {conflict['field']} is "
                        f"{values[0]} (“{spans[0]}”) versus {values[1]} (“{spans[1]}”)."
                    )
                    evidence["reasons"].append(warning)
                    potential_conflict_review_reasons.append(warning)
            times_known = all(
                "time" not in evidence["missing_fields"] for evidence in pair_evidence
            )
            anchor_evidence, anchor_hard, anchor_specific, _ = pair_results[0]
            required_context = (
                not anchor_hard and times_known and anchor_specific and not hard_mismatch
            )
            if not required_context:
                missing_gate_any = missing_gate_any or not times_known or not anchor_specific
                if hard_mismatch:
                    for evidence in pair_evidence:
                        evidence["decision"] = "separate"
                        evidence["reasons"].append(
                            "The candidate group contains a hard mismatch with another "
                            "member; no pair in this group is eligible."
                        )
                else:
                    for evidence in pair_evidence:
                        if evidence["decision"] != "separate":
                            evidence["decision"] = "suggest"
                continue

            route_details = [result[3] for result in pair_results]
            ambiguity_reasons = _dedupe(
                reason for route in route_details for reason in route["ambiguity_reasons"]
            )

            def candidate_for_route(
                route_name: str,
                anchor_minimum: float,
                *,
                group_id: str = group_id,
                route_details: list[dict[str, Any]] = route_details,
                anchor_evidence: dict[str, Any] = anchor_evidence,
                pair_evidence: list[dict[str, Any]] = pair_evidence,
                ambiguity_reasons: list[str] = ambiguity_reasons,
            ) -> dict[str, Any] | None:
                nonlocal anchor_gate_any, mixed_revision_any
                score_key = "dense_score" if route_name == "semantic" else "lexical_score"
                total_key = "dense_total" if route_name == "semantic" else "lexical_total"
                if route_name == "semantic" and not all(
                    route["dense_available"] for route in route_details
                ):
                    mixed_revision_any = mixed_revision_any or any(
                        route["revision_mismatch"] for route in route_details
                    )
                    return None
                if any(
                    route[score_key] is None or route[total_key] is None for route in route_details
                ):
                    return None
                anchor_similarity = route_details[0][score_key]
                if anchor_similarity < anchor_minimum:
                    anchor_gate_any = True
                    if anchor_evidence["decision"] != "separate":
                        anchor_evidence["decision"] = "suggest"
                    anchor_evidence["reasons"].append(
                        f"{route_name.capitalize()} anchor similarity is below "
                        f"{anchor_minimum:.2f}; do not bridge through another member."
                    )
                    return None
                representatives = route_details
                candidate_score = sum(float(route[total_key]) for route in representatives) / len(
                    representatives
                )
                return {
                    "group_id": group_id,
                    "route": route_name,
                    "score": candidate_score,
                    "member_count": len(representatives),
                    "anchor_total": route_details[0][total_key],
                    "anchor_similarity": anchor_similarity,
                    "dense_available": all(route["dense_available"] for route in route_details),
                    "anchor_dense_available": route_details[0]["dense_available"],
                    "dense_anchor_score": route_details[0]["dense_score"],
                    "anchor_evidence": anchor_evidence,
                    "pair_evidence": pair_evidence,
                    "ambiguity_reasons": ambiguity_reasons,
                }

            lexical_candidate = candidate_for_route("lexical", _LEXICAL_ANCHOR_MINIMUM)
            if lexical_candidate is not None:
                lexical_candidates.append(lexical_candidate)

            semantic_review_candidate = candidate_for_route(
                "semantic", _SEMANTIC_REVIEW_ANCHOR_MINIMUM
            )
            if semantic_review_candidate is not None:
                semantic_review_candidates.append(semantic_review_candidate)
                if semantic_review_candidate["anchor_similarity"] >= _ANCHOR_SEMANTIC_MINIMUM:
                    semantic_candidates.append(semantic_review_candidate)

        if not incoming_id:
            return {
                "incident_id": None,
                "evidence": all_evidence,
                "review_reasons": with_potential_conflicts(
                    ["Incoming report has no stable ID; retain it as a singleton for review."]
                ),
            }
        if not groups or not all_evidence:
            return {
                "incident_id": None,
                "evidence": all_evidence,
                "review_reasons": with_potential_conflicts(
                    [
                        "No usable candidate incident is available; retain this report as "
                        "a singleton."
                    ]
                ),
            }
        if not lexical_candidates and not semantic_review_candidates:
            reasons: list[str] = []
            if rejected_any:
                reasons.append(
                    "A prior coordinator rejection prevents automatic re-creation of this grouping."
                )
            if missing_gate_any:
                reasons.append(
                    "Known event time and a specific shared sublocation or described entity "
                    "are required for attachment."
                )
            if anchor_gate_any:
                reasons.append(
                    "Anchor similarity is insufficient; a strong member match cannot create a "
                    "transitive bridge."
                )
            if hard_mismatch_any:
                reasons.append(
                    "A known location, time, category, or entity incompatibility keeps this "
                    "report separate."
                )
            if mixed_revision_any:
                reasons.append(
                    "Pinned MiniLM comparison is unavailable for at least one candidate because "
                    "its stored vector uses a different revision; lexical scores were "
                    "kept separate."
                )
            return {
                "incident_id": None,
                "evidence": all_evidence,
                "review_reasons": with_potential_conflicts(reasons),
            }

        def ranked(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
            return sorted(
                candidates, key=lambda candidate: (-candidate["score"], candidate["group_id"])
            )

        lexical_ranked = ranked(lexical_candidates)
        semantic_ranked = ranked(semantic_candidates)
        semantic_review_ranked = ranked(semantic_review_candidates)
        for index, candidate in enumerate(semantic_review_ranked):
            runner_up_score = (
                semantic_review_ranked[index + 1]["score"]
                if index + 1 < len(semantic_review_ranked)
                else None
            )
            candidate["review_runner_up_score"] = runner_up_score
            candidate["review_margin"] = (
                float("inf") if runner_up_score is None else candidate["score"] - runner_up_score
            )

        def route_winner(
            candidates: list[dict[str, Any]], threshold: float
        ) -> dict[str, Any] | None:
            if not candidates:
                return None
            best_candidate = candidates[0]
            runner_up = candidates[1]["score"] if len(candidates) > 1 else None
            margin = float("inf") if runner_up is None else best_candidate["score"] - runner_up
            best_candidate["margin"] = margin
            if best_candidate["score"] < threshold or margin < _RUNNER_UP_MARGIN:
                return None
            if (
                best_candidate["route"] == "lexical"
                and best_candidate["anchor_dense_available"]
                and best_candidate["dense_anchor_score"] < _ANCHOR_SEMANTIC_MINIMUM
            ):
                best_candidate["anchor_evidence"]["reasons"].append(
                    "Lexical candidate has pinned MiniLM anchor corroboration "
                    f"{best_candidate['dense_anchor_score']:.3f}, below the "
                    f"{_ANCHOR_SEMANTIC_MINIMUM:.2f} minimum; keep it for review."
                )
                return None
            if best_candidate["ambiguity_reasons"]:
                return None
            return best_candidate

        lexical_winner = route_winner(lexical_ranked, _LEXICAL_ATTACH_THRESHOLD)
        semantic_winner = route_winner(semantic_ranked, _ATTACH_THRESHOLD)
        semantic_suggestion = (
            semantic_review_ranked[0]
            if semantic_review_ranked
            and semantic_review_ranked[0]["score"] >= _SEMANTIC_REVIEW_THRESHOLD
            else None
        )
        semantic_alternatives = (
            [semantic_review_ranked[1]]
            if semantic_suggestion is not None
            and len(semantic_review_ranked) > 1
            and semantic_review_ranked[0]["review_margin"] < _RUNNER_UP_MARGIN
            else []
        )
        lexical_suggestion = (
            lexical_ranked[0]
            if lexical_ranked and lexical_ranked[0]["score"] >= _LEXICAL_SUGGEST_THRESHOLD
            else None
        )

        strict_winners = [
            winner for winner in (lexical_winner, semantic_winner) if winner is not None
        ]
        strict_ids = {winner["group_id"] for winner in strict_winners}
        primary_suggestions = [
            candidate
            for candidate in (lexical_suggestion, semantic_suggestion)
            if candidate is not None
        ]
        suggestions = [*primary_suggestions, *semantic_alternatives]
        primary_suggestion_ids = {candidate["group_id"] for candidate in primary_suggestions}
        dissenting_suggestions = [
            candidate
            for candidate in primary_suggestions
            if strict_ids and candidate["group_id"] not in strict_ids
        ]
        route_disagreement = len(strict_ids) > 1 or bool(dissenting_suggestions)

        def select_route(candidate: dict[str, Any], decision: str, reason: str) -> None:
            evidence = candidate["anchor_evidence"]
            route = candidate["route"]
            # The chosen route and its aggregate score are stated explicitly. The public
            # semantic_score remains the dense cosine whenever both vectors are compatible.
            evidence["total_score"] = _rounded(candidate["anchor_total"])
            for existing_reason in list(evidence["reasons"]):
                if existing_reason.startswith("Composite total_score uses "):
                    evidence["reasons"].remove(existing_reason)
            if route == "lexical":
                evidence["reasons"].append(
                    "This candidate uses the independent local lexical-hash route; dense results "
                    "are shown separately and were not mixed into its score."
                )
                evidence["reasons"].append(
                    "Composite total_score uses the local lexical-hash similarity plus "
                    "context components."
                )
            else:
                evidence["reasons"].append(
                    "This candidate uses the pinned MiniLM route; lexical-hash results were "
                    "scored independently and were not mixed into its score."
                )
                evidence["reasons"].append(
                    "Composite total_score uses pinned MiniLM similarity plus context components."
                )
            evidence["reasons"].append(reason)
            evidence["reasons"].append(
                f"Candidate group rank score {candidate['score']:.3f} is the mean of all "
                f"{candidate['member_count']} {route} pair composites and is used for "
                "threshold and margin checks; "
                "total_score remains the anchor pair composite."
            )
            corroborating_route = candidate.get("corroborating_route")
            if isinstance(corroborating_route, dict):
                evidence["reasons"].append(
                    "The independent "
                    f"{corroborating_route['name']} route also proposed this incident "
                    f"(anchor composite {corroborating_route['score']:.3f}); total_score "
                    f"reports the selected {route} route."
                )
            evidence["decision"] = decision

        if route_disagreement:
            for candidate in suggestions + strict_winners:
                select_route(
                    candidate,
                    "suggest",
                    "Lexical and MiniLM routes disagree on the leading incident; "
                    "coordinator review is required.",
                )
            return {
                "incident_id": None,
                "evidence": all_evidence,
                "review_reasons": with_potential_conflicts(
                    [
                        "Lexical and MiniLM routes do not establish one incident; keep this "
                        "report separate for human review."
                    ]
                ),
            }

        if strict_winners:
            chosen = strict_winners[0]
            select_route(
                chosen,
                "attach",
                "This candidate passed its versioned route score, margin, known-time, "
                "specific-context, "
                "all-member compatibility, and coordinator-rejection gates.",
            )
            for candidate in semantic_alternatives:
                select_route(
                    candidate,
                    "suggest",
                    "This close MiniLM runner-up remains visible for coordinator review; "
                    "it does not override the independently supported attachment.",
                )
            return {
                "incident_id": chosen["group_id"],
                "evidence": all_evidence,
                "review_reasons": with_potential_conflicts(
                    ["Provisional grouping only; coordinator confirmation remains required."]
                    + (
                        [
                            "MiniLM candidate margin is below 0.08; the close runner-up "
                            "remains visible for review."
                        ]
                        if semantic_alternatives
                        else []
                    )
                ),
            }

        review_candidates_by_group: dict[str, dict[str, Any]] = {}
        for candidate in suggestions:
            current = review_candidates_by_group.get(candidate["group_id"])
            if current is None:
                review_candidates_by_group[candidate["group_id"]] = candidate
                continue
            # Both score spaces may propose the same incident. Select one route
            # so shared anchor evidence is not overwritten by the second route.
            selected_candidate = candidate if candidate["route"] == "semantic" else current
            alternate_candidate = current if selected_candidate is candidate else candidate
            review_candidates_by_group[candidate["group_id"]] = {
                **selected_candidate,
                "corroborating_route": {
                    "name": alternate_candidate["route"],
                    "score": alternate_candidate["anchor_total"],
                },
            }
        review_candidates = list(review_candidates_by_group.values())
        for candidate in review_candidates:
            select_route(
                candidate,
                "suggest",
                "This route can propose a review candidate but cannot attach it without "
                "passing the independent attachment gates.",
            )
        review_reasons: list[str] = []
        if review_candidates:
            if len(primary_suggestion_ids) > 1:
                review_reasons.append(
                    "Lexical and MiniLM review suggestions point to different incidents; "
                    "coordinator review is required."
                )
            if any(
                candidate["route"] == "lexical"
                and candidate["anchor_dense_available"]
                and candidate["dense_anchor_score"] < _ANCHOR_SEMANTIC_MINIMUM
                for candidate in review_candidates
            ):
                review_reasons.append(
                    "Anchor similarity is insufficient; a strong member match cannot "
                    "create a transitive bridge."
                )
            if any(candidate["ambiguity_reasons"] for candidate in review_candidates):
                review_reasons.extend(
                    reason
                    for candidate in review_candidates
                    for reason in candidate["ambiguity_reasons"]
                )
            if semantic_alternatives:
                review_reasons.append(
                    "MiniLM candidate margin is below 0.08; the close runner-up is shown "
                    "for coordinator review."
                )
            if not semantic_alternatives and any(
                candidate["margin"] < _RUNNER_UP_MARGIN
                for candidate in review_candidates
                if "margin" in candidate
            ):
                review_reasons.append(
                    "The candidate margin is below 0.08; similar incidents remain "
                    "ambiguous for human review."
                )
        else:
            if lexical_ranked and lexical_ranked[0]["score"] < _LEXICAL_ATTACH_THRESHOLD:
                review_reasons.append(
                    "Best lexical candidate score is below "
                    f"{_LEXICAL_ATTACH_THRESHOLD:.2f}; retain this report as a "
                    "reviewable singleton."
                )
            if (
                semantic_review_ranked
                and semantic_review_ranked[0]["score"] < _SEMANTIC_REVIEW_THRESHOLD
            ):
                review_reasons.append(
                    "Best MiniLM candidate score is below "
                    f"{_SEMANTIC_REVIEW_THRESHOLD:.2f}; retain this report as a "
                    "reviewable singleton."
                )
            if mixed_revision_any:
                review_reasons.append(
                    "Pinned MiniLM comparison was unavailable for a mixed-revision "
                    "candidate; lexical scores were not compared with dense vectors."
                )
        return {
            "incident_id": None,
            "evidence": all_evidence,
            "review_reasons": with_potential_conflicts(review_reasons),
        }

    def assess_priority(self, reports: list[dict[str, Any]]) -> dict[str, Any]:
        """Apply the policy to every report and retain the strongest unresolved signal."""
        if not isinstance(reports, list):
            raise TypeError("reports must be a list")
        assessed: list[tuple[int, str, str, list[str]]] = []
        all_review_reasons: list[str] = []
        rank = {"UNASSESSED": 0, "P2": 1, "P1": 2, "P0": 3}
        for report in reports:
            if not isinstance(report, dict):
                all_review_reasons.append("A malformed report was omitted from policy assessment.")
                continue
            text = _report_text(report)
            claims = report.get("claims")
            if not isinstance(claims, list):
                claims, claim_review = _extract_claims(text)
                all_review_reasons.extend(claim_review)
            else:
                claims = [claim for claim in claims if isinstance(claim, dict)]
            category = _category(report.get("category")) or _classify_category(text, claims)
            priority, reason, reviews = _priority_for_text(
                text, category, claims, report.get("zone_id"), report.get("id")
            )
            assessed.append((rank[priority], priority, reason, reviews))
            report_reviews = report.get("review_reasons")
            if isinstance(report_reviews, list):
                all_review_reasons.extend(str(item) for item in report_reviews if item)
            all_review_reasons.extend(reviews)

        if not assessed:
            priority = "UNASSESSED"
            reason = "Rule U0: no assessable reports were supplied; human assessment required."
            all_review_reasons.append(
                "No assessable reports were supplied; human review is required."
            )
        else:
            _, priority, reason, _ = max(assessed, key=lambda item: item[0])
        for conflict in self.detect_conflicts(reports):
            all_review_reasons.append(
                f"Conflicting or changing {conflict['field']} claims require human review."
            )
        return {
            "priority": priority,
            "reason": reason,
            "review_reasons": _dedupe(all_review_reasons),
        }

    def detect_conflicts(self, reports: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Return opposing supported claims without deciding which account is correct."""
        if not isinstance(reports, list):
            raise TypeError("reports must be a list")
        claims_by_field: dict[str, list[tuple[str, str, str]]] = defaultdict(list)
        for report in reports:
            if not isinstance(report, dict):
                continue
            report_id = _report_id(report)
            claims = report.get("claims")
            if not isinstance(claims, list):
                claims, _ = _extract_claims(_report_text(report))
            for claim in claims:
                if not isinstance(claim, dict):
                    continue
                field = claim.get("field")
                value = claim.get("value")
                span = claim.get("span")
                if not all(isinstance(item, str) and item for item in (field, value, span)):
                    continue
                claims_by_field[field].append((report_id, value, span))

        conflicts: list[dict[str, Any]] = []
        seen: set[tuple[str, str, str, str, str]] = set()
        for field, claims in claims_by_field.items():
            for left_index, left in enumerate(claims):
                for right in claims[left_index + 1 :]:
                    if left[0] == right[0] or left[1] == right[1]:
                        continue
                    key = (field, left[0], right[0], left[1], right[1])
                    reverse_key = (field, right[0], left[0], right[1], left[1])
                    if key in seen or reverse_key in seen:
                        continue
                    seen.add(key)
                    conflicts.append(
                        {
                            "field": field,
                            "report_ids": [left[0], right[0]],
                            "values": [left[1], right[1]],
                            "spans": [left[2], right[2]],
                        }
                    )
        return conflicts


def _dedupe(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if isinstance(value, str) and value))


def _rounded(value: float | None) -> float | None:
    return round(value, 6) if value is not None else None
