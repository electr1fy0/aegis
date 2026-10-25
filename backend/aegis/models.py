"""Typed request and response shapes for the Aegis HTTP API."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Priority = Literal["P0", "P1", "P2", "UNASSESSED"]
IncidentStatus = Literal["open", "acknowledged", "monitoring", "resolved"]
AnalysisStatus = Literal["complete", "pending", "failed"]
ResourceID = Annotated[str, Field(min_length=1, max_length=80, pattern=r"\S")]
Version = Annotated[int, Field(strict=True, ge=1)]


class StrictModel(BaseModel):
    # Raw report text and source evidence must survive byte-for-byte at the text layer.
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)

    @field_validator("*", mode="before")
    @classmethod
    def strings_must_be_valid_unicode(cls, value: Any) -> Any:
        if isinstance(value, str):
            try:
                value.encode("utf-8")
            except UnicodeEncodeError as exc:
                raise ValueError("text must contain valid Unicode characters") from exc
        return value


class ErrorDetail(StrictModel):
    loc: list[str | int]
    message: str
    code: str


class ErrorFields(StrictModel):
    fields: list[ErrorDetail]


class ErrorBody(StrictModel):
    code: str
    message: str
    details: dict[str, Any] | ErrorFields | list[Any] | None = None


class ErrorResponse(StrictModel):
    error: ErrorBody


class Zone(StrictModel):
    id: str
    label: str
    x: float
    y: float


class Event(StrictModel):
    id: str
    name: str
    timezone: str
    exercise: bool
    created_at: datetime
    policy_version: str


class CoordinatorNote(StrictModel):
    id: str
    text: str
    actor: str
    created_at: datetime


class Claim(StrictModel):
    field: str
    value: str
    span: str


class Report(StrictModel):
    id: str
    display_id: str | None = None
    event_id: str
    text: str
    zone_id: str | None
    sublocation: str | None
    category: str | None
    reported_at: datetime | None
    received_at: datetime
    analysis_status: AnalysisStatus
    incident_id: str
    claims: list[Claim]
    review_reasons: list[str]
    model_revision: str | None = None
    confirmed: bool = False


class Evidence(StrictModel):
    report_id: str
    candidate_report_id: str
    semantic_score: float | None
    location_score: float | None
    time_score: float | None
    category_score: float | None
    total_score: float | None
    decision: Literal["attach", "suggest", "separate"]
    reasons: list[str]
    missing_fields: list[str]
    created_at: datetime | None = None


class Conflict(StrictModel):
    id: str
    field: str
    report_ids: list[str]
    values: list[str]
    spans: list[str]
    status: Literal["unresolved", "resolved"]
    reason: str


class Incident(StrictModel):
    id: str
    display_id: str | None = None
    event_id: str
    title: str
    zone_id: str | None
    priority: Priority
    suggested_priority: Priority
    priority_reason: str
    status: IncidentStatus
    review_required: bool
    review_reasons: list[str]
    report_ids: list[str]
    evidence: list[Evidence]
    conflicts: list[Conflict]
    version: int
    created_at: datetime
    updated_at: datetime
    override_reason: str | None
    notes: list[CoordinatorNote] = Field(default_factory=list)
    original_title: str | None = None
    title_override: bool = False


class Audit(StrictModel):
    id: str
    seq: int
    event_id: str
    actor: str
    action: str
    entity_id: str
    reason: str | None
    before: Any | None
    after: Any | None
    created_at: datetime


class Health(StrictModel):
    status: str
    engine: str
    model_ready: bool
    model_revision: str | None


class Replay(StrictModel):
    session_id: str
    event_id: str
    cursor: int
    total: int
    scenario: str


class Counts(StrictModel):
    reports: int
    incidents: int
    review: int
    conflicts: int


class UndoableAction(StrictModel):
    audit_id: str
    incident_id: str
    action: str
    expected_version: int


class Snapshot(StrictModel):
    event: Event
    zones: list[Zone]
    incidents: list[Incident]
    reports: list[Report]
    audit: list[Audit]
    counts: Counts
    health: Health
    replay: Replay | None
    undoable_actions: list[UndoableAction] = Field(default_factory=list)


class IngestReportRequest(StrictModel):
    text: str = Field(min_length=1, max_length=4000)
    zone_id: str | None = Field(default=None, max_length=80)
    sublocation: str | None = Field(default=None, max_length=200)
    reported_at: datetime | None = None
    idempotency_key: str = Field(min_length=1, max_length=200)
    source: Literal["form", "replay"] = "form"
    event_id: str | None = Field(default=None, min_length=1, max_length=80)

    @field_validator("text")
    @classmethod
    def text_must_not_be_whitespace(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("text must contain a non-whitespace character")
        return value

    @field_validator("idempotency_key")
    @classmethod
    def key_must_not_be_whitespace(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("idempotency_key must not be blank")
        return value.strip()

    @field_validator("sublocation")
    @classmethod
    def empty_sublocation_becomes_null(cls, value: str | None) -> str | None:
        return value.strip() or None if value is not None else None

    @field_validator("reported_at")
    @classmethod
    def reported_time_must_be_timezone_aware(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("reported_at must include a UTC offset")
        if value is not None:
            try:
                value.astimezone(UTC)
            except (ValueError, OverflowError) as exc:
                raise ValueError("reported_at must be representable in UTC") from exc
        return value

    @field_validator("reported_at", mode="before")
    @classmethod
    def reported_time_must_use_iso_text(cls, value: Any) -> Any:
        if value is not None and not isinstance(value, (str, datetime)):
            raise ValueError("reported_at must be an ISO timestamp with a UTC offset")
        return value


class IngestReportResponse(StrictModel):
    report: Report
    incident: Incident
    duplicate: bool


class GroupingReviewRequest(StrictModel):
    action: Literal["confirm", "reject", "move", "merge", "split"]
    report_ids: list[ResourceID] = Field(default_factory=list, max_length=500)
    incident_ids: list[ResourceID] = Field(default_factory=list, max_length=200)
    target_incident_id: str | None = Field(default=None, min_length=1, max_length=80)
    reason: str = Field(min_length=3, max_length=1000)
    expected_versions: dict[ResourceID, Version] = Field(max_length=501)

    @field_validator("report_ids", "incident_ids")
    @classmethod
    def ids_must_be_unique(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("IDs must not contain duplicates")
        return values

    @field_validator("reason")
    @classmethod
    def reason_must_contain_text(cls, value: str) -> str:
        if len(value.strip()) < 3:
            raise ValueError("reason must contain at least 3 non-whitespace characters")
        return value.strip()

    @model_validator(mode="after")
    def action_has_required_ids(self) -> GroupingReviewRequest:
        if self.action == "merge":
            if len(self.incident_ids) < 2:
                raise ValueError("merge requires at least two incident_ids")
        elif not self.report_ids:
            raise ValueError(f"{self.action} requires at least one report_id")
        return self


class PriorityReviewRequest(StrictModel):
    priority: Priority
    reason: str = Field(min_length=3, max_length=1000)
    expected_version: Version

    @field_validator("reason")
    @classmethod
    def reason_must_contain_text(cls, value: str) -> str:
        if len(value.strip()) < 3:
            raise ValueError("reason must contain at least 3 non-whitespace characters")
        return value.strip()


class StatusReviewRequest(StrictModel):
    status: IncidentStatus
    reason: str = Field(min_length=3, max_length=1000)
    expected_version: Version

    @field_validator("reason")
    @classmethod
    def reason_must_contain_text(cls, value: str) -> str:
        if len(value.strip()) < 3:
            raise ValueError("reason must contain at least 3 non-whitespace characters")
        return value.strip()


class ConflictReviewRequest(StrictModel):
    status: Literal["unresolved", "resolved"]
    reason: str = Field(min_length=3, max_length=1000)
    expected_version: Version

    @field_validator("reason")
    @classmethod
    def reason_must_contain_text(cls, value: str) -> str:
        if len(value.strip()) < 3:
            raise ValueError("reason must contain at least 3 non-whitespace characters")
        return value.strip()


class IncidentNoteRequest(StrictModel):
    text: str = Field(min_length=1, max_length=2000)
    expected_version: Version

    @field_validator("text")
    @classmethod
    def note_must_contain_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("text must contain a non-whitespace character")
        return value.strip()


class IncidentTitleRequest(StrictModel):
    title: str = Field(min_length=1, max_length=120)
    reason: str = Field(min_length=3, max_length=1000)
    expected_version: Version

    @field_validator("title")
    @classmethod
    def title_must_contain_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("title must contain a non-whitespace character")
        return value.strip()

    @field_validator("reason")
    @classmethod
    def reason_must_contain_text(cls, value: str) -> str:
        if len(value.strip()) < 3:
            raise ValueError("reason must contain at least 3 non-whitespace characters")
        return value.strip()


class PriorityResetRequest(StrictModel):
    reason: str = Field(min_length=3, max_length=1000)
    expected_version: Version

    @field_validator("reason")
    @classmethod
    def reason_must_contain_text(cls, value: str) -> str:
        if len(value.strip()) < 3:
            raise ValueError("reason must contain at least 3 non-whitespace characters")
        return value.strip()


class UndoRequest(StrictModel):
    reason: str = Field(min_length=3, max_length=1000)
    expected_version: Version

    @field_validator("reason")
    @classmethod
    def reason_must_contain_text(cls, value: str) -> str:
        if len(value.strip()) < 3:
            raise ValueError("reason must contain at least 3 non-whitespace characters")
        return value.strip()


class RetryAnalysisRequest(StrictModel):
    expected_version: Version


class DemoSessionRequest(StrictModel):
    scenario: Literal["demo", "busy", "edge"]


class EmptyRequest(StrictModel):
    pass


class EvaluationResult(StrictModel):
    method: str
    precision: float
    recall: float
    f1: float
    false_merges: int
    missed_pairs: int
    review_rate: float


class EvaluationCheck(StrictModel):
    name: str
    passed: bool
    detail: str


class EvaluationLatency(StrictModel):
    p50_ms: float
    p95_ms: float


class EvaluationErrorExample(StrictModel):
    kind: Literal["missed_pair", "false_merge"]
    method: str
    report_ids: tuple[str, str]
    texts: tuple[str, str]
    expected_same_incident: bool
    predicted_same_incident: bool
    reasons: list[str]


class EvaluationWorkload(StrictModel):
    reports: int
    review_reports: int
    proposed_groups: int
    confirmation_groups: int
    split_operations: int
    merge_operations: int
    basis: str


class Evaluation(StrictModel):
    dataset_version: str
    model: str
    config_version: str
    generated_at: datetime
    results: list[EvaluationResult]
    checks: list[EvaluationCheck]
    latency: EvaluationLatency
    limitations: list[str]
    failures: list[str]
    error_examples: list[EvaluationErrorExample] = Field(default_factory=list)
    workload: EvaluationWorkload | None = None
