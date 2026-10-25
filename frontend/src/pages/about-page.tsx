import { Link } from "@tanstack/react-router";
import { Button } from "../components/ui/button";
import "./about-page.css";

const reviewSteps = [
  {
    title: "Receive and retain",
    copy: "Each report is stored with its original wording and receipt time before analysis. A failed analysis remains visible for coordinator follow-up.",
  },
  {
    title: "Compare evidence",
    copy: "Candidate groups show text, location, time, and category signals. Missing context and conflicting claims stay beside the source reports.",
  },
  {
    title: "Review the grouping",
    copy: "A coordinator can confirm, reject, move, merge, or split reports. Changes use current incident versions and enter the audit trail.",
  },
  {
    title: "Record a decision",
    copy: "Priority and status overrides require a reason. Stale versions are rejected so the coordinator can review the latest snapshot first.",
  },
];

export function AboutPage() {
  return (
    <section className="about-page" aria-labelledby="about-page-title">
      <div className="page-heading about-page-heading">
        <div className="page-heading-copy">
          <h1 id="about-page-title">About Aegis</h1>
          <p className="page-subtitle">
            Aegis stores synthetic exercise reports, suggests related reports for review, and records coordinator decisions.
          </p>
        </div>
        <div className="heading-actions">
          <Button variant="outline" render={<Link to="/dashboard" />} nativeButton={false}>Operations</Button>
          <Button render={<Link to="/report" />} nativeButton={false}>New report</Button>
        </div>
      </div>

      <div className="about-layout">
        <section className="about-section about-workflow" aria-labelledby="workflow-heading">
          <h2 id="workflow-heading">How review works</h2>
          <ol className="about-steps">
            {reviewSteps.map((step) => (
              <li key={step.title}>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
              </li>
            ))}
          </ol>
        </section>

        <div className="about-sidebar">
          <section className="about-section" aria-labelledby="records-heading">
            <h2 id="records-heading">What the system records</h2>
            <ul className="about-capabilities">
              <li>Original reports and their analysis state.</li>
              <li>Candidate evidence and unresolved conflicting claims.</li>
              <li>Reasons for coordinator overrides.</li>
              <li>Review actions in an append-only audit history.</li>
            </ul>
          </section>

          <section className="about-section about-scope" aria-labelledby="scope-heading">
            <h2 id="scope-heading">Scope and evaluation</h2>
            <p>
              This is a synthetic exercise with illustrative zones. It does not contact emergency services, send messages, dispatch responders, or provide a real-world safety map.
            </p>
            <p>
              Similarity scores are ranking aids, not probabilities or verified facts. Evaluation results show measured behavior on the synthetic test set; unavailable results are not replaced with examples.
            </p>
            <Link className="about-evaluation-link" to="/evaluation">View evaluation results</Link>
          </section>
        </div>
      </div>
    </section>
  );
}
