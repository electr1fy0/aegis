import { useEffect, useRef, useState } from "react";
import { ApiError, getEvaluation } from "../lib/api";
import type { Evaluation } from "../lib/types";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";

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
    <div className="min-w-0 space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="break-words text-sm font-medium text-foreground">{value || "Not reported"}</p>
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
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
    return (
      <p className="rounded-md border border-border bg-background p-4 text-sm text-muted-foreground">
        No measured grouping results are available for this run.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[820px] border-collapse text-left text-sm">
        <caption className="sr-only">Measured report grouping results</caption>
        <thead className="bg-muted/60 text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium" scope="col">Method</th>
            <th className="px-3 py-3 text-right font-medium" scope="col">Precision</th>
            <th className="px-3 py-3 text-right font-medium" scope="col">Recall</th>
            <th className="px-3 py-3 text-right font-medium" scope="col">F1</th>
            <th className="px-3 py-3 text-right font-medium" scope="col">False merge pairs</th>
            <th className="px-3 py-3 text-right font-medium" scope="col">Missed pairs</th>
            <th className="px-4 py-3 text-right font-medium" scope="col">Review rate</th>
          </tr>
        </thead>
        <tbody>
          {data.results.map((result, index) => (
            <tr className="border-t border-border align-top" key={result.method + "-" + index}>
              <th className="px-4 py-3 font-medium text-foreground" scope="row">
                <span>{result.method}</span>
                {result.method.toLowerCase().includes("lexical") ? (
                  <span className="mt-1 block text-xs font-normal text-muted-foreground">
                    Lexical comparison; no semantic model result is implied.
                  </span>
                ) : null}
              </th>
              <td className="px-3 py-3 text-right tabular-nums">{percent(result.precision)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{percent(result.recall)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{percent(result.f1)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{result.false_merges}</td>
              <td className="px-3 py-3 text-right tabular-nums">{result.missed_pairs}</td>
              <td className="px-4 py-3 text-right tabular-nums">{percent(result.review_rate)}</td>
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
    <details className="rounded-lg border border-border bg-card p-4">
      <summary className="cursor-pointer text-sm font-semibold">Review workload and grouping mistakes</summary>
      <div className="mt-4 space-y-4">
        {data.workload ? (
          <section aria-label="Estimated grouping review workload" className="space-y-3">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div><dt className="text-xs text-muted-foreground">Reports flagged</dt><dd>{data.workload.review_reports} / {data.workload.reports}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Group confirmations</dt><dd>{data.workload.confirmation_groups}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Corrective splits</dt><dd>{data.workload.split_operations}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Corrective merges</dt><dd>{data.workload.merge_operations}</dd></div>
            </dl>
            <p className="text-xs leading-5 text-muted-foreground">{data.workload.basis}</p>
          </section>
        ) : <p className="text-sm text-muted-foreground">Review workload was not recorded for this run.</p>}
        <label className="flex flex-wrap items-center gap-3 text-sm">
          Grouping mistake type
          <select className="rounded-md border border-border bg-background p-2" value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="all">All mistakes</option>
            <option value="missed_pair">Missed pairs</option>
            <option value="false_merge">False merges</option>
          </select>
        </label>
        <p className="text-xs text-muted-foreground">Up to 40 actual pairwise mistakes from the Aegis result. Runtime errors are listed separately.</p>
        {visible.length ? visible.map((example) => (
          <details className="rounded-md border border-border p-3" key={example.report_ids.join(":")}>
            <summary className="cursor-pointer text-sm">{example.kind === "missed_pair" ? "Missed pair" : "False merge"}: {example.report_ids.join(" / ")}</summary>
            <p className="my-2 text-xs text-muted-foreground">{example.method} · Expected {example.expected_same_incident ? "one incident" : "separate incidents"}; proposed {example.predicted_same_incident ? "one group" : "separate groups"}.</p>
            <div className="grid gap-3 sm:grid-cols-2">{example.texts.map((text, index) => <blockquote className="border-l-2 border-border pl-3 text-sm" key={index}>{text}</blockquote>)}</div>
            <ul className="mt-3 space-y-1 text-xs text-muted-foreground">{example.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
          </details>
        )) : <p className="text-sm text-muted-foreground">No recorded grouping mistakes match this filter.</p>}
      </div>
    </details>
  );
}

function EvaluationDetails({ data }: { data: Evaluation }) {
  const failedChecks = data.checks.filter((check) => !check.passed);
  const engineMethod = aegisMethod(data);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Card className="border-border bg-card">
          <CardContent className="grid gap-4 p-4 sm:grid-cols-2">
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
          </CardContent>
        </Card>

        <Card className="border-border bg-card xl:col-span-2">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Grouping results</CardTitle>
              <Badge variant="secondary">Synthetic regression set</Badge>
            </div>
            <CardDescription>
              Pairwise report-grouping metrics. False merges and misses count report pairs.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResultTable data={data} />
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Similarity scores are ranking signals, not probabilities. These synthetic results do not establish
              accuracy in real incidents.
            </p>
          </CardContent>
        </Card>
      </div>

      <EvaluationDiagnostics data={data} />

      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="border-border bg-card">
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Policy and retention checks</CardTitle>
              <Badge variant="secondary">{data.checks.length} checks</Badge>
            </div>
            <CardDescription>
              The checks show whether the current implementation meets each explicit fixture condition.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.checks.length > 0 ? (
              <ul className="divide-y divide-border">
                {data.checks.map((check, index) => (
                  <li className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0" key={check.name + "-" + index}>
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-medium text-foreground">{check.name}</p>
                      <p className="text-xs leading-5 text-muted-foreground">{check.detail}</p>
                    </div>
                    <Badge variant={check.passed ? "secondary" : "destructive"}>
                      {check.passed ? "Passed" : "Failed"}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No checks were returned for this evaluation.</p>
            )}
          </CardContent>
        </Card>

        <Card className="border-border bg-card">
          <CardHeader>
            <CardTitle>Known failures</CardTitle>
            <CardDescription>
              Failed fixture checks and runtime errors are shown separately so a successful load cannot hide a miss.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <section aria-labelledby="failed-checks-heading" className="space-y-2">
              <h3 className="text-xs font-semibold text-foreground" id="failed-checks-heading">
                Checks that failed
              </h3>
              {failedChecks.length > 0 ? (
                <ul className="list-disc space-y-2 pl-5 text-sm text-foreground">
                  {failedChecks.map((check, index) => (
                    <li key={check.name + "-" + index}>
                      <span className="font-medium">{check.name}:</span>{" "}
                      <span className="text-muted-foreground">{check.detail}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No fixture checks failed in this run.</p>
              )}
            </section>

            <section aria-labelledby="runtime-failures-heading" className="space-y-2 border-t border-border pt-4">
              <h3 className="text-xs font-semibold text-foreground" id="runtime-failures-heading">
                Runtime and analysis errors
              </h3>
              {data.failures.length > 0 ? (
                <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
                  {data.failures.map((failure, index) => <li key={index + "-" + failure}>{failure}</li>)}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No runtime or analysis errors were recorded.</p>
              )}
            </section>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border bg-card">
        <CardHeader>
          <CardTitle>Limitations</CardTitle>
          <CardDescription>
            Interpret these measurements within the limits of the fixture set and the active engine mode.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.limitations.length > 0 ? (
            <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-muted-foreground">
              {data.limitations.map((limitation, index) => <li key={index + "-" + limitation}>{limitation}</li>)}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No additional limitations were reported.</p>
          )}
        </CardContent>
      </Card>
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
    <section aria-labelledby="evaluation-heading" className="space-y-5 bg-background text-foreground">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Measured prototype results
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground" id="evaluation-heading">Evaluation</h1>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            Reproducible grouping and policy checks on the fixed synthetic test split. Use the active engine label
            below to distinguish semantic mode from lexical fallback.
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
        <Card aria-live="polite" className="border-border bg-card" role="status">
          <CardContent className="p-5 text-sm text-muted-foreground">
            Loading measured evaluation results…
          </CardContent>
        </Card>
      ) : null}

      {state.status === "error" ? (
        <Card aria-live="assertive" className="border-border bg-card" role="alert">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{state.unavailable ? "Evaluation unavailable" : "Could not load evaluation"}</CardTitle>
              {state.unavailable ? <Badge variant="secondary">503 · Not measured</Badge> : null}
            </div>
            <CardDescription>{state.message}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Retry after the backend has an available evaluation result.
          </CardContent>
        </Card>
      ) : null}

      {state.status === "success" ? <EvaluationDetails data={state.data} /> : null}
    </section>
  );
}
