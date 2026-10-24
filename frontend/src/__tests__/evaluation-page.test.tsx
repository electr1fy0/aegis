// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getEvaluation } from "../lib/api";
import type { Evaluation } from "../lib/types";
import { EvaluationPage } from "../pages/evaluation-page";
import { evaluationFixture, makeEvaluation } from "./fixtures";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, getEvaluation: vi.fn() };
});

const getEvaluationMock = vi.mocked(getEvaluation);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => getEvaluationMock.mockReset());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("EvaluationPage", () => {
  it("shows an accessible loading state while evaluation is pending", async () => {
    const pending = deferred<Evaluation>();
    getEvaluationMock.mockReturnValueOnce(pending.promise);
    render(<EvaluationPage />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading measured evaluation results");
    expect(screen.getByRole("button", { name: "Refresh evaluation" })).toBeDisabled();
    expect(getEvaluationMock).toHaveBeenCalledOnce();

    await act(async () => pending.resolve(evaluationFixture));
    expect(await screen.findByRole("table", { name: "Measured report grouping results" })).toBeInTheDocument();
  });

  it("renders measured grouping results, checks, failures, limitations, and model metadata", async () => {
    getEvaluationMock.mockResolvedValueOnce(evaluationFixture);
    render(<EvaluationPage />);

    expect(await screen.findByRole("heading", { name: "Grouping results" })).toBeInTheDocument();
    expect(screen.getByText("synthetic-v1")).toBeInTheDocument();
    expect(screen.getByText("all-MiniLM-L6-v2")).toBeInTheDocument();
    expect(screen.getByText("Lexical baseline")).toBeInTheDocument();
    expect(screen.getAllByText("Aegis")).toHaveLength(2);
    expect(screen.getByText("Lexical comparison; no semantic model result is implied.")).toBeInTheDocument();
    expect(screen.getByText("92.0%")).toBeInTheDocument();
    expect(screen.getByText("All reports retained")).toBeInTheDocument();
    expect(screen.getByText("Passed")).toBeInTheDocument();
    expect(screen.getByText("One ambiguous nearby report remained separate.")).toBeInTheDocument();
    expect(screen.getByText("Synthetic English reports only.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh evaluation" })).toBeEnabled();
  });

  it("separates fixture check failures from runtime failures", async () => {
    getEvaluationMock.mockResolvedValueOnce(
      makeEvaluation({
        checks: [
          { name: "No P0 reports missed", passed: false, detail: "1 severe fixture remained unassessed." },
        ],
        failures: ["Model load was unavailable for one replay."],
      }),
    );
    render(<EvaluationPage />);

    expect(await screen.findByText("Checks that failed")).toBeInTheDocument();
    expect(screen.getByText("No P0 reports missed:")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Runtime and analysis errors")).toBeInTheDocument();
    expect(screen.getByText("Model load was unavailable for one replay.")).toBeInTheDocument();
  });

  it("shows an explicit 503 unavailable state and retries", async () => {
    getEvaluationMock
      .mockRejectedValueOnce(new ApiError("No measured evaluation is available yet.", 503, "evaluation_unavailable"))
      .mockResolvedValueOnce(evaluationFixture);
    const user = userEvent.setup();
    render(<EvaluationPage />);

    const errorPanel = await screen.findByRole("alert");
    expect(errorPanel).toHaveTextContent("Evaluation unavailable");
    expect(errorPanel).toHaveTextContent("503 · Not measured");
    expect(errorPanel).toHaveTextContent("No measured evaluation is available yet.");
    await user.click(screen.getByRole("button", { name: "Retry evaluation" }));

    expect(await screen.findByRole("heading", { name: "Grouping results" })).toBeInTheDocument();
    expect(getEvaluationMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an interrupted request", new DOMException("Aborted", "AbortError"), "The evaluation request was interrupted. Try again."],
    ["an Error named AbortError", Object.assign(new Error("Aborted"), { name: "AbortError" }), "The evaluation request was interrupted. Try again."],
    ["a server error", new Error("Backend connection failed."), "Backend connection failed."],
    ["an unknown failure", "offline", "The evaluation could not be loaded. Try again."],
  ])("explains %s and offers a retry", async (_label, failure, message) => {
    getEvaluationMock.mockRejectedValueOnce(failure);
    render(<EvaluationPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Retry evaluation" })).toBeEnabled();
  });

  it("shows empty measurements without implying a result or latency", async () => {
    const emptyEvaluation = makeEvaluation({
      dataset_version: "",
      model: "",
      config_version: "",
      generated_at: "",
      results: [],
      checks: [],
      failures: [],
      limitations: [],
      latency: { p50_ms: Number.NaN, p95_ms: Number.POSITIVE_INFINITY },
    });
    getEvaluationMock.mockResolvedValueOnce(emptyEvaluation);
    render(<EvaluationPage />);

    expect(await screen.findByText("No measured grouping results are available for this run.")).toBeInTheDocument();
    expect(screen.getByText("Aegis measurement unavailable")).toBeInTheDocument();
    expect(screen.getByText("Not measured / Not measured")).toBeInTheDocument();
    expect(screen.getAllByText("Not reported").length).toBeGreaterThan(1);
    expect(screen.getByText("No checks were returned for this evaluation.")).toBeInTheDocument();
    expect(screen.getByText("No fixture checks failed in this run.")).toBeInTheDocument();
    expect(screen.getByText("No runtime or analysis errors were recorded.")).toBeInTheDocument();
    expect(screen.getByText("No additional limitations were reported.")).toBeInTheDocument();
  });

  it("marks a non-finite metric as not measured", async () => {
    getEvaluationMock.mockResolvedValueOnce(makeEvaluation({
      results: [{ ...evaluationFixture.results[0]!, precision: Number.NaN }],
    }));
    render(<EvaluationPage />);

    const table = await screen.findByRole("table", { name: "Measured report grouping results" });
    expect(table).toHaveTextContent("Not measured");
  });

  it("ignores an evaluation response that finishes after unmount", async () => {
    const pending = deferred<Evaluation>();
    getEvaluationMock.mockReturnValueOnce(pending.promise);
    const view = render(<EvaluationPage />);
    await waitFor(() => expect(getEvaluationMock).toHaveBeenCalledOnce());

    view.unmount();
    await act(async () => pending.resolve(evaluationFixture));
  });

  it("ignores an evaluation error that finishes after unmount", async () => {
    const pending = deferred<Evaluation>();
    getEvaluationMock.mockReturnValueOnce(pending.promise);
    const view = render(<EvaluationPage />);
    await waitFor(() => expect(getEvaluationMock).toHaveBeenCalledOnce());

    view.unmount();
    await act(async () => pending.reject(new Error("Late evaluation failure")));
  });

  it("refreshes a successful evaluation on request", async () => {
    getEvaluationMock
      .mockResolvedValueOnce(evaluationFixture)
      .mockResolvedValueOnce(makeEvaluation({ dataset_version: "synthetic-v2" }));
    const user = userEvent.setup();
    render(<EvaluationPage />);

    expect(await screen.findByText("synthetic-v1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh evaluation" }));
    expect(await screen.findByText("synthetic-v2")).toBeInTheDocument();
    expect(getEvaluationMock).toHaveBeenCalledTimes(2);
  });
});
