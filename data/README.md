# Synthetic fixtures

All report text, event times, and incident-family labels here are fabricated
for a campus event coordination prototype. The six zone coordinates are
illustrative points on a schematic, not a real campus map. No personal or
operational records are included.

Regenerate the JSON files by running python3 data/generate_fixtures.py from
the repository root. The generator uses only the Python standard library.
Its output keeps replay inputs and ground-truth labels in separate files.
backend/aegis/fixtures.py loads only the input files.

## Scenario and split files

- scenarios/demo.json: 24 replay reports for the live demonstration.
- scenarios/demo_labels.json: separate expected family labels for those 24
  reports across 8 synthetic incidents. Its report keys match the replay
  idempotency keys and are not returned by get_scenario.
- scenarios/busy.json: 60 input-only replay reports.
- scenarios/edge.json: 16 input-only reports covering missing context,
  negation, hypothetical wording, a form/text location mismatch, and changing
  exit and missing-person accounts.
- evaluation/dev_inputs.json and evaluation/dev_labels.json: 60 reports
  across 20 families for development.
- evaluation/test_inputs.json and evaluation/test_labels.json: 60 reports
  across 20 families for the fixed regression evaluation.

The test wording and labels are frozen separately from development inputs.
Both splits use the same broad campus incident taxonomy and recurring
coordination patterns, so they are not disjoint topic families or an external
benchmark. Test cases were inspected while engineering the prototype; report
their measurements as synthetic regression results, not evidence of accuracy
on real events or unseen operational data.

The held-out labels include an explicit severe singleton, an incomplete
singleton, a changing exit account, and negative controls for priority rules.
The evaluation reports policy and conflict checks independently from grouping
metrics. A failed check remains a failure; do not edit its held-out text to
make a prototype check pass.

Pairwise grouping metrics count each same-incident report pair. false_merges
counts predicted pairs that have different labels; missed_pairs counts
same-label pairs left in different predicted groups. The baseline is token-set
Jaccard similarity with simple zone and 20-minute time gates, not TF-IDF.
Semantic results are emitted only if the active engine reports semantic mode
and supplies valid embeddings for every report.
