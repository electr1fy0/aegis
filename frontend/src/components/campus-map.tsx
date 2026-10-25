import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { IconFocusCentered, IconMapPin, IconMinus, IconPlus } from "@tabler/icons-react";
import campus from "../../../data/campus-map.json";
import type { Zone } from "../lib/types";
import { Button } from "./ui/button";
import { MenuSelect } from "./ui/menu-select";
import "./campus-map.css";

export const CAMPUS_ZONE_IDS = new Set(campus.zones.map((zone) => zone.id));

type Region = (typeof campus.regions)[number];

interface CampusMapProps {
  zones: Zone[];
  value: string;
  onValueChange: (zoneId: string) => void;
  disabled?: boolean;
  counts?: Record<string, number>;
  showHeading?: boolean;
}

const center = (region: Region) => ({
  x: region.points.reduce((sum, point) => sum + point[0]!, 0) / region.points.length,
  y: region.points.reduce((sum, point) => sum + point[1]!, 0) / region.points.length,
});

/** Original map artwork with independently selectable, traced SVG regions. */
export function CampusMap({ zones, value, onValueChange, disabled = false, counts = {}, showHeading = true }: CampusMapProps) {
  const descriptionId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const shapes = useRef(new Map<string, SVGPolygonElement>());
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const [zoom, setZoom] = useState(1);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const regionZones = useMemo(() => {
    const available = new Map(zones.filter((zone) => zone.selectable !== false).map((zone) => [zone.id, zone]));
    return campus.regions.flatMap((region) => {
      const choices = region.zoneIds.flatMap((id) => available.has(id) ? [available.get(id)!] : []);
      return choices.length ? [{ region, choices }] : [];
    });
  }, [zones]);
  const selected = regionZones.find(({ choices }) => choices.some((zone) => zone.id === value));
  const pending = regionZones.find(({ region }) => region.id === pendingId);
  const highlighted = regionZones.find(({ region }) => region.id === (hoveredId ?? focusedId)) ?? selected;
  const selectedLabel = zones.find((zone) => zone.id === value)?.label;
  const tabStop = focusedId ?? selected?.region.id ?? regionZones[0]?.region.id;

  const selectedRegionId = selected?.region.id ?? null;
  useEffect(() => {
    setFocusedId(selectedRegionId);
    setPendingId(null);
  }, [value, selectedRegionId]);

  if (regionZones.length === 0) return null;

  const selectRegion = (region: Region, choices: Zone[]) => {
    if (disabled || dragged.current) return;
    setFocusedId(region.id);
    setPendingId(choices.length > 1 ? region.id : null);
    if (choices.length === 1) onValueChange(choices[0]!.id);
  };

  const changeZoom = (next: number) => {
    const container = viewport.current;
    if (!container) return;
    const clamped = Math.max(1, Math.min(4, next));
    const cx = (container.scrollLeft + container.clientWidth / 2) / zoom;
    const cy = (container.scrollTop + container.clientHeight / 2) / zoom;
    setZoom(clamped);
    requestAnimationFrame(() => {
      container.scrollLeft = clamped === 1 ? 0 : cx * clamped - container.clientWidth / 2;
      container.scrollTop = clamped === 1 ? 0 : cy * clamped - container.clientHeight / 2;
    });
  };

  const handleRegionKey = (event: KeyboardEvent<SVGPolygonElement>, region: Region, choices: Zone[]) => {
    if (disabled) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      event.stopPropagation();
      dragged.current = false;
      selectRegion(region, choices);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = center(region);
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const next = event.key === "Home" ? regionZones[0] : event.key === "End" ? regionZones.at(-1) : regionZones
      .filter(({ region: candidate }) => {
        const point = center(candidate);
        return (horizontal ? point.x - origin.x : point.y - origin.y) * direction > 1;
      })
      .sort((left, right) => {
        const score = (candidate: Region) => {
          const point = center(candidate);
          const across = horizontal ? point.y - origin.y : point.x - origin.x;
          const along = horizontal ? point.x - origin.x : point.y - origin.y;
          return Math.abs(along) + Math.abs(across) * 3;
        };
        return score(left.region) - score(right.region);
      })[0];
    if (next) {
      setFocusedId(next.region.id);
      const shape = shapes.current.get(next.region.id);
      shape?.focus({ preventScroll: true });
      shape?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    }
  };

  return <section className="campus-map" aria-label="Campus location picker">
    <div className="campus-map-toolbar">
      {showHeading && <div className="campus-map-heading"><IconMapPin size={17} /><strong>Choose on the campus map</strong></div>}
      <div className="campus-map-zoom" role="group" aria-label="Map zoom">
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Zoom out" disabled={zoom === 1} onClick={() => changeZoom(zoom - 0.5)}><IconMinus /></Button>
        <span aria-label={`Map zoom ${Math.round(zoom * 100)} percent`}>{Math.round(zoom * 100)}%</span>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Zoom in" disabled={zoom === 4} onClick={() => changeZoom(zoom + 0.5)}><IconPlus /></Button>
        <Button type="button" size="sm" variant="ghost" aria-label="Fit campus map" disabled={zoom === 1} onClick={() => changeZoom(1)}><IconFocusCentered /><span>Fit</span></Button>
      </div>
    </div>
    <p className="campus-map-help" id={descriptionId}>Select a building or area. Zoom in for smaller regions, then drag to move. Use arrow keys to explore and Enter to select.</p>
    <div className="campus-map-viewport" ref={viewport} data-zoomed={zoom > 1}
      onPointerDown={(event) => {
        dragged.current = false;
        if (event.button !== 0 || event.pointerType !== "mouse") return;
        drag.current = { x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop, moved: false };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || zoom === 1) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (Math.hypot(dx, dy) > 6) {
          start.moved = true;
          dragged.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }
        if (start.moved) {
          event.currentTarget.scrollLeft = start.left - dx;
          event.currentTarget.scrollTop = start.top - dy;
        }
      }}
      onPointerUp={(event) => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; }}>
      <div className="campus-map-canvas" style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}>
        <svg viewBox={campus.viewBox.join(" ")} className="campus-map-svg" role="group" aria-label="VIT Vellore campus regions" aria-describedby={descriptionId}>
          <image href={campus.image} width={campus.width} height={campus.height} aria-hidden="true" pointerEvents="none" />
          {regionZones.map(({ region, choices }) => {
            const isSelected = choices.some((zone) => zone.id === value);
            const count = choices.reduce((total, zone) => total + (counts[zone.id] ?? 0), 0);
            const point = center(region);
            return <g key={region.id}>
              <polygon ref={(node) => { if (node) shapes.current.set(region.id, node); else shapes.current.delete(region.id); }}
                points={region.points.map((point) => point.join(",")).join(" ")}
                className="campus-map-region" role="button"
                aria-label={choices.length === 1 ? `Select ${choices[0]!.label}` : `Choose a location in ${region.label}`}
                aria-pressed={isSelected} aria-disabled={disabled || undefined}
                tabIndex={disabled ? -1 : tabStop === region.id ? 0 : -1}
                data-selected={isSelected} data-pending={pendingId === region.id}
                onClick={() => selectRegion(region, choices)}
                onKeyDown={(event) => handleRegionKey(event, region, choices)}
                onFocus={() => setFocusedId(region.id)}
                onMouseEnter={() => setHoveredId(region.id)} onMouseLeave={() => setHoveredId(null)}>
                <title>{region.label}{count ? ` · ${count} active groups` : ""}</title>
              </polygon>
              {count > 0 && <g className="campus-map-count" aria-hidden="true" pointerEvents="none" transform={`translate(${point.x}, ${point.y - 10})`}>
                <circle r="9" /><text textAnchor="middle" dy="3.5">{count}</text>
              </g>}
            </g>;
          })}
        </svg>
      </div>
    </div>
    {pending && <div className="campus-map-shared-region">
      <label htmlFor={`${descriptionId}-region`}>{pending.region.label} — choose a location</label>
      <MenuSelect id={`${descriptionId}-region`} disabled={disabled} value={pending.choices.some((zone) => zone.id === value) ? value : ""}
        onChange={(event) => { onValueChange(event.target.value); setPendingId(null); requestAnimationFrame(() => shapes.current.get(pending.region.id)?.focus({ preventScroll: true })); }}>
        <option value="" disabled>Choose a location</option>
        {pending.choices.map((zone) => <option key={zone.id} value={zone.id}>{zone.label}</option>)}
      </MenuSelect>
    </div>}
    <div className="campus-map-selection" aria-live="polite" aria-atomic="true">
      <span>{selectedLabel ? <>Selected: <strong>{selectedLabel}</strong></> : "No location selected"}</span>
      {value && <Button type="button" size="xs" variant="ghost" disabled={disabled} onClick={() => { setPendingId(null); onValueChange(""); requestAnimationFrame(() => shapes.current.get(regionZones[0]!.region.id)?.focus({ preventScroll: true })); }}>Clear location</Button>}
    </div>
    <div className="campus-map-caption"><span>{highlighted?.region.label ?? "VIT University, Vellore"}</span><span>Reference map · regions are approximate</span></div>
  </section>;
}
