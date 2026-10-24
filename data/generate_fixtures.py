"""Regenerate Aegis' synthetic replay and evaluation JSON fixtures.

The generated runtime inputs and the evaluation labels are written to different
files. Runtime replay files never contain incident-family labels.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

ROOT = Path(os.environ.get("AEGIS_FIXTURE_OUTPUT_DIR", Path(__file__).resolve().parent))
DATASET_VERSION = "aegis-synthetic-2026-10-v1"


def _case(
    zone: str | None,
    place: str | None,
    at: str | None,
    *texts: str,
    offsets: tuple[int, ...] | None = None,
) -> dict[str, Any]:
    return {
        "zone_id": zone,
        "sublocation": place,
        "reported_at": at,
        "texts": list(texts),
        "offsets": offsets,
    }


# Dev and test have separately authored wording in the same broad campus
# incident taxonomy; they are a synthetic regression split, not a topic-diverse
# external benchmark. The live demo has eight separately labeled groups.
DEMO_CASES = [
    _case(
        "stage",
        "west lighting desk",
        "2026-10-25T06:30:00Z",
        "A guest collapsed beside the west lighting desk and is not responding to people "
        "speaking to them.",
    ),
    _case(
        None,
        None,
        None,
        "Someone near a door might need help, but I cannot say what happened or which door it was.",
    ),
    _case(
        "hall",
        "north poster aisle",
        "2026-10-25T06:34:00Z",
        "A visitor twisted an ankle by the north poster aisle and is sitting down.",
        "There is an attendee with an injured ankle in the poster hall, seated and alert.",
        "At the north display row, one person says their ankle hurts after a misstep.",
        "The person resting beside the posters says they can walk, but their ankle is sore.",
    ),
    _case(
        "exit-a",
        "inner door",
        "2026-10-25T06:38:00Z",
        "People are bunching up because the inner door at Exit A will not open.",
        "The inside Exit A door seems jammed; the queue has stopped moving through it.",
        "I can see the Exit A inner doorway blocked by a fallen sign stand.",
        "The same Exit A doorway is clear now and people are passing through.",
    ),
    _case(
        "hall",
        "east information table",
        "2026-10-25T06:41:00Z",
        "A young child is separated from their family at the east information table.",
        "A parent at the east help desk cannot find their small child.",
        "Staff are looking for a child last seen beside the hall's eastern information point.",
        "The family reports their child is still missing near the east-side help table.",
    ),
    _case(
        "registration",
        "water station",
        "2026-10-25T06:44:00Z",
        "Water is spreading across the floor under the registration water station.",
        "There is a leak at the drinking-water point by registration, making the tiles wet.",
        "A puddle is growing beneath the water dispenser near the check-in desks.",
        "The registration fountain is still leaking onto the walkway.",
    ),
    _case(
        "stage",
        "projection booth",
        "2026-10-25T06:46:00Z",
        "The projector in the booth has gone dark, so the stage screen is blank.",
        "No picture is reaching the main screen from the projection booth.",
        "The stage display stopped showing slides; the booth projector appears off.",
    ),
    _case(
        "exit-b",
        "outer ramp",
        "2026-10-25T06:48:00Z",
        "A delivery cart is parked across the outer ramp at Exit B.",
        "People using Exit B cannot get past a trolley left on the ramp.",
        "The outer Exit B access route is obstructed by a loaded cart.",
    ),
]


DEV_CASES = [
    # A P0 singleton is deliberately near a large collection of ordinary cases.
    _case(
        "stage",
        "rear cable bridge",
        "2026-10-25T08:00:00Z",
        "A speaker fell behind the rear cable bridge and does not respond when called; "
        "breathing is unclear.",
    ),
    _case(
        None,
        None,
        None,
        "A guest may have a problem somewhere, but the reporter does not know what it is or where.",
    ),
    _case(
        "hall",
        "north poster row",
        "2026-10-25T08:04:00Z",
        "A person stumbled by the northern posters and says their wrist hurts.",
        "Someone with a painful wrist is seated beside the north poster display.",
        "An attendee reports a wrist injury after tripping near the northern display wall.",
    ),
    _case(
        "exit-a",
        "inner door",
        "2026-10-25T08:08:00Z",
        "The inner Exit A door is stuck shut and the line has stopped.",
        "A crowd cannot pass through the jammed inside door at Exit A.",
        "A display frame is lying across the Exit A inner doorway.",
        "The Exit A inner doorway is open again; people are walking through now.",
    ),
    _case(
        "hall",
        "east welcome desk",
        "2026-10-25T08:11:00Z",
        "A child wearing a yellow raincoat is separated from their family by the east welcome "
        "desk.",
        "The family is looking for a small child last seen at the eastern help counter.",
        "A young visitor in a yellow coat cannot find their parent near the east information "
        "point.",
        "Staff are still trying to reunite a family with their missing child at the welcome desk.",
    ),
    _case(
        "food",
        "coffee counter",
        "2026-10-25T08:14:00Z",
        "Coffee has spilled across the floor directly in front of the north coffee counter.",
        "The tiles by the coffee stand are slick from a large drink spill.",
        "A cup burst near the counter and liquid is spreading into the aisle.",
        "The wet patch in front of the coffee counter is still there.",
    ),
    _case(
        "stage",
        "control booth",
        "2026-10-25T08:17:00Z",
        "The left stage monitor has lost its picture; the control booth reports a blank feed.",
        "No image is coming from the booth to the stage's left display.",
        "The screen on stage left went black while the speaker was presenting.",
        "The control room says the left-hand stage display is still without a signal.",
    ),
    _case(
        "exit-b",
        "outer ramp",
        "2026-10-25T08:20:00Z",
        "A stack of folded chairs blocks half of the outer Exit B ramp.",
        "The ramp at Exit B is narrowed by chairs waiting to be moved.",
        "A group cannot roll a wheelchair past the chair stack on the outside ramp.",
    ),
    _case(
        "food",
        "south seating",
        "2026-10-25T08:23:00Z",
        "A blue backpack has been left under the south seating row with nobody nearby.",
        "There is an unattended blue rucksack beneath the southern café seats.",
        "I noticed a blue bag under the food court benches and cannot find its owner.",
    ),
    _case(
        "stage",
        "front sound desk",
        "2026-10-25T08:26:00Z",
        "The front sound desk has lost microphone audio, although the projection still works.",
        "The stage microphone is silent at the front mixing position.",
        "The sound operator says the handheld mic is not reaching the speakers.",
    ),
    _case(
        "registration",
        "east queue",
        "2026-10-25T08:29:00Z",
        "The registration line is crossing the walkway at its east end.",
        "People waiting to check in have spilled into the eastern passage.",
        "The east side of the registration queue is obstructing through traffic.",
    ),
    _case(
        "hall",
        "north side exit",
        "2026-10-25T08:32:00Z",
        "No smoke is visible by the north hall exit; someone only smelled toasted food.",
        "A guest asks about a smoky smell, but says there is no smoke at the north door.",
        "The north exit smells like warm bread and reporters see no haze.",
    ),
    _case(
        "food",
        "allergen desk",
        "2026-10-25T08:35:00Z",
        "A visitor asks whether the allergen list is available beside the food counters.",
        "The ingredient information is missing from the small desk by the serving area.",
        "Someone cannot find the allergen notices at the food information point.",
    ),
    _case(
        "registration",
        "west badge printer",
        "2026-10-25T08:38:00Z",
        "The badge printer at the west check-in table keeps feeding blank labels.",
        "No names are appearing on badges from the western registration printer.",
        "The west-side label machine is printing empty name tags.",
    ),
    _case(
        "exit-a",
        "outer steps",
        "2026-10-25T08:41:00Z",
        "A handrail cap is loose on the outside steps beside Exit A.",
        "The outer Exit A stair rail moves at its top fitting.",
        "There is a wobbly handrail at the steps just outside Exit A.",
    ),
    _case(
        "hall",
        "south aisle",
        "2026-10-25T08:44:00Z",
        "A visitor in a green scarf is waiting in the south aisle for their group.",
        "Someone wearing a green scarf says their companions have not returned to the southern "
        "aisle.",
        "A guest is separated from friends near the hall's south display row.",
    ),
    _case(
        "food",
        "east drinks station",
        "2026-10-25T08:47:00Z",
        "The tap at the east drinks station will not shut off completely.",
        "Water is dripping continuously from the eastern refill tap.",
        "A faulty faucet is leaking at the drinks refill point on the east side.",
    ),
    _case(
        "stage",
        "rear aisle",
        "2026-10-25T08:50:00Z",
        "A visitor says they may have left a phone in the rear stage aisle.",
        "A lost phone is being searched for along the back aisle near the stage.",
        "Someone cannot find their mobile after sitting in the rear aisle.",
    ),
    _case(
        "registration",
        "main entrance mat",
        "2026-10-25T08:53:00Z",
        "The entrance mat at registration has curled up at its left corner.",
        "A raised edge on the check-in entrance mat could catch a shoe.",
        "The corner of the welcome mat is folded back near registration.",
    ),
    _case(
        "exit-b",
        "inside landing",
        "2026-10-25T08:56:00Z",
        "The inside landing near Exit B is crowded by guests waiting for a tour.",
        "Tour visitors have gathered on the indoor Exit B landing and narrowed the passage.",
        "People waiting for the next tour are standing across the inner Exit B landing.",
    ),
]


TEST_CASES = [
    _case(
        "stage",
        "green room threshold",
        "2026-10-26T09:00:00Z",
        "A performer dropped at the green room threshold and is unresponsive to their name; "
        "breathing is uncertain.",
    ),
    _case(
        None,
        None,
        None,
        "A person could be in trouble somewhere in the venue; no further details were provided.",
    ),
    _case(
        "hall",
        "west model table",
        "2026-10-26T09:04:00Z",
        "A guest caught a toe by the west model table and now has a sore knee.",
        "Someone is resting near the western displays after hurting a knee.",
        "A visitor says their knee hurts after a trip beside the model exhibit.",
    ),
    _case(
        "exit-a",
        "lower gate",
        "2026-10-26T09:08:00Z",
        "The lower gate at Exit A will not swing open, and people are waiting.",
        "Visitors are held up at a jammed bottom Exit A gate.",
        "A barrier panel has fallen across the lower Exit A opening.",
        "The bottom gate at Exit A is moving freely again and passage is open.",
    ),
    _case(
        "hall",
        "south host stand",
        "2026-10-26T09:11:00Z",
        "A senior visitor using a cane is separated from their companion at the south host stand.",
        "Staff at the southern welcome point are looking for an older guest's companion.",
        "A person with a walking stick cannot find the friend who was with them by the host desk.",
        "The companion has not been located yet near the south-side host station.",
    ),
    _case(
        "food",
        "bakery island",
        "2026-10-26T09:14:00Z",
        "A tray of water has spilled onto the aisle at the bakery island.",
        "The floor beside the pastry counter is wet from a fallen drink tray.",
        "There is liquid across the walkway next to the bakery display.",
        "The puddle by the bakery island remains on the aisle floor.",
    ),
    _case(
        "stage",
        "lighting console",
        "2026-10-26T09:17:00Z",
        "The stage wash lights stopped responding at the lighting console.",
        "No front lights are coming on from the stage lighting controls.",
        "The operator cannot bring up the stage lights from the console.",
        "The lighting desk is not controlling the wash lamps over the platform.",
    ),
    _case(
        "exit-b",
        "north approach",
        "2026-10-26T09:20:00Z",
        "A stack of exhibition panels sits across the north approach to Exit B.",
        "Guests at the northern path cannot pass the panel stack near Exit B.",
        "The way to Exit B from the north is narrowed by display boards.",
    ),
    _case(
        "food",
        "window seats",
        "2026-10-26T09:23:00Z",
        "A red tote is still sitting under the window seats with no one claiming it.",
        "There is an unattended red carry bag beneath the café's window row.",
        "A red shopping bag has been left under the food court windows.",
    ),
    _case(
        "stage",
        "stage right monitor",
        "2026-10-26T09:26:00Z",
        "Stage right's confidence monitor has stopped showing the speaker notes.",
        "The small display beside the stage-right microphone is blank.",
        "A monitor at the right side of the platform has lost its feed.",
    ),
    _case(
        "registration",
        "ticket scan lane",
        "2026-10-26T09:29:00Z",
        "The ticket scanning line has expanded across the west-side walkway.",
        "Check-in visitors are queueing into the western corridor.",
        "The west passage is partially blocked by the entry scan queue.",
    ),
    _case(
        "hall",
        "east fire door",
        "2026-10-26T09:32:00Z",
        "No flames or smoke are present by the east fire door; the smell came from a hot "
        "display lamp.",
        "A report about burning odor was checked at the east door and nobody found smoke.",
        "The east hall exit is clear; the warm smell is from equipment, not a fire.",
    ),
    _case(
        "food",
        "menu stand",
        "2026-10-26T09:35:00Z",
        "The menu board at the serving area does not list which dishes contain nuts.",
        "A diner cannot see the nut information on the food counter menu.",
        "The allergen details for the lunch menu are absent from the display.",
    ),
    _case(
        "registration",
        "north label desk",
        "2026-10-26T09:38:00Z",
        "The name tag machine at the north label desk is jammed.",
        "Badges are stuck inside the northern check-in label printer.",
        "The north registration printer will not feed a name badge.",
    ),
    _case(
        "exit-a",
        "west approach",
        "2026-10-26T09:41:00Z",
        "A paving tile is rocking on the west approach just outside Exit A.",
        "One loose paver shifts underfoot on the outer path by Exit A.",
        "The walkway west of Exit A has a raised, moving stone tile.",
    ),
    _case(
        "hall",
        "central bench",
        "2026-10-26T09:44:00Z",
        "A teenager in a purple jacket is waiting alone by the central hall bench.",
        "Someone wearing a purple coat says their group left without them near the middle bench.",
        "A young visitor is separated from their group at the central seating.",
    ),
    _case(
        "food",
        "west bottle filler",
        "2026-10-26T09:47:00Z",
        "The west bottle-filling nozzle continues to drip after use.",
        "A slow leak is coming from the refill fountain on the west side.",
        "Water keeps seeping from the west-side bottle station tap.",
    ),
    _case(
        "stage",
        "under rear seats",
        "2026-10-26T09:50:00Z",
        "A guest is searching for an earbud case they may have dropped under the rear seats.",
        "A small headphone case is missing from the back seating row.",
        "Someone lost their earbuds near the last row behind the stage.",
    ),
    _case(
        "registration",
        "south threshold",
        "2026-10-26T09:53:00Z",
        "The rubber threshold strip at the south entrance has lifted at one end.",
        "A loose floor strip is sticking up by the southern check-in entrance.",
        "The entry edging at registration's south doorway has peeled back.",
    ),
    _case(
        "exit-b",
        "upper landing",
        "2026-10-26T09:56:00Z",
        "A tour group has stopped on the upper landing inside Exit B.",
        "The interior top landing at Exit B is crowded by a waiting tour.",
        "People waiting for the gallery tour are gathered across Exit B's upper landing.",
    ),
]


def _materialize(
    cases: list[dict[str, Any]], prefix: str
) -> tuple[list[dict[str, Any]], dict[str, str], list[dict[str, str]]]:
    rows_by_group: list[list[dict[str, Any]]] = []
    group_ids: list[str] = []
    for group_index, case in enumerate(cases, start=1):
        group_id = f"{prefix}-G{group_index:02d}"
        group_ids.append(group_id)
        group_rows: list[dict[str, Any]] = []
        base_time = (
            datetime.fromisoformat(case["reported_at"].replace("Z", "+00:00"))
            if case["reported_at"]
            else None
        )
        offsets = case.get("offsets")
        for item_index, text in enumerate(case["texts"]):
            reported_at = None
            if base_time is not None:
                seconds = (
                    offsets[item_index]
                    if offsets and item_index < len(offsets)
                    else item_index * 45
                )
                reported_at = (
                    (base_time + timedelta(seconds=seconds))
                    .astimezone(UTC)
                    .isoformat()
                    .replace("+00:00", "Z")
                )
            group_rows.append(
                {
                    "text": text,
                    "zone_id": case["zone_id"],
                    "sublocation": case["sublocation"],
                    "reported_at": reported_at,
                }
            )
        rows_by_group.append(group_rows)

    # Interleave report families so each matching pass sees hard negatives
    # from the same broad zone/category before the next paraphrase arrives.
    rows: list[dict[str, Any]] = []
    labels: dict[str, str] = {}
    row_number = 0
    max_size = max((len(group) for group in rows_by_group), default=0)
    for item_index in range(max_size):
        for group_index, group in enumerate(rows_by_group):
            if item_index >= len(group):
                continue
            row_number += 1
            report_id = f"{prefix.lower()}-{row_number:03d}"
            rows.append({"id": report_id, **group[item_index]})
            labels[report_id] = group_ids[group_index]
    return (
        rows,
        labels,
        [
            {
                "id": group_id,
                "report_ids": [
                    report_id for report_id, label in labels.items() if label == group_id
                ],
            }
            for group_id in group_ids
        ],
    )


def _scenario_rows(rows: list[dict[str, Any]], prefix: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for index, row in enumerate(rows, start=1):
        result.append(
            {key: row[key] for key in ("text", "zone_id", "sublocation", "reported_at")}
            | {"idempotency_key": f"{prefix}-{index:03d}", "source": "replay"}
        )
    return result


def _edge_scenario() -> list[dict[str, Any]]:
    base = datetime(2026, 10, 25, 10, 0, tzinfo=UTC)
    items = [
        ("No smoke is visible at the hall door; the smell is from toast.", "hall", "north door", 0),
        (
            "If a fire started here, we would evacuate; this is only a drill briefing.",
            "hall",
            "north door",
            15,
        ),
        (
            "A possible medical issue was mentioned, but nobody can tell what happened.",
            None,
            None,
            None,
        ),
        (
            "A person collapsed and is not responding beside the stage console.",
            "stage",
            "console",
            30,
        ),
        (
            "The report form says Exit B, but the text says the problem is at Exit A.",
            "exit-b",
            "outer gate",
            45,
        ),
        ("Exit A is blocked by a fallen sign frame.", "exit-a", "inner door", 60),
        (
            "The inner Exit A doorway is clear and people are passing through.",
            "exit-a",
            "inner door",
            90,
        ),
        (
            "I cannot tell whether the door is blocked from where I am standing.",
            "exit-a",
            "inner door",
            120,
        ),
        (
            "A guest is missing near the food area; last seen by the west counter.",
            "food",
            "west counter",
            150,
        ),
        (
            "The missing guest has been found and is with their family at the west counter.",
            "food",
            "west counter",
            240,
        ),
        (
            "A cup spilled on the floor at the stage-side refreshment table.",
            "stage",
            "refreshment table",
            300,
        ),
        (
            "Water is on the floor by the drinks table, creating a slip concern.",
            "stage",
            "refreshment table",
            330,
        ),
        (
            "Someone reports a loud bang, but cannot identify its source or location.",
            None,
            None,
            None,
        ),
        (
            "A visitor appears dizzy but says they are alert and speaking normally.",
            "registration",
            "check-in desk",
            360,
        ),
        (
            "No one is unconscious at registration; one person is resting after a long walk.",
            "registration",
            "check-in desk",
            375,
        ),
        (
            "A child was last seen by the west poster table and has not returned to family.",
            "hall",
            "west poster table",
            420,
        ),
    ]
    output: list[dict[str, Any]] = []
    for index, (text, zone, place, seconds) in enumerate(items, start=1):
        at = (
            (base + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")
            if seconds is not None
            else None
        )
        output.append(
            {
                "text": text,
                "zone_id": zone,
                "sublocation": place,
                "reported_at": at,
                "idempotency_key": f"edge-{index:03d}",
                "source": "replay",
            }
        )
    return output


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def generate() -> None:
    demo_rows, demo_labels, demo_groups = _materialize(DEMO_CASES, "demo")
    dev_rows, dev_labels, dev_groups = _materialize(DEV_CASES, "dev")
    test_rows, test_labels, test_groups = _materialize(TEST_CASES, "test")

    _write_json(
        ROOT / "scenarios" / "demo.json",
        {
            "scenario": "demo",
            "version": DATASET_VERSION,
            "reports": _scenario_rows(demo_rows, "demo"),
        },
    )
    _write_json(
        ROOT / "scenarios" / "demo_labels.json",
        {
            "dataset_version": DATASET_VERSION,
            "scenario": "demo",
            "report_groups": demo_labels,
            "groups": demo_groups,
        },
    )
    _write_json(
        ROOT / "scenarios" / "busy.json",
        {
            "scenario": "busy",
            "version": DATASET_VERSION,
            "reports": _scenario_rows(dev_rows, "busy"),
        },
    )
    _write_json(
        ROOT / "scenarios" / "edge.json",
        {
            "scenario": "edge",
            "version": DATASET_VERSION,
            "reports": _edge_scenario(),
        },
    )

    _write_json(
        ROOT / "evaluation" / "dev_inputs.json",
        {
            "dataset_version": DATASET_VERSION,
            "split": "dev",
            "reports": dev_rows,
        },
    )
    _write_json(
        ROOT / "evaluation" / "dev_labels.json",
        {
            "dataset_version": DATASET_VERSION,
            "split": "dev",
            "report_groups": dev_labels,
            "groups": dev_groups,
            "policy_cases": {
                dev_groups[0]["id"]: "P0",
                dev_groups[1]["id"]: "UNASSESSED",
                dev_groups[11]["id"]: "NOT_P0",
                dev_groups[12]["id"]: "NOT_P0",
            },
            "conflict_groups": [dev_groups[3]["id"]],
            "review_groups": [dev_groups[1]["id"]],
        },
    )
    _write_json(
        ROOT / "evaluation" / "test_inputs.json",
        {
            "dataset_version": DATASET_VERSION,
            "split": "test",
            "reports": test_rows,
        },
    )
    _write_json(
        ROOT / "evaluation" / "test_labels.json",
        {
            "dataset_version": DATASET_VERSION,
            "split": "test",
            "report_groups": test_labels,
            "groups": test_groups,
            "policy_cases": {
                test_groups[0]["id"]: "P0",
                test_groups[1]["id"]: "UNASSESSED",
                test_groups[11]["id"]: "NOT_P0",
            },
            "conflict_groups": [test_groups[3]["id"]],
            "review_groups": [test_groups[1]["id"]],
        },
    )


if __name__ == "__main__":
    generate()
