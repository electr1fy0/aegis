# Aegis implementation contract

All `/api` endpoints use JSON and UTC ISO timestamps. Frontend proxies `/api` to http://127.0.0.1:8000. Bind locally by default. Synthetic exercise data only. No external messages or dispatch.

The API validates the raw Host header against `AEGIS_ALLOWED_HOSTS` (default `localhost,127.0.0.1,::1`). Mutations reject untrusted browser origins and POST bodies require `application/json`. Rejections use the error envelope below: invalid host 400, untrusted origin 403, unsupported media type 415. These controls do not provide user authentication.

## Shapes

`Priority = "P0" | "P1" | "P2" | "UNASSESSED"`

`Status = "open" | "acknowledged" | "monitoring" | "resolved"`

- Event: `{id,name,timezone,exercise,created_at,policy_version}`.
- Zone: `{id,label,x,y}`; schematic uses a 1000 by 600 viewbox.
- Claim: `{field,value,span}`. `span` is original supporting text, not numerical offsets.
- Report: `{id,event_id,text,zone_id,sublocation,category,reported_at,received_at,analysis_status,incident_id,claims,review_reasons}`. Nullable fields are explicit null. Status: complete/pending/failed.
- Evidence: `{report_id,candidate_report_id,semantic_score,location_score,time_score,category_score,total_score,decision,reasons,missing_fields}`. Context scores nullable. Decision: attach/suggest/separate. Scores are ranking signals, not probabilities.
- Conflict: `{id,field,report_ids,values,spans,status,reason}`; status unresolved/resolved.
- Incident: `{id,event_id,title,zone_id,priority,suggested_priority,priority_reason,status,review_required,review_reasons,report_ids,evidence,conflicts,version,created_at,updated_at,override_reason}`.
- Audit: `{id,seq,event_id,actor,action,entity_id,reason,before,after,created_at}`. before/after JSON values or null.
- Health: `{status,engine,model_ready,model_revision}`. Engine must truthfully label semantic vs lexical/degraded mode.
- Replay: `{session_id,event_id,cursor,total,scenario}` or null.
- Snapshot: `{event,zones,incidents,reports,audit,counts,health,replay}`. Counts: `{reports,incidents,review,conflicts}`. All incidents/reports remain in snapshot; filtering is a UI operation.

Workflow extensions: Report includes `display_id`, `model_revision` and `confirmed`; Incident includes `display_id`, `notes`, `original_title` and `title_override`; Evidence includes its historical `created_at`. Display IDs are stable and unique within an event and entity kind. Notes are `{id,text,actor,created_at}`. Snapshot also includes `undoable_actions: [{audit_id,incident_id,action,expected_version}]`, computed by the server from current state. Optional legacy response fields have defaults.

Zones: `stage` Main Stage (230,180), `exit-a` Exit A (120,430), `exit-b` Exit B (820,430), `food` Food Court (720,180), `registration` Registration (470,430), `hall` Exhibition Hall (470,180). Labels are illustrative, not a real safety map.

## Endpoints

- `GET /api/health` -> Health.
- `GET /api/snapshot?event_id=...` -> Snapshot. Omitted event ID uses current exercise event.
- `GET /api/events/current` -> `{event,zones}`.
- `GET /api/events` -> Event[] newest first, including retained earlier exercises.
- `GET /api/reports` -> Report[]. `event_id` optional.
- `GET /api/incidents` -> Incident[]. `event_id` optional.
- `GET /api/incidents/{id}` -> Incident.
- `GET /api/audit` -> Audit[]. `event_id` optional.
- `POST /api/reports`: `{text,zone_id?,sublocation?,reported_at?,idempotency_key,source?}` -> `{report,incident,duplicate}`. source form/replay, defaults form; `event_id` optional. Text 1–4000 non-whitespace characters. Unknown zones rejected. Idempotency scoped by event, mismatched retry payload is 409.
- `POST /api/reviews/grouping`: `{action,report_ids,incident_ids?,target_incident_id?,reason,expected_versions}` -> Snapshot. Actions confirm/reject/move/merge/split. `expected_versions` maps every affected incident ID to version. Confirm selected membership; reject a candidate pairing using target_incident_id, retaining separate report; move selected reports to target; merge incident_ids into target (or first ID); split selected reports into a new incident. All operations validate same event, update atomically, and retain rejection constraints. Rejecting an existing membership must split it into its own incident. Empty/no-op/invalid actions return validation errors.
- `POST /api/incidents/{id}/priority`: `{priority,reason,expected_version}` -> Snapshot.
- `POST /api/incidents/{id}/status`: `{status,reason,expected_version}` -> Snapshot.
- `POST /api/incidents/{id}/notes`: `{text,expected_version}` -> Snapshot. Text is nonblank, at most 2,000 characters; the note, incident version, and audit entry commit together.
- `POST /api/incidents/{id}/title`: `{title,reason,expected_version}` -> Snapshot. Title is nonblank, at most 120 characters; source wording and original title remain available.
- `POST /api/incidents/{id}/priority/reset`: `{reason,expected_version}` -> Snapshot. Removes the override and recomputes its review warning; resetting an absent override is 409.
- `POST /api/audit/{audit_id}/undo`: `{reason,expected_version}` -> Snapshot. Compensates the eligible latest priority override/reset or status change. Later incident changes, deleted incidents, stale versions, unsupported actions and already compensated actions cannot be undone. Original audit records remain.
- `POST /api/reports/{id}/retry`: `{expected_version}` -> Snapshot. Retries pending/failed analysis in the owning incident; the existing receipt and coordinator membership are preserved. Completed analysis is not retryable.
- `POST /api/conflicts/{id}/review`: `{status,reason,expected_version}` -> Snapshot. Version is owning incident version.
- `POST /api/demo/session`: `{scenario}` -> Snapshot, where scenario demo/busy/edge. Creates new exercise event; never deletes history.
- `POST /api/demo/session/{id}/next`: `{}` -> Snapshot. Ingest next fixture using ordinary ingestion. Exhausted replay returns unchanged snapshot, no duplicate insertion. `{id}` is session_id.
- `GET /api/evaluation/latest` -> Evaluation (see below). If unavailable, explicit 503, not fabricated results.

Reason fields min 3 max 1000 characters, trimmed. Versions must be positive JSON integers; booleans and numeric strings are rejected. Grouping ID lists are bounded and each ID is nonblank and at most 80 characters. Text must be valid Unicode and reported times must be representable in UTC. Validation returns 422, missing resource 404, stale versions/idempotency conflict 409. All errors: `{error:{code,message,details?}}`. Server failure: 500 with generic user-facing message and logged internal details. Method not allowed/unknown route also use error shape.

## Evaluation shape

`{dataset_version,model,config_version,generated_at,results,checks,latency,limitations,failures}`

- results: `[{method,precision,recall,f1,false_merges,missed_pairs,review_rate}]`.
- checks: `[{name,passed,detail}]`.
- latency: `{p50_ms,p95_ms}`.
- limitations/failures: string arrays.

Evaluation also includes `error_examples` (up to 40 actual Aegis missed/false report pairs, original texts and recorded comparison reasons) and nullable `workload` (`reports`, `review_reports`, `proposed_groups`, `confirmation_groups`, `split_operations`, `merge_operations`, `basis`). Correction counts are calculated from the synthetic truth partition and are not measured operator time or clicks. Runtime failures remain separate from grouping mistakes.

Measurements must be produced by executable evaluation code. Runtime may compute/cached-load real results locally.

## Python engine interface (owner: intelligence agent)

Module `backend/aegis/engine.py` exports `AnalysisEngine`:

- `health() -> dict`: Health.
- `analyze_report(text, zone_id=None, sublocation=None, reported_at=None) -> dict`: `{category,claims,priority,priority_reason,review_reasons,embedding,model_revision}`.
- `score_pair(incoming:dict, existing:dict) -> dict`: Evidence. Inputs include public report fields plus embedding. report IDs use `id`.
- `choose_group(incoming:dict, groups:list[dict], rejections:set[tuple[str,str]] | None=None) -> dict`: `{incident_id: str|None,evidence:list[dict],review_reasons:list[str]}`. Group: `{id,reports:list[dict]}`. Rejections are report-ID/incident-ID pairs; honor them. Maintain anchor/margin/context constraints and no transitive bridging.
- `assess_priority(reports:list[dict]) -> dict`: `{priority,reason,review_reasons}`.
- `detect_conflicts(reports:list[dict]) -> list[dict]`: Conflict field data `{field,report_ids,values,spans}` (storage adds stable id/status/reason).

Pure engine methods must never read ground-truth incident labels. API service persists raw receipt before analysis; catches inference failures, retains failed visible singleton, and always records audit.

## Fixtures/evaluation interface (owner: data agent)

`backend/aegis/fixtures.py`: `ZONES` list above; `get_scenario(name)->list[dict]` fresh copies. Fixture reports `{text,zone_id,sublocation?,reported_at,idempotency_key,source:"replay"}`. Scenario fixtures do not include truth in runtime inputs.

`backend/aegis/evaluation.py`: `run_evaluation(engine=None)->dict` returning Evaluation shape. Test/dev ground truth lives separately from runtime fixture objects. No dependencies on API/storage internals. Import AnalysisEngine lazily if needed.

## Ownership

Root: repository tooling, root tests/verification, integration/review, documentation and commit.
Frontend agent: frontend/ only.
Backend agent: backend/aegis/api.py, storage.py, models.py, __init__.py, __main__.py; backend/tests/test_api.py and test_storage.py.
Intelligence agent: backend/aegis/engine.py and backend/tests/test_engine.py.
Data agent: backend/aegis/fixtures.py, evaluation.py, backend/tests/test_fixtures.py, test_evaluation.py and data/.

Follow this contract exactly; report necessary contract changes to root before changing another owner's files.
