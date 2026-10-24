import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  IconChartBar,
  IconFileReport,
  IconInfoCircle,
  IconLayoutDashboard,
  IconShieldCheck,
} from "@tabler/icons-react";
import { getSnapshot } from "../lib/api";
import { engineLabel } from "../lib/format";
import type { Health } from "../lib/types";

interface AppFrameProps {
  children: ReactNode;
}

interface HeaderState {
  eventName: string;
  health: Health | null;
  connected: boolean;
}

const navigation = [
  { to: "/dashboard", label: "Operations", icon: IconLayoutDashboard },
  { to: "/report", label: "New report", icon: IconFileReport },
  { to: "/evaluation", label: "Evaluation", icon: IconChartBar },
  { to: "/about", label: "About", icon: IconInfoCircle },
] as const;

export function AppFrame({ children }: AppFrameProps) {
  const [header, setHeader] = useState<HeaderState>({
    eventName: "Loading current exercise",
    health: null,
    connected: false,
  });

  useEffect(() => {
    let mounted = true;
    const refreshHeader = async () => {
      try {
        const snapshot = await getSnapshot();
        if (mounted) {
          setHeader({
            eventName: snapshot.event.name,
            health: snapshot.health,
            connected: true,
          });
        }
      } catch {
        if (mounted) setHeader((previous) => ({ ...previous, connected: false }));
      }
    };

    void refreshHeader();
    const interval = window.setInterval(() => void refreshHeader(), 5_000);
    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

  const engineText = header.health ? engineLabel(header.health) : "Checking model status";
  const engineState = header.connected ? (header.health?.model_ready ? "ready" : "degraded") : "offline";

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/dashboard" className="brand" aria-label="Aegis operations home">
          <span className="brand-mark"><IconShieldCheck size={19} stroke={1.8} /></span>
          <span className="brand-name">aegis<span className="brand-period">.</span></span>
        </Link>

        <div className="event-heading" aria-live="polite">
          <span className="event-name">{header.eventName}</span>
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

        <div className="topbar-status" aria-live="polite">
          <span className={`engine-dot engine-dot-${engineState}`} />
          <span className="engine-label">{engineText}</span>
        </div>
      </header>

      <main className="page-shell">{children}</main>
    </div>
  );
}
