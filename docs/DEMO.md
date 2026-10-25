# Four-minute demonstration

After setup, run `make dev` to start both services. Use synthetic data throughout. Keep the engine status visible and describe the active method accurately.

| Time | Action | Explain |
| --- | --- | --- |
| 0:00–0:25 | Open Operations, expand Replay, choose Demo and start replay | Several reports may describe one event; a coordinator needs to review the evidence |
| 0:25–1:05 | Advance reports through a duplicate family | Grouping retains original text and shows supporting context |
| 1:05–1:35 | Select a group and inspect priority and matching evidence | Similarity is a ranking signal; priority comes from explicit exercise rules |
| 1:35–2:00 | Show the incomplete singleton and unlocated tray | Unknown information remains visible |
| 2:00–2:40 | Advance the blocked/clear Exit A reports | Later accounts may conflict or describe a change; no automatic closure |
| 2:40–3:20 | Confirm selected membership or split a selected report, supplying a reason | The coordinator can correct the state; each decision is audited |
| 3:20–4:00 | Open Evaluation | Show actual metrics, the review rate, known limitations and the active matching method |

Before the review, rehearse all 24 steps and one fresh submission through New report. Use a new exercise session for a clean run; earlier event history is retained. Avoid adding duplicate report text with a different idempotency key unless duplication is the point of that step.

Suggested pitch:

> Aegis combines contextual report matching, visible evidence and reversible human review. It helps a coordinator organise fragmented accounts while preserving uncertainty and conflicting information.

Normal development uses the measured lexical fallback. The separate pinned MiniLM environment has also executed real offline inference, but its current grouping policy performed worse on the synthetic fixture. Compare the saved results in `docs/IMPROVEMENTS.md`; describe the active `/api/health` mode accurately during the demo.

For a correction, select a report, open the relevant coordinator action, enter a specific reason, and save. If the incident changed while the form was open, review the new evidence before explicitly rebasing to the latest version. A stale edit should fail safely.

For a longer walkthrough, show a recovered intake draft, the receipt's incident link, a coordinator note, an audited priority reset and eligible undo. Switch exercises from the header to show retained history. Export an exercise brief from the compact Export menu.
