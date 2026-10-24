// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  ApiError,
  getSnapshot,
  reviewConflict,
  updatePriority,
  updateStatus,
} from "../lib/api";
import type { Snapshot } from "../lib/types";
import { DashboardPage } from "../pages/dashboard-page";
import {
  conflictFixture,
  eventFixture,
  incidentFixture,
  makeIncident,
  makeReport,
  makeSnapshot,
  matchingReportFixture,
  reportFixture,
} from "./fixtures";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    getSnapshot: vi.fn(),
    reviewConflict: vi.fn(),
    updatePriority: vi.fn(),
    updateStatus: vi.fn(),
  };
});

const getSnapshotMock = vi.mocked(getSnapshot);
const reviewConflictMock = vi.mocked(reviewConflict);
const updatePriorityMock = vi.mocked(updatePriority);
const updateStatusMock = vi.mocked(updateStatus);

function actionSnapshot(
  sourceVersion = 1,
  targetVersion = 2,
  conflictStatus: "unresolved" | "resolved" = "unresolved",
): Snapshot {
  const reports = [
    makeReport({ ...reportFixture, id: "report-101", event_id: eventFixture.id, incident_id: "incident-001" }),
    makeReport({ ...matchingReportFixture, id: "report-102", event_id: eventFixture.id, incident_id: "incident-001" }),
    makeReport({
      ...reportFixture,
      id: "report-201",
      event_id: eventFixture.id,
      text: "The barrier has fallen across Exit A.",
      zone_id: "exit-a",
      incident_id: "incident-002",
    }),
    makeReport({
      ...reportFixture,
      id: "report-202",
      event_id: eventFixture.id,
      text: "Exit A is open now.",
      zone_id: "exit-a",
      incident_id: "incident-002",
    }),
  ];
  const primary = makeIncident({
    ...incidentFixture,
    id: "incident-001",
    event_id: eventFixture.id,
    report_ids: ["report-101", "report-102"],
    conflicts: [],
    version: sourceVersion,
  });
  const target = makeIncident({
    ...incidentFixture,
    id: "incident-002",
    event_id: eventFixture.id,
    title: "Exit A barrier reports conflict",
    zone_id: "exit-a",
    priority: "P1",
    suggested_priority: "P1",
    review_required: true,
    review_reasons: ["Conflicting updates need review."],
    report_ids: ["report-201", "report-202"],
    evidence: [],
    conflicts: [{ ...conflictFixture, status: conflictStatus, report_ids: ["report-201", "report-202"] }],
    version: targetVersion,
  });
  return makeSnapshot({
    event: eventFixture,
    incidents: [primary, target],
    reports,
    counts: { reports: reports.length, incidents: 2, review: 1, conflicts: conflictStatus === "unresolved" ? 1 : 0 },
  });
}

let intervalSpy: MockInstance<typeof window.setInterval>;

function snapshotPollingCallback(): TimerHandler | undefined {
  return intervalSpy.mock.calls.find((call) => call[1] === 1_000)?.[0];
}

async function renderDashboard(snapshot = actionSnapshot()) {
  getSnapshotMock.mockResolvedValueOnce(snapshot);
  const user = userEvent.setup();
  const view = render(<DashboardPage />);
  await screen.findByRole("heading", { name: "Incident queue" });
  await screen.findByRole("heading", { name: "Guest collapsed near Main Stage" });
  return { ...view, user };
}

async function selectIncident(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: new RegExp(title) }));
  await screen.findByRole("heading", { name: title });
}

function reasonFieldInForm(submitButtonName: string) {
  const button = screen.getByRole("button", { name: submitButtonName });
  const form = button.closest("form");
  if (!form) throw new Error(`${submitButtonName} must be inside its action form`);
  return within(form).getByRole("textbox");
}

async function pollNextSnapshot() {
  const callback = snapshotPollingCallback();
  expect(typeof callback).toBe("function");
  await act(async () => {
    if (typeof callback === "function") callback();
    await Promise.resolve();
  });
}

beforeEach(() => {
  getSnapshotMock.mockReset();
  reviewConflictMock.mockReset();
  updatePriorityMock.mockReset();
  updateStatusMock.mockReset();
  intervalSpy = vi.spyOn(window, "setInterval").mockImplementation(
    () => 1 as unknown as ReturnType<typeof window.setInterval>,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("dashboard priority and status actions", () => {
  it("requires a meaningful reason and saves an audited priority override", async () => {
    const { user } = await renderDashboard();
    await user.click(screen.getByRole("button", { name: "Override priority" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Coordinator priority override" }), "P1");
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "no");
    await user.click(screen.getByRole("button", { name: "Save priority" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("at least 3 characters");
    expect(updatePriorityMock).not.toHaveBeenCalled();

    await user.clear(screen.getByRole("textbox", { name: "Reason" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "  Supervisor verified the lower risk.  ");
    const next = actionSnapshot(2, 2);
    next.incidents[0] = { ...next.incidents[0]!, priority: "P1", override_reason: "Supervisor verified the lower risk." };
    updatePriorityMock.mockResolvedValueOnce(next);
    await user.click(screen.getByRole("button", { name: "Save priority" }));

    await waitFor(() => expect(updatePriorityMock).toHaveBeenCalledOnce());
    expect(updatePriorityMock).toHaveBeenCalledWith("incident-001", {
      priority: "P1",
      reason: "Supervisor verified the lower risk.",
      expected_version: 1,
    });
    expect(await screen.findByText("Priority override saved with its reason.")).toBeInTheDocument();
    expect(await screen.findByText("Coordinator override: Supervisor verified the lower risk.")).toBeInTheDocument();
  });

  it("keeps a priority reason on server error and offers the polled version after 409", async () => {
    const initial = actionSnapshot(1, 2);
    const polled = actionSnapshot(8, 9);
    getSnapshotMock.mockResolvedValueOnce(initial).mockResolvedValueOnce(polled);
    updatePriorityMock
      .mockRejectedValueOnce(new ApiError("Stale version.", 409, "stale_version"))
      .mockRejectedValueOnce(new Error("Priority service unavailable."));
    const user = userEvent.setup();
    render(<DashboardPage />);
    await screen.findByRole("heading", { name: "Guest collapsed near Main Stage" });
    await user.click(screen.getByRole("button", { name: "Override priority" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Coordinator priority override" }), "P2");
    const reason = screen.getByRole("textbox", { name: "Reason" });
    await user.type(reason, "Reviewed with the operations lead.");
    await user.click(screen.getByRole("button", { name: "Save priority" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("older incident version");
    expect(reason).toHaveValue("Reviewed with the operations lead.");
    expect(screen.getByRole("button", { name: "Use latest version and keep reason" })).toBeDisabled();
    await pollNextSnapshot();
    await screen.findByText("v8");
    await user.click(screen.getByRole("button", { name: "Use latest version and keep reason" }));
    expect(reason).toHaveValue("Reviewed with the operations lead.");
    expect(screen.queryByRole("status", { name: /newer snapshot/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save priority" }));
    await waitFor(() => expect(updatePriorityMock).toHaveBeenCalledTimes(2));
    expect(updatePriorityMock.mock.calls.map(([id, input]) => [id, input.expected_version])).toEqual([
      ["incident-001", 1],
      ["incident-001", 8],
    ]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Priority service unavailable.");
    expect(reason).toHaveValue("Reviewed with the operations lead.");
  });

  it("saves status changes and shows server errors without losing the reason", async () => {
    const { user } = await renderDashboard();
    await user.click(screen.getByRole("button", { name: "Change status" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Workflow status" }), "acknowledged");
    const reason = screen.getByRole("textbox", { name: "Reason" });
    await user.type(reason, "no");
    await user.click(screen.getByRole("button", { name: "Save status" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("at least 3 characters");
    expect(updateStatusMock).not.toHaveBeenCalled();
    await user.clear(reason);
    await user.type(reason, "Coordinator accepted the report.");
    const next = actionSnapshot(2, 2);
    next.incidents[0] = { ...next.incidents[0]!, status: "acknowledged" };
    updateStatusMock.mockResolvedValueOnce(next);
    await user.click(screen.getByRole("button", { name: "Save status" }));

    await waitFor(() => expect(updateStatusMock).toHaveBeenCalledOnce());
    expect(updateStatusMock).toHaveBeenCalledWith("incident-001", {
      status: "acknowledged",
      reason: "Coordinator accepted the report.",
      expected_version: 1,
    });
    expect(await screen.findByText("Status changed to Acknowledged.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Change status" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Workflow status" }), "monitoring");
    const failedReason = screen.getByRole("textbox", { name: "Reason" });
    await user.type(failedReason, "Monitor until facilities confirms.");
    updateStatusMock.mockRejectedValueOnce(new Error("Status service unavailable."));
    await user.click(screen.getByRole("button", { name: "Save status" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Status service unavailable.");
    expect(failedReason).toHaveValue("Monitor until facilities confirms.");

    updateStatusMock.mockRejectedValueOnce({ code: "unknown_failure" });
    await user.click(screen.getByRole("button", { name: "Save status" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The coordinator action could not be saved.");
    expect(failedReason).toHaveValue("Monitor until facilities confirms.");
  });

  it("rebases a status retry onto the newer polled version while preserving the reason", async () => {
    getSnapshotMock.mockResolvedValueOnce(actionSnapshot(1, 2)).mockResolvedValueOnce(actionSnapshot(7, 9));
    updateStatusMock
      .mockRejectedValueOnce(new ApiError("Stale status version.", 409, "stale_version"))
      .mockResolvedValueOnce(actionSnapshot(8, 9));
    const user = userEvent.setup();
    render(<DashboardPage />);
    await screen.findByRole("heading", { name: "Guest collapsed near Main Stage" });
    await user.click(screen.getByRole("button", { name: "Change status" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Workflow status" }), "monitoring");
    const reason = screen.getByRole("textbox", { name: "Reason" });
    await user.type(reason, "Keep watch until exit is checked.");
    await pollNextSnapshot();
    await screen.findByText("v7");
    await user.click(screen.getByRole("button", { name: "Save status" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("older incident version");
    expect(reason).toHaveValue("Keep watch until exit is checked.");
    await user.click(screen.getByRole("button", { name: "Use latest version and keep reason" }));
    await user.click(screen.getByRole("button", { name: "Save status" }));

    await waitFor(() => expect(updateStatusMock).toHaveBeenCalledTimes(2));
    expect(updateStatusMock.mock.calls.map(([, input]) => input.expected_version)).toEqual([1, 7]);
  });

  it("clears priority and status drafts when the selected incident changes", async () => {
    const { user } = await renderDashboard();
    await user.click(screen.getByRole("button", { name: "Override priority" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Unsaved priority rationale.");
    await selectIncident(user, "Exit A barrier reports conflict");
    expect(screen.queryByRole("button", { name: "Save priority" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Override priority" }));
    expect(screen.getByRole("textbox", { name: "Reason" })).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "Change status" }));
    await user.type(reasonFieldInForm("Save status"), "Unsaved status rationale.");
    await selectIncident(user, "Guest collapsed near Main Stage");
    expect(screen.queryByRole("button", { name: "Save status" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change status" }));
    expect(reasonFieldInForm("Save status")).toHaveValue("");
  });
});

describe("conflict review actions", () => {
  it("resolves and reopens a conflict with an audited reason", async () => {
    const { user } = await renderDashboard();
    await selectIncident(user, "Exit A barrier reports conflict");
    await user.click(screen.getByRole("button", { name: "Resolve conflict" }));
    await user.type(screen.getByRole("textbox", { name: "Reason for resolution" }), "Facilities checked the exit.");
    const resolved = actionSnapshot(1, 3, "resolved");
    reviewConflictMock.mockResolvedValueOnce(resolved);
    await user.click(screen.getByRole("button", { name: "Save conflict review" }));

    await waitFor(() => expect(reviewConflictMock).toHaveBeenCalledOnce());
    expect(reviewConflictMock).toHaveBeenLastCalledWith("conflict-001", {
      status: "resolved",
      reason: "Facilities checked the exit.",
      expected_version: 2,
    });
    expect(await screen.findByRole("button", { name: "Reopen conflict review" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reopen conflict review" }));
    const reopenReason = screen.getByRole("textbox", { name: "Reason for reopening" });
    expect(reopenReason).toHaveValue("");
    await user.type(reopenReason, "A new report requires another check.");
    const reopened = actionSnapshot(1, 4, "unresolved");
    reviewConflictMock.mockResolvedValueOnce(reopened);
    await user.click(screen.getByRole("button", { name: "Save conflict review" }));

    await waitFor(() => expect(reviewConflictMock).toHaveBeenCalledTimes(2));
    expect(reviewConflictMock).toHaveBeenLastCalledWith("conflict-001", {
      status: "unresolved",
      reason: "A new report requires another check.",
      expected_version: 3,
    });
    expect(await screen.findByRole("button", { name: "Resolve conflict" })).toBeInTheDocument();
  });

  it("requires a reason and rebases a stale conflict review onto the newer version", async () => {
    getSnapshotMock.mockResolvedValueOnce(actionSnapshot(1, 2)).mockResolvedValueOnce(actionSnapshot(8, 9));
    reviewConflictMock
      .mockRejectedValueOnce(new ApiError("Stale conflict version.", 409, "stale_version"))
      .mockResolvedValueOnce(actionSnapshot(8, 10, "resolved"));
    const user = userEvent.setup();
    render(<DashboardPage />);
    await screen.findByRole("heading", { name: "Guest collapsed near Main Stage" });
    await selectIncident(user, "Exit A barrier reports conflict");
    await user.click(screen.getByRole("button", { name: "Resolve conflict" }));
    await user.type(screen.getByRole("textbox", { name: "Reason for resolution" }), "ok");
    await user.click(screen.getByRole("button", { name: "Save conflict review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("at least 3 characters");
    expect(reviewConflictMock).not.toHaveBeenCalled();

    const reason = screen.getByRole("textbox", { name: "Reason for resolution" });
    await user.clear(reason);
    await user.type(reason, "Facilities verified the updated exit status.");
    await pollNextSnapshot();
    await screen.findByText("v9");
    await user.click(screen.getByRole("button", { name: "Save conflict review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("older incident version");
    expect(reason).toHaveValue("Facilities verified the updated exit status.");
    await user.click(screen.getByRole("button", { name: "Use latest version and keep reason" }));
    await user.click(screen.getByRole("button", { name: "Save conflict review" }));

    await waitFor(() => expect(reviewConflictMock).toHaveBeenCalledTimes(2));
    expect(reviewConflictMock.mock.calls.map(([, input]) => input.expected_version)).toEqual([2, 9]);
    expect(reviewConflictMock).toHaveBeenLastCalledWith("conflict-001", {
      status: "resolved",
      reason: "Facilities verified the updated exit status.",
      expected_version: 9,
    });
  });
});
