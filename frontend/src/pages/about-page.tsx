import { Link } from "@tanstack/react-router";
import { IconAlertTriangle, IconCheck, IconHistory, IconMessageCircle, IconShieldCheck } from "@tabler/icons-react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";

const reviewSteps = [
  {
    title: "Receive and retain",
    copy: "Each report is stored with its original wording and receipt time before analysis. A failed analysis remains visible for coordinator follow-up.",
  },
  {
    title: "Compare evidence",
    copy: "Candidate groups show separate text, location, time, and category signals. Missing context and conflicting claims stay visible beside the source reports.",
  },
  {
    title: "Review the grouping",
    copy: "A coordinator can confirm, reject, move, merge, or split reports. Changes use the current incident versions and are written to the audit trail.",
  },
  {
    title: "Record a decision",
    copy: "Priority and status overrides require a reason. A stale version is rejected so the coordinator can review the latest snapshot before retrying.",
  },
];

export function AboutPage() {
  return (
    <>
      <div className="page-heading">
        <div className="page-heading-copy">
          <span className="eyebrow">System overview</span>
          <h1>Designed for review, not autopilot</h1>
          <p className="page-subtitle">Aegis organizes synthetic exercise reports so a human coordinator can inspect the evidence and record the next decision.</p>
        </div>
        <div className="heading-actions">
          <Button variant="outline" render={<Link to="/dashboard" />} nativeButton={false}><IconHistory />Open operations</Button>
          <Button render={<Link to="/report" />} nativeButton={false}><IconMessageCircle />Submit a report</Button>
        </div>
      </div>

      <div className="about-grid">
        <section className="about-card cn-card" aria-labelledby="workflow-heading">
          <div className="about-card-heading">
            <div>
              <span className="eyebrow">Coordinator workflow</span>
              <h2 id="workflow-heading">From report to reviewable action</h2>
            </div>
            <Badge variant="secondary">Human controlled</Badge>
          </div>
          <ol className="method-list">
            {reviewSteps.map((step) => (
              <li key={step.title}>
                <span><strong>{step.title}.</strong> {step.copy}</span>
              </li>
            ))}
          </ol>
          <div className="about-callout">
            <IconAlertTriangle aria-hidden="true" />
            <span>Grouping and similarity scores are ranking aids. They are not probabilities, verified facts, or a substitute for coordinator judgment.</span>
          </div>
        </section>

        <div>
          <section className="about-card cn-card" aria-labelledby="boundaries-heading">
            <div className="about-card-heading">
              <div>
                <span className="eyebrow">Scope and boundaries</span>
                <h2 id="boundaries-heading">What this system does</h2>
              </div>
              <IconShieldCheck className="about-heading-icon" aria-hidden="true" />
            </div>
            <ul className="feature-list">
              <li><IconCheck aria-hidden="true" /><span>Stores the original report alongside its analysis state.</span></li>
              <li><IconCheck aria-hidden="true" /><span>Shows candidate evidence and unresolved conflicting claims.</span></li>
              <li><IconCheck aria-hidden="true" /><span>Requires a reason for coordinator overrides.</span></li>
              <li><IconCheck aria-hidden="true" /><span>Records review actions in an append-only audit history.</span></li>
            </ul>
            <div className="about-callout about-callout-neutral">
              <span>This app uses synthetic exercise data and illustrative zones. It does not contact emergency services, send messages, dispatch responders, or provide a real-world safety map.</span>
            </div>
          </section>

          <section className="about-card cn-card" aria-labelledby="engine-heading">
            <div className="about-card-heading">
              <div>
                <span className="eyebrow">Model transparency</span>
                <h2 id="engine-heading">Measured behavior is visible</h2>
              </div>
              <Badge variant="outline">Local exercise</Badge>
            </div>
            <p>The header reports the backend engine state. Evaluation results come from executable synthetic regression checks; when they are unavailable, Aegis shows that state instead of filling in sample results.</p>
            <p>The evaluation page includes model and dataset revisions, pairwise grouping metrics, policy checks, latency, and known limitations.</p>
            <Link className="about-inline-link" to="/evaluation">Review measured evaluation <span aria-hidden="true">→</span></Link>
          </section>
        </div>
      </div>

      <p className="about-footer">Aegis is a local, synthetic exercise workspace. Confirm every material conclusion with the source report and current coordinator context.</p>
    </>
  );
}
