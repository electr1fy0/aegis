// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getEvents, getSnapshot, submitReport } from "../lib/api";
import { dashboardReceiptHref, datetimeLocalToIso, ReportPage } from "../pages/report-page";
import type { EventInfo, ReportReceipt, Snapshot } from "../lib/types";
import { SnapshotProvider, useSnapshot } from "../hooks/use-snapshot";
import { emptyReportDraft, loadReportDraft, saveReportDraft } from "../lib/report-draft";
import { eventFixture, makeIncident, makeReport, makeSnapshot, snapshotFixture } from "./fixtures";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    getEvents: vi.fn(),
    getSnapshot: vi.fn(),
    submitReport: vi.fn(),
  };
});

const getSnapshotMock = vi.mocked(getSnapshot);
const getEventsMock = vi.mocked(getEvents);
const submitReportMock = vi.mocked(submitReport);

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function installLocalStorage(storage: Storage): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  return () => {
    if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
    else delete (window as unknown as { localStorage?: Storage }).localStorage;
  };
}

function reportEvent(id: string, name: string, createdAt: string): EventInfo {
  return { ...eventFixture, id, name, created_at: createdAt };
}

function snapshotForEvent(event: EventInfo): Snapshot {
  return makeSnapshot({ event, zones: [], incidents: [], reports: [], audit: [], counts: { reports: 0, incidents: 0, review: 0, conflicts: 0 } });
}

function ReportEventHarness() {
  const stream = useSnapshot();
  return (
    <>
      <button type="button" onClick={() => stream.selectEvent("event-older")}>Open older event</button>
      <button type="button" onClick={() => stream.selectEvent(eventFixture.id)}>Open current event</button>
      <ReportPage />
    </>
  );
}

function receipt(overrides: Partial<ReportReceipt> = {}): ReportReceipt {
  return {
    report: makeReport({
      id: "report-new",
      text: "A guest needs help near the main stage.",
      analysis_status: "pending",
      incident_id: "incident-new",
    }),
    incident: makeIncident({
      id: "incident-new",
      priority: "P1",
      suggested_priority: "P1",
      report_ids: ["report-new"],
    }),
    duplicate: false,
    ...overrides,
  };
}

async function openLoadedForm() {
  getSnapshotMock.mockResolvedValueOnce(snapshotFixture);
  const user = userEvent.setup();
  const view = render(<ReportPage />);
  const description = await screen.findByRole("textbox", { name: "Report description" });
  await waitFor(() => expect(description).toBeEnabled());
  return { ...view, user, description };
}

beforeEach(() => {
  getEventsMock.mockReset();
  getSnapshotMock.mockReset();
  submitReportMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("ReportPage", () => {
  it("builds a safe receipt link when rendered without a browser location", () => {
    const browserWindow = window;
    vi.stubGlobal("window", undefined);
    try {
      expect(dashboardReceiptHref("event /one", "incident?two")).toBe(
        "/dashboard?event=event%20%2Fone&incident=incident%3Ftwo",
      );
    } finally {
      vi.stubGlobal("window", browserWindow);
    }
  });

  it("creates a fallback idempotency identity when randomUUID is unavailable", async () => {
    const restoreStorage = installLocalStorage(new MemoryStorage());
    const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
    try {
      submitReportMock.mockResolvedValueOnce(receipt());
      const { unmount, user, description } = await openLoadedForm();
      await user.type(description, "A report using the local fallback identity.");
      await user.click(screen.getByRole("button", { name: "Submit report" }));
      await screen.findByRole("status", { name: "Submission receipt" });
      expect(submitReportMock.mock.calls[0]?.[0].idempotency_key).toMatch(/^aegis-/);
      unmount();
    } finally {
      if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
      else delete (globalThis as unknown as { crypto?: Crypto }).crypto;
      restoreStorage();
    }
  });

  it("loads event zones and submits exact text with event context and local time", async () => {
    const input = {
      text: "  A guest needs help near the main stage.  ",
      source: "form",
      event_id: "event-demo",
      zone_id: "stage",
      sublocation: "north rail",
      reported_at: "2026-10-24T17:15:00.000Z",
      idempotency_key: expect.any(String),
    };
    submitReportMock.mockResolvedValueOnce(receipt({
      report: makeReport({
        id: "report-new",
        display_id: null,
        event_id: "event-demo",
        text: input.text,
        analysis_status: "pending",
        incident_id: "incident-new",
      }),
    }));
    const { user, description } = await openLoadedForm();

    expect(screen.getByText("Aegis Campus Safety Exercise")).toBeInTheDocument();
    await user.type(description, input.text);
    await user.selectOptions(screen.getByRole("combobox", { name: "Zone" }), "stage");
    await user.type(screen.getByRole("textbox", { name: "Sublocation" }), "north rail");
    await user.click(screen.getByRole("radio", { name: /Earlier/ }));
    fireEvent.change(screen.getByLabelText("Earlier event time"), {
      target: { value: "2026-10-24T10:15" },
    });
    await user.click(screen.getByRole("button", { name: "Submit report" }));

    const receiptRegion = await screen.findByRole("status", { name: "Submission receipt" });
    expect(submitReportMock).toHaveBeenCalledOnce();
    expect(submitReportMock).toHaveBeenCalledWith(input);
    expect(screen.getByText("report-n", { selector: ".mono" })).toHaveAttribute("title", "report-new");
    expect(screen.getByText("incident", { selector: ".mono" })).toHaveAttribute("title", "incident-new");
    expect(receiptRegion).toHaveTextContent("P1 · pending analysis");
    expect(receiptRegion.querySelector("blockquote")?.textContent).toBe(input.text);
    expect(description).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Zone" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Sublocation" })).toHaveValue("");
    expect(screen.getByRole("radio", { name: /Unknown/ })).toBeChecked();
  });

  it("captures the current event-local time only after Just observed is explicitly selected", async () => {
    vi.setSystemTime(new Date("2026-10-24T17:15:42.000Z"));
    submitReportMock.mockResolvedValueOnce(receipt());
    const { user, description } = await openLoadedForm();
    await user.type(description, "A person is waiting for assistance now.");
    expect(screen.getByRole("radio", { name: /Unknown/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /Just observed/ }));
    expect(screen.getByText(/Captured at 2026-10-24 10:15:42 in America\/Los_Angeles/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit report" }));

    await screen.findByRole("status", { name: "Submission receipt" });
    expect(submitReportMock.mock.calls[0]?.[0].reported_at).toBe("2026-10-24T17:15:42.000Z");
  });

  it("captures Just observed at submission if a restored draft has no captured time yet", async () => {
    const storage = new MemoryStorage();
    const restoreStorage = installLocalStorage(storage);
    vi.setSystemTime(new Date("2026-10-24T17:15:42.000Z"));
    const draft = {
      ...emptyReportDraft("event-demo", "stable-observation-key"),
      text: "A restored report has an explicit current-time choice.",
      timeMode: "just-observed" as const,
    };
    expect(saveReportDraft(draft, storage)).toBe(true);
    submitReportMock.mockResolvedValueOnce(receipt());
    try {
      const { user, description } = await openLoadedForm();
      expect(description).toHaveValue(draft.text);
      expect(screen.getByRole("radio", { name: /Just observed/ })).toBeChecked();
      expect(screen.getByText(/will be captured when you submit/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Submit report" }));
      await screen.findByRole("status", { name: "Submission receipt" });
      expect(submitReportMock.mock.calls[0]?.[0].reported_at).toBe("2026-10-24T17:15:42.000Z");
      expect(submitReportMock.mock.calls[0]?.[0].idempotency_key).toBe("stable-observation-key");
    } finally {
      restoreStorage();
    }
  });

  it("keeps Just observed available and explains when a legacy event timezone is invalid", async () => {
    const malformedEvent = { ...eventFixture, timezone: "Invalid/Zone" };
    getSnapshotMock.mockResolvedValueOnce(makeSnapshot({ event: malformedEvent }));
    const { user, description } = await openLoadedForm();
    await user.type(description, "An observation for a legacy exercise.");
    await user.click(screen.getByRole("radio", { name: /Just observed/ }));
    expect(screen.getByText(/will be captured when you submit/)).toBeInTheDocument();
  });

  it("keeps Just observed optional when timezone projection is unavailable", async () => {
    getSnapshotMock.mockResolvedValueOnce(snapshotFixture);
    const formatParts = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockReturnValue([]);
    const { user, description } = await openLoadedForm();
    await user.type(description, "A current observation with unavailable local formatting.");
    await user.click(screen.getByRole("radio", { name: /Just observed/ }));
    expect(screen.getByText(/will be captured when you submit/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a valid, unambiguous local time in America/Los_Angeles.",
    );
    expect(submitReportMock).not.toHaveBeenCalled();
    formatParts.mockRestore();
  });

  it("does not invent a current time when the system clock cannot format an instant", async () => {
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue("not-an-ISO-time");
    const { user, description } = await openLoadedForm();
    await user.type(description, "An observation while the clock is unavailable.");
    await user.click(screen.getByRole("radio", { name: /Just observed/ }));
    expect(screen.getByText(/will be captured when you submit/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a valid, unambiguous local time in America/Los_Angeles.",
    );
    expect(submitReportMock).not.toHaveBeenCalled();
  });

  it("omits unknown optional location fields and preserves them blank on a pending receipt", async () => {
    submitReportMock.mockResolvedValueOnce(receipt({ duplicate: false }));
    const { user, description } = await openLoadedForm();
    await user.type(description, "A barrier is down near Exit A.");
    await user.click(screen.getByRole("radio", { name: /Earlier/ }));
    await user.click(screen.getByRole("radio", { name: /Unknown/ }));
    await user.click(screen.getByRole("button", { name: "Submit report" }));

    await screen.findByRole("status", { name: "Submission receipt" });
    const sent = submitReportMock.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      text: "A barrier is down near Exit A.",
      source: "form",
      event_id: "event-demo",
    });
    expect(sent).not.toHaveProperty("zone_id");
    expect(sent).not.toHaveProperty("sublocation");
    expect(sent).not.toHaveProperty("reported_at");
  });

  it("rejects whitespace and overlong descriptions before making a request", async () => {
    const { user, description } = await openLoadedForm();
    await user.type(description, "   ");
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a report description before submitting.",
    );
    expect(submitReportMock).not.toHaveBeenCalled();

    fireEvent.change(description, { target: { value: "x".repeat(4_001) } });
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Keep the description to 4,000 characters or fewer.",
    );
    expect(submitReportMock).not.toHaveBeenCalled();
  });

  it("rejects invalid and daylight-saving-gap times with an accessible explanation", async () => {
    const { user, description } = await openLoadedForm();
    await user.type(description, "Exit A is blocked.");
    await user.click(screen.getByRole("radio", { name: /Earlier/ }));
    fireEvent.change(screen.getByLabelText("Earlier event time"), {
      target: { value: "2026-03-08T02:30" },
    });
    await user.click(screen.getByRole("button", { name: "Submit report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a valid, unambiguous local time in America/Los_Angeles.",
    );
    expect(screen.getByLabelText("Earlier event time")).toHaveAttribute("aria-invalid", "true");
    expect(submitReportMock).not.toHaveBeenCalled();
  });

  it("requires a time for Earlier and rejects a reporter time after now", async () => {
    vi.setSystemTime(new Date("2026-10-24T17:15:00.000Z"));
    const { user, description } = await openLoadedForm();
    await user.type(description, "A report with a supplied time.");
    await user.click(screen.getByRole("radio", { name: /Earlier/ }));
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose an earlier event time, or select Unknown if it was not provided.",
    );

    fireEvent.change(screen.getByLabelText("Earlier event time"), {
      target: { value: "2026-10-25T11:00" },
    });
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This time is after now. Choose Just observed or check the reporter’s time.",
    );
    expect(submitReportMock).not.toHaveBeenCalled();
  });

  it("retries loading the current event after an accessible backend error", async () => {
    getSnapshotMock
      .mockRejectedValueOnce(new ApiError("Exercise history is unavailable.", 503, "offline"))
      .mockResolvedValueOnce(snapshotFixture);
    const user = userEvent.setup();
    render(<ReportPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Exercise history is unavailable.");

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Report description" })).toBeEnabled());
    expect(getSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes the shared snapshot stream from the report event error", async () => {
    const currentEvent = reportEvent(eventFixture.id, "Current exercise", "2026-10-25T12:00:00Z");
    getEventsMock.mockResolvedValue([currentEvent]);
    getSnapshotMock
      .mockResolvedValueOnce(null as unknown as Snapshot)
      .mockResolvedValueOnce(snapshotForEvent(currentEvent));
    const user = userEvent.setup();
    render(<SnapshotProvider><ReportEventHarness /></SnapshotProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The exercise snapshot could not be read. Check the backend and retry.",
    );

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Report description" })).toBeEnabled());
    expect(getSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the shared intake disabled until the selected event loads", async () => {
    let resolveEvents!: (events: EventInfo[]) => void;
    const pendingEvents = new Promise<EventInfo[]>((resolve) => { resolveEvents = resolve; });
    const currentEvent = reportEvent(eventFixture.id, "Current exercise", "2026-10-25T12:00:00Z");
    let resolveSnapshot!: (snapshot: Snapshot) => void;
    const pendingSnapshot = new Promise<Snapshot>((resolve) => { resolveSnapshot = resolve; });
    getEventsMock.mockReturnValueOnce(pendingEvents);
    getSnapshotMock.mockReturnValueOnce(pendingSnapshot);
    render(<SnapshotProvider><ReportEventHarness /></SnapshotProvider>);

    const description = await screen.findByRole("textbox", { name: "Report description" });
    expect(description).toBeDisabled();
    const form = screen.getByRole("button", { name: "Submit report" }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.change(description, { target: { value: "A premature entry" } });
    fireEvent.submit(form as HTMLFormElement);
    expect(submitReportMock).not.toHaveBeenCalled();

    await act(async () => resolveEvents([currentEvent]));
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledOnce());
    await act(async () => resolveSnapshot(snapshotForEvent(currentEvent)));
    await waitFor(() => expect(description).toBeEnabled());
    expect(description).toHaveValue("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps an idempotency key for same-payload retries and rotates it after edits", async () => {
    submitReportMock
      .mockRejectedValueOnce(new ApiError("Retry with the same content.", 409, "idempotency_conflict"))
      .mockRejectedValueOnce(new ApiError("Retry with the same content.", 409, "idempotency_conflict"))
      .mockRejectedValueOnce(new ApiError("Conflict remains visible.", 409, "idempotency_conflict"));
    const { user, description } = await openLoadedForm();
    await user.type(description, "A person fell near the food court.");
    const submitButton = screen.getByRole("button", { name: "Submit report" });

    await user.click(submitButton);
    expect(await screen.findByRole("alert")).toHaveTextContent("Retry with the same content.");
    const firstKey = submitReportMock.mock.calls[0]?.[0].idempotency_key;

    await user.click(submitButton);
    await waitFor(() => expect(submitReportMock).toHaveBeenCalledTimes(2));
    const retryKey = submitReportMock.mock.calls[1]?.[0].idempotency_key;
    expect(retryKey).toBe(firstKey);

    await user.clear(description);
    await user.type(description, "A person fell by Registration.");
    await user.click(submitButton);
    await waitFor(() => expect(submitReportMock).toHaveBeenCalledTimes(3));
    const editedKey = submitReportMock.mock.calls[2]?.[0].idempotency_key;
    expect(editedKey).not.toBe(firstKey);
    expect(description).toHaveValue("A person fell by Registration.");
  });

  it("keeps an ambiguous submission retry safe after refreshing the page", async () => {
    const storage = new MemoryStorage();
    const restoreStorage = installLocalStorage(storage);
    vi.setSystemTime(new Date("2026-10-24T17:15:00.000Z"));
    submitReportMock
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(receipt({ duplicate: true }));
    try {
      const first = await openLoadedForm();
      await first.user.type(first.description, "A responder is needed by the south gate.");
      await first.user.click(screen.getByRole("radio", { name: /Just observed/ }));
      await first.user.click(screen.getByRole("button", { name: "Submit report" }));
      await screen.findByRole("alert");
      const originalKey = submitReportMock.mock.calls[0]?.[0].idempotency_key;
      const originalReportedAt = submitReportMock.mock.calls[0]?.[0].reported_at;
      first.unmount();

      vi.setSystemTime(new Date("2026-10-25T18:30:00.000Z"));
      getSnapshotMock.mockResolvedValueOnce(snapshotFixture);
      const retry = await openLoadedForm();
      expect(retry.description).toHaveValue("A responder is needed by the south gate.");
      expect(screen.getByRole("radio", { name: /Just observed/ })).toBeChecked();
      await retry.user.click(screen.getByRole("button", { name: "Submit report" }));

      await screen.findByRole("status", { name: "Submission receipt" });
      expect(submitReportMock).toHaveBeenCalledTimes(2);
      expect(submitReportMock.mock.calls[1]?.[0].idempotency_key).toBe(originalKey);
      expect(submitReportMock.mock.calls[1]?.[0].reported_at).toBe(originalReportedAt);
      expect(loadReportDraft("event-demo", "new-key", storage).receipt?.duplicate).toBe(true);
    } finally {
      restoreStorage();
    }
  });

  it("restores a confirmed receipt after a refresh without resubmitting it", async () => {
    const storage = new MemoryStorage();
    const restoreStorage = installLocalStorage(storage);
    submitReportMock.mockResolvedValueOnce(receipt());
    try {
      const first = await openLoadedForm();
      await first.user.type(first.description, "A visitor has a minor injury.");
      await first.user.click(screen.getByRole("button", { name: "Submit report" }));
      await screen.findByRole("status", { name: "Submission receipt" });
      expect(screen.getByText("Report receipt saved on this device.")).toBeInTheDocument();
      first.unmount();

      getSnapshotMock.mockResolvedValueOnce(snapshotFixture);
      const recovered = render(<ReportPage />);
      expect(await screen.findByRole("status", { name: "Submission receipt" })).toHaveTextContent("report-n");
      expect(screen.getByText("Report receipt restored on this device.")).toBeInTheDocument();
      expect(submitReportMock).toHaveBeenCalledOnce();
      recovered.unmount();
    } finally {
      restoreStorage();
    }
  });

  it("keeps separate drafts when switching between retained events", async () => {
    const storage = new MemoryStorage();
    const restoreStorage = installLocalStorage(storage);
    const currentEvent = reportEvent(eventFixture.id, "Current exercise", "2026-10-25T12:00:00Z");
    const olderEvent = reportEvent("event-older", "Earlier exercise", "2026-10-20T12:00:00Z");
    getEventsMock.mockResolvedValue([currentEvent, olderEvent]);
    getSnapshotMock.mockImplementation(async (eventId) => snapshotForEvent(eventId === olderEvent.id ? olderEvent : currentEvent));
    window.history.replaceState(null, "", "/report?event=event-demo&queue=review");
    try {
      const user = userEvent.setup();
      render(<SnapshotProvider><ReportEventHarness /></SnapshotProvider>);
      const description = await screen.findByRole("textbox", { name: "Report description" });
      await waitFor(() => expect(description).toBeEnabled());
      await user.type(description, "Current exercise draft.");

      await user.click(screen.getByRole("button", { name: "Open older event" }));
      await waitFor(() => expect(screen.getByText("Earlier exercise", { selector: "strong" })).toBeInTheDocument());
      await waitFor(() => expect(description).toHaveValue(""));
      await user.type(description, "Earlier exercise draft.");

      await user.click(screen.getByRole("button", { name: "Open current event" }));
      await waitFor(() => expect(description).toHaveValue("Current exercise draft."));
      await user.click(screen.getByRole("button", { name: "Open older event" }));
      await waitFor(() => expect(description).toHaveValue("Earlier exercise draft."));

      expect(loadReportDraft(eventFixture.id, "unused", storage).text).toBe("Current exercise draft.");
      expect(loadReportDraft(olderEvent.id, "unused", storage).text).toBe("Earlier exercise draft.");
      expect(new URL(window.location.href).searchParams.get("queue")).toBe("review");
    } finally {
      restoreStorage();
    }
  });

  it("stores an in-flight report receipt under its original event without replacing another event draft", async () => {
    const storage = new MemoryStorage();
    const restoreStorage = installLocalStorage(storage);
    const currentEvent = reportEvent(eventFixture.id, "Current exercise", "2026-10-25T12:00:00Z");
    const olderEvent = reportEvent("event-older", "Earlier exercise", "2026-10-20T12:00:00Z");
    let finishSubmission!: (value: ReportReceipt) => void;
    getEventsMock.mockResolvedValue([currentEvent, olderEvent]);
    getSnapshotMock.mockImplementation(async (eventId) => snapshotForEvent(eventId === olderEvent.id ? olderEvent : currentEvent));
    submitReportMock.mockReturnValueOnce(new Promise((resolve) => { finishSubmission = resolve; }));
    window.history.replaceState(null, "", "/report?event=event-demo");
    try {
      const user = userEvent.setup();
      render(<SnapshotProvider><ReportEventHarness /></SnapshotProvider>);
      const description = await screen.findByRole("textbox", { name: "Report description" });
      await waitFor(() => expect(description).toBeEnabled());
      await user.type(description, "Current event report awaiting confirmation.");
      await user.click(screen.getByRole("button", { name: "Open older event" }));
      await waitFor(() => expect(screen.getByText("Earlier exercise", { selector: "strong" })).toBeInTheDocument());
      await waitFor(() => expect(description).toHaveValue(""));
      await user.type(description, "Keep this separate older event draft.");
      await user.click(screen.getByRole("button", { name: "Open current event" }));
      await waitFor(() => expect(description).toHaveValue("Current event report awaiting confirmation."));

      await user.click(screen.getByRole("button", { name: "Submit report" }));
      await waitFor(() => expect(submitReportMock).toHaveBeenCalledOnce());
      await user.click(screen.getByRole("button", { name: "Open older event" }));
      await waitFor(() => expect(description).toHaveValue("Keep this separate older event draft."));
      await act(async () => finishSubmission(receipt()));

      expect(description).toHaveValue("Keep this separate older event draft.");
      expect(loadReportDraft(eventFixture.id, "unused", storage).receipt?.report.id).toBe("report-new");
      expect(loadReportDraft("event-older", "unused", storage).text).toBe("Keep this separate older event draft.");
    } finally {
      restoreStorage();
    }
  });

  it("shows a duplicate receipt without losing the original report", async () => {
    submitReportMock.mockResolvedValueOnce(receipt({
      duplicate: true,
      report: makeReport({ id: "report-original", text: "Original wording is retained." }),
    }));
    const { user, description } = await openLoadedForm();
    await user.type(description, "Original wording is retained.");
    await user.click(screen.getByRole("button", { name: "Submit report" }));

    const receiptRegion = await screen.findByRole("status", { name: "Submission receipt" });
    expect(receiptRegion).toHaveTextContent("Existing report receipt");
    expect(receiptRegion).toHaveTextContent("Duplicate retry");
    expect(receiptRegion.querySelector('[title="report-original"]')).toBeInTheDocument();
    expect(receiptRegion).toHaveTextContent("Original wording is retained.");
  });

  it("links to the received incident and copies the full report and incident IDs", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
    const copiedIds: string[] = [];
    const writeText = async (id: string) => { copiedIds.push(id); };
    window.history.replaceState(null, "", "/report?queue=review&event=previous-event");
    submitReportMock.mockResolvedValueOnce(receipt());
    try {
      const { user, description } = await openLoadedForm();
      await user.type(description, "A visitor has a minor injury.");
      await user.click(screen.getByRole("button", { name: "Submit report" }));
      const receiptRegion = await screen.findByRole("status", { name: "Submission receipt" });
      Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
      expect(receiptRegion.querySelector("a")).toHaveAttribute(
        "href",
        "/dashboard?queue=review&event=event-demo&incident=incident-new",
      );

      const copyButtons = within(receiptRegion).getAllByRole("button", { name: "Copy full ID" });
      await user.click(copyButtons[0]!);
      expect(await within(receiptRegion).findByText("Full report id copied.")).toBeInTheDocument();
      await user.click(copyButtons[1]!);
      expect(await within(receiptRegion).findByText("Full incident id copied.")).toBeInTheDocument();
      expect(copiedIds).toEqual(["report-new", "incident-new"]);
    } finally {
      if (originalClipboard) Object.defineProperty(window.navigator, "clipboard", originalClipboard);
      else Reflect.deleteProperty(window.navigator, "clipboard");
    }
  });

  const rejectedWriteText = async () => { throw new Error("permission denied"); };
  const copyFailureCases: Array<[string, (() => Promise<void>) | undefined, string]> = [
    ["unsupported", undefined, "Clipboard access is unavailable in this browser."],
    ["denied", rejectedWriteText, "The ID could not be copied. Select it to copy manually."],
  ];

  it.each(copyFailureCases)("explains when copying an ID is %s", async (_label, writeText, message) => {
    const originalClipboard = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
    submitReportMock.mockResolvedValueOnce(receipt());
    try {
      const { user, description } = await openLoadedForm();
      await user.type(description, "A visitor has a minor injury.");
      await user.click(screen.getByRole("button", { name: "Submit report" }));
      const receiptRegion = await screen.findByRole("status", { name: "Submission receipt" });
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: writeText ? { writeText } : undefined,
      });
      await user.click(within(receiptRegion).getAllByRole("button", { name: "Copy full ID" })[0]!);
      expect(await within(receiptRegion).findByText(message)).toBeInTheDocument();
    } finally {
      if (originalClipboard) Object.defineProperty(window.navigator, "clipboard", originalClipboard);
      else Reflect.deleteProperty(window.navigator, "clipboard");
    }
  });

  it("prevents a second submission while the first request is still pending", async () => {
    let resolveSubmission!: (value: ReportReceipt) => void;
    submitReportMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSubmission = resolve;
      }),
    );
    const { user, description } = await openLoadedForm();
    await user.type(description, "Two taps should record one report.");
    const form = screen.getByRole("button", { name: "Submit report" }).closest("form");
    expect(form).not.toBeNull();

    act(() => {
      fireEvent.submit(form as HTMLFormElement);
      fireEvent.submit(form as HTMLFormElement);
    });

    expect(submitReportMock).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    expect(description).toBeDisabled();

    await act(async () => resolveSubmission(receipt()));
    await screen.findByRole("status", { name: "Submission receipt" });
  });

  it("surfaces load errors and retries event loading", async () => {
    getSnapshotMock
      .mockRejectedValueOnce(new ApiError("Exercise unavailable.", 503, "service_unavailable"))
      .mockResolvedValueOnce(snapshotFixture);
    render(<ReportPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Exercise unavailable.");
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("textbox", { name: "Report description" })).toBeEnabled();
    expect(getSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("aborts and ignores an event load that finishes after unmount", async () => {
    let finishLoad!: (value: typeof snapshotFixture) => void;
    let loadSignal: AbortSignal | undefined;
    getSnapshotMock.mockImplementationOnce((_eventId, signal) => {
      loadSignal = signal;
      return new Promise((resolve) => {
        finishLoad = resolve as (value: typeof snapshotFixture) => void;
      });
    });
    const view = render(<ReportPage />);
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledOnce());

    view.unmount();
    expect(loadSignal?.aborted).toBe(true);
    await act(async () => finishLoad(snapshotFixture));
  });

  it("ignores a submit event before the current event and draft have loaded", async () => {
    let finishLoad!: (value: typeof snapshotFixture) => void;
    getSnapshotMock.mockImplementationOnce(() => new Promise((resolve) => {
      finishLoad = resolve as (value: typeof snapshotFixture) => void;
    }));
    render(<ReportPage />);
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledOnce());
    const form = screen.getByRole("button", { name: "Submit report" }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    expect(submitReportMock).not.toHaveBeenCalled();

    await act(async () => finishLoad(snapshotFixture));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Report description" })).toBeEnabled());
  });

  it("uses a safe fallback for an unstructured current-event load failure", async () => {
    getSnapshotMock.mockRejectedValueOnce(new Error("connection reset"));
    render(<ReportPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The current exercise could not be loaded. Check the backend and retry.",
    );
  });

  it("ignores a failed event load after unmount", async () => {
    let failLoad!: (error: unknown) => void;
    getSnapshotMock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      failLoad = reject;
    }));
    const view = render(<ReportPage />);
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledOnce());

    view.unmount();
    await act(async () => failLoad(new Error("Late fetch failure")));
  });

  it("uses a secondary priority badge for a P2 receipt", async () => {
    submitReportMock.mockResolvedValueOnce(receipt({
      incident: makeIncident({
        id: "incident-standard",
        priority: "P2",
        suggested_priority: "P2",
        report_ids: ["report-new"],
      }),
    }));
    const { user, description } = await openLoadedForm();
    await user.type(description, "A small obstruction is reported.");
    await user.click(screen.getByRole("button", { name: "Submit report" }));

    const receiptRegion = await screen.findByRole("status", { name: "Submission receipt" });
    expect(receiptRegion).toHaveTextContent("P2 · pending analysis");
  });

  it("uses the destructive priority badge for a P0 receipt", async () => {
    submitReportMock.mockResolvedValueOnce(receipt({
      incident: makeIncident({
        id: "incident-urgent",
        priority: "P0",
        suggested_priority: "P0",
        report_ids: ["report-new"],
      }),
    }));
    const { user, description } = await openLoadedForm();
    await user.type(description, "A person is unresponsive at the stage.");
    await user.click(screen.getByRole("button", { name: "Submit report" }));

    const receiptRegion = await screen.findByRole("status", { name: "Submission receipt" });
    expect(receiptRegion).toHaveTextContent("P0 · pending analysis");
    expect(receiptRegion.querySelector('[data-slot="badge"]')).toHaveClass("cn-badge-variant-destructive");
  });

  it("ignores a successful report submission that finishes after unmount", async () => {
    let finishSubmit!: (value: ReportReceipt) => void;
    submitReportMock.mockImplementationOnce(() => new Promise((resolve) => {
      finishSubmit = resolve;
    }));
    const { user, description, unmount } = await openLoadedForm();
    await user.type(description, "The reporter can safely leave this page.");
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    await waitFor(() => expect(submitReportMock).toHaveBeenCalledOnce());

    unmount();
    await act(async () => finishSubmit(receipt()));
  });

  it("does not surface a rejected report request after unmount", async () => {
    let failSubmit!: (error: unknown) => void;
    submitReportMock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      failSubmit = reject;
    }));
    const { user, description, unmount } = await openLoadedForm();
    await user.type(description, "A transient request is still running.");
    await user.click(screen.getByRole("button", { name: "Submit report" }));
    await waitFor(() => expect(submitReportMock).toHaveBeenCalledOnce());

    unmount();
    await act(async () => failSubmit(new Error("late failure")));
  });

  it.each([
    ["a backend validation error", new ApiError("Report text is too short.", 422, "validation_error"), "Report text is too short."],
    ["a network error", new Error("fetch failed"), "The Aegis backend could not be reached. Your report is still here; you can safely retry."],
    ["an aborted submission", new DOMException("Aborted", "AbortError"), "The report could not be submitted. Your report is still here; you can safely retry."],
    ["an unknown error", "offline", "The report could not be submitted. Your report is still here; you can safely retry."],
  ])("preserves the draft and explains %s", async (_label, failure, message) => {
    submitReportMock.mockRejectedValueOnce(failure);
    const { user, description } = await openLoadedForm();
    await user.type(description, "A report with an error stays in the form.");
    await user.click(screen.getByRole("button", { name: "Submit report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(description).toHaveValue("A report with an error stays in the form.");
    expect(screen.getByRole("button", { name: "Submit report" })).toBeEnabled();
  });
});

describe("datetimeLocalToIso", () => {
  it("converts event-local wall time to UTC with milliseconds", () => {
    expect(datetimeLocalToIso("2026-10-24T10:15", "America/Los_Angeles")).toBe(
      "2026-10-24T17:15:00.000Z",
    );
    expect(datetimeLocalToIso("2026-10-24T10:15:31.4", "UTC")).toBe(
      "2026-10-24T10:15:31.400Z",
    );
    expect(datetimeLocalToIso("2026-03-07T02:30", "America/Los_Angeles")).toBe(
      "2026-03-07T10:30:00.000Z",
    );
  });

  it.each([
    ["a malformed value", "tomorrow at ten", "UTC"],
    ["a month outside the calendar", "2026-13-01T10:00", "UTC"],
    ["an impossible calendar date", "2026-02-30T10:00", "UTC"],
    ["an invalid timezone", "2026-10-24T10:00", "Not/A_Zone"],
    ["a daylight-saving gap", "2026-03-08T02:30", "America/Los_Angeles"],
    ["a daylight-saving repeated time", "2026-11-01T01:30", "America/Los_Angeles"],
  ])("returns null for %s", (_label, value, zone) => {
    expect(datetimeLocalToIso(value, zone)).toBeNull();
  });

  it("returns null when timezone formatting omits a required calendar field", () => {
    const formatterSpy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockReturnValue([]);

    expect(datetimeLocalToIso("2026-10-24T10:15", "UTC")).toBeNull();
    formatterSpy.mockRestore();
  });

  it("continues through unavailable nearby timezone projections", () => {
    const originalFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;
    let calls = 0;
    const formatterSpy = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    formatterSpy.mockImplementation(function (this: Intl.DateTimeFormat, date?: Date | number) {
      calls += 1;
      return calls <= 2 ? originalFormatToParts.call(this, date) : [];
    });

    expect(datetimeLocalToIso("2026-10-24T10:15", "UTC")).toBe("2026-10-24T10:15:00.000Z");
    expect(calls).toBeGreaterThan(2);
    formatterSpy.mockRestore();
  });
});
