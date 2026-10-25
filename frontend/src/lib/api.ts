import type {
  AuditEntry,
  ConflictReviewInput,
  CurrentEvent,
  Evaluation,
  EventInfo,
  GroupingReviewInput,
  Incident,
  PriorityInput,
  Report,
  ReportInput,
  ReportReceipt,
  Snapshot,
  StatusInput,
} from "./types";

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export const REQUEST_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, status: number, code = "request_failed", details: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const sourceSignal = init?.signal ?? undefined;
  if (sourceSignal?.aborted) controller.abort(sourceSignal.reason);
  const forwardAbort = () => controller.abort(sourceSignal?.reason);
  sourceSignal?.addEventListener("abort", forwardAbort, { once: true });

  let rejectTimeout!: (reason: ApiError) => void;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeoutId = setTimeout(() => {
      rejectTimeout(new ApiError("The server did not respond in time. Try again.", 408, "request_timeout"));
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

  const request = async (): Promise<T> => {
    const response = await fetch(path, { ...init, signal: controller.signal });
    let payload: unknown;

    try {
      payload = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
      payload = null;
    }

    if (!response.ok) {
      const body = typeof payload === "object" && payload !== null ? (payload as ApiErrorBody) : {};
      const errorValue = body.error;
      const error = typeof errorValue === "object" && errorValue !== null ? errorValue : undefined;
      const message = typeof error?.message === "string" ? error.message : `Request failed (${response.status}).`;
      throw new ApiError(
        message,
        response.status,
        error?.code ?? "request_failed",
        error?.details ?? null,
      );
    }

    if (payload === null) {
      throw new ApiError("The server returned an unreadable response.", response.status, "invalid_response");
    }

    return payload as T;
  };

  try {
    return await Promise.race([request(), timeout]);
  } finally {
    clearTimeout(timeoutId);
    sourceSignal?.removeEventListener("abort", forwardAbort);
  }
}

function eventQuery(eventId?: string): string {
  return eventId ? `?event_id=${encodeURIComponent(eventId)}` : "";
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function getSnapshot(eventId?: string, signal?: AbortSignal): Promise<Snapshot> {
  return requestJson(`/api/snapshot${eventQuery(eventId)}`, { signal });
}

export function getEvaluation(): Promise<Evaluation> {
  return requestJson("/api/evaluation/latest");
}

export function getEventsCurrent(): Promise<CurrentEvent> {
  return requestJson("/api/events/current");
}

export function getEvents(signal?: AbortSignal): Promise<EventInfo[]> {
  return requestJson("/api/events", { signal });
}

export function addIncidentNote(id: string, input: { text: string; expected_version: number }): Promise<Snapshot> {
  return requestJson(`/api/incidents/${encodeURIComponent(id)}/notes`, jsonRequest(input));
}

export function updateIncidentTitle(id: string, input: { title: string; reason: string; expected_version: number }): Promise<Snapshot> {
  return requestJson(`/api/incidents/${encodeURIComponent(id)}/title`, jsonRequest(input));
}

export function resetPriority(id: string, input: { reason: string; expected_version: number }): Promise<Snapshot> {
  return requestJson(`/api/incidents/${encodeURIComponent(id)}/priority/reset`, jsonRequest(input));
}

export function undoDecision(auditId: string, input: { reason: string; expected_version: number }): Promise<Snapshot> {
  return requestJson(`/api/audit/${encodeURIComponent(auditId)}/undo`, jsonRequest(input));
}

export function retryAnalysis(reportId: string, input: { expected_version: number }): Promise<Snapshot> {
  return requestJson(`/api/reports/${encodeURIComponent(reportId)}/retry`, jsonRequest(input));
}

export function getReports(eventId?: string): Promise<Report[]> {
  return requestJson(`/api/reports${eventQuery(eventId)}`);
}

export function getIncidents(eventId?: string): Promise<Incident[]> {
  return requestJson(`/api/incidents${eventQuery(eventId)}`);
}

export function getAudit(eventId?: string): Promise<AuditEntry[]> {
  return requestJson(`/api/audit${eventQuery(eventId)}`);
}

export function submitReport(input: ReportInput): Promise<ReportReceipt> {
  return requestJson("/api/reports", jsonRequest(input));
}

export function reviewGrouping(input: GroupingReviewInput): Promise<Snapshot> {
  return requestJson("/api/reviews/grouping", jsonRequest(input));
}

export function updatePriority(id: string, input: PriorityInput): Promise<Snapshot> {
  return requestJson(`/api/incidents/${encodeURIComponent(id)}/priority`, jsonRequest(input));
}

export function updateStatus(id: string, input: StatusInput): Promise<Snapshot> {
  return requestJson(`/api/incidents/${encodeURIComponent(id)}/status`, jsonRequest(input));
}

export function reviewConflict(id: string, input: ConflictReviewInput): Promise<Snapshot> {
  return requestJson(`/api/conflicts/${encodeURIComponent(id)}/review`, jsonRequest(input));
}

export function startReplay(scenario: "demo" | "busy" | "edge"): Promise<Snapshot> {
  return requestJson("/api/demo/session", jsonRequest({ scenario }));
}

export function advanceReplay(sessionId: string): Promise<Snapshot> {
  return requestJson(`/api/demo/session/${encodeURIComponent(sessionId)}/next`, jsonRequest({}));
}
