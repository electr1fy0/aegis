import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getEvents, getSnapshot } from "../lib/api";
import type { EventInfo, Snapshot } from "../lib/types";

const SELECTED_EVENT_KEY = "aegis.selected-event";
const POLL_INTERVAL_MS = 2_000;
const HIDDEN_POLL_INTERVAL_MS = 15_000;
const MAX_RETRY_DELAY_MS = 30_000;
const INVALID_SNAPSHOT_MESSAGE = "The exercise snapshot could not be read. Check the backend and retry.";

export interface SnapshotState {
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  applySnapshot: (snapshot: Snapshot, options?: ApplySnapshotOptions) => void;
  events: EventInfo[];
  selectedEventId: string | undefined;
  selectEvent: (id?: string) => void;
  lastUpdated: number | null;
  reconnecting: boolean;
}

export interface ApplySnapshotOptions {
  /** Activate a snapshot for another event only while the initiating event is still selected. */
  activate?: boolean;
  expectedEventId?: string;
}

const SnapshotContext = createContext<SnapshotState | null>(null);

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The Aegis backend could not be reached.";
}

function requireSnapshot(value: unknown): Snapshot {
  if (
    typeof value === "object" && value !== null &&
    "event" in value && typeof value.event === "object" && value.event !== null &&
    "id" in value.event && typeof value.event.id === "string"
  ) {
    return value as Snapshot;
  }
  throw new Error(INVALID_SNAPSHOT_MESSAGE);
}

function sortNewestFirst(events: EventInfo[]): EventInfo[] {
  return [...events].sort((left, right) => {
    const leftTime = Date.parse(left.created_at);
    const rightTime = Date.parse(right.created_at);
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
    return rightTime - leftTime;
  });
}

function upsertEvent(events: EventInfo[], event: EventInfo): EventInfo[] {
  return sortNewestFirst([...events.filter((item) => item.id !== event.id), event]);
}

function readStoredEventId(): string | undefined {
  try {
    return window.sessionStorage.getItem(SELECTED_EVENT_KEY) || undefined;
  } catch {
    return undefined;
  }
}

function writeStoredEventId(id: string | undefined): void {
  try {
    if (id) window.sessionStorage.setItem(SELECTED_EVENT_KEY, id);
    else window.sessionStorage.removeItem(SELECTED_EVENT_KEY);
  } catch {
    // Storage can be disabled by the browser; selection still works in memory.
  }
}

function readUrlEventId(): string | undefined {
  try {
    return new URL(window.location.href).searchParams.get("event") || undefined;
  } catch {
    return undefined;
  }
}

function writeUrlEventId(id: string | undefined): void {
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("event", id);
    else url.searchParams.delete("event");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // The in-memory event selection remains usable when history is unavailable.
  }
}

function chooseInitialEvent(events: EventInfo[], urlId: string | undefined, storedId: string | undefined): string | undefined {
  const knownIds = new Set(events.map((event) => event.id));
  if (urlId && (knownIds.size === 0 || knownIds.has(urlId))) return urlId;
  if (storedId && knownIds.has(storedId)) return storedId;
  return events[0]?.id ?? urlId ?? storedId;
}

interface SnapshotProviderProps {
  children: ReactNode;
}

/** One snapshot stream shared by the shell and every route inside it. */
export function SnapshotProvider({ children }: SnapshotProviderProps) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<EventInfo[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | undefined>();
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const eventsRef = useRef<EventInfo[]>([]);
  const selectedEventIdRef = useRef<string | undefined>(undefined);
  const cacheRef = useRef(new Map<string, { snapshot: Snapshot; updatedAt: number }>());
  const generationRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const eventListControllerRef = useRef<AbortController | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const [reconnectState, setReconnectState] = useState(false);

  const refresh = useCallback(() => refreshRef.current(), []);

  const applySnapshot = useCallback((value: Snapshot, options?: ApplySnapshotOptions) => {
    const updatedAt = Date.now();
    cacheRef.current.set(value.event.id, { snapshot: value, updatedAt });
    const nextEvents = upsertEvent(eventsRef.current, value.event);
    eventsRef.current = nextEvents;
    setEvents(nextEvents);
    const currentEventId = selectedEventIdRef.current;
    const sameEvent = currentEventId === value.event.id;
    const guardedActivation = options?.activate === true &&
      (options.expectedEventId === undefined || options.expectedEventId === currentEventId);
    if (currentEventId !== undefined && !sameEvent && !guardedActivation) return;

    generationRef.current += 1;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    snapshotRef.current = value;
    selectedEventIdRef.current = value.event.id;
    setSelectedEventId(value.event.id);
    setSnapshot(value);
    setLastUpdated(updatedAt);
    setError(null);
    setLoading(false);
    setReconnectState(false);
    writeStoredEventId(value.event.id);
    writeUrlEventId(value.event.id);
    void refreshRef.current();
  }, []);

  const selectEvent = useCallback((requestedId?: string) => {
    const nextId = requestedId ?? eventsRef.current[0]?.id;
    if (!nextId) {
      writeUrlEventId(undefined);
      writeStoredEventId(undefined);
      return;
    }
    writeUrlEventId(nextId);
    writeStoredEventId(nextId);
    if (nextId === selectedEventIdRef.current) return;

    generationRef.current += 1;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    selectedEventIdRef.current = nextId;
    setSelectedEventId(nextId);
    setError(null);
    setReconnectState(false);
    const cached = cacheRef.current.get(nextId);
    snapshotRef.current = cached?.snapshot ?? null;
    setSnapshot(cached?.snapshot ?? null);
    setLastUpdated(cached?.updatedAt ?? null);
    setLoading(!cached);
    void refreshRef.current();
  }, []);

  useEffect(() => {
    let mounted = true;
    let inFlight = false;
    let failures = 0;
    let timer: number | null = null;

    const clearScheduledRefresh = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };

    const scheduleRefresh = (delay: number) => {
      clearScheduledRefresh();
      timer = window.setTimeout(() => {
        timer = null;
        void loadSnapshot();
      }, delay);
    };

    const loadSnapshot = async (force = false) => {
      if (!mounted || (inFlight && !force)) return;
      if (force && inFlight) {
        requestControllerRef.current?.abort();
        requestControllerRef.current = null;
        inFlight = false;
      }
      inFlight = true;
      const requestGeneration = generationRef.current;
      const requestEventId = selectedEventIdRef.current;
      const controller = new AbortController();
      requestControllerRef.current = controller;
      if (!snapshotRef.current) setLoading(true);

      try {
        const value = requireSnapshot(await getSnapshot(requestEventId, controller.signal));
        if (
          mounted &&
          requestGeneration === generationRef.current &&
          requestEventId === selectedEventIdRef.current &&
          !controller.signal.aborted
        ) {
          const updatedAt = Date.now();
          snapshotRef.current = value;
          selectedEventIdRef.current = value.event.id;
          cacheRef.current.set(value.event.id, { snapshot: value, updatedAt });
          const nextEvents = upsertEvent(eventsRef.current, value.event);
          eventsRef.current = nextEvents;
          setEvents(nextEvents);
          setSelectedEventId(value.event.id);
          setSnapshot(value);
          setLastUpdated(updatedAt);
          setError(null);
          setReconnectState(false);
          setLoading(false);
          writeStoredEventId(value.event.id);
          failures = 0;
        }
      } catch (caught) {
        if (mounted && !controller.signal.aborted && requestGeneration === generationRef.current) {
          const message = errorMessage(caught);
          setError(message);
          setReconnectState(snapshotRef.current !== null);
          setLoading(false);
          failures += 1;
        }
      } finally {
        if (requestControllerRef.current === controller) {
          requestControllerRef.current = null;
          inFlight = false;
        }
        if (mounted && requestControllerRef.current === null && !inFlight) {
          const normalDelay = document.visibilityState === "hidden" ? HIDDEN_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
          const retryDelay = Math.min(POLL_INTERVAL_MS * 2 ** Math.max(0, failures - 1), MAX_RETRY_DELAY_MS);
          const nextDelay = failures > 0
            ? Math.max(retryDelay, document.visibilityState === "hidden" ? HIDDEN_POLL_INTERVAL_MS : 0)
            : normalDelay;
          scheduleRefresh(nextDelay);
        }
      }
    };

    refreshRef.current = async () => {
      clearScheduledRefresh();
      await loadSnapshot(true);
    };

    const initialize = async () => {
      const listController = new AbortController();
      eventListControllerRef.current = listController;
      const startingGeneration = generationRef.current;
      let listedEvents: EventInfo[] = [];
      try {
        listedEvents = await getEvents(listController.signal);
      } catch {
        // The snapshot endpoint can still provide the current event if history is unavailable.
      }
      if (!mounted) return;

      let nextEvents = sortNewestFirst(listedEvents);
      if (generationRef.current !== startingGeneration) {
        const currentSnapshot = snapshotRef.current;
        if (currentSnapshot) nextEvents = upsertEvent(nextEvents, currentSnapshot.event);
        eventsRef.current = nextEvents;
        setEvents(nextEvents);
        const currentId = selectedEventIdRef.current;
        setSelectedEventId(currentId);
        writeStoredEventId(currentId);
        writeUrlEventId(currentId);
        if (!snapshotRef.current) await loadSnapshot();
        return;
      }
      eventsRef.current = nextEvents;
      setEvents(nextEvents);
      const initialId = chooseInitialEvent(nextEvents, readUrlEventId(), readStoredEventId());
      selectedEventIdRef.current = initialId;
      setSelectedEventId(initialId);
      if (initialId) {
        writeStoredEventId(initialId);
        writeUrlEventId(initialId);
      }
      await loadSnapshot();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        clearScheduledRefresh();
        void loadSnapshot(true);
      } else if (!inFlight) {
        scheduleRefresh(HIDDEN_POLL_INTERVAL_MS);
      }
    };

    const handlePopState = () => {
      const id = readUrlEventId();
      if (id && (eventsRef.current.length === 0 || eventsRef.current.some((event) => event.id === id))) {
        if (id !== selectedEventIdRef.current) selectEvent(id);
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("popstate", handlePopState);
    void initialize();

    return () => {
      mounted = false;
      generationRef.current += 1;
      clearScheduledRefresh();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("popstate", handlePopState);
      eventListControllerRef.current?.abort();
      eventListControllerRef.current = null;
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
      refreshRef.current = async () => undefined;
    };
  }, [selectEvent]);

  return createElement(SnapshotContext.Provider, { value: {
      snapshot,
      loading,
      error,
      refresh,
      applySnapshot,
      events,
      selectedEventId,
      selectEvent,
      lastUpdated,
      reconnecting: reconnectState,
    } }, children);
}

function useStandaloneSnapshot(enabled: boolean): SnapshotState {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | undefined>();
  const snapshotRef = useRef<Snapshot | null>(null);
  const selectedEventIdRef = useRef<string | undefined>(undefined);
  const activeController = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);

  const applySnapshot = useCallback((value: Snapshot, options?: ApplySnapshotOptions) => {
    const currentEventId = selectedEventIdRef.current;
    if (
      currentEventId !== undefined &&
      currentEventId !== value.event.id &&
      !(options?.activate === true && (options.expectedEventId === undefined || options.expectedEventId === currentEventId))
    ) return;
    generation.current += 1;
    activeController.current?.abort();
    activeController.current = null;
    inFlight.current = false;
    snapshotRef.current = value;
    selectedEventIdRef.current = value.event.id;
    setSelectedEventId(value.event.id);
    setSnapshot(value);
    setLastUpdated(Date.now());
    setError(null);
    setLoading(false);
  }, []);

  const refresh = useCallback(() => refreshRef.current(), []);

  const selectEvent = useCallback((id?: string) => {
    const nextId = id ?? snapshotRef.current?.event.id;
    if (!nextId) return;
    selectedEventIdRef.current = nextId;
    setSelectedEventId(nextId);
    generation.current += 1;
    activeController.current?.abort();
    activeController.current = null;
    inFlight.current = false;
    snapshotRef.current = null;
    setSnapshot(null);
    setLoading(true);
    setError(null);
    void refreshRef.current();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    mounted.current = true;
    const doRefresh = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      const controller = new AbortController();
      const requestGeneration = generation.current;
      activeController.current = controller;
      if (!snapshotRef.current) setLoading(true);
      try {
        const value = requireSnapshot(await getSnapshot(selectedEventIdRef.current, controller.signal));
        if (mounted.current && requestGeneration === generation.current && !controller.signal.aborted) {
          snapshotRef.current = value;
          selectedEventIdRef.current = value.event.id;
          setSelectedEventId(value.event.id);
          setSnapshot(value);
          setLastUpdated(Date.now());
          setError(null);
        }
      } catch (caught) {
        if (mounted.current && requestGeneration === generation.current && !controller.signal.aborted) {
          setError(errorMessage(caught));
        }
      } finally {
        if (activeController.current === controller) {
          activeController.current = null;
          inFlight.current = false;
          if (mounted.current) setLoading(false);
        }
      }
    };
    refreshRef.current = doRefresh;
    void doRefresh();
    const interval = window.setInterval(() => void doRefresh(), 1_000);
    return () => {
      mounted.current = false;
      generation.current += 1;
      window.clearInterval(interval);
      activeController.current?.abort();
      activeController.current = null;
      inFlight.current = false;
    };
  }, [enabled]);

  const events = snapshot ? [snapshot.event] : [];
  return {
    snapshot,
    loading,
    error,
    refresh,
    applySnapshot,
    events,
    selectedEventId,
    selectEvent,
    lastUpdated,
    reconnecting: Boolean(snapshot && error),
  };
}

export function useSharedSnapshot(): SnapshotState | null {
  return useContext(SnapshotContext);
}

export function useSnapshot(): SnapshotState {
  const shared = useSharedSnapshot();
  const standalone = useStandaloneSnapshot(shared === null);
  return shared ?? standalone;
}
