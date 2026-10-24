// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRootRoute,
  createMemoryHistory,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Input } from "../components/ui/input";
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "../components/ui/native-select";
import { Textarea } from "../components/ui/textarea";
import { AppFrame } from "../components/app-frame";
import * as format from "../lib/format";
import { getSnapshot } from "../lib/api";
import type { Snapshot } from "../lib/types";
import { getRouter } from "../router";
import { AboutPage } from "../pages/about-page";
import { Route as rootRoute } from "../routes/__root";
import { Route as indexRoute } from "../routes/index";
import { Route as dashboardRoute } from "../routes/dashboard";
import { Route as reportRoute } from "../routes/report";
import { Route as evaluationRoute } from "../routes/evaluation";
import { Route as aboutRoute } from "../routes/about";
import { healthFixture, snapshotFixture } from "./fixtures";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, getSnapshot: vi.fn() };
});

const getSnapshotMock = vi.mocked(getSnapshot);
const histories: Array<{ destroy: () => void }> = [];

function trackHistory<TRouter extends { history: { destroy: () => void } }>(router: TRouter): TRouter {
  histories.push(router.history);
  return router;
}

const testRootRoute = createRootRoute({ component: () => <AppFrame><Outlet /></AppFrame> });
const testIndexRoute = createRoute({ getParentRoute: () => testRootRoute, path: "/", component: () => <div>Test home</div> });
const testDashboardRoute = createRoute({ getParentRoute: () => testRootRoute, path: "dashboard", component: () => <div>Test operations</div> });
const testReportRoute = createRoute({ getParentRoute: () => testRootRoute, path: "report", component: () => <div>Test report</div> });
const testEvaluationRoute = createRoute({ getParentRoute: () => testRootRoute, path: "evaluation", component: () => <div>Test evaluation</div> });
const testAboutRoute = createRoute({ getParentRoute: () => testRootRoute, path: "about", component: AboutPage });
const testRouteTree = testRootRoute.addChildren([
  testIndexRoute,
  testDashboardRoute,
  testReportRoute,
  testEvaluationRoute,
  testAboutRoute,
]);

function makeRouter(initialEntry = "/about") {
  return trackHistory(createRouter({
    routeTree: testRouteTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  getSnapshotMock.mockReset();
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  for (const history of histories.splice(0)) history.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("format helpers", () => {
  it("formats missing, invalid, valid, zoned, and invalid-zone timestamps", () => {
    expect(format.formatClock(null)).toBe("Not reported");
    expect(format.formatClock("not a date")).toBe("not a date");
    expect(format.formatClock("2026-10-24T16:02:00Z")).not.toBe("2026-10-24T16:02:00Z");
    expect(format.formatClock("2026-10-24T16:02:00Z", "America/Los_Angeles")).not.toBe("Not reported");
    expect(format.formatClock("2026-10-24T16:02:00Z", "Invalid/Zone")).not.toBe("Not reported");

    expect(format.formattedTime(undefined)).toBe("Not reported");
    expect(format.formattedTime("not a date")).toBe("not a date");
    expect(format.formattedTime("2026-10-24T16:02:00Z")).not.toBe("2026-10-24T16:02:00Z");
    expect(format.formattedTime("2026-10-24T16:02:00Z", "America/Los_Angeles")).not.toBe("Not reported");
    expect(format.formattedTime("2026-10-24T16:02:00Z", "Invalid/Zone")).not.toBe("Not reported");
  });

  it("covers elapsed-time ranges and invalid timestamps", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    expect(format.formatAge("bad time", now)).toBe("Time unavailable");
    expect(format.formatAge("2026-10-25T12:01:00Z", now)).toBe("Just now");
    expect(format.formatAge("2026-10-25T11:59:00Z", now)).toBe("1m ago");
    expect(format.formatAge("2026-10-25T11:00:00Z", now)).toBe("1h ago");
    expect(format.formatAge("2026-10-24T12:00:00Z", now)).toBe("1d ago");
  });

  it("formats every priority, zone, status, and engine-state branch", () => {
    expect(format.priorityLabel("P0")).toBe("P0 · Immediate");
    expect(format.priorityLabel("P1")).toBe("P1 · High");
    expect(format.priorityLabel("P2")).toBe("P2 · Standard");
    expect(format.priorityLabel("UNASSESSED")).toBe("Unassessed");
    expect(format.zoneLabel(null, [])).toBe("Unlocated");
    expect(format.zoneLabel("stage", [{ id: "stage", label: "Main Stage", x: 0, y: 0 }])).toBe("Main Stage");
    expect(format.zoneLabel("missing", [])).toBe("Unknown zone");
    expect(format.displayStatus("priority_override-recorded")).toBe("Priority Override Recorded");

    expect(format.engineLabel({ ...healthFixture, engine: "semantic", model_ready: false })).toBe("semantic · degraded");
    expect(format.engineLabel({ ...healthFixture, engine: "", model_ready: false })).toBe("Matching engine · degraded");
    expect(format.engineLabel({ ...healthFixture, engine: "lexical", model_ready: true })).toBe("lexical · fallback");
    expect(format.engineLabel({ ...healthFixture, engine: "", model_ready: true })).toBe("Matching engine ready");
    expect(format.engineLabel({ ...healthFixture, engine: "semantic", model_ready: true })).toBe("semantic");
    expect(format.engineLabel({ ...healthFixture, engine: "lexical", model_ready: true })).toBe("lexical · fallback");
  });

  it("orders and filters incidents, audit entries, reports, and map points", () => {
    const resolved = { ...snapshotFixture.incidents[0]!, status: "resolved" as const };
    expect(format.activeIncidents([snapshotFixture.incidents[0]!, resolved])).toEqual([snapshotFixture.incidents[0]]);

    const sorted = format.latestAuditFirst([
      { ...snapshotFixture.audit[0]!, seq: 1, created_at: "2026-10-25T12:00:00Z" },
      { ...snapshotFixture.audit[0]!, id: "later-seq", seq: 2 },
      { ...snapshotFixture.audit[0]!, id: "same-seq-later-time", seq: 1, created_at: "2026-10-25T13:00:00Z" },
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["later-seq", "same-seq-later-time", "audit-001"]);

    const reports = [
      { ...snapshotFixture.reports[0]!, reported_at: null, received_at: "2026-10-24T16:02:04Z" },
      { ...snapshotFixture.reports[1]!, id: "bad-time", reported_at: "invalid", received_at: "invalid" },
    ];
    const incident = { ...snapshotFixture.incidents[0]!, report_ids: [reports[0]!.id, reports[1]!.id, "absent"] };
    expect(format.incidentReports(incident, reports)).toHaveLength(2);
    expect(format.firstReportTime(incident, reports)).toBe("2026-10-24T16:02:04.000Z");
    expect(format.firstReportTime({ ...incident, report_ids: [] }, reports)).toBe(incident.created_at);

    expect(format.incidentMapPoint(snapshotFixture.incidents[0]!, [{ id: "stage", label: "Stage", x: 9, y: 7 }]))
      .toEqual({ x: 9, y: 7 });
    expect(format.incidentMapPoint({ ...incident, zone_id: "missing" }, [])).toBeNull();
  });

  it("normalizes previews and handles every evidence-score value class", () => {
    expect(format.reportTextPreview("  line  one\n  line two  ")).toBe("line one line two");
    expect(format.reportTextPreview("short", 10)).toBe("short");
    expect(format.reportTextPreview("abcdefgh", 5)).toBe("abcd…");
    expect(format.reportTextPreview("abc", 0)).toBe("…");
    expect(format.evidenceScore(null)).toBe("—");
    expect(format.evidenceScore(Number.NaN)).toBe("—");
    expect(format.evidenceScore(0.873)).toBe("87%");
  });
});

describe("raw UI primitives", () => {
  it("renders every badge variant and forwards classes and accessibility attributes", () => {
    const { container } = render(
      <div>
        <Badge>Default badge</Badge>
        <Badge variant="secondary">Secondary badge</Badge>
        <Badge variant="outline">Outline badge</Badge>
        <Badge variant="destructive" className="extra-badge" aria-label="Destructive">Destructive badge</Badge>
      </div>,
    );
    expect(container.querySelectorAll('[data-slot="badge"]')).toHaveLength(4);
    expect(screen.getByLabelText("Destructive")).toHaveClass("extra-badge", "cn-badge-variant-destructive");
  });

  it("renders the native button variant and size matrix", () => {
    const variants = ["default", "outline", "secondary", "ghost", "destructive", "link"] as const;
    const sizes = ["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"] as const;
    const { container } = render(
      <div>
        {variants.map((variant) => <Button key={variant} variant={variant}>{variant}</Button>)}
        {sizes.map((size) => <Button key={size} size={size} variant="outline">{size}</Button>)}
      </div>,
    );
    for (const variant of variants) {
      const button = container.querySelector('[data-slot="button"].cn-button-variant-' + variant);
      expect(button).toBeInTheDocument();
    }
    for (const size of sizes) {
      const button = container.querySelector('[data-slot="button"].cn-button-size-' + size);
      expect(button).toBeInTheDocument();
    }
    expect(container.querySelectorAll('[data-slot="button"]')).toHaveLength(variants.length + sizes.length);
  });

  it("renders card compound parts, custom classes, and forwarded props", () => {
    render(
      <Card aria-label="Panel" className="custom-card">
        <CardHeader className="custom-header">
          <CardTitle className="custom-title">Card title</CardTitle>
          <CardDescription className="custom-description">Card description</CardDescription>
        </CardHeader>
        <CardContent className="custom-content">Card content</CardContent>
        <CardFooter className="custom-footer">Card footer</CardFooter>
      </Card>,
    );
    expect(screen.getByRole("region", { name: "Panel" })).toHaveClass("custom-card", "cn-card");
    expect(screen.getByRole("heading", { name: "Card title" })).toHaveClass("custom-title");
    expect(screen.getByText("Card description")).toHaveClass("custom-description");
    expect(screen.getByText("Card content")).toHaveClass("custom-content");
    expect(screen.getByText("Card footer")).toHaveClass("custom-footer");
  });

  it("renders text input, textarea, native select, option, and optgroup defaults and overrides", () => {
    const { container } = render(
      <form>
        <Input aria-label="Default input" />
        <Input type="email" aria-label="Email input" className="custom-input" />
        <Textarea aria-label="Default notes" />
        <Textarea aria-label="Custom notes" className="custom-textarea" />
        <NativeSelect aria-label="Default select">
          <NativeSelectOption value="a">Option A</NativeSelectOption>
          <NativeSelectOptGroup label="More options" className="custom-group">
            <NativeSelectOption value="b" className="custom-option">Option B</NativeSelectOption>
          </NativeSelectOptGroup>
        </NativeSelect>
        <NativeSelect size="sm" aria-label="Small select" className="custom-select">
          <NativeSelectOption value="small">Small option</NativeSelectOption>
        </NativeSelect>
      </form>,
    );
    expect(screen.getByRole("textbox", { name: "Default input" })).toHaveAttribute("data-slot", "input");
    expect(screen.getByRole("textbox", { name: "Email input" })).toHaveClass("custom-input");
    expect(screen.getByRole("textbox", { name: "Email input" })).toHaveAttribute("type", "email");
    expect(screen.getByRole("textbox", { name: "Default notes" })).toHaveAttribute("data-slot", "textarea");
    expect(screen.getByRole("textbox", { name: "Custom notes" })).toHaveClass("custom-textarea");
    const nativeSelects = container.querySelectorAll<HTMLSelectElement>('[data-slot="native-select"]');
    expect(nativeSelects).toHaveLength(2);
    expect(nativeSelects[0]).toHaveAttribute("data-size", "default");
    expect(nativeSelects[1]).toHaveAttribute("data-size", "sm");
    expect(container.querySelector('[data-slot="native-select-wrapper"].custom-select')).toBeInTheDocument();
    expect(nativeSelects[0]).toHaveAttribute("aria-label", "Default select");
    expect(nativeSelects[1]).toHaveAttribute("aria-label", "Small select");
    expect(container.querySelector('[data-slot="native-select-icon"]')).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector('[data-slot="native-select-optgroup"]')).toHaveClass("custom-group");
    expect(container.querySelector('[data-slot="native-select-option"].custom-option')).toHaveTextContent("Option B");
  });
});

describe("application frame, static overview, and route wiring", () => {
  it("renders the overview through a real TanStack memory router", async () => {
    getSnapshotMock.mockResolvedValue(snapshotFixture);
    const router = makeRouter("/about");
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole("heading", { name: "Designed for review, not autopilot" })).toBeInTheDocument();
    expect(screen.getByText("Aegis Campus Safety Exercise")).toBeInTheDocument();
    expect(screen.getByText("semantic")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "About" })).toHaveClass("is-active");
    expect(screen.getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByRole("link", { name: /Review measured evaluation/ })).toHaveAttribute("href", "/evaluation");
    expect(getSnapshotMock).toHaveBeenCalledOnce();
  });

  it("shows checking then degraded or lexical fallback engine states", async () => {
    const request = deferred<Snapshot>();
    getSnapshotMock.mockReturnValueOnce(request.promise);
    const router = makeRouter("/about");
    render(<RouterProvider router={router} />);
    expect(await screen.findByText("Checking model status")).toBeInTheDocument();
    await act(async () => request.resolve({
      ...snapshotFixture,
      health: { ...healthFixture, engine: "lexical", model_ready: true },
    }));
    expect(await screen.findByText("lexical · fallback")).toBeInTheDocument();
  });

  it("shows a connected but unavailable model as degraded", async () => {
    getSnapshotMock.mockResolvedValueOnce({
      ...snapshotFixture,
      health: { ...healthFixture, model_ready: false },
    });
    const router = makeRouter("/about");
    const { container } = render(<RouterProvider router={router} />);
    expect(await screen.findByText("semantic · degraded")).toBeInTheDocument();
    expect(container.querySelector(".engine-dot-degraded")).toBeInTheDocument();
  });

  it("keeps the frame visible when the snapshot request fails", async () => {
    getSnapshotMock.mockRejectedValueOnce(new Error("Backend is offline"));
    const router = makeRouter("/about");
    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => expect(container.querySelector(".engine-dot-offline")).toBeInTheDocument());
    expect(screen.getByText("Loading current exercise")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Designed for review, not autopilot" })).toBeInTheDocument();
  });

  it("polls the header and clears its interval when the app frame unmounts", async () => {
    vi.useFakeTimers();
    getSnapshotMock.mockResolvedValue(snapshotFixture);
    const clearIntervalSpy = vi.spyOn(window, "clearInterval");
    const router = makeRouter("/about");
    const view = render(<RouterProvider router={router} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getSnapshotMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getSnapshotMock).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it("ignores a snapshot completion after the route tree unmounts", async () => {
    const request = deferred<Snapshot>();
    getSnapshotMock.mockReturnValueOnce(request.promise);
    const router = makeRouter("/about");
    const view = render(<RouterProvider router={router} />);
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => request.resolve(snapshotFixture));
    expect(screen.queryByText("Aegis Campus Safety Exercise")).not.toBeInTheDocument();
  });

  it("ignores a failed snapshot after the route tree unmounts", async () => {
    const request = deferred<Snapshot>();
    getSnapshotMock.mockReturnValueOnce(request.promise);
    const router = makeRouter("/about");
    const view = render(<RouterProvider router={router} />);
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => request.reject(new Error("late offline response")));
    expect(screen.queryByText("Aegis Campus Safety Exercise")).not.toBeInTheDocument();
  });

  it("exposes router options, every file route, and root document metadata", async () => {
    const browserRouter = trackHistory(getRouter());
    expect(browserRouter.options.defaultPreload).toBe("intent");
    expect(browserRouter.options.scrollRestoration).toBe(true);
    expect(Object.keys(browserRouter.routesById)).toEqual(expect.arrayContaining([
      "__root__",
      "/",
      "/dashboard",
      "/report",
      "/evaluation",
      "/about",
    ]));

    expect(indexRoute.options.component).toBeDefined();
    expect(dashboardRoute.options.component).toBeDefined();
    expect(reportRoute.options.component).toBeDefined();
    expect(evaluationRoute.options.component).toBeDefined();
    expect(aboutRoute.options.component).toBeDefined();

    const head = rootRoute.options.head;
    expect(head).toBeDefined();
    const documentHead = await head?.({} as never);
    expect(documentHead?.meta).toContainEqual({ title: "Aegis — Operations" });
    expect(documentHead?.meta).toContainEqual({ name: "description", content: "Synthetic event coordination workspace" });
  });

  it("renders the root document component under the TanStack router", async () => {
    getSnapshotMock.mockResolvedValue(snapshotFixture);
    window.history.replaceState(null, "", "/evaluation");
    const router = trackHistory(getRouter());
    await router.load();
    const html = renderToString(<RouterProvider router={router} />);
    expect(html).toContain('<html lang="en" class="dark style-nova">');
    expect(html).toContain('name="description" content="Synthetic event coordination workspace"');
    expect(html).toContain('id="app"');
    window.history.replaceState(null, "", "/");
  });
});
