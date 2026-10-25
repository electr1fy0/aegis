import { MenuSelect } from "../components/ui/menu-select";
import { useEffect, useRef, useState } from "react";
import { ApiError, getEvaluation } from "../lib/api";
import type { Evaluation } from "../lib/types";
import { Button } from "../components/ui/button";
import "./evaluation-page.css";

type EvaluationState =
  | { status: "loading" }
  | { status: "error"; message: string; unavailable: boolean }
  | { status: "success"; data: Evaluation };

interface MetadataItemProps {
  label: string;
  value: string;
  detail?: string;
}

function MetadataItem({ label, value, detail }: MetadataItemProps) {
  return (
    <div className="evaluation-metadata-item">
      <dt>{label}</dt>
      <dd>{value || "Not reported"}</dd>
      {detail ? <dd className="evaluation-metadata-detail">{detail}</dd> : null}
    </div>
  );
}

function percent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? (value * 100).toFixed(1) + "%"
    : "Not measured";
}

function milliseconds(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(1) + " ms"
    : "Not measured";
}

function timestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value || "Not reported" : parsed.toLocaleString();
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
    return "The evaluation request was interrupted. Try again.";
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "The evaluation request was interrupted. Try again.";
  }
  if (error instanceof Error && error.message) return error.message;
  return "The evaluation could not be loaded. Try again.";
}

function aegisMethod(data: Evaluation): string {
  const method = data.results.find((result) => result.method.startsWith("Aegis"));
  return method?.method ?? "Aegis measurement unavailable";
}

function ResultTable({ data }: { data: Evaluation }) {
  if (data.results.length === 0) {
    return <p className="evaluation-empty">No measured grouping results are available for this run.</p>;
  }

  return (
    <div className="evaluation-table-wrap">
      <table className="evaluation-results-table">
        <caption className="sr-only">Measured report grouping results</caption>
        <thead>
          <tr>
            <th scope="col">Method</th>
            <th scope="col">Precision</th>
            <th scope="col">Recall</th>
            <th scope="col">F1</th>
            <th scope="col">False merge pairs</th>
            <th scope="col">Missed pairs</th>
            <th scope="col">Review rate</th>
          </tr>
        </thead>
        <tbody>
          {data.results.map((result, index) => (
            <tr key={result.method + "-" + index}>
              <th scope="row">
                <span>{result.method}</span>
                {result.method.toLowerCase().includes("lexical") ? (
                  <span className="evaluation-method-detail">
                    Lexical comparison; no semantic model result is implied.
                  </span>
                ) : null}
              </th>
              <td>{percent(result.precision)}</td>
              <td>{percent(result.recall)}</td>
              <td>{percent(result.f1)}</td>
              <td>{result.false_merges}</td>
              <td>{result.missed_pairs}</td>
              <td>{percent(result.review_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EvaluationDiagnostics({ data }: { data: Evaluation }) {
  const [kind, setKind] = useState("all");
  const examples = data.error_examples ?? [];
  const visible = examples.filter((example) => kind === "all" || example.kind === kind);
  return (
    <details className="evaluation-diagnostics">
      <summary>Review workload and grouping mistakes</summary>
      <div className="evaluation-diagnostics-content">
        {data.workload ? (
          <section aria-label="Estimated grouping review workload" className="evaluation-workload-section">
            <dl className="evaluation-workload">
              <div><dt>Reports flagged</dt><dd>{data.workload.review_reports} / {data.workload.reports}</dd></div>
              <div><dt>Group confirmations</dt><dd>{data.workload.confirmation_groups}</dd></div>
              <div><dt>Corrective splits</dt><dd>{data.workload.split_operations}</dd></div>
              <div><dt>Corrective merges</dt><dd>{data.workload.merge_operations}</dd></div>
            </dl>
            <p className="evaluation-workload-basis">{data.workload.basis}</p>
          </section>
        ) : <p className="evaluation-note">Review workload was not recorded for this run.</p>}
        <div className="evaluation-filter"><label htmlFor="grouping-mistake-type">
          Grouping mistake type
          </label><MenuSelect id="grouping-mistake-type" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="all">All mistakes</option>
            <option value="missed_pair">Missed pairs</option>
            <option value="false_merge">False merges</option>
          </MenuSelect></div>
        <p className="evaluation-note">Up to 40 actual pairwise mistakes from the Aegis result. Runtime errors are listed separately.</p>
        {visible.length ? visible.map((example) => (
          <details className="evaluation-example" key={example.report_ids.join(":")}>
            <summary>{example.kind === "missed_pair" ? "Missed pair" : "False merge"}: {example.report_ids.join(" / ")}</summary>
            <p className="evaluation-example-method">{example.method} · Expected {example.expected_same_incident ? "one incident" : "separate incidents"}; proposed {example.predicted_same_incident ? "one group" : "separate groups"}.</p>
            <div className="evaluation-example-texts">{example.texts.map((text, index) => <blockquote key={index}>{text}</blockquote>)}</div>
            <ul className="evaluation-example-reasons">{example.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
          </details>
        )) : <p className="evaluation-note">No recorded grouping mistakes match this filter.</p>}
      </div>
    </details>
  );
}

function EvaluationDetails({ data }: { data: Evaluation }) {
  const failedChecks = data.checks.filter((check) => !check.passed);
  const engineMethod = aegisMethod(data);

  return (
    <div className="evaluation-details">
      <section className="evaluation-section evaluation-run" aria-labelledby="evaluation-run-heading">
        <h2 id="evaluation-run-heading">Run details</h2>
        <dl className="evaluation-metadata">
            <MetadataItem label="Dataset version" value={data.dataset_version} />
            <MetadataItem label="Engine result" value={engineMethod} />
            <MetadataItem label="Model revision" value={data.model} />
            <MetadataItem label="Matching config" value={data.config_version} />
            <MetadataItem label="Generated" value={timestamp(data.generated_at)} />
            <MetadataItem
              label="Measured analysis latency"
              value={milliseconds(data.latency?.p50_ms) + " / " + milliseconds(data.latency?.p95_ms)}
              detail="p50 / p95 per report, including analysis and incremental grouping"
            />
        </dl>
      </section>

      <section className="evaluation-section" aria-labelledby="grouping-results-heading">
        <div className="evaluation-section-heading">
          <h2 id="grouping-results-heading">Grouping results</h2>
          <p>Pairwise report-grouping metrics. False merges and misses count report pairs.</p>
        </div>
        <ResultTable data={data} />
        <p className="evaluation-note evaluation-caution">
          Similarity scores are ranking signals, not probabilities. These synthetic results do not establish accuracy in real incidents.
        </p>
      </section>

      <EvaluationDiagnostics data={data} />

      <div className="evaluation-review-layout">
        <section className="evaluation-section" aria-labelledby="policy-checks-heading">
          <div className="evaluation-section-heading">
            <h2 id="policy-checks-heading">Policy and retention checks</h2>
            <p>The checks show whether this implementation meets each explicit fixture condition.</p>
          </div>
          {data.checks.length > 0 ? (
            <ul className="evaluation-check-list">
              {data.checks.map((check, index) => (
                <li key={check.name + "-" + index}>
                  <div>
                    <p className="evaluation-check-name">{check.name}</p>
                    <p className="evaluation-check-detail">{check.detail}</p>
                  </div>
                  <span className={`evaluation-check-status${check.passed ? " is-passed" : " is-failed"}`}>
                    {check.passed ? "Passed" : "Failed"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="evaluation-note">No checks were returned for this evaluation.</p>
          )}
        </section>

        <section className="evaluation-section evaluation-failures" aria-labelledby="known-failures-heading">
          <div className="evaluation-section-heading">
            <h2 id="known-failures-heading">Known failures</h2>
            <p>Failed fixture checks and runtime errors are shown separately.</p>
          </div>
          <section aria-labelledby="failed-checks-heading">
            <h3 id="failed-checks-heading">Checks that failed</h3>
            {failedChecks.length > 0 ? (
              <ul className="evaluation-plain-list">
                {failedChecks.map((check, index) => (
                  <li key={check.name + "-" + index}>
                    <span className="evaluation-failure-name">{check.name}:</span>{" "}
                    <span>{check.detail}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="evaluation-note">No fixture checks failed in this run.</p>
            )}
          </section>

          <section className="evaluation-runtime-errors" aria-labelledby="runtime-failures-heading">
            <h3 id="runtime-failures-heading">Runtime and analysis errors</h3>
            {data.failures.length > 0 ? (
              <ul className="evaluation-plain-list">
                {data.failures.map((failure, index) => <li key={index + "-" + failure}>{failure}</li>)}
              </ul>
            ) : (
              <p className="evaluation-note">No runtime or analysis errors were recorded.</p>
            )}
          </section>
        </section>
      </div>

      <section className="evaluation-section evaluation-limitations" aria-labelledby="limitations-heading">
        <div className="evaluation-section-heading">
          <h2 id="limitations-heading">Limitations</h2>
          <p>Interpret these measurements within the fixture set and active engine mode.</p>
        </div>
        {data.limitations.length > 0 ? (
          <ul className="evaluation-plain-list">
            {data.limitations.map((limitation, index) => <li key={index + "-" + limitation}>{limitation}</li>)}
          </ul>
        ) : (
          <p className="evaluation-note">No additional limitations were reported.</p>
        )}
      </section>
    </div>
  );
}

export function EvaluationPage() {
  const [state, setState] = useState<EvaluationState>({ status: "loading" });
  const [reloadCount, setReloadCount] = useState(0);
  const attemptId = useRef(0);

  useEffect(() => {
    let mounted = true;
    const currentAttempt = ++attemptId.current;
    setState({ status: "loading" });

    const loadEvaluation = async () => {
      try {
        const data = await getEvaluation();
        if (mounted && attemptId.current === currentAttempt) {
          setState({ status: "success", data });
        }
      } catch (error) {
        if (!mounted || attemptId.current !== currentAttempt) return;
        setState({
          status: "error",
          message: errorMessage(error),
          unavailable: error instanceof ApiError && error.status === 503,
        });
      }
    };

    void loadEvaluation();
    return () => {
      mounted = false;
      if (attemptId.current === currentAttempt) attemptId.current += 1;
    };
  }, [reloadCount]);

  const handleRetry = () => {
    attemptId.current += 1;
    setReloadCount((count) => count + 1);
  };

  return (
    <section aria-labelledby="evaluation-heading" className="evaluation-page">
      <div className="page-heading evaluation-page-heading">
        <div className="page-heading-copy">
          <h1 id="evaluation-heading">Evaluation</h1>
          <p className="page-subtitle">
            Measured grouping and policy checks for the fixed synthetic test set. The header shows whether semantic matching or lexical fallback is active.
          </p>
        </div>
        <Button
          aria-label={state.status === "error" ? "Retry evaluation" : "Refresh evaluation"}
          disabled={state.status === "loading"}
          onClick={handleRetry}
          variant="outline"
        >
          {state.status === "loading" ? "Loading evaluation…" : state.status === "error" ? "Retry" : "Refresh evaluation"}
        </Button>
      </div>

      {state.status === "loading" ? (
        <div aria-live="polite" className="evaluation-status" role="status">
          Loading measured evaluation results…
        </div>
      ) : null}

      {state.status === "error" ? (
        <section aria-live="assertive" className="evaluation-status is-error" role="alert">
          <div className="evaluation-status-heading">
            <h2>{state.unavailable ? "Evaluation unavailable" : "Could not load evaluation"}</h2>
            {state.unavailable ? <span>503 · Not measured</span> : null}
          </div>
          <p>{state.message}</p>
          <p>Retry after the backend has an available evaluation result.</p>
        </section>
      ) : null}

      {state.status === "success" ? <EvaluationDetails data={state.data} /> : null}
    </section>
  );
}
