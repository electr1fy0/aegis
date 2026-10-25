// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  addIncidentNote,
  advanceReplay,
  ApiError,
  getSnapshot,
  resetPriority,
  reviewConflict,
  reviewGrouping,
  startReplay,
  updateIncidentTitle,
  updatePriority,
  updateStatus,
  undoDecision,
} from "../lib/api";
import type { Snapshot } from "../lib/types";
import { formattedTime } from "../lib/format";
import {
  createGroupingReviewInput,
  DashboardPage,
  GroupingReviewForm,
} from "../pages/dashboard-page";
import {
  auditFixture,
  conflictFixture,
  evidenceFixture,
  eventFixture,
  makeIncident,
  makeReport,
  makeSnapshot,
  reportFixture,
  snapshotFixture,
  zonesFixture,
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
    addIncidentNote: vi.fn(),
    advanceReplay: vi.fn(),
    getSnapshot: vi.fn(),
    resetPriority: vi.fn(),
    reviewConflict: vi.fn(),
    reviewGrouping: vi.fn(),
    startReplay: vi.fn(),
    updateIncidentTitle: vi.fn(),
    updatePriority: vi.fn(),
    updateStatus: vi.fn(),
    undoDecision: vi.fn(),
  };
});

const addIncidentNoteMock = vi.mocked(addIncidentNote);
const getSnapshotMock = vi.mocked(getSnapshot);
const resetPriorityMock = vi.mocked(resetPriority);
const reviewGroupingMock = vi.mocked(reviewGrouping);
const updatePriorityMock = vi.mocked(updatePriority);
const updateStatusMock = vi.mocked(updateStatus);
const updateIncidentTitleMock = vi.mocked(updateIncidentTitle);
const undoDecisionMock = vi.mocked(undoDecision);
const reviewConflictMock = vi.mocked(reviewConflict);
const startReplayMock = vi.mocked(startReplay);
const advanceReplayMock = vi.mocked(advanceReplay);

const reportOne = makeReport({
  id: "report-101",
  event_id: eventFixture.id,
  text: "A guest collapsed near the Main Stage.",
  zone_id: "stage",
  incident_id: "incident-001",
});
const reportTwo = makeReport({
  ...reportFixture,
  id: "report-102",
  event_id: eventFixture.id,
  text: "Someone needs help by the stage.",
  zone_id: "stage",
  incident_id: "incident-001",
});
const reportThree = makeReport({
  ...reportFixture,
  id: "report-201",
  event_id: eventFixture.id,
  text: "The barrier has fallen across Exit A.",
  zone_id: "exit-a",
  incident_id: "incident-002",
});
const reportFour = makeReport({
  ...reportFixture,
  id: "report-202",
  event_id: eventFixture.id,
  text: "Exit A is open now.",
  zone_id: "exit-a",
  incident_id: "incident-002",
});
const reportFive = makeReport({
  ...reportFixture,
  id: "report-301",
  event_id: eventFixture.id,
  text: "I can hear an alarm but do not know where it is.",
  zone_id: null,
  incident_id: "incident-003",
});

function boardSnapshot(sourceVersion = 1, targetVersion = 2): Snapshot {
  const source = makeIncident({
    id: "incident-001",
    event_id: eventFixture.id,
    title: "Guest collapsed near Main Stage",
    zone_id: "stage",
    priority: "P0",
    suggested_priority: "P0",
    status: "open",
    report_ids: [reportOne.id, reportTwo.id],
    evidence: [evidenceFixture],
    conflicts: [],
    version: sourceVersion,
    created_at: "2026-10-24T16:02:04Z",
  });
  const target = makeIncident({
    id: "incident-002",
    event_id: eventFixture.id,
    title: "Exit A barrier reports conflict",
    zone_id: "exit-a",
    priority: "P1",
    suggested_priority: "P1",
    review_required: true,
    review_reasons: ["Conflicting updates need review."],
    report_ids: [reportThree.id, reportFour.id],
    evidence: [],
    conflicts: [{ ...conflictFixture, status: "unresolved" as const, report_ids: [reportThree.id, reportFour.id] }],
    version: targetVersion,
    created_at: "2026-10-24T16:01:04Z",
  });
  const unlocated = makeIncident({
    id: "incident-003",
    event_id: eventFixture.id,
    title: "Unlocated alarm report",
    zone_id: null,
    priority: "UNASSESSED",
    suggested_priority: "UNASSESSED",
    review_required: true,
    review_reasons: ["The location is unknown."],
    report_ids: [reportFive.id],
    evidence: [],
    conflicts: [],
    version: 1,
    created_at: "2026-10-24T16:03:04Z",
  });
  const resolved = makeIncident({
    id: "incident-004",
    event_id: eventFixture.id,
    title: "Previously resolved facility issue",
    zone_id: "hall",
    priority: "P2",
    status: "resolved",
    report_ids: [],
    evidence: [],
    conflicts: [],
    version: 4,
  });

  return makeSnapshot({
    event: eventFixture,
    zones: zonesFixture,
    incidents: [source, target, unlocated, resolved],
    reports: [reportOne, reportTwo, reportThree, reportFour, reportFive],
    audit: [
      auditFixture,
      { ...auditFixture, id: "audit-002", seq: 2, entity_id: "incident-001", action: "priority.changed", reason: "Verified lower risk." },
      { ...auditFixture, id: "audit-003", seq: 3, entity_id: reportTwo.id, action: "status.changed", reason: "Coordinator acknowledged." },
      { ...auditFixture, id: "audit-004", seq: 4, entity_id: conflictFixture.id, action: "conflict.reviewed", reason: "Exit inspected." },
    ],
    counts: { reports: 5, incidents: 4, review: 2, conflicts: 1 },
  });
}

let intervalSpy: MockInstance<typeof window.setInterval>;
let heldIntervalId: ReturnType<typeof window.setInterval> = null!;
let dashboardStorage: Map<string, string>;

function snapshotPollingCallback(): TimerHandler | undefined {
  return intervalSpy.mock.calls.find((call) => call[1] === 1_000)?.[0];
}

async function pollNextSnapshot() {
  const callback = snapshotPollingCallback();
  expect(typeof callback).toBe("function");
  await act(async () => {
    if (typeof callback === "function") callback();
    await Promise.resolve();
  });
}

async function renderDashboard(snapshot = boardSnapshot()) {
  getSnapshotMock.mockResolvedValueOnce(snapshot);
  const user = userEvent.setup();
  const view = render(<DashboardPage />);
  await screen.findByRole("heading", { name: "Incident queue" });
  await screen.findByRole("heading", { name: "Guest collapsed near Main Stage" });
  return { ...view, user };
}

beforeEach(() => {
  window.history.replaceState({}, "", "/dashboard");
  dashboardStorage = new Map();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      get length() { return dashboardStorage.size; },
      clear: () => dashboardStorage.clear(),
      getItem: (key: string) => dashboardStorage.get(key) ?? null,
      key: (index: number) => [...dashboardStorage.keys()][index] ?? null,
      removeItem: (key: string) => dashboardStorage.delete(key),
      setItem: (key: string, value: string) => dashboardStorage.set(key, String(value)),
    } satisfies Storage,
  });
  getSnapshotMock.mockReset();
  addIncidentNoteMock.mockReset();
  resetPriorityMock.mockReset();
  reviewGroupingMock.mockReset();
  updatePriorityMock.mockReset();
  updateStatusMock.mockReset();
  reviewConflictMock.mockReset();
  startReplayMock.mockReset();
  advanceReplayMock.mockReset();
  updateIncidentTitleMock.mockReset();
  undoDecisionMock.mockReset();
  intervalSpy = vi.spyOn(window, "setInterval").mockImplementation(() => heldIntervalId);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.clearInterval(heldIntervalId);
});

describe("createGroupingReviewInput", () => {
  const source = makeIncident({ id: "incident-001", version: 3, report_ids: ["report-1", "report-2"] });
  const destination = makeIncident({ id: "incident-002", version: 7 });
  const all = [source, destination];

  it("confirms the selected membership with its target and current version", () => {
    expect(
      createGroupingReviewInput("confirm", source, all, ["report-1"], "", [], "  Evidence checked.  "),
    ).toEqual({
      action: "confirm",
      report_ids: ["report-1"],
      incident_ids: ["incident-001"],
      target_incident_id: "incident-001",
      reason: "Evidence checked.",
      expected_versions: { "incident-001": 3 },
    });
  });

  it("rejects a candidate pairing against the source incident", () => {
    expect(
      createGroupingReviewInput("reject", source, all, ["report-2"], "", [], "Separate account."),
    ).toEqual({
      action: "reject",
      report_ids: ["report-2"],
      target_incident_id: "incident-001",
      reason: "Separate account.",
      expected_versions: { "incident-001": 3 },
    });
  });

  it("moves a report using source and destination versions", () => {
    expect(
      createGroupingReviewInput("move", source, all, ["report-1"], destination.id, [], "Move to the exit."),
    ).toEqual({
      action: "move",
      report_ids: ["report-1"],
      incident_ids: ["incident-001"],
      target_incident_id: "incident-002",
      reason: "Move to the exit.",
      expected_versions: { "incident-001": 3, "incident-002": 7 },
    });
  });

  it("merges selected groups into the chosen identity with every version", () => {
    expect(
      createGroupingReviewInput("merge", source, all, [], destination.id, [source.id, destination.id], "Same event."),
    ).toEqual({
      action: "merge",
      report_ids: [],
      incident_ids: ["incident-001", "incident-002"],
      target_incident_id: "incident-002",
      reason: "Same event.",
      expected_versions: { "incident-001": 3, "incident-002": 7 },
    });
  });

  it("splits selected reports while keeping the source version", () => {
    expect(
      createGroupingReviewInput("split", source, all, ["report-2"], "", [], "Keep separate."),
    ).toEqual({
      action: "split",
      report_ids: ["report-2"],
      incident_ids: ["incident-001"],
      reason: "Keep separate.",
      expected_versions: { "incident-001": 3 },
    });
  });

  it("uses the source version when an affected incident is not in the supplied list", () => {
    expect(createGroupingReviewInput("move", source, [], ["report-1"], "missing", [], "Move after review.")).toMatchObject({
      expected_versions: { "incident-001": 3, missing: 3 },
    });
  });
});

describe("GroupingReviewForm", () => {
  const incident = makeIncident({ id: "incident-001", version: 1, report_ids: ["report-101", "report-102"] });
  const target = makeIncident({ id: "incident-002", version: 2, title: "Exit A barrier reports conflict" });
  const onCancel = vi.fn();
  const onSaved = vi.fn();

  beforeEach(() => {
    onCancel.mockReset();
    onSaved.mockReset();
  });

  it("requires a coordinator reason before sending a confirmation", async () => {
    const user = userEvent.setup();
    render(
      <GroupingReviewForm
        mode="confirm"
        incident={incident}
        incidents={[incident, target]}
        selectedReportIds={[]}
        selectedIncidentIds={[]}
        onCancel={onCancel}
        onSaved={onSaved}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Coordinator reason" }), "no");
    await user.click(screen.getByRole("button", { name: "Save coordinator decision" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("at least 3 characters");
    expect(reviewGroupingMock).not.toHaveBeenCalled();
  });

  it("sends confirm membership and target ID exactly as required by the API", async () => {
    const user = userEvent.setup();
    reviewGroupingMock.mockResolvedValueOnce(snapshotFixture);
    render(
      <GroupingReviewForm
        mode="confirm"
        incident={incident}
        incidents={[incident, target]}
        selectedReportIds={[]}
        selectedIncidentIds={[]}
        onCancel={onCancel}
        onSaved={onSaved}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Coordinator reason" }), "  Reviewed both reports.  ");
    await user.click(screen.getByRole("button", { name: "Save coordinator decision" }));

    await waitFor(() => expect(reviewGroupingMock).toHaveBeenCalledOnce());
    expect(reviewGroupingMock).toHaveBeenCalledWith({
      action: "confirm",
      report_ids: ["report-101", "report-102"],
      incident_ids: ["incident-001"],
      target_incident_id: "incident-001",
      reason: "Reviewed both reports.",
      expected_versions: { "incident-001": 1 },
    });
    expect(onSaved).toHaveBeenCalledWith(snapshotFixture, expect.stringContaining("decision saved"), false);
  });

  it("keeps the version captured when the form opened and preserves the reason on 409", async () => {
    const user = userEvent.setup();
    reviewGroupingMock.mockRejectedValueOnce(new ApiError("Stale row version.", 409, "stale_version"));
    const view = render(
      <GroupingReviewForm
        mode="confirm"
        incident={incident}
        incidents={[incident, target]}
        selectedReportIds={["report-101"]}
        selectedIncidentIds={[]}
        onCancel={onCancel}
        onSaved={onSaved}
      />,
    );
    const reason = screen.getByRole("textbox", { name: "Coordinator reason" });
    await user.type(reason, "Reviewed current evidence.");

    view.rerender(
      <GroupingReviewForm
        mode="confirm"
        incident={{ ...incident, version: 2 }}
        incidents={[{ ...incident, version: 2 }, target]}
        selectedReportIds={["report-101"]}
        selectedIncidentIds={[]}
        onCancel={onCancel}
        onSaved={onSaved}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Save coordinator decision" }));

    await waitFor(() => expect(reviewGroupingMock).toHaveBeenCalledOnce());
    expect(reviewGroupingMock.mock.calls[0]?.[0].expected_versions).toEqual({ "incident-001": 1 });
    expect(await screen.findByRole("alert")).toHaveTextContent("older incident version");
    expect(reason).toHaveValue("Reviewed current evidence.");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("requires two selected groups before a merge can be submitted", async () => {
    const user = userEvent.setup();
    render(
      <GroupingReviewForm
        mode="merge"
        incident={incident}
        incidents={[incident, target]}
        selectedReportIds={[]}
        selectedIncidentIds={[]}
        onCancel={onCancel}
        onSaved={onSaved}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Coordinator reason" }), "Same event.");
    await user.click(screen.getByRole("button", { name: "Save coordinator decision" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Select at least two groups");
    expect(reviewGroupingMock).not.toHaveBeenCalled();
  });

  it("requires a destination for a move", async () => {
    const user = userEvent.setup();
    render(
      <GroupingReviewForm
        mode="move"
        incident={incident}
        incidents={[incident, target]}
        selectedReportIds={["report-101"]}
        selectedIncidentIds={[]}
        onCancel={onCancel}
        onSaved={onSaved}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Coordinator reason" }), "Move to target.");
    fireEvent.change(screen.getByRole("combobox", { name: "Destination group" }), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "Save coordinator decision" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a destination group");
    expect(reviewGroupingMock).not.toHaveBeenCalled();
  });

  it("requires selecting a source report for split actions", async () => {
    const user = userEvent.setup();
    render(
      <GroupingReviewForm
        mode="split"
        incident={incident}
        incidents={[incident, target]}
        selectedReportIds={[]}
        selectedIncidentIds={[]}
        onCancel={onCancel}
        onSaved={onSaved}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Coordinator reason" }), "Keep it separate.");
    await user.click(screen.getByRole("button", { name: "Save coordinator decision" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Select at least one source report");
    expect(reviewGroupingMock).not.toHaveBeenCalled();
  });

  it.each([
    ["reject", "Reject pairing", {
      action: "reject",
      report_ids: ["report-101"],
      target_incident_id: "incident-001",
      reason: "Keep separate.",
      expected_versions: { "incident-001": 1 },
    }],
    ["move", "Move selected", {
      action: "move",
      report_ids: ["report-101"],
      incident_ids: ["incident-001"],
      target_incident_id: "incident-002",
      reason: "Keep separate.",
      expected_versions: { "incident-001": 1, "incident-002": 2 },
    }],
    ["split", "Split selected reports", {
      action: "split",
      report_ids: ["report-101"],
      incident_ids: ["incident-001"],
      reason: "Keep separate.",
      expected_versions: { "incident-001": 1 },
    }],
  ] as const)("submits the %s action with its required report and version data", async (mode, _label, expected) => {
    const user = userEvent.setup();
    reviewGroupingMock.mockResolvedValueOnce(snapshotFixture);
    render(
      <GroupingReviewForm
        mode={mode}
        incident={incident}
        incidents={[incident, target]}
        selectedReportIds={["report-101"]}
        selectedIncidentIds={[]}
        onCancel={onCancel}
        onSaved={onSaved}
      />,
    );

    if (mode === "move") {
      await user.selectOptions(screen.getByRole("combobox", { name: "Destination group" }), target.id);
    }
    await user.type(screen.getByRole("textbox", { name: "Coordinator reason" }), "Keep separate.");
    await user.click(screen.getByRole("button", { name: "Save coordinator decision" }));
    await waitFor(() => expect(reviewGroupingMock).toHaveBeenCalledOnce());
    expect(reviewGroupingMock).toHaveBeenCalledWith(expected);
    expect(onSaved).toHaveBeenCalledWith(snapshotFixture, expect.stringContaining("decision saved"), false);
  });

  it("rebases a stale grouping form only after explicit coordinator action", async () => {
    const user = userEvent.setup();
    reviewGroupingMock
      .mockRejectedValueOnce(new ApiError("Stale grouping version.", 409, "stale_version"))
      .mockResolvedValueOnce(snapshotFixture);
    const view = render(
      <GroupingReviewForm
        mode="confirm"
        incident={incident}
        incidents={[incident, target]}
        selectedReportIds={["report-101"]}
        selectedIncidentIds={[]}
        onCancel={onCancel}
        onSaved={onSaved}
      />,
    );
    const reason = screen.getByRole("textbox", { name: "Coordinator reason" });
    await user.type(reason, "Reviewed refreshed reports.");
    view.rerender(
      <GroupingReviewForm
        mode="confirm"
        incident={{ ...incident, version: 4 }}
        incidents={[{ ...incident, version: 4 }, target]}
        selectedReportIds={["report-101"]}
        selectedIncidentIds={[]}
        onCancel={onCancel}
        onSaved={onSaved}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Save coordinator decision" }));
    expect(await screen.findByRole("button", { name: "Use latest version and keep reason" })).toBeEnabled();
    expect(reason).toHaveValue("Reviewed refreshed reports.");
    expect(reviewGroupingMock.mock.calls[0]?.[0].expected_versions).toEqual({ "incident-001": 1 });

    await user.click(screen.getByRole("button", { name: "Use latest version and keep reason" }));
    await user.click(screen.getByRole("button", { name: "Save coordinator decision" }));
    await waitFor(() => expect(reviewGroupingMock).toHaveBeenCalledTimes(2));
    expect(reviewGroupingMock.mock.calls[1]?.[0].expected_versions).toEqual({ "incident-001": 4 });
    expect(onSaved).toHaveBeenCalledWith(snapshotFixture, expect.stringContaining("decision saved"), false);
  });

  it("falls back to the source version when a stale selected group is missing", async () => {
    const user = userEvent.setup();
    reviewGroupingMock.mockResolvedValueOnce(snapshotFixture);
    render(
      <GroupingReviewForm
        mode="merge"
        incident={incident}
        incidents={[incident, target]}
        selectedReportIds={[]}
        selectedIncidentIds={[incident.id, "incident-missing"]}
        onCancel={onCancel}
        onSaved={onSaved}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Coordinator reason" }), "Keep both references.");
    await user.click(screen.getByRole("button", { name: "Save coordinator decision" }));
    await waitFor(() => expect(reviewGroupingMock).toHaveBeenCalledOnce());
    expect(reviewGroupingMock.mock.calls[0]?.[0].expected_versions).toEqual({
      "incident-001": 1,
      "incident-missing": 1,
    });
  });
});

describe("DashboardPage", () => {
  it("shows summary counts, priority-ordered queue, unlocated reports, and evidence", async () => {
    await renderDashboard();

    expect(screen.getByText("Reports received").closest(".summary-card")).toHaveTextContent("5");
    expect(screen.getByText("Provisional groups").closest(".summary-card")).toHaveTextContent("4");
    expect(screen.getByText("Unresolved conflicts").closest(".summary-card")).toHaveTextContent("1");
    expect(screen.getByText(/Ranking signals · not probabilities/)).toBeInTheDocument();
    expect(screen.getByText("Compatible medical reports")).toBeInTheDocument();
    const unlocatedTray = screen.getByText("Unlocated reports").closest(".unlocated-tray");
    expect(unlocatedTray?.lastElementChild).toHaveTextContent("1");

    const queue = screen.getByRole("region", { name: "Incident queue" });
    const visibleTitles = Array.from(queue.querySelectorAll(".incident-row-title")).map((node) => node.childNodes[0]?.textContent);
    expect(visibleTitles.slice(0, 3)).toEqual([
      "Guest collapsed near Main Stage",
      "Exit A barrier reports conflict",
      "Unlocated alarm report",
    ]);
    expect(visibleTitles).not.toContain("Previously resolved facility issue");
    expect(screen.getByText(/Counts follow the current search, priority, status, and zone filters across all queue tabs/)).toBeInTheDocument();
  });

  it("restores a saved dashboard view while preserving the event URL parameter", async () => {
    window.history.replaceState({}, "", `/dashboard?event=${eventFixture.id}`);
    dashboardStorage.set(`aegis.dashboard.view.v1:${eventFixture.id}`, JSON.stringify({
      incidentId: "incident-002",
      criteria: { query: "Exit A", filter: "all", priority: "P1", status: "all", zone: "all", sort: "newest_update" },
      view: "map",
      queueScroll: 0,
    }));
    getSnapshotMock.mockResolvedValueOnce(boardSnapshot());
    render(<DashboardPage />);

    expect(await screen.findByRole("heading", { name: "Incident queue" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search incidents by title, ID, report text, or location" })).toHaveValue("Exit A"));
    expect(screen.getByRole("combobox", { name: "Filter by priority" })).toHaveValue("P1");
    expect(screen.getByRole("combobox", { name: "Sort incidents" })).toHaveValue("newest_update");
    expect(screen.getByRole("button", { name: "Map" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get("event")).toBe(eventFixture.id);
      expect(params.get("q")).toBe("Exit A");
      expect(params.get("priority")).toBe("P1");
      expect(params.get("sort")).toBe("newest_update");
      expect(params.get("view")).toBe("map");
    });
  });

  it("gives explicit dashboard URL filters precedence over a saved view", async () => {
    window.history.replaceState({}, "", `/dashboard?event=${eventFixture.id}&q=Guest&queue=review&sort=oldest_unreviewed`);
    dashboardStorage.set(`aegis.dashboard.view.v1:${eventFixture.id}`, JSON.stringify({
      criteria: { query: "Exit A", filter: "all", priority: "P1", status: "all", zone: "all", sort: "newest_update" },
      view: "map",
    }));
    getSnapshotMock.mockResolvedValueOnce(boardSnapshot());
    render(<DashboardPage />);

    expect(await screen.findByRole("heading", { name: "Incident queue" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search incidents by title, ID, report text, or location" })).toHaveValue("Guest");
    expect(screen.getByRole("button", { name: "Review" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("combobox", { name: "Sort incidents" })).toHaveValue("oldest_unreviewed");
    expect(screen.getByRole("button", { name: "Queue" })).toHaveAttribute("aria-pressed", "true");
    expect(new URLSearchParams(window.location.search).get("event")).toBe(eventFixture.id);
  });

  it("changes the inspector from queue selection and keyboard map selection", async () => {
    const { user } = await renderDashboard();
    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Exit A barrier reports conflict/ }));
    expect(screen.getByRole("heading", { name: "Exit A barrier reports conflict" })).toBeInTheDocument();
    expect(screen.getByText("Conflicting or changing reports")).toBeInTheDocument();
    expect(screen.getByText(/Exit A is blocked/)).toBeInTheDocument();
    expect(screen.getByText(/Exit A is clear now/)).toBeInTheDocument();

    const marker = screen.getByRole("button", {
      name: "Guest collapsed near Main Stage, P0 · Immediate, 2 reports",
    });
    marker.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("heading", { name: "Guest collapsed near Main Stage" })).toBeInTheDocument();

    const exitMarker = screen.getByRole("button", { name: "Exit A barrier reports conflict, P1 · High, 2 reports" });
    await user.click(exitMarker);
    expect(screen.getByRole("heading", { name: "Exit A barrier reports conflict" })).toBeInTheDocument();
    exitMarker.focus();
    await user.keyboard(" ");
    expect(screen.getByRole("heading", { name: "Exit A barrier reports conflict" })).toBeInTheDocument();
    await user.keyboard("x");
    expect(screen.getByRole("heading", { name: "Exit A barrier reports conflict" })).toBeInTheDocument();
  });

  it("closes the inspector drawer on Escape when the keyboard target is not an input", async () => {
    const { container, user } = await renderDashboard();
    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Exit A barrier reports conflict/ }));
    expect(container.querySelector(".workspace-grid")).toHaveClass("is-inspector-open");
    fireEvent.keyDown(container.querySelector(".dashboard-page")!, { key: "Escape" });
    expect(container.querySelector(".workspace-grid")).toHaveClass("is-inspector-closed");
  });

  it("focuses search with slash and ignores modified slash shortcuts", async () => {
    const { container } = await renderDashboard();
    const page = container.querySelector(".dashboard-page")!;
    const search = screen.getByRole("searchbox", { name: "Search incidents by title, ID, report text, or location" });
    fireEvent.keyDown(page, { key: "/" });
    expect(document.activeElement).toBe(search);
    search.blur();
    fireEvent.keyDown(page, { key: "/", ctrlKey: true });
    expect(document.activeElement).not.toBe(search);
  });

  it("shows concise review categories and keeps every review reason available", async () => {
    const snapshot = boardSnapshot();
    snapshot.incidents[0] = {
      ...snapshot.incidents[0]!,
      review_required: true,
      review_reasons: ["Conflicting updates need review.", "Conflicting reports require another check.", "The location is unknown."],
    };
    const { user } = await renderDashboard(snapshot);
    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Guest collapsed near Main Stage/ }));
    expect(screen.getByText("Conflicting accounts · Location needs checking")).toBeInTheDocument();
    const reasonDetails = screen.getByText("Show all review reasons").closest("details")!;
    expect(reasonDetails).not.toHaveAttribute("open");
    await user.click(screen.getByText("Show all review reasons"));
    expect(reasonDetails).toHaveTextContent("Conflicting reports require another check.");
  });

  it("opens a related resolved group by broadening the filters that hid it", async () => {
    const snapshot = boardSnapshot();
    snapshot.incidents[0] = {
      ...snapshot.incidents[0]!,
      evidence: [{ ...evidenceFixture, report_id: reportOne.id, candidate_report_id: reportThree.id, total_score: 0.77, reasons: ["Same exit reports"], missing_fields: [] }],
    };
    snapshot.incidents[1] = { ...snapshot.incidents[1]!, status: "resolved" };
    const { user } = await renderDashboard(snapshot);
    await user.type(screen.getByRole("searchbox", { name: "Search incidents by title, ID, report text, or location" }), "Guest");
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by priority" }), "P0");
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by status" }), "open");
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by zone" }), "stage");
    await user.click(within(document.querySelector(".candidate-card")!).getByRole("button", { name: "Open group" }));

    expect(await screen.findByRole("heading", { name: "Exit A barrier reports conflict" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("searchbox", { name: "Search incidents by title, ID, report text, or location" })).toHaveValue("");
    expect(screen.getByText("Queue filters were broadened to show this related group.")).toBeInTheDocument();
  });

  it("opens a visible related group without changing compatible queue filters", async () => {
    const snapshot = boardSnapshot();
    snapshot.incidents[0] = {
      ...snapshot.incidents[0]!,
      evidence: [{ ...evidenceFixture, report_id: reportOne.id, candidate_report_id: reportThree.id, total_score: 0.77, reasons: ["Same exit reports"], missing_fields: [] }],
    };
    const { user } = await renderDashboard(snapshot);
    await user.click(within(document.querySelector(".candidate-card")!).getByRole("button", { name: "Open group" }));

    expect(await screen.findByRole("heading", { name: "Exit A barrier reports conflict" })).toBeInTheDocument();
    expect(screen.queryByText("Queue filters were broadened to show this related group.")).not.toBeInTheDocument();
  });

  it("toggles source report selection and confirms only that selected report", async () => {
    const { user } = await renderDashboard();
    const reportCheckbox = screen.getByRole("checkbox", { name: "Select report report-101 for a coordinator action" });
    await user.click(reportCheckbox);
    expect(reportCheckbox).toBeChecked();
    await user.click(reportCheckbox);
    expect(reportCheckbox).not.toBeChecked();
    await user.click(reportCheckbox);

    reviewGroupingMock.mockResolvedValueOnce(snapshotFixture);
    await user.click(screen.getByRole("button", { name: "Confirm grouping" }));
    await user.type(screen.getByRole("textbox", { name: "Coordinator reason" }), "Selected report verified.");
    await user.click(screen.getByRole("button", { name: "Save coordinator decision" }));

    await waitFor(() => expect(reviewGroupingMock).toHaveBeenCalledOnce());
    expect(reviewGroupingMock.mock.calls[0]?.[0].report_ids).toEqual(["report-101"]);
  });

  it("toggles each grouping action form and lets the coordinator cancel", async () => {
    const { user } = await renderDashboard();
    await user.click(screen.getByRole("checkbox", { name: "Select report report-101 for a coordinator action" }));
    const groupingActions: Array<[string, string]> = [
      ["Confirm grouping", "Confirm the selected report membership."],
      ["Reject pairing", "Keep the selected report separate from this group."],
      ["Move selected", "Move selected reports to another group."],
      ["Split selected reports", "Create a separate group from the selected reports."],
    ];

    for (const [buttonName, formHeading] of groupingActions) {
      const action = screen.getByRole("button", { name: buttonName });
      await user.click(action);
      expect(screen.getByText(formHeading)).toBeInTheDocument();
      await user.click(action);
      expect(screen.queryByText(formHeading)).not.toBeInTheDocument();
    }

    await user.click(screen.getByRole("button", { name: "Confirm grouping" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Confirm the selected report membership.")).not.toBeInTheDocument();
  });

  it("filters the queue by review, conflicts, and all incidents", async () => {
    const { user } = await renderDashboard();
    const queue = screen.getByRole("region", { name: "Incident queue" });

    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(queue).toHaveTextContent("Exit A barrier reports conflict");
    expect(queue).toHaveTextContent("Unlocated alarm report");
    expect(queue).not.toHaveTextContent("Guest collapsed near Main Stage");

    await user.click(screen.getByRole("button", { name: "Conflicts" }));
    expect(queue).toHaveTextContent("Exit A barrier reports conflict");
    expect(queue).not.toHaveTextContent("Unlocated alarm report");

    await user.click(screen.getByRole("button", { name: "All" }));
    expect(queue).toHaveTextContent("Previously resolved facility issue");
  });

  it("merges selected queue groups with every expected version and the chosen target", async () => {
    const { user } = await renderDashboard();
    const sourceGroupName = "Select Guest collapsed near Main Stage for a group action";
    await user.click(screen.getByRole("checkbox", { name: sourceGroupName }));
    const mergeButton = screen.getByRole("button", { name: "Merge selected groups" });
    expect(mergeButton).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: sourceGroupName }));
    expect(screen.queryByRole("button", { name: "Merge selected groups" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: sourceGroupName }));
    await user.click(screen.getByRole("checkbox", { name: "Select Exit A barrier reports conflict for a group action" }));
    expect(screen.getByRole("button", { name: "Merge selected groups" })).toBeEnabled();
    reviewGroupingMock.mockResolvedValueOnce(snapshotFixture);

    await user.click(screen.getByRole("button", { name: "Merge selected groups" }));
    await user.type(screen.getByRole("textbox", { name: "Coordinator reason" }), "Same barrier event.");
    await user.click(screen.getByRole("button", { name: "Save coordinator decision" }));

    await waitFor(() => expect(reviewGroupingMock).toHaveBeenCalledOnce());
    expect(reviewGroupingMock).toHaveBeenCalledWith({
      action: "merge",
      report_ids: [],
      incident_ids: ["incident-001", "incident-002"],
      target_incident_id: "incident-001",
      reason: "Same barrier event.",
      expected_versions: { "incident-001": 1, "incident-002": 2 },
    });
    expect(await screen.findByText(/Merge decision saved to the audit trail/)).toBeInTheDocument();
  });

  it("preserves an opened priority version and reason when polling advances the row", async () => {
    const initial = boardSnapshot(1, 2);
    const polled = boardSnapshot(8, 9);
    getSnapshotMock.mockResolvedValueOnce(initial).mockResolvedValueOnce(polled);
    updatePriorityMock.mockRejectedValueOnce(new ApiError("Stale version.", 409, "stale_version"));
    const user = userEvent.setup();
    render(<DashboardPage />);
    await screen.findByRole("heading", { name: "Guest collapsed near Main Stage" });

    await user.click(screen.getByRole("button", { name: "Override priority" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Coordinator priority override" }), "P1");
    const reason = screen.getByRole("textbox", { name: "Reason" });
    await user.type(reason, "Coordinator verified lower risk.");

    const pollHandler = snapshotPollingCallback();
    expect(typeof pollHandler).toBe("function");
    await act(async () => {
      if (typeof pollHandler === "function") pollHandler();
      await Promise.resolve();
    });
    await screen.findByText("v8");
    await user.click(screen.getByRole("button", { name: "Save priority" }));

    await waitFor(() => expect(updatePriorityMock).toHaveBeenCalledOnce());
    expect(updatePriorityMock).toHaveBeenCalledWith("incident-001", {
      priority: "P1",
      reason: "Coordinator verified lower risk.",
      expected_version: 1,
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("older incident version");
    expect(reason).toHaveValue("Coordinator verified lower risk.");
  });

  it("keeps the opened grouping versions when polling advances incidents", async () => {
    const initial = boardSnapshot(1, 2);
    const polled = boardSnapshot(9, 10);
    getSnapshotMock.mockResolvedValueOnce(initial).mockResolvedValueOnce(polled);
    reviewGroupingMock.mockRejectedValueOnce(new ApiError("Stale grouping version.", 409, "stale_version"));
    const user = userEvent.setup();
    render(<DashboardPage />);
    await screen.findByRole("heading", { name: "Guest collapsed near Main Stage" });
    await user.click(screen.getByRole("button", { name: "Confirm grouping" }));
    const reason = screen.getByRole("textbox", { name: "Coordinator reason" });
    await user.type(reason, "Verified all related reports.");

    const pollHandler = snapshotPollingCallback();
    await act(async () => {
      if (typeof pollHandler === "function") pollHandler();
      await Promise.resolve();
    });
    await screen.findByText("v9");
    await user.click(screen.getByRole("button", { name: "Save coordinator decision" }));

    await waitFor(() => expect(reviewGroupingMock).toHaveBeenCalledOnce());
    expect(reviewGroupingMock.mock.calls[0]?.[0].expected_versions).toEqual({ "incident-001": 1 });
    expect(reviewGroupingMock.mock.calls[0]?.[0].target_incident_id).toBe("incident-001");
    expect(await screen.findByRole("alert")).toHaveTextContent("older incident version");
    expect(reason).toHaveValue("Verified all related reports.");
  });

  it("does not replace a mutation snapshot with an older in-flight poll", async () => {
    const initial = boardSnapshot();
    const stalePoll = boardSnapshot();
    let resolvePoll!: (snapshot: Snapshot) => void;
    getSnapshotMock
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(new Promise((resolve) => { resolvePoll = resolve; }));
    await renderDashboard(initial);

    // The dashboard hook is private to the page; a successful status action provides its applySnapshot path.
    const mutation = boardSnapshot(11, 12);
    updateStatusMock.mockResolvedValueOnce(mutation);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Change status" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Workflow status" }), "acknowledged");
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Coordinator accepted the report.");

    const pollHandler = snapshotPollingCallback();
    await act(async () => {
      if (typeof pollHandler === "function") pollHandler();
      await Promise.resolve();
    });
    await user.click(screen.getByRole("button", { name: "Save status" }));
    await waitFor(() => expect(updateStatusMock).toHaveBeenCalledOnce());
    await screen.findByText("v11");

    await act(async () => resolvePoll(stalePoll));
    expect(screen.getByText("v11")).toBeInTheDocument();
  });

  it("shows a loading state, a failed connection and then retries successfully", async () => {
    let rejectInitial!: (error: unknown) => void;
    getSnapshotMock
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectInitial = reject; }))
      .mockResolvedValueOnce(boardSnapshot());
    const user = userEvent.setup();
    render(<DashboardPage />);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to the exercise workspace");

    await act(async () => rejectInitial(new Error("Backend offline.")));
    expect(await screen.findByText("Exercise data is unavailable")).toBeInTheDocument();
    expect(screen.getByText("Backend offline.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry connection" }));
    expect(await screen.findByRole("heading", { name: "Incident queue" })).toBeInTheDocument();
  });

  it("keeps the last dashboard snapshot visible after a polling error", async () => {
    getSnapshotMock.mockResolvedValueOnce(boardSnapshot()).mockRejectedValueOnce(new Error("Temporary network failure."));
    await renderDashboard();
    const pollHandler = snapshotPollingCallback();

    await act(async () => {
      if (typeof pollHandler === "function") pollHandler();
      await Promise.resolve();
    });

    expect(await screen.findByText(/Snapshot refresh failed: Temporary network failure/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Guest collapsed near Main Stage" })).toBeInTheDocument();
  });

  it("shows empty queue, inspector and audit states when the event has no incidents", async () => {
    getSnapshotMock.mockResolvedValueOnce(makeSnapshot({
      incidents: [],
      reports: [],
      audit: [],
      counts: { reports: 0, incidents: 0, review: 0, conflicts: 0 },
    }));
    render(<DashboardPage />);
    await screen.findByRole("heading", { name: "Incident queue" });

    expect(screen.getByText("No incidents match this filter.")).toBeInTheDocument();
    expect(screen.getByText("Select a provisional group")).toBeInTheDocument();
    expect(screen.getByText("Coordinator decisions will appear here with their reasons.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Report a situation" })).toHaveAttribute("href", "/report");
  });

  it("uses the fallback message for an empty snapshot response", async () => {
    getSnapshotMock.mockResolvedValueOnce(null as unknown as Snapshot);
    render(<DashboardPage />);

    expect(await screen.findByText("The exercise snapshot could not be read. Check the backend and retry.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry connection" })).toBeEnabled();
  });

  it("sorts same-priority groups by creation time and keeps unknown zones off the map", async () => {
    const later = makeIncident({
      id: "incident-later",
      title: "Later-created incident",
      priority: "P2",
      status: "open",
      zone_id: "missing-zone",
      report_ids: [],
      conflicts: [],
      created_at: "2026-10-24T16:20:00Z",
    });
    const earlier = makeIncident({
      id: "incident-earlier",
      title: "Earlier-created incident",
      priority: "P2",
      status: "open",
      zone_id: "missing-zone",
      report_ids: [],
      conflicts: [],
      created_at: "2026-10-24T16:10:00Z",
    });
    getSnapshotMock.mockResolvedValueOnce(makeSnapshot({ incidents: [later, earlier], reports: [], audit: [] }));
    render(<DashboardPage />);
    await screen.findByRole("heading", { name: "Incident queue" });

    const queue = screen.getByRole("region", { name: "Incident queue" });
    const visibleTitles = Array.from(queue.querySelectorAll(".incident-row-title")).map((node) => node.childNodes[0]?.textContent);
    expect(visibleTitles).toEqual(["Earlier-created incident", "Later-created incident"]);
    expect(queue).toHaveTextContent("Unknown zone");
    const map = screen.getByRole("region", { name: "Campus schematic" });
    expect(map).toHaveTextContent("Active groups matching queue filters with known zones.");
    expect(within(map).queryByRole("button", { name: /Later-created incident/ })).not.toBeInTheDocument();
  });

  it("starts, advances and completes replay while reporting failures accessibly", async () => {
    const { user } = await renderDashboard();
    const replay = { session_id: "session-1", event_id: eventFixture.id, cursor: 0, total: 1, scenario: "busy" as const };
    const started = boardSnapshot();
    started.replay = replay;
    const advanced = boardSnapshot();
    advanced.replay = { ...replay, cursor: 1 };
    startReplayMock.mockResolvedValueOnce(started);
    advanceReplayMock.mockResolvedValueOnce(advanced);

    await user.click(screen.getByText("Replay"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Synthetic scenario" }), "busy");
    await user.click(screen.getByRole("button", { name: "Start replay" }));
    expect(await screen.findByText("Started the busy synthetic replay.")).toBeInTheDocument();
    expect(screen.getByText(/Replay step 0 of 1 · busy scenario/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next report" }));
    expect(await screen.findByText("Next synthetic report added.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replay complete" })).toBeDisabled();
    expect(advanceReplayMock).toHaveBeenCalledOnce();
    expect(advanceReplayMock).toHaveBeenCalledWith("session-1");
  });

  it("announces completion when advancing a replay does not move its cursor", async () => {
    const { user } = await renderDashboard();
    const replay = { session_id: "session-steady", event_id: eventFixture.id, cursor: 0, total: 1, scenario: "busy" as const };
    const started = boardSnapshot();
    started.replay = replay;
    const unchanged = boardSnapshot();
    unchanged.replay = replay;
    startReplayMock.mockResolvedValueOnce(started);
    advanceReplayMock.mockResolvedValueOnce(unchanged);

    await user.click(screen.getByText("Replay"));
    await user.click(screen.getByRole("button", { name: "Start replay" }));
    await user.click(await screen.findByRole("button", { name: "Next report" }));
    expect(await screen.findByText("Replay is complete.")).toBeInTheDocument();
  });

  it("clears a replay notice after its announced duration", async () => {
    await renderDashboard();
    vi.useFakeTimers();
    const started = boardSnapshot();
    started.replay = { session_id: "session-timer", event_id: eventFixture.id, cursor: 0, total: 1, scenario: "demo" };
    startReplayMock.mockResolvedValueOnce(started);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start replay" }));
      await Promise.resolve();
    });
    expect(screen.getByText("Started the demo synthetic replay.")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_500);
    });
    expect(screen.queryByText("Started the demo synthetic replay.")).not.toBeInTheDocument();
  });

  it("keeps a readable error notice when replay requests fail", async () => {
    const { user } = await renderDashboard();
    startReplayMock.mockRejectedValueOnce("network unavailable");
    await user.click(screen.getByRole("button", { name: "Start replay" }));
    expect(await screen.findByText("The coordinator action could not be saved.")).toBeInTheDocument();

    const activeReplay = boardSnapshot();
    activeReplay.replay = { session_id: "session-fail", event_id: eventFixture.id, cursor: 0, total: 1, scenario: "demo" };
    getSnapshotMock.mockResolvedValueOnce(activeReplay);
    const pollHandler = snapshotPollingCallback();
    await act(async () => {
      if (typeof pollHandler === "function") pollHandler();
      await Promise.resolve();
    });
    await screen.findByRole("button", { name: "Next report" });
    advanceReplayMock.mockRejectedValueOnce(new Error("Replay transport failed."));
    await user.click(screen.getByRole("button", { name: "Next report" }));
    expect(await screen.findByText("Replay transport failed.")).toBeInTheDocument();
  });

  it("expands and collapses the audit history", async () => {
    const { user } = await renderDashboard();
    const toggle = screen.getByRole("button", { name: "View all 4" });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Show recent" })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Show recent" }));
    expect(screen.getByRole("button", { name: "View all 4" })).toHaveAttribute("aria-expanded", "false");
  });

  it("links current audit entities to the owning incident and preserves the event", async () => {
    const { user } = await renderDashboard();
    window.history.replaceState({}, "", `/dashboard?event=${eventFixture.id}&queue=review`);
    await user.click(screen.getByRole("button", { name: "View all 4" }));

    const audit = screen.getByRole("region", { name: "Coordinator audit" });
    expect(within(audit).getAllByRole("link", { name: "Open INC-001" })).toHaveLength(2);
    expect(within(audit).getByRole("link", { name: "Open INC-002" })).toHaveAttribute("href", `/dashboard?event=${eventFixture.id}&queue=review&incident=incident-002`);
    const historic = within(audit).getByText(/coordinator · report-001/).closest(".audit-entry");
    expect(within(historic as HTMLElement).queryByRole("link")).not.toBeInTheDocument();
    expect(within(audit).getAllByRole("link", { name: "Open INC-001" })[0]).toHaveAttribute("href", `/dashboard?event=${eventFixture.id}&queue=review&incident=incident-001`);
  });

  it("includes relevant report and conflict decisions in each incident timeline", async () => {
    const snapshot = boardSnapshot();
    snapshot.audit.push(
      { ...auditFixture, id: "audit-report-analyzed", seq: 5, entity_id: reportOne.id, action: "report.analyzed", actor: "analysis-worker" },
      { ...auditFixture, id: "audit-coordinator-no-reason", seq: 6, entity_id: "incident-001", action: "status.changed", reason: null },
      { ...auditFixture, id: "audit-conflict-no-reason", seq: 7, entity_id: conflictFixture.id, action: "conflict.reviewed", reason: null },
    );
    const { user } = await renderDashboard(snapshot);
    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Guest collapsed near Main Stage/ }));
    const sourceTimeline = screen.getByRole("region", { name: "Incident timeline" });
    await user.click(within(sourceTimeline).getByRole("button", { name: "View all 8" }));
    expect(within(sourceTimeline).getByText("Report decision")).toBeInTheDocument();
    expect(within(sourceTimeline).getByText("Report lifecycle")).toBeInTheDocument();
    const statusChangedEntries = within(sourceTimeline).getAllByText(/coordinator · Status Changed/).map((detail) => detail.closest(".timeline-entry"));
    expect(statusChangedEntries).toHaveLength(2);
    expect(statusChangedEntries.map((entry) => entry?.className)).toEqual(expect.arrayContaining(["timeline-entry is-report-decision", "timeline-entry is-coordinator-decision"]));

    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Exit A barrier reports conflict/ }));
    const targetTimeline = screen.getByRole("region", { name: "Incident timeline" });
    await user.click(within(targetTimeline).getByRole("button", { name: "View all 6" }));
    expect(within(targetTimeline).getAllByText("Conflict review")).toHaveLength(2);
    expect(within(targetTimeline).getByText("exit access · coordinator · Conflict Reviewed")).toBeInTheDocument();
    expect(within(targetTimeline).getByText("exit access · coordinator · Conflict Reviewed · Exit inspected.")).toBeInTheDocument();
  });

  it("shows an empty timeline for a group without current reports or decisions", async () => {
    const { user } = await renderDashboard();
    const queue = screen.getByRole("region", { name: "Incident queue" });
    await user.click(within(queue).getByRole("button", { name: "All" }));
    await user.click(within(queue).getByRole("button", { name: /Previously resolved facility issue/ }));

    expect(screen.getByRole("region", { name: "Incident timeline" })).toHaveTextContent("No report or coordinator events have been recorded.");
  });

  it("includes unresolved conflict phrases in the print brief when no reason was recorded", async () => {
    const snapshot = boardSnapshot();
    snapshot.incidents[1]!.conflicts[0]!.reason = "";
    await renderDashboard(snapshot);

    const printBrief = document.querySelector(".print-brief") as HTMLElement;
    expect(within(printBrief).getByText("Unresolved question (exit_access): Exit A is blocked / Exit A is clear now")).toBeInTheDocument();
  });

  it("links evidence phrases to their exact source report and scopes conflict highlights per report", async () => {
    const snapshot = boardSnapshot();
    snapshot.reports[0] = {
      ...snapshot.reports[0]!,
      text: "A guest is not responding near Main Stage.",
      claims: [{ field: "reported_condition", value: "unresponsive", span: "is not responding" }],
    };
    snapshot.incidents[0] = {
      ...snapshot.incidents[0]!,
      priority_reason: "P0 rule DANGER: source phrase “is not responding” in report report-101; \"near Main Stage\" in report report-101 also matches.",
    };
    snapshot.reports[2] = { ...snapshot.reports[2]!, text: "Exit A is blocked." };
    snapshot.reports[3] = { ...snapshot.reports[3]!, text: "Exit A is clear now." };
    const { user } = await renderDashboard(snapshot);

    const prioritySource = screen.getAllByRole("button", { name: "Show priority source phrase from RPT-101" })[0]!;
    expect(screen.getByText("“near Main Stage” · RPT-101")).toBeInTheDocument();
    await user.click(prioritySource);
    const sourceDetails = screen.getByText("Source reports").closest("details")!;
    expect(sourceDetails).toHaveAttribute("open");
    const stageReport = document.getElementById("source-report-report-101")!;
    expect(within(stageReport).getByText("is not responding", { selector: "mark" })).toBeInTheDocument();

    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Exit A barrier reports conflict/ }));
    const blockedReport = document.getElementById("source-report-report-201")!;
    const clearReport = document.getElementById("source-report-report-202")!;
    expect(within(blockedReport).getByText("Exit A is blocked", { selector: "mark" })).toBeInTheDocument();
    expect(within(blockedReport).queryByText("Exit A is clear now", { selector: "mark" })).not.toBeInTheDocument();
    expect(within(clearReport).getByText("Exit A is clear now", { selector: "mark" })).toBeInTheDocument();
    expect(within(clearReport).queryByText("Exit A is blocked", { selector: "mark" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show source report report-201 for exit access" }));
    expect(sourceDetails).toHaveAttribute("open");
    await waitFor(() => expect(document.activeElement).toBe(blockedReport));
  });

  it("does nothing when selected queue groups disappear before the merge action", async () => {
    const initial = boardSnapshot();
    const remaining = boardSnapshot();
    remaining.incidents = [remaining.incidents[2]!];
    remaining.counts.incidents = 1;
    getSnapshotMock.mockResolvedValueOnce(initial).mockResolvedValueOnce(remaining);
    const user = userEvent.setup();
    render(<DashboardPage />);
    await screen.findByRole("heading", { name: "Incident queue" });
    await user.click(screen.getByRole("checkbox", { name: "Select Guest collapsed near Main Stage for a group action" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Exit A barrier reports conflict for a group action" }));

    const pollHandler = snapshotPollingCallback();
    await act(async () => {
      if (typeof pollHandler === "function") pollHandler();
      await Promise.resolve();
    });
    await screen.findByRole("checkbox", { name: "Select Unlocated alarm report for a group action" });
    await user.click(screen.getByRole("button", { name: "Merge selected groups" }));
    expect(screen.queryByRole("textbox", { name: "Coordinator reason" })).not.toBeInTheDocument();
  });

  it("uses received time, shows incomplete analysis, and exposes evidence notes", async () => {
    const snapshot = boardSnapshot();
    snapshot.reports[0] = {
      ...snapshot.reports[0]!,
      reported_at: null,
      received_at: "2026-10-24T20:45:00Z",
      sublocation: "North concourse",
      analysis_status: "pending",
    };
    snapshot.incidents[0] = {
      ...snapshot.incidents[0]!,
      evidence: [{ ...evidenceFixture, created_at: "2026-10-24T20:40:00Z", reasons: [], missing_fields: ["sublocation"] }],
    };
    await renderDashboard(snapshot);

    expect(screen.getByText("Analysis pending")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry pending analysis" })).toBeInTheDocument();
    expect(screen.getByText("Missing context: sublocation")).toBeInTheDocument();
    expect(screen.getByText("Text similarity")).toBeInTheDocument();
    const evidenceCard = screen.getByText("Text similarity").closest(".evidence-card") as HTMLElement;
    expect(within(evidenceCard).getByText(/Historical comparison/)).toBeInTheDocument();
    expect(screen.getByText("North concourse")).toBeInTheDocument();
    const reportArticle = screen.getByText("RPT-101").closest(".source-report");
    expect(reportArticle).toHaveTextContent(formattedTime("2026-10-24T20:45:00Z", snapshot.event.timezone));
  });

  it("shows an evidence card without notes when no reasons or fields were produced", async () => {
    const snapshot = boardSnapshot();
    snapshot.incidents[0] = {
      ...snapshot.incidents[0]!,
      evidence: [{ ...evidenceFixture, reasons: [], missing_fields: [] }],
    };
    await renderDashboard(snapshot);

    expect(screen.getByText("RPT-002 ↔ RPT-001")).toBeInTheDocument();
    expect(screen.queryByText("Missing context:")).not.toBeInTheDocument();
    expect(document.querySelector(".evidence-notes")).toBeNull();
  });

  it("explains when the reports have no supported claims", async () => {
    const snapshot = boardSnapshot();
    snapshot.reports[0] = { ...snapshot.reports[0]!, claims: [] };
    snapshot.reports[1] = { ...snapshot.reports[1]!, claims: [] };
    await renderDashboard(snapshot);

    expect(screen.getByText("No supported claim fields were extracted from these reports.")).toBeInTheDocument();
  });

  it("keeps unknown conflict values visible and lets the reviewer cancel", async () => {
    const snapshot = boardSnapshot();
    snapshot.incidents[1] = {
      ...snapshot.incidents[1]!,
      conflicts: [{ ...snapshot.incidents[1]!.conflicts[0]!, values: ["blocked"] }],
    };
    const { user } = await renderDashboard(snapshot);
    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Exit A barrier reports conflict/ }));
    expect(screen.getByText("“Exit A is clear now” · unknown")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Resolve conflict" }));
    expect(screen.getByRole("textbox", { name: "Reason for resolution" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: "Reason for resolution" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolve conflict" })).toBeInTheDocument();
  });

  it("keeps a title draft through a version conflict and rebases only when requested", async () => {
    const initial = boardSnapshot();
    const latest = boardSnapshot(2, 3);
    latest.incidents[0] = {
      ...latest.incidents[0]!,
      title: "Guest condition checked by supervisor",
      priority: "P1",
      status: "monitoring",
      report_ids: [...latest.incidents[0]!.report_ids, reportFive.id],
      evidence: [{ ...evidenceFixture, total_score: null }],
    };
    const { user } = await renderDashboard(initial);
    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Guest collapsed near Main Stage/ }));
    await user.click(screen.getByRole("button", { name: "Edit title" }));
    await user.click(screen.getByRole("button", { name: "Cancel title edit" }));
    expect(screen.queryByRole("textbox", { name: "Incident title" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit title" }));
    const form = screen.getByRole("button", { name: "Save title" }).closest("form")!;
    fireEvent.submit(form);
    expect(await screen.findByRole("alert")).toHaveTextContent("title and reason with at least 3 characters");
    await user.clear(within(form).getByRole("textbox", { name: "Incident title" }));
    await user.type(within(form).getByRole("textbox", { name: "Incident title" }), "Updated guest condition");
    await user.type(within(form).getByRole("textbox", { name: "Reason for title change" }), "Supervisor confirmed the description.");

    updateIncidentTitleMock.mockRejectedValueOnce(new ApiError("Stale title version.", 409, "stale_version"));
    await user.click(within(form).getByRole("button", { name: "Save title" }));
    expect(await screen.findByText(/older incident version/)).toBeInTheDocument();
    expect(within(form).getByRole("textbox", { name: "Reason for title change" })).toHaveValue("Supervisor confirmed the description.");

    getSnapshotMock.mockResolvedValueOnce(latest);
    await pollNextSnapshot();
    expect(await screen.findByText(/Membership changed: Added RPT-301/)).toBeInTheDocument();
    expect(screen.getByText(/Pairwise grouping evidence changed in the current snapshot/)).toBeInTheDocument();
    expect(screen.getByText(/Priority changed from P0 to P1/)).toBeInTheDocument();
    expect(screen.getByText(/Status changed from Open to Monitoring/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use latest version and keep reason" }));

    updateIncidentTitleMock.mockResolvedValueOnce(latest);
    await user.click(within(form).getByRole("button", { name: "Save title" }));
    await waitFor(() => expect(updateIncidentTitleMock).toHaveBeenLastCalledWith("incident-001", {
      title: "Updated guest condition",
      reason: "Supervisor confirmed the description.",
      expected_version: 2,
    }));
    expect(await screen.findByText("Incident title updated with its reason.")).toBeInTheDocument();
  });

  it("saves coordinator notes with the current version and clears drafts on incident change", async () => {
    const snapshot = boardSnapshot();
    snapshot.incidents[0] = {
      ...snapshot.incidents[0]!,
      notes: [{ id: "note-old", text: "Call placed to the venue desk.", actor: "coordinator", created_at: "2026-10-24T20:00:00Z" }],
    };
    const { user } = await renderDashboard(snapshot);
    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Guest collapsed near Main Stage/ }));
    expect(within(screen.getByRole("region", { name: "Incident inspector" })).getByText("Call placed to the venue desk.")).toBeInTheDocument();
    const sourceNote = screen.getByRole("textbox", { name: "Add a coordinator note" });
    await user.type(sourceNote, "Draft for the stage group");
    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Exit A barrier reports conflict/ }));
    const targetNote = screen.getByRole("textbox", { name: "Add a coordinator note" });
    expect(targetNote).toHaveValue("");
    fireEvent.submit(targetNote.closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Write a note before saving.");
    await user.type(targetNote, "Exit checked with facilities.");

    addIncidentNoteMock.mockRejectedValueOnce(new Error("Notes service unavailable."));
    await user.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Notes service unavailable.");
    expect(addIncidentNoteMock).toHaveBeenCalledWith("incident-002", { text: "Exit checked with facilities.", expected_version: 2 });

    const saved = boardSnapshot();
    addIncidentNoteMock.mockResolvedValueOnce(saved);
    await user.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByText("Coordinator note saved.")).toBeInTheDocument();
  });

  it("returns an equal-valued priority override to policy", async () => {
    const snapshot = boardSnapshot();
    snapshot.incidents[0] = { ...snapshot.incidents[0]!, override_reason: "Supervisor reviewed this priority." };
    const latest = boardSnapshot(2, 2);
    latest.incidents[0] = {
      ...latest.incidents[0]!,
      priority: "P1",
      override_reason: "Updated priority.",
      report_ids: [reportOne.id],
      evidence: [],
    };
    const { user } = await renderDashboard(snapshot);
    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Guest collapsed near Main Stage/ }));

    await user.click(screen.getByRole("button", { name: "Reset to suggested priority" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Reset to suggested priority" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset to suggested priority" }));
    const resetField = screen.getByRole("textbox", { name: "Reason for returning to P0" });
    await user.click(screen.getByRole("button", { name: "Reset priority" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("at least 3 characters");
    await user.type(resetField, "Confirmed by coordinator.");
    resetPriorityMock.mockRejectedValueOnce(new ApiError("Stale priority version.", 409, "stale_version"));
    await user.click(screen.getByRole("button", { name: "Reset priority" }));
    expect(await screen.findByText(/older incident version/)).toBeInTheDocument();
    getSnapshotMock.mockResolvedValueOnce(latest);
    await pollNextSnapshot();
    expect(await screen.findByText(/Priority changed from P0 to P1/)).toBeInTheDocument();
    expect(screen.getByText(/Membership changed: removed RPT-102/)).toBeInTheDocument();
    expect(screen.getByText(/Pairwise grouping evidence changed in the current snapshot/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use latest version and keep reason" }));

    const resetResult = boardSnapshot(3, 2);
    resetResult.incidents[0] = { ...resetResult.incidents[0]!, override_reason: null };
    resetPriorityMock.mockResolvedValueOnce(resetResult);
    await user.click(screen.getByRole("button", { name: "Reset priority" }));
    await waitFor(() => expect(resetPriorityMock).toHaveBeenLastCalledWith("incident-001", { reason: "Confirmed by coordinator.", expected_version: 2 }));
    expect(await screen.findByText("Priority returned to the policy suggestion.")).toBeInTheDocument();
  });

  it("saves a priority override and advances to the next matching review item", async () => {
    const initial = boardSnapshot();
    initial.incidents = initial.incidents.slice(0, 2);
    const next = boardSnapshot(2, 2);
    next.incidents = next.incidents.slice(0, 2);
    const { user } = await renderDashboard(initial);
    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Guest collapsed near Main Stage/ }));
    await user.click(screen.getByRole("button", { name: "Override priority" }));
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Reviewed with the incident lead.");
    updatePriorityMock.mockResolvedValueOnce(next);

    await user.click(screen.getByRole("button", { name: "Save & next review" }));

    await waitFor(() => expect(updatePriorityMock).toHaveBeenCalledWith("incident-001", {
      priority: "P0",
      reason: "Reviewed with the incident lead.",
      expected_version: 1,
    }));
    expect(await screen.findByRole("button", { name: "Copy full incident ID incident-002" })).toBeInTheDocument();
  });

  it("saves a status with next-review and explains when no matching review item remains", async () => {
    const initial = boardSnapshot();
    initial.incidents = initial.incidents.slice(0, 2);
    initial.incidents[1] = { ...initial.incidents[1]!, review_required: false, review_reasons: [] };
    const next = boardSnapshot(2, 2);
    next.incidents = next.incidents.slice(0, 2);
    next.incidents[1] = { ...next.incidents[1]!, review_required: false, review_reasons: [] };
    const { user } = await renderDashboard(initial);
    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Guest collapsed near Main Stage/ }));
    await user.click(screen.getByRole("button", { name: "Change status" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Workflow status" }), "monitoring");
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "Keep watch until facilities confirms.");
    updateStatusMock.mockResolvedValueOnce(next);

    await user.click(screen.getByRole("button", { name: "Save & next review" }));

    await waitFor(() => expect(updateStatusMock).toHaveBeenCalledWith("incident-001", {
      status: "monitoring",
      reason: "Keep watch until facilities confirms.",
      expected_version: 1,
    }));
    expect(await screen.findByText("No other review item matches the current filters.")).toBeInTheDocument();
  });

  it("saves a grouping review with next-review and selects its next candidate", async () => {
    const initial = boardSnapshot();
    initial.incidents = initial.incidents.slice(0, 2);
    const next = boardSnapshot(2, 2);
    next.incidents = next.incidents.slice(0, 2);
    const { user } = await renderDashboard(initial);
    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Guest collapsed near Main Stage/ }));
    await user.click(screen.getByRole("button", { name: "Confirm grouping" }));
    await user.type(screen.getByRole("textbox", { name: "Coordinator reason" }), "Reports describe the same incident.");
    reviewGroupingMock.mockResolvedValueOnce(next);

    await user.click(screen.getByRole("button", { name: "Save & next review" }));

    await waitFor(() => expect(reviewGroupingMock).toHaveBeenCalledOnce());
    expect(await screen.findByRole("button", { name: "Copy full incident ID incident-002" })).toBeInTheDocument();
  });

  it("saves a grouping review and keeps selection when no other item matches", async () => {
    const initial = boardSnapshot();
    initial.incidents = initial.incidents.slice(0, 2);
    const next = boardSnapshot(2, 2);
    next.incidents = next.incidents.slice(0, 2);
    next.incidents[1] = { ...next.incidents[1]!, review_required: false, review_reasons: [] };
    const { user } = await renderDashboard(initial);
    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Guest collapsed near Main Stage/ }));
    await user.click(screen.getByRole("button", { name: "Confirm grouping" }));
    await user.type(screen.getByRole("textbox", { name: "Coordinator reason" }), "Reports describe the same incident.");
    reviewGroupingMock.mockResolvedValueOnce(next);

    await user.click(screen.getByRole("button", { name: "Save & next review" }));

    await waitFor(() => expect(reviewGroupingMock).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Confirm decision saved to the audit trail. No other review item matches/)).toBeInTheDocument();
  });

  it("requires a reason before undoing an eligible action and records the explanation", async () => {
    const snapshot = boardSnapshot();
    snapshot.undoable_actions = [{ audit_id: "audit-undo-1", incident_id: "incident-001", action: "priority.changed", expected_version: 1 }];
    const { user } = await renderDashboard(snapshot);
    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Guest collapsed near Main Stage/ }));
    await user.click(screen.getByRole("button", { name: "Undo last Priority Changed" }));
    const reasonField = screen.getByRole("textbox", { name: "Reason" });
    expect(reasonField).toBeRequired();
    fireEvent.change(reasonField, { target: { value: "  " } });
    fireEvent.submit(screen.getByRole("button", { name: "Save undo" }).closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("at least 3 characters");
    await user.clear(reasonField);
    await user.type(reasonField, "Undo after supervisor review.");
    const undone = boardSnapshot(2, 2);
    undoDecisionMock.mockResolvedValueOnce(undone);
    await user.click(screen.getByRole("button", { name: "Save undo" }));
    await waitFor(() => expect(undoDecisionMock).toHaveBeenCalledWith("audit-undo-1", { reason: "Undo after supervisor review.", expected_version: 1 }));
    expect(await screen.findByText("The last eligible decision was undone.")).toBeInTheDocument();
  });

  it("rebases an undo after a stale version, keeps the reason on failure, and can be canceled", async () => {
    const snapshot = boardSnapshot();
    snapshot.undoable_actions = [{ audit_id: "audit-undo-1", incident_id: "incident-001", action: "priority.changed", expected_version: 1 }];
    const latest = boardSnapshot(3, 2);
    latest.undoable_actions = snapshot.undoable_actions;
    const { user } = await renderDashboard(snapshot);
    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Guest collapsed near Main Stage/ }));
    await user.click(screen.getByRole("button", { name: "Undo last Priority Changed" }));
    const reason = screen.getByRole("textbox", { name: "Reason" });
    await user.type(reason, "Supervisor confirmed this can be reversed.");

    undoDecisionMock.mockRejectedValueOnce(new ApiError("Stale undo version.", 409, "stale_version"));
    await user.click(screen.getByRole("button", { name: "Save undo" }));
    expect(await screen.findByText(/older incident version/)).toBeInTheDocument();
    expect(reason).toHaveValue("Supervisor confirmed this can be reversed.");

    getSnapshotMock.mockResolvedValueOnce(latest);
    await pollNextSnapshot();
    await user.click(screen.getByRole("button", { name: "Use latest version and keep reason" }));
    undoDecisionMock.mockRejectedValueOnce(new Error("Undo service unavailable."));
    await user.click(screen.getByRole("button", { name: "Save undo" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Undo service unavailable.");
    expect(reason).toHaveValue("Supervisor confirmed this can be reversed.");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Undo last Priority Changed" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo last Priority Changed" }));
    expect(screen.getByRole("textbox", { name: "Reason" })).toHaveValue("Supervisor confirmed this can be reversed.");
  });

});
