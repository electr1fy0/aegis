import { useCallback, useEffect, useRef, useState } from "react";
import { getSnapshot } from "../lib/api";
import type { Snapshot } from "../lib/types";

export interface SnapshotState {
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  applySnapshot: (snapshot: Snapshot) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The Aegis backend could not be reached.";
}

export function useSnapshot(): SnapshotState {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const inFlight = useRef(false);
  const activeController = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);

  const applySnapshot = useCallback((value: Snapshot) => {
    generation.current += 1;
    activeController.current?.abort();
    activeController.current = null;
    inFlight.current = false;
    snapshotRef.current = value;
    setSnapshot(value);
    setError(null);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const controller = new AbortController();
    const requestGeneration = generation.current;
    activeController.current = controller;
    if (!snapshotRef.current) setLoading(true);
    try {
      const value = await getSnapshot(undefined, controller.signal);
      if (mounted.current && requestGeneration === generation.current && !controller.signal.aborted) {
        snapshotRef.current = value;
        setSnapshot(value);
        setError(null);
      }
    } catch (caught) {
      if (mounted.current && requestGeneration === generation.current && !controller.signal.aborted) {
        setError(errorMessage(caught));
      }
    } finally {
      if (activeController.current === controller) {
        inFlight.current = false;
        activeController.current = null;
        if (mounted.current) setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 1_000);
    return () => {
      mounted.current = false;
      generation.current += 1;
      window.clearInterval(interval);
      activeController.current?.abort();
      activeController.current = null;
      inFlight.current = false;
    };
  }, [refresh]);

  return { snapshot, loading, error, refresh, applySnapshot };
}
