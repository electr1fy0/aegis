import { describe, expect, it } from "vitest";
import { exportSnapshotCsv, highlightRanges, reviewReasonLabel } from "../lib/dashboard-model";
import { engineLabel, formatEventAge } from "../lib/format";
import { healthFixture, makeIncident, makeSnapshot } from "./fixtures";

describe("dashboard helper edge cases", () => {
  it("uses the longer phrase when highlight candidates begin at the same position", () => {
    expect(highlightRanges("Smoke alarm near the exit", ["Smoke", "Smoke alarm"])).toEqual([
      { start: 0, end: 11, phrase: "Smoke alarm" },
    ]);
  });

  it("keeps nullable export fields empty instead of stringifying null", () => {
    const snapshot = makeSnapshot({
      incidents: [makeIncident({ id: null as unknown as string })],
    });

    const row = exportSnapshotCsv(snapshot).split("\r\n")[1];
    expect(row?.startsWith(",")).toBe(true);
  });

  it("labels a semantic engine with its engine name when the model revision is absent", () => {
    expect(engineLabel({ ...healthFixture, engine: "semantic", model_revision: null })).toBe("Semantic matching · semantic");
  });

  it("marks an occurrence within the next minute as soon", () => {
    const now = Date.parse("2026-10-25T10:00:00Z");
    expect(formatEventAge("2026-10-25T10:00:30Z", now)).toBe("Soon");
  });

  it("classifies the backend's unknown event-time review reason as a timing issue", () => {
    expect(reviewReasonLabel("Reported event time is unknown; automated grouping needs review."))
      .toBe("Timing needs checking");
  });
});
