import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowsExchange,
  IconChevronRight,
  IconCircleCheck,
  IconClock,
  IconGitMerge,
  IconHistory,
  IconListCheck,
  IconMap,
  IconMapPin,
  IconMessageCircle,
  IconPlayerPlay,
  IconPlayerTrackNext,
  IconRefresh,
  IconUsers,
  IconX,
} from "@tabler/icons-react";
import { Button } from "../components/ui/button";
import { NativeSelect } from "../components/ui/native-select";
import { Textarea } from "../components/ui/textarea";
import { useSnapshot } from "../hooks/use-snapshot";
import {
  ApiError,
  advanceReplay,
  reviewConflict,
  reviewGrouping,
  startReplay,
  updatePriority,
  updateStatus,
} from "../lib/api";
import {
  displayStatus,
  evidenceScore,
  formatAge,
  formattedTime,
  incidentReports,
  latestAuditFirst,
  priorityLabel,
  zoneLabel,
} from "../lib/format";
import type {
  Conflict,
  GroupingAction,
  GroupingReviewInput,
  Incident,
  IncidentStatus,
  Priority,
  Replay,
  Snapshot,
  Zone,
} from "../lib/types";

type QueueFilter = "active" | "review" | "conflicts" | "all";
type ReviewMode = Extract<GroupingAction, "confirm" | "reject" | "move" | "merge" | "split">;
type ReplayScenario = "demo" | "busy" | "edge";

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

function sortedIncidents(incidents: Incident[]): Incident[] {
  return [...incidents].sort((left, right) => {
    const priorityDiff = priorityOrder[left.priority] - priorityOrder[right.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(left.created_at).valueOf() - new Date(right.created_at).valueOf();
  });
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
}: {
  visible: boolean;
  canUseLatest: boolean;
  onUseLatest: () => void;
}) {
  if (!visible) return null;
  return (
    <div className="version-conflict" role="status">
      <span>{canUseLatest ? "A newer snapshot is available." : "Waiting for the next live snapshot."} Your reason remains in this form.</span>
      <Button size="xs" variant="outline" type="button" disabled={!canUseLatest} onClick={onUseLatest}>
        Use latest version and keep reason
      </Button>
    </div>
  );
}

export function DashboardPage() {
  const { snapshot, loading, error, refresh, applySnapshot } = useSnapshot();
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [selectedIncidentIds, setSelectedIncidentIds] = useState<string[]>([]);
  const [selectedReportIds, setSelectedReportIds] = useState<string[]>([]);
  const [filter, setFilter] = useState<QueueFilter>("active");
  const [reviewMode, setReviewMode] = useState<ReviewMode | null>(null);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [scenario, setScenario] = useState<ReplayScenario>("demo");
  const [replayPending, setReplayPending] = useState(false);
  const { notice, setNotice } = useNotice();

  useEffect(() => {
    if (snapshot && !snapshot.incidents.some((incident) => incident.id === selectedIncidentId)) {
      setSelectedIncidentId(snapshot.incidents[0]?.id ?? null);
      setSelectedReportIds([]);
    }
  }, [snapshot, selectedIncidentId]);

  const selectedIncident = snapshot?.incidents.find((incident) => incident.id === selectedIncidentId) ?? null;
  const visibleIncidents = useMemo(() => {
    if (!snapshot) return [];
    const filtered = snapshot.incidents.filter((incident) => {
      if (filter === "all") return true;
      if (filter === "active") return incident.status !== "resolved";
      if (filter === "review") return incident.review_required || incident.priority === "UNASSESSED";
      return incident.conflicts.some((conflict) => conflict.status === "unresolved");
    });
    return sortedIncidents(filtered);
  }, [snapshot, filter]);

  const onGroupingSaved = (next: Snapshot, message: string) => {
    applySnapshot(next);
    setReviewMode(null);
    setSelectedReportIds([]);
    setSelectedIncidentIds([]);
    setNotice({ kind: "success", message });
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
    setReplayPending(true);
    try {
      const next = await startReplay(scenario);
      applySnapshot(next);
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
      applySnapshot(next);
      setNotice({ kind: "success", message: advanced ? "Next synthetic report added." : "Replay is complete." });
    } catch (caught) {
      setNotice({ kind: "error", message: errorText(caught) });
    } finally {
      setReplayPending(false);
    }
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
  const unresolvedConflictCount = snapshot.incidents.reduce(
    (count, incident) => count + incident.conflicts.filter((conflict) => conflict.status === "unresolved").length,
    0,
  );
  const activeUnlocated = snapshot.reports.filter((report) => report.zone_id === null).length;
  const checkedReports = selectedIncident
    ? selectedReportIds.filter((reportId) => selectedIncident.report_ids.includes(reportId))
    : [];

  return (
    <>
      <div className="page-heading">
        <div className="page-heading-copy">
          <span className="eyebrow">Coordinator workspace</span>
          <h1>Situation overview</h1>
          <p className="page-subtitle">Provisional groups from the current exercise, ready for human review.</p>
        </div>
        <div className="heading-actions">
          <Button render={<Link to="/report" />} nativeButton={false}><IconMessageCircle />Report a situation</Button>
        </div>
      </div>

      {error && <div className="status-banner"><IconAlertTriangle /><span>Snapshot refresh failed: {error}. Showing the last successful snapshot.</span></div>}

      <SummaryStrip snapshot={snapshot} conflicts={unresolvedConflictCount} />

      <div className="dashboard-toolbar">
        <div className="toolbar-left">
          <span className="toolbar-caption"><IconActivity />Live snapshot · refreshes every second</span>
          <span className="mini-pill">{snapshot.event.policy_version}</span>
        </div>
        <div className="toolbar-right">
          <label className="visually-hidden" htmlFor="replay-scenario">Replay scenario</label>
          <NativeSelect
            id="replay-scenario"
            className="toolbar-select"
            value={scenario}
            onChange={(event) => setScenario(event.target.value as ReplayScenario)}
          >
            <option value="demo">Demo replay</option>
            <option value="busy">Busy replay</option>
            <option value="edge">Edge cases replay</option>
          </NativeSelect>
          <Button variant="outline" size="sm" disabled={replayPending} onClick={() => void handleReplayStart()}>
            <IconPlayerPlay />{replayPending ? "Starting…" : "Start replay"}
          </Button>
          {activeReplay && (
            <Button variant="secondary" size="sm" disabled={replayPending} onClick={() => void handleReplayNext(activeReplay)}>
              <IconPlayerTrackNext />{replayPending ? "Advancing…" : "Next report"}
            </Button>
          )}
        </div>
      </div>

      <div className="workspace-grid">
        <IncidentQueue
          incidents={visibleIncidents}
          reports={snapshot.reports}
          zones={snapshot.zones}
          selectedIncidentId={selectedIncidentId}
          selectedIncidentIds={selectedIncidentIds}
          filter={filter}
          onFilterChange={setFilter}
          onSelect={(incidentId) => {
            setSelectedIncidentId(incidentId);
            setSelectedReportIds([]);
            setReviewMode(null);
            setPriorityOpen(false);
            setStatusOpen(false);
          }}
          onToggleIncident={toggleIncidentSelection}
          onMerge={() => {
            const first = snapshot.incidents.find((incident) => selectedIncidentIds.includes(incident.id));
            if (first) {
              setSelectedIncidentId(first.id);
              setReviewMode("merge");
              setPriorityOpen(false);
              setStatusOpen(false);
            }
          }}
        />

        <SchematicMap
          incidents={visibleIncidents.filter((incident) => incident.status !== "resolved")}
          zones={snapshot.zones}
          selectedIncidentId={selectedIncidentId}
          unlocatedCount={activeUnlocated}
          onSelect={(incidentId) => {
            setSelectedIncidentId(incidentId);
            setSelectedReportIds([]);
          }}
        />

        <IncidentInspector
          incident={selectedIncident}
          incidents={snapshot.incidents}
          reports={snapshot.reports}
          zones={snapshot.zones}
          selectedReportIds={checkedReports}
          selectedIncidentIds={selectedIncidentIds}
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
        />
      </div>

      <AuditTimeline snapshot={snapshot} />

      {activeReplay && (
        <p className="action-note replay-note" role="status">
          Replay step {activeReplay.cursor} of {activeReplay.total} · {activeReplay.scenario} scenario. Every step uses normal report ingestion.
        </p>
      )}
      {notice && <div className={`toast-message is-${notice.kind}`} role="status">{notice.message}</div>}
    </>
  );
}

interface SummaryStripProps {
  snapshot: Snapshot;
  conflicts: number;
}

function SummaryStrip({ snapshot, conflicts }: SummaryStripProps) {
  return (
    <div className="summary-grid" aria-label="Exercise counts">
      <SummaryCard value={snapshot.counts.reports} label="Reports received" icon={<IconMessageCircle />} />
      <SummaryCard value={snapshot.counts.incidents} label="Provisional groups" icon={<IconUsers />} />
      <SummaryCard value={snapshot.counts.review} label="Awaiting review" icon={<IconAlertTriangle />} tone="warning" />
      <SummaryCard value={conflicts} label="Unresolved conflicts" icon={<IconActivity />} tone="alert" />
    </div>
  );
}

function SummaryCard({
  value,
  label,
  icon,
  tone,
}: {
  value: number;
  label: string;
  icon: ReactNode;
  tone?: "warning" | "alert";
}) {
  return (
    <div className={`summary-card${tone ? ` is-${tone}` : ""}`}>
      <div className="summary-copy"><strong className="summary-value">{value}</strong><span className="summary-label">{label}</span></div>
      <span className="summary-icon" aria-hidden="true">{icon}</span>
    </div>
  );
}

interface IncidentQueueProps {
  incidents: Incident[];
  reports: Snapshot["reports"];
  zones: Zone[];
  selectedIncidentId: string | null;
  selectedIncidentIds: string[];
  filter: QueueFilter;
  onFilterChange: (filter: QueueFilter) => void;
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
  filter,
  onFilterChange,
  onSelect,
  onToggleIncident,
  onMerge,
}: IncidentQueueProps) {
  const filters: { id: QueueFilter; label: string }[] = [
    { id: "active", label: "Active" },
    { id: "review", label: "Review" },
    { id: "conflicts", label: "Conflicts" },
    { id: "all", label: "All" },
  ];

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
              className={`filter-button${filter === item.id ? " is-selected" : ""}`}
              aria-pressed={filter === item.id}
              onClick={() => onFilterChange(item.id)}
            >{item.label}</button>
          ))}
        </div>
        <span className="panel-meta">Priority first</span>
      </div>
      {incidents.length === 0 ? (
        <div className="queue-empty">No incidents match this filter.</div>
      ) : (
        <div className="queue-list">
          {incidents.map((incident) => {
            const reportList = incidentReports(incident, reports);
            const reasonCount = incident.review_reasons.length;
            const unresolved = incident.conflicts.some((conflict) => conflict.status === "unresolved");
            return (
              <article
                key={incident.id}
                className={`incident-row${selectedIncidentId === incident.id ? " is-selected" : ""}`}
                aria-current={selectedIncidentId === incident.id ? "true" : undefined}
              >
                <span className={`priority-rail priority-rail-${incident.priority}`} />
                <button type="button" className="incident-row-main" onClick={() => onSelect(incident.id)}>
                  <span className="incident-row-body">
                    <span className="incident-row-title">{incident.title}</span>
                    <span className="incident-row-meta">
                      <span>{zoneLabel(incident.zone_id, zones)}</span>
                      <span>·</span>
                      <span>{reportList.length} report{reportList.length === 1 ? "" : "s"}</span>
                      {reasonCount > 0 && <span className="mini-pill is-review">Review</span>}
                      {unresolved && <span className="mini-pill is-conflict">Conflict</span>}
                    </span>
                  </span>
                  <span className="incident-row-time">{formatAge(incident.created_at)}</span>
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
}

function SchematicMap({ incidents, zones, selectedIncidentId, unlocatedCount, onSelect }: SchematicMapProps) {
  const located = incidents.flatMap((incident) => {
    const zone = zones.find((candidate) => candidate.id === incident.zone_id);
    return zone ? [{ incident, zone }] : [];
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
          <div className="map-caption-copy"><strong>Reported locations</strong><span>Markers represent groups with known zones.</span></div>
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
            {zones.map((zone) => (
              <g key={zone.id}>
                <rect className="map-zone" x={zone.x - 75} y={zone.y - 34} width="150" height="68" rx="10" />
                <text className="map-zone-label" x={zone.x} y={zone.y}>{zone.label}</text>
              </g>
            ))}
            {located.map(({ incident, zone }) => {
              const sameZoneIndex = located
                .filter((item) => item.incident.zone_id === incident.zone_id)
                .findIndex((item) => item.incident.id === incident.id);
              const shiftX = ((sameZoneIndex % 3) - 1) * 22;
              const shiftY = Math.floor(sameZoneIndex / 3) * 25;
              const x = zone.x + shiftX;
              const y = zone.y + shiftY;
              const groupReports = incident.report_ids.length;
              const markerLabel = `${incident.title}, ${priorityLabel(incident.priority)}, ${groupReports} reports`;
              return (
                <g
                  key={incident.id}
                  className={`map-marker map-marker-${incident.priority.toLowerCase()}${selectedIncidentId === incident.id ? " map-marker-selected" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-label={markerLabel}
                  aria-pressed={selectedIncidentId === incident.id}
                  onClick={() => onSelect(incident.id)}
                  onKeyDown={(event: KeyboardEvent<SVGGElement>) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(incident.id);
                    }
                  }}
                >
                  <circle className="map-marker-ring" cx={x} cy={y} r="15" />
                  <circle className="map-marker-core" cx={x} cy={y} r="9" />
                  <text className="map-marker-count" x={x} y={y}>{groupReports}</text>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="unlocated-tray"><span><IconMapPin size={13} /> <strong>Unlocated reports</strong> stay in the queue</span><span>{unlocatedCount}</span></div>
      </div>
      <p className="map-note">Illustrative event zones only. This schematic is not a live safety map and does not imply verified conditions.</p>
    </section>
  );
}

interface IncidentInspectorProps {
  incident: Incident | null;
  incidents: Incident[];
  reports: Snapshot["reports"];
  zones: Zone[];
  selectedReportIds: string[];
  selectedIncidentIds: string[];
  reviewMode: ReviewMode | null;
  priorityOpen: boolean;
  statusOpen: boolean;
  onToggleReport: (reportId: string) => void;
  onReviewMode: (mode: ReviewMode | null) => void;
  onPriorityOpen: (open: boolean) => void;
  onStatusOpen: (open: boolean) => void;
  onApplySnapshot: (snapshot: Snapshot) => void;
  onGroupingSaved: (snapshot: Snapshot, message: string) => void;
  onNotice: (notice: Notice) => void;
}

function IncidentInspector({
  incident,
  incidents,
  reports,
  zones,
  selectedReportIds,
  selectedIncidentIds,
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
}: IncidentInspectorProps) {
  if (!incident) {
    return (
      <section className="workspace-panel inspector-panel" aria-label="Incident inspector">
        <div className="panel-header"><h2 className="panel-title">Incident inspector</h2></div>
        <div className="inspector-empty"><IconMapPin /><strong>Select a provisional group</strong><span>Review its source reports, evidence, priority rule, and coordinator actions.</span></div>
      </section>
    );
  }

  const sourceReports = incidentReports(incident, reports);

  return (
    <section className="workspace-panel inspector-panel" aria-labelledby="inspector-heading">
      <div className="panel-header">
        <h2 className="panel-title" id="inspector-heading">Incident inspector</h2>
        <span className="panel-meta mono">v{incident.version}</span>
      </div>
      <div className="inspector-content">
        <div className="inspector-title-row">
          <div className="inspector-title-copy">
            <h3 className="inspector-title">{incident.title}</h3>
            <div className="inspector-meta">
              <span className={`priority-badge priority-${incident.priority}`}><span className={`priority-rail priority-rail-${incident.priority}`} />{priorityLabel(incident.priority)}</span>
              <span className="mini-pill">{displayStatus(incident.status)}</span>
              <span className="mini-pill">{zoneLabel(incident.zone_id, zones)}</span>
            </div>
          </div>
          <span className="panel-meta">{sourceReports.length} reports</span>
        </div>

        {incident.review_required && incident.review_reasons.length > 0 && (
          <div className="inspector-rule">
            <span className="inspector-rule-label">Review required</span>
            {incident.review_reasons.map((reason, index) => <p key={`${incident.id}-review-${index}`}>{reason}</p>)}
          </div>
        )}

        <div className="inspector-rule">
          <span className="inspector-rule-label">Priority policy · suggested {priorityLabel(incident.suggested_priority)}</span>
          <p>{incident.priority_reason}</p>
          {incident.override_reason && <p>Coordinator override: {incident.override_reason}</p>}
        </div>

        <div className="inspector-section">
          <div className="inspector-section-heading"><h3>Source reports</h3><span className="panel-meta">Original text is preserved</span></div>
          <div className="report-stack">
            {sourceReports.map((report) => (
              <article key={report.id} className="source-report">
                <div className="source-report-head">
                  <span className="source-report-id">{report.id}</span>
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
                <p>{report.text}</p>
                <div className="source-report-meta">
                  <span><IconClock size={12} />{formattedTime(report.reported_at ?? report.received_at)}</span>
                  <span>{zoneLabel(report.zone_id, zones)}</span>
                  {report.analysis_status !== "complete" && <span className="mini-pill is-review">Analysis {report.analysis_status}</span>}
                </div>
              </article>
            ))}
          </div>
        </div>

        <div className="inspector-section">
          <div className="inspector-section-heading"><h3>Grouping evidence</h3><span className="panel-meta">Ranking signals · not probabilities</span></div>
          {incident.evidence.length === 0 ? (
            <p className="action-note">No pairwise evidence is available for this group.</p>
          ) : (
            <div className="evidence-list">
              {incident.evidence.map((evidence, index) => (
                <article className="evidence-card" key={`${evidence.report_id}-${evidence.candidate_report_id}-${index}`}>
                  <div className="evidence-topline"><span>{evidence.report_id} ↔ {evidence.candidate_report_id}</span><span className="evidence-decision">{evidence.decision}</span></div>
                  <div className="score-grid">
                    <ScoreCell label="Semantic" value={evidence.semantic_score} />
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
        </div>

        <div className="inspector-section">
          <div className="inspector-section-heading"><h3>Extracted claims</h3><span className="panel-meta">Evidence phrases</span></div>
          {sourceReports.some((report) => report.claims.length > 0) ? (
            <div className="claim-list">
              {sourceReports.flatMap((report) => report.claims.map((claim, index) => (
                <div className="claim-row" key={`${report.id}-${claim.field}-${index}`}>
                  <span className="claim-field">{claim.field.replaceAll("_", " ")}</span>
                  <span className="claim-span">“{claim.span}” · {claim.value}</span>
                </div>
              )))}
            </div>
          ) : <p className="action-note">No supported claim fields were extracted from these reports.</p>}
        </div>

        {incident.conflicts.length > 0 && (
          <div className="inspector-section">
            <div className="inspector-section-heading"><h3>Conflicting or changing reports</h3><span className="panel-meta">Coordinator review</span></div>
            {incident.conflicts.map((conflict) => (
              <ConflictCard
                key={conflict.id}
                conflict={conflict}
                incident={incident}
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
            <Button size="sm" variant="outline" onClick={() => onReviewMode(reviewMode === "reject" ? null : "reject")}><IconX />Reject pairing</Button>
          </div>
          <div className="action-row">
            <Button size="sm" variant="secondary" onClick={() => onReviewMode(reviewMode === "move" ? null : "move")}><IconArrowsExchange />Move selected</Button>
            <Button size="sm" variant="secondary" onClick={() => onReviewMode(reviewMode === "split" ? null : "split")}><IconGitMerge />Split selected reports</Button>
          </div>
          <div className="action-row">
            <Button size="sm" variant="ghost" onClick={() => onPriorityOpen(!priorityOpen)}>Override priority</Button>
            <Button size="sm" variant="ghost" onClick={() => onStatusOpen(!statusOpen)}>Change status</Button>
          </div>

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
          {priorityOpen && <PriorityForm key={incident.id} incident={incident} onCancel={() => onPriorityOpen(false)} onSaved={onApplySnapshot} onNotice={onNotice} />}
          {statusOpen && <StatusForm key={incident.id} incident={incident} onCancel={() => onStatusOpen(false)} onSaved={onApplySnapshot} onNotice={onNotice} />}
        </div>
      </div>
    </section>
  );
}

function ScoreCell({ label, value }: { label: string; value: number | null }) {
  return <div className="score-cell"><span>{label}</span><strong>{evidenceScore(value)}</strong></div>;
}

interface GroupingReviewFormProps {
  mode: ReviewMode;
  incident: Incident;
  incidents: Incident[];
  selectedReportIds: string[];
  selectedIncidentIds: string[];
  onCancel: () => void;
  onSaved: (snapshot: Snapshot, message: string) => void;
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
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [versionConflict, setVersionConflict] = useState(false);
  const mergeIncidentIds = selectedIncidentIds.length > 1 ? selectedIncidentIds : [];
  const otherIncidents = incidents.filter((item) => item.id !== incident.id && item.status !== "resolved");
  const affectedIds = getAffectedIncidentIds(mode, incident.id, targetIncidentId, mergeIncidentIds);
  const currentVersions = Object.fromEntries(incidents.map((item) => [item.id, item.version]));
  const hasNewVersion = affectedIds.some((id) => currentVersions[id] !== versionsAtOpen[id]);
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
      onSaved(next, `${displayStatus(mode)} decision saved to the audit trail.`);
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
      {formError && <span className="form-error" role="alert">{formError}</span>}
      <VersionConflictNotice
        visible={versionConflict}
        canUseLatest={hasNewVersion}
        onUseLatest={() => {
          setVersionsAtOpen(currentVersions);
          setVersionConflict(false);
          setFormError(null);
        }}
      />
      <div className="form-actions">
        <Button size="xs" variant="ghost" type="button" onClick={onCancel}>Cancel</Button>
        <Button size="xs" type="submit" disabled={pending}>{pending ? "Saving…" : "Save coordinator decision"}</Button>
      </div>
    </form>
  );
}

interface PriorityFormProps {
  incident: Incident;
  onCancel: () => void;
  onSaved: (snapshot: Snapshot) => void;
  onNotice: (notice: Notice) => void;
}

function PriorityForm({ incident, onCancel, onSaved, onNotice }: PriorityFormProps) {
  const [priority, setPriority] = useState<Priority>(incident.priority);
  const [expectedVersion, setExpectedVersion] = useState(incident.version);
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
        onUseLatest={() => {
          setExpectedVersion(incident.version);
          setVersionConflict(false);
          setError(null);
        }}
      />
      <div className="form-actions"><Button size="xs" type="button" variant="ghost" onClick={onCancel}>Cancel</Button><Button size="xs" type="submit" disabled={pending}>{pending ? "Saving…" : "Save priority"}</Button></div>
    </form>
  );
}

interface StatusFormProps {
  incident: Incident;
  onCancel: () => void;
  onSaved: (snapshot: Snapshot) => void;
  onNotice: (notice: Notice) => void;
}

function StatusForm({ incident, onCancel, onSaved, onNotice }: StatusFormProps) {
  const [status, setStatus] = useState<IncidentStatus>(incident.status);
  const [expectedVersion, setExpectedVersion] = useState(incident.version);
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
        onUseLatest={() => {
          setExpectedVersion(incident.version);
          setVersionConflict(false);
          setError(null);
        }}
      />
      <div className="form-actions"><Button size="xs" type="button" variant="ghost" onClick={onCancel}>Cancel</Button><Button size="xs" type="submit" disabled={pending}>{pending ? "Saving…" : "Save status"}</Button></div>
    </form>
  );
}

interface ConflictCardProps {
  conflict: Conflict;
  incident: Incident;
  onApplySnapshot: (snapshot: Snapshot) => void;
  onNotice: (notice: Notice) => void;
}

function ConflictCard({ conflict, incident, onApplySnapshot, onNotice }: ConflictCardProps) {
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
        {conflict.spans.map((span, index) => <p className="conflict-quote" key={`${conflict.id}-${index}`}>“{span}” · {conflict.values[index] ?? "unknown"}</p>)}
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
          {visible.map((entry) => (
            <article className="audit-entry" key={entry.id}>
              <div className="audit-entry-head"><span className="audit-action">{displayStatus(entry.action)}</span><span className="audit-time">{formattedTime(entry.created_at, snapshot.event.timezone)}</span></div>
              <span className="audit-actor">{entry.actor} · {entry.entity_id}</span>
              {entry.reason && <span className="audit-reason">{entry.reason}</span>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
