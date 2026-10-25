// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSnapshot, type SnapshotState } from "../hooks/use-snapshot";
import { DashboardPage } from "../pages/dashboard-page";
import type { Snapshot } from "../lib/types";
import {
  auditFixture,
  conflictFixture,
  eventFixture,
  incidentFixture,
  makeIncident,
  makeReport,
  makeSnapshot,
  matchingReportFixture,
  reportFixture,
} from "./fixtures";

const hookMock = vi.hoisted(() => ({ useSnapshot: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../hooks/use-snapshot", () => ({ useSnapshot: hookMock.useSnapshot }));

const useSnapshotMock = vi.mocked(useSnapshot);
let restorers: Array<() => void> = [];

function replaceProperty(target: object, key: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restorers.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else Reflect.deleteProperty(target, key);
  });
}

function setClipboard(writeText: ReturnType<typeof vi.fn> | undefined): void {
  const clipboard = writeText ? { writeText } : undefined;
  replaceProperty(window.navigator, "clipboard", clipboard);
  if (globalThis.navigator !== window.navigator) replaceProperty(globalThis.navigator, "clipboard", clipboard);
}

function dashboardSnapshot(title = "Guest collapsed near Main Stage"): Snapshot {
  const report = makeReport({
    ...reportFixture,
    display_id: "RPT-001",
    text: "A guest collapsed near the main stage and is not responding.",
    claims: [{ field: "reported_condition", value: "unresponsive", span: "is not responding" }],
  });
  const matchingReport = makeReport({
    ...matchingReportFixture,
    display_id: "RPT-002",
    event_id: eventFixture.id,
    incident_id: incidentFixture.id,
  });
  const incident = makeIncident({
    ...incidentFixture,
    display_id: "INC-001",
    title,
    priority_reason: `P0 policy source phrase “is not responding” in report ${report.id}.`,
    report_ids: [report.id, matchingReport.id],
    evidence: incidentFixture.evidence,
    conflicts: [],
  });
  return makeSnapshot({
    event: eventFixture,
    incidents: [incident],
    reports: [report, matchingReport],
    audit: [auditFixture],
    replay: null,
    counts: { reports: 2, incidents: 1, review: 0, conflicts: 0 },
  });
}

function multiLocationSnapshot(): Snapshot {
  const snapshot = dashboardSnapshot();
  const mainStageGroup = snapshot.incidents[0]!;
  const sameZone = makeIncident({
    ...mainStageGroup,
    id: "incident-002",
    display_id: "INC-002",
    title: "Second Main Stage group",
    priority: "P0",
    suggested_priority: "P0",
    version: 2,
    report_ids: ["report-003"],
  });
  const unlocatedReport = makeReport({
    ...reportFixture,
    id: "report-004",
    display_id: "RPT-004",
    incident_id: "incident-003",
    zone_id: null,
    text: "An alarm is sounding somewhere on campus.",
  });
  const unlocated = makeIncident({
    ...mainStageGroup,
    id: "incident-003",
    display_id: "INC-003",
    title: "Unlocated alarm group",
    zone_id: null,
    priority: "UNASSESSED",
    suggested_priority: "UNASSESSED",
    version: 3,
    report_ids: [unlocatedReport.id],
  });
  const additionalReport = makeReport({
    ...reportFixture,
    id: "report-003",
    display_id: "RPT-003",
    incident_id: sameZone.id,
    zone_id: "stage",
    reported_at: "2026-10-24T17:00:00Z",
    received_at: "2026-10-24T17:00:05Z",
    text: "A separate guest needs help by the stage.",
  });
  snapshot.incidents = [mainStageGroup, sameZone, unlocated];
  snapshot.reports = [...snapshot.reports, additionalReport, unlocatedReport];
  snapshot.counts = { reports: snapshot.reports.length, incidents: 3, review: 0, conflicts: 0 };
  return snapshot;
}

function incompleteAnalysisSnapshot(status: "pending" | "failed" = "failed"): Snapshot {
  const snapshot = dashboardSnapshot();
  snapshot.reports[1] = { ...snapshot.reports[1]!, analysis_status: status };
  snapshot.incidents[0] = { ...snapshot.incidents[0]!, version: 7 };
  return snapshot;
}

function stateFor(snapshot: Snapshot | null): SnapshotState {
  return {
    snapshot,
    loading: false,
    error: null,
    refresh: vi.fn(async () => undefined),
    applySnapshot: vi.fn(),
    events: [eventFixture],
    selectedEventId: eventFixture.id,
    selectEvent: vi.fn(),
    lastUpdated: null,
    reconnecting: false,
  };
}

async function renderDashboard(snapshot = dashboardSnapshot()) {
  const state = stateFor(snapshot);
  useSnapshotMock.mockReturnValue(state);
  const user = userEvent.setup();
  const view = render(<DashboardPage />);
  await screen.findByRole("heading", { name: snapshot.incidents[0]!.title });
  return { ...view, user, state };
}

beforeEach(() => {
  window.history.replaceState({}, "", "/dashboard");
  useSnapshotMock.mockReset();
  useSnapshotMock.mockReturnValue(stateFor(dashboardSnapshot()));
  restorers = [];
});

afterEach(() => {
  cleanup();
  for (const restore of restorers.reverse()) restore();
  restorers = [];
  vi.restoreAllMocks();
});

describe("dashboard interaction regressions", () => {
  it("copies the full incident and report IDs through the available clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { user } = await renderDashboard();
    setClipboard(writeText);
    expect(navigator.clipboard?.writeText).toBe(writeText);

    await user.click(screen.getByRole("button", { name: "Copy full incident ID incident-001" }));
    expect(await screen.findByText("Full incident ID copied.")).toBeInTheDocument();
    expect(writeText).toHaveBeenNthCalledWith(1, "incident-001");

    const sourceSummary = screen.getByText("Source reports").closest("summary")!;
    await user.click(sourceSummary);
    await user.click(screen.getByRole("button", { name: "Copy full report ID report-001" }));
    await waitFor(() => expect(writeText).toHaveBeenNthCalledWith(2, "report-001"));
    expect(screen.getByText("Full report ID copied.")).toBeInTheDocument();
  });

  it("falls back to execCommand after clipboard denial and removes its temporary field", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    const copiedValues: string[] = [];
    const execCommand = vi.fn((command: string) => {
      copiedValues.push(document.querySelector<HTMLTextAreaElement>("textarea[readonly]")?.value ?? "");
      return command === "copy";
    });
    const { user } = await renderDashboard();
    setClipboard(writeText);
    replaceProperty(window.document, "execCommand", execCommand);
    if (globalThis.document !== window.document) replaceProperty(globalThis.document, "execCommand", execCommand);

    await user.click(screen.getByRole("button", { name: "Copy full incident ID incident-001" }));

    expect(await screen.findByText("Full incident ID copied.")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("incident-001");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(copiedValues).toEqual(["incident-001"]);
    expect(document.querySelector("textarea[readonly]")).not.toBeInTheDocument();
  });

  it("reports clipboard unavailability when the fallback returns false or throws", async () => {
    const execCommand = vi.fn()
      .mockReturnValueOnce(false)
      .mockImplementationOnce(() => { throw new Error("copy command unavailable"); });
    const { user } = await renderDashboard();
    setClipboard(undefined);
    replaceProperty(window.document, "execCommand", execCommand);
    if (globalThis.document !== window.document) replaceProperty(globalThis.document, "execCommand", execCommand);

    await user.click(screen.getByRole("button", { name: "Copy full incident ID incident-001" }));
    expect(await screen.findByText("Clipboard access is unavailable.")).toBeInTheDocument();
    expect(document.querySelector("textarea[readonly]")).not.toBeInTheDocument();

    const sourceSummary = screen.getByText("Source reports").closest("summary")!;
    await user.click(sourceSummary);
    await user.click(screen.getByRole("button", { name: "Copy full report ID report-001" }));
    await waitFor(() => expect(execCommand).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Clipboard access is unavailable.")).toBeInTheDocument();
    expect(document.querySelector("textarea[readonly]")).not.toBeInTheDocument();
  });

  it("opens and focuses the exact source report for policy and claim phrases", async () => {
    const scrollIntoView = vi.fn();
    replaceProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoView);
    const { user } = await renderDashboard();

    await user.click(screen.getByRole("button", { name: "Show priority source phrase from RPT-001" }));

    const sourceDisclosure = screen.getByText("Source reports").closest("details")!;
    const sourceReport = document.getElementById("source-report-report-001")!;
    await waitFor(() => expect(document.activeElement).toBe(sourceReport));
    expect(sourceDisclosure).toHaveAttribute("open");
    expect(within(sourceReport).getByText("is not responding", { selector: "mark" })).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });

    await user.click(screen.getByRole("button", { name: "Show source report RPT-001 for claim reported condition" }));
    await waitFor(() => expect(document.activeElement).toBe(sourceReport));
  });

  it("opens a native evidence disclosure and exposes its pairwise scores", async () => {
    const { user } = await renderDashboard();
    const summary = screen.getByText("Grouping evidence").closest("summary")!;
    const disclosure = summary.closest("details")!;
    await user.click(summary);

    await waitFor(() => expect(disclosure).toHaveAttribute("open"));
    expect(screen.getByText("Text similarity")).toBeInTheDocument();
  });

  it("prints the brief and downloads the current JSON and formula-safe CSV snapshot", async () => {
    const createObjectURL = vi.fn((blob: Blob) => `blob:brief-${createdBlobs.push(blob)}`);
    const revokeObjectURL = vi.fn();
    const printed = vi.fn();
    const downloads: Array<{ href: string; filename: string }> = [];
    const anchorClick = vi.fn(function (this: HTMLAnchorElement) {
      downloads.push({ href: this.href, filename: this.download });
    });
    const createdBlobs: Blob[] = [];
    replaceProperty(URL, "createObjectURL", createObjectURL);
    replaceProperty(URL, "revokeObjectURL", revokeObjectURL);
    replaceProperty(window, "print", printed);
    replaceProperty(HTMLAnchorElement.prototype, "click", anchorClick);
    const snapshot = dashboardSnapshot("=1+1");
    const { user } = await renderDashboard(snapshot);

    await user.click(screen.getByText("Export").closest("summary")!);
    await user.click(screen.getByRole("button", { name: "Print incident brief" }));
    expect(printed).toHaveBeenCalledOnce();
    expect(document.querySelector(".print-brief")).toHaveTextContent("Aegis Campus Safety Exercise · Incident brief");
    expect(document.querySelector(".print-brief")).toHaveTextContent("RPT-001");

    await user.click(screen.getByRole("button", { name: "Download JSON" }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createdBlobs[0]?.type).toBe("application/json;charset=utf-8");
    expect(JSON.parse(await createdBlobs[0]!.text()).incidents[0].title).toBe("=1+1");
    expect(downloads[0]).toEqual({ href: "blob:brief-1", filename: "aegis-event-demo-brief.json" });
    expect(revokeObjectURL).toHaveBeenNthCalledWith(1, "blob:brief-1");

    await user.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(createdBlobs[1]?.type).toBe("text/csv;charset=utf-8");
    expect(await createdBlobs[1]!.text()).toContain("incident-001,INC-001,'=1+1,P0");
    expect(downloads[1]).toEqual({ href: "blob:brief-2", filename: "aegis-event-demo-brief.csv" });
    expect(revokeObjectURL).toHaveBeenNthCalledWith(2, "blob:brief-2");
  });

  it("moves through queue groups with j/k, switches views, and handles an empty queue safely", async () => {
    const snapshot = multiLocationSnapshot();
    const { container, user } = await renderDashboard(snapshot);
    const page = container.querySelector(".dashboard-page")!;
    const inspector = screen.getByRole("region", { name: "Incident inspector" });

    const search = screen.getByRole("searchbox", { name: "Search incidents by title, ID, report text, or location" });
    fireEvent.keyDown(page, { key: "/" });
    expect(document.activeElement).toBe(search);
    search.blur();
    fireEvent.keyDown(page, { key: "/", ctrlKey: true });
    expect(document.activeElement).not.toBe(search);

    fireEvent.keyDown(page, { key: "j" });
    expect(within(inspector).getByRole("heading", { name: "Second Main Stage group" })).toBeInTheDocument();
    fireEvent.keyDown(page, { key: "k" });
    expect(within(inspector).getByRole("heading", { name: "Guest collapsed near Main Stage" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Map" }));
    expect(screen.getByRole("button", { name: "Map" })).toHaveAttribute("aria-pressed", "true");
    expect(new URLSearchParams(window.location.search).get("view")).toBe("map");
    await user.click(screen.getByRole("button", { name: "Queue" }));
    expect(screen.getByRole("button", { name: "Queue" })).toHaveAttribute("aria-pressed", "true");

    const empty = dashboardSnapshot();
    empty.incidents = [];
    empty.reports = [];
    empty.counts = { reports: 0, incidents: 0, review: 0, conflicts: 0 };
    useSnapshotMock.mockReturnValue(stateFor(empty));
    cleanup();
    const emptyView = render(<DashboardPage />);
    await screen.findByText("No incidents match this filter.");
    fireEvent.keyDown(emptyView.container.querySelector(".dashboard-page")!, { key: "j" });
    expect(screen.getByRole("region", { name: "Incident inspector" })).toHaveTextContent("Select a provisional group");
  });

  it("opens a map cluster by keyboard, selects a group, and filters to unlocated groups", async () => {
    const { user } = await renderDashboard(multiLocationSnapshot());
    await user.click(screen.getByRole("button", { name: "Map" }));

    const cluster = screen.getByRole("button", { name: "Main Stage, 2 incident groups" });
    cluster.focus();
    await user.keyboard("{Enter}");
    const groups = screen.getByLabelText("Groups in Main Stage");
    await user.click(within(groups).getByRole("button", { name: /Second Main Stage group/ }));
    expect(screen.getByRole("heading", { name: "Second Main Stage group" })).toBeInTheDocument();

    cluster.focus();
    await user.keyboard(" ");
    expect(screen.queryByLabelText("Groups in Main Stage")).not.toBeInTheDocument();
    cluster.focus();
    await user.keyboard(" ");
    expect(screen.getByLabelText("Groups in Main Stage")).toBeInTheDocument();
    await user.click(cluster);
    expect(screen.queryByLabelText("Groups in Main Stage")).not.toBeInTheDocument();
    await user.click(cluster);
    expect(screen.getByLabelText("Groups in Main Stage")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Unlocated reports/ }));
    const queue = screen.getByRole("region", { name: "Incident queue" });
    expect(within(queue).getByText("Unlocated alarm group")).toBeInTheDocument();
    expect(within(queue).queryByText("Guest collapsed near Main Stage")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Filter by zone" })).toHaveValue("unlocated");
  });

  it("changes the zone and sort controls and leaves workspace arrow navigation alone", async () => {
    const snapshot = multiLocationSnapshot();
    const { container, user } = await renderDashboard(snapshot);
    const mapTab = screen.getByRole("button", { name: "Map" });
    await user.click(mapTab);
    for (const key of ["ArrowDown", "ArrowUp"]) {
      const arrow = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      mapTab.dispatchEvent(arrow);
      expect(arrow.defaultPrevented).toBe(false);
    }
    expect(document.activeElement).toBe(mapTab);
    expect(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Guest collapsed near Main Stage/ }).closest("article")).toHaveAttribute("aria-current", "true");

    const zone = screen.getByRole("combobox", { name: "Filter by zone" });
    await user.selectOptions(zone, "stage");
    expect(zone).toHaveValue("stage");
    const sort = screen.getByRole("combobox", { name: "Sort incidents" });
    await user.selectOptions(sort, "latest_report");
    expect(sort).toHaveValue("latest_report");
    const queue = screen.getByRole("region", { name: "Incident queue" });
    const titles = Array.from(queue.querySelectorAll(".incident-row-title")).map((row) => row.childNodes[0]?.textContent);
    expect(titles).toEqual(["Second Main Stage group", "Guest collapsed near Main Stage"]);
    expect(within(queue).queryByText("Unlocated alarm group")).not.toBeInTheDocument();

    const search = screen.getByRole("searchbox", { name: "Search incidents by title, ID, report text, or location" });
    search.remove();
    const slash = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
    container.querySelector(".dashboard-page")!.dispatchEvent(slash);
    expect(slash.defaultPrevented).toBe(false);
  });

  it("ignores a source phrase click after its source report leaves the document", async () => {
    await renderDashboard();
    const sourceReport = document.getElementById("source-report-report-001")!;
    const focus = vi.spyOn(sourceReport, "focus");
    const link = screen.getByRole("button", { name: "Show priority source phrase from RPT-001" });

    fireEvent.click(link);
    sourceReport.remove();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(document.getElementById("source-report-report-001")).toBeNull();
    expect(focus).not.toHaveBeenCalled();
  });

  it("uses the last visible group for reverse navigation before selection is initialized", async () => {
    const snapshot = multiLocationSnapshot();
    const writes: string[] = [];
    let deliveredEarlyKey = false;
    const fakeStorage = {
      getItem(key: string) {
        if (key === `aegis.dashboard.view.v1:${eventFixture.id}` && !deliveredEarlyKey) {
          const page = document.querySelector<HTMLElement>(".dashboard-page");
          if (page) {
            deliveredEarlyKey = true;
            page.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
          }
        }
        return null;
      },
      setItem(_key: string, value: string) { writes.push(value); },
    };
    replaceProperty(window, "localStorage", fakeStorage);
    useSnapshotMock.mockReturnValue(stateFor(snapshot));

    render(<DashboardPage />);
    await screen.findByRole("heading", { name: snapshot.incidents[0]!.title });

    expect(deliveredEarlyKey).toBe(true);
    expect(writes.some((value) => JSON.parse(value)[`${eventFixture.id}:incident-003`])).toBe(true);
  });

  it("clears contextual group selection and closes the inspector on Escape", async () => {
    const { container, user } = await renderDashboard(multiLocationSnapshot());
    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Guest collapsed near Main Stage/ }));
    const checkbox = screen.getByRole("checkbox", { name: "Select Guest collapsed near Main Stage for a group action" });
    await user.click(checkbox);
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Select Second Main Stage group for a group action" }));
    await user.click(screen.getByRole("button", { name: "Merge 2 selected groups" }));
    expect(screen.getByRole("textbox", { name: "Coordinator reason" })).toBeInTheDocument();

    fireEvent.keyDown(container.querySelector(".dashboard-page")!, { key: "Escape" });
    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select Guest collapsed near Main Stage for a group action" })).not.toBeChecked();
    expect(screen.queryByRole("textbox", { name: "Coordinator reason" })).not.toBeInTheDocument();
    expect(container.querySelector(".workspace-grid")).toHaveClass("is-inspector-closed");
  });

  it("routes each summary card to its matching queue filter and applies the status select", async () => {
    const snapshot = multiLocationSnapshot();
    const reviewGroup = snapshot.incidents[1]!;
    snapshot.incidents[1] = {
      ...reviewGroup,
      review_required: true,
      review_reasons: ["Coordinator review requested."],
      conflicts: [{ ...conflictFixture, report_ids: reviewGroup.report_ids, status: "unresolved" }],
    };
    const { user } = await renderDashboard(snapshot);
    const summaryFilters: Array<[RegExp, string]> = [
      [/Reports received/, "All"],
      [/Provisional groups/, "Active"],
      [/Awaiting review/, "Review"],
      [/Unresolved conflicts/, "Conflicts"],
    ];

    for (const [cardName, filterName] of summaryFilters) {
      await user.click(screen.getByRole("button", { name: cardName }));
      expect(screen.getByRole("button", { name: filterName })).toHaveAttribute("aria-pressed", "true");
    }

    const queue = screen.getByRole("region", { name: "Incident queue" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by status" }), "resolved");
    expect(within(queue).getByText("No incidents match this filter.")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by status" }), "open");
    expect(within(queue).getByText("Second Main Stage group")).toBeInTheDocument();
  });

  it("closes and reopens the inspector and reports reconnecting provider state", async () => {
    const snapshot = dashboardSnapshot();
    const provider = stateFor(snapshot);
    provider.reconnecting = true;
    provider.lastUpdated = Date.parse("2026-10-25T00:00:00Z");
    useSnapshotMock.mockReturnValue(provider);
    const user = userEvent.setup();
    const { container } = render(<DashboardPage />);
    await screen.findByRole("heading", { name: snapshot.incidents[0]!.title });
    expect(screen.getByText("Reconnecting")).toHaveClass("is-stale");

    await user.click(within(screen.getByRole("region", { name: "Incident queue" })).getByRole("button", { name: /Guest collapsed near Main Stage/ }));
    expect(container.querySelector(".workspace-grid")).toHaveClass("is-inspector-open");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(container.querySelector(".workspace-grid")).toHaveClass("is-inspector-closed");
    await user.click(screen.getByRole("button", { name: "Open incident inspector" }));
    expect(container.querySelector(".workspace-grid")).toHaveClass("is-inspector-open");
  });

  it("shows loading and unavailable connection states and retries refresh", async () => {
    const loadingState = stateFor(null);
    loadingState.loading = true;
    useSnapshotMock.mockReturnValue(loadingState);
    render(<DashboardPage />);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to the exercise workspace");

    cleanup();
    const unavailableState = stateFor(null);
    unavailableState.error = "No active exercise.";
    useSnapshotMock.mockReturnValue(unavailableState);
    const user = userEvent.setup();
    render(<DashboardPage />);
    expect(screen.getByText("No active exercise.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry connection" }));
    expect(unavailableState.refresh).toHaveBeenCalledOnce();
  });

  it("retries failed report analysis, applies the returned snapshot, and reports API failures", async () => {
    const snapshot = incompleteAnalysisSnapshot("failed");
    snapshot.reports[0] = { ...snapshot.reports[0]!, analysis_status: "pending" };
    const nextSnapshot = { ...snapshot, incidents: snapshot.incidents.map((incident) => ({ ...incident, version: 8 })) };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => nextSnapshot } as Response)
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: { code: "analysis_unavailable", message: "Analysis service is unavailable." } }) } as Response);
    replaceProperty(globalThis, "fetch", fetchMock);
    const { user, state } = await renderDashboard(snapshot);
    const sourceReports = screen.getByText("Source reports").closest("summary")!;

    await user.click(screen.getByRole("button", { name: "Retry failed analysis" }));
    expect(await screen.findByText("Report analysis retry requested.")).toBeInTheDocument();
    expect(state.applySnapshot).toHaveBeenCalledWith(nextSnapshot);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/reports/report-002/retry", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ expected_version: 7 }),
    }));

    await user.click(sourceReports);
    await user.click(sourceReports);
    await user.click(screen.getByRole("button", { name: "Retry pending analysis" }));
    expect(await screen.findByText("Analysis service is unavailable.")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/reports/report-001/retry", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ expected_version: 7 }),
    }));
  });
});
