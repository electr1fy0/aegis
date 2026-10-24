import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  advanceReplay,
  getAudit,
  getEvaluation,
  getEventsCurrent,
  getIncidents,
  getReports,
  getSnapshot,
  reviewConflict,
  reviewGrouping,
  REQUEST_TIMEOUT_MS,
  startReplay,
  submitReport,
  updatePriority,
  updateStatus,
} from "../lib/api";
import { evaluationFixture, snapshotFixture } from "./fixtures";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("API client", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("loads the default snapshot and passes an AbortSignal through", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshotFixture));
    const controller = new AbortController();

    await expect(getSnapshot(undefined, controller.signal)).resolves.toEqual(
      snapshotFixture,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/snapshot",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("adds the selected event to snapshot requests", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshotFixture));

    await getSnapshot("event-demo");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/snapshot?event_id=event-demo",
      expect.anything(),
    );
  });

  it.each([
    ["current event", getEventsCurrent, "/api/events/current"],
    ["reports", getReports, "/api/reports"],
    ["incidents", getIncidents, "/api/incidents"],
    ["audit entries", getAudit, "/api/audit"],
  ])("loads %s from its contract endpoint", async (_label, request, path) => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await request();

    expect(fetchMock).toHaveBeenCalledWith(
      path,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    ["reports", getReports, "/api/reports"],
    ["incidents", getIncidents, "/api/incidents"],
    ["audit entries", getAudit, "/api/audit"],
  ])("filters %s by event", async (_label, request, path) => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await request("event with spaces");

    expect(fetchMock).toHaveBeenCalledWith(
      `${path}?event_id=event%20with%20spaces`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("loads measured evaluation data", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(evaluationFixture));

    await expect(getEvaluation()).resolves.toEqual(evaluationFixture);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/evaluation/latest",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("submits a report without mutating its idempotency key or source", async () => {
    const input = {
      text: "Exit A is blocked by a fallen barrier.",
      zone_id: "exit-a",
      sublocation: "north door",
      reported_at: "2026-10-24T16:10:00Z",
      idempotency_key: "form-submit-123",
      source: "form" as const,
    };
    const response = {
      report: snapshotFixture.reports[0],
      incident: snapshotFixture.incidents[0],
      duplicate: false,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(response));

    await expect(submitReport(input)).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/reports",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify(input),
      }),
    );
  });

  it.each([
    [
      "grouping review",
      () =>
        reviewGrouping({
          action: "confirm",
          report_ids: ["report-001", "report-002"],
          target_incident_id: "incident-001",
          incident_ids: ["incident-001"],
          reason: "Reviewed the matching evidence.",
          expected_versions: { "incident-001": 1 },
        }),
      "/api/reviews/grouping",
      {
        action: "confirm",
        report_ids: ["report-001", "report-002"],
        target_incident_id: "incident-001",
        incident_ids: ["incident-001"],
        reason: "Reviewed the matching evidence.",
        expected_versions: { "incident-001": 1 },
      },
    ],
    [
      "priority override",
      () =>
        updatePriority("incident/001", {
          priority: "P1",
          reason: "The coordinator confirmed a lower risk.",
          expected_version: 1,
        }),
      "/api/incidents/incident%2F001/priority",
      {
        priority: "P1",
        reason: "The coordinator confirmed a lower risk.",
        expected_version: 1,
      },
    ],
    [
      "status transition",
      () =>
        updateStatus("incident-001", {
          status: "acknowledged",
          reason: "Coordinator has reviewed the incident.",
          expected_version: 1,
        }),
      "/api/incidents/incident-001/status",
      {
        status: "acknowledged",
        reason: "Coordinator has reviewed the incident.",
        expected_version: 1,
      },
    ],
    [
      "conflict review",
      () =>
        reviewConflict("conflict 001", {
          status: "resolved",
          reason: "Venue staff verified the exit is clear.",
          expected_version: 1,
        }),
      "/api/conflicts/conflict%20001/review",
      {
        status: "resolved",
        reason: "Venue staff verified the exit is clear.",
        expected_version: 1,
      },
    ],
    [
      "replay start",
      () => startReplay("busy"),
      "/api/demo/session",
      { scenario: "busy" },
    ],
    ["replay advance", () => advanceReplay("session/demo"), "/api/demo/session/session%2Fdemo/next", {}],
  ])("sends %s to its endpoint with a JSON body", async (_label, request, path, body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(snapshotFixture));

    await expect(request()).resolves.toEqual(snapshotFixture);
    expect(fetchMock).toHaveBeenCalledWith(
      path,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      }),
    );
  });

  it("turns structured API errors into useful failures", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error: {
            code: "stale_version",
            message: "This incident changed. Refresh and try again.",
            details: { expected: 1, actual: 2 },
          },
        },
        409,
      ),
    );

    await expect(getSnapshot()).rejects.toThrow(
      "This incident changed. Refresh and try again.",
    );
  });

  it("shows the backend-unavailable evaluation message", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: "evaluation_unavailable", message: "Evaluation results are not available yet." } },
        503,
      ),
    );

    await expect(getEvaluation()).rejects.toThrow("Evaluation results are not available yet.");
  });

  it("falls back to the HTTP status when an error response is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("upstream failure", { status: 502 }));

    const failure = getSnapshot();

    await expect(failure).rejects.toMatchObject({
      name: "ApiError",
      message: "Request failed (502).",
      status: 502,
      code: "request_failed",
      details: null,
    });
  });

  it("rejects a successful response with unreadable JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }));

    await expect(getEvaluation()).rejects.toMatchObject({
      name: "ApiError",
      message: "The server returned an unreadable response.",
      status: 200,
      code: "invalid_response",
      details: null,
    });
  });

  it("provides safe defaults for directly constructed API errors", () => {
    const failure = new ApiError("Conflict", 409);

    expect(failure).toMatchObject({
      name: "ApiError",
      message: "Conflict",
      status: 409,
      code: "request_failed",
      details: null,
    });
  });

  it("rejects slow requests with a timeout error and aborts the fetch", async () => {
    vi.useFakeTimers();
    const pendingResponse = new Promise<Response>(() => {});
    fetchMock.mockReturnValueOnce(pendingResponse);
    const request = getSnapshot();
    const [, requestInit] = fetchMock.mock.calls[0] ?? [];

    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    const rejection = expect(request).rejects.toMatchObject({
      name: "ApiError",
      status: 408,
      code: "request_timeout",
      message: "The server did not respond in time. Try again.",
    });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await rejection;
    expect(requestInit?.signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("times out when the server sends headers but stalls while reading JSON", async () => {
    vi.useFakeTimers();
    let resolveBody!: (value: unknown) => void;
    const stalledBody = new Promise<unknown>((resolve) => {
      resolveBody = resolve;
    });
    const response = {
      ok: true,
      status: 200,
      json: () => stalledBody,
    } as unknown as Response;
    fetchMock.mockResolvedValueOnce(response);
    const request = getSnapshot();
    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    const rejection = expect(request).rejects.toMatchObject({
      name: "ApiError",
      status: 408,
      code: "request_timeout",
      message: "The server did not respond in time. Try again.",
    });

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await rejection;
    expect(requestInit?.signal?.aborted).toBe(true);
    resolveBody(snapshotFixture);
    vi.useRealTimers();
  });

  it("does not turn an aborted JSON read into an unreadable-response error", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => new Promise((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => {
            reject(new DOMException("Request timed out", "AbortError"));
          }, { once: true });
        }),
      } as Response);
    });

    const request = getSnapshot();
    const rejection = expect(request).rejects.toMatchObject({
      name: "ApiError",
      status: 408,
      code: "request_timeout",
    });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("forwards caller cancellation to the in-flight fetch", async () => {
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("Caller cancelled", "AbortError")),
          { once: true },
        );
      });
    });

    const request = getSnapshot(undefined, caller.signal);
    caller.abort();

    await expect(request).rejects.toThrow("Caller cancelled");
    expect(requestSignal?.aborted).toBe(true);
  });

  it("starts an already-cancelled request with an aborted fetch signal", async () => {
    const caller = new AbortController();
    caller.abort();
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return Promise.reject(new DOMException("Already cancelled", "AbortError"));
    });

    await expect(getSnapshot(undefined, caller.signal)).rejects.toThrow("Already cancelled");
    expect(requestSignal?.aborted).toBe(true);
  });
});
