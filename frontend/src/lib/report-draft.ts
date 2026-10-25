import type { ReportReceipt } from "./types";

const STORAGE_KEY = "aegis.report-drafts.v1";

export type ReportTimeMode = "just-observed" | "earlier" | "unknown";

export interface ReportDraft {
  eventId: string;
  text: string;
  zoneId: string;
  sublocation: string;
  timeMode: ReportTimeMode;
  reportedAt: string;
  idempotencyKey: string;
  lastAttemptFingerprint: string | null;
  receipt: ReportReceipt | null;
}

export function emptyReportDraft(eventId: string, idempotencyKey: string): ReportDraft {
  return {
    eventId,
    text: "",
    zoneId: "",
    sublocation: "",
    timeMode: "unknown",
    reportedAt: "",
    idempotencyKey,
    lastAttemptFingerprint: null,
    receipt: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReceipt(value: unknown, eventId: string): value is ReportReceipt {
  if (!isRecord(value) || typeof value["duplicate"] !== "boolean") return false;
  if (!isRecord(value["report"]) || !isRecord(value["incident"])) return false;
  const report = value["report"];
  const incident = value["incident"];
  return (
    typeof report["id"] === "string" && report["id"].length > 0 &&
    typeof report["event_id"] === "string" && report["event_id"] === eventId &&
    typeof report["text"] === "string" && report["text"].length <= 4_000 &&
    typeof report["incident_id"] === "string" &&
    (report["analysis_status"] === "complete" || report["analysis_status"] === "pending" || report["analysis_status"] === "failed") &&
    (report["display_id"] === undefined || report["display_id"] === null || typeof report["display_id"] === "string") &&
    typeof incident["id"] === "string" && incident["id"].length > 0 &&
    report["incident_id"] === incident["id"] &&
    typeof incident["event_id"] === "string" && incident["event_id"] === eventId &&
    (incident["priority"] === "P0" || incident["priority"] === "P1" || incident["priority"] === "P2" || incident["priority"] === "UNASSESSED") &&
    (incident["display_id"] === undefined || incident["display_id"] === null || typeof incident["display_id"] === "string")
  );
}

export function isReportDraft(value: unknown): value is ReportDraft {
  if (!isRecord(value)) return false;
  return (
    typeof value["eventId"] === "string" && value["eventId"].length > 0 && value["eventId"].length <= 200 &&
    typeof value["text"] === "string" && value["text"].length <= 4_000 &&
    typeof value["zoneId"] === "string" && value["zoneId"].length <= 200 &&
    typeof value["sublocation"] === "string" && value["sublocation"].length <= 200 &&
    (value["timeMode"] === "just-observed" || value["timeMode"] === "earlier" || value["timeMode"] === "unknown") &&
    typeof value["reportedAt"] === "string" && value["reportedAt"].length <= 40 &&
    typeof value["idempotencyKey"] === "string" && value["idempotencyKey"].length > 0 && value["idempotencyKey"].length <= 200 &&
    (value["lastAttemptFingerprint"] === null || typeof value["lastAttemptFingerprint"] === "string") &&
    value["lastAttemptFingerprint"] !== undefined &&
    (value["receipt"] === null || isReceipt(value["receipt"], value["eventId"])) &&
    value["receipt"] !== undefined
  );
}

function storageOrNull(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function readEntries(storage: Storage): Record<string, ReportDraft> {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const entries: Record<string, ReportDraft> = {};
    for (const [eventId, value] of Object.entries(parsed)) {
      if (isReportDraft(value) && value.eventId === eventId) entries[eventId] = value;
    }
    return entries;
  } catch {
    return {};
  }
}

export function loadReportDraft(eventId: string, idempotencyKey: string, storage?: Storage): ReportDraft {
  const fallback = emptyReportDraft(eventId, idempotencyKey);
  const availableStorage = storageOrNull(storage);
  if (!availableStorage) return fallback;
  return readEntries(availableStorage)[eventId] ?? fallback;
}

export function saveReportDraft(draft: ReportDraft, storage?: Storage): boolean {
  if (!isReportDraft(draft)) return false;
  const availableStorage = storageOrNull(storage);
  if (!availableStorage) return false;
  try {
    const next = { ...readEntries(availableStorage), [draft.eventId]: draft };
    availableStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

export function hasReportDraftContent(draft: ReportDraft): boolean {
  return Boolean(
    draft.text || draft.zoneId || draft.sublocation || draft.reportedAt || draft.receipt ||
    draft.lastAttemptFingerprint,
  );
}
