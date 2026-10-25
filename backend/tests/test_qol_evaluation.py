"""Ground-truth examples and workload calculations expose model mistakes honestly."""

from aegis.evaluation import _error_examples, _review_workload


def test_error_examples_explain_both_error_kinds_and_workload_counts_partition_operations():
    truth = {"a": "one", "b": "one", "c": "two", "d": "three"}
    predictions = {"a": "first", "b": "second", "c": "second", "d": "third"}
    reports = [
        {"id": key, "text": f"Original {key}", "matching_reasons": ["Specific context missing"]}
        for key in truth
    ]
    examples = _error_examples(reports, truth, predictions, "Aegis lexical")
    assert [example["kind"] for example in examples] == ["missed_pair", "false_merge"]
    assert examples[0]["texts"] == ["Original a", "Original b"]
    assert examples[0]["reasons"] == ["Report-level review context: Specific context missing"]
    assert examples[1]["expected_same_incident"] is False
    assert examples[1]["predicted_same_incident"] is True
    workload = _review_workload(truth, predictions, {"a", "c", "unknown"})
    assert workload["review_reports"] == 2
    assert workload["confirmation_groups"] == 3
    assert workload["split_operations"] == 1
    assert workload["merge_operations"] == 1
    assert "not measured clicks" in workload["basis"]


def test_examples_are_bounded_and_perfect_or_empty_results_need_no_corrections():
    reports = [{"id": str(index), "text": "Original"} for index in range(12)]
    truth = {report["id"]: "one" for report in reports}
    predictions = {report["id"]: report["id"] for report in reports}
    assert len(_error_examples(reports, truth, predictions, "Aegis")) == 40
    assert _error_examples(reports, truth, truth, "Aegis") == []
    assert _review_workload({}, {}, set())["split_operations"] == 0


def test_error_examples_prefer_the_historical_pair_evidence_over_other_candidate_context():
    reports = [
        {"id": "one", "text": "Original one", "review_reasons": ["Other candidate differs"]},
        {
            "id": "two",
            "text": "Original two",
            "matching_evidence": [
                {"candidate_report_id": "unrelated", "reasons": ["Unrelated reason"]},
                {"candidate_report_id": "one", "reasons": ["Anchor score below minimum"]},
            ],
        },
    ]
    examples = _error_examples(
        reports, {"one": "same", "two": "same"}, {"one": "first", "two": "second"}, "Aegis"
    )
    assert examples[0]["reasons"] == ["Anchor score below minimum"]
