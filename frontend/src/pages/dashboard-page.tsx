import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowsExchange,
  IconChevronRight,
  IconCircleCheck,
  IconClock,
  IconCopy,
  IconDownload,
  IconEdit,
  IconFileExport,
  IconGitMerge,
  IconHistory,
  IconListCheck,
  IconMap,
  IconMapPin,
  IconMessageCircle,
  IconPlayerPlay,
  IconPlayerTrackNext,
  IconPrinter,
  IconRefresh,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { NativeSelect } from "../components/ui/native-select";
import { Textarea } from "../components/ui/textarea";
import { useSnapshot } from "../hooks/use-snapshot";
import {
  ApiError,
  addIncidentNote,
  advanceReplay,
  resetPriority,
  reviewConflict,
  reviewGrouping,
  startReplay,
  undoDecision,
  updateIncidentTitle,
  updatePriority,
  updateStatus,
  retryAnalysis,
} from "../lib/api";
import {
  displayStatus,
  engineLabel,
  evidenceScore,
  formatAge,
  formattedTime,
  incidentReports,
  latestAuditFirst,
  priorityLabel,
  zoneLabel,
} from "../lib/format";
import {
  criteriaForIncident,
  dashboardIncidentHref,
  exportSnapshotCsv,
  exportSnapshotJson,
  highlightRanges,
  matchesQueueCriteria,
  readDashboardQuery,
  nextReviewCandidate,
  reviewReasonLabel,
  shortDisplayId,
  sortQueue,
  unreadReportIds,
  writeDashboardQuery,
  type QueueCriteria,
  type QueueFilter,
  type QueueSort,
} from "../lib/dashboard-model";
import { RelatedGroups } from "../components/dashboard-candidates";
import type {
  Conflict,
  GroupingAction,
  GroupingReviewInput,
  Incident,
  IncidentStatus,
  Priority,
  Report,
  Replay,
  Snapshot,
  Zone,
} from "../lib/types";

type ReviewMode = Extract<GroupingAction, "confirm" | "reject" | "move" | "merge" | "split">;
type ReplayScenario = "demo" | "busy" | "edge";

const defaultCriteria: QueueCriteria = {
  query: "",
  filter: "active",
  priority: "all",
  status: "all",
  zone: "all",
  sort: "priority",
};
const readStorageKey = "aegis.dashboard.read-reports.v1";

interface Notice {
  kind: "success" | "error";
  message: string;
}

const priorityOrder: Record<Priority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  UNASSESSED: 3,
};

function errorText(error: unknown): string {
  if (isVersionConflict(error)) {
    return "This action is based on an older incident version. Review the refreshed incident before retrying.";
  }
  return error instanceof Error && error.message ? error.message : "The coordinator action could not be saved.";
}

function citedPriorityPhrases(reason: string, report: Report): string[] {
  if (!reason.toLocaleLowerCase().includes(`in report ${report.id}`.toLocaleLowerCase())) return [];
  return [...reason.matchAll(/[“]([^”]+)[”]|"([^"]+)"/g)]
    .map((match) => match[1] ?? match[2]!)
    .filter((phrase) => report.text.toLocaleLowerCase().includes(phrase.toLocaleLowerCase()));
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

function getAffectedIncidentIds(
  mode: ReviewMode,
  sourceIncidentId: string,
  targetIncidentId: string,
  mergeIncidentIds: string[],
): string[] {
  if (mode === "merge") return mergeIncidentIds;
  if (mode === "move") return [sourceIncidentId, targetIncidentId];
  return [sourceIncidentId];
}

type ReadReportMap = Record<string, string[]>;

function loadReadReportMap(): ReadReportMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(readStorageKey);
    const value: unknown = raw ? JSON.parse(raw) : {};
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([key, ids]) =>
      Array.isArray(ids) && ids.every((id) => typeof id === "string") ? [[key, ids]] : [],
    ));
  } catch {
    return {};
  }
}

function saveReadReportMap(value: ReadReportMap): void {
  try {
    window.localStorage.setItem(readStorageKey, JSON.stringify(value));
  } catch {
    // The unread badge remains useful for this page session when storage is unavailable.
  }
}

function readKey(eventId: string, incidentId: string): string {
  return `${eventId}:${incidentId}`;
}

function persistedDashboardKey(eventId: string): string {
  return `aegis.dashboard.view.v1:${eventId}`;
}

function persistedInspectorKey(eventId: string, incidentId: string): string {
  return `aegis.dashboard.inspector.v1:${eventId}:${incidentId}`;
}

function changedIncidentDetails(before: Incident, after: Incident): string[] {
  const details: string[] = [];
  if (before.title !== after.title) details.push(`Title changed from “${before.title}” to “${after.title}”.`);
  if (before.priority !== after.priority) details.push(`Priority changed from ${before.priority} to ${after.priority}.`);
  if (before.status !== after.status) details.push(`Status changed from ${displayStatus(before.status)} to ${displayStatus(after.status)}.`);
  const beforeIds = new Set(before.report_ids);
  const afterIds = new Set(after.report_ids);
  const added = after.report_ids.filter((id) => !beforeIds.has(id));
  const removed = before.report_ids.filter((id) => !afterIds.has(id));
  if (added.length || removed.length) {
    const changeText = [
      added.length ? `Added ${added.map((id) => shortDisplayId(undefined, id, "RPT")).join(", ")}` : "",
      removed.length ? `removed ${removed.map((id) => shortDisplayId(undefined, id, "RPT")).join(", ")}` : "",
    ].filter(Boolean).join("; ");
    details.push(`Membership changed: ${changeText}.`);
  }
  const evidenceSignature = (item: Incident) => item.evidence
    .map((entry) => `${entry.report_id}:${entry.candidate_report_id}:${entry.decision}:${entry.total_score ?? ""}`)
    .sort()
    .join("|");
  if (evidenceSignature(before) !== evidenceSignature(after)) details.push("Pairwise grouping evidence changed in the current snapshot.");
  return details;
}

async function copyValue(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // A denied clipboard write can still fall back to the browser's copy command.
  }
  try {
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    try {
      field.select();
      return document.execCommand("copy");
    } finally {
      field.remove();
    }
  } catch {
    return false;
  }
}

function saveFile(filename: string, type: string, value: string): void {
  const blob = new Blob([value], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function createGroupingReviewInput(
  mode: ReviewMode,
  incident: Incident,
  allIncidents: Incident[],
  reportIds: string[],
  targetIncidentId: string,
  mergeIncidentIds: string[],
  reason: string,
): GroupingReviewInput {
  const affectedIds = getAffectedIncidentIds(mode, incident.id, targetIncidentId, mergeIncidentIds);
  const expectedVersions = Object.fromEntries(
    affectedIds.map((id) => {
      const affected = allIncidents.find((candidate) => candidate.id === id);
      return [id, affected?.version ?? incident.version];
    }),
  );
  const input: GroupingReviewInput = {
    action: mode,
    report_ids: mode === "merge" ? [] : reportIds,
    reason: reason.trim(),
    expected_versions: expectedVersions,
  };

  if (mode === "merge") input.incident_ids = mergeIncidentIds;
  if (mode === "confirm") input.incident_ids = [incident.id];
  if (mode === "split") input.incident_ids = [incident.id];
  if (mode === "move") {
    input.incident_ids = [incident.id];
    input.target_incident_id = targetIncidentId;
  }
  if (mode === "reject") input.target_incident_id = incident.id;
  if (mode === "merge") input.target_incident_id = targetIncidentId;
  if (mode === "confirm") input.target_incident_id = incident.id;
  return input;
}

function useNotice() {
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    if (!notice) return undefined;
    const timeout = window.setTimeout(() => setNotice(null), 4_500);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  return { notice, setNotice };
}

function VersionConflictNotice({
  visible,
  canUseLatest,
  onUseLatest,
  changedDetails = [],
}: {
  visible: boolean;
  canUseLatest: boolean;
  onUseLatest: () => void;
  changedDetails?: string[];
}) {
  if (!visible) return null;
  return (
    <div className="version-conflict" role="status">
      <span>{canUseLatest ? "A newer snapshot is available." : "Waiting for the next live snapshot."} Your reason remains in this form.</span>
      {changedDetails.length > 0 && <ul>{changedDetails.map((detail) => <li key={detail}>{detail}</li>)}</ul>}
      <Button size="xs" variant="outline" type="button" disabled={!canUseLatest} onClick={onUseLatest}>
        Use latest version and keep reason
      </Button>
    </div>
  );
}

export function DashboardPage() {
  const provider = useSnapshot();
  const { snapshot, loading, error, refresh, applySnapshot } = provider;
  const [initialQuery] = useState(() => typeof window === "undefined"
    ? { incidentId: null, criteria: defaultCriteria, view: "queue" as const }
    : readDashboardQuery(window.location.search));
  const [initialDashboardParams] = useState(() => typeof window !== "undefined" &&
    ["incident", "q", "queue", "priority", "status", "zone", "sort", "view"].some((key) => new URLSearchParams(window.location.search).has(key)));
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(initialQuery.incidentId);
  const [selectedIncidentIds, setSelectedIncidentIds] = useState<string[]>([]);
  const [selectedReportIds, setSelectedReportIds] = useState<string[]>([]);
  const [criteria, setCriteria] = useState<QueueCriteria>(initialQuery.criteria);
  const [view, setView] = useState<"queue" | "map">(initialQuery.view);
  const [reviewMode, setReviewMode] = useState<ReviewMode | null>(null);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(Boolean(initialQuery.incidentId));
  const [scenario, setScenario] = useState<ReplayScenario>("demo");
  const [replayPending, setReplayPending] = useState(false);
  const [readReports, setReadReports] = useState<ReadReportMap>(loadReadReportMap);
  const queueListRef = useRef<HTMLDivElement>(null);
  const initializedEvents = useRef(new Set<string>());
  const hydratedEvent = useRef<string | null>(null);
  const skipPersistEvent = useRef<string | null>(null);
  const deepLinkPending = useRef(Boolean(initialQuery.incidentId));
  const { notice, setNotice } = useNotice();

  const visibleIncidents = useMemo(() => {
    if (!snapshot) return [];
    return sortQueue(
      snapshot.incidents.filter((incident) => matchesQueueCriteria(incident, criteria, snapshot.reports, snapshot.zones)),
      criteria.sort,
      snapshot.reports,
    );
  }, [snapshot, criteria]);
  const selectedIncident = snapshot?.incidents.find((incident) => incident.id === selectedIncidentId) ?? null;

  useEffect(() => {
    if (!snapshot) return;
    const eventId = snapshot.event.id;
    if (!initializedEvents.current.has(eventId)) {
      const eventHasReadState = Object.keys(readReports).some((key) => key.startsWith(`${eventId}:`));
      if (!eventHasReadState) {
        const baseline = { ...readReports };
        snapshot.incidents.forEach((incident) => { baseline[readKey(eventId, incident.id)] = incident.report_ids; });
        setReadReports(baseline);
        saveReadReportMap(baseline);
      }
      initializedEvents.current.add(eventId);
    }
    if (hydratedEvent.current !== eventId) {
      const firstHydration = hydratedEvent.current === null;
      hydratedEvent.current = eventId;
      if (!(firstHydration && initialDashboardParams)) {
        try {
          const saved = window.localStorage.getItem(persistedDashboardKey(eventId));
          const parsed = saved ? JSON.parse(saved) as { incidentId?: string; queueScroll?: number; criteria?: Partial<QueueCriteria>; view?: string } : {};
          if (saved) skipPersistEvent.current = eventId;
          const savedQuery = new URLSearchParams();
          const savedCriteria = parsed.criteria;
          if (typeof savedCriteria?.query === "string") savedQuery.set("q", savedCriteria.query);
          if (typeof savedCriteria?.filter === "string") savedQuery.set("queue", savedCriteria.filter);
          if (typeof savedCriteria?.priority === "string") savedQuery.set("priority", savedCriteria.priority);
          if (typeof savedCriteria?.status === "string") savedQuery.set("status", savedCriteria.status);
          if (typeof savedCriteria?.zone === "string") savedQuery.set("zone", savedCriteria.zone);
          if (typeof savedCriteria?.sort === "string") savedQuery.set("sort", savedCriteria.sort);
          if (parsed.view === "map") savedQuery.set("view", parsed.view);
          const restored = readDashboardQuery(`?${savedQuery.toString()}`);
          setCriteria(restored.criteria);
          setView(restored.view);
          const savedIncident = snapshot.incidents.find((item) => item.id === parsed.incidentId);
          if (savedIncident) {
            deepLinkPending.current = true;
            setSelectedIncidentId(savedIncident.id);
            setInspectorOpen(true);
          }
          if (queueListRef.current && typeof parsed.queueScroll === "number") queueListRef.current.scrollTop = parsed.queueScroll;
        } catch {
          // A bad saved view should not prevent opening the live dashboard.
        }
      }
    }
  }, [snapshot?.event.id]);

  useEffect(() => {
    if (!snapshot) return;
    if (deepLinkPending.current && selectedIncidentId === null) return;
    const selectedIsVisible = visibleIncidents.some((incident) => incident.id === selectedIncidentId);
    if (selectedIncidentId && selectedIsVisible) {
      deepLinkPending.current = false;
      return;
    }
    const selectedFromSnapshot = snapshot.incidents.find((incident) => incident.id === selectedIncidentId);
    if (selectedFromSnapshot && deepLinkPending.current) {
      const compatibleCriteria = criteriaForIncident(selectedFromSnapshot, criteria, snapshot.reports, snapshot.zones);
      setCriteria(compatibleCriteria);
      return;
    }
    setSelectedIncidentId(visibleIncidents[0]?.id ?? null);
    setSelectedReportIds([]);
    setReviewMode(null);
    setPriorityOpen(false);
    setStatusOpen(false);
  }, [snapshot, visibleIncidents, selectedIncidentId, criteria]);

  useEffect(() => {
    if (!snapshot) return;
    if (skipPersistEvent.current === snapshot.event.id) {
      skipPersistEvent.current = null;
      return;
    }
    const target = writeDashboardQuery(window.location.href, { incidentId: selectedIncidentId, criteria, view });
    window.history.replaceState(window.history.state, "", target);
    try {
      const previous = window.localStorage.getItem(persistedDashboardKey(snapshot.event.id));
      const parsed = previous ? JSON.parse(previous) as Record<string, unknown> : {};
      window.localStorage.setItem(persistedDashboardKey(snapshot.event.id), JSON.stringify({
        ...parsed,
        incidentId: selectedIncidentId,
        criteria,
        view,
        queueScroll: queueListRef.current?.scrollTop ?? 0,
      }));
    } catch {
      // The URL still keeps the current view when local storage is unavailable.
    }
  }, [snapshot?.event.id, selectedIncidentId, criteria, view]);

  const markIncidentRead = (incident: Incident, eventId: string) => {
    const next = { ...readReports, [readKey(eventId, incident.id)]: incident.report_ids };
    setReadReports(next);
    saveReadReportMap(next);
  };

  const selectIncident = (incidentId: string, source: Snapshot = snapshot!) => {
    setSelectedIncidentId(incidentId);
    setInspectorOpen(true);
    setSelectedReportIds([]);
    setReviewMode(null);
    setPriorityOpen(false);
    setStatusOpen(false);
    setSelectedIncidentIds([]);
    const incident = source.incidents.find((item) => item.id === incidentId)!;
    markIncidentRead(incident, source.event.id);
  };

  const onGroupingSaved = (next: Snapshot, message: string, moveNext = false) => {
    applySnapshot(next);
    setReviewMode(null);
    setSelectedReportIds([]);
    setSelectedIncidentIds([]);
    if (moveNext) {
      const nextReview = nextReviewCandidate(next, criteria, selectedIncidentId);
      if (nextReview) selectIncident(nextReview.id, next);
      else setNotice({ kind: "success", message: `${message} No other review item matches the current filters.` });
      if (nextReview) setNotice({ kind: "success", message });
      return;
    }
    setNotice({ kind: "success", message });
  };

  const selectNextReview = (source: Snapshot) => {
    const next = nextReviewCandidate(source, criteria, selectedIncidentId);
    if (next) selectIncident(next.id, source);
    else setNotice({ kind: "success", message: "No other review item matches the current filters." });
  };

  const toggleIncidentSelection = (incidentId: string) => {
    setSelectedIncidentIds((current) =>
      current.includes(incidentId)
        ? current.filter((id) => id !== incidentId)
        : [...current, incidentId],
    );
  };

  const toggleReportSelection = (reportId: string) => {
    setSelectedReportIds((current) =>
      current.includes(reportId)
        ? current.filter((id) => id !== reportId)
        : [...current, reportId],
    );
  };

  const handleReplayStart = async () => {
    const sourceEventId = snapshot!.event.id;
    setReplayPending(true);
    try {
      const next = await startReplay(scenario);
      applySnapshot(next, { activate: true, expectedEventId: sourceEventId });
      setSelectedIncidentIds([]);
      setSelectedReportIds([]);
      setNotice({ kind: "success", message: `Started the ${scenario} synthetic replay.` });
    } catch (caught) {
      setNotice({ kind: "error", message: errorText(caught) });
    } finally {
      setReplayPending(false);
    }
  };

  const handleReplayNext = async (replay: Replay) => {
    setReplayPending(true);
    try {
      const next = await advanceReplay(replay.session_id);
      const advanced = next.replay?.cursor !== replay.cursor;
      applySnapshot(next, { activate: true, expectedEventId: replay.event_id });
      setNotice({ kind: "success", message: advanced ? "Next synthetic report added." : "Replay is complete." });
    } catch (caught) {
      setNotice({ kind: "error", message: errorText(caught) });
    } finally {
      setReplayPending(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']")) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "/") {
      const search = document.querySelector<HTMLInputElement>(".queue-search input[type='search']");
      if (search) {
        event.preventDefault();
        search.focus();
      }
      return;
    }
    if (target instanceof HTMLElement && target.closest(".workspace-switch") && ["ArrowDown", "ArrowUp"].includes(event.key)) return;
    if (event.key === "Escape") {
      if (reviewMode || priorityOpen || statusOpen || selectedIncidentIds.length || selectedReportIds.length || inspectorOpen) {
        event.preventDefault();
        setReviewMode(null);
        setPriorityOpen(false);
        setStatusOpen(false);
        setSelectedIncidentIds([]);
        setSelectedReportIds([]);
        setInspectorOpen(false);
      }
      return;
    }
    if (!["j", "k", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    if (visibleIncidents.length === 0) return;
    event.preventDefault();
    const currentIndex = visibleIncidents.findIndex((incident) => incident.id === selectedIncidentId);
    const direction = event.key === "j" || event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = currentIndex < 0
      ? direction > 0 ? 0 : visibleIncidents.length - 1
      : (currentIndex + direction + visibleIncidents.length) % visibleIncidents.length;
    selectIncident(visibleIncidents[nextIndex]!.id);
  };

  if (loading && !snapshot) {
    return <div className="loading-state" role="status"><IconActivity /><span>Connecting to the exercise workspace…</span></div>;
  }

  if (!snapshot) {
    return (
      <div className="empty-state">
        <IconAlertTriangle />
        <strong>Exercise data is unavailable</strong>
        <span>{error ?? "The backend has not returned a current event snapshot."}</span>
        <Button variant="outline" onClick={() => void refresh()}><IconRefresh />Retry connection</Button>
      </div>
    );
  }

  const activeReplay = snapshot.replay;
  const scopeCriteria: QueueCriteria = { ...criteria, filter: "all" };
  const scopedIncidents = snapshot.incidents.filter((incident) => matchesQueueCriteria(incident, scopeCriteria, snapshot.reports, snapshot.zones));
  const scopedReportIds = new Set(scopedIncidents.flatMap((incident) => incident.report_ids));
  const scopedReports = snapshot.reports.filter((report) => scopedReportIds.has(report.id));
  const visibleReportIds = new Set(visibleIncidents.flatMap((incident) => incident.report_ids));
  const activeUnlocated = snapshot.reports.filter((report) => report.zone_id === null && visibleReportIds.has(report.id)).length;
  const checkedReports = selectedIncident
    ? selectedReportIds.filter((reportId) => selectedIncident.report_ids.includes(reportId))
    : [];
  const scopedReviewCount = scopedIncidents.filter((incident) => incident.review_required || incident.priority === "UNASSESSED").length;
  const scopedConflictCount = scopedIncidents.reduce((count, incident) => count + incident.conflicts.filter((conflict) => conflict.status === "unresolved").length, 0);
  const providerStatus = provider as typeof provider & { lastUpdated?: number | null; reconnecting?: boolean };
  const selectedUnreadIds = selectedIncident ? unreadReportIds(selectedIncident, readReports[readKey(snapshot.event.id, selectedIncident.id)] ?? []) : [];

  return (
    <div className="dashboard-page" onKeyDown={handleKeyDown}>
      <div className="page-heading">
        <div className="page-heading-copy">
          <h1>Situation overview</h1>
          <p className="page-subtitle">Provisional groups from the current exercise, ready for human review.</p>
        </div>
        <div className="heading-actions">
          <Button render={<Link to="/report" />} nativeButton={false}><IconMessageCircle />Report a situation</Button>
        </div>
      </div>

      {error && <div className="status-banner"><IconAlertTriangle /><span>Snapshot refresh failed: {error}. Showing the last successful snapshot.</span></div>}

      <SummaryStrip
        reports={scopedReports.length}
        groups={scopedIncidents.length}
        review={scopedReviewCount}
        conflicts={scopedConflictCount}
        onSelect={(next) => setCriteria((current) => ({ ...current, filter: next }))}
      />

      <div className="dashboard-toolbar">
        <div className="toolbar-left">
          <span className={`toolbar-caption visually-hidden${providerStatus.reconnecting ? " is-stale" : ""}`}><IconActivity />
            {providerStatus.reconnecting ? "Reconnecting" : providerStatus.lastUpdated ? `Updated ${formatAge(new Date(providerStatus.lastUpdated).toISOString())}` : "Live snapshot"}
          </span>
          <span className="policy-version">Policy {snapshot.event.policy_version}</span>
          <span className="matcher-label visually-hidden" title={snapshot.health.model_revision ?? snapshot.health.engine}>{engineLabel(snapshot.health)}</span>
        </div>
        <div className="toolbar-right">
          <details className="toolbar-menu replay-menu">
            <summary><IconPlayerPlay />Replay</summary>
            <div className="toolbar-menu-content">
              <label htmlFor="replay-scenario">Synthetic scenario</label>
              <NativeSelect id="replay-scenario" className="toolbar-select" value={scenario} onChange={(event) => setScenario(event.target.value as ReplayScenario)}>
                <option value="demo">Demo replay</option><option value="busy">Busy replay</option><option value="edge">Edge cases replay</option>
              </NativeSelect>
              <Button variant="outline" size="sm" disabled={replayPending} onClick={() => void handleReplayStart()}><IconPlayerPlay />{replayPending ? "Starting…" : "Start replay"}</Button>
              {activeReplay && <Button variant="secondary" size="sm" disabled={replayPending || activeReplay.cursor >= activeReplay.total} onClick={() => void handleReplayNext(activeReplay)}><IconPlayerTrackNext />{activeReplay.cursor >= activeReplay.total ? "Replay complete" : replayPending ? "Advancing…" : "Next report"}</Button>}
            </div>
          </details>
          <ExportMenu snapshot={snapshot} />
        </div>
      </div>

      <div className="workspace-switch" role="group" aria-label="Dashboard workspace view">
        <button type="button" aria-pressed={view === "queue"} onClick={() => setView("queue")}>Queue</button>
        <button type="button" aria-pressed={view === "map"} onClick={() => setView("map")}>Map</button>
      </div>
      <div className={`workspace-grid is-${view}${inspectorOpen ? " is-inspector-open" : " is-inspector-closed"}`}>
        <IncidentQueue
          incidents={visibleIncidents}
          reports={snapshot.reports}
          zones={snapshot.zones}
          selectedIncidentId={selectedIncidentId}
          selectedIncidentIds={selectedIncidentIds}
          criteria={criteria}
          queueListRef={queueListRef}
          unreadReportIds={readReports}
          eventId={snapshot.event.id}
          onCriteriaChange={(change) => setCriteria((current) => ({ ...current, ...change }))}
          onSelect={selectIncident}
          onToggleIncident={toggleIncidentSelection}
          onMerge={() => {
            const first = snapshot.incidents.find((incident) => selectedIncidentIds.includes(incident.id));
            if (first) {
              setSelectedIncidentId(first.id);
              setInspectorOpen(true);
              markIncidentRead(first, snapshot.event.id);
              setSelectedReportIds([]);
              setReviewMode(null);
              setPriorityOpen(false);
              setStatusOpen(false);
              setReviewMode("merge");
            }
          }}
        />

        <SchematicMap
          incidents={visibleIncidents.filter((incident) => incident.status !== "resolved")}
          zones={snapshot.zones}
          selectedIncidentId={selectedIncidentId}
          unlocatedCount={activeUnlocated}
          onSelect={selectIncident}
          onShowUnlocated={() => setCriteria((current) => ({ ...current, filter: "all", zone: "unlocated" }))}
        />

        <IncidentInspector
          incident={selectedIncident}
          incidents={snapshot.incidents}
          reports={snapshot.reports}
          zones={snapshot.zones}
          selectedReportIds={checkedReports}
          selectedIncidentIds={selectedIncidentIds}
          snapshot={snapshot}
          unreadReportIds={selectedUnreadIds}
          reviewMode={reviewMode}
          priorityOpen={priorityOpen}
          statusOpen={statusOpen}
          onToggleReport={toggleReportSelection}
          onReviewMode={setReviewMode}
          onPriorityOpen={setPriorityOpen}
          onStatusOpen={setStatusOpen}
          onApplySnapshot={applySnapshot}
          onGroupingSaved={onGroupingSaved}
          onNotice={setNotice}
          onSelectIncident={(incidentId) => {
            const related = snapshot.incidents.find((incident) => incident.id === incidentId)!;
            const compatibleCriteria = criteriaForIncident(related, criteria, snapshot.reports, snapshot.zones);
            if (compatibleCriteria !== criteria) {
              setCriteria(compatibleCriteria);
              setNotice({ kind: "success", message: "Queue filters were broadened to show this related group." });
            }
            selectIncident(incidentId);
          }}
          onNextReview={selectNextReview}
          onClose={() => setInspectorOpen(false)}
        />
      </div>
      {!inspectorOpen && <button type="button" className="open-inspector-button" onClick={() => setInspectorOpen(true)}>Open incident inspector</button>}

      <AuditTimeline snapshot={snapshot} />

      {activeReplay && (
        <p className="action-note replay-note" role="status">
          Replay step {activeReplay.cursor} of {activeReplay.total} · {activeReplay.scenario} scenario. Every step uses normal report ingestion.
        </p>
      )}
      {notice && <div className={`toast-message is-${notice.kind}`} role="status">{notice.message}</div>}
      <PrintBrief snapshot={snapshot} />
    </div>
  );
}

interface SummaryStripProps {
  reports: number;
  groups: number;
  review: number;
  conflicts: number;
  onSelect: (filter: QueueFilter) => void;
}

function SummaryStrip({ reports, groups, review, conflicts, onSelect }: SummaryStripProps) {
  return (
    <div className="summary-strip">
      <div className="summary-grid" role="group" aria-label="Exercise counts" aria-describedby="summary-scope-note">
        <SummaryCard value={reports} label="Reports received" onClick={() => onSelect("all")} />
        <SummaryCard value={groups} label="Provisional groups" onClick={() => onSelect("active")} />
        <SummaryCard value={review} label="Awaiting review" tone="warning" onClick={() => onSelect("review")} />
        <SummaryCard value={conflicts} label="Unresolved conflicts" tone="alert" onClick={() => onSelect("conflicts")} />
      </div>
      <p className="summary-scope-note" id="summary-scope-note">Counts follow the current search, priority, status, and zone filters across all queue tabs.</p>
    </div>
  );
}

function SummaryCard({
  value,
  label,
  tone,
  onClick,
}: {
  value: number;
  label: string;
  tone?: "warning" | "alert";
  onClick: () => void;
}) {
  return (
    <button type="button" className={`summary-card${tone ? ` is-${tone}` : ""}`} onClick={onClick} aria-label={`${label}: ${value}. Filter incident queue`}>
      <div className="summary-copy"><strong className="summary-value">{value}</strong><span className="summary-label">{label}</span></div>
    </button>
  );
}

interface IncidentQueueProps {
  incidents: Incident[];
  reports: Snapshot["reports"];
  zones: Zone[];
  selectedIncidentId: string | null;
  selectedIncidentIds: string[];
  criteria: QueueCriteria;
  queueListRef: React.RefObject<HTMLDivElement | null>;
  unreadReportIds: ReadReportMap;
  eventId: string;
  onCriteriaChange: (criteria: Partial<QueueCriteria>) => void;
  onSelect: (incidentId: string) => void;
  onToggleIncident: (incidentId: string) => void;
  onMerge: () => void;
}

function IncidentQueue({
  incidents,
  reports,
  zones,
  selectedIncidentId,
  selectedIncidentIds,
  criteria,
  queueListRef,
  unreadReportIds: readMap,
  eventId,
  onCriteriaChange,
  onSelect,
  onToggleIncident,
  onMerge,
}: IncidentQueueProps) {
  const filters: { id: QueueFilter; label: string }[] = [
    { id: "active", label: "Active" }, { id: "review", label: "Review" },
    { id: "conflicts", label: "Conflicts" }, { id: "all", label: "All" },
  ];
  const setFilter = (filter: QueueFilter) => onCriteriaChange({ filter });

  return (
    <section className="workspace-panel queue-panel" aria-labelledby="queue-heading">
      <div className="panel-header">
        <h2 className="panel-title" id="queue-heading"><IconListCheck />Incident queue</h2>
        <span className="panel-meta">{incidents.length} groups</span>
      </div>
      <div className="queue-tools">
        <div className="queue-filter" role="group" aria-label="Filter incident queue">
          {filters.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`filter-button${criteria.filter === item.id ? " is-selected" : ""}`}
              aria-pressed={criteria.filter === item.id}
              onClick={() => setFilter(item.id)}
            >{item.label}</button>
          ))}
        </div>
      </div>
      <div className="queue-controls">
        <label className="queue-search">
          <IconSearch size={15} />
          <span className="visually-hidden">Search incidents by title, ID, report text, or location</span>
          <Input type="search" value={criteria.query} placeholder="Search title, ID, report, location" onChange={(event) => onCriteriaChange({ query: event.target.value })} />
        </label>
        <div className="queue-filter-selects">
          <label><span className="visually-hidden">Filter by priority</span><NativeSelect aria-label="Filter by priority" value={criteria.priority} onChange={(event) => onCriteriaChange({ priority: event.target.value as QueueCriteria["priority"] })}>
            <option value="all">Any priority</option><option value="P0">P0 · Immediate</option><option value="P1">P1 · High</option><option value="P2">P2 · Standard</option><option value="UNASSESSED">Unassessed</option>
          </NativeSelect></label>
          <label><span className="visually-hidden">Filter by status</span><NativeSelect aria-label="Filter by status" value={criteria.status} onChange={(event) => onCriteriaChange({ status: event.target.value as QueueCriteria["status"] })}>
            <option value="all">Any status</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="monitoring">Monitoring</option><option value="resolved">Resolved</option>
          </NativeSelect></label>
          <label><span className="visually-hidden">Filter by zone</span><NativeSelect aria-label="Filter by zone" value={criteria.zone} onChange={(event) => onCriteriaChange({ zone: event.target.value })}>
            <option value="all">Any zone</option><option value="unlocated">Has unlocated report</option>{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.label}</option>)}
          </NativeSelect></label>
          <label><span className="visually-hidden">Sort incidents</span><NativeSelect aria-label="Sort incidents" value={criteria.sort} onChange={(event) => onCriteriaChange({ sort: event.target.value as QueueSort })}>
            <option value="priority">Priority</option><option value="oldest_unreviewed">Oldest unreviewed</option><option value="newest_update">Newest update</option><option value="latest_report">Latest report</option>
          </NativeSelect></label>
        </div>
      </div>
      {incidents.length === 0 ? (
        <div className="queue-empty">No incidents match this filter.</div>
      ) : (
        <div
          className="queue-list"
          ref={queueListRef}
          onScroll={(event) => {
            try {
              const key = persistedDashboardKey(eventId);
              const saved = window.localStorage.getItem(key);
              const parsed = saved ? JSON.parse(saved) as Record<string, unknown> : {};
              window.localStorage.setItem(key, JSON.stringify({ ...parsed, queueScroll: event.currentTarget.scrollTop }));
            } catch {
              // Scroll restoration is optional when storage is blocked.
            }
          }}
          aria-label="Incidents matching queue filters"
        >
          {incidents.map((incident) => {
            const reportList = incidentReports(incident, reports);
            const reasonCount = incident.review_reasons.length;
            const unresolved = incident.conflicts.some((conflict) => conflict.status === "unresolved");
            const newCount = unreadReportIds(incident, readMap[readKey(eventId, incident.id)] ?? []).length;
            return (
              <article
                key={incident.id}
                className={`incident-row${selectedIncidentId === incident.id ? " is-selected" : ""}`}
                aria-current={selectedIncidentId === incident.id ? "true" : undefined}
              >
                <span className={`priority-rail priority-rail-${incident.priority}`} />
                <button type="button" className="incident-row-main" onClick={() => onSelect(incident.id)}>
                  <span className="incident-row-body">
                    <span className="incident-row-title">{incident.title}<span className="incident-short-id">{shortDisplayId(incident.display_id, incident.id, "INC")}</span></span>
                    <span className="incident-row-meta">
                      <span>{zoneLabel(incident.zone_id, zones)}</span>
                      <span>{reportList.length} report{reportList.length === 1 ? "" : "s"}</span>
                      <span className={`mini-pill priority-pill-${incident.priority}`}>{incident.priority === "UNASSESSED" ? "Unassessed" : incident.priority}</span>
                      <span className="mini-pill">{displayStatus(incident.status)}</span>
                      {reasonCount > 0 && <span className="mini-pill is-review">{reviewReasonLabel(incident.review_reasons[0]!)}</span>}
                      {unresolved && <span className="mini-pill is-conflict">Conflict</span>}
                      {newCount > 0 && <span className="mini-pill is-new">{newCount} new</span>}
                    </span>
                  </span>
                  <span className="incident-row-time">Updated {formatAge(incident.updated_at)}</span>
                </button>
                <label className="visually-hidden" htmlFor={`select-${incident.id}`}>Select {incident.title} for a group action</label>
                <input
                  id={`select-${incident.id}`}
                  type="checkbox"
                  checked={selectedIncidentIds.includes(incident.id)}
                  aria-label={`Select ${incident.title} for a group action`}
                  onChange={() => onToggleIncident(incident.id)}
                />
              </article>
            );
          })}
        </div>
      )}
      {selectedIncidentIds.length > 0 && (
        <div className="selection-bar">
          <span className="selection-count">{selectedIncidentIds.length} selected</span>
          <Button size="xs" variant="secondary" disabled={selectedIncidentIds.length < 2} onClick={onMerge}>
            <IconGitMerge />Merge selected groups
          </Button>
        </div>
      )}
    </section>
  );
}

interface SchematicMapProps {
  incidents: Incident[];
  zones: Zone[];
  selectedIncidentId: string | null;
  unlocatedCount: number;
  onSelect: (incidentId: string) => void;
  onShowUnlocated: () => void;
}

function SchematicMap({ incidents, zones, selectedIncidentId, unlocatedCount, onSelect, onShowUnlocated }: SchematicMapProps) {
  const [expandedZoneId, setExpandedZoneId] = useState<string | null>(null);
  const expandedZone = zones.find((zone) => zone.id === expandedZoneId);
  const located = zones.flatMap((zone) => {
    const groups = incidents.filter((incident) => incident.zone_id === zone.id);
    return groups.length ? [{ zone, groups: sortIncidentsByPriority(groups) }] : [];
  });
  const mapZones = [...zones].sort((left, right) => left.x - right.x);
  const roadPath = mapZones.map((zone, index) => `${index === 0 ? "M" : "L"} ${zone.x} ${zone.y}`).join(" ");

  return (
    <section className="workspace-panel map-panel" aria-labelledby="map-heading">
      <div className="panel-header">
        <h2 className="panel-title" id="map-heading"><IconMap />Campus schematic</h2>
        <span className="panel-meta">Illustrative · not to scale</span>
      </div>
      <div className="map-wrap">
        <div className="map-caption">
          <div className="map-caption-copy"><strong>Reported locations</strong><span>Active groups matching queue filters with known zones.</span></div>
          <div className="map-legend" aria-label="Marker legend">
            <span className="map-legend-item"><i className="legend-dot is-risk" />P0</span>
            <span className="map-legend-item"><i className="legend-dot" />Other</span>
          </div>
        </div>
        <div className="map-canvas">
          <svg className="map-svg" viewBox="0 0 1000 600" role="img" aria-label="Illustrative campus zone map">
            <path className="map-road" d={roadPath} />
            <path className="map-road" d="M 230 180 L 470 180 L 720 180 M 120 430 L 470 430 L 820 430" />
            <rect className="map-hall" x="305" y="90" width="330" height="182" rx="18" />
            {zones.map((zone) => {
              const labelLines = zone.label.trim().split(/\s+/);
              const labelHeight = Math.max(96, labelLines.length * 34 + 28);
              return (
                <g key={zone.id}>
                  <rect className="map-zone" x={zone.x - 110} y={zone.y - labelHeight / 2} width="220" height={labelHeight} rx="10" />
                  <text className="map-zone-label" aria-label={zone.label}>
                    {labelLines.map((word, index) => (
                      <tspan key={`${zone.id}-${index}`} x={zone.x} y={zone.y + (index - (labelLines.length - 1) / 2) * 34}>{word}</tspan>
                    ))}
                  </text>
                </g>
              );
            })}
            {located.map(({ zone, groups }) => {
              const primary = groups[0]!;
              const markerY = zone.y + 70;
              const groupReports = groups.reduce((count, incident) => count + incident.report_ids.length, 0);
              const markerLabel = groups.length === 1
                ? `${primary.title}, ${priorityLabel(primary.priority)}, ${primary.report_ids.length} reports`
                : `${zone.label}, ${groups.length} incident groups`;
              return (
                <g
                  key={zone.id}
                  className={`map-marker map-marker-${primary.priority.toLowerCase()}${groups.some((incident) => incident.id === selectedIncidentId) ? " map-marker-selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label={markerLabel}
                  aria-pressed={groups.some((incident) => incident.id === selectedIncidentId)}
                  onClick={() => groups.length === 1 ? onSelect(primary.id) : setExpandedZoneId(expandedZoneId === zone.id ? null : zone.id)}
                  onKeyDown={(event: KeyboardEvent<SVGGElement>) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      if (groups.length === 1) onSelect(primary.id);
                      else setExpandedZoneId(expandedZoneId === zone.id ? null : zone.id);
                    }
                  }}
                >
                  <circle className="map-marker-ring" cx={zone.x} cy={markerY} r={groups.length > 1 ? 20 : 15} />
                  <circle className="map-marker-core" cx={zone.x} cy={markerY} r="9" />
                  <text className="map-marker-count" x={zone.x} y={markerY}>{groups.length > 1 ? groups.length : groupReports}</text>
                </g>
              );
            })}
          </svg>
        </div>
        {expandedZone && (
          <div className="map-group-list" aria-label={`Groups in ${expandedZone.label}`}>
            <strong>{expandedZone.label} · groups at this location</strong>
            {incidents.filter((incident) => incident.zone_id === expandedZoneId).map((incident) => (
              <button key={incident.id} type="button" className={selectedIncidentId === incident.id ? "is-selected" : ""} onClick={() => onSelect(incident.id)}>
                <span className={`priority-rail priority-rail-${incident.priority}`} /><span>{incident.title}</span><span>{incident.priority} · {incident.report_ids.length} reports</span>
              </button>
            ))}
          </div>
        )}
        <button type="button" className="unlocated-tray" onClick={onShowUnlocated}>
          <span><IconMapPin size={13} /> <strong>Unlocated reports</strong> · filter queue</span><span>{unlocatedCount}</span>
        </button>
      </div>
      <p className="map-note">Illustrative event zones only. This schematic is not a live safety map and does not imply verified conditions.</p>
    </section>
  );
}

function sortIncidentsByPriority(incidents: Incident[]): Incident[] {
  return [...incidents].sort((left, right) => priorityOrder[left.priority] - priorityOrder[right.priority] || left.title.localeCompare(right.title));
}

interface IncidentInspectorProps {
  incident: Incident | null;
  incidents: Incident[];
  reports: Snapshot["reports"];
  zones: Zone[];
  snapshot: Snapshot;
  selectedReportIds: string[];
  selectedIncidentIds: string[];
  unreadReportIds: string[];
  reviewMode: ReviewMode | null;
  priorityOpen: boolean;
  statusOpen: boolean;
  onToggleReport: (reportId: string) => void;
  onReviewMode: (mode: ReviewMode | null) => void;
  onPriorityOpen: (open: boolean) => void;
  onStatusOpen: (open: boolean) => void;
  onApplySnapshot: (snapshot: Snapshot) => void;
  onGroupingSaved: (snapshot: Snapshot, message: string, moveNext?: boolean) => void;
  onNotice: (notice: Notice) => void;
  onSelectIncident: (incidentId: string) => void;
  onNextReview: (snapshot: Snapshot) => void;
  onClose: () => void;
}

function IncidentInspector({
  incident,
  incidents,
  reports,
  zones,
  snapshot,
  selectedReportIds,
  selectedIncidentIds,
  unreadReportIds: newReportIds,
  reviewMode,
  priorityOpen,
  statusOpen,
  onToggleReport,
  onReviewMode,
  onPriorityOpen,
  onStatusOpen,
  onApplySnapshot,
  onGroupingSaved,
  onNotice,
  onSelectIncident,
  onNextReview,
  onClose,
}: IncidentInspectorProps) {
  const [titleOpen, setTitleOpen] = useState(false);
  const [reportSectionOpen, setReportSectionOpen] = useState(true);
  const inspectorContentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (newReportIds.length > 0) setReportSectionOpen(true);
  }, [newReportIds.length]);
  useEffect(() => {
    if (!incident) return;
    setReportSectionOpen(true);
    setTitleOpen(false);
  }, [incident?.id]);
  useEffect(() => {
    if (!incident) return;
    try {
      const saved = window.localStorage.getItem(persistedInspectorKey(snapshot.event.id, incident.id));
      if (saved !== null && inspectorContentRef.current) inspectorContentRef.current.scrollTop = Number(saved) || 0;
    } catch {
      // The live inspector remains usable when storage is blocked.
    }
  }, [snapshot.event.id, incident?.id]);
  if (!incident) {
    return (
      <section className="workspace-panel inspector-panel" aria-label="Incident inspector">
        <div className="panel-header"><h2 className="panel-title">Incident inspector</h2><Button className="inspector-close-button" size="xs" variant="ghost" onClick={onClose}><IconX />Close</Button></div>
        <div className="inspector-empty"><IconMapPin /><strong>Select a provisional group</strong><span>Review its source reports, evidence, priority rule, and coordinator actions.</span></div>
      </section>
    );
  }

  const sourceReports = incidentReports(incident, reports);
  const sourceById = new Map(snapshot.reports.map((report) => [report.id, report]));
  const locateSourceReport = (reportId: string) => {
    setReportSectionOpen(true);
    const scrollToReport = () => {
      const reportElement = document.getElementById(`source-report-${reportId}`);
      if (!reportElement) return;
      if (typeof reportElement.scrollIntoView === "function") reportElement.scrollIntoView({ behavior: "smooth", block: "center" });
      reportElement.focus({ preventScroll: true });
    };
    window.setTimeout(scrollToReport, 0);
  };
  const highlightPhrasesForReport = (report: Report) => [
    ...report.claims.map((claim) => claim.span),
    ...citedPriorityPhrases(incident.priority_reason, report),
    ...incident.conflicts.flatMap((conflict) => conflict.report_ids.flatMap((reportId, index) =>
      reportId === report.id && conflict.spans[index] ? [conflict.spans[index]!] : [])),
  ];
  const prioritySourcePhrases = sourceReports.flatMap((report) => citedPriorityPhrases(incident.priority_reason, report).map((phrase) => ({ report, phrase })));
  const undoableAction = snapshot.undoable_actions?.find((action) => action.incident_id === incident.id);

  return (
    <section className="workspace-panel inspector-panel" aria-labelledby="inspector-heading">
      <div className="panel-header">
        <h2 className="panel-title" id="inspector-heading">Incident inspector</h2>
        <div className="inspector-head-actions"><button type="button" className="copy-id" aria-label={`Copy full incident ID ${incident.id}`} onClick={() => void copyValue(incident.id).then((copied) => onNotice({ kind: copied ? "success" : "error", message: copied ? "Full incident ID copied." : "Clipboard access is unavailable." }))}><IconCopy size={14} />{shortDisplayId(incident.display_id, incident.id, "INC")}</button><span className="panel-meta mono">v{incident.version}</span><Button className="inspector-close-button" size="xs" variant="ghost" onClick={onClose}><IconX />Close</Button></div>
      </div>
      <div
        className="inspector-content"
        ref={inspectorContentRef}
        onScroll={(event) => {
          try { window.localStorage.setItem(persistedInspectorKey(snapshot.event.id, incident.id), String(event.currentTarget.scrollTop)); } catch { /* optional saved scroll */ }
        }}
      >
        <div className="inspector-title-row">
          <div className="inspector-title-copy">
            <h3 className="inspector-title">{incident.title}</h3>
            <div className="inspector-meta">
              <span className={`priority-badge priority-${incident.priority}`}><span className={`priority-rail priority-rail-${incident.priority}`} />{priorityLabel(incident.priority)}</span>
              <span className="mini-pill">{displayStatus(incident.status)}</span>
              <span className="mini-pill">{zoneLabel(incident.zone_id, zones)}</span>
            </div>
          </div>
          <div className="inspector-title-actions"><span className="panel-meta">{sourceReports.length} reports</span><Button size="xs" variant="ghost" onClick={() => setTitleOpen((open) => !open)}><IconEdit />{titleOpen ? "Cancel title edit" : "Edit title"}</Button></div>
        </div>

        {titleOpen && <TitleForm key={`title-${incident.id}`} incident={incident} onCancel={() => setTitleOpen(false)} onSaved={(next) => { onApplySnapshot(next); setTitleOpen(false); onNotice({ kind: "success", message: "Incident title updated with its reason." }); }} />}

        {incident.review_required && incident.review_reasons.length > 0 && <div className="inspector-rule triage-rule">
          <span className="inspector-rule-label">Review required · {incident.review_reasons.length} reason{incident.review_reasons.length === 1 ? "" : "s"}</span>
          <p><span className="triage-reason-label">Check these areas</span>{[...new Set(incident.review_reasons.map(reviewReasonLabel))].join(" · ")}</p>
          <details className="triage-details"><summary>Show all review reasons</summary>{incident.review_reasons.map((reason, index) => <p key={`${incident.id}-review-${index}`}><span className="triage-reason-label">{reviewReasonLabel(reason)}</span>{reason}</p>)}</details>
        </div>}

        <div className="inspector-rule">
          <span className="inspector-rule-label">Priority policy · suggested {priorityLabel(incident.suggested_priority)}</span>
          <p>{incident.priority_reason}</p>
          {prioritySourcePhrases.length > 0 && <div className="priority-source-phrases"><span>Source phrase</span>{prioritySourcePhrases.map(({ report, phrase }, index) => <button type="button" className="source-phrase-link" key={`${report.id}-${index}`} onClick={() => locateSourceReport(report.id)} aria-label={`Show priority source phrase from ${shortDisplayId(report.display_id, report.id, "RPT")}`}>“{phrase}” · {shortDisplayId(report.display_id, report.id, "RPT")}</button>)}</div>}
          {incident.override_reason && <p>Coordinator override: {incident.override_reason}</p>}
          {incident.override_reason != null && <ResetPriorityButton key={`reset-priority-${incident.id}`} incident={incident} onSaved={onApplySnapshot} onNotice={onNotice} />}
        </div>

        <RelatedGroups snapshot={snapshot} incident={incident} onSelect={onSelectIncident} />

        <details className="inspector-disclosure report-disclosure" open={reportSectionOpen} onToggle={(event) => setReportSectionOpen(event.currentTarget.open)}>
          <summary><span><h3>Source reports</h3><span className="panel-meta">Original text is preserved · Times in {snapshot.event.timezone} · {newReportIds.length} new since viewed</span></span><span className="disclosure-state" /></summary>
          <div className="report-stack">
            {sourceReports.map((report) => (
              <article id={`source-report-${report.id}`} tabIndex={-1} key={report.id} className={`source-report${newReportIds.includes(report.id) ? " is-new" : ""}`}>
                <div className="source-report-head">
                  <span className="source-report-id">{shortDisplayId(report.display_id, report.id, "RPT")}</span>
                  {report.display_id && <span className="historical-label">{report.id}</span>}
                  <button type="button" className="copy-icon-button" aria-label={`Copy full report ID ${report.id}`} onClick={() => void copyValue(report.id).then((copied) => onNotice({ kind: copied ? "success" : "error", message: copied ? "Full report ID copied." : "Clipboard access is unavailable." }))}><IconCopy size={13} /></button>
                  {newReportIds.includes(report.id) && <span className="mini-pill is-new">New</span>}
                  <label className="visually-hidden" htmlFor={`report-select-${report.id}`}>Select report {report.id} for a coordinator action</label>
                  <input
                    id={`report-select-${report.id}`}
                    className="report-select"
                    type="checkbox"
                    checked={selectedReportIds.includes(report.id)}
                    aria-label={`Select report ${report.id} for a coordinator action`}
                    onChange={() => onToggleReport(report.id)}
                  />
                </div>
                <p><HighlightedText text={report.text} phrases={highlightPhrasesForReport(report)} /></p>
                <div className="source-report-meta">
                  <span><IconClock size={12} />Occurred {report.reported_at ? formattedTime(report.reported_at, snapshot.event.timezone) : "Not reported"}</span>
                  <span><IconClock size={12} />Received {formattedTime(report.received_at, snapshot.event.timezone)}</span>
                  <span>{zoneLabel(report.zone_id, zones)}</span>
                  {report.sublocation && <span>{report.sublocation}</span>}
                  {report.analysis_status !== "complete" && <span className="mini-pill is-review">Analysis {report.analysis_status}</span>}
                    {report.analysis_status !== "complete" && <Button size="xs" variant="outline" onClick={() => void retryAnalysis(report.id, { expected_version: incident.version }).then(onApplySnapshot).then(() => onNotice({ kind: "success", message: "Report analysis retry requested." })).catch((error: unknown) => onNotice({ kind: "error", message: errorText(error) }))}>Retry {report.analysis_status === "failed" ? "failed" : "pending"} analysis</Button>}
                </div>
              </article>
            ))}
          </div>
        </details>

        <details className="inspector-disclosure">
          <summary><span><h3>Grouping evidence</h3><span className="panel-meta">Ranking signals · not probabilities · {incident.evidence.length} comparisons</span></span><span className="disclosure-state" /></summary>
          {incident.evidence.length === 0 ? (
            <p className="action-note">No pairwise evidence is available for this group.</p>
          ) : (
            <div className="evidence-list">
              {incident.evidence.map((evidence, index) => (
                <article className="evidence-card" key={`${evidence.report_id}-${evidence.candidate_report_id}-${index}`}>
                  <div className="evidence-topline"><span>{shortDisplayId(sourceById.get(evidence.report_id)?.display_id, evidence.report_id, "RPT")} ↔ {shortDisplayId(sourceById.get(evidence.candidate_report_id)?.display_id, evidence.candidate_report_id, "RPT")}</span><span className="evidence-decision">{evidence.decision}</span></div>
                  <span className="historical-label">Historical comparison{evidence.created_at ? ` · ${formattedTime(evidence.created_at, snapshot.event.timezone)}` : ""}</span>
                  <div className="score-grid">
                    <ScoreCell label="Text similarity" value={evidence.semantic_score} />
                    <ScoreCell label="Location" value={evidence.location_score} />
                    <ScoreCell label="Time" value={evidence.time_score} />
                    <ScoreCell label="Total" value={evidence.total_score} />
                  </div>
                  {(evidence.reasons.length > 0 || evidence.missing_fields.length > 0) && (
                    <div className="evidence-notes">
                      {evidence.reasons.map((reason, reasonIndex) => <span key={`reason-${reasonIndex}`}>{reason}</span>)}
                      {evidence.missing_fields.length > 0 && <span>Missing context: {evidence.missing_fields.join(", ")}</span>}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </details>

        <details className="inspector-disclosure">
          <summary><span><h3>Extracted claims</h3><span className="panel-meta">Source phrases that support these fields</span></span><span className="disclosure-state" /></summary>
          {sourceReports.some((report) => report.claims.length > 0) ? (
            <div className="claim-list">
              {sourceReports.flatMap((report) => report.claims.map((claim, index) => (
                <div className="claim-row" key={`${report.id}-${claim.field}-${index}`}>
                  <span className="claim-field">{claim.field.replaceAll("_", " ")}</span>
                  <button type="button" className="claim-span source-phrase-link" onClick={() => locateSourceReport(report.id)} aria-label={`Show source report ${shortDisplayId(report.display_id, report.id, "RPT")} for claim ${claim.field.replaceAll("_", " ")}`}>
                    “{claim.span}” · {claim.value}
                  </button>
                </div>
              )))}
            </div>
          ) : <p className="action-note">No supported claim fields were extracted from these reports.</p>}
        </details>

        <NotesPanel key={`notes-${incident.id}`} incident={incident} timeZone={snapshot.event.timezone} onSaved={onApplySnapshot} onNotice={onNotice} />
        <IncidentTimeline key={incident.id} incident={incident} reports={sourceReports} snapshot={snapshot} />

        {incident.conflicts.length > 0 && (
          <div className="inspector-section">
            <div className="inspector-section-heading"><h3>Conflicting or changing reports</h3><span className="panel-meta">Coordinator review</span></div>
            {incident.conflicts.map((conflict) => (
              <ConflictCard
                key={conflict.id}
                conflict={conflict}
                incident={incident}
                onLocateSource={locateSourceReport}
                onApplySnapshot={onApplySnapshot}
                onNotice={onNotice}
              />
            ))}
          </div>
        )}

        <div className="coordinator-actions">
          <div className="inspector-section-heading"><h3>Coordinator actions</h3><span className="panel-meta">Each decision is audited</span></div>
          <div className="action-row">
            <Button size="sm" variant="outline" onClick={() => onReviewMode(reviewMode === "confirm" ? null : "confirm")}><IconCircleCheck />Confirm grouping</Button>
            <Button size="sm" variant="outline" disabled={selectedReportIds.length === 0} onClick={() => onReviewMode(reviewMode === "reject" ? null : "reject")}><IconX />Reject pairing</Button>
          </div>
          {selectedReportIds.length > 0 && <div className="action-row"><Button size="sm" variant="secondary" onClick={() => onReviewMode(reviewMode === "move" ? null : "move")}><IconArrowsExchange />Move selected</Button><Button size="sm" variant="secondary" onClick={() => onReviewMode(reviewMode === "split" ? null : "split")}><IconGitMerge />Split selected reports</Button></div>}
          {selectedIncidentIds.length > 1 && <Button size="sm" variant="secondary" onClick={() => onReviewMode("merge")}><IconGitMerge />Merge {selectedIncidentIds.length} selected groups</Button>}
          {selectedReportIds.length === 0 && <p className="action-note">Select one or more source reports to move, split, or reject a pairing.</p>}
          <div className="action-row">
            <Button size="sm" variant="ghost" onClick={() => onPriorityOpen(!priorityOpen)}>Override priority</Button>
            <Button size="sm" variant="ghost" onClick={() => onStatusOpen(!statusOpen)}>Change status</Button>
          </div>
          {undoableAction && <UndoActionForm key={`undo-${undoableAction.audit_id}`} action={undoableAction} incident={incident} onSaved={onApplySnapshot} onNotice={onNotice} />}

          {reviewMode && (
            <GroupingReviewForm
              key={`${reviewMode}-${incident.id}`}
              mode={reviewMode}
              incident={incident}
              incidents={incidents}
              selectedReportIds={selectedReportIds}
              selectedIncidentIds={selectedIncidentIds}
              onCancel={() => onReviewMode(null)}
              onSaved={onGroupingSaved}
            />
          )}
          {priorityOpen && <PriorityForm key={`priority-${incident.id}`} incident={incident} onCancel={() => onPriorityOpen(false)} onSaved={onApplySnapshot} onNotice={onNotice} onNextReview={onNextReview} />}
          {statusOpen && <StatusForm key={`status-${incident.id}`} incident={incident} onCancel={() => onStatusOpen(false)} onSaved={onApplySnapshot} onNotice={onNotice} onNextReview={onNextReview} />}
        </div>
      </div>
    </section>
  );
}

function ScoreCell({ label, value }: { label: string; value: number | null }) {
  return <div className="score-cell"><span>{label}</span><strong>{evidenceScore(value)}</strong></div>;
}

function HighlightedText({ text, phrases }: { text: string; phrases: string[] }) {
  const ranges = highlightRanges(text, phrases);
  if (!ranges.length) return <>{text}</>;
  const fragments: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) fragments.push(text.slice(cursor, range.start));
    fragments.push(<mark key={`${range.start}-${index}`}>{text.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  });
  if (cursor < text.length) fragments.push(text.slice(cursor));
  return <>{fragments}</>;
}

function TitleForm({ incident, onCancel, onSaved }: { incident: Incident; onCancel: () => void; onSaved: (snapshot: Snapshot) => void }) {
  const [title, setTitle] = useState(incident.title);
  const [reason, setReason] = useState("");
  const [expectedVersion, setExpectedVersion] = useState(incident.version);
  const [incidentAtOpen, setIncidentAtOpen] = useState(incident);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [versionConflict, setVersionConflict] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (title.trim().length < 3 || reason.trim().length < 3) {
      setError("Enter a title and reason with at least 3 characters each.");
      return;
    }
    setPending(true);
    setError(null);
    setVersionConflict(false);
    try {
      onSaved(await updateIncidentTitle(incident.id, { title: title.trim(), reason: reason.trim(), expected_version: expectedVersion }));
    } catch (caught) {
      setError(errorText(caught));
      setVersionConflict(isVersionConflict(caught));
    } finally {
      setPending(false);
    }
  };
  return <form className="action-form" onSubmit={(event) => void submit(event)}>
    <label>Incident title<Input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} /></label>
    <label>Reason for title change<Textarea value={reason} minLength={3} maxLength={1000} required placeholder="What does the source evidence support?" onChange={(event) => setReason(event.target.value)} /></label>
    {error && <span className="form-error" role="alert">{error}</span>}
    <VersionConflictNotice visible={versionConflict} canUseLatest={incident.version !== expectedVersion} changedDetails={changedIncidentDetails(incidentAtOpen, incident)} onUseLatest={() => { setExpectedVersion(incident.version); setIncidentAtOpen(incident); setVersionConflict(false); setError(null); }} />
    <div className="form-actions"><Button size="xs" type="button" variant="ghost" onClick={onCancel}>Cancel</Button><Button size="xs" type="submit" disabled={pending}>{pending ? "Saving…" : "Save title"}</Button></div>
  </form>;
}

function NotesPanel({ incident, timeZone, onSaved, onNotice }: { incident: Incident; timeZone: string; onSaved: (snapshot: Snapshot) => void; onNotice: (notice: Notice) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!text.trim()) { setError("Write a note before saving."); return; }
    setPending(true);
    setError(null);
    try {
      onSaved(await addIncidentNote(incident.id, { text: text.trim(), expected_version: incident.version }));
      setText("");
      onNotice({ kind: "success", message: "Coordinator note saved." });
    } catch (caught) {
      setError(errorText(caught));
      onNotice({ kind: "error", message: errorText(caught) });
    } finally {
      setPending(false);
    }
  };
  return <section className="inspector-section notes-section" aria-labelledby="notes-heading">
    <div className="inspector-section-heading"><h3 id="notes-heading">Coordinator notes</h3><span className="panel-meta">Standalone notes · {incident.notes?.length ?? 0}</span></div>
    {(incident.notes?.length ?? 0) > 0 && <ol className="notes-list">{incident.notes!.map((note) => <li key={note.id}><p>{note.text}</p><span>{note.actor} · {formattedTime(note.created_at, timeZone)}</span></li>)}</ol>}
    <form className="note-form" onSubmit={(event) => void submit(event)}>
      <label className="visually-hidden" htmlFor={`incident-note-${incident.id}`}>Add a coordinator note</label>
      <Textarea id={`incident-note-${incident.id}`} value={text} maxLength={1000} placeholder="Add a note without changing the incident title or status." onChange={(event) => setText(event.target.value)} />
      {error && <span className="form-error" role="alert">{error}</span>}
      <div className="form-actions"><Button size="xs" type="submit" disabled={pending || !text.trim()}>{pending ? "Saving…" : "Save note"}</Button></div>
    </form>
  </section>;
}

function IncidentTimeline({ incident, reports, snapshot }: { incident: Incident; reports: Snapshot["reports"]; snapshot: Snapshot }) {
  const [expanded, setExpanded] = useState(false);
  const currentReportIds = new Set(incident.report_ids);
  const currentConflictIds = new Set(incident.conflicts.map((conflict) => conflict.id));
  const reportById = new Map(reports.map((report) => [report.id, report]));
  const relevantAudit = snapshot.audit.flatMap((entry) => {
    const action = entry.action.toLocaleLowerCase();
    if (currentReportIds.has(entry.entity_id)) {
      if (action === "report.received") return [];
      const report = reportById.get(entry.entity_id)!;
      const kind = /^report\.(analyzed|analysis_failed|analysis_retry_started)$/.test(action) ? "Report lifecycle" : "Report decision";
      const source = shortDisplayId(report.display_id, report.id, "RPT");
      const detail = `${source} · ${entry.actor} · ${displayStatus(entry.action)}${entry.reason ? ` · ${entry.reason}` : ""}`;
      return [{ entry, kind, detail }];
    }
    if (currentConflictIds.has(entry.entity_id)) {
      const conflict = incident.conflicts.find((item) => item.id === entry.entity_id)!;
      const source = conflict.field.replaceAll("_", " ");
      const detail = `${source} · ${entry.actor} · ${displayStatus(entry.action)}${entry.reason ? ` · ${entry.reason}` : ""}`;
      return [{ entry, kind: "Conflict review", detail }];
    }
    if (entry.entity_id === incident.id) {
      const detail = `${entry.actor} · ${displayStatus(entry.action)}${entry.reason ? ` · ${entry.reason}` : ""}`;
      return [{ entry, kind: "Coordinator decision", detail }];
    }
    return [];
  });
  const entries = [
    ...reports.flatMap((report) => [
      { id: `${report.id}-received`, kind: "Report received", time: report.received_at, detail: `${shortDisplayId(report.display_id, report.id, "RPT")} entered the exercise workspace.`, sortTime: new Date(report.received_at).valueOf() },
      ...(report.reported_at ? [{ id: `${report.id}-occurred`, kind: "Reported occurrence", time: report.reported_at, detail: `${shortDisplayId(report.display_id, report.id, "RPT")} account of when the event occurred.`, sortTime: new Date(report.reported_at).valueOf() }] : []),
    ]),
    ...relevantAudit.map(({ entry, kind, detail }) => ({
      id: entry.id,
      kind,
      time: entry.created_at,
      detail,
      sortTime: new Date(entry.created_at).valueOf(),
    })),
  ].sort((left, right) => right.sortTime - left.sortTime || right.id.localeCompare(left.id));
  const visible = expanded ? entries : entries.slice(0, 4);
  return <section className="inspector-section incident-timeline" aria-labelledby="incident-timeline-heading">
    <div className="inspector-section-heading"><h3 id="incident-timeline-heading">Incident timeline</h3>{entries.length > 4 && <button type="button" className="audit-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Show recent" : `View all ${entries.length}`}</button>}</div>
    {entries.length === 0 ? <p className="action-note">No report or coordinator events have been recorded.</p> : <ol>{visible.map((entry) => <li key={entry.id} className={`timeline-entry is-${entry.kind.toLocaleLowerCase().replaceAll(" ", "-")}`}><span className="timeline-kind">{entry.kind}</span><time dateTime={entry.time}>{formattedTime(entry.time, snapshot.event.timezone)}</time><p>{entry.detail}</p></li>)}</ol>}
  </section>;
}

function ResetPriorityButton({ incident, onSaved, onNotice }: { incident: Incident; onSaved: (snapshot: Snapshot) => void; onNotice: (notice: Notice) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [expectedVersion, setExpectedVersion] = useState(incident.version);
  const [incidentAtOpen, setIncidentAtOpen] = useState(incident);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [versionConflict, setVersionConflict] = useState(false);
  const submit = async () => {
    if (reason.trim().length < 3) { setError("Enter a reason of at least 3 characters."); return; }
    setPending(true);
    setError(null);
    setVersionConflict(false);
    try {
      onSaved(await resetPriority(incident.id, { reason: reason.trim(), expected_version: expectedVersion }));
      setOpen(false);
      onNotice({ kind: "success", message: "Priority returned to the policy suggestion." });
    } catch (caught) {
      setError(errorText(caught));
      setVersionConflict(isVersionConflict(caught));
    } finally {
      setPending(false);
    }
  };
  return <div className="reset-priority">
    {open ? <div className="reset-priority-form"><label>Reason for returning to {incident.suggested_priority}<Textarea value={reason} minLength={3} maxLength={1000} required onChange={(event) => setReason(event.target.value)} /></label>{error && <span role="alert" className="form-error">{error}</span>}<VersionConflictNotice visible={versionConflict} canUseLatest={incident.version !== expectedVersion} changedDetails={changedIncidentDetails(incidentAtOpen, incident)} onUseLatest={() => { setExpectedVersion(incident.version); setIncidentAtOpen(incident); setVersionConflict(false); setError(null); }} /><div className="form-actions"><Button size="xs" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button size="xs" onClick={() => void submit()} disabled={pending}>{pending ? "Saving…" : "Reset priority"}</Button></div></div> : <Button size="xs" variant="outline" onClick={() => { setReason(""); setError(null); setExpectedVersion(incident.version); setIncidentAtOpen(incident); setVersionConflict(false); setOpen(true); }}>Reset to suggested priority</Button>}
  </div>;
}

function UndoActionForm({ action, incident, onSaved, onNotice }: { action: NonNullable<Snapshot["undoable_actions"]>[number]; incident: Incident; onSaved: (snapshot: Snapshot) => void; onNotice: (notice: Notice) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [expectedVersion, setExpectedVersion] = useState(incident.version);
  const [incidentAtOpen, setIncidentAtOpen] = useState(incident);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [versionConflict, setVersionConflict] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (reason.trim().length < 3) { setError("Enter a reason of at least 3 characters."); return; }
    setPending(true);
    setError(null);
    setVersionConflict(false);
    try {
      onSaved(await undoDecision(action.audit_id, { reason: reason.trim(), expected_version: expectedVersion }));
      setOpen(false);
      onNotice({ kind: "success", message: "The last eligible decision was undone." });
    } catch (caught) {
      setError(errorText(caught));
      setVersionConflict(isVersionConflict(caught));
    } finally {
      setPending(false);
    }
  };
  return open ? <form className="action-form" onSubmit={(event) => void submit(event)}><strong>Undo {displayStatus(action.action)}</strong><label>Reason<Textarea value={reason} minLength={3} maxLength={1000} required onChange={(event) => setReason(event.target.value)} /></label>{error && <span className="form-error" role="alert">{error}</span>}<VersionConflictNotice visible={versionConflict} canUseLatest={incident.version !== expectedVersion} changedDetails={changedIncidentDetails(incidentAtOpen, incident)} onUseLatest={() => { setExpectedVersion(incident.version); setIncidentAtOpen(incident); setVersionConflict(false); setError(null); }} /><div className="form-actions"><Button size="xs" type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button size="xs" type="submit" disabled={pending}>{pending ? "Saving…" : "Save undo"}</Button></div></form> : <Button size="sm" variant="outline" onClick={() => { setExpectedVersion(incident.version); setIncidentAtOpen(incident); setOpen(true); }}><IconHistory />Undo last {displayStatus(action.action)}</Button>;
}

function ExportMenu({ snapshot }: { snapshot: Snapshot }) {
  return <details className="toolbar-menu export-menu">
    <summary><IconFileExport />Export</summary>
    <div className="toolbar-menu-content">
      <Button variant="outline" size="sm" onClick={() => window.print()}><IconPrinter />Print incident brief</Button>
      <Button variant="outline" size="sm" onClick={() => saveFile(`aegis-${snapshot.event.id}-brief.json`, "application/json;charset=utf-8", exportSnapshotJson(snapshot))}><IconDownload />Download JSON</Button>
      <Button variant="outline" size="sm" onClick={() => saveFile(`aegis-${snapshot.event.id}-brief.csv`, "text/csv;charset=utf-8", exportSnapshotCsv(snapshot))}><IconDownload />Download CSV</Button>
    </div>
  </details>;
}

function PrintBrief({ snapshot }: { snapshot: Snapshot }) {
  return <article className="print-brief">
    <h1>{snapshot.event.name} · Incident brief</h1>
    <p>Generated {formattedTime(new Date().toISOString(), snapshot.event.timezone)} · Synthetic exercise</p>
    <p>Groups and source reports are provisional coordinator records. Similarity scores are ranking signals and do not establish that an account is true.</p>
    {snapshot.incidents.map((incident) => {
      const reports = incidentReports(incident, snapshot.reports);
      return <section key={incident.id}>
        <h2>{shortDisplayId(incident.display_id, incident.id, "INC")} · {incident.title}</h2>
        <p>{priorityLabel(incident.priority)} · {displayStatus(incident.status)} · {zoneLabel(incident.zone_id, snapshot.zones)}</p>
        {incident.review_reasons.map((reason, index) => <p key={`review-${index}`}>Review: {reason}</p>)}
        {reports.map((report) => <blockquote key={report.id}><strong>{shortDisplayId(report.display_id, report.id, "RPT")} · Occurred {report.reported_at ? formattedTime(report.reported_at, snapshot.event.timezone) : "not reported"} · Received {formattedTime(report.received_at, snapshot.event.timezone)}</strong><br />{report.text}</blockquote>)}
        {(incident.notes ?? []).map((note) => <p key={note.id}>Coordinator note: {note.text}</p>)}
        {incident.conflicts.filter((conflict) => conflict.status === "unresolved").map((conflict) => <p key={conflict.id}>Unresolved question ({conflict.field}): {conflict.reason || conflict.spans.join(" / ")}</p>)}
      </section>;
    })}
  </article>;
}

interface GroupingReviewFormProps {
  mode: ReviewMode;
  incident: Incident;
  incidents: Incident[];
  selectedReportIds: string[];
  selectedIncidentIds: string[];
  onCancel: () => void;
  onSaved: (snapshot: Snapshot, message: string, moveNext?: boolean) => void;
}

export function GroupingReviewForm({
  mode,
  incident,
  incidents,
  selectedReportIds,
  selectedIncidentIds,
  onCancel,
  onSaved,
}: GroupingReviewFormProps) {
  const [targetIncidentId, setTargetIncidentId] = useState(mode === "merge" ? selectedIncidentIds[0] ?? incident.id : "");
  const [versionsAtOpen, setVersionsAtOpen] = useState(() => Object.fromEntries(incidents.map((item) => [item.id, item.version])));
  const [incidentsAtOpen] = useState(incidents);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [versionConflict, setVersionConflict] = useState(false);
  const mergeIncidentIds = selectedIncidentIds.length > 1 ? selectedIncidentIds : [];
  const otherIncidents = incidents.filter((item) => item.id !== incident.id && item.status !== "resolved");
  const affectedIds = getAffectedIncidentIds(mode, incident.id, targetIncidentId, mergeIncidentIds);
  const currentVersions = Object.fromEntries(incidents.map((item) => [item.id, item.version]));
  const hasNewVersion = affectedIds.some((id) => currentVersions[id] !== versionsAtOpen[id]);
  const previewReportIds = reportIdsForPreview(mode, selectedReportIds, incident);
  const changedDetails = affectedIds.flatMap((id) => {
    const before = incidentsAtOpen.find((item) => item.id === id);
    const after = incidents.find((item) => item.id === id);
    return before && after ? changedIncidentDetails(before, after) : before ? [`${before.title} is no longer available in the current event snapshot.`] : [];
  });
  const titles: Record<ReviewMode, string> = {
    confirm: "Confirm the selected report membership.",
    reject: "Keep the selected report separate from this group.",
    move: "Move selected reports to another group.",
    merge: "Merge selected groups into one group.",
    split: "Create a separate group from the selected reports.",
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setVersionConflict(false);
    if (reason.trim().length < 3) {
      setFormError("Enter a coordinator reason of at least 3 characters.");
      return;
    }
    if (mode === "merge" && mergeIncidentIds.length < 2) {
      setFormError("Select at least two groups in the incident queue.");
      return;
    }
    if (mode === "move" && !targetIncidentId) {
      setFormError("Choose a destination group.");
      return;
    }
    const reportIds = mode === "confirm" && selectedReportIds.length === 0
      ? incident.report_ids
      : selectedReportIds;
    if (mode !== "merge" && reportIds.length === 0) {
      setFormError("Select at least one source report first.");
      return;
    }
    setPending(true);
    try {
      const input = createGroupingReviewInput(
        mode,
        incident,
        incidents,
        reportIds,
        targetIncidentId,
        mergeIncidentIds,
        reason,
      );
      input.expected_versions = Object.fromEntries(
        Object.entries(input.expected_versions).map(([id, version]) => [id, versionsAtOpen[id] ?? version]),
      );
      const next = await reviewGrouping(input);
      const submitter = (event.nativeEvent as SubmitEvent).submitter;
      const moveNext = submitter instanceof HTMLElement && submitter.dataset["nextReview"] === "true";
      onSaved(next, `${displayStatus(mode)} decision saved to the audit trail.`, moveNext);
    } catch (caught) {
      setFormError(errorText(caught));
      setVersionConflict(isVersionConflict(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="action-form" onSubmit={(event) => void handleSubmit(event)}>
      <strong className="action-note">{titles[mode]}</strong>
      {(mode === "move" || mode === "merge") && (
        <label>
          {mode === "move" ? "Destination group" : "Keep group identity"}
          <NativeSelect className="w-full" value={targetIncidentId} onChange={(event) => setTargetIncidentId(event.target.value)}>
            {mode === "move" && <option value="" disabled>Choose a destination group</option>}
            {(mode === "merge" ? incidents.filter((item) => mergeIncidentIds.includes(item.id)) : otherIncidents).map((item) => (
              <option key={item.id} value={item.id}>{item.title}</option>
            ))}
          </NativeSelect>
        </label>
      )}
      <label>
        Coordinator reason
        <Textarea
          className="min-h-24"
          value={reason}
          minLength={3}
          maxLength={1000}
          required
          placeholder="Describe what you reviewed."
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <div className="grouping-preview" aria-label="Grouping change preview">
        <strong>Change preview</strong>
        <span>{mode === "merge" ? `${mergeIncidentIds.length} groups will become one.` : `${previewReportIds.length} report${previewReportIds.length === 1 ? "" : "s"} will ${mode === "split" ? "form a separate group" : mode === "move" ? "move to the selected group" : mode === "reject" ? "stay separate" : "remain in this group"}.`}</span>
        {mode === "move" && targetIncidentId && <span>Destination: {incidents.find((item) => item.id === targetIncidentId)?.title ?? "Selected group"}</span>}
        {mode === "merge" && targetIncidentId && <span>Group identity: {incidents.find((item) => item.id === targetIncidentId)?.title ?? "Selected group"}</span>}
        {selectedReportIds.length > 0 && <span>Selected reports: {selectedReportIds.map((id) => shortDisplayId(undefined, id, "RPT")).join(", ")}</span>}
      </div>
      {formError && <span className="form-error" role="alert">{formError}</span>}
      <VersionConflictNotice
        visible={versionConflict}
        canUseLatest={hasNewVersion}
        changedDetails={changedDetails}
        onUseLatest={() => {
          setVersionsAtOpen(currentVersions);
          setVersionConflict(false);
          setFormError(null);
        }}
      />
      <div className="form-actions">
        <Button size="xs" variant="ghost" type="button" onClick={onCancel}>Cancel</Button>
        <Button size="xs" type="submit" disabled={pending}>{pending ? "Saving…" : "Save coordinator decision"}</Button>
        <Button size="xs" type="submit" data-next-review="true" disabled={pending}>{pending ? "Saving…" : "Save & next review"}</Button>
      </div>
    </form>
  );
}

function reportIdsForPreview(mode: ReviewMode, selectedReportIds: string[], incident: Incident): string[] {
  return mode === "confirm" && selectedReportIds.length === 0 ? incident.report_ids : selectedReportIds;
}

interface PriorityFormProps {
  incident: Incident;
  onCancel: () => void;
  onSaved: (snapshot: Snapshot) => void;
  onNotice: (notice: Notice) => void;
  onNextReview: (snapshot: Snapshot) => void;
}

function PriorityForm({ incident, onCancel, onSaved, onNotice, onNextReview }: PriorityFormProps) {
  const [priority, setPriority] = useState<Priority>(incident.priority);
  const [expectedVersion, setExpectedVersion] = useState(incident.version);
  const [incidentAtOpen] = useState(incident);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [versionConflict, setVersionConflict] = useState(false);
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (reason.trim().length < 3) {
      setError("Enter a reason of at least 3 characters.");
      return;
    }
    setPending(true);
    setError(null);
    setVersionConflict(false);
    try {
      const next = await updatePriority(incident.id, { priority, reason: reason.trim(), expected_version: expectedVersion });
      onSaved(next);
      onNotice({ kind: "success", message: "Priority override saved with its reason." });
      const submitter = (event.nativeEvent as SubmitEvent).submitter;
      if (submitter instanceof HTMLElement && submitter.dataset["nextReview"] === "true") onNextReview(next);
      onCancel();
    } catch (caught) {
      setError(errorText(caught));
      setVersionConflict(isVersionConflict(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="action-form" onSubmit={(event) => void handleSubmit(event)}>
      <label>Coordinator priority override
        <NativeSelect className="w-full" value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>
          <option value="P0">P0 · immediate review</option><option value="P1">P1 · urgent review</option><option value="P2">P2 · standard review</option><option value="UNASSESSED">Unassessed · needs review</option>
        </NativeSelect>
      </label>
      <label>Reason<Textarea className="min-h-24" value={reason} minLength={3} maxLength={1000} required placeholder="What did you verify?" onChange={(event) => setReason(event.target.value)} /></label>
      {error && <span className="form-error" role="alert">{error}</span>}
      <VersionConflictNotice
        visible={versionConflict}
        canUseLatest={incident.version !== expectedVersion}
        changedDetails={changedIncidentDetails(incidentAtOpen, incident)}
        onUseLatest={() => {
          setExpectedVersion(incident.version);
          setVersionConflict(false);
          setError(null);
        }}
      />
      <div className="form-actions"><Button size="xs" type="button" variant="ghost" onClick={onCancel}>Cancel</Button><Button size="xs" type="submit" disabled={pending}>{pending ? "Saving…" : "Save priority"}</Button><Button size="xs" type="submit" data-next-review="true" disabled={pending}>{pending ? "Saving…" : "Save & next review"}</Button></div>
    </form>
  );
}

interface StatusFormProps {
  incident: Incident;
  onCancel: () => void;
  onSaved: (snapshot: Snapshot) => void;
  onNotice: (notice: Notice) => void;
  onNextReview: (snapshot: Snapshot) => void;
}

function StatusForm({ incident, onCancel, onSaved, onNotice, onNextReview }: StatusFormProps) {
  const [status, setStatus] = useState<IncidentStatus>(incident.status);
  const [expectedVersion, setExpectedVersion] = useState(incident.version);
  const [incidentAtOpen] = useState(incident);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [versionConflict, setVersionConflict] = useState(false);
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (reason.trim().length < 3) {
      setError("Enter a reason of at least 3 characters.");
      return;
    }
    setPending(true);
    setError(null);
    setVersionConflict(false);
    try {
      const next = await updateStatus(incident.id, { status, reason: reason.trim(), expected_version: expectedVersion });
      onSaved(next);
      onNotice({ kind: "success", message: `Status changed to ${displayStatus(status)}.` });
      const submitter = (event.nativeEvent as SubmitEvent).submitter;
      if (submitter instanceof HTMLElement && submitter.dataset["nextReview"] === "true") onNextReview(next);
      onCancel();
    } catch (caught) {
      setError(errorText(caught));
      setVersionConflict(isVersionConflict(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="action-form" onSubmit={(event) => void handleSubmit(event)}>
      <label>Workflow status
        <NativeSelect className="w-full" value={status} onChange={(event) => setStatus(event.target.value as IncidentStatus)}>
          <option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="monitoring">Monitoring</option><option value="resolved">Resolved</option>
        </NativeSelect>
      </label>
      <label>Reason<Textarea className="min-h-24" value={reason} minLength={3} maxLength={1000} required placeholder="Record what changed." onChange={(event) => setReason(event.target.value)} /></label>
      {error && <span className="form-error" role="alert">{error}</span>}
      <VersionConflictNotice
        visible={versionConflict}
        canUseLatest={incident.version !== expectedVersion}
        changedDetails={changedIncidentDetails(incidentAtOpen, incident)}
        onUseLatest={() => {
          setExpectedVersion(incident.version);
          setVersionConflict(false);
          setError(null);
        }}
      />
      <div className="form-actions"><Button size="xs" type="button" variant="ghost" onClick={onCancel}>Cancel</Button><Button size="xs" type="submit" disabled={pending}>{pending ? "Saving…" : "Save status"}</Button><Button size="xs" type="submit" data-next-review="true" disabled={pending}>{pending ? "Saving…" : "Save & next review"}</Button></div>
    </form>
  );
}

interface ConflictCardProps {
  conflict: Conflict;
  incident: Incident;
  onLocateSource: (reportId: string) => void;
  onApplySnapshot: (snapshot: Snapshot) => void;
  onNotice: (notice: Notice) => void;
}

function ConflictCard({ conflict, incident, onLocateSource, onApplySnapshot, onNotice }: ConflictCardProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [openedConflictStatus, setOpenedConflictStatus] = useState(conflict.status);
  const [expectedVersion, setExpectedVersion] = useState(incident.version);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [versionConflict, setVersionConflict] = useState(false);
  const nextStatus = openedConflictStatus === "unresolved" ? "resolved" : "unresolved";
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (reason.trim().length < 3) {
      setError("Enter a coordinator reason of at least 3 characters.");
      return;
    }
    setPending(true);
    setError(null);
    setVersionConflict(false);
    try {
      const next = await reviewConflict(conflict.id, { status: nextStatus, reason: reason.trim(), expected_version: expectedVersion });
      onApplySnapshot(next);
      setExpectedVersion(next.incidents.find((item) => item.id === incident.id)!.version);
      setReason("");
      setError(null);
      setVersionConflict(false);
      onNotice({ kind: "success", message: nextStatus === "resolved" ? "Conflict resolution recorded." : "Conflict returned to review." });
      setOpen(false);
    } catch (caught) {
      setError(errorText(caught));
      setVersionConflict(isVersionConflict(caught));
    } finally {
      setPending(false);
    }
  };

  return (
    <article className="conflict-card">
      <div className="conflict-title"><span><IconAlertTriangle size={13} />{conflict.field.replaceAll("_", " ")}</span><span>{displayStatus(conflict.status)}</span></div>
      <div className="conflict-quotes">
        {conflict.spans.map((span, index) => {
          const reportId = conflict.report_ids[index];
          const quote = `“${span}” · ${conflict.values[index] ?? "unknown"}`;
          return reportId
            ? <button type="button" className="conflict-quote source-phrase-link" key={`${conflict.id}-${index}`} onClick={() => onLocateSource(reportId)} aria-label={`Show source report ${reportId} for ${conflict.field.replaceAll("_", " ")}`}>{quote}</button>
            : <p className="conflict-quote" key={`${conflict.id}-${index}`}>{quote}</p>;
        })}
      </div>
      {conflict.reason && <p className="action-note">{conflict.reason}</p>}
      {open ? (
        <form className="action-form" onSubmit={(event) => void handleSubmit(event)}>
          <label>Reason for {nextStatus === "resolved" ? "resolution" : "reopening"}<Textarea className="min-h-24" value={reason} minLength={3} maxLength={1000} required placeholder="Record what was checked." onChange={(event) => setReason(event.target.value)} /></label>
          {error && <span className="form-error" role="alert">{error}</span>}
          <VersionConflictNotice
            visible={versionConflict}
            canUseLatest={incident.version !== expectedVersion}
            onUseLatest={() => {
              setExpectedVersion(incident.version);
              setVersionConflict(false);
              setError(null);
            }}
          />
          <div className="form-actions"><Button size="xs" type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button size="xs" type="submit" disabled={pending}>{pending ? "Saving…" : "Save conflict review"}</Button></div>
        </form>
      ) : (
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setOpenedConflictStatus(conflict.status);
            setExpectedVersion(incident.version);
            setReason("");
            setError(null);
            setVersionConflict(false);
            setOpen(true);
          }}
        >
          {conflict.status === "unresolved" ? "Resolve conflict" : "Reopen conflict review"}
        </Button>
      )}
    </article>
  );
}

interface AuditTimelineProps {
  snapshot: Snapshot;
}

function AuditTimeline({ snapshot }: AuditTimelineProps) {
  const [expanded, setExpanded] = useState(false);
  const audit = latestAuditFirst(snapshot.audit);
  const visible = expanded ? audit : audit.slice(0, 3);
  return (
    <section className="audit-section" aria-labelledby="audit-heading">
      <div className="panel-header">
        <h2 className="panel-title" id="audit-heading"><IconHistory />Coordinator audit</h2>
        <button className="audit-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show recent" : `View all ${audit.length}`}<IconChevronRight size={13} />
        </button>
      </div>
      {visible.length === 0 ? <p className="audit-empty">Coordinator decisions will appear here with their reasons.</p> : (
        <div className="audit-list">
          {visible.map((entry) => {
            const incident = auditIncident(snapshot, entry.entity_id);
            return (
              <article className="audit-entry" key={entry.id}>
                <div className="audit-entry-head"><span className="audit-action">{displayStatus(entry.action)}</span><span className="audit-time">{formattedTime(entry.created_at, snapshot.event.timezone)}</span></div>
                <span className="audit-actor">{entry.actor} · {entry.entity_id}</span>
                {incident && <a className="audit-incident-link" href={dashboardIncidentHref(window.location.href, snapshot.event.id, incident.id)}>Open {shortDisplayId(incident.display_id, incident.id, "INC")}</a>}
                {entry.reason && <span className="audit-reason">{entry.reason}</span>}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function auditIncident(snapshot: Snapshot, entityId: string): Incident | undefined {
  const direct = snapshot.incidents.find((incident) => incident.id === entityId);
  if (direct) return direct;
  const report = snapshot.reports.find((candidate) => candidate.id === entityId);
  if (report) return snapshot.incidents.find((incident) => incident.report_ids.includes(report.id));
  return snapshot.incidents.find((incident) => incident.conflicts.some((conflict) => conflict.id === entityId));
}
