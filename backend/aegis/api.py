"""FastAPI application for the local Aegis synthetic exercise."""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .models import (
    Audit,
    ConflictReviewRequest,
    DemoSessionRequest,
    EmptyRequest,
    Evaluation,
    GroupingReviewRequest,
    Health,
    Incident,
    IngestReportRequest,
    IngestReportResponse,
    PriorityReviewRequest,
    Report,
    Snapshot,
    StatusReviewRequest,
)
from .storage import SQLiteStore, StorageError

logger = logging.getLogger("aegis.api")


class APIError(Exception):
    def __init__(self, status_code: int, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


def _engine_from_runtime() -> Any:
    from .engine import AnalysisEngine

    return AnalysisEngine()


def create_app(
    db_path: str | Path | None = ":memory:",
    engine: Any | None = None,
    store: SQLiteStore | None = None,
    allowed_hosts: tuple[str, ...] = ("localhost", "127.0.0.1", "::1"),
) -> FastAPI:
    """Create an isolated API app; tests should pass ``:memory:`` and a fake engine."""

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        owns_store = application.state.store is None
        try:
            if owns_store:
                path = application.state.db_path
                if path is None:
                    path = os.environ.get("AEGIS_DB_PATH", "runtime/aegis.sqlite3")
                application.state.store = SQLiteStore(path)
            if application.state.engine is None:
                application.state.engine = _engine_from_runtime()
            yield
        finally:
            if owns_store and application.state.store is not None:
                application.state.store.close()
                application.state.store = None

    application = FastAPI(
        title="Aegis API",
        version="1.0.0",
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url=None,
    )
    application.state.db_path = db_path
    application.state.store = store
    application.state.engine = engine
    application.state.evaluation_cache = None
    application.state.evaluation_lock = Lock()

    @application.middleware("http")
    async def guard_local_api(request: Request, call_next: Any) -> Response:
        def reject(status: int, code: str, message: str) -> JSONResponse:
            return JSONResponse(
                status_code=status,
                content={"error": {"code": code, "message": message}},
                headers={"Cache-Control": "no-store"},
            )

        try:
            authority = urlsplit("//" + request.headers.get("host", ""))
            hostname = authority.hostname
            if (
                authority.username is not None
                or authority.password is not None
                or authority.path
                or authority.query
                or authority.fragment
                or (authority.port is not None and authority.port == 0)
            ):
                hostname = None
        except ValueError:
            hostname = None
        if hostname not in allowed_hosts:
            return reject(400, "invalid_host", "The request host is not allowed.")
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            origin = request.headers.get("origin")
            if origin is not None:
                try:
                    parsed = urlsplit(origin)
                    trusted = (
                        parsed.scheme in {"http", "https"}
                        and parsed.hostname in allowed_hosts
                        and parsed.username is None
                        and parsed.password is None
                        and not (parsed.path or parsed.query or parsed.fragment)
                    )
                except ValueError:
                    trusted = False
                if not trusted:
                    return reject(403, "untrusted_origin", "The request origin is not allowed.")
            elif request.headers.get("sec-fetch-site") == "cross-site":
                return reject(403, "untrusted_origin", "Cross-site changes are not allowed.")
            content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if request.method == "POST" and content_type != "application/json":
                return reject(415, "unsupported_media_type", "Requests must use application/json.")
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @application.exception_handler(APIError)
    async def api_error_handler(_: Request, exc: APIError) -> JSONResponse:
        body: dict[str, Any] = {"code": exc.code, "message": exc.message}
        if exc.details is not None:
            body["details"] = exc.details
        return JSONResponse(status_code=exc.status_code, content={"error": body})

    @application.exception_handler(StorageError)
    async def storage_error_handler(_: Request, exc: StorageError) -> JSONResponse:
        body: dict[str, Any] = {"code": exc.code, "message": exc.message}
        if exc.details is not None:
            body["details"] = exc.details
        return JSONResponse(status_code=exc.status_code, content={"error": body})

    @application.exception_handler(RequestValidationError)
    async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
        fields = [
            {
                "loc": list(error.get("loc", ())),
                "message": str(error.get("msg", "Invalid value.")),
                "code": str(error.get("type", "value_error")),
            }
            for error in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "validation_error",
                    "message": "The request did not match the API contract.",
                    "details": {"fields": fields},
                }
            },
        )

    @application.exception_handler(StarletteHTTPException)
    async def http_error_handler(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        if exc.status_code == 404:
            code, message = "not_found", "The requested resource was not found."
        elif exc.status_code == 405:
            code, message = (
                "method_not_allowed",
                "This method is not available for the requested path.",
            )
        else:
            code, message = "request_failed", "The request could not be completed."
        return JSONResponse(
            status_code=exc.status_code, content={"error": {"code": code, "message": message}}
        )

    @application.exception_handler(Exception)
    async def unexpected_error_handler(_: Request, exc: Exception) -> JSONResponse:
        logger.error("Unhandled Aegis request failure (%s)", type(exc).__name__, exc_info=exc)
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "internal_error",
                    "message": "The request could not be completed.",
                }
            },
        )

    def get_store(request: Request) -> SQLiteStore:
        store_value = request.app.state.store
        if store_value is None:
            raise RuntimeError("Application storage was not initialized.")
        return store_value

    def get_engine(request: Request) -> Any:
        engine_value = request.app.state.engine
        if engine_value is None:
            raise RuntimeError("Analysis engine was not initialized.")
        return engine_value

    @application.get("/api/health", response_model=Health)
    def health(request: Request) -> dict[str, Any]:
        engine_value = get_engine(request)
        try:
            result = engine_value.health()
            return {
                "status": result.get("status", "ready"),
                "engine": result.get("engine", "unknown"),
                "model_ready": bool(result.get("model_ready", False)),
                "model_revision": result.get("model_revision"),
            }
        except Exception as exc:
            logger.error("Aegis engine health check failed (%s)", type(exc).__name__, exc_info=exc)
            return {
                "status": "degraded",
                "engine": "unavailable",
                "model_ready": False,
                "model_revision": None,
            }

    @application.get("/api/events/current")
    def current_event(request: Request) -> dict[str, Any]:
        event = get_store(request).current_event()
        if event is None:
            raise APIError(503, "event_unavailable", "No exercise event is available.")
        return {"event": event, "zones": _zones()}

    @application.get("/api/reports", response_model=list[Report])
    def list_reports(request: Request, event_id: str | None = None) -> list[dict[str, Any]]:
        store_value = get_store(request)
        selected_event = event_id or _require_current_event(store_value)["id"]
        _require_event(store_value, selected_event)
        return [_public_report(report) for report in store_value.reports_for_event(selected_event)]

    @application.get("/api/incidents", response_model=list[Incident])
    def list_incidents(request: Request, event_id: str | None = None) -> list[dict[str, Any]]:
        store_value = get_store(request)
        selected_event = event_id or _require_current_event(store_value)["id"]
        _require_event(store_value, selected_event)
        return store_value.incidents_for_event(selected_event)

    @application.get("/api/incidents/{incident_id}", response_model=Incident)
    def get_incident(request: Request, incident_id: str) -> dict[str, Any]:
        incident = get_store(request).get_incident(incident_id)
        if incident is None:
            raise APIError(404, "not_found", "Incident was not found.")
        return incident

    @application.get("/api/audit", response_model=list[Audit])
    def list_audit(request: Request, event_id: str | None = None) -> list[dict[str, Any]]:
        store_value = get_store(request)
        selected_event = event_id or _require_current_event(store_value)["id"]
        _require_event(store_value, selected_event)
        return store_value.audit_for_event(selected_event)

    @application.get("/api/snapshot", response_model=Snapshot)
    def snapshot(request: Request, event_id: str | None = None) -> dict[str, Any]:
        return _snapshot(request, event_id)

    @application.post(
        "/api/reports",
        response_model=IngestReportResponse,
        status_code=201,
        responses={200: {"model": IngestReportResponse}},
    )
    def ingest_report(
        body: IngestReportRequest, request: Request, response: Response
    ) -> dict[str, Any]:
        result = _ingest(body, request)
        if result["duplicate"]:
            response.status_code = 200
        return result

    @application.post("/api/reviews/grouping", response_model=Snapshot)
    def grouping_review(body: GroupingReviewRequest, request: Request) -> dict[str, Any]:
        store_value = get_store(request)
        engine_value = get_engine(request)
        event_id, _ = store_value.apply_grouping_review(body.model_dump(), engine_value)
        return _snapshot(request, event_id)

    @application.post("/api/incidents/{incident_id}/priority", response_model=Snapshot)
    def update_priority(
        incident_id: str, body: PriorityReviewRequest, request: Request
    ) -> dict[str, Any]:
        store_value = get_store(request)
        store_value.update_priority(incident_id, body.priority, body.reason, body.expected_version)
        incident = store_value.get_incident(incident_id)
        return _snapshot(request, incident["event_id"] if incident else None)

    @application.post("/api/incidents/{incident_id}/status", response_model=Snapshot)
    def update_status(
        incident_id: str, body: StatusReviewRequest, request: Request
    ) -> dict[str, Any]:
        store_value = get_store(request)
        store_value.update_status(incident_id, body.status, body.reason, body.expected_version)
        incident = store_value.get_incident(incident_id)
        return _snapshot(request, incident["event_id"] if incident else None)

    @application.post("/api/conflicts/{conflict_id}/review", response_model=Snapshot)
    def review_conflict(
        conflict_id: str, body: ConflictReviewRequest, request: Request
    ) -> dict[str, Any]:
        store_value = get_store(request)
        event_id = store_value.review_conflict(
            conflict_id, body.status, body.reason, body.expected_version
        )
        return _snapshot(request, event_id)

    @application.post("/api/demo/session", response_model=Snapshot)
    def start_demo(body: DemoSessionRequest, request: Request) -> dict[str, Any]:
        fixtures = _scenario(body.scenario)
        session = get_store(request).create_demo_session(body.scenario, len(fixtures))
        return _snapshot(request, session["event_id"], replay=session)

    @application.post("/api/demo/session/{session_id}/next", response_model=Snapshot)
    def next_demo(session_id: str, body: EmptyRequest, request: Request) -> dict[str, Any]:
        store_value = get_store(request)
        session = store_value.get_demo_session(session_id)
        if session is None:
            raise APIError(404, "not_found", "Demo session was not found.")
        scenario_reports = _scenario(session["scenario"])
        if session["cursor"] < session["total"]:
            fixture = scenario_reports[session["cursor"]]
            if fixture.get("source") != "replay":
                fixture = {**fixture, "source": "replay"}
            if fixture.get("event_id") is not None and fixture["event_id"] != session["event_id"]:
                raise APIError(
                    500, "fixture_invalid", "The replay fixture is not event independent."
                )
            body_value = IngestReportRequest(
                text=fixture["text"],
                zone_id=fixture.get("zone_id"),
                sublocation=fixture.get("sublocation"),
                reported_at=fixture.get("reported_at"),
                idempotency_key=fixture["idempotency_key"],
                source="replay",
                event_id=session["event_id"],
            )
            _ingest(body_value, request)
            session = store_value.advance_demo_cursor(session_id, session["cursor"])
        return _snapshot(request, session["event_id"], replay=session)

    @application.get("/api/evaluation/latest", response_model=Evaluation)
    def latest_evaluation(request: Request) -> dict[str, Any]:
        with request.app.state.evaluation_lock:
            cached = request.app.state.evaluation_cache
            if cached is not None:
                return cached
            try:
                from .evaluation import run_evaluation

                result = Evaluation.model_validate(run_evaluation(get_engine(request)))
            except Exception as exc:
                logger.warning(
                    "Aegis evaluation is unavailable (%s)", type(exc).__name__, exc_info=exc
                )
                raise APIError(
                    503, "evaluation_unavailable", "Measured evaluation results are unavailable."
                ) from exc
            checked_result = result.model_dump()
            request.app.state.evaluation_cache = checked_result
            return checked_result

    def _snapshot(
        request: Request, event_id: str | None = None, replay: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        store_value = get_store(request)
        selected_event = event_id or _require_current_event(store_value)["id"]
        data = store_value.snapshot_data(selected_event)
        if replay is None:
            replay = store_value.get_demo_session_for_event(selected_event)
        unresolved_conflicts = sum(
            1
            for incident in data["incidents"]
            for conflict in incident["conflicts"]
            if conflict["status"] == "unresolved"
        )
        return {
            **data,
            "reports": [_public_report(report) for report in data["reports"]],
            "zones": _zones(),
            "counts": {
                "reports": len(data["reports"]),
                "incidents": len(data["incidents"]),
                "review": sum(1 for incident in data["incidents"] if incident["review_required"]),
                "conflicts": unresolved_conflicts,
            },
            "health": health(request),
            "replay": replay,
        }

    application.state.snapshot_builder = _snapshot
    return application


def _require_current_event(store: SQLiteStore) -> dict[str, Any]:
    event = store.current_event()
    if event is None:
        raise APIError(503, "event_unavailable", "No exercise event is available.")
    return event


def _require_event(store: SQLiteStore, event_id: str) -> dict[str, Any]:
    event = store.get_event(event_id)
    if event is None:
        raise APIError(404, "not_found", "Event was not found.")
    return event


def _zones() -> list[dict[str, Any]]:
    from .fixtures import ZONES

    return [dict(zone) for zone in ZONES]


def _scenario(name: str) -> list[dict[str, Any]]:
    from .fixtures import get_scenario

    return get_scenario(name)


def _ingest(body: IngestReportRequest, request: Request) -> dict[str, Any]:
    store_value: SQLiteStore = request.app.state.store
    engine_value = request.app.state.engine
    event = (
        _require_event(store_value, body.event_id)
        if body.event_id
        else _require_current_event(store_value)
    )
    allowed_zones = {zone["id"] for zone in _zones()}
    if body.zone_id is not None and body.zone_id not in allowed_zones:
        raise APIError(422, "invalid_zone", "zone_id must match a configured event zone.")
    report, incident, duplicate = store_value.create_report_receipt(
        event_id=event["id"],
        text=body.text,
        zone_id=body.zone_id,
        sublocation=body.sublocation,
        reported_at=body.reported_at,
        idempotency_key=body.idempotency_key,
        source=body.source,
    )
    if duplicate:
        return {"report": _public_report(report), "incident": incident, "duplicate": True}

    # The receipt and singleton were committed above. Model failure cannot erase either.
    try:
        analysis = engine_value.analyze_report(
            body.text,
            zone_id=body.zone_id,
            sublocation=body.sublocation,
            reported_at=body.reported_at,
        )
        if not isinstance(analysis, dict):
            raise TypeError("analyze_report must return a dictionary")
        incoming = {**report, **analysis}
        all_groups = store_value.get_groups_for_event(event["id"])
        candidate_groups = []
        for group in all_groups:
            complete_reports = [
                item for item in group["reports"] if item["analysis_status"] == "complete"
            ]
            if group["id"] != incident["id"] and complete_reports:
                candidate_groups.append({"id": group["id"], "reports": complete_reports})
        decision = engine_value.choose_group(
            incoming, candidate_groups, store_value.rejection_pairs(event["id"])
        )
        if not isinstance(decision, dict):
            raise TypeError("choose_group must return a dictionary")
        target_id = decision.get("incident_id")
        candidates = {group["id"]: group for group in candidate_groups}
        if target_id is not None and target_id not in candidates:
            raise ValueError("choose_group selected an unavailable incident")
        review_reasons = list(
            dict.fromkeys(
                list(analysis.get("review_reasons", [])) + list(decision.get("review_reasons", []))
            )
        )
        analysis = {**analysis, "review_reasons": review_reasons}
        target_group = candidates.get(target_id)
        group_reports = [*(target_group["reports"] if target_group else []), incoming]
        assessment = engine_value.assess_priority(group_reports)
        generated_conflicts = engine_value.detect_conflicts(group_reports)
        if not isinstance(assessment, dict) or not isinstance(generated_conflicts, list):
            raise TypeError("assessment and conflicts must have their contract types")
        evidence = decision.get("evidence", [])
        if not isinstance(evidence, list):
            raise TypeError("choose_group evidence must be a list")
        finalized_report, finalized_incident = store_value.finalize_analysis(
            report["id"],
            analysis,
            target_id,
            evidence,
            assessment,
            generated_conflicts,
            engine=engine_value,
            receipt_incident_id=incident["id"],
        )
    except Exception as exc:
        logger.error(
            "Report analysis failed for report %s (%s)",
            report["id"],
            type(exc).__name__,
            exc_info=exc,
        )
        fallback_assessment = None
        try:
            policy_report = {"id": report["id"], "text": body.text, "zone_id": body.zone_id}
            fallback_assessment = engine_value.assess_priority([policy_report])
            if not isinstance(fallback_assessment, dict):
                raise TypeError("assess_priority must return a dictionary")
        except Exception as policy_exc:
            logger.error(
                "Deterministic priority assessment failed for report %s (%s)",
                report["id"],
                type(policy_exc).__name__,
                exc_info=policy_exc,
            )
        failed_report, failed_incident = store_value.fail_pending_analysis(
            report["id"], type(exc).__name__, fallback_assessment
        )
        return {
            "report": _public_report(failed_report),
            "incident": failed_incident,
            "duplicate": False,
        }

    return {
        "report": _public_report(finalized_report),
        "incident": finalized_incident,
        "duplicate": False,
    }


def _public_report(report: dict[str, Any]) -> dict[str, Any]:
    """Remove internal model/replay metadata while preserving the public report shape."""
    return {
        key: report[key]
        for key in (
            "id",
            "event_id",
            "text",
            "zone_id",
            "sublocation",
            "category",
            "reported_at",
            "received_at",
            "analysis_status",
            "incident_id",
            "claims",
            "review_reasons",
        )
    }


app = create_app(
    db_path=None,
    allowed_hosts=tuple(
        host.strip()
        for host in os.environ.get("AEGIS_ALLOWED_HOSTS", "localhost,127.0.0.1,::1").split(",")
        if host.strip()
    ),
)
