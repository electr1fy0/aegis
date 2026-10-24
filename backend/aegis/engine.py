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
LEXICAL_CONFIG_VERSION = "lexical-context-dev-v2"
CONFIG_VERSION = f"semantic-context-v1+{LEXICAL_CONFIG_VERSION}+{LOCATION_VERSION}"

_SCORE_WEIGHTS = {
    "semantic": 0.65,
    "location": 0.20,
    "time": 0.10,
    "category": 0.05,
}
_ATTACH_THRESHOLD = 0.82
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
    r"\b(?:exit|door|egress|way\s+out|gate|opening|ramp)(?:\s+(?!(?:is|was|looks|appears|remains|not|isn['\u2019]t|aren['\u2019]t|wasn['\u2019]t|weren['\u2019]t)\b)[a-z0-9-]+){0,2}\s+"
    r"(?:(?:is|was|looks|appears|remains)\s+(?:(?:now|again|still)\s+)?)?"
    r"(?:blocked|obstructed|unusable|jammed|stuck|impassable|narrowed|"
    r"cannot\s+get\s+past|can['\u2019]t\s+get\s+past|cannot\s+get\s+through|"
    r"can['\u2019]t\s+get\s+through|will\s+not\s+open|won['\u2019]t\s+open|"
    r"cannot\s+open|can['\u2019]t\s+open|will\s+not\s+swing\s+open|"
    r"won['\u2019]t\s+swing\s+open|stuck\s+shut)\b|"
    r"\b(?:exit|door|egress|way\s+out|gate|opening|ramp)\b[^.!?;\n]{0,80}\b"
    r"(?:blocked|obstructed|unusable|jammed|stuck|impassable|narrowed|"
    r"will\s+not\s+open|won['\u2019]t\s+open|cannot\s+open|can['\u2019]t\s+open|"
    r"will\s+not\s+swing\s+open|won['\u2019]t\s+swing\s+open|stuck\s+shut)\b|"
    r"\b(?:jammed|stuck|blocked|obstructed|unusable|narrowed)\b"
    r"[^.!?;\n]{0,80}\b(?:exit|door|egress|gate|opening|ramp)\b|"
    r"\b(?:barrier|panel|cart|trolley|object)\b[^.!?;\n]{0,80}\b"
    r"(?:across|blocking|blocks?)\b[^.!?;\n]{0,50}\b(?:exit|door|gate|opening|ramp)\b|"
    r"\b(?:blocked|obstructed)\s+(?:exit|door|egress|way\s+out|gate|opening|ramp)\b|"
    r"\b(?:parked\s+across|blocks?|blocking|obstructing|obstructed|"
    r"narrows?|narrowed)\b[^.!?;\n]{0,80}\b(?:exit|ramp|door|passage|walkway|route)\b",
    re.IGNORECASE,
)
_EXIT_CLEAR_RE = re.compile(
    r"\b(?:exit|door|egress|way\s+out|gate|opening|passage|ramp)(?:\s+(?!(?:is|was|looks|appears|remains|not|isn['\u2019]t|aren['\u2019]t|wasn['\u2019]t|weren['\u2019]t)\b)[a-z0-9-]+){0,2}\s+"
    r"(?:(?:is|was|looks|appears|remains)\s+(?:(?:now|again|still)\s+)?)?"
    r"(?:clear|open|unblocked|unobstructed|accessible|passable|moving\s+freely)\b|"
    r"\b(?:clear|open|unblocked|unobstructed|passable|moving\s+freely)\s+"
    r"(?:exit|door|egress|way\s+out|gate|opening|passage|ramp)\b",
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
    r"(?:has|have)\s+not\s+returned|not\s+returned|didn['\u2019]t\s+return)\b",
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
    r"twisted\s+(?:an?\s+)?(?:ankle|wrist))\b",
    re.IGNORECASE,
)
_FACILITY_RE = re.compile(
    r"\b(?:broken|leak|leaking|spilled|spill|spreading|puddle|wet|slick|slippery|"
    r"liquid|water|faulty|outage|power\s+failure|lighting|light|elevator|lift|"
    r"air\s+conditioning|HVAC|water\s+leak|toilet|restroom|equipment|"
    r"facility|fixture|projector|monitor|screen|display|printer|label|"
    r"handrail|rail|mat|raised\s+edge|folded|curled|crowded|narrowed|"
    r"obstructing|obstructed|walkway|passage|wobbly|blank|no\s+(?:image|picture)|"
    r"lost\s+(?:its\s+)?(?:picture|signal|audio)|"
    r"will\s+not\s+open|won['\u2019]t\s+open|stuck\s+shut)\b",
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
    return bool(_PERSON_CONTEXT_RE.search(_nearby_clause(text, match.start())))


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
    for match in _FACILITY_RE.finditer(text):
        if not _is_negated(text, match) and not _is_hypothetical(text, match):
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
        has_location = bool(_normalise_text(zone_id))
        if has_location:
            match = _FACILITY_RE.search(text)
            phrase = match.group(0) if match else "reported facility issue"
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
    ) -> tuple[dict[str, Any], bool, bool]:
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
        semantic_mode = incoming_revision == MODEL_REVISION and existing_revision == MODEL_REVISION
        lexical_mode = not semantic_mode
        semantic_score: float | None = None
        if incoming_embedding is not None and existing_embedding is not None and semantic_mode:
            semantic_score = _cosine(incoming_embedding, existing_embedding)
        if semantic_score is None:
            lexical_mode = True
            semantic_score = _cosine(_lexical_vector(incoming_text), _lexical_vector(existing_text))
            if semantic_score is not None:
                reasons.append(
                    "Text similarity uses the local lexical-hash fallback, not MiniLM semantics."
                )
            else:
                missing_fields.append("semantic")
                reasons.append(
                    "Text similarity is unavailable because one report has no usable text."
                )

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

        components = {
            "semantic": semantic_score,
            "location": location_score,
            "time": time_score,
            "category": category_score,
        }
        total_score = _weighted_score(components)
        hard_incompatible = location_hard or time_hard or category_hard
        specifically_located = same_sublocation or bool(shared_entities)
        if not specifically_located:
            missing_fields.append("specific_location_or_entity")
        if len(components) > len([value for value in components.values() if value is not None]):
            reasons.append(
                "Missing score components were omitted and available weights were renormalized."
            )
        if hard_incompatible:
            decision = "separate"
        elif total_score >= (_LEXICAL_SUGGEST_THRESHOLD if lexical_mode else _SUGGEST_THRESHOLD):
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
        return evidence, hard_incompatible, specifically_located

    def score_pair(self, incoming: dict[str, Any], existing: dict[str, Any]) -> dict[str, Any]:
        """Return an inspectable pair score; it is a ranking signal, not a probability."""
        if not isinstance(incoming, dict) or not isinstance(existing, dict):
            raise TypeError("incoming and existing reports must be dictionaries")
        evidence, _, _ = self._pair_analysis(incoming, existing)
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
        ranked: list[dict[str, Any]] = []
        rejected_any = False
        missing_gate_any = False
        anchor_gate_any = False
        hard_mismatch_any = False

        for group in groups:
            if not isinstance(group, dict):
                continue
            group_id_value = group.get("id")
            group_id = str(group_id_value) if group_id_value is not None else ""
            reports = group.get("reports")
            if not group_id or not isinstance(reports, list) or not reports:
                continue

            pair_results = [
                self._pair_analysis(incoming, report)
                for report in reports
                if isinstance(report, dict)
            ]
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
            anchor_evidence, anchor_hard, anchor_specific = pair_results[0]
            anchor_similarity = anchor_evidence["semantic_score"]
            lexical_mode = any(
                "local lexical-hash fallback" in reason for reason in anchor_evidence["reasons"]
            )
            times_known = all(
                "time" not in evidence["missing_fields"] for evidence in pair_evidence
            )
            specific = anchor_specific
            required_context = not anchor_hard and times_known and specific and not hard_mismatch
            if not required_context:
                missing_gate_any = missing_gate_any or not times_known or not specific
                for evidence, hard, _ in pair_results:
                    if hard:
                        evidence["decision"] = "separate"
                    elif evidence["decision"] != "separate":
                        evidence["decision"] = "suggest"
                continue
            anchor_minimum = _LEXICAL_ANCHOR_MINIMUM if lexical_mode else _ANCHOR_SEMANTIC_MINIMUM
            if anchor_similarity is None or anchor_similarity < anchor_minimum:
                anchor_gate_any = True
                anchor_evidence["decision"] = "suggest"
                anchor_evidence["reasons"].append(
                    "Anchor similarity is below the prototype minimum of "
                    f"{anchor_minimum:.2f}; do not bridge through another member."
                )
                continue

            representatives = pair_results[:4]
            candidate_score = sum(
                float(result[0]["total_score"] or 0.0) for result in representatives
            ) / len(representatives)
            ranked.append(
                {
                    "group_id": group_id,
                    "score": candidate_score,
                    "anchor_evidence": anchor_evidence,
                    "pair_evidence": pair_evidence,
                    "lexical_mode": lexical_mode,
                }
            )

        if not incoming_id:
            return {
                "incident_id": None,
                "evidence": all_evidence,
                "review_reasons": [
                    "Incoming report has no stable ID; retain it as a singleton for review."
                ],
            }
        if not groups or not all_evidence:
            return {
                "incident_id": None,
                "evidence": all_evidence,
                "review_reasons": [
                    "No usable candidate incident is available; retain this report as a singleton."
                ],
            }
        if not ranked:
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
            return {
                "incident_id": None,
                "evidence": all_evidence,
                "review_reasons": _dedupe(reasons),
            }

        ranked.sort(key=lambda candidate: (-candidate["score"], candidate["group_id"]))
        best = ranked[0]
        runner_up_score = ranked[1]["score"] if len(ranked) > 1 else None
        margin = float("inf") if runner_up_score is None else best["score"] - runner_up_score
        attach_threshold = _LEXICAL_ATTACH_THRESHOLD if best["lexical_mode"] else _ATTACH_THRESHOLD
        if best["score"] < attach_threshold:
            best["anchor_evidence"]["decision"] = "suggest"
            best["anchor_evidence"]["reasons"].append(
                "Candidate score is below the prototype attachment threshold of "
                f"{attach_threshold:.2f}."
            )
            return {
                "incident_id": None,
                "evidence": all_evidence,
                "review_reasons": [
                    "Best candidate score is below "
                    f"{attach_threshold:.2f}; retain this report as a reviewable singleton."
                ],
            }
        if margin < _RUNNER_UP_MARGIN:
            best["anchor_evidence"]["decision"] = "suggest"
            best["anchor_evidence"]["reasons"].append(
                "Best-versus-runner-up margin is below the prototype minimum of 0.08."
            )
            return {
                "incident_id": None,
                "evidence": all_evidence,
                "review_reasons": [
                    "Candidate margin is below 0.08; similar incidents remain ambiguous for "
                    "human review."
                ],
            }

        best["anchor_evidence"]["decision"] = "attach"
        best["anchor_evidence"]["reasons"].append(
            "This anchor comparison passed the versioned "
            f"{'lexical-context' if best['lexical_mode'] else 'MiniLM'} score, margin, time, "
            "and specific-context gates."
        )
        return {
            "incident_id": best["group_id"],
            "evidence": all_evidence,
            "review_reasons": [
                "Provisional grouping only; coordinator confirmation remains required."
            ],
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
