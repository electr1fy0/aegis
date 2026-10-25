// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SnapshotProvider, useSnapshot } from "../hooks/use-snapshot";
import { getEvents, getSnapshot } from "../lib/api";
import type { EventInfo, Snapshot } from "../lib/types";
import type { SnapshotState } from "../hooks/use-snapshot";
import { DashboardPage } from "../pages/dashboard-page";
import { eventFixture, makeIncident, makeSnapshot, snapshotFixture } from "./fixtures";

const snapshotHookOverride = vi.hoisted(() => ({ state: undefined as unknown }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, getEvents: vi.fn(), getSnapshot: vi.fn() };
});

vi.mock("../hooks/use-snapshot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/use-snapshot")>();
  return {
    ...actual,
    useSnapshot: vi.fn(() => snapshotHookOverride.state === undefined
      ? actual.useSnapshot()
      : snapshotHookOverride.state),
  };
});

const getEventsMock = vi.mocked(getEvents);
const getSnapshotMock = vi.mocked(getSnapshot);
let dashboardStorage: Map<string, string>;

function installStorage(options: { failReads?: boolean; failWrites?: boolean } = {}): void {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      get length() { return dashboardStorage.size; },
      clear: () => dashboardStorage.clear(),
      getItem: (key: string) => {
        if (options.failReads) throw new Error("Storage is blocked");
        return dashboardStorage.get(key) ?? null;
      },
      key: (index: number) => [...dashboardStorage.keys()][index] ?? null,
      removeItem: (key: string) => dashboardStorage.delete(key),
      setItem: (key: string, value: string) => {
        if (options.failWrites) throw new Error("Storage is blocked");
        dashboardStorage.set(key, String(value));
      },
    } satisfies Storage,
  });
}

function renderDashboard(): ReturnType<typeof render> {
  return render(
    <SnapshotProvider>
      <DashboardPage />
    </SnapshotProvider>,
  );
}

function EventSwitchingDashboard() {
  const { selectEvent } = useSnapshot();
  return (
    <>
      <button type="button" onClick={() => selectEvent("event-older")}>Visit older event</button>
      <button type="button" onClick={() => selectEvent(eventFixture.id)}>Return to demo event</button>
      <DashboardPage />
    </>
  );
}

function DashboardAfterSnapshot() {
  const { snapshot } = useSnapshot();
  return snapshot ? (
    <StrictMode>
      <DashboardPage />
    </StrictMode>
  ) : <div>Waiting for the snapshot.</div>;
}

function eventSnapshot(event: EventInfo): Snapshot {
  return makeSnapshot({
    event,
    incidents: snapshotFixture.incidents.map((incident) => ({ ...incident, event_id: event.id })),
    reports: snapshotFixture.reports.map((report) => ({ ...report, event_id: event.id })),
  });
}

function snapshotState(snapshot: Snapshot | null, error: string | null = null): SnapshotState {
  return {
    snapshot,
    loading: false,
    error,
    refresh: vi.fn(async () => undefined),
    applySnapshot: vi.fn(),
    events: snapshot ? [snapshot.event] : [],
    selectedEventId: snapshot?.event.id,
    selectEvent: vi.fn(),
    lastUpdated: null,
    reconnecting: false,
  };
}

beforeEach(() => {
  window.history.replaceState({}, "", "/dashboard");
  window.sessionStorage.clear();
  dashboardStorage = new Map();
  installStorage();
  getEventsMock.mockReset();
  getSnapshotMock.mockReset();
  snapshotHookOverride.state = undefined;
  getEventsMock.mockResolvedValue([eventFixture]);
  getSnapshotMock.mockResolvedValue(makeSnapshot());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("dashboard saved state", () => {
  it("restores the URL-selected event's queue view, selected incident, scroll, and read reports", async () => {
    const olderEvent: EventInfo = {
      ...eventFixture,
      id: "event-older",
      created_at: "2026-10-24T15:00:00Z",
    };
    window.history.replaceState({}, "", `/dashboard?event=${olderEvent.id}`);
    getEventsMock.mockResolvedValue([eventFixture, olderEvent]);
    getSnapshotMock.mockImplementation(async (eventId) => eventSnapshot(eventId === olderEvent.id ? olderEvent : eventFixture));

    dashboardStorage.set(`aegis.dashboard.view.v1:${eventFixture.id}`, JSON.stringify({
      criteria: { query: "missing-from-older-event", filter: "all", priority: "all", status: "all", zone: "all", sort: "priority" },
      view: "queue",
      queueScroll: 0,
    }));
    dashboardStorage.set(`aegis.dashboard.view.v1:${olderEvent.id}`, JSON.stringify({
      incidentId: "incident-001",
      criteria: { query: "Guest", filter: "all", priority: "all", status: "all", zone: "all", sort: "latest_report" },
      view: "queue",
      queueScroll: 36,
    }));
    dashboardStorage.set("aegis.dashboard.read-reports.v1", JSON.stringify({
      [`${eventFixture.id}:incident-001`]: ["report-001", "report-002"],
      [`${olderEvent.id}:incident-001`]: ["report-001"],
    }));

    renderDashboard();

    const queue = await screen.findByRole("region", { name: "Incident queue" });
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search incidents by title, ID, report text, or location" })).toHaveValue("Guest"));
    expect(screen.getByRole("combobox", { name: "Sort incidents" })).toHaveValue("latest_report");
    expect(within(queue).getByRole("button", { name: /Guest collapsed near Main Stage/ }).closest(".incident-row")).toHaveAttribute("aria-current", "true");
    expect(within(queue).getByText("1 new")).toBeInTheDocument();
    expect(screen.getByLabelText("Incidents matching queue filters")).toHaveProperty("scrollTop", 36);
    expect(new URLSearchParams(window.location.search).get("event")).toBe(olderEvent.id);

    fireEvent.scroll(screen.getByLabelText("Incidents matching queue filters"));
    await waitFor(() => {
      expect(JSON.parse(dashboardStorage.get(`aegis.dashboard.view.v1:${olderEvent.id}`) ?? "{}")).toMatchObject({
        queueScroll: 36,
        criteria: { query: "Guest" },
      });
    });
    expect(JSON.parse(dashboardStorage.get(`aegis.dashboard.view.v1:${eventFixture.id}`) ?? "{}")).toMatchObject({
      criteria: { query: "missing-from-older-event" },
    });
  });

  it("marks a restored event's report membership as read without changing another event's state", async () => {
    const olderEvent: EventInfo = { ...eventFixture, id: "event-older" };
    window.history.replaceState({}, "", `/dashboard?event=${olderEvent.id}`);
    getEventsMock.mockResolvedValue([eventFixture, olderEvent]);
    getSnapshotMock.mockImplementation(async (eventId) => eventSnapshot(eventId === olderEvent.id ? olderEvent : eventFixture));
    dashboardStorage.set("aegis.dashboard.read-reports.v1", JSON.stringify({
      [`${eventFixture.id}:incident-001`]: ["report-001", "report-002"],
      [`${olderEvent.id}:incident-001`]: ["report-001"],
    }));

    renderDashboard();

    const queue = await screen.findByLabelText("Incidents matching queue filters");
    const row = within(queue).getByRole("button", { name: /Guest collapsed near Main Stage/ });
    expect(within(row).getByText("1 new")).toBeInTheDocument();
    fireEvent.click(row);
    await waitFor(() => expect(within(row).queryByText("1 new")).not.toBeInTheDocument());

    const savedReadState = JSON.parse(dashboardStorage.get("aegis.dashboard.read-reports.v1") ?? "{}") as Record<string, string[]>;
    expect(savedReadState[`${olderEvent.id}:incident-001`]).toEqual(["report-001", "report-002"]);
    expect(savedReadState[`${eventFixture.id}:incident-001`]).toEqual(["report-001", "report-002"]);
  });

  it("ignores corrupt saved view JSON and still opens the queue", async () => {
    dashboardStorage.set(`aegis.dashboard.view.v1:${eventFixture.id}`, "{");
    renderDashboard();

    expect(await screen.findByRole("heading", { name: "Incident queue" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search incidents by title, ID, report text, or location" })).toHaveValue("");
  });

  it("revisits each event's saved dashboard state without seeding read-state twice", async () => {
    const olderEvent: EventInfo = {
      ...eventFixture,
      id: "event-older",
      created_at: "2026-10-23T15:00:00Z",
    };
    window.history.replaceState({}, "", `/dashboard?event=${eventFixture.id}`);
    getEventsMock.mockResolvedValue([eventFixture, olderEvent]);
    getSnapshotMock.mockImplementation(async (eventId) => eventSnapshot(eventId === olderEvent.id ? olderEvent : eventFixture));
    dashboardStorage.set(`aegis.dashboard.view.v1:${eventFixture.id}`, JSON.stringify({
      criteria: { query: "Guest", filter: "all", priority: "all", status: "all", zone: "all", sort: "priority" },
      view: "queue",
    }));
    dashboardStorage.set(`aegis.dashboard.view.v1:${olderEvent.id}`, JSON.stringify({
      criteria: { query: "nothing-matches", filter: "all", priority: "all", status: "all", zone: "all", sort: "priority" },
      view: "queue",
    }));

    render(
      <SnapshotProvider>
        <EventSwitchingDashboard />
      </SnapshotProvider>,
    );
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search incidents by title, ID, report text, or location" })).toHaveValue("Guest"));

    fireEvent.click(screen.getByRole("button", { name: "Visit older event" }));
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search incidents by title, ID, report text, or location" })).toHaveValue("nothing-matches"));
    expect(screen.getByText("No incidents match this filter.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Return to demo event" }));
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search incidents by title, ID, report text, or location" })).toHaveValue("Guest"));
    expect(within(screen.getByLabelText("Incidents matching queue filters")).getByRole("button", { name: /Guest collapsed near Main Stage/ })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("event")).toBe(eventFixture.id);
  });

  it("recovers a deep-linked resolved incident by relaxing the active-only filter", async () => {
    const resolved = makeIncident({
      id: "incident-resolved",
      title: "Previously resolved venue issue",
      status: "resolved",
      report_ids: [],
    });
    getSnapshotMock.mockResolvedValue(makeSnapshot({ incidents: [resolved], reports: [] }));
    window.history.replaceState({}, "", `/dashboard?event=${eventFixture.id}&incident=${resolved.id}&queue=active`);

    renderDashboard();

    expect(await screen.findByRole("heading", { name: resolved.title })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true"));
    expect(within(screen.getByLabelText("Incidents matching queue filters")).getByRole("button", { name: /Previously resolved venue issue/ })).toBeInTheDocument();
  });

  it("restores and saves inspector scroll for the selected incident", async () => {
    const key = `aegis.dashboard.inspector.v1:${eventFixture.id}:incident-001`;
    window.history.replaceState({}, "", `/dashboard?event=${eventFixture.id}&incident=incident-001`);
    dashboardStorage.set(key, "48");
    renderDashboard();

    await screen.findByRole("heading", { name: "Guest collapsed near Main Stage" });
    const inspector = document.querySelector(".inspector-panel .inspector-content");
    expect(inspector).not.toBeNull();
    await waitFor(() => expect(inspector).toHaveProperty("scrollTop", 48));
    Object.defineProperty(inspector, "scrollTop", { configurable: true, value: 73, writable: true });
    fireEvent.scroll(inspector!);
    expect(dashboardStorage.get(key)).toBe("73");
  });

  it("handles a queue scroll event after its saved dashboard entry was removed", async () => {
    renderDashboard();
    const queue = await screen.findByLabelText("Incidents matching queue filters");
    const key = `aegis.dashboard.view.v1:${eventFixture.id}`;
    dashboardStorage.delete(key);
    Object.defineProperty(queue, "scrollTop", { configurable: true, value: 19, writable: true });

    fireEvent.scroll(queue);

    expect(JSON.parse(dashboardStorage.get(key) ?? "{}")).toMatchObject({ queueScroll: 19 });
  });

  it("ignores malformed read-report storage instead of treating it as a report map", async () => {
    dashboardStorage.set("aegis.dashboard.read-reports.v1", "[]");
    renderDashboard();

    expect(await screen.findByRole("heading", { name: "Incident queue" })).toBeInTheDocument();
    await waitFor(() => expect(JSON.parse(dashboardStorage.get("aegis.dashboard.read-reports.v1") ?? "{}")).toHaveProperty(`${eventFixture.id}:incident-001`));
  });

  it("drops read-report entries whose values are not string arrays", async () => {
    dashboardStorage.set("aegis.dashboard.read-reports.v1", JSON.stringify({
      [`${eventFixture.id}:bad-shape`]: "report-001",
      [`${eventFixture.id}:bad-item`]: ["report-001", 17],
    }));
    renderDashboard();

    expect(await screen.findByRole("heading", { name: "Incident queue" })).toBeInTheDocument();
    await waitFor(() => {
      const saved = JSON.parse(dashboardStorage.get("aegis.dashboard.read-reports.v1") ?? "{}") as Record<string, unknown>;
      expect(saved).not.toHaveProperty(`${eventFixture.id}:bad-shape`);
      expect(saved).not.toHaveProperty(`${eventFixture.id}:bad-item`);
      expect(saved).toHaveProperty(`${eventFixture.id}:incident-001`);
    });
  });

  it("shows the generic unavailable message when there is no snapshot or backend error", () => {
    snapshotHookOverride.state = snapshotState(null);
    render(<DashboardPage />);

    expect(screen.getByText("The backend has not returned a current event snapshot.")).toBeInTheDocument();
  });

  it("keeps technical matcher metadata out of the dashboard toolbar", async () => {
    const health = { ...snapshotFixture.health, model_revision: undefined } as unknown as Snapshot["health"];
    const snapshot = makeSnapshot({ health });
    snapshotHookOverride.state = snapshotState(snapshot);
    const { container } = render(<DashboardPage />);

    await screen.findByRole("heading", { name: "Incident queue" });
    expect(container.querySelector(".matcher-label")).not.toBeInTheDocument();
  });

  it("keeps the report section closed when the selected incident has no unread reports", async () => {
    window.history.replaceState({}, "", `/dashboard?event=${eventFixture.id}&incident=incident-001`);
    dashboardStorage.set("aegis.dashboard.read-reports.v1", JSON.stringify({
      [`${eventFixture.id}:incident-001`]: snapshotFixture.incidents[0]!.report_ids,
    }));
    snapshotHookOverride.state = snapshotState(makeSnapshot());
    render(<DashboardPage />);

    await screen.findByRole("heading", { name: "Guest collapsed near Main Stage" });
    expect(screen.queryByText("New", { exact: true })).not.toBeInTheDocument();
  });

  it("restores an invalid saved inspector scroll as zero", async () => {
    const second = makeIncident({
      id: "incident-002",
      title: "Secondary incident",
      priority: "P2",
      suggested_priority: "P2",
      report_ids: [],
      evidence: [],
      conflicts: [],
    });
    getSnapshotMock.mockResolvedValue(makeSnapshot({ incidents: [...snapshotFixture.incidents, second] }));
    dashboardStorage.set(`aegis.dashboard.inspector.v1:${eventFixture.id}:${second.id}`, "not-a-number");
    renderDashboard();

    await screen.findByRole("heading", { name: "Guest collapsed near Main Stage" });
    const inspector = document.querySelector(".inspector-panel .inspector-content");
    expect(inspector).not.toBeNull();
    Object.defineProperty(inspector, "scrollTop", { configurable: true, value: 23, writable: true });
    fireEvent.click(within(screen.getByLabelText("Incidents matching queue filters")).getByRole("button", { name: /Secondary incident/ }));

    await screen.findByRole("heading", { name: "Secondary incident" });
    await waitFor(() => expect(inspector).toHaveProperty("scrollTop", 0));
  });

  it("renders a safe initial dashboard state during server rendering", () => {
    vi.stubGlobal("window", undefined);
    try {
      expect(renderToStaticMarkup(<DashboardPage />)).toContain("Connecting to the exercise workspace");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps explicit query state when StrictMode replays event hydration", async () => {
    window.history.replaceState({}, "", `/dashboard?event=${eventFixture.id}&incident=incident-001&queue=all&view=queue`);
    dashboardStorage.set(`aegis.dashboard.view.v1:${eventFixture.id}`, JSON.stringify({
      incidentId: "incident-001",
      criteria: { query: "stored-view-must-not-win", filter: "all", priority: "all", status: "all", zone: "all", sort: "priority" },
      view: "map",
    }));

    render(
      <SnapshotProvider>
        <DashboardAfterSnapshot />
      </SnapshotProvider>,
    );

    expect(await screen.findByRole("searchbox", { name: "Search incidents by title, ID, report text, or location" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Queue" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(new URLSearchParams(window.location.search).get("incident")).toBe("incident-001");
  });

  it("keeps the queue usable when storage reads and writes fail during restore and scroll", async () => {
    installStorage({ failReads: true, failWrites: true });
    renderDashboard();

    const queue = await screen.findByLabelText("Incidents matching queue filters");
    Object.defineProperty(queue, "scrollTop", { configurable: true, value: 22, writable: true });
    expect(() => fireEvent.scroll(queue)).not.toThrow();
    expect(screen.getByRole("heading", { name: "Incident queue" })).toBeInTheDocument();
    expect(within(queue).getByRole("button", { name: /Guest collapsed near Main Stage/ })).toBeInTheDocument();
  });

  it("shows the empty queue state when a saved search excludes every incident", async () => {
    dashboardStorage.set(`aegis.dashboard.view.v1:${eventFixture.id}`, JSON.stringify({
      criteria: { query: "no incident matches this text", filter: "all", priority: "all", status: "all", zone: "all", sort: "priority" },
      view: "queue",
      queueScroll: 24,
    }));
    renderDashboard();

    expect(await screen.findByText("No incidents match this filter.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Incidents matching queue filters")).not.toBeInTheDocument();
  });

  it("renders the empty state for an event with no incident rows", async () => {
    getSnapshotMock.mockResolvedValue(makeSnapshot({
      incidents: [],
      reports: [],
      audit: [],
      counts: { reports: 0, incidents: 0, review: 0, conflicts: 0 },
    }));
    renderDashboard();

    expect(await screen.findByText("No incidents match this filter.")).toBeInTheDocument();
    expect(screen.getByText("Select a provisional group")).toBeInTheDocument();
    expect(screen.queryByLabelText("Incidents matching queue filters")).not.toBeInTheDocument();
  });
});
