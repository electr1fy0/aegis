import { IconCheck, IconChevronDown, IconMapPin } from "@tabler/icons-react";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogClose } from "../components/ui/dialog";
import { CampusMap } from "../components/campus-map";
import { MenuSelect } from "../components/ui/menu-select";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, getSnapshot, submitReport } from "../lib/api";
import type { CurrentEvent, ReportInput, ReportReceipt } from "../lib/types";
import { hasReportDraftContent, loadReportDraft, saveReportDraft, type ReportDraft, type ReportTimeMode } from "../lib/report-draft";
import { useSharedSnapshot } from "../hooks/use-snapshot";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import "./report-page.css";

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
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `aegis-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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

function isoToDatetimeLocal(value: string, timeZone: string): string | null {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  try {
    const parts = datePartsAt(timestamp, timeZone);
    if (!parts) return null;
    const pad = (part: number) => String(part).padStart(2, "0");
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
  } catch {
    return null;
  }
}

function displayIdentifier(id: string, displayId?: string | null): string {
  return displayId || id.slice(0, 8);
}

export function dashboardReceiptHref(eventId: string, incidentId: string): string {
  try {
    const url = new URL(window.location.href);
    url.pathname = "/dashboard";
    url.searchParams.set("event", eventId);
    url.searchParams.set("incident", incidentId);
    return `${url.pathname}${url.search}`;
  } catch {
    return `/dashboard?event=${encodeURIComponent(eventId)}&incident=${encodeURIComponent(incidentId)}`;
  }
}

export function ReportPage() {
  const shared = useSharedSnapshot();
  const [currentEvent, setCurrentEvent] = useState<CurrentEvent | null>(null);
  const [loadingEvent, setLoadingEvent] = useState(true);
  const [eventError, setEventError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const [draftStatus, setDraftStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [textError, setTextError] = useState<string | null>(null);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [copyMessage, setCopyMessage] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);

  const mountedRef = useRef(false);
  const receiptRef = useRef<HTMLElement>(null);
  const currentEventRef = useRef<CurrentEvent | null>(null);
  const draftRef = useRef<ReportDraft | null>(null);
  const eventRequestRef = useRef<AbortController | null>(null);
  const eventRequestSequenceRef = useRef(0);
  const submittingRef = useRef(false);

  const restoreEvent = useCallback((loadedEvent: CurrentEvent) => {
    const previousId = currentEventRef.current?.event.id;
    currentEventRef.current = loadedEvent;
    setCurrentEvent(loadedEvent);
    setLoadingEvent(false);
    setEventError(null);
    if (previousId !== loadedEvent.event.id || draftRef.current === null) {
      const restored = loadReportDraft(loadedEvent.event.id, createIdempotencyKey());
      draftRef.current = restored;
      setDraft(restored);
      setDetailsOpen(!!restored.sublocation || restored.timeMode !== "unknown");
      setDraftStatus(restored.receipt
        ? "Report receipt restored on this device."
        : hasReportDraftContent(restored)
          ? "Saved draft restored."
          : "");
      setTextError(null);
      setTimeError(null);
      setSubmitError(null);
      setCopyMessage("");
    }
  }, []);

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
      restoreEvent({ event: snapshot.event, zones: snapshot.zones });
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
  }, [restoreEvent]);

  useEffect(() => {
    mountedRef.current = true;
    if (!shared) void loadCurrentEvent();
    return () => {
      mountedRef.current = false;
      eventRequestSequenceRef.current += 1;
      eventRequestRef.current?.abort();
      eventRequestRef.current = null;
    };
  }, [loadCurrentEvent, shared === null]);

  useEffect(() => {
    if (!shared) return;
    if (shared.snapshot) {
      restoreEvent({ event: shared.snapshot.event, zones: shared.snapshot.zones });
      return;
    }
    setLoadingEvent(shared.loading);
    if (shared.error) setEventError(shared.error);
    else setEventError(null);
  }, [shared?.snapshot, shared?.selectedEventId, shared?.loading, shared?.error, restoreEvent]);

  const updateDraft = (changes: Partial<ReportDraft>): ReportDraft | null => {
    const previous = draftRef.current;
    if (!previous) return null;
    const next = { ...previous, ...changes };
    draftRef.current = next;
    setDraft(next);
    const saved = saveReportDraft(next);
    setDraftStatus(saved ? "Draft saved on this device." : "Draft storage is unavailable; keep this page open.");
    return next;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const activeDraft = draftRef.current;
    const activeEvent = currentEventRef.current;
    if (submittingRef.current || !activeEvent || !activeDraft) return;
    setTextError(null);
    setTimeError(null);
    setSubmitError(null);

    if (!activeDraft.text.trim()) {
      setTextError("Enter a report description before submitting.");
      return;
    }
    if (activeDraft.text.length > 4000) {
      setTextError("Keep the description to 4,000 characters or fewer.");
      return;
    }

    let eventTimeIso: string | undefined;
    let localReportedAt = activeDraft.reportedAt;
    if (activeDraft.timeMode === "just-observed") {
      localReportedAt = localReportedAt || isoToDatetimeLocal(new Date().toISOString(), activeEvent.event.timezone) || "";
      if (localReportedAt !== activeDraft.reportedAt) updateDraft({ reportedAt: localReportedAt });
    }
    if (activeDraft.timeMode === "earlier" && !localReportedAt) {
      setTimeError("Choose an earlier event time, or select Unknown if it was not provided.");
      return;
    }
    if (activeDraft.timeMode !== "unknown") {
      const converted = datetimeLocalToIso(localReportedAt, activeEvent.event.timezone);
      if (!converted) {
        setTimeError(
          `Choose a valid, unambiguous local time in ${activeEvent.event.timezone}. A time skipped or repeated by a clock change cannot be submitted.`,
        );
        return;
      }
      if (activeDraft.timeMode === "earlier" && Date.parse(converted) > Date.now()) {
        setTimeError("This time is after now. Choose Just observed or check the reporter’s time.");
        return;
      }
      eventTimeIso = converted;
    }

    const fields: Omit<ReportInput, "idempotency_key"> = {
      text: activeDraft.text,
      source: "form",
      event_id: activeEvent.event.id,
      ...(activeDraft.zoneId ? { zone_id: activeDraft.zoneId } : {}),
      ...(activeDraft.sublocation.trim() ? { sublocation: activeDraft.sublocation.trim() } : {}),
      ...(eventTimeIso ? { reported_at: eventTimeIso } : {}),
    };
    const fingerprint = JSON.stringify(fields);
    let currentIdempotencyKey = activeDraft.idempotencyKey;
    if (activeDraft.lastAttemptFingerprint !== null && activeDraft.lastAttemptFingerprint !== fingerprint) {
      currentIdempotencyKey = createIdempotencyKey();
    }
    const input: ReportInput = {
      ...fields,
      idempotency_key: currentIdempotencyKey,
    };
    const attemptedDraft: ReportDraft = {
      ...activeDraft,
      reportedAt: localReportedAt,
      idempotencyKey: currentIdempotencyKey,
      lastAttemptFingerprint: fingerprint,
    };
    draftRef.current = attemptedDraft;
    setDraft(attemptedDraft);
    const savedAttempt = saveReportDraft(attemptedDraft);
    setDraftStatus(savedAttempt ? "Draft saved on this device." : "Draft storage is unavailable; keep this page open.");

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const result = await submitReport(input);
      if (!mountedRef.current) return;
      const confirmedDraft: ReportDraft = {
        ...attemptedDraft,
        text: "",
        zoneId: "",
        sublocation: "",
        timeMode: "unknown",
        reportedAt: "",
        idempotencyKey: createIdempotencyKey(),
        receipt: result,
      };
      const savedReceipt = saveReportDraft(confirmedDraft);
      if (currentEventRef.current?.event.id === activeEvent.event.id) {
        draftRef.current = confirmedDraft;
        setDraft(confirmedDraft);
        setDraftStatus(savedReceipt
          ? "Report receipt saved on this device."
          : "Report received. Receipt storage is unavailable; keep this page open.");
        requestAnimationFrame(() => {
          if (!mountedRef.current || currentEventRef.current?.event.id !== activeEvent.event.id) return;
          receiptRef.current?.focus({ preventScroll: true });
          receiptRef.current?.scrollIntoView?.({ block: "start", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
        });
      }
      setCopyMessage("");
      void shared?.refresh();
    } catch (error) {
      if (mountedRef.current && currentEventRef.current?.event.id === activeEvent.event.id) {
        setSubmitError(errorMessage(error));
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  };

  const activeDraft = draft;
  const text = activeDraft?.text ?? "";
  const zoneId = activeDraft?.zoneId ?? "";
  const sublocation = activeDraft?.sublocation ?? "";
  const reportedAt = activeDraft?.reportedAt ?? "";
  const timeMode = activeDraft?.timeMode ?? "unknown";
  const receipt: ReportReceipt | null = activeDraft?.receipt ?? null;
  const selectedEventPending = Boolean(
    shared?.selectedEventId && currentEvent?.event.id !== shared.selectedEventId,
  );
  const isFormDisabled = loadingEvent || selectedEventPending || !currentEvent || !activeDraft || submitting;
  const timeDescriptionId = timeError ? "event-time-error" : timeMode !== "unknown" ? "event-time-help" : undefined;

  const chooseTimeMode = (mode: ReportTimeMode) => {
    let captured = "";
    if (mode === "just-observed" && currentEvent) {
      captured = isoToDatetimeLocal(new Date().toISOString(), currentEvent.event.timezone) ?? "";
    }
    updateDraft({ timeMode: mode, reportedAt: mode === "just-observed" ? captured : "" });
    setTimeError(null);
    setSubmitError(null);
  };

  useEffect(() => { if (timeError) setDetailsOpen(true); }, [timeError]);

  const copyFullId = async (label: string, id: string) => {
    try {
      if (!window.navigator.clipboard?.writeText) {
        setCopyMessage("Clipboard access is unavailable in this browser.");
        return;
      }
      await window.navigator.clipboard.writeText(id);
      setCopyMessage(`Full ${label.toLowerCase()} copied.`);
    } catch {
      setCopyMessage("The ID could not be copied. Select it to copy manually.");
    }
  };

  return (
    <section className="report-page" aria-labelledby="report-page-title">
      <div className="page-heading">
        <div className="page-heading-copy">
          <h1 id="report-page-title">New report</h1>
          <p className="page-subtitle">
            Use the reporter’s words. Add only what you know.
          </p>
        </div>
      </div>

      {eventError && (
        <div className="status-banner is-error" role="alert">
          <span>{eventError}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void (shared ? shared.refresh() : loadCurrentEvent())}>
            Retry
          </Button>
        </div>
      )}

      <div className="report-layout">
        <Card className="form-card">
          {receipt && (
            <section ref={receiptRef} tabIndex={-1} className="receipt-card" role="status" aria-live="polite" aria-label="Submission receipt">
              <div className="receipt-head"><span className="receipt-check"><IconCheck size={20} /></span>
                <span>{receipt.duplicate ? "Existing report receipt" : "Report received"}</span>
                {receipt.duplicate && <Badge variant="outline">Duplicate retry</Badge>}
              </div>
              <p className="receipt-copy">
                {receipt.duplicate
                  ? "This submission was already received. The original report and incident are shown below."
                  : "The report was saved and remains available to the coordinator."}
              </p>
              <p className="receipt-copy"><a className="receipt-dashboard-link" href={dashboardReceiptHref(receipt.report.event_id, receipt.incident.id)}>Open this incident on the operations board</a></p>
              <details className="receipt-details"><summary>Receipt details</summary>
              <p className="receipt-copy">
                <strong>Report ID</strong> <span className="mono" title={receipt.report.id}>{displayIdentifier(receipt.report.id, receipt.report.display_id)}</span>
                <Button type="button" variant="ghost" size="xs" onClick={() => void copyFullId("report ID", receipt.report.id)}>Copy full ID</Button>
              </p>
              <p className="receipt-copy">
                <strong>Incident ID</strong> <span className="mono" title={receipt.incident.id}>{displayIdentifier(receipt.incident.id, receipt.incident.display_id)}</span>
                <Button type="button" variant="ghost" size="xs" onClick={() => void copyFullId("incident ID", receipt.incident.id)}>Copy full ID</Button>
              </p>

              {copyMessage && <p className="field-hint" role="status">{copyMessage}</p>}
              <p className="receipt-copy">
                <strong>Priority</strong>{" "}
                <Badge variant={priorityVariant(receipt.incident.priority)}>
                  {receipt.incident.priority}
                </Badge>{" "}
                · {receipt.report.analysis_status} analysis
              </p>
              <blockquote className="receipt-copy">{receipt.report.text}</blockquote>
              </details>
            </section>
          )}

          <p className="field-hint report-context" id="event-context" role={loadingEvent || selectedEventPending ? "status" : undefined} aria-live="polite">
            {loadingEvent ? "Loading the current exercise…" : selectedEventPending
              ? "Loading the selected exercise. Your draft stays saved."
              : currentEvent ? <>Submitting to <strong>{currentEvent.event.name}</strong> ({currentEvent.event.timezone}).</> : "Exercise unavailable."}
          </p>

          <form className="report-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
            <div className="form-field report-description-field">
              <label htmlFor="report-description">Report description</label>
              <Textarea
                id="report-description"
                name="text"
                value={text}
                onChange={(event) => {
                  updateDraft({ text: event.target.value });
                  setTextError(null);
                  setSubmitError(null);
                }}
                placeholder="What happened?"
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
                <p className="field-hint report-character-count" id="report-description-help" data-near-limit={text.length >= 3500}>
                  {text.length}/4,000
                </p>
              )}
            </div>

            <div className="form-grid">
              <div className="form-field">
                <label htmlFor="report-zone">Location <span className="optional-label" aria-hidden="true">Optional</span></label>
                <MenuSelect
                  id="report-zone"
                  name="zone_id"
                  className="form-select"
                  value={zoneId}
                  onChange={(event) => {
                    updateDraft({ zoneId: event.target.value });
                    setSubmitError(null);
                  }}
                  disabled={isFormDisabled}
                >
                  <option value="">Unknown / not provided</option>
                  {currentEvent?.zones.filter((zone) => zone.id === zoneId && zone.selectable === false).map((zone) => (
                    <option key={zone.id} value={zone.id} disabled>{zone.label} (saved draft)</option>
                  ))}
                  {currentEvent?.zones.filter((zone) => zone.selectable !== false).map((zone) => (
                    <option key={zone.id} value={zone.id}>
                      {zone.label}
                    </option>
                  ))}
                </MenuSelect>
              </div>

              <Dialog>
                <DialogTrigger render={<Button type="button" variant="outline" className="map-picker-button" />} disabled={isFormDisabled}>
                  <IconMapPin size={17} />Choose on map
                </DialogTrigger>
                <DialogContent className="location-dialog">
                  <DialogHeader>
                    <DialogTitle>Choose a location</DialogTitle>
                    <DialogDescription>Select a building or area on the campus map.</DialogDescription>
                  </DialogHeader>
                  <div className="location-map-content">
                    <CampusMap zones={currentEvent?.zones ?? []} value={zoneId} disabled={isFormDisabled} showHeading={false}
                      onValueChange={(nextZoneId) => { updateDraft({ zoneId: nextZoneId }); setSubmitError(null); }} />
                  </div>
                  <div className="location-dialog-footer"><DialogClose render={<Button type="button" size="lg" />}>Done</DialogClose></div>
                </DialogContent>
              </Dialog>
            </div>

            <details className="report-extra-details" open={detailsOpen} onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
              <summary><span>Add time or a specific spot</span><IconChevronDown size={16} aria-hidden="true" /></summary>
              <div className="report-extra-details-body" hidden={!detailsOpen}>
              <div className="form-field">
                <label htmlFor="report-sublocation">Specific spot</label>
                <Input
                  id="report-sublocation"
                  name="sublocation"
                  value={sublocation}
                  onChange={(event) => {
                    updateDraft({ sublocation: event.target.value });
                    setSubmitError(null);
                  }}
                  placeholder="e.g. inner doorway"
                  maxLength={200}
                  disabled={isFormDisabled}
                />
              </div>
            <fieldset className="form-field time-mode-fieldset" aria-describedby={timeDescriptionId}>
              <legend>When was this observed?</legend>
              <div className="time-mode-options">
                <label>
                  <input type="radio" name="report-time-mode" value="just-observed" checked={timeMode === "just-observed"} onChange={() => chooseTimeMode("just-observed")} disabled={isFormDisabled} />
                  <span><strong>Just observed</strong></span>
                </label>
                <label>
                  <input type="radio" name="report-time-mode" value="earlier" checked={timeMode === "earlier"} onChange={() => chooseTimeMode("earlier")} disabled={isFormDisabled} />
                  <span><strong>Earlier</strong></span>
                </label>
                <label>
                  <input type="radio" name="report-time-mode" value="unknown" checked={timeMode === "unknown"} onChange={() => chooseTimeMode("unknown")} disabled={isFormDisabled} />
                  <span><strong>Unknown</strong></span>
                </label>
              </div>
              {timeMode === "earlier" && currentEvent && !selectedEventPending && (
                <div className="form-field time-mode-detail">
                  <label htmlFor="report-event-time">Earlier event time</label>
                  <Input
                    id="report-event-time"
                    name="reported_at"
                    type="datetime-local"
                    value={reportedAt}
                    onChange={(event) => {
                      updateDraft({ reportedAt: event.target.value });
                      setTimeError(null);
                      setSubmitError(null);
                    }}
                    disabled={isFormDisabled}
                    aria-invalid={timeError ? true : undefined}
                    aria-describedby={timeDescriptionId}
                  />
                  <p className="field-hint" id="event-time-help">
                    Time in {currentEvent.event.timezone}.
                  </p>
                </div>
              )}
              {timeMode === "just-observed" && currentEvent && !selectedEventPending && (
                <p className="field-hint time-mode-detail" id="event-time-help">
                  {reportedAt
                    ? `Captured at ${reportedAt.replace("T", " ")} in ${currentEvent.event.timezone} when you selected this option.`
                    : `The current time in ${currentEvent.event.timezone} will be captured when you submit.`}
                </p>
              )}
              {timeError && <p className="form-error" id="event-time-error" role="alert">{timeError}</p>}
            </fieldset>

              </div>
            </details>

            {submitError && (
              <p className="form-error" role="alert">
                {submitError}
              </p>
            )}

            <div className="submit-row">
              <Button type="submit" size="lg" disabled={isFormDisabled}>
                {submitting ? "Submitting…" : "Submit report"}
              </Button>
            </div>
          </form>

          {draftStatus && <p className="draft-status" role="status">{draftStatus}</p>}
        </Card>


      </div>
      <p className="report-safety-scope">Synthetic exercise only. Reports do not contact emergency services or dispatch responders.</p>
    </section>
  );
}
