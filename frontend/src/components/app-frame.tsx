import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  IconChartBar,
  IconFileReport,
  IconLayoutDashboard,
  IconShieldCheck,
} from "@tabler/icons-react";
import { engineLabel } from "../lib/format";
import { SnapshotProvider, useSnapshot } from "../hooks/use-snapshot";
import type { EventInfo } from "../lib/types";

interface AppFrameProps {
  children: ReactNode;
}

type ThemePreference = "system" | "dark" | "light";

const THEME_KEY = "aegis.theme";

const navigation = [
  { to: "/dashboard", label: "Operations", icon: IconLayoutDashboard },
  { to: "/report", label: "New report", icon: IconFileReport },
  { to: "/evaluation", label: "Evaluation", icon: IconChartBar },
] as const;

function readThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    if (value === "dark" || value === "light" || value === "system") return value;
  } catch {
    return "system";
  }
  return "system";
}

function writeThemePreference(value: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_KEY, value);
  } catch {
    // The theme still updates for this page when storage is unavailable.
  }
}

function setDocumentTheme(preference: ThemePreference, systemDark: boolean): void {
  const dark = preference === "dark" || (preference === "system" && systemDark);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
}

function freshnessLabel(lastUpdated: number | null, now: number): string {
  if (lastUpdated === null) return "Waiting for first snapshot";
  const seconds = Math.max(0, Math.floor((now - lastUpdated) / 1_000));
  if (seconds < 60) return `Updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  return `Updated ${Math.floor(minutes / 60)}h ago`;
}

function eventOptionLabel(event: EventInfo): string {
  const timestamp = Date.parse(event.created_at);
  if (!Number.isFinite(timestamp)) return event.name;
  try {
    const created = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: event.timezone,
    }).format(timestamp);
    return `${event.name} · ${created}`;
  } catch {
    return event.name;
  }
}

export function AppFrame({ children }: AppFrameProps) {
  return (
    <SnapshotProvider>
      <AppFrameContent>{children}</AppFrameContent>
    </SnapshotProvider>
  );
}

function AppFrameContent({ children }: AppFrameProps) {
  const stream = useSnapshot();
  const [themePreference, setThemePreference] = useState<ThemePreference>(readThemePreference);
  const [now, setNow] = useState(() => Date.now());
  const selectedEvent = stream.events.find((event) => event.id === stream.selectedEventId)
    ?? stream.snapshot?.event;
  const eventName = selectedEvent?.name ?? (stream.loading ? "Loading current exercise" : "Exercise unavailable");
  const engineText = stream.snapshot ? engineLabel(stream.snapshot.health) : "Checking model status";

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => setDocumentTheme(themePreference, media?.matches ?? true);
    apply();
    media?.addEventListener?.("change", apply);
    return () => media?.removeEventListener?.("change", apply);
  }, [themePreference]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const stale = stream.lastUpdated !== null && now - stream.lastUpdated > 30_000;
  const limitedMatching = /fallback|degraded|unavailable/i.test(engineText);

  const chooseTheme = (value: string) => {
    if (value !== "system" && value !== "dark" && value !== "light") return;
    writeThemePreference(value);
    setThemePreference(value);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/dashboard" className="brand" aria-label="Aegis operations home">
          <IconShieldCheck className="brand-mark" size={18} stroke={1.8} aria-hidden="true" />
          <span className="brand-name">Aegis</span>
        </Link>

        <div className="event-heading">
          <label className="shell-event-label" htmlFor="shell-event-select">Exercise</label>
          <select
            id="shell-event-select"
            className="shell-event-select"
            aria-label="Exercise"
            value={stream.selectedEventId ?? ""}
            onChange={(event) => stream.selectEvent(event.target.value || undefined)}
            disabled={stream.events.length === 0}
          >
            {stream.events.length === 0 && <option value="">{eventName}</option>}
            {stream.events.map((event) => (
              <option key={event.id} value={event.id}>{eventOptionLabel(event)}</option>
            ))}
          </select>
        </div>

        <nav className="main-nav" aria-label="Main navigation">
          {navigation.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className="nav-link"
              activeProps={{ className: "nav-link is-active" }}
              aria-label={label}
            >
              <Icon size={16} stroke={1.8} />
              <span>{label}</span>
            </Link>
          ))}
        </nav>

        <div className="shell-status-group">
          <details className="shell-detail shell-live-detail">
            <summary className={`shell-freshness${stream.error || stream.reconnecting || stale ? " is-reconnecting" : ""}`}>
              <span className="shell-freshness-dot" aria-hidden="true" />
              {stream.reconnecting ? "Reconnecting" : stream.error ? "Offline" : stale ? "Updates delayed" : stream.lastUpdated === null ? "Connecting" : "Live"}
            </summary>
            <div className="shell-detail-content">
              <span>{freshnessLabel(stream.lastUpdated, now)}</span>
              <span>{engineText}</span>
              {stream.snapshot?.health.model_revision && <span>{stream.snapshot.health.model_revision}</span>}
            </div>
          </details>
          {limitedMatching && <span className="shell-matching-warning">Limited matching</span>}
          <details className="shell-detail shell-utilities">
            <summary aria-label="Settings and information">More</summary>
            <div className="shell-detail-content">
              <label className="theme-control">
                <span>Theme</span>
                <select aria-label="Theme" value={themePreference} onChange={(event) => chooseTheme(event.target.value)}>
                  <option value="system">System</option>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </label>
              <Link to="/about" activeProps={{ className: "is-active" }}>About Aegis</Link>
            </div>
          </details>
        </div>
      </header>

      {stream.reconnecting && stream.lastUpdated !== null && (
        <div className="shell-connection-notice" role="status">
          Live updates are reconnecting. The last successful snapshot is still shown.
        </div>
      )}

      {stale && !stream.reconnecting && (
        <div className="shell-connection-notice" role="status">Live updates are delayed. The last successful snapshot is still shown.</div>
      )}
      <main className="page-shell">{children}</main>
    </div>
  );
}
