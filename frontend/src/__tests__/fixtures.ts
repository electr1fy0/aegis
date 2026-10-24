import type { Evaluation, Evidence, Incident, Report, Snapshot } from "../lib/types";

/** Small, explicit fixtures matching docs/API_CONTRACT.md. */

export const eventFixture = {
  id: "event-demo",
  name: "Aegis Campus Safety Exercise",
  timezone: "America/Los_Angeles",
  exercise: true,
  created_at: "2026-10-24T16:00:00Z",
  policy_version: "campus-v1",
};

export const zonesFixture = [
  { id: "stage", label: "Main Stage", x: 230, y: 180 },
  { id: "exit-a", label: "Exit A", x: 120, y: 430 },
  { id: "exit-b", label: "Exit B", x: 820, y: 430 },
  { id: "food", label: "Food Court", x: 720, y: 180 },
  { id: "registration", label: "Registration", x: 470, y: 430 },
  { id: "hall", label: "Exhibition Hall", x: 470, y: 180 },
];

export const reportFixture: Report = {
  id: "report-001",
  event_id: eventFixture.id,
  text: "A guest collapsed near the main stage and is not responding.",
  zone_id: "stage",
  sublocation: null,
  category: "medical",
  reported_at: "2026-10-24T16:02:00Z",
  received_at: "2026-10-24T16:02:04Z",
  analysis_status: "complete",
  incident_id: "incident-001",
  claims: [
    {
      field: "reported_condition",
      value: "unresponsive",
      span: "is not responding",
    },
  ],
  review_reasons: [],
};

export const matchingReportFixture = {
  ...reportFixture,
  id: "report-002",
  text: "Someone fainted by the stage and seems unconscious.",
  reported_at: "2026-10-24T16:03:00Z",
  received_at: "2026-10-24T16:03:05Z",
  claims: [],
};

export const evidenceFixture: Evidence = {
  report_id: "report-002",
  candidate_report_id: "report-001",
  semantic_score: 0.83,
  location_score: 1,
  time_score: 0.91,
  category_score: 0.8,
  total_score: 0.87,
  decision: "attach",
  reasons: ["Compatible medical reports", "Same zone"],
  missing_fields: [],
};

export const conflictFixture = {
  id: "conflict-001",
  field: "exit_access",
  report_ids: ["report-003", "report-004"],
  values: ["blocked", "clear"],
  spans: ["Exit A is blocked", "Exit A is clear now"],
  status: "unresolved",
  reason: "Reports describe different exit access conditions.",
};

export const incidentFixture: Incident = {
  id: "incident-001",
  event_id: eventFixture.id,
  title: "Guest collapsed near Main Stage",
  zone_id: "stage",
  priority: "P0",
  suggested_priority: "P0",
  priority_reason: "An unresponsive person was reported.",
  status: "open",
  review_required: false,
  review_reasons: [],
  report_ids: [reportFixture.id, "report-002"],
  evidence: [evidenceFixture],
  conflicts: [],
  version: 1,
  created_at: "2026-10-24T16:02:04Z",
  updated_at: "2026-10-24T16:02:04Z",
  override_reason: null,
};

export const auditFixture = {
  id: "audit-001",
  seq: 1,
  event_id: eventFixture.id,
  actor: "coordinator",
  action: "report.received",
  entity_id: reportFixture.id,
  reason: null,
  before: null,
  after: { report_id: reportFixture.id },
  created_at: "2026-10-24T16:02:04Z",
};

export const healthFixture = {
  status: "ready",
  engine: "semantic",
  model_ready: true,
  model_revision: "all-MiniLM-L6-v2",
};

export const replayFixture = {
  session_id: "session-demo",
  event_id: eventFixture.id,
  cursor: 2,
  total: 8,
  scenario: "demo",
};

export const snapshotFixture: Snapshot = {
  event: eventFixture,
  zones: zonesFixture,
  incidents: [incidentFixture],
  reports: [reportFixture, matchingReportFixture],
  audit: [auditFixture],
  counts: { reports: 2, incidents: 1, review: 0, conflicts: 0 },
  health: healthFixture,
  replay: replayFixture,
};

export const evaluationFixture: Evaluation = {
  dataset_version: "synthetic-v1",
  model: "all-MiniLM-L6-v2",
  config_version: "matching-v1",
  generated_at: "2026-10-24T16:00:00Z",
  results: [
    {
      method: "Lexical baseline",
      precision: 0.72,
      recall: 0.67,
      f1: 0.69,
      false_merges: 2,
      missed_pairs: 3,
      review_rate: 0.25,
    },
    {
      method: "Aegis",
      precision: 0.92,
      recall: 0.83,
      f1: 0.87,
      false_merges: 1,
      missed_pairs: 2,
      review_rate: 0.31,
    },
  ],
  checks: [{ name: "All reports retained", passed: true, detail: "144 / 144" }],
  latency: { p50_ms: 85, p95_ms: 220 },
  limitations: ["Synthetic English reports only."],
  failures: ["One ambiguous nearby report remained separate."],
};

export function makeReport(overrides: Partial<Report> = {}): Report {
  return { ...reportFixture, ...overrides };
}

export function makeIncident(overrides: Partial<Incident> = {}): Incident {
  return { ...incidentFixture, ...overrides };
}

export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return { ...snapshotFixture, ...overrides };
}

export function makeEvaluation(overrides: Partial<Evaluation> = {}): Evaluation {
  return { ...evaluationFixture, ...overrides };
}
