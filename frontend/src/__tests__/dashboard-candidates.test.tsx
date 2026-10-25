// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelatedGroups } from "../components/dashboard-candidates";
import type { Evidence, Incident, Snapshot } from "../lib/types";
import {
  evidenceFixture,
  eventFixture,
  makeIncident,
  makeReport,
  makeSnapshot,
  zonesFixture,
} from "./fixtures";

interface RelatedScenario {
  snapshot: Snapshot;
  selected: Incident;
  candidate: Incident;
}

function comparison(
  reportId: string,
  candidateReportId: string,
  overrides: Partial<Evidence> = {},
): Evidence {
  return {
    ...evidenceFixture,
    report_id: reportId,
    candidate_report_id: candidateReportId,
    decision: "suggest",
    total_score: 0.91,
    reasons: ["Shared location"],
    missing_fields: [],
    created_at: "2026-10-24T17:05:00Z",
    ...overrides,
  };
}

function relatedScenario(options: {
  evidence?: Evidence[];
  omitSelectedReport?: boolean;
  selectedReports?: { id: string; displayId: string; text: string; zoneId: string | null; sublocation: string | null; reportedAt: string | null }[];
  candidateReports?: { id: string; displayId: string; text: string; zoneId: string | null; sublocation: string | null; reportedAt: string | null }[];
} = {}): RelatedScenario {
  const selectedRows = options.selectedReports ?? [
    {
      id: "selected-report-1",
      displayId: "RPT-21",
      text: "A guest reported a medical incident by the north gate.",
      zoneId: "stage",
      sublocation: "north gate",
      reportedAt: "2026-10-24T17:01:00Z",
    },
  ];
  const candidateRows = options.candidateReports ?? [
    {
      id: "candidate-report-1",
      displayId: "RPT-34",
      text: "Another account describes the same event near the north gate.",
      zoneId: "stage",
      sublocation: "north gate",
      reportedAt: "2026-10-24T17:02:00Z",
    },
  ];
  const selectedId = "incident-selected";
  const candidateId = "incident-candidate";
  const selectedReports = selectedRows.map((row) => makeReport({
    id: row.id,
    display_id: row.displayId,
    event_id: eventFixture.id,
    incident_id: selectedId,
    text: row.text,
    zone_id: row.zoneId,
    sublocation: row.sublocation,
    reported_at: row.reportedAt,
    received_at: "2026-10-24T17:03:00Z",
  }));
  const candidateReports = candidateRows.map((row) => makeReport({
    id: row.id,
    display_id: row.displayId,
    event_id: eventFixture.id,
    incident_id: candidateId,
    text: row.text,
    zone_id: row.zoneId,
    sublocation: row.sublocation,
    reported_at: row.reportedAt,
    received_at: "2026-10-24T17:04:00Z",
  }));
  const selected = makeIncident({
    id: selectedId,
    display_id: "INC-21",
    event_id: eventFixture.id,
    title: "Selected group near the stage",
    zone_id: "stage",
    report_ids: selectedRows.map((row) => row.id),
    evidence: options.evidence ?? [comparison(selectedRows[0]!.id, candidateRows[0]!.id)],
  });
  const candidate = makeIncident({
    id: candidateId,
    display_id: "INC-34",
    event_id: eventFixture.id,
    title: "Possible north gate incident",
    zone_id: "stage",
    report_ids: candidateRows.map((row) => row.id),
    evidence: [],
  });
  const reports = [
    ...(options.omitSelectedReport ? selectedReports.slice(1) : selectedReports),
    ...candidateReports,
  ];
  const snapshot = makeSnapshot({
    event: eventFixture,
    zones: zonesFixture,
    incidents: [selected, candidate],
    reports,
  });
  return { snapshot, selected, candidate };
}

function renderRelated({ snapshot, selected }: RelatedScenario, onSelect = vi.fn()) {
  render(<RelatedGroups snapshot={snapshot} incident={selected} onSelect={onSelect} />);
  return onSelect;
}

describe("RelatedGroups", () => {
  afterEach(() => cleanup());

  it("explains when no cross-group evidence links a candidate", () => {
    const scenario = relatedScenario({
      evidence: [comparison("selected-report-1", "candidate-report-1", { decision: "separate" })],
    });

    renderRelated(scenario);

    expect(screen.getByRole("region", { name: "Related groups" })).toBeInTheDocument();
    expect(screen.getByText("No cross-group pairwise comparison is available. Groups are not linked by location alone.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open group" })).not.toBeInTheDocument();
  });

  it("shows the highest-ranked real report pair with stable IDs, source context, and opens that group", async () => {
    const scenario = relatedScenario({
      evidence: [
        comparison("selected-report-1", "candidate-report-1", {
          total_score: 0.94,
          reasons: ["The accounts share a described event."],
          created_at: "2026-10-24T17:05:00Z",
        }),
        comparison("selected-report-1", "candidate-report-2", {
          total_score: 0.73,
          reasons: ["A lower-ranked historical comparison."],
        }),
      ],
      candidateReports: [
        {
          id: "candidate-report-1",
          displayId: "RPT-34",
          text: "Another account describes the same event near the north gate.",
          zoneId: "stage",
          sublocation: "north gate",
          reportedAt: "2026-10-24T17:02:00Z",
        },
        {
          id: "candidate-report-2",
          displayId: "RPT-35",
          text: "A different report refers to an unrelated entrance.",
          zoneId: "exit-a",
          sublocation: "south doors",
          reportedAt: "2026-10-24T17:08:00Z",
        },
      ],
    });
    const onSelect = vi.fn();
    const user = userEvent.setup();

    renderRelated(scenario, onSelect);

    const card = screen.getByText("Possible north gate incident").closest(".candidate-card");
    expect(card).not.toBeNull();
    const candidate = within(card as HTMLElement);
    expect(candidate.getByText("0.94")).toBeInTheDocument();
    expect(candidate.getByText("RPT-21")).toBeInTheDocument();
    expect(candidate.getByText("RPT-34")).toBeInTheDocument();
    expect(candidate.getByText("A guest reported a medical incident by the north gate.")).toBeInTheDocument();
    expect(candidate.getByText("Another account describes the same event near the north gate.")).toBeInTheDocument();
    expect(candidate.getAllByText(/Main Stage · north gate/)).toHaveLength(2);
    expect(candidate.getByText("2 historical comparisons with this group")).toBeInTheDocument();
    expect(candidate.getByText("The accounts share a described event.")).toBeInTheDocument();
    expect(candidate.queryByText("A lower-ranked historical comparison.")).not.toBeInTheDocument();

    await user.click(candidate.getByRole("button", { name: "Open group" }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(scenario.candidate.id);
  });

  it("shows unknown timing and location plus missing context from the chosen comparison", () => {
    const scenario = relatedScenario({
      selectedReports: [{
        id: "selected-report-1",
        displayId: "RPT-21",
        text: "A report with no stated time or location.",
        zoneId: null,
        sublocation: null,
        reportedAt: null,
      }],
      candidateReports: [{
        id: "candidate-report-1",
        displayId: "RPT-34",
        text: "Another report with no stated time or location.",
        zoneId: null,
        sublocation: null,
        reportedAt: null,
      }],
      evidence: [comparison("selected-report-1", "candidate-report-1", {
        reasons: ["Both reports lack time and specific location."],
        missing_fields: ["time", "sublocation"],
      })],
    });

    renderRelated(scenario);

    const card = screen.getByText("Possible north gate incident").closest(".candidate-card");
    expect(card).not.toBeNull();
    const candidate = within(card as HTMLElement);
    expect(candidate.getAllByText(/Occurred time unknown/)).toHaveLength(2);
    expect(candidate.getAllByText(/Unlocated/).length).toBeGreaterThan(0);
    expect(candidate.getByText("Missing context: time, sublocation")).toBeInTheDocument();
  });

  it("identifies candidate signals as historical and membership as current", () => {
    const scenario = relatedScenario({
      evidence: [comparison("selected-report-1", "candidate-report-1", {
        created_at: "2026-10-24T17:05:00Z",
      })],
    });

    renderRelated(scenario);

    expect(screen.getByText("Historical comparisons · not probabilities")).toBeInTheDocument();
    expect(screen.getByText("Historical match signals are shown with the source text and current group membership. A score is a ranking signal, not a probability.")).toBeInTheDocument();
    expect(screen.getByText("Selected group · current membership")).toBeInTheDocument();
    expect(screen.getByText("Other group · current membership")).toBeInTheDocument();
  });

  it("reports plural historical comparisons when several signals support a group", () => {
    const scenario = relatedScenario({
      selectedReports: [
        { id: "selected-report-1", displayId: "RPT-21", text: "Selected account one.", zoneId: "stage", sublocation: null, reportedAt: null },
        { id: "selected-report-2", displayId: "RPT-22", text: "Selected account two.", zoneId: "stage", sublocation: null, reportedAt: null },
      ],
      candidateReports: [
        { id: "candidate-report-1", displayId: "RPT-34", text: "Candidate account one.", zoneId: "stage", sublocation: null, reportedAt: null },
        { id: "candidate-report-2", displayId: "RPT-35", text: "Candidate account two.", zoneId: "stage", sublocation: null, reportedAt: null },
      ],
      evidence: [
        comparison("selected-report-1", "candidate-report-1", { total_score: 0.92 }),
        comparison("selected-report-2", "candidate-report-2", { total_score: 0.81, reasons: ["A second pairwise signal."] }),
      ],
    });

    renderRelated(scenario);

    const card = screen.getByText("Possible north gate incident").closest(".candidate-card");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("2 historical comparisons with this group")).toBeInTheDocument();
  });

  it("uses full report IDs and omits the notes panel for legacy evidence without optional notes", () => {
    const scenario = relatedScenario({
      evidence: [comparison("selected-report-1", "candidate-report-1", {
        reasons: [],
        missing_fields: [],
        created_at: null,
      })],
    });
    scenario.snapshot.reports.forEach((report) => { delete report.display_id; });

    renderRelated(scenario);

    const card = screen.getByText("Possible north gate incident").closest(".candidate-card");
    expect(card).not.toBeNull();
    const candidate = within(card as HTMLElement);
    expect(candidate.getByText("selected-report-1")).toBeInTheDocument();
    expect(candidate.getByText("candidate-report-1")).toBeInTheDocument();
    expect(candidate.queryByText("Signals for the best historical pair")).not.toBeInTheDocument();
    expect(card?.querySelector(".candidate-reasons")).toBeNull();
  });

  it("keeps an evidence-linked candidate readable when report ownership metadata is inconsistent", () => {
    const scenario = relatedScenario();
    scenario.candidate.report_ids = [];

    renderRelated(scenario);

    const card = screen.getByText("Possible north gate incident").closest(".candidate-card");
    expect(card).not.toBeNull();
    const candidate = within(card as HTMLElement);
    expect(candidate.getByText("RPT-34")).toBeInTheDocument();
    expect(candidate.getByText("Another account describes the same event near the north gate.")).toBeInTheDocument();
  });

  it("safely explains when a selected-group source report is missing from the snapshot", () => {
    const scenario = relatedScenario({
      selectedReports: [{
        id: "removed-selected-report",
        displayId: "RPT-21",
        text: "This source is no longer in the snapshot.",
        zoneId: "stage",
        sublocation: null,
        reportedAt: null,
      }],
      candidateReports: [{
        id: "candidate-report-1",
        displayId: "RPT-34",
        text: "Candidate report remains available.",
        zoneId: "stage",
        sublocation: null,
        reportedAt: null,
      }],
      evidence: [comparison("removed-selected-report", "candidate-report-1")],
      omitSelectedReport: true,
    });

    renderRelated(scenario);

    const card = screen.getByText("Possible north gate incident").closest(".candidate-card");
    expect(card).not.toBeNull();
    const candidate = within(card as HTMLElement);
    expect(candidate.getByText("Source report is no longer present in this snapshot.")).toBeInTheDocument();
    expect(candidate.getByText("Candidate report remains available.")).toBeInTheDocument();
  });
});
