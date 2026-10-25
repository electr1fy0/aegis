export type Priority = "P0" | "P1" | "P2" | "UNASSESSED";
export type IncidentStatus = "open" | "acknowledged" | "monitoring" | "resolved";
export type AnalysisStatus = "complete" | "pending" | "failed";
export type EvidenceDecision = "attach" | "suggest" | "separate";

export interface EventInfo {
  id: string;
  name: string;
  timezone: string;
  exercise: boolean;
  created_at: string;
  policy_version: string;
}

export interface Zone {
  selectable?: boolean;
  id: string;
  label: string;
  x: number;
  y: number;
}

export interface Claim {
  field: string;
  value: string;
  span: string;
}

export interface Report {
  id: string;
  display_id?: string | null;
  event_id: string;
  text: string;
  zone_id: string | null;
  sublocation: string | null;
  category: string | null;
  reported_at: string | null;
  received_at: string;
  analysis_status: AnalysisStatus;
  incident_id: string;
  claims: Claim[];
  review_reasons: string[];
  model_revision?: string | null;
  confirmed?: boolean;
}

export interface Evidence {
  report_id: string;
  candidate_report_id: string;
  semantic_score: number | null;
  location_score: number | null;
  time_score: number | null;
  category_score: number | null;
  total_score: number | null;
  decision: EvidenceDecision;
  reasons: string[];
  missing_fields: string[];
  created_at?: string | null;
}

export interface CoordinatorNote {
  id: string;
  text: string;
  actor: string;
  created_at: string;
}

export interface UndoableAction {
  audit_id: string;
  incident_id: string;
  action: string;
  expected_version: number;
}

export interface Conflict {
  id: string;
  field: string;
  report_ids: string[];
  values: string[];
  spans: string[];
  status: "unresolved" | "resolved";
  reason: string;
}

export interface Incident {
  id: string;
  display_id?: string | null;
  event_id: string;
  title: string;
  zone_id: string | null;
  priority: Priority;
  suggested_priority: Priority;
  priority_reason: string;
  status: IncidentStatus;
  review_required: boolean;
  review_reasons: string[];
  report_ids: string[];
  evidence: Evidence[];
  conflicts: Conflict[];
  version: number;
  created_at: string;
  updated_at: string;
  override_reason: string | null;
  notes?: CoordinatorNote[];
  original_title?: string | null;
  title_override?: boolean;
}

export interface AuditEntry {
  id: string;
  seq: number;
  event_id: string;
  actor: string;
  action: string;
  entity_id: string;
  reason: string | null;
  before: unknown;
  after: unknown;
  created_at: string;
}

export interface Health {
  status: string;
  engine: string;
  model_ready: boolean;
  model_revision: string | null;
}

export interface Replay {
  session_id: string;
  event_id: string;
  cursor: number;
  total: number;
  scenario: string;
}

export interface SnapshotCounts {
  reports: number;
  incidents: number;
  review: number;
  conflicts: number;
}

export interface Snapshot {
  event: EventInfo;
  zones: Zone[];
  incidents: Incident[];
  reports: Report[];
  audit: AuditEntry[];
  counts: SnapshotCounts;
  health: Health;
  replay: Replay | null;
  undoable_actions?: UndoableAction[];
}

export interface EvaluationResult {
  method: string;
  precision: number;
  recall: number;
  f1: number;
  false_merges: number;
  missed_pairs: number;
  review_rate: number;
}

export interface EvaluationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface Evaluation {
  dataset_version: string;
  model: string;
  config_version: string;
  generated_at: string;
  results: EvaluationResult[];
  checks: EvaluationCheck[];
  latency: { p50_ms: number; p95_ms: number };
  limitations: string[];
  failures: string[];
  error_examples?: EvaluationErrorExample[];
  workload?: EvaluationWorkload;
}

export interface EvaluationErrorExample {
  kind: "missed_pair" | "false_merge";
  method: string;
  report_ids: [string, string];
  texts: [string, string];
  expected_same_incident: boolean;
  predicted_same_incident: boolean;
  reasons: string[];
}

export interface EvaluationWorkload {
  reports: number;
  review_reports: number;
  proposed_groups: number;
  confirmation_groups: number;
  split_operations: number;
  merge_operations: number;
  basis: string;
}

export type GroupingAction = "confirm" | "reject" | "move" | "merge" | "split";

export interface GroupingReviewInput {
  action: GroupingAction;
  report_ids: string[];
  incident_ids?: string[];
  target_incident_id?: string;
  reason: string;
  expected_versions: Record<string, number>;
}

export interface PriorityInput {
  priority: Priority;
  reason: string;
  expected_version: number;
}

export interface StatusInput {
  status: IncidentStatus;
  reason: string;
  expected_version: number;
}

export interface ConflictReviewInput {
  status: "unresolved" | "resolved";
  reason: string;
  expected_version: number;
}

export interface ReportInput {
  text: string;
  zone_id?: string;
  sublocation?: string;
  reported_at?: string;
  idempotency_key: string;
  source?: "form" | "replay";
  event_id?: string;
}

export interface ReportReceipt {
  report: Report;
  incident: Incident;
  duplicate: boolean;
}

export interface CurrentEvent {
  event: EventInfo;
  zones: Zone[];
}
