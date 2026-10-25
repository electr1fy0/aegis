import { incidentReports, zoneLabel } from "./format";
import type { Incident, Priority, Report, Snapshot } from "./types";

export type QueueFilter = "active" | "review" | "conflicts" | "all";
export type QueueSort = "priority" | "newest_update" | "oldest_unreviewed" | "latest_report";

export interface QueueCriteria {
  query: string;
  filter: QueueFilter;
  priority: Priority | "all";
  status: Incident["status"] | "all";
  zone: string | "all" | "unlocated";
  sort: QueueSort;
}

export interface RelatedCandidate {
  incident: Incident;
  score: number;
  evidenceCount: number;
  reasons: string[];
  missingFields: string[];
  reportPair: [string, string];
}

const priorities: Priority[] = ["P0", "P1", "P2", "UNASSESSED"];
const statuses: Incident["status"][] = ["open", "acknowledged", "monitoring", "resolved"];
const sortModes: QueueSort[] = ["priority", "newest_update", "oldest_unreviewed", "latest_report"];
const queueFilters: QueueFilter[] = ["active", "review", "conflicts", "all"];

function validValue<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return value && allowed.includes(value as T) ? value as T : fallback;
}

export function readDashboardQuery(search: string): { incidentId: string | null; criteria: QueueCriteria; view: "queue" | "map" } {
  const params = new URLSearchParams(search);
  const query = params.get("q") ?? "";
  const filter = validValue(params.get("queue"), queueFilters, "active");
  const priority = validValue(params.get("priority"), ["all", ...priorities] as const, "all");
  const status = validValue(params.get("status"), ["all", ...statuses] as const, "all");
  const sort = validValue(params.get("sort"), sortModes, "priority");
  const zone = params.get("zone") ?? "all";
  const view = validValue(params.get("view"), ["queue", "map"] as const, "queue");
  return {
    incidentId: params.get("incident"),
    criteria: { query, filter, priority, status, zone, sort },
    view,
  };
}

export function writeDashboardQuery(
  currentUrl: string,
  next: { incidentId: string | null; criteria: QueueCriteria; view: "queue" | "map" },
): string {
  const url = new URL(currentUrl, "http://aegis.local");
  const params = url.searchParams;
  const entries: [string, string][] = [
    ["incident", next.incidentId ?? ""],
    ["q", next.criteria.query.trim()],
    ["queue", next.criteria.filter === "active" ? "" : next.criteria.filter],
    ["priority", next.criteria.priority === "all" ? "" : next.criteria.priority],
    ["status", next.criteria.status === "all" ? "" : next.criteria.status],
    ["zone", next.criteria.zone === "all" ? "" : next.criteria.zone],
    ["sort", next.criteria.sort === "priority" ? "" : next.criteria.sort],
    ["view", next.view === "queue" ? "" : next.view],
  ];
  entries.forEach(([key, value]) => {
    if (value) params.set(key, value);
    else params.delete(key);
  });
  return `${url.pathname}${params.size ? `?${params.toString()}` : ""}${url.hash}`;
}

export function dashboardIncidentHref(currentUrl: string, eventId: string, incidentId: string): string {
  const current = new URL(currentUrl, "http://aegis.local");
  const currentView = readDashboardQuery(current.search);
  const nextUrl = new URL(writeDashboardQuery(current.toString(), {
    incidentId,
    criteria: currentView.criteria,
    view: currentView.view,
  }), "http://aegis.local");
  nextUrl.searchParams.set("event", eventId);
  return `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
}

function normalized(value: string): string {
  return value.normalize("NFKD").toLocaleLowerCase().trim();
}

function searchableText(incident: Incident, reports: Report[], zones: Snapshot["zones"]): string {
  const related = incidentReports(incident, reports);
  return normalized([
    incident.title,
    incident.id,
    incident.display_id ?? "",
    zoneLabel(incident.zone_id, zones),
    incident.zone_id ?? "",
    ...related.flatMap((report) => [report.id, report.display_id ?? "", report.text, report.sublocation ?? ""]),
  ].join(" "));
}

function latestReportAt(incident: Incident, reports: Report[]): number {
  const times = incidentReports(incident, reports)
    .map((report) => new Date(report.received_at).valueOf())
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : new Date(incident.updated_at).valueOf();
}

function reviewTimestamp(incident: Incident, reports: Report[]): number {
  const times = incidentReports(incident, reports)
    .map((report) => new Date(report.received_at).valueOf())
    .filter(Number.isFinite);
  return times.length ? Math.min(...times) : new Date(incident.created_at).valueOf();
}

export function matchesQueueCriteria(
  incident: Incident,
  criteria: QueueCriteria,
  reports: Report[],
  zones: Snapshot["zones"],
): boolean {
  if (criteria.filter === "active" && incident.status === "resolved") return false;
  if (criteria.filter === "review" && !incident.review_required && incident.priority !== "UNASSESSED") return false;
  if (criteria.filter === "conflicts" && !incident.conflicts.some((conflict) => conflict.status === "unresolved")) return false;
  if (criteria.priority !== "all" && incident.priority !== criteria.priority) return false;
  if (criteria.status !== "all" && incident.status !== criteria.status) return false;
  if (criteria.zone === "unlocated" && !incidentReports(incident, reports).some((report) => report.zone_id === null)) return false;
  if (criteria.zone !== "all" && criteria.zone !== "unlocated" && incident.zone_id !== criteria.zone) return false;
  if (criteria.query && !searchableText(incident, reports, zones).includes(normalized(criteria.query))) return false;
  return true;
}

export function criteriaForIncident(
  incident: Incident,
  criteria: QueueCriteria,
  reports: Report[],
  zones: Snapshot["zones"],
): QueueCriteria {
  if (matchesQueueCriteria(incident, criteria, reports, zones)) return criteria;
  const next = { ...criteria };
  const matches = () => matchesQueueCriteria(incident, next, reports, zones);
  if (next.filter !== "all") {
    next.filter = "all";
    if (matches()) return next;
  }
  if (next.priority !== "all") {
    next.priority = "all";
    if (matches()) return next;
  }
  if (next.status !== "all") {
    next.status = "all";
    if (matches()) return next;
  }
  if (next.zone !== "all") {
    next.zone = "all";
    if (matches()) return next;
  }
  next.query = "";
  return next;
}

export function sortQueue(
  incidents: Incident[],
  sort: QueueSort,
  reports: Report[],
): Incident[] {
  return [...incidents].sort((left, right) => {
    if (sort === "priority") {
      const priorityOrder: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, UNASSESSED: 3 };
      return priorityOrder[left.priority] - priorityOrder[right.priority]
        || new Date(left.created_at).valueOf() - new Date(right.created_at).valueOf()
        || left.id.localeCompare(right.id);
    }
    if (sort === "newest_update") {
      return new Date(right.updated_at).valueOf() - new Date(left.updated_at).valueOf() || left.id.localeCompare(right.id);
    }
    if (sort === "latest_report") {
      return latestReportAt(right, reports) - latestReportAt(left, reports) || left.id.localeCompare(right.id);
    }
    const leftReview = left.review_required || left.priority === "UNASSESSED";
    const rightReview = right.review_required || right.priority === "UNASSESSED";
    if (leftReview !== rightReview) return leftReview ? -1 : 1;
    return reviewTimestamp(left, reports) - reviewTimestamp(right, reports) || left.id.localeCompare(right.id);
  });
}

export function nextReviewCandidate(snapshot: Snapshot, criteria: QueueCriteria, currentIncidentId: string | null): Incident | undefined {
  const candidates = sortQueue(
    snapshot.incidents.filter((incident) =>
      (incident.review_required || incident.priority === "UNASSESSED")
      && matchesQueueCriteria(incident, criteria, snapshot.reports, snapshot.zones),
    ),
    "oldest_unreviewed",
    snapshot.reports,
  );
  return candidates.find((incident) => incident.id !== currentIncidentId);
}

export function relatedCandidates(snapshot: Snapshot, incident: Incident, limit = 3): RelatedCandidate[] {
  const reportOwner = new Map(snapshot.reports.map((report) => [report.id, report.incident_id]));
  const byId = new Map(snapshot.incidents.map((item) => [item.id, item]));
  const ownReports = new Set(incident.report_ids);
  const candidates = new Map<string, RelatedCandidate>();

  for (const source of snapshot.incidents) {
    for (const evidence of source.evidence) {
      const firstOwner = reportOwner.get(evidence.report_id);
      const secondOwner = reportOwner.get(evidence.candidate_report_id);
      let candidateId: string | undefined;
      if (ownReports.has(evidence.report_id) && secondOwner && secondOwner !== incident.id) candidateId = secondOwner;
      else if (ownReports.has(evidence.candidate_report_id) && firstOwner && firstOwner !== incident.id) candidateId = firstOwner;
      if (!candidateId || !byId.has(candidateId) || evidence.decision === "separate") continue;
      const candidate = byId.get(candidateId)!;
      const entry = candidates.get(candidateId) ?? {
        incident: candidate,
        score: -1,
        evidenceCount: 0,
        reasons: [],
        missingFields: [],
        reportPair: [evidence.report_id, evidence.candidate_report_id] as [string, string],
      };
      entry.evidenceCount += 1;
      const score = evidence.total_score ?? 0;
      const isChosenPair = [...entry.reportPair].sort().join("\u0000")
        === [evidence.report_id, evidence.candidate_report_id].sort().join("\u0000");
      if (score > entry.score) {
        entry.score = score;
        entry.reportPair = [evidence.report_id, evidence.candidate_report_id];
        entry.reasons = [...evidence.reasons];
        entry.missingFields = [...evidence.missing_fields];
      } else if (score === entry.score && isChosenPair) {
        entry.reasons.push(...evidence.reasons);
        entry.missingFields.push(...evidence.missing_fields);
      }
      candidates.set(candidateId, entry);
    }
  }

  return [...candidates.values()]
    .map((candidate) => ({
      ...candidate,
      score: Math.max(0, candidate.score),
      reasons: [...new Set(candidate.reasons)],
      missingFields: [...new Set(candidate.missingFields)],
    }))
    .sort((left, right) => right.score - left.score || right.evidenceCount - left.evidenceCount || left.incident.id.localeCompare(right.incident.id))
    .slice(0, Math.max(0, limit));
}

export function shortDisplayId(displayId: string | null | undefined, id: string, prefix: "INC" | "RPT"): string {
  if (displayId?.trim()) return displayId.trim();
  const parts = id.split("-");
  const suffix = parts[parts.length - 1]!.toUpperCase();
  return `${prefix}-${suffix}`;
}

export function reviewReasonLabel(reason: string): string {
  const value = normalized(reason);
  if (/conflict|contradict|inconsistent/.test(value)) return "Conflicting accounts";
  if (/location|zone|where/.test(value)) return "Location needs checking";
  if (/time|when|timestamp/.test(value)) return "Timing needs checking";
  if (/missing|incomplete|unclear|ambiguous/.test(value)) return "More detail needed";
  if (/analysis|failed|pending/.test(value)) return "Analysis needs attention";
  return "Coordinator review";
}

export function highlightRanges(text: string, phrases: string[]): Array<{ start: number; end: number; phrase: string }> {
  const ranges: Array<{ start: number; end: number; phrase: string }> = [];
  for (const phrase of [...new Set(phrases)].filter(Boolean)) {
    const start = text.toLocaleLowerCase().indexOf(phrase.toLocaleLowerCase());
    if (start >= 0) ranges.push({ start, end: start + phrase.length, phrase });
  }
  const result: Array<{ start: number; end: number; phrase: string }> = [];
  for (const range of ranges.sort((left, right) => left.start - right.start || right.end - left.end)) {
    if (!result.length || range.start >= result[result.length - 1]!.end) result.push(range);
  }
  return result;
}

export function exportSnapshotJson(snapshot: Snapshot): string {
  return JSON.stringify({
    event: snapshot.event,
    generated_at: new Date().toISOString(),
    incidents: snapshot.incidents.map((incident) => ({
      id: incident.id,
      display_id: incident.display_id ?? null,
      title: incident.title,
      priority: incident.priority,
      status: incident.status,
      zone_id: incident.zone_id,
      source_report_ids: incident.report_ids,
      coordinator_notes: incident.notes ?? [],
      unresolved_questions: incident.conflicts
        .filter((conflict) => conflict.status === "unresolved")
        .map((conflict) => ({
          field: conflict.field,
          reason: conflict.reason,
          values: conflict.values,
          spans: conflict.spans,
          report_ids: conflict.report_ids,
        })),
    })),
  }, null, 2);
}

export function exportSnapshotCsv(snapshot: Snapshot): string {
  const escape = (value: string | number | null | undefined): string => {
    const raw = value == null ? "" : String(value);
    const text = /^[=+\-@]/.test(raw.trimStart()) ? `'${raw}` : raw;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const headings = ["incident_id", "display_id", "title", "priority", "status", "zone_id", "source_report_ids", "coordinator_notes", "unresolved_questions"];
  const rows = snapshot.incidents.map((incident) => [
    incident.id,
    incident.display_id ?? "",
    incident.title,
    incident.priority,
    incident.status,
    incident.zone_id ?? "",
    incident.report_ids.join(";"),
    (incident.notes ?? []).map((note) => note.text).join(" | "),
    incident.conflicts.filter((conflict) => conflict.status === "unresolved").map((conflict) => `${conflict.field}: ${conflict.reason || conflict.spans.join(" / ")}`).join(" | "),
  ]);
  return [headings, ...rows].map((row) => row.map(escape).join(",")).join("\r\n");
}

export function unreadReportIds(incident: Incident, readIds: string[]): string[] {
  const seen = new Set(readIds);
  return incident.report_ids.filter((id) => !seen.has(id));
}
