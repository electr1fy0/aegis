// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getSnapshot, submitReport } from "../lib/api";
import { datetimeLocalToIso, ReportPage } from "../pages/report-page";
import type { ReportReceipt } from "../lib/types";
import { makeIncident, makeReport, snapshotFixture } from "./fixtures";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    getSnapshot: vi.fn(),
    submitReport: vi.fn(),
  };
});

const getSnapshotMock = vi.mocked(getSnapshot);
const submitReportMock = vi.mocked(submitReport);

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
  getSnapshotMock.mockReset();
  submitReportMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ReportPage", () => {
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
    fireEvent.change(screen.getByLabelText("Event time (optional)"), {
      target: { value: "2026-10-24T10:15" },
    });
    await user.click(screen.getByRole("button", { name: "Submit report" }));

    const receiptRegion = await screen.findByRole("status", { name: "Submission receipt" });
    expect(submitReportMock).toHaveBeenCalledOnce();
    expect(submitReportMock).toHaveBeenCalledWith(input);
    expect(screen.getByText("report-new")).toBeInTheDocument();
    expect(screen.getByText("incident-new")).toBeInTheDocument();
    expect(receiptRegion).toHaveTextContent("P1 · pending analysis");
    expect(receiptRegion.querySelector("blockquote")?.textContent).toBe(input.text);
    expect(description).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Zone" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Sublocation" })).toHaveValue("");
    expect(screen.getByLabelText("Event time (optional)")).toHaveValue("");
  });

  it("omits unknown optional location fields and preserves them blank on a pending receipt", async () => {
    submitReportMock.mockResolvedValueOnce(receipt({ duplicate: false }));
    const { user, description } = await openLoadedForm();
    await user.type(description, "A barrier is down near Exit A.");
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
    fireEvent.change(screen.getByLabelText("Event time (optional)"), {
      target: { value: "2026-03-08T02:30" },
    });
    await user.click(screen.getByRole("button", { name: "Submit report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a valid, unambiguous local time in America/Los_Angeles.",
    );
    expect(screen.getByLabelText("Event time (optional)")).toHaveAttribute("aria-invalid", "true");
    expect(submitReportMock).not.toHaveBeenCalled();
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
    expect(receiptRegion).toHaveTextContent("report-original");
    expect(receiptRegion).toHaveTextContent("Original wording is retained.");
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
