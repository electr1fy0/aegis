import { describe, expect, it } from "vitest";
import {
  criteriaForIncident,
  dashboardIncidentHref,
  exportSnapshotCsv,
  exportSnapshotJson,
  highlightRanges,
  matchesQueueCriteria,
  nextReviewCandidate,
  readDashboardQuery,
  relatedCandidates,
  reviewReasonLabel,
  shortDisplayId,
  sortQueue,
  unreadReportIds,
  writeDashboardQuery,
  type QueueCriteria,
} from "../lib/dashboard-model";
import type { Incident, Snapshot } from "../lib/types";
import { formatEventAge } from "../lib/format";
import {
  conflictFixture,
  evidenceFixture,
  eventFixture,
  makeIncident,
  makeReport,
  snapshotFixture,
  zonesFixture,
} from "./fixtures";

const criteria: QueueCriteria = {
  query: "",
  filter: "active",
  priority: "all",
  status: "all",
  zone: "all",
  sort: "priority",
};

function modelSnapshot(): Snapshot {
  const first = makeReport({ id: "report-one", incident_id: "incident-one", text: "Alarm beside the stage", zone_id: "stage", received_at: "2026-10-24T10:00:00Z" });
  const second = makeReport({ id: "report-two", incident_id: "incident-two", text: "Alarm at the stage entrance", zone_id: "stage", received_at: "2026-10-24T10:05:00Z", sublocation: "north gate" });
  const third = makeReport({ id: "report-three", incident_id: "incident-three", text: "Unlocated smoke report", zone_id: null, received_at: "2026-10-24T10:02:00Z" });
  const fourth = makeReport({ id: "report-four", incident_id: "incident-one", text: "Second account", zone_id: "stage", received_at: "2026-10-24T10:10:00Z" });
  const baseEvidence = { ...evidenceFixture, report_id: first.id, candidate_report_id: second.id, decision: "suggest" as const, total_score: 0.87, reasons: ["Same zone", "Same account"], missing_fields: ["time"] };
  const incidentOne = makeIncident({ id: "incident-one", display_id: "INC-1", title: "Stage alarm", zone_id: "stage", report_ids: [first.id, fourth.id], priority: "P1", review_required: true, review_reasons: ["Location is not confirmed."], evidence: [baseEvidence, { ...baseEvidence, report_id: fourth.id, total_score: 0.4, reasons: ["A different report pair"], missing_fields: ["sublocation"] }, { ...baseEvidence, total_score: 0.63, reasons: ["Same zone"], missing_fields: ["time", "sublocation"] }], updated_at: "2026-10-24T11:00:00Z", created_at: "2026-10-24T10:00:00Z" });
  const incidentTwo = makeIncident({ id: "incident-two", title: "Possible gate alarm", zone_id: "stage", report_ids: [second.id], priority: "P2", status: "monitoring", updated_at: "2026-10-24T10:30:00Z", evidence: [{ ...baseEvidence, report_id: second.id, candidate_report_id: first.id, decision: "suggest", total_score: 0.87 }] });
  const incidentThree = makeIncident({ id: "incident-three", title: "Unlocated smoke", zone_id: null, report_ids: [third.id], priority: "UNASSESSED", review_required: true, status: "open", conflicts: [{ ...conflictFixture, status: "unresolved" }] });
  const incidents = [incidentOne, incidentTwo, incidentThree];
  return {
    ...snapshotFixture,
    event: eventFixture,
    zones: zonesFixture,
    incidents,
    reports: [first, second, third, fourth],
  };
}

describe("dashboard queue model", () => {
  it("reads validated queue state from the URL and ignores invalid options", () => {
    expect(readDashboardQuery("?event=ev-2&incident=inc-1&q=alarm&queue=conflicts&priority=P1&status=monitoring&zone=stage&sort=latest_report&view=map")).toEqual({
      incidentId: "inc-1",
      criteria: { query: "alarm", filter: "conflicts", priority: "P1", status: "monitoring", zone: "stage", sort: "latest_report" },
      view: "map",
    });
    expect(readDashboardQuery("?queue=unknown&priority=bad&status=bad&sort=bad&view=bad")).toEqual({ incidentId: null, criteria, view: "queue" });
  });

  it("updates incident and queue parameters while retaining the event and unrelated keys", () => {
    expect(writeDashboardQuery("/dashboard?event=ev-2&keep=yes&incident=old#queue", {
      incidentId: "inc new",
      criteria: { ...criteria, query: "  smoke  ", filter: "review", priority: "P0", status: "resolved", zone: "unlocated", sort: "newest_update" },
      view: "map",
    })).toBe("/dashboard?event=ev-2&keep=yes&incident=inc+new&q=smoke&queue=review&priority=P0&status=resolved&zone=unlocated&sort=newest_update&view=map#queue");
    expect(writeDashboardQuery("/dashboard?event=ev-2&q=old&incident=inc", { incidentId: null, criteria, view: "queue" })).toBe("/dashboard?event=ev-2");
  });

  it("creates audit links that retain the selected event and existing deep-link criteria", () => {
    expect(dashboardIncidentHref("/dashboard?event=ev-2&queue=review&keep=yes#audit", "ev-2", "inc-7"))
      .toBe("/dashboard?event=ev-2&queue=review&keep=yes&incident=inc-7#audit");
    expect(dashboardIncidentHref("/dashboard?keep=yes", "ev 2", "inc 7"))
      .toBe("/dashboard?keep=yes&incident=inc+7&event=ev+2");
  });

  it("matches query, status, priority, zone, unlocated evidence, and review scopes", () => {
    const snapshot = modelSnapshot();
    const [stage, _possible, unlocated] = snapshot.incidents as [Incident, Incident, Incident];
    expect(matchesQueueCriteria(stage, { ...criteria, filter: "review" }, snapshot.reports, snapshot.zones)).toBe(true);
    expect(matchesQueueCriteria(stage, { ...criteria, filter: "conflicts" }, snapshot.reports, snapshot.zones)).toBe(false);
    expect(matchesQueueCriteria(unlocated, { ...criteria, filter: "conflicts" }, snapshot.reports, snapshot.zones)).toBe(true);
    expect(matchesQueueCriteria(stage, { ...criteria, filter: "active", priority: "P1" }, snapshot.reports, snapshot.zones)).toBe(true);
    expect(matchesQueueCriteria(stage, { ...criteria, priority: "P2" }, snapshot.reports, snapshot.zones)).toBe(false);
    expect(matchesQueueCriteria(stage, { ...criteria, status: "monitoring" }, snapshot.reports, snapshot.zones)).toBe(false);
    expect(matchesQueueCriteria(stage, { ...criteria, status: "open" }, snapshot.reports, snapshot.zones)).toBe(true);
    expect(matchesQueueCriteria(unlocated, { ...criteria, zone: "unlocated" }, snapshot.reports, snapshot.zones)).toBe(true);
    expect(matchesQueueCriteria(stage, { ...criteria, zone: "unlocated" }, snapshot.reports, snapshot.zones)).toBe(false);
    expect(matchesQueueCriteria(stage, { ...criteria, zone: "stage" }, snapshot.reports, snapshot.zones)).toBe(true);
    expect(matchesQueueCriteria(stage, { ...criteria, zone: "exit-a" }, snapshot.reports, snapshot.zones)).toBe(false);
    expect(matchesQueueCriteria(stage, { ...criteria, query: "second account" }, snapshot.reports, snapshot.zones)).toBe(true);
    expect(matchesQueueCriteria(stage, { ...criteria, query: "report-four" }, snapshot.reports, snapshot.zones)).toBe(true);
    expect(matchesQueueCriteria(stage, { ...criteria, query: "not present" }, snapshot.reports, snapshot.zones)).toBe(false);
    const resolved = makeIncident({ id: "resolved", status: "resolved" });
    expect(matchesQueueCriteria(resolved, { ...criteria, filter: "active" }, [], zonesFixture)).toBe(false);
    expect(matchesQueueCriteria(resolved, { ...criteria, filter: "review" }, [], zonesFixture)).toBe(false);
  });

  it("relaxes only the filters needed to reveal a selected related group", () => {
    const snapshot = modelSnapshot();
    const resolved = makeIncident({ id: "resolved-related", status: "resolved", priority: "P2", zone_id: "exit-a", title: "Resolved alarm" });
    const hiddenCriteria: QueueCriteria = { ...criteria, query: "missing phrase", filter: "active", priority: "P1", status: "open", zone: "stage" };
    const result = criteriaForIncident(resolved, hiddenCriteria, snapshot.reports, snapshot.zones);
    expect(result).toEqual({ ...hiddenCriteria, filter: "all", priority: "all", status: "all", zone: "all", query: "" });
    expect(matchesQueueCriteria(resolved, result, snapshot.reports, snapshot.zones)).toBe(true);
  });

  it("broadens filters one at a time and preserves filters that already include a group", () => {
    const snapshot = modelSnapshot();
    const resolved = makeIncident({ id: "resolved", status: "resolved", priority: "P1", zone_id: "exit-a", title: "Resolved alarm" });
    expect(criteriaForIncident(snapshot.incidents[0]!, criteria, snapshot.reports, snapshot.zones)).toBe(criteria);
    expect(criteriaForIncident(resolved, { ...criteria, filter: "active" }, snapshot.reports, snapshot.zones)).toMatchObject({ filter: "all" });
    expect(criteriaForIncident(resolved, { ...criteria, filter: "all", priority: "P2" }, snapshot.reports, snapshot.zones)).toMatchObject({ filter: "all", priority: "all" });
    expect(criteriaForIncident(resolved, { ...criteria, filter: "all", status: "open" }, snapshot.reports, snapshot.zones)).toMatchObject({ filter: "all", status: "all" });
    expect(criteriaForIncident(resolved, { ...criteria, filter: "all", zone: "stage" }, snapshot.reports, snapshot.zones)).toMatchObject({ filter: "all", zone: "all" });
    expect(criteriaForIncident(resolved, { ...criteria, filter: "all", query: "missing phrase" }, snapshot.reports, snapshot.zones)).toMatchObject({ filter: "all", query: "" });
  });

  it("sorts by latest update, latest report, or oldest unreviewed with stable ID ties", () => {
    const snapshot = modelSnapshot();
    const [first, second, third] = snapshot.incidents as [Incident, Incident, Incident];
    expect(sortQueue([first, second], "newest_update", snapshot.reports).map((item) => item.id)).toEqual(["incident-one", "incident-two"]);
    expect(sortQueue([first, second], "latest_report", snapshot.reports).map((item) => item.id)).toEqual(["incident-one", "incident-two"]);
    expect(sortQueue([first, second, third], "oldest_unreviewed", snapshot.reports).map((item) => item.id)).toEqual(["incident-one", "incident-three", "incident-two"]);
    const noReport = makeIncident({ id: "no-report", report_ids: [], created_at: "2026-10-24T09:00:00Z", updated_at: "2026-10-24T12:00:00Z" });
    const laterNoReport = makeIncident({ id: "later-no-report", report_ids: [], created_at: "2026-10-24T10:00:00Z", updated_at: "2026-10-24T13:00:00Z" });
    expect(sortQueue([noReport, laterNoReport], "latest_report", []).map((item) => item.id)).toEqual(["later-no-report", "no-report"]);
    expect(sortQueue([noReport, laterNoReport], "oldest_unreviewed", []).map((item) => item.id)).toEqual(["no-report", "later-no-report"]);
    expect(sortQueue([third, second, first], "priority", snapshot.reports).map((item) => item.id)).toEqual(["incident-one", "incident-two", "incident-three"]);
    const tieB = makeIncident({ id: "tie-b", created_at: "2026-10-24T10:00:00Z", updated_at: "2026-10-24T11:00:00Z", report_ids: [], review_required: true });
    const tieA = makeIncident({ id: "tie-a", created_at: "2026-10-24T10:00:00Z", updated_at: "2026-10-24T11:00:00Z", report_ids: [], review_required: true });
    expect(sortQueue([tieB, tieA], "priority", []).map((item) => item.id)).toEqual(["tie-a", "tie-b"]);
    expect(sortQueue([tieB, tieA], "newest_update", []).map((item) => item.id)).toEqual(["tie-a", "tie-b"]);
    expect(sortQueue([tieB, tieA], "latest_report", []).map((item) => item.id)).toEqual(["tie-a", "tie-b"]);
    expect(sortQueue([tieB, tieA], "oldest_unreviewed", []).map((item) => item.id)).toEqual(["tie-a", "tie-b"]);
  });

  it("finds the next review item inside current queue filters", () => {
    const snapshot = modelSnapshot();
    expect(nextReviewCandidate(snapshot, { ...criteria, filter: "all" }, "incident-one")?.id).toBe("incident-three");
    expect(nextReviewCandidate(snapshot, { ...criteria, filter: "review", zone: "stage" }, "incident-one")).toBeUndefined();
    expect(nextReviewCandidate(snapshot, { ...criteria, filter: "review", priority: "P0" }, "incident-one")).toBeUndefined();
    expect(nextReviewCandidate(snapshot, { ...criteria, filter: "review", query: "smoke" }, "incident-one")?.id).toBe("incident-three");
  });

  it("ranks evidence-linked groups and keeps notes scoped to the best comparison pair", () => {
    const snapshot = modelSnapshot();
    const selected = snapshot.incidents[0]!;
    const candidates = relatedCandidates(snapshot, selected, 3);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ incident: snapshot.incidents[1], score: 0.87, evidenceCount: 4, reasons: ["Same zone", "Same account"], missingFields: ["time"] });
    expect(candidates[0]?.reportPair).toEqual(["report-one", "report-two"]);
    expect(relatedCandidates(snapshot, selected, 0)).toEqual([]);

    selected.evidence = [
      { ...evidenceFixture, report_id: "report-one", candidate_report_id: "report-three", decision: "separate" },
      { ...evidenceFixture, report_id: "missing-report", candidate_report_id: "report-three", decision: "suggest" },
      { ...evidenceFixture, report_id: "report-one", candidate_report_id: "missing-report", decision: "suggest" },
      { ...evidenceFixture, report_id: "report-one", candidate_report_id: "report-four", decision: "suggest" },
    ];
    snapshot.incidents[1]!.evidence = [];
    expect(relatedCandidates(snapshot, selected)).toEqual([]);
  });

  it("orders equal historical candidates by ID and handles evidence stored in either direction", () => {
    const first = makeReport({ id: "root-report", incident_id: "root", received_at: "2026-10-24T10:00:00Z" });
    const candidateAReport = makeReport({ id: "candidate-a-report", incident_id: "candidate-a" });
    const candidateBReport = makeReport({ id: "candidate-b-report", incident_id: "candidate-b" });
    const root = makeIncident({ id: "root", report_ids: [first.id], evidence: [
      { ...evidenceFixture, report_id: first.id, candidate_report_id: candidateBReport.id, total_score: null },
      { ...evidenceFixture, report_id: candidateAReport.id, candidate_report_id: first.id, total_score: null },
    ] });
    const snapshot = { ...snapshotFixture, incidents: [root, makeIncident({ id: "candidate-b", report_ids: [candidateBReport.id] }), makeIncident({ id: "candidate-a", report_ids: [candidateAReport.id] })], reports: [first, candidateAReport, candidateBReport] };
    expect(relatedCandidates(snapshot, root).map((candidate) => candidate.incident.id)).toEqual(["candidate-a", "candidate-b"]);
    expect(relatedCandidates(snapshot, root).map((candidate) => candidate.score)).toEqual([0, 0]);
  });

  it("labels review reasons, formats short IDs, and chooses non-overlapping highlights", () => {
    expect(reviewReasonLabel("Two conflicting reports contradict one another")).toBe("Conflicting accounts");
    expect(reviewReasonLabel("Location unknown")).toBe("Location needs checking");
    expect(reviewReasonLabel("The timestamp is missing")).toBe("Timing needs checking");
    expect(reviewReasonLabel("Ambiguous detail")).toBe("More detail needed");
    expect(reviewReasonLabel("Analysis failed")).toBe("Analysis needs attention");
    expect(reviewReasonLabel("Coordinator asked for a review")).toBe("Coordinator review");
    expect(shortDisplayId("INC-42", "incident-001", "INC")).toBe("INC-42");
    expect(shortDisplayId(undefined, "report-xyz", "RPT")).toBe("RPT-XYZ");
    expect(shortDisplayId(null, "incident-7", "INC")).toBe("INC-7");
    expect(shortDisplayId(undefined, "plain", "INC")).toBe("INC-PLAIN");
    expect(highlightRanges("The exit is blocked by smoke.", ["blocked", "exit is blocked", "SMOKE", "blocked"])).toEqual([
      { start: 4, end: 19, phrase: "exit is blocked" },
      { start: 23, end: 28, phrase: "SMOKE" },
    ]);
    expect(highlightRanges("plain text", ["missing", ""])).toEqual([]);
  });

  it("renders future occurrence times distinctly from recent past times", () => {
    const now = Date.parse("2026-10-25T10:00:00Z");
    expect(formatEventAge("2026-10-25T10:01:00Z", now)).toBe("In 1m");
    expect(formatEventAge("2026-10-25T11:00:00Z", now)).toBe("In 1h");
    expect(formatEventAge("2026-10-27T10:00:00Z", now)).toBe("In 2d");
    expect(formatEventAge("2026-10-25T09:59:00Z", now)).toBe("1m ago");
    expect(formatEventAge("bad time", now)).toBe("Time unavailable");
  });

  it("exports status, report IDs, notes, and unresolved questions in JSON and escaped CSV", () => {
    const snapshot = modelSnapshot();
    const incident = snapshot.incidents[0]!;
    incident.notes = [{ id: "note-1", text: "Checked with, facilities", actor: "coordinator", created_at: "2026-10-24T11:10:00Z" }];
    incident.title = 'Stage "alarm", north';
    incident.conflicts = [{ ...conflictFixture, status: "unresolved", reason: "Check, then confirm" }];
    const json = JSON.parse(exportSnapshotJson(snapshot)) as { incidents: Array<Record<string, unknown>> };
    expect(json.incidents[0]).toMatchObject({ id: "incident-one", title: 'Stage "alarm", north', status: "open", source_report_ids: ["report-one", "report-four"], coordinator_notes: incident.notes, unresolved_questions: [{ field: "exit_access", reason: "Check, then confirm", values: conflictFixture.values, spans: conflictFixture.spans, report_ids: conflictFixture.report_ids }] });
    expect(exportSnapshotCsv(snapshot)).toContain('"Stage ""alarm"", north"');
    expect(exportSnapshotCsv(snapshot)).toContain('"Checked with, facilities"');
    incident.title = "  =HYPERLINK(\"https://example.invalid\")";
    incident.notes = [{ id: "note-2", text: "@SUM(1,1)", actor: "coordinator", created_at: "2026-10-24T11:11:00Z" }];
    const csv = exportSnapshotCsv(snapshot);
    expect(csv).toContain("'  =HYPERLINK");
    expect(csv).toContain("'@SUM(1,1)");
  });

  it("exports evidence snippets when an unresolved conflict has no written reason", () => {
    const snapshot = modelSnapshot();
    snapshot.incidents[0]!.conflicts = [{
      ...conflictFixture,
      status: "unresolved",
      reason: "",
      values: ["blocked", "clear"],
      spans: ["The exit is blocked.", "Exit A is clear."],
    }];
    const json = JSON.parse(exportSnapshotJson(snapshot)) as { incidents: Array<{ unresolved_questions: Array<Record<string, unknown>> }> };
    expect(json.incidents[0]!.unresolved_questions[0]).toMatchObject({
      field: "exit_access",
      values: ["blocked", "clear"],
      spans: ["The exit is blocked.", "Exit A is clear."],
      report_ids: conflictFixture.report_ids,
    });
    expect(exportSnapshotCsv(snapshot)).toContain("exit_access: The exit is blocked. / Exit A is clear.");
  });

  it("keeps unread report IDs in incident membership order", () => {
    const incident = makeIncident({ report_ids: ["report-3", "report-1", "report-2"] });
    expect(unreadReportIds(incident, ["report-1"])).toEqual(["report-3", "report-2"]);
  });
});
