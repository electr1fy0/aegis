import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  IconChartBar,
  IconFileReport,
  IconInfoCircle,
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
  { to: "/about", label: "About", icon: IconInfoCircle },
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
  const engineState = stream.error
    ? "offline"
    : stream.snapshot?.health.model_ready
      ? "ready"
      : stream.snapshot
        ? "degraded"
        : "offline";

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

  const chooseTheme = (value: string) => {
    if (value !== "system" && value !== "dark" && value !== "light") return;
    writeThemePreference(value);
    setThemePreference(value);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/dashboard" className="brand" aria-label="Aegis operations home">
          <span className="brand-mark"><IconShieldCheck size={19} stroke={1.8} /></span>
          <span className="brand-name">aegis<span className="brand-period">.</span></span>
        </Link>

        <div className="event-heading" aria-live="polite">
          <label className="sr-only" htmlFor="shell-event-select">Exercise</label>
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
          <span className="exercise-chip"><span className="chip-dot" />Synthetic exercise</span>
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
          <div className={`shell-freshness${stream.reconnecting ? " is-reconnecting" : ""}`}>
            <span className="shell-freshness-dot" />
            <span>{stream.reconnecting
              ? `Reconnecting · last update ${freshnessLabel(stream.lastUpdated, now).replace("Updated ", "")}`
              : freshnessLabel(stream.lastUpdated, now)}</span>
          </div>
          <div className="topbar-status" aria-live="polite">
            <span className={`engine-dot engine-dot-${engineState}`} />
            <span className="engine-label">{engineText}</span>
          </div>
          <label className="theme-control">
            <span>Theme</span>
            <select aria-label="Theme" value={themePreference} onChange={(event) => chooseTheme(event.target.value)}>
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
        </div>
      </header>

      {stream.reconnecting && stream.lastUpdated !== null && (
        <div className="shell-connection-notice" role="status">
          Live updates are reconnecting. The last successful snapshot is still shown.
        </div>
      )}

      <main className="page-shell">{children}</main>
    </div>
  );
}
