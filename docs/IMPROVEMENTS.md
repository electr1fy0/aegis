# Coordinator workflow improvements

The forty improvements stay within the existing four routes. The queue is the main navigation surface; the inspector holds evidence and decisions; the header holds exercise selection and theme; Replay and Export are compact disclosure menus.

| # | Improvement | Implementation |
| --- | --- | --- |
| 1 | Related-group suggestions | Up to three candidates ranked from stored cross-group evidence; no location-only suggestions. |
| 2 | Side-by-side comparison | Original report snippets, reported times, locations, ranking signals and missing context. |
| 3 | Reason-specific review queue | Readable review categories distinguish missing location/time, conflicts, analysis failures and confirmation. |
| 4 | Easier time entry | Just observed, Earlier and Unknown; unknown remains absent and known times use the event timezone. |
| 5 | Draft recovery | Event-scoped persisted text, context, time, receipt and stable retry identity. |
| 6 | Exercise history | Header selector revisits retained exercises; new replay preserves history. |
| 7 | Shorter inspector | Detailed grouping evidence and extracted claims expand on demand. |
| 8 | New evidence indicators | Persisted report read state distinguishes arrivals since an incident was explicitly viewed. |
| 9 | Search | Titles, IDs, original report wording, locations and sublocations. |
| 10 | Compact filters | Priority, status, zone and reports with unknown locations. |
| 11 | Sort choices | Priority default; oldest unreviewed, newest update and latest report alternatives. |
| 12 | Interactive counts | Summary cards change queue tabs; the unlocated tray applies its location filter. |
| 13 | Workspace restoration | Event-scoped selection, queue criteria and scroll position. |
| 14 | Incident links | Receipt links and dashboard query state identify the exercise and incident. |
| 15 | Readable IDs | Stable event-local report/incident references with full-ID copy actions. |
| 16 | Keyboard controls | Search focus, queue navigation and Escape; typing retains normal input behavior. |
| 17 | Review next | Audited save-and-next actions keep review work moving. |
| 18 | Contextual actions | Report selection exposes move/split; group selection exposes merge. |
| 19 | Consistent scopes | Selected incident visibility and map/queue/count scopes are explicit. |
| 20 | Coordinator notes | Independent attributed notes, persisted and audited without changing status. |
| 21 | Editable titles | Custom titles survive analysis rebuilds; original text and title history are retained. |
| 22 | Laptop inspector drawer | Responsive inspector preserves access to queue, map and toolbar. |
| 23 | Crowded map zones | A zone marker expands its incident list instead of stacking overlapping markers. |
| 24 | Readability | Larger operational text and hit targets, visible focus and reduced-motion support. |
| 25 | Light theme | One persisted System/Dark/Light control supports projectors. |
| 26 | Freshness | Last successful update, reconnecting and stale-snapshot status. |
| 27 | Source highlights | Supporting claim/conflict phrases link back to their original reports. |
| 28 | Accurate score labels | Lexical/semantic provenance and decimal ranking values; historical evidence remains labelled. |
| 29 | Incident timeline | Reported occurrence, receipt and coordinator decisions remain distinct. |
| 30 | Grouping preview | Membership and affected groups are shown before saving a correction. |
| 31 | Stale-edit explanation | Changed membership, priority, status or evidence is shown while the draft reason survives. |
| 32 | Return to policy | An audited reset removes a priority override, including its obsolete override-specific warning. |
| 33 | Guarded undo | Only an eligible latest priority/status decision can be compensated; later changes prevent undo. |
| 34 | Location equivalents | Versioned aliases are zone-scoped; raw wording and directional distinctions are preserved. |
| 35 | Semantic setup | Separate locked environment, exact model revision, explicit preparation and verified offline inference. |
| 36 | Evaluation diagnostics | Real missed/false report pairs and idealized split/merge/confirmation workload. |
| 37 | Analysis recovery | Bounded pending-report recovery at startup and explicit failed/pending retry preserve coordinator edits. |
| 38 | Shared snapshots | Header and routes share event state, cancellation, failure backoff and visibility-aware polling. |
| 39 | Local toolkit | One development command, read-only preflight, additive migrations and verified backup/restore to new paths. |
| 40 | Exercise brief | Print view and JSON/CSV contain status, source IDs, notes and unresolved questions. |

## Evaluation evidence

Both environments were executed against the unchanged 60-report synthetic regression fixture. Normal development remains lexical. Optional semantic inference is not enabled merely because weights exist in the cache.

| Measured Aegis method | Precision | Recall | F1 | Missed pairs | False merges |
| --- | ---: | ---: | ---: | ---: | ---: |
| Contextual lexical | 1.000 | 0.621 | 0.766 | 25 | 0 |
| Pinned MiniLM plus context | 1.000 | 0.030 | 0.059 | 64 | 0 |

The current semantic gates are conservative and perform worse on this fixture. No thresholds were changed using the test labels. These measurements do not establish real-world accuracy. Ground-truth partition corrections estimate grouping operations; they do not measure operator time or clicks.

See [the lexical result](../evaluation/results/latest.json), [the real semantic result](../evaluation/results/semantic.json), and [local maintenance commands](MAINTENANCE.md).
