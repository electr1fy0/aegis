# Four-minute demonstration

Prepare the model once with `make semantic-setup`, then run `make dev-semantic` to verify offline inference and start both services. Use synthetic data throughout. Keep the engine status visible and describe the active method accurately.

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

Ordinary `make dev` can use the labelled lexical fallback; use `make dev-semantic` for the AI demonstration. The hybrid improves semantic regression recall from 3.0% to 19.7%, while retaining more singletons than lexical matching. On the context-matched development challenge it avoids all 18 explicitly distinct attachments, versus 15 false attachments with current lexical settings. Four underdetermined cases still receive provisional membership and suggestions remain noisy. Describe both the benefit and the tradeoff; see `docs/MATCHING.md`.

For a short, repeatable semantic demonstration, submit these three reports to one available zone, using the same specific spot (`west display row`) and a known event time within one minute:

1. “The projector at the west display row has lost its picture; the screen is blank.”
2. “There is no image on the west-row projection screen, although the presentation is running.”
3. “The sound monitor by the west displays has lost audio, although its picture remains.”

The real-model API rehearsal grouped the first two and kept the third separate. Open the evidence to compare the independently scored signals. Use a fresh exercise so unrelated candidates do not change the runner-up margin. For blocked/clear accounts that remain in separate groups, inspect the source-cited potential-conflict warning, then merge explicitly with a reason to show the retained conflict. The 24-step semantic replay retained all reports but produced 19 groups and no automatic within-group conflict objects; do not present it as a perfect replay.

For a correction, select a report, open the relevant coordinator action, enter a specific reason, and save. If the incident changed while the form was open, review the new evidence before explicitly rebasing to the latest version. A stale edit should fail safely.

For a longer walkthrough, show a recovered intake draft, the receipt's incident link, a coordinator note, an audited priority reset and eligible undo. Switch exercises from the header to show retained history. Export an exercise brief from the compact Export menu.
