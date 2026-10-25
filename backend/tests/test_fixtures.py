from __future__ import annotations

import json
import os
import runpy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.aegis import fixtures
from data import generate_fixtures

EXPECTED_ZONES = [
    {"id": "stage", "label": "Main Stage", "x": 230, "y": 180},
    {"id": "exit-a", "label": "Exit A", "x": 120, "y": 430},
    {"id": "exit-b", "label": "Exit B", "x": 820, "y": 430},
    {"id": "food", "label": "Food Court", "x": 720, "y": 180},
    {"id": "registration", "label": "Registration", "x": 470, "y": 430},
    {"id": "hall", "label": "Exhibition Hall", "x": 470, "y": 180},
]


def _valid_report(**overrides: object) -> dict[str, object]:
    report: dict[str, object] = {
        "text": "A synthetic report at the main stage.",
        "zone_id": "stage",
        "sublocation": "west aisle",
        "reported_at": "2026-10-25T06:30:00Z",
        "idempotency_key": "case-001",
        "source": "replay",
    }
    report.update(overrides)
    return report


class ScenarioFixtureTests(unittest.TestCase):
    def _write_payload(self, directory: Path, payload: object) -> None:
        (directory / "demo.json").write_text(json.dumps(payload), encoding="utf-8")

    def test_campus_map_regions_cover_every_selectable_location_once(self) -> None:
        path = Path(__file__).resolve().parents[2] / "data" / "campus-map.json"
        campus = json.loads(path.read_text(encoding="utf-8"))
        region_zone_ids = [zone_id for region in campus["regions"] for zone_id in region["zoneIds"]]
        self.assertEqual(len(region_zone_ids), len(set(region_zone_ids)))
        self.assertEqual(set(region_zone_ids), {zone["id"] for zone in fixtures.CAMPUS_ZONES})
        for region in campus["regions"]:
            self.assertGreaterEqual(len(region["points"]), 3)
            for x, y in region["points"]:
                self.assertTrue(0 <= x <= campus["width"])
                self.assertTrue(0 <= y <= campus["height"])

    def test_zones_and_scenario_counts_match_the_contract(self) -> None:
        by_id = {zone["id"]: zone for zone in fixtures.ZONES}
        self.assertTrue({zone["id"] for zone in EXPECTED_ZONES} <= by_id.keys())
        self.assertTrue({"a-block", "technology-tower", "vit-lake"} <= by_id.keys())
        self.assertEqual(len(by_id), len(fixtures.ZONES))
        self.assertFalse(by_id["hall"]["selectable"])
        for name, expected_count in (("demo", 24), ("busy", 60), ("edge", 16)):
            with self.subTest(name=name):
                reports = fixtures.get_scenario(name)
                self.assertEqual(len(reports), expected_count)
                self.assertEqual(
                    set(reports[0]),
                    {"text", "zone_id", "sublocation", "reported_at", "idempotency_key", "source"},
                )
                self.assertTrue(all(report["source"] == "replay" for report in reports))
                self.assertEqual(
                    len({report["idempotency_key"] for report in reports}), expected_count
                )
                self.assertTrue(all("incident_id" not in report for report in reports))
                self.assertTrue(all("ground_truth" not in report for report in reports))

    def test_scenario_results_are_fresh_nested_objects(self) -> None:
        first = fixtures.get_scenario("demo")
        original = first[0]["text"]
        first[0]["text"] = "changed"
        self.assertEqual(fixtures.get_scenario("demo")[0]["text"], original)

    def test_invalid_scenario_names_are_rejected(self) -> None:
        for name in ("", "DEV", "unknown", None, 12):
            with self.subTest(name=name), self.assertRaises(ValueError):
                fixtures.get_scenario(name)  # type: ignore[arg-type]

    def test_missing_invalid_json_and_invalid_encoding_are_wrapped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with patch.object(fixtures, "_SCENARIO_DIR", directory):
                with self.assertRaisesRegex(RuntimeError, "Unable to load"):
                    fixtures.get_scenario("demo")
                (directory / "demo.json").write_text("{", encoding="utf-8")
                with self.assertRaisesRegex(RuntimeError, "Unable to load"):
                    fixtures.get_scenario("demo")
                (directory / "demo.json").write_bytes(b"\xff")
                with self.assertRaisesRegex(RuntimeError, "Unable to load"):
                    fixtures.get_scenario("demo")

    def test_invalid_scenario_document_headers_and_report_collection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with patch.object(fixtures, "_SCENARIO_DIR", directory):
                for payload in ([], {"scenario": "edge", "reports": []}):
                    with self.subTest(payload=payload):
                        self._write_payload(directory, payload)
                        with self.assertRaisesRegex(RuntimeError, "invalid document header"):
                            fixtures.get_scenario("demo")
                self._write_payload(directory, {"scenario": "demo", "reports": {}})
                with self.assertRaisesRegex(RuntimeError, "report list"):
                    fixtures.get_scenario("demo")

    def test_invalid_report_shapes_and_field_values_are_rejected(self) -> None:
        invalid_reports = [
            ([], "invalid shape"),
            (
                {key: value for key, value in _valid_report().items() if key != "source"},
                "invalid shape",
            ),
            (_valid_report(text=1), "has no text"),
            (_valid_report(text="  "), "has no text"),
            (_valid_report(zone_id=["stage"]), "unknown zone"),
            (_valid_report(zone_id="unknown"), "unknown zone"),
            (_valid_report(sublocation=4), "invalid sublocation"),
            (_valid_report(reported_at=4), "invalid reported_at"),
            (_valid_report(reported_at="not a time"), "invalid reported_at"),
            (_valid_report(reported_at="2026-10-25T06:30:00"), "UTC offset"),
            (_valid_report(idempotency_key=4), "no idempotency key"),
            (_valid_report(idempotency_key="  "), "no idempotency key"),
            (_valid_report(source="form"), "not marked as replay"),
        ]
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with patch.object(fixtures, "_SCENARIO_DIR", directory):
                for report, message in invalid_reports:
                    with self.subTest(report=report):
                        self._write_payload(directory, {"scenario": "demo", "reports": [report]})
                        with self.assertRaisesRegex(RuntimeError, message):
                            fixtures.get_scenario("demo")

    def test_null_location_and_time_are_valid_and_duplicate_keys_are_not(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with patch.object(fixtures, "_SCENARIO_DIR", directory):
                nullable = _valid_report(zone_id=None, sublocation=None, reported_at=None)
                self._write_payload(directory, {"scenario": "demo", "reports": [nullable]})
                self.assertEqual(fixtures.get_scenario("demo"), [nullable])
                duplicate = _valid_report()
                second = _valid_report(text="A second report.")
                self._write_payload(directory, {"scenario": "demo", "reports": [duplicate, second]})
                with self.assertRaisesRegex(RuntimeError, "repeats an idempotency key"):
                    fixtures.get_scenario("demo")


class FixtureGeneratorTests(unittest.TestCase):
    def test_materialize_offsets_and_empty_input(self) -> None:
        base = generate_fixtures._case(
            "stage",
            "north aisle",
            "2026-10-25T06:30:00Z",
            "First synthetic paraphrase.",
            "Second synthetic paraphrase.",
            offsets=(12,),
        )
        rows, labels, groups = generate_fixtures._materialize([base], "unit")
        self.assertEqual(len(rows), 2)
        self.assertEqual(len(labels), 2)
        self.assertEqual(len(groups), 1)
        self.assertEqual(rows[0]["reported_at"], "2026-10-25T06:30:12Z")
        self.assertEqual(rows[1]["reported_at"], "2026-10-25T06:30:45Z")
        missing_time = generate_fixtures._case(None, None, None, "An incomplete synthetic report.")
        no_time_rows, _, _ = generate_fixtures._materialize([missing_time], "unit")
        self.assertIsNone(no_time_rows[0]["reported_at"])
        empty_rows, empty_labels, empty_groups = generate_fixtures._materialize([], "unit")
        self.assertEqual((empty_rows, empty_labels, empty_groups), ([], {}, []))

    def test_generator_writes_exact_split_sizes_and_separate_labels(self) -> None:
        with (
            tempfile.TemporaryDirectory() as temporary,
            patch.object(generate_fixtures, "ROOT", Path(temporary)),
        ):
            generate_fixtures.generate()
            demo = json.loads((Path(temporary) / "scenarios" / "demo.json").read_text())
            demo_labels = json.loads(
                (Path(temporary) / "scenarios" / "demo_labels.json").read_text()
            )
            busy = json.loads((Path(temporary) / "scenarios" / "busy.json").read_text())
            edge = json.loads((Path(temporary) / "scenarios" / "edge.json").read_text())
            dev_inputs = json.loads(
                (Path(temporary) / "evaluation" / "dev_inputs.json").read_text()
            )
            dev_labels = json.loads(
                (Path(temporary) / "evaluation" / "dev_labels.json").read_text()
            )
            test_inputs = json.loads(
                (Path(temporary) / "evaluation" / "test_inputs.json").read_text()
            )
            test_labels = json.loads(
                (Path(temporary) / "evaluation" / "test_labels.json").read_text()
            )
        self.assertEqual(
            (len(demo["reports"]), len(busy["reports"]), len(edge["reports"])), (24, 60, 16)
        )
        self.assertEqual((len(demo_labels["report_groups"]), len(demo_labels["groups"])), (24, 8))
        self.assertEqual((len(dev_inputs["reports"]), len(dev_labels["groups"])), (60, 20))
        self.assertEqual((len(test_inputs["reports"]), len(test_labels["groups"])), (60, 20))
        self.assertNotIn("report_groups", dev_inputs)
        self.assertNotIn("report_groups", test_inputs)
        self.assertNotIn("incident_family", busy["reports"][0])

    def test_command_line_entry_point_generates_into_configured_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with patch.dict(os.environ, {"AEGIS_FIXTURE_OUTPUT_DIR": temporary}):
                namespace = runpy.run_path(
                    str(Path(generate_fixtures.__file__).resolve()),
                    run_name="__main__",
                )
            self.assertEqual(namespace["ROOT"], Path(temporary))
            self.assertTrue((Path(temporary) / "scenarios" / "demo.json").is_file())
            self.assertTrue((Path(temporary) / "evaluation" / "test_labels.json").is_file())


if __name__ == "__main__":
    unittest.main()
