# Matching, evidence and measurement

Aegis implements Topic 10's AI-assisted grouping workflow: reports that appear
to describe one incident can be provisionally grouped, every comparison has
inspectable evidence, and a coordinator can correct the result. Priority stays
under the team's explicit policy. No model dispatches responders or discards a
report.

## Local inference and independent signals

The pinned MiniLM sentence encoder runs locally. Once the separately
locked semantic environment and model cache are prepared, normal inference
requires no network connection or paid API. Use `make dev-semantic` to verify
real offline inference and start both services. Its preflight stops startup if
the pinned model falls back to lexical analysis. `make dev` remains available
for ordinary development with an explicitly labelled fallback.

Lexical overlap and MiniLM similarity provide different evidence. The hybrid
engine evaluates them independently, preserving their own scores and gates.
Dense vectors are compared only when both reports carry the exact pinned model
revision; fallback vectors are never compared with MiniLM vectors. Evidence
reasons identify the signal used for a decision. Scores are ranking signals,
not probabilities of incident identity.

Known incompatible locations, times, categories, entities and coordinator
rejections block attachment. Missing context cannot count as agreement. The
first report remains the anchor, all group members are checked for hard
incompatibilities, and a close competing incident requires human review.
Uncertain descriptions and explicit distinctions remain visible. Opposing
accounts can describe a changing incident, so disagreement alone does not
establish two separate events or cancel an urgent claim.

Group ranking averages all member comparisons, including reports after the
fourth. Each evidence row retains its own pair score; its explanation states
the group mean and member count used for ranking. When a lexical route has a
compatible MiniLM anchor, it additionally requires dense anchor corroboration.
This is an anchor safeguard, not a requirement that both complete ranking
methods independently choose a winner. A different leading candidate from the
other route requires review, and close semantic alternatives remain visible.

## Why the original semantic result was weak

The lexical gates were adjusted on development fixtures, while semantic
attachment still used the build plan's illustrative starting values: a 0.82
composite and a 0.62 anchor cosine. These were hypotheses, not calibrated
probabilities. Their synthetic regression comparison did not establish that
lexical matching is intrinsically better than semantic matching.

A development-only experiment with the real pinned encoder recovered 2 of 66
same-family pairs at the original semantic settings, compared with 55 of 66 for
lexical matching. Lowering the semantic gates experimentally recovered 64 of
66, but none of that development set's different-family pairs passed its
location/time gates. That apparent precision therefore could not establish
safety among unrelated incidents sharing the same context. The experiment is
diagnosis, not justification for shipping its lowest thresholds.

Rule-based context also needs review. A bare location or equipment noun such as
“display” does not establish a facility fault. A mistaken category can block an
otherwise strong semantic match; installing another model does not repair that
boundary by itself.

## Development safety challenge

`data/evaluation/challenge_dev.json` contains 48 hand-authored pairs: 18 assigned
to one synthetic event, 18 assigned to distinct events, and 12 whose identity is
deliberately underdetermined. Every pair shares the same recorded zone,
sublocation and event time. The cases include varied paraphrases, different
people and equipment, changing claims, and incomplete descriptions.

The core 36 cases were authored before scoring. A balanced extension was also
written before scoring: six positive pairs mention a “different” tool or helper,
and six negative pairs avoid annotation-like “different” or “separate” cues.
This reduces one obvious wording shortcut without making the small fixture an
independent benchmark. The final fixture's SHA-256 is
`0612fcc14b68f681ab55a737687f9e1a5d1de71034d4e711bf2750f70eee8079`.

These labels encode author assumptions about synthetic scenarios. Sometimes
the available text cannot establish the author's intended identity. An
attachment on an underdetermined case is a missed review target, not proof of a
false merge between known different events. A changing blocked/clear account
may legitimately belong to one incident; the required conflict workflow must
remain available.

`scripts/evaluate_challenge.py` calls the ordinary report analysis and grouping
methods in both arrival orders. It records observed model revisions, fixture
hash, configuration, failures and per-case evidence. It reports attachment
recall separately from candidate recall, identifiable false attachments,
suggestion noise, and underdetermined cases needing review. A suggested match
is not an automatic attachment or a successful identification.

```sh
make evaluate-challenge
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .venv-semantic/bin/python scripts/evaluate_challenge.py --mode lexical
```

The selected development profile uses a 0.76 semantic attachment composite,
0.62 dense anchor corroboration, 0.65 semantic review composite, 0.20 review
anchor and the existing 0.08 runner-up margin. Selection required zero
automatic attachments on explicitly distinct challenge incidents, then
maximized pairwise grouping recall on the original development stream. Ties
favoured higher thresholds. The underdetermined labels were reported
separately instead of being treated as known distinct events.

| Same decision policy on the 48-pair challenge | Same-event pairs attached, both orders | Distinct-event pairs wrongly attached | Underdetermined pairs provisionally attached | Same-event candidate coverage |
| --- | ---: | ---: | ---: | ---: |
| Forced lexical, current rules | 17 / 18 | 15 / 18 | 9 / 12 | 18 / 18 |
| Hybrid with real MiniLM, selected settings | 12 / 18 | 0 / 18 | 4 / 12 | 18 / 18 |

This is a precision/recall tradeoff on development data: dense corroboration
prevents 15 known distinct-event attachments, while five duplicate scenarios
move from automatic attachment to coordinator review. The original semantic
prototype attached only 2 of the 18 duplicate scenarios and surfaced candidate
evidence for 15 of 18. The hybrid still suggests 17 of 18 explicitly distinct
scenarios, including all six cue-free negatives, so suggestion noise remains
substantial. Four underdetermined scenarios receive provisional membership;
coordinator confirmation is still required, and this is a recorded limitation.

A matched-budget lexical control was also tuned on the same development data.
Lexical attachment thresholds of 0.60 and above avoid the 18 distinct-case
attachments, but recover zero of the original development stream's 66 positive
pairs. The predeclared tie-break selects 0.82; it automatically attaches none of
the challenge's duplicate cases either. This control is a diagnostic, not a
change to the runtime lexical fallback. It prevents attributing an apparent AI
gain solely to comparing tuned hybrid settings against an untuned baseline.

On the original 60-report development stream, the hybrid recovers 22 of 66
same-family pairs without a false merge, compared with 2 of 66 under the
original semantic configuration. This does not establish performance on
unseen incidents. Full profile summaries, selection rules, device and model
provenance, fixture hashes and selected-case witnesses are recorded in
`evaluation/results/hybrid-development.json`.

On the fixed 60-report regression stream, the final hybrid groups 13 of 66
same-family pairs (recall 19.7%, previously 3.0%), with no false merge pairs.
The paired production lexical run groups 43 of 66 (65.2%), also without a false
merge on this easier context partition. Thus hybrid does not outperform lexical
recall on this fixture. Its context-matched development results demonstrate a
more conservative operating choice; neither result establishes unseen-event
accuracy. The full current measurements are `evaluation/results/semantic.json`
and `evaluation/results/latest.json`.

The final real-model API rehearsal retained all 24 replay reports in 19 groups,
with no automatic within-group conflict objects. A fresh-intake check grouped
the projector paraphrases, kept a sound-monitor fault separate, retained an
incomplete unassessed report, and preserved opposing doorway claims after
coordinator review. The development changing-exit reports remain in separate
groups, but the incoming clear account carries a source-cited cross-report
conflict warning. Review warnings and actual within-group conflict objects
are intentionally distinguished in the recorded verification.

## Fair comparison and limits

The main evaluator includes a forced-lexical production run on the same ordered
report stream whenever all semantic embeddings have consistent provenance.
This comparison uses the same grouping, context, ambiguity and review rules.
The older Jaccard and fixed-threshold cosine rows remain diagnostic baselines;
their simpler policy and uncalibrated thresholds are labelled in limitations.

Policy and conflict-detector checks supply ground-truth memberships to test
those components separately. Their success does not prove that predicted
groups joined the relevant reports. Actual membership errors, cross-report
review flags and the persisted API workflow must also be inspected.

Original development and fixed test/regression fixtures remain unchanged. No
test labels enter runtime matching or threshold selection. Both original
splits are synthetic, share recurring patterns, and were inspected during
engineering; the fixed test results are regression measurements rather than an
untouched operational accuracy study. The new challenge is development data
used during implementation and cannot serve as independent validation either.

Further model complexity is worthwhile only if it improves identification or
reduces review burden under a fair comparison. A general-purpose reranker can
judge similar meaning without establishing incident identity. Additional model
downloads, inference work and dependencies need measured benefit before they
belong in the demo runtime.

## Reranker feasibility result

A bounded CPU experiment scored all 48 frozen pairs with
[`cross-encoder/stsb-TinyBERT-L4`](https://huggingface.co/cross-encoder/stsb-TinyBERT-L4)
at revision `1f478482145797a0cac02d6b9ab3c65c9d25fb1e`. Only its 57.4 MB
safetensors checkpoint and tokenizer/config files were downloaded into a
temporary experiment cache. The existing Sentence Transformers environment
provided the implementation; no runtime dependency or second model was added.

At a raw score threshold of 0.60 it accepted 9 of 18 same-event pairs and 1 of
18 distinct-event pairs; that false match was among the cue-free negatives.
At 0.65 it accepted only 5 of 18 same-event pairs. Similarity distributions
overlapped substantially, so this model did not earn integration into Aegis.
These are development feasibility measurements, not a calibrated incident
classifier. Full scores, provenance, threshold diagnostics and limitations are
in `evaluation/results/reranker-development.json`.
