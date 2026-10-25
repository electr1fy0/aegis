import type { AuditEntry, Health, Incident, Priority, Report, Zone } from "./types";

const priorityNames: Record<Priority, string> = {
  P0: "P0 · Immediate",
  P1: "P1 · High",
  P2: "P2 · Standard",
  UNASSESSED: "Unassessed",
};

export function formatClock(value: string | null | undefined, timeZone?: string): string {
  if (!value) return "Not reported";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
  }
}

export function formattedTime(value: string | null | undefined, timeZone?: string): string {
  if (!value) return "Not reported";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    return formatClock(value);
  }
}

export function formatAge(value: string, now = Date.now()): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "Time unavailable";
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "Just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatEventAge(value: string, now = Date.now()): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "Time unavailable";
  const remaining = timestamp - now;
  if (remaining <= 0) return formatAge(value, now);
  if (remaining < 60_000) return "Soon";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `In ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `In ${hours}h`;
  return `In ${Math.ceil(hours / 24)}d`;
}

export function priorityLabel(priority: Priority): string {
  return priorityNames[priority];
}

export function zoneLabel(zoneId: string | null, zones: Zone[]): string {
  if (!zoneId) return "Unlocated";
  return zones.find((zone) => zone.id === zoneId)?.label ?? "Unknown zone";
}

export function incidentReports(incident: Incident, reports: Report[]): Report[] {
  const byId = new Map(reports.map((report) => [report.id, report]));
  return incident.report_ids.flatMap((id) => {
    const report = byId.get(id);
    return report ? [report] : [];
  });
}

export function firstReportTime(incident: Incident, reports: Report[]): string {
  const times = incidentReports(incident, reports)
    .map((report) => report.reported_at ?? report.received_at)
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)).toISOString() : incident.created_at;
}

export function engineLabel(health: Health): string {
  const engine = health.engine.trim();
  if (/lexical/i.test(engine)) return "Lexical matching · fallback";
  if (/semantic|minilm|sentence/i.test(engine)) {
    return health.model_ready
      ? `Semantic matching · ${health.model_revision ?? engine}`
      : "Semantic matching · unavailable";
  }
  if (!health.model_ready) return `${engine || "Matching engine"} · unavailable`;
  return engine || "Matching engine ready";
}

export function activeIncidents(incidents: Incident[]): Incident[] {
  return incidents.filter((incident) => incident.status !== "resolved");
}

export function latestAuditFirst(entries: AuditEntry[]): AuditEntry[] {
  return [...entries].sort((left, right) => right.seq - left.seq || right.created_at.localeCompare(left.created_at));
}

export function displayStatus(status: string): string {
  return status
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replaceAll(".", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function reportTextPreview(text: string, limit = 180): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function incidentMapPoint(incident: Incident, zones: Zone[]): { x: number; y: number } | null {
  const zone = zones.find((candidate) => candidate.id === incident.zone_id);
  return zone ? { x: zone.x, y: zone.y } : null;
}

export function evidenceScore(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toFixed(2);
}
