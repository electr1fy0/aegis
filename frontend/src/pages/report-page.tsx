import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, getSnapshot, submitReport } from "../lib/api";
import type { CurrentEvent, ReportInput, ReportReceipt } from "../lib/types";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

function createIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

function datePartsAt(timestamp: number, timeZone: string): LocalDateTimeParts | null {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values = new Map(
    formatter
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part): [string, number] => [part.type, Number(part.value)]),
  );
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  const hour = values.get("hour");
  const minute = values.get("minute");
  const second = values.get("second");
  if (
    year === undefined || month === undefined || day === undefined ||
    hour === undefined || minute === undefined || second === undefined
  ) {
    return null;
  }
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond: 0,
  };
}

function sameWallTime(left: LocalDateTimeParts, right: LocalDateTimeParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

/** Convert the form's wall time in the event's IANA timezone to a UTC ISO string. */
export function datetimeLocalToIso(value: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
    value,
  );
  if (!match) return null;

  const target: LocalDateTimeParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
    millisecond: Number((match[7] ?? "").padEnd(3, "0")),
  };
  if (
    target.year < 1000 ||
    target.month < 1 || target.month > 12 ||
    target.day < 1 || target.day > 31 ||
    target.hour > 23 || target.minute > 59 || target.second > 59
  ) {
    return null;
  }

  const wallTimeAsUtc = Date.UTC(
    target.year,
    target.month - 1,
    target.day,
    target.hour,
    target.minute,
    target.second,
    target.millisecond,
  );
  const calendarCheck = new Date(wallTimeAsUtc);
  if (
    calendarCheck.getUTCFullYear() !== target.year ||
    calendarCheck.getUTCMonth() + 1 !== target.month ||
    calendarCheck.getUTCDate() !== target.day
  ) {
    return null;
  }

  try {
    let candidate = wallTimeAsUtc;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const projected = datePartsAt(candidate, timeZone);
      if (!projected) return null;
      const projectedAsUtc = Date.UTC(
        projected.year,
        projected.month - 1,
        projected.day,
        projected.hour,
        projected.minute,
        projected.second,
      );
      const candidateAtWholeSecond = Math.floor(candidate / 1000) * 1000;
      const offset = projectedAsUtc - candidateAtWholeSecond;
      const next = wallTimeAsUtc - offset;
      if (next === candidate) break;
      candidate = next;
    }

    const roundTrip = datePartsAt(candidate, timeZone);
    if (!roundTrip || !sameWallTime(roundTrip, target)) return null;

    const nearbyOffsets = [-24, -6, -3, -2, -1, 1, 2, 3, 6, 24].map((hours) => {
      const nearbyInstant = candidate + hours * 60 * 60 * 1000;
      const nearbyParts = datePartsAt(nearbyInstant, timeZone);
      if (!nearbyParts) return null;
      const nearbyAsUtc = Date.UTC(
        nearbyParts.year,
        nearbyParts.month - 1,
        nearbyParts.day,
        nearbyParts.hour,
        nearbyParts.minute,
        nearbyParts.second,
      );
      return nearbyAsUtc - Math.floor(nearbyInstant / 1000) * 1000;
    });
    for (const offset of nearbyOffsets) {
      if (offset === null) continue;
      const alternate = wallTimeAsUtc - offset;
      if (alternate === candidate) continue;
      const alternateParts = datePartsAt(alternate, timeZone);
      if (alternateParts && sameWallTime(alternateParts, target)) return null;
    }
    return new Date(candidate).toISOString();
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.name !== "AbortError") {
    return "The Aegis backend could not be reached. Your report is still here; you can safely retry.";
  }
  return "The report could not be submitted. Your report is still here; you can safely retry.";
}

function priorityVariant(priority: string): "default" | "secondary" | "destructive" {
  if (priority === "P0") return "destructive";
  if (priority === "P1") return "default";
  return "secondary";
}

export function ReportPage() {
  const [currentEvent, setCurrentEvent] = useState<CurrentEvent | null>(null);
  const [loadingEvent, setLoadingEvent] = useState(true);
  const [eventError, setEventError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [sublocation, setSublocation] = useState("");
  const [reportedAt, setReportedAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ReportReceipt | null>(null);

  const mountedRef = useRef(false);
  const eventRequestRef = useRef<AbortController | null>(null);
  const eventRequestSequenceRef = useRef(0);
  const submittingRef = useRef(false);
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey);
  const lastAttemptFingerprintRef = useRef<string | null>(null);

  const loadCurrentEvent = useCallback(async () => {
    eventRequestRef.current?.abort();
    const controller = new AbortController();
    const requestSequence = eventRequestSequenceRef.current + 1;
    eventRequestSequenceRef.current = requestSequence;
    eventRequestRef.current = controller;
    setLoadingEvent(true);
    setEventError(null);

    try {
      const snapshot = await getSnapshot(undefined, controller.signal);
      if (!mountedRef.current || requestSequence !== eventRequestSequenceRef.current) return;
      const loadedEvent: CurrentEvent = { event: snapshot.event, zones: snapshot.zones };
      setCurrentEvent(loadedEvent);
    } catch (error) {
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        requestSequence !== eventRequestSequenceRef.current
      ) {
        return;
      }
      setEventError(
        error instanceof ApiError
          ? error.message
          : "The current exercise could not be loaded. Check the backend and retry.",
      );
    } finally {
      if (mountedRef.current && requestSequence === eventRequestSequenceRef.current) {
        setLoadingEvent(false);
      }
      if (eventRequestRef.current === controller) eventRequestRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadCurrentEvent();
    return () => {
      mountedRef.current = false;
      eventRequestSequenceRef.current += 1;
      eventRequestRef.current?.abort();
      eventRequestRef.current = null;
    };
  }, [loadCurrentEvent]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current || !currentEvent) return;
    setTextError(null);
    setTimeError(null);
    setSubmitError(null);

    if (!text.trim()) {
      setTextError("Enter a report description before submitting.");
      return;
    }
    if (text.length > 4000) {
      setTextError("Keep the description to 4,000 characters or fewer.");
      return;
    }

    let eventTimeIso: string | undefined;
    if (reportedAt) {
      const converted = datetimeLocalToIso(reportedAt, currentEvent.event.timezone);
      if (!converted) {
        setTimeError(
          `Choose a valid, unambiguous local time in ${currentEvent.event.timezone}. A time skipped or repeated by a clock change cannot be submitted.`,
        );
        return;
      }
      eventTimeIso = converted;
    }

    const fields: Omit<ReportInput, "idempotency_key"> = {
      text,
      source: "form",
      event_id: currentEvent.event.id,
      ...(zoneId ? { zone_id: zoneId } : {}),
      ...(sublocation.trim() ? { sublocation: sublocation.trim() } : {}),
      ...(eventTimeIso ? { reported_at: eventTimeIso } : {}),
    };
    const fingerprint = JSON.stringify(fields);
    let currentIdempotencyKey = idempotencyKey;
    if (
      lastAttemptFingerprintRef.current !== null &&
      lastAttemptFingerprintRef.current !== fingerprint
    ) {
      currentIdempotencyKey = createIdempotencyKey();
      setIdempotencyKey(currentIdempotencyKey);
    }
    lastAttemptFingerprintRef.current = fingerprint;
    const input: ReportInput = {
      ...fields,
      idempotency_key: currentIdempotencyKey,
    };

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const result = await submitReport(input);
      if (!mountedRef.current) return;
      setReceipt(result);
      setText("");
      setZoneId("");
      setSublocation("");
      setReportedAt("");
      setIdempotencyKey(createIdempotencyKey());
      lastAttemptFingerprintRef.current = null;
    } catch (error) {
      if (mountedRef.current) setSubmitError(errorMessage(error));
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const isFormDisabled = loadingEvent || !currentEvent || submitting;
  const timeDescriptionId = timeError ? "event-time-error" : "event-time-help";

  return (
    <>
      <div className="page-heading">
        <div className="page-heading-copy">
          <span className="eyebrow">Report intake</span>
          <h1>New report</h1>
          <p className="page-subtitle">
            Preserve what was reported and send it to the coordinator review board.
          </p>
        </div>
      </div>

      {loadingEvent && (
        <div className="status-banner" role="status" aria-live="polite">
          Loading the current exercise and its zones…
        </div>
      )}
      {eventError && (
        <div className="status-banner is-error" role="alert">
          <span>{eventError}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadCurrentEvent()}>
            Retry
          </Button>
        </div>
      )}

      <div className="report-layout">
        <Card className="form-card">
          <h2>Incident details</h2>
          <p className="form-intro">
            The description is stored exactly as entered. Unknown details can stay blank and will remain visible for review.
          </p>

          {currentEvent && (
            <p className="field-hint" id="event-context">
              Submitting to <strong>{currentEvent.event.name}</strong> ({currentEvent.event.timezone}).
            </p>
          )}

          <form className="report-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
            <div className="form-field">
              <label htmlFor="report-description">Report description</label>
              <Textarea
                id="report-description"
                name="text"
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setTextError(null);
                  setSubmitError(null);
                }}
                placeholder="Describe what was observed, using the reporter’s own words."
                required
                maxLength={4000}
                aria-invalid={textError ? true : undefined}
                aria-describedby={textError ? "report-description-error" : "report-description-help"}
                disabled={isFormDisabled}
              />
              {textError ? (
                <p className="form-error" id="report-description-error" role="alert">
                  {textError}
                </p>
              ) : (
                <p className="field-hint" id="report-description-help">
                  Keep the original wording, including uncertainty or conflicting details. {text.length}/4,000
                </p>
              )}
            </div>

            <div className="form-grid">
              <div className="form-field">
                <label htmlFor="report-zone">Zone</label>
                <select
                  id="report-zone"
                  name="zone_id"
                  className="form-select"
                  value={zoneId}
                  onChange={(event) => {
                    setZoneId(event.target.value);
                    setSubmitError(null);
                  }}
                  disabled={isFormDisabled}
                  aria-describedby="report-zone-help"
                >
                  <option value="">Unknown / not provided</option>
                  {currentEvent?.zones.map((zone) => (
                    <option key={zone.id} value={zone.id}>
                      {zone.label}
                    </option>
                  ))}
                </select>
                <p className="field-hint" id="report-zone-help">
                  Leave unknown if the location was not supplied.
                </p>
              </div>

              <div className="form-field">
                <label htmlFor="report-sublocation">Sublocation</label>
                <Input
                  id="report-sublocation"
                  name="sublocation"
                  value={sublocation}
                  onChange={(event) => {
                    setSublocation(event.target.value);
                    setSubmitError(null);
                  }}
                  placeholder="e.g. inner doorway"
                  maxLength={200}
                  disabled={isFormDisabled}
                  aria-describedby="report-sublocation-help"
                />
                <p className="field-hint" id="report-sublocation-help">
                  Optional reporter-supplied detail.
                </p>
              </div>
            </div>

            <div className="form-field">
              <label htmlFor="report-event-time">Event time (optional)</label>
              <Input
                id="report-event-time"
                name="reported_at"
                type="datetime-local"
                value={reportedAt}
                onChange={(event) => {
                  setReportedAt(event.target.value);
                  setTimeError(null);
                  setSubmitError(null);
                }}
                disabled={isFormDisabled}
                aria-invalid={timeError ? true : undefined}
                aria-describedby={timeDescriptionId}
              />
              {timeError ? (
                <p className="form-error" id="event-time-error" role="alert">
                  {timeError}
                </p>
              ) : (
                <p className="field-hint" id="event-time-help">
                  Enter the event-local time in {currentEvent?.event.timezone ?? "the event timezone"}; it will be stored as UTC.
                </p>
              )}
            </div>

            {submitError && (
              <p className="form-error" role="alert">
                {submitError}
              </p>
            )}

            <div className="submit-row">
              <p className="submit-note">
                This synthetic exercise records reports for human review. It does not contact responders or dispatch anyone.
              </p>
              <Button type="submit" size="lg" disabled={isFormDisabled}>
                {submitting ? "Submitting…" : "Submit report"}
              </Button>
            </div>
          </form>

          {receipt && (
            <section className="receipt-card" role="status" aria-live="polite" aria-label="Submission receipt">
              <div className="receipt-head">
                <span>{receipt.duplicate ? "Existing report receipt" : "Report received"}</span>
                {receipt.duplicate && <Badge variant="outline">Duplicate retry</Badge>}
              </div>
              <p className="receipt-copy">
                {receipt.duplicate
                  ? "This submission was already received. The original report and incident are shown below."
                  : "The report was saved and remains available to the coordinator."}
              </p>
              <p className="receipt-copy">
                <strong>Report ID</strong> <span className="mono">{receipt.report.id}</span>
              </p>
              <p className="receipt-copy">
                <strong>Incident ID</strong> <span className="mono">{receipt.incident.id}</span>
              </p>
              <p className="receipt-copy">
                <strong>Priority</strong>{" "}
                <Badge variant={priorityVariant(receipt.incident.priority)}>
                  {receipt.incident.priority}
                </Badge>{" "}
                · {receipt.report.analysis_status} analysis
              </p>
              <blockquote className="receipt-copy">{receipt.report.text}</blockquote>
            </section>
          )}
        </Card>

        <Card className="report-guidance">
          <div>
            <span className="eyebrow">Coordinator workflow</span>
            <h2>What happens next</h2>
          </div>
          <div className="guidance-row">
            <span className="guidance-icon" aria-hidden="true">1</span>
            <div className="guidance-copy">
              <strong>The original report stays available</strong>
              <p>Submitting does not overwrite the reporter’s wording, including incomplete or uncertain details.</p>
            </div>
          </div>
          <div className="guidance-row">
            <span className="guidance-icon" aria-hidden="true">2</span>
            <div className="guidance-copy">
              <strong>Grouping is provisional</strong>
              <p>Location, event time, and text similarity help suggest related reports for a coordinator to inspect.</p>
            </div>
          </div>
          <div className="guidance-row">
            <span className="guidance-icon" aria-hidden="true">3</span>
            <div className="guidance-copy">
              <strong>People remain in control</strong>
              <p>Priority labels order review. A human coordinator decides how to respond and records any correction.</p>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
