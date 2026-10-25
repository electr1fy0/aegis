// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import userEvent from "@testing-library/user-event";
import { getEvents, getSnapshot } from "../lib/api";
import type { EventInfo, Snapshot } from "../lib/types";
import { SnapshotProvider, useSnapshot } from "../hooks/use-snapshot";
import { eventFixture, makeSnapshot, snapshotFixture } from "./fixtures";

vi.mock("../lib/api", () => ({ getEvents: vi.fn(), getSnapshot: vi.fn() }));

const getSnapshotMock = vi.mocked(getSnapshot);
const getEventsMock = vi.mocked(getEvents);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleMockResult(callIndex: number) {
  const value = getSnapshotMock.mock.results[callIndex]?.value as Promise<unknown> | undefined;
  if (!value) return;
  try {
    await value;
  } catch {
    // The hook's catch path is what each rejected request test exercises.
  }
}

describe("useSnapshot", () => {
  let intervalSpy: MockInstance<typeof window.setInterval>;
  let intervalId: ReturnType<typeof window.setInterval>;

  beforeEach(() => {
    getSnapshotMock.mockReset();
    getEventsMock.mockReset();
    intervalId = setInterval(() => {}, 60_000);
    intervalSpy = vi.spyOn(window, "setInterval").mockImplementation(() => intervalId);
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.clearInterval(intervalId);
    window.history.replaceState(null, "", "/");
  });

  it("loads an initial snapshot and polls every second", async () => {
    getSnapshotMock.mockResolvedValueOnce(snapshotFixture);

    const { result, unmount } = renderHook(() => useSnapshot());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledOnce());
    const pollingCall = intervalSpy.mock.calls.find((call) => call[1] === 1_000);
    const pollNow = pollingCall?.[0];
    expect(pollNow).toBeTypeOf("function");
    await act(async () => settleMockResult(0));
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshotFixture));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(getSnapshotMock).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 1_000);

    getSnapshotMock.mockResolvedValueOnce(makeSnapshot({ reports: [] }));
    await act(async () => {
      if (typeof pollNow === "function") pollNow();
      await settleMockResult(1);
    });

    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.snapshot?.reports).toEqual([]));
    unmount();
    expect(window.clearInterval).toHaveBeenCalledWith(intervalId);
  });

  it("ignores a standalone refresh invoked before its first effect initializes", async () => {
    getSnapshotMock.mockResolvedValueOnce(snapshotFixture);
    const { result } = renderHook(() => {
      const stream = useSnapshot();
      const alreadyRefreshed = useRef(false);
      if (!alreadyRefreshed.current) {
        alreadyRefreshed.current = true;
        void stream.refresh();
      }
      return stream;
    });

    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledOnce());
    await act(async () => settleMockResult(0));
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshotFixture));
    expect(getSnapshotMock).toHaveBeenCalledOnce();
  });

  it("keeps standalone event selection coherent and refreshes the selected event", async () => {
    const otherEvent = { ...eventFixture, id: "event-older", name: "Earlier exercise" };
    const otherSnapshot = makeSnapshot({ event: otherEvent });
    getSnapshotMock
      .mockResolvedValueOnce(snapshotFixture)
      .mockResolvedValueOnce(otherSnapshot)
      .mockResolvedValueOnce(otherSnapshot);
    const { result } = renderHook(() => useSnapshot());

    act(() => result.current.selectEvent());
    expect(getSnapshotMock).toHaveBeenCalledOnce();
    await act(async () => settleMockResult(0));
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshotFixture));

    act(() => result.current.selectEvent(otherEvent.id));
    expect(getSnapshotMock).toHaveBeenCalledTimes(2);
    expect(result.current.selectedEventId).toBe(otherEvent.id);
    expect(getSnapshotMock.mock.calls[1]?.[0]).toBe(otherEvent.id);
    await act(async () => settleMockResult(1));
    await waitFor(() => expect(result.current.snapshot?.event.id).toBe(otherEvent.id));
    expect(result.current.selectedEventId).toBe(otherEvent.id);
    expect(getSnapshotMock).toHaveBeenLastCalledWith(otherEvent.id, expect.any(AbortSignal));

    act(() => result.current.selectEvent());
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledTimes(3));
    expect(getSnapshotMock).toHaveBeenLastCalledWith(otherEvent.id, expect.any(AbortSignal));
    await act(async () => settleMockResult(2));
    expect(result.current.snapshot?.event.id).toBe(otherEvent.id);
  });

  it("guards standalone snapshot activation after the user changes exercises", async () => {
    const otherEvent = { ...eventFixture, id: "event-older", name: "Earlier exercise" };
    const otherSnapshot = makeSnapshot({ event: otherEvent });
    getSnapshotMock.mockResolvedValue(snapshotFixture);
    const { result } = renderHook(() => useSnapshot());
    await act(async () => settleMockResult(0));
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshotFixture));

    act(() => result.current.applySnapshot(otherSnapshot));
    expect(result.current.snapshot?.event.id).toBe(eventFixture.id);

    act(() => result.current.applySnapshot(otherSnapshot, {
      activate: true,
      expectedEventId: eventFixture.id,
    }));
    expect(result.current.snapshot?.event.id).toBe(otherEvent.id);

    act(() => result.current.applySnapshot(snapshotFixture, {
      activate: true,
      expectedEventId: eventFixture.id,
    }));
    expect(result.current.snapshot?.event.id).toBe(otherEvent.id);
  });

  it("keeps prior data visible when a polling request fails and applySnapshot clears the error", async () => {
    const revisedSnapshot = makeSnapshot({
      counts: { reports: 3, incidents: 1, review: 1, conflicts: 0 },
    });
    getSnapshotMock
      .mockResolvedValueOnce(snapshotFixture)
      .mockRejectedValueOnce(new Error("Temporary polling failure"));

    const { result } = renderHook(() => useSnapshot());
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledOnce());
    const pollingCall = intervalSpy.mock.calls.find((call) => call[1] === 1_000);
    const pollNow = pollingCall?.[0];
    expect(pollNow).toBeTypeOf("function");
    await act(async () => settleMockResult(0));
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshotFixture));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      if (typeof pollNow === "function") pollNow();
      await settleMockResult(1);
    });

    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledTimes(2));
    expect(result.current.snapshot).toEqual(snapshotFixture);
    expect(result.current.error).toBe("Temporary polling failure");

    act(() => result.current.applySnapshot(revisedSnapshot));
    expect(result.current.snapshot).toEqual(revisedSnapshot);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it.each([
    ["an empty Error", new Error("")],
    ["a non-Error rejection", "offline"],
  ])("uses a safe fallback message for %s", async (_label, failure) => {
    getSnapshotMock.mockRejectedValueOnce(failure);

    const { result } = renderHook(() => useSnapshot());
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledOnce());
    await act(async () => settleMockResult(0));

    await waitFor(() =>
      expect(result.current.error).toBe("The Aegis backend could not be reached."),
    );
    expect(result.current.loading).toBe(false);
    expect(result.current.snapshot).toBeNull();
  });

  it("shows a generic unreadable-snapshot message when the current response has no event", async () => {
    getSnapshotMock.mockResolvedValueOnce(null as unknown as Snapshot);
    const { result } = renderHook(() => useSnapshot());

    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledOnce());
    await act(async () => settleMockResult(0));
    await waitFor(() => expect(result.current.error).toBe(
      "The exercise snapshot could not be read. Check the backend and retry.",
    ));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.reconnecting).toBe(false);
  });

  it("does not start duplicate polling requests while one is in flight", async () => {
    const pending = deferred<Snapshot>();
    getSnapshotMock.mockReturnValueOnce(pending.promise);

    const { result } = renderHook(() => useSnapshot());
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledOnce());

    await act(async () => {
      await result.current.refresh();
    });
    expect(getSnapshotMock).toHaveBeenCalledOnce();

    await act(async () => {
      pending.resolve(snapshotFixture);
      await pending.promise;
    });
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshotFixture));
    expect(result.current.loading).toBe(false);
  });

  it("aborts an active request on unmount without surfacing cancellation as an error", async () => {
    let requestSignal: AbortSignal | undefined;
    getSnapshotMock.mockImplementationOnce((_eventId, signal) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Request cancelled", "AbortError")),
          { once: true },
        );
      });
    });

    const { unmount } = renderHook(() => useSnapshot());
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledOnce());

    unmount();
    expect(requestSignal?.aborted).toBe(true);
    await act(async () => Promise.resolve());
  });

  it("does not update loading state when a retained refresh finishes after unmount", async () => {
    getSnapshotMock.mockResolvedValueOnce(snapshotFixture);
    const { result, unmount } = renderHook(() => useSnapshot());
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledOnce());
    await act(async () => settleMockResult(0));
    expect(result.current.snapshot).toEqual(snapshotFixture);
    unmount();

    const lateRequest = deferred<Snapshot>();
    getSnapshotMock.mockReturnValueOnce(lateRequest.promise);
    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = result.current.refresh();
    });
    expect(getSnapshotMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      lateRequest.resolve(snapshotFixture);
      await refreshPromise;
    });
  });
});

function eventInfo(id: string, name: string, createdAt: string): EventInfo {
  return { ...eventFixture, id, name, created_at: createdAt };
}

function eventSnapshot(event: EventInfo): Snapshot {
  return makeSnapshot({ event, zones: [], incidents: [], reports: [], audit: [], counts: { reports: 0, incidents: 0, review: 0, conflicts: 0 } });
}

function SnapshotProbe() {
  const stream = useSnapshot();
  return (
    <div>
      <span data-testid="event-name">{stream.snapshot?.event.name ?? "No snapshot"}</span>
      <span data-testid="selected-event">{stream.selectedEventId ?? "none"}</span>
      <span data-testid="event-count">{stream.events.length}</span>
      <span data-testid="updated">{stream.lastUpdated ?? "none"}</span>
      <span data-testid="connection">{stream.reconnecting ? "reconnecting" : "connected"}</span>
      <span data-testid="stream-error">{stream.error ?? "none"}</span>
      <button type="button" onClick={() => stream.selectEvent()}>Select default event</button>
      <button type="button" onClick={() => stream.selectEvent("event-current")}>Select current</button>
      <button type="button" onClick={() => stream.selectEvent("event-older")}>Select older</button>
      <button type="button" onClick={() => void stream.refresh()}>Refresh snapshot</button>
      <button type="button" onClick={() => stream.applySnapshot(
        eventSnapshot(eventInfo("event-replay", "Replay event", "2026-10-25T13:00:00Z")),
        { activate: true, expectedEventId: stream.selectedEventId },
      )}>Apply replay</button>
      <button type="button" onClick={() => {
        const next = eventSnapshot(eventInfo("event-unguarded-replay", "Unguarded replay", "2026-10-25T13:30:00Z"));
        getSnapshotMock.mockResolvedValueOnce(next);
        stream.applySnapshot(next, { activate: true });
      }}>Apply replay without source</button>
      <button type="button" onClick={() => stream.applySnapshot(
        eventSnapshot(eventInfo("event-stale-replay", "Stale replay", "2026-10-25T14:00:00Z")),
        { activate: true, expectedEventId: "event-current" },
      )}>Apply stale replay</button>
      <button type="button" onClick={() => stream.applySnapshot(eventSnapshot({
        ...eventInfo("event-current", "Current exercise", "2026-10-25T12:00:00Z"),
        name: "Updated current exercise",
      }))}>Apply late current response</button>
    </div>
  );
}

function RefreshDuringInitialRender() {
  const stream = useSnapshot();
  const alreadyRefreshed = useRef(false);
  if (!alreadyRefreshed.current) {
    alreadyRefreshed.current = true;
    void stream.refresh();
  }
  return <span data-testid="initial-refresh-event">{stream.snapshot?.event.name ?? "Loading"}</span>;
}

let retainedRefresh: (() => Promise<void>) | undefined;

function RetainRefresh() {
  retainedRefresh = useSnapshot().refresh;
  return null;
}

describe("SnapshotProvider", () => {
  const currentEvent = eventInfo("event-current", "Current exercise", "2026-10-25T12:00:00Z");
  const olderEvent = eventInfo("event-older", "Earlier exercise", "2026-10-20T12:00:00Z");

  beforeEach(() => {
    getSnapshotMock.mockReset();
    getEventsMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
  });

  it("shares one snapshot poll between consumers and restores the URL event selection", async () => {
    window.history.replaceState(null, "", "/dashboard?event=event-older&incident=keep-me&view=map");
    getEventsMock.mockResolvedValue([currentEvent, olderEvent]);
    getSnapshotMock.mockResolvedValue(eventSnapshot(olderEvent));
    render(<SnapshotProvider><SnapshotProbe /><SnapshotProbe /></SnapshotProvider>);

    await waitFor(() => expect(screen.getAllByTestId("event-name")).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByText("Earlier exercise")).toHaveLength(2));
    expect(getEventsMock).toHaveBeenCalledOnce();
    expect(getSnapshotMock).toHaveBeenCalledOnce();
    expect(getSnapshotMock).toHaveBeenCalledWith("event-older", expect.any(AbortSignal));
    expect(screen.getAllByText("event-older")).toHaveLength(2);
    expect(new URL(window.location.href).searchParams.get("incident")).toBe("keep-me");
    expect(new URL(window.location.href).searchParams.get("view")).toBe("map");
  });

  it("keeps a selected event stable when the selector chooses the same event again", async () => {
    window.history.replaceState(null, "", "/dashboard?event=event-current");
    getEventsMock.mockResolvedValue([currentEvent, olderEvent]);
    getSnapshotMock.mockResolvedValue(eventSnapshot(currentEvent));
    render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);
    await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Current exercise"));

    await userEvent.setup().click(screen.getByRole("button", { name: "Select current" }));
    expect(screen.getByTestId("selected-event")).toHaveTextContent("event-current");
    expect(getSnapshotMock).toHaveBeenCalledOnce();
  });

  it("switches events immediately, preserves query filters, and applies replay snapshots coherently", async () => {
    window.history.replaceState(null, "", "/dashboard?event=event-current&incident=old&queue=review&view=map");
    getEventsMock.mockResolvedValue([currentEvent, olderEvent]);
    getSnapshotMock
      .mockResolvedValueOnce(eventSnapshot(currentEvent))
      .mockResolvedValueOnce(eventSnapshot(olderEvent))
      .mockResolvedValue(eventSnapshot(eventInfo("event-replay", "Replay event", "2026-10-25T13:00:00Z")));
    render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);
    await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Current exercise"));

    await userEvent.setup().click(screen.getByRole("button", { name: "Select older" }));
    await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Earlier exercise"));
    expect(new URL(window.location.href).searchParams.get("incident")).toBe("old");
    expect(new URL(window.location.href).searchParams.get("queue")).toBe("review");
    expect(new URL(window.location.href).searchParams.get("event")).toBe("event-older");

    await userEvent.setup().click(screen.getByRole("button", { name: "Apply replay" }));
    expect(screen.getByTestId("event-name")).toHaveTextContent("Replay event");
    expect(screen.getByTestId("selected-event")).toHaveTextContent("event-replay");
    expect(screen.getByTestId("event-count")).toHaveTextContent("3");
    expect(new URL(window.location.href).searchParams.get("event")).toBe("event-replay");
    expect(new URL(window.location.href).searchParams.get("queue")).toBe("review");
    await waitFor(() => expect(screen.getByTestId("updated")).not.toHaveTextContent("none"));

    await userEvent.setup().click(screen.getByRole("button", { name: "Apply replay without source" }));
    await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Unguarded replay"));
  });

  it("starts the shared stream after a replay snapshot wins the event-list initialization race", async () => {
    const pendingEvents = deferred<EventInfo[]>();
    const replayEvent = eventInfo("event-replay", "Replay event", "2026-10-25T13:00:00Z");
    getEventsMock.mockReturnValueOnce(pendingEvents.promise);
    getSnapshotMock.mockResolvedValue(eventSnapshot(replayEvent));
    render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);

    await userEvent.setup().click(screen.getByRole("button", { name: "Apply replay" }));
    expect(screen.getByTestId("event-name")).toHaveTextContent("Replay event");
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledWith("event-replay", expect.any(AbortSignal)));

    await act(async () => pendingEvents.resolve([currentEvent, olderEvent]));
    await waitFor(() => expect(screen.getByTestId("event-count")).toHaveTextContent("3"));
    expect(getSnapshotMock).toHaveBeenCalledOnce();
    expect(screen.getByTestId("selected-event")).toHaveTextContent("event-replay");
    expect(screen.getByTestId("event-name")).toHaveTextContent("Replay event");
  });

  it("ignores a retained-event response that finishes after provider unmount", async () => {
    const pendingEvents = deferred<EventInfo[]>();
    getEventsMock.mockReturnValueOnce(pendingEvents.promise);
    const view = render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);
    await waitFor(() => expect(getEventsMock).toHaveBeenCalledOnce());

    view.unmount();
    const signal = getEventsMock.mock.calls[0]?.[0];
    expect(signal?.aborted).toBe(true);
    await act(async () => pendingEvents.resolve([currentEvent, olderEvent]));
    expect(getSnapshotMock).not.toHaveBeenCalled();
  });

  it("starts a shared snapshot request if event selection wins initialization without a cached snapshot", async () => {
    const pendingEvents = deferred<EventInfo[]>();
    const pendingSnapshot = deferred<Snapshot>();
    getEventsMock.mockReturnValueOnce(pendingEvents.promise);
    getSnapshotMock.mockReturnValueOnce(pendingSnapshot.promise);
    render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);

    await userEvent.setup().click(screen.getByRole("button", { name: "Select older" }));
    expect(screen.getByTestId("selected-event")).toHaveTextContent("event-older");
    expect(getSnapshotMock).toHaveBeenCalledWith("event-older", expect.any(AbortSignal));
    await act(async () => pendingEvents.resolve([currentEvent, olderEvent]));
    await waitFor(() => expect(screen.getByTestId("event-count")).toHaveTextContent("2"));
    await act(async () => pendingSnapshot.resolve(eventSnapshot(olderEvent)));
    await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Earlier exercise"));
    expect(getSnapshotMock).toHaveBeenCalledOnce();
  });

  it("caches a late response for the previous event without switching the active exercise", async () => {
    window.history.replaceState(null, "", "/dashboard?event=event-current");
    getEventsMock.mockResolvedValue([currentEvent, olderEvent]);
    getSnapshotMock
      .mockResolvedValueOnce(eventSnapshot(currentEvent))
      .mockResolvedValueOnce(eventSnapshot(olderEvent));
    render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);
    await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Current exercise"));

    await userEvent.setup().click(screen.getByRole("button", { name: "Select older" }));
    await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Earlier exercise"));

    await userEvent.setup().click(screen.getByRole("button", { name: "Apply late current response" }));
    expect(screen.getByTestId("event-name")).toHaveTextContent("Earlier exercise");
    expect(screen.getByTestId("selected-event")).toHaveTextContent("event-older");
    expect(new URL(window.location.href).searchParams.get("event")).toBe("event-older");
    await userEvent.setup().click(screen.getByRole("button", { name: "Apply stale replay" }));
    expect(screen.getByTestId("event-name")).toHaveTextContent("Earlier exercise");
    expect(screen.getByTestId("selected-event")).toHaveTextContent("event-older");

    await userEvent.setup().click(screen.getByRole("button", { name: "Select current" }));
    expect(screen.getByTestId("event-name")).toHaveTextContent("Updated current exercise");
  });

  it("preserves the last successful snapshot when the backend returns an unreadable payload", async () => {
    getEventsMock.mockResolvedValue([currentEvent]);
    getSnapshotMock
      .mockResolvedValueOnce(eventSnapshot(currentEvent))
      .mockResolvedValueOnce(null as unknown as Snapshot);
    render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);
    await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Current exercise"));

    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh snapshot" }));
    await waitFor(() => expect(screen.getByTestId("stream-error")).toHaveTextContent(
      "The exercise snapshot could not be read. Check the backend and retry.",
    ));
    expect(screen.getByTestId("event-name")).toHaveTextContent("Current exercise");
    expect(screen.getByTestId("connection")).toHaveTextContent("reconnecting");
  });

  it("falls back to the newest listed event when a URL selection is invalid", async () => {
    window.history.replaceState(null, "", "/report?event=missing&incident=keep");
    getEventsMock.mockResolvedValue([currentEvent, olderEvent]);
    getSnapshotMock.mockResolvedValue(eventSnapshot(currentEvent));
    render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);

    await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Current exercise"));
    expect(new URL(window.location.href).searchParams.get("event")).toBe("event-current");
    expect(new URL(window.location.href).searchParams.get("incident")).toBe("keep");
  });

  it("follows valid browser history event changes and ignores unknown or absent events", async () => {
    window.history.replaceState(null, "", "/dashboard?event=event-current");
    getEventsMock.mockResolvedValue([currentEvent, olderEvent]);
    getSnapshotMock.mockResolvedValueOnce(eventSnapshot(currentEvent)).mockResolvedValue(eventSnapshot(olderEvent));
    render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);
    await waitFor(() => expect(screen.getByTestId("selected-event")).toHaveTextContent("event-current"));

    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(screen.getByTestId("selected-event")).toHaveTextContent("event-current");

    window.history.replaceState(null, "", "/dashboard?event=event-older&incident=keep");
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Earlier exercise"));
    expect(new URL(window.location.href).searchParams.get("incident")).toBe("keep");

    window.history.replaceState(null, "", "/dashboard?event=missing");
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(screen.getByTestId("selected-event")).toHaveTextContent("event-older");

    window.history.replaceState(null, "", "/dashboard");
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(screen.getByTestId("selected-event")).toHaveTextContent("event-older");
  });

  it("uses the saved session event when the URL has no event parameter", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    const session = {
      getItem: () => "event-older",
      setItem: vi.fn(),
      removeItem: vi.fn(),
    } as unknown as Storage;
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: session });
    try {
      window.history.replaceState(null, "", "/report?incident=keep");
      getEventsMock.mockResolvedValue([currentEvent, olderEvent]);
      getSnapshotMock.mockResolvedValue(eventSnapshot(olderEvent));
      render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);

      await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Earlier exercise"));
      expect(new URL(window.location.href).searchParams.get("event")).toBe("event-older");
      expect(new URL(window.location.href).searchParams.get("incident")).toBe("keep");
      expect(session.setItem).toHaveBeenCalledWith("aegis.selected-event", "event-older");
    } finally {
      if (original) Object.defineProperty(window, "sessionStorage", original);
      else delete (window as unknown as { sessionStorage?: Storage }).sessionStorage;
    }
  });

  it("keeps event switching usable when browser storage and history updates are blocked", async () => {
    const originalStorage = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get: () => { throw new Error("session storage blocked"); },
    });
    window.history.replaceState(null, "", "/dashboard?event=event-current&queue=keep");
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new Error("history unavailable");
    });
    getEventsMock.mockResolvedValue([currentEvent, olderEvent]);
    getSnapshotMock.mockResolvedValueOnce(eventSnapshot(currentEvent)).mockResolvedValue(eventSnapshot(olderEvent));
    try {
      render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);
      await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Current exercise"));
      await userEvent.setup().click(screen.getByRole("button", { name: "Select older" }));
      await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Earlier exercise"));
      expect(screen.getByTestId("selected-event")).toHaveTextContent("event-older");
    } finally {
      if (originalStorage) Object.defineProperty(window, "sessionStorage", originalStorage);
      else delete (window as unknown as { sessionStorage?: Storage }).sessionStorage;
    }
  });

  it("loads the current event when the browser URL parser is unavailable", async () => {
    const browserURL = globalThis.URL;
    vi.stubGlobal("URL", class {
      constructor() { throw new Error("URL parser unavailable"); }
    } as unknown as typeof URL);
    getEventsMock.mockResolvedValue([currentEvent]);
    getSnapshotMock.mockResolvedValue(eventSnapshot(currentEvent));
    try {
      render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);
      await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Current exercise"));
      expect(screen.getByTestId("selected-event")).toHaveTextContent("event-current");
    } finally {
      vi.stubGlobal("URL", browserURL);
    }
  });

  it("clears a URL event selection when no event is available", async () => {
    window.history.replaceState(null, "", "/dashboard?event=missing&queue=review");
    getEventsMock.mockResolvedValue([]);
    getSnapshotMock.mockResolvedValueOnce(null as unknown as Snapshot);
    render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);
    await waitFor(() => expect(screen.getByTestId("stream-error")).toHaveTextContent(
      "The exercise snapshot could not be read. Check the backend and retry.",
    ));

    await userEvent.setup().click(screen.getByRole("button", { name: "Select default event" }));
    expect(new URL(window.location.href).searchParams.has("event")).toBe(false);
    expect(new URL(window.location.href).searchParams.get("queue")).toBe("review");
  });

  it("loads the current snapshot when the retained-event list is unavailable", async () => {
    getEventsMock.mockRejectedValue(new Error("history unavailable"));
    getSnapshotMock.mockResolvedValue(snapshotFixture);
    render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);

    await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent(eventFixture.name));
    expect(screen.getByTestId("event-count")).toHaveTextContent("1");
    expect(screen.getByTestId("selected-event")).toHaveTextContent(eventFixture.id);
  });

  it("keeps the last successful snapshot and marks reconnecting after a poll failure", async () => {
    getEventsMock.mockResolvedValue([currentEvent]);
    getSnapshotMock.mockResolvedValueOnce(eventSnapshot(currentEvent)).mockRejectedValueOnce(new Error("offline"));
    render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);
    await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Current exercise"));
    const updated = screen.getByTestId("updated").textContent;

    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh snapshot" }));
    await waitFor(() => expect(screen.getByTestId("connection")).toHaveTextContent("reconnecting"));
    expect(screen.getByTestId("event-name")).toHaveTextContent("Current exercise");
    expect(screen.getByTestId("updated")).toHaveTextContent(updated ?? "");
  });

  it("backs off after failures and polls less often while the tab is hidden", async () => {
    vi.useFakeTimers();
    const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    getEventsMock.mockResolvedValue([currentEvent]);
    getSnapshotMock.mockRejectedValue(new Error("offline"));
    try {
      render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(getSnapshotMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_999);
      });
      expect(getSnapshotMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(getSnapshotMock).toHaveBeenCalledTimes(2);

      visibility = "hidden";
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(getSnapshotMock).toHaveBeenCalledTimes(3);

      visibility = "visible";
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(getSnapshotMock).toHaveBeenCalledTimes(4);
    } finally {
      if (original) Object.defineProperty(document, "visibilityState", original);
      else delete (document as unknown as { visibilityState?: DocumentVisibilityState }).visibilityState;
    }
  });

  it("schedules the longer polling interval after the tab becomes hidden", async () => {
    const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    getEventsMock.mockResolvedValue([currentEvent]);
    getSnapshotMock.mockResolvedValue(eventSnapshot(currentEvent));
    const view = render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);
    try {
      await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Current exercise"));
      await waitFor(() => expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 15_000));
      expect(document.visibilityState).toBe("hidden");
      timeoutSpy.mockClear();
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);
    } finally {
      view.unmount();
      if (original) Object.defineProperty(document, "visibilityState", original);
      else delete (document as unknown as { visibilityState?: DocumentVisibilityState }).visibilityState;
    }
  });

  it("does not schedule a hidden-tab poll while a snapshot request is already running", async () => {
    const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    const pendingSnapshot = deferred<Snapshot>();
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    getEventsMock.mockResolvedValue([currentEvent]);
    getSnapshotMock.mockReturnValueOnce(pendingSnapshot.promise);
    const view = render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);
    try {
      await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledOnce());
      timeoutSpy.mockClear();
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(timeoutSpy).not.toHaveBeenCalled();

      await act(async () => pendingSnapshot.resolve(eventSnapshot(currentEvent)));
      await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Current exercise"));
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);
    } finally {
      view.unmount();
      if (original) Object.defineProperty(document, "visibilityState", original);
      else delete (document as unknown as { visibilityState?: DocumentVisibilityState }).visibilityState;
    }
  });

  it("ignores a refresh invoked from a consumer before the shared stream initializes", async () => {
    getEventsMock.mockResolvedValue([currentEvent]);
    getSnapshotMock.mockResolvedValue(eventSnapshot(currentEvent));
    render(<SnapshotProvider><RefreshDuringInitialRender /></SnapshotProvider>);

    await waitFor(() => expect(screen.getByTestId("initial-refresh-event")).toHaveTextContent("Current exercise"));
    expect(getEventsMock).toHaveBeenCalledOnce();
    expect(getSnapshotMock).toHaveBeenCalledOnce();
  });

  it("keeps refresh harmless after the shared provider has unmounted", async () => {
    getEventsMock.mockResolvedValue([currentEvent]);
    getSnapshotMock.mockResolvedValue(eventSnapshot(currentEvent));
    retainedRefresh = undefined;
    const view = render(<SnapshotProvider><RetainRefresh /></SnapshotProvider>);
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledOnce());
    view.unmount();

    await act(async () => retainedRefresh?.());
    expect(getSnapshotMock).toHaveBeenCalledOnce();
  });

  it("ignores a stale snapshot after switching events while its request is pending", async () => {
    const pending = deferred<Snapshot>();
    getEventsMock.mockResolvedValue([currentEvent, olderEvent]);
    getSnapshotMock.mockResolvedValueOnce(eventSnapshot(currentEvent)).mockReturnValueOnce(pending.promise).mockResolvedValue(eventSnapshot(olderEvent));
    render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);
    await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Current exercise"));
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh snapshot" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Select older" }));
    await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Earlier exercise"));
    await act(async () => pending.resolve(eventSnapshot(currentEvent)));
    expect(screen.getByTestId("event-name")).toHaveTextContent("Earlier exercise");
  });

  it("supersedes a pending shared refresh with the latest request", async () => {
    const staleResponse = deferred<Snapshot>();
    const updatedCurrent = eventSnapshot({ ...currentEvent, name: "Refreshed current exercise" });
    getEventsMock.mockResolvedValue([currentEvent]);
    getSnapshotMock
      .mockResolvedValueOnce(eventSnapshot(currentEvent))
      .mockReturnValueOnce(staleResponse.promise)
      .mockResolvedValueOnce(updatedCurrent);
    render(<SnapshotProvider><SnapshotProbe /></SnapshotProvider>);
    await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Current exercise"));

    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh snapshot" }));
    await waitFor(() => expect(getSnapshotMock).toHaveBeenCalledTimes(2));
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh snapshot" }));
    await waitFor(() => expect(screen.getByTestId("event-name")).toHaveTextContent("Refreshed current exercise"));
    await act(async () => staleResponse.resolve(eventSnapshot(currentEvent)));
    expect(screen.getByTestId("event-name")).toHaveTextContent("Refreshed current exercise");
  });
});
