// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { getSnapshot } from "../lib/api";
import type { Snapshot } from "../lib/types";
import { useSnapshot } from "../hooks/use-snapshot";
import { makeSnapshot, snapshotFixture } from "./fixtures";

vi.mock("../lib/api", () => ({ getSnapshot: vi.fn() }));

const getSnapshotMock = vi.mocked(getSnapshot);

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
    intervalId = setInterval(() => {}, 60_000);
    intervalSpy = vi.spyOn(window, "setInterval").mockImplementation(() => intervalId);
    vi.spyOn(window, "clearInterval").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.clearInterval(intervalId);
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
