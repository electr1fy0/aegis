"""Versioned, zone-scoped equivalents; source location wording is never rewritten."""

LOCATION_VERSION = "location-aliases-v1"
SUBLOCATION_ALIASES: dict[str, dict[str, str]] = {
    "hall": {
        "inner door": "inner doorway",
        "inside doorway": "inner doorway",
        "north entrance": "north door",
        "south entrance": "south door",
    },
    "food": {
        "service desk": "service counter",
        "serving counter": "service counter",
    },
    "exit-a": {"inner door": "inner doorway", "inside doorway": "inner doorway"},
    "exit-b": {"inner door": "inner doorway", "inside doorway": "inner doorway"},
}


def canonical_sublocation(value: str | None, zone_id: str | None) -> str | None:
    """Resolve only explicit aliases within the supplied zone."""
    if value is None:
        return None
    return SUBLOCATION_ALIASES.get(zone_id or "", {}).get(value, value)
