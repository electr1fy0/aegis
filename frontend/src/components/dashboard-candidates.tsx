import { IconArrowsExchange, IconClock, IconMapPin } from "@tabler/icons-react";
import { Button } from "./ui/button";
import { formatAge, formatEventAge, reportTextPreview, zoneLabel } from "../lib/format";
import { relatedCandidates } from "../lib/dashboard-model";
import type { Incident, Snapshot } from "../lib/types";

function CandidateReport({
  reportId,
  reports,
  zones,
}: {
  reportId: string;
  reports: Snapshot["reports"];
  zones: Snapshot["zones"];
}) {
  const report = reports.find((item) => item.id === reportId);
  if (!report) return <p className="candidate-report-missing">Source report is no longer present in this snapshot.</p>;
  return (
    <div className="candidate-report">
      <span className="candidate-report-id">{report.display_id ?? report.id}</span>
      <p>{reportTextPreview(report.text, 190)}</p>
      <span className="candidate-report-meta">
        <span><IconClock size={13} />Occurred {report.reported_at ? formatEventAge(report.reported_at) : "time unknown"} · received {formatAge(report.received_at)}</span>
        <span><IconMapPin size={13} />{zoneLabel(report.zone_id, zones)}{report.sublocation ? ` · ${report.sublocation}` : ""}</span>
      </span>
    </div>
  );
}

export function RelatedGroups({
  snapshot,
  incident,
  onSelect,
}: {
  snapshot: Snapshot;
  incident: Incident;
  onSelect: (incidentId: string) => void;
}) {
  const candidates = relatedCandidates(snapshot, incident, 3);
  return (
    <section className="inspector-section related-groups" aria-labelledby="related-heading">
      <div className="inspector-section-heading">
        <h3 id="related-heading">Related groups</h3>
        <span className="panel-meta">Historical comparisons · not probabilities</span>
      </div>
      {candidates.length === 0 ? (
        <p className="action-note">No cross-group pairwise comparison is available. Groups are not linked by location alone.</p>
      ) : (
        <div className="candidate-list">
          <p className="candidate-history-note">Historical match signals are shown with the source text and current group membership. A score is a ranking signal, not a probability.</p>
          {candidates.map((candidate) => {
            const selectedReport = candidate.reportPair.find((id) => incident.report_ids.includes(id))!;
            const otherReport = candidate.reportPair.find((id) => candidate.incident.report_ids.includes(id)) ?? candidate.reportPair[1];
            const otherIsCurrentMember = candidate.incident.report_ids.includes(otherReport);
            const missing = candidate.missingFields.length > 0;
            return (
              <article className="candidate-card" key={candidate.incident.id}>
                <div className="candidate-header">
                  <div className="candidate-title-copy">
                    <strong>{candidate.incident.title}</strong>
                    <span>{zoneLabel(candidate.incident.zone_id, snapshot.zones)}</span>
                    <span className="historical-label">{candidate.evidenceCount} historical comparison{candidate.evidenceCount === 1 ? "" : "s"} with this group</span>
                  </div>
                  <span className="candidate-score" aria-label={`Ranking score ${candidate.score.toFixed(2)}`}>{candidate.score.toFixed(2)}</span>
                </div>
                <div className="candidate-compare" aria-label={`Side-by-side report comparison for ${candidate.incident.title}`}>
                  <div><span className="compare-side-label">Selected group · current membership</span><CandidateReport reportId={selectedReport} reports={snapshot.reports} zones={snapshot.zones} /></div>
                  <div><span className="compare-side-label">{otherIsCurrentMember ? "Other group · current membership" : "Other group · historical pair; membership changed"}</span><CandidateReport reportId={otherReport} reports={snapshot.reports} zones={snapshot.zones} /></div>
                </div>
                {(candidate.reasons.length > 0 || missing) && (
                  <div className="candidate-reasons">
                    <span className="historical-label">Signals for the best historical pair</span>
                    {candidate.reasons.slice(0, 3).map((reason, index) => <span key={`${candidate.incident.id}-${index}`}>{reason}</span>)}
                    {missing && <span className="candidate-missing">Missing context: {candidate.missingFields.join(", ")}</span>}
                  </div>
                )}
                <div className="candidate-footer">
                  <span>Ranking signal · not a probability</span>
                  <Button size="xs" variant="outline" onClick={() => onSelect(candidate.incident.id)}><IconArrowsExchange />Open group</Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
