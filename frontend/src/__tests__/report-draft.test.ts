import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyReportDraft,
  hasReportDraftContent,
  isReportDraft,
  loadReportDraft,
  saveReportDraft,
  type ReportDraft,
} from "../lib/report-draft";
import type { ReportReceipt } from "../lib/types";
import { makeIncident, makeReport } from "./fixtures";

const validReceipt: ReportReceipt = {
  report: makeReport({
    id: "report-1",
    event_id: "event-1",
    text: "A report",
    incident_id: "incident-1",
    analysis_status: "pending",
  }),
  incident: makeIncident({ id: "incident-1", event_id: "event-1", priority: "P1", report_ids: ["report-1"] }),
  duplicate: false,
};

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function createDraft(): ReportDraft {
  return emptyReportDraft("event-1", "key-1");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("report draft persistence", () => {
  it("creates an unknown-time draft and validates a complete receipt", () => {
    const draft = createDraft();
    expect(draft).toMatchObject({ eventId: "event-1", timeMode: "unknown", receipt: null });
    expect(isReportDraft(draft)).toBe(true);
    expect(isReportDraft({ ...draft, receipt: validReceipt })).toBe(true);
    expect(isReportDraft({
      ...draft,
      receipt: {
        ...validReceipt,
        report: { ...validReceipt.report, display_id: null },
        incident: { ...validReceipt.incident, display_id: null },
      },
    })).toBe(true);
  });

  it.each([
    null,
    [],
    { ...createDraft(), eventId: "" },
    { ...createDraft(), eventId: "x".repeat(201) },
    { ...createDraft(), text: 12 },
    { ...createDraft(), text: "x".repeat(4_001) },
    { ...createDraft(), zoneId: 12 },
    { ...createDraft(), zoneId: "x".repeat(201) },
    { ...createDraft(), sublocation: 12 },
    { ...createDraft(), sublocation: "x".repeat(201) },
    { ...createDraft(), timeMode: "soon" },
    { ...createDraft(), reportedAt: 12 },
    { ...createDraft(), reportedAt: "x".repeat(41) },
    { ...createDraft(), idempotencyKey: "" },
    { ...createDraft(), idempotencyKey: "x".repeat(201) },
    { ...createDraft(), lastAttemptFingerprint: 12 },
    { ...createDraft(), lastAttemptFingerprint: undefined },
    { ...createDraft(), receipt: {} },
    { ...createDraft(), receipt: undefined },
  ])("rejects malformed saved draft data %#", (value) => {
    expect(isReportDraft(value)).toBe(false);
  });

  it.each([
    { duplicate: "false", report: validReceipt.report, incident: validReceipt.incident },
    { duplicate: false, report: null, incident: validReceipt.incident },
    { duplicate: false, report: validReceipt.report, incident: null },
    { duplicate: false, report: { ...validReceipt.report, id: 7 }, incident: validReceipt.incident },
    { duplicate: false, report: { ...validReceipt.report, event_id: 7 }, incident: validReceipt.incident },
    { duplicate: false, report: { ...validReceipt.report, text: 7 }, incident: validReceipt.incident },
    { duplicate: false, report: { ...validReceipt.report, incident_id: 7 }, incident: validReceipt.incident },
    { duplicate: false, report: { ...validReceipt.report, analysis_status: 7 }, incident: validReceipt.incident },
    { duplicate: false, report: { ...validReceipt.report, analysis_status: "unknown" }, incident: validReceipt.incident },
    { duplicate: false, report: validReceipt.report, incident: { ...validReceipt.incident, id: 7 } },
    { duplicate: false, report: validReceipt.report, incident: { ...validReceipt.incident, priority: 7 } },
    { duplicate: false, report: { ...validReceipt.report, event_id: "other-event" }, incident: validReceipt.incident },
    { duplicate: false, report: { ...validReceipt.report, incident_id: "other-incident" }, incident: validReceipt.incident },
    { duplicate: false, report: validReceipt.report, incident: { ...validReceipt.incident, event_id: "other-event" } },
    { duplicate: false, report: { ...validReceipt.report, display_id: 4 }, incident: validReceipt.incident },
    { duplicate: false, report: validReceipt.report, incident: { ...validReceipt.incident, display_id: 4 } },
    { duplicate: false, report: { ...validReceipt.report, display_id: { value: "report" } }, incident: validReceipt.incident },
    { duplicate: false, report: validReceipt.report, incident: { ...validReceipt.incident, display_id: { value: "incident" } } },
  ])("rejects malformed receipt data %#", (receipt) => {
    expect(isReportDraft({ ...createDraft(), receipt })).toBe(false);
  });

  it("stores separate event drafts and restores the idempotency identity", () => {
    const storage = new MemoryStorage();
    const first = { ...createDraft(), text: "Keep this wording.", lastAttemptFingerprint: "same-fields" };
    const second = { ...emptyReportDraft("event-2", "key-2"), zoneId: "stage" };
    expect(saveReportDraft(first, storage)).toBe(true);
    expect(saveReportDraft(second, storage)).toBe(true);
    expect(loadReportDraft("event-1", "fresh-key", storage)).toEqual(first);
    expect(loadReportDraft("event-2", "fresh-key", storage)).toEqual(second);
    expect(loadReportDraft("missing", "fresh-key", storage)).toEqual(emptyReportDraft("missing", "fresh-key"));
  });

  it("ignores malformed JSON, invalid roots, mismatched event keys, and invalid entries", () => {
    const storage = new MemoryStorage();
    storage.setItem("aegis.report-drafts.v1", "{");
    expect(loadReportDraft("event-1", "fallback", storage).idempotencyKey).toBe("fallback");
    storage.setItem("aegis.report-drafts.v1", "[]");
    expect(loadReportDraft("event-1", "fallback", storage).eventId).toBe("event-1");
    storage.setItem("aegis.report-drafts.v1", JSON.stringify({
      "event-other": createDraft(),
      "event-1": { ...createDraft(), eventId: "event-1", text: 12 },
    }));
    expect(loadReportDraft("event-1", "fallback", storage).idempotencyKey).toBe("fallback");
  });

  it("drops a persisted receipt with a corrupt display identifier instead of restoring it", () => {
    const storage = new MemoryStorage();
    const corrupted = {
      ...createDraft(),
      receipt: {
        ...validReceipt,
        report: { ...validReceipt.report, display_id: { unexpected: true } },
      },
    };
    storage.setItem("aegis.report-drafts.v1", JSON.stringify({ "event-1": corrupted }));

    expect(loadReportDraft("event-1", "fresh-key", storage)).toEqual(emptyReportDraft("event-1", "fresh-key"));
  });

  it("handles unavailable and throwing storage without losing the in-memory draft", () => {
    expect(loadReportDraft("event-1", "fallback").idempotencyKey).toBe("fallback");
    expect(saveReportDraft(createDraft())).toBe(false);
    const readFailure = { getItem: () => { throw new Error("blocked"); } } as unknown as Storage;
    expect(loadReportDraft("event-1", "fallback", readFailure).idempotencyKey).toBe("fallback");
    const writeFailure = {
      getItem: () => null,
      setItem: () => { throw new Error("quota"); },
    } as unknown as Storage;
    expect(saveReportDraft(createDraft(), writeFailure)).toBe(false);
    expect(saveReportDraft({ ...createDraft(), text: 12 } as unknown as ReportDraft, new MemoryStorage())).toBe(false);
  });

  it.each([
    ["text", { ...createDraft(), text: "words" }],
    ["zone", { ...createDraft(), zoneId: "stage" }],
    ["sublocation", { ...createDraft(), sublocation: "north door" }],
    ["time", { ...createDraft(), reportedAt: "2026-10-24T10:00" }],
    ["attempt fingerprint", { ...createDraft(), lastAttemptFingerprint: "attempted" }],
    ["receipt", { ...createDraft(), receipt: validReceipt }],
  ] as Array<[string, ReportDraft]>) ("recognizes a draft with saved %s", (_label, draft) => {
    expect(hasReportDraftContent(draft)).toBe(true);
  });

  it("treats a blank draft as empty", () => {
    expect(hasReportDraftContent(createDraft())).toBe(false);
  });

  it("handles a browser that throws while exposing local storage", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
    expect(loadReportDraft("event-1", "fallback").idempotencyKey).toBe("fallback");
    if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
    else delete (window as unknown as { localStorage?: Storage }).localStorage;
  });
});
