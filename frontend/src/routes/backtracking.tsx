import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Marker, OceanMap, MapPolyline, MapCircle } from "../components/OceanMap";

import { KeyVal, OutcomeBadge, Panel, Stat, StatusDot } from "../components/ui-kit";
import { useIncident } from "../context/IncidentContext";
import {
  Compass,
  Clock,
  Waves,
  Wind,
  ShieldAlert,
  ArrowRight,
  RotateCcw,
  Navigation,
} from "lucide-react";

export const Route = createFileRoute("/backtracking")({
  head: () => ({
    meta: [
      { title: "Drift Backtracking & Origin — O.S.I.S. Maritime Intelligence" },
      {
        name: "description",
        content:
          "Reverse Lagrangian hydrodynamic advection model estimating oil spill release origin and temporal release window.",
      },
      { property: "og:title", content: "Drift Backtracking & Origin — O.S.I.S." },
      {
        property: "og:description",
        content:
          "Scrub the backward drift timeline from satellite detection back to the probable release point.",
      },
    ],
  }),
  component: BacktrackingPage,
});

const utc = (iso: string) => {
  if (!iso) return "N/A";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
};

function BacktrackingPage() {
  const { activeReport, autoLoading, historyLoading, isSwitchingIncident } = useIncident();
  const [direction, setDirection] = useState<"backward" | "forward">("backward");
  const [sliderIndex, setSliderIndex] = useState(0);
  const [showEnvDetails, setShowEnvDetails] = useState(false);

  if (autoLoading || historyLoading || isSwitchingIncident) {
    return (
      <div className="mx-auto max-w-4xl py-16 text-center space-y-4">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded border border-border bg-secondary">
          <Compass className="h-6 w-6 animate-spin text-[var(--accent-amber)]" />
        </div>
        <div>
          <h2 className="text-base font-semibold text-foreground font-mono">
            Loading Hydrodynamic Drift Simulation…
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Running Runge-Kutta Lagrangian particle advection.
          </p>
        </div>
      </div>
    );
  }

  if (!activeReport) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto py-8">
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-mono text-xs text-[var(--accent-amber)] uppercase tracking-wider">
            <Compass className="h-4 w-4" />
            Drift &middot; Hydrodynamic Advection
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Lagrangian Drift Simulation
          </h1>
          <p className="text-sm text-muted-foreground">
            No active incident loaded. Select an incident from the header dropdown or run an analysis from the Investigation page.
          </p>
        </div>
        <Panel className="flex flex-col items-center justify-center p-12 text-center space-y-4">
          <p className="text-sm font-medium text-foreground">No active incident analysis</p>
          <p className="text-xs text-muted-foreground max-w-sm">
            Load an incident to view reverse drift trajectories and estimated release origin.
          </p>
          <Link
            to="/analysis"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90"
          >
            <span>Open Analyze Incident</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Panel>
      </div>
    );
  }

  const report = activeReport;
  const { origin, backward, forward, outcome, spill, environment } = report;
  const isSpillDetected = outcome === "SPILL_DETECTED" && !!spill;
  const isNoSpill = outcome === "NO_SPILL_DETECTED";
  const isInconclusive = outcome === "ANALYSIS_INCONCLUSIVE" || (!isSpillDetected && !isNoSpill);

  // Backward path: index 0 = image time (t=0), last = furthest back (origin)
  const backwardPath = [...(backward ?? [])].reverse();
  const forwardPath = forward ?? [];

  const activePath = direction === "backward" ? backwardPath : forwardPath;
  const hasPath = activePath.length > 0;
  const MAX_IDX = hasPath ? activePath.length - 1 : 0;
  const currentStep = Math.min(sliderIndex, MAX_IDX);
  const point = hasPath ? activePath[currentStep] : null;
  const visible = hasPath ? activePath.slice(0, currentStep + 1) : [];

  // Map center: prefer spill centroid, then origin [lat, lon]
  const mapCenter: [number, number] = spill
    ? [spill.metrics.centroid.lat, spill.metrics.centroid.lon]
    : origin
      ? [origin.lat, origin.lon]
      : report.scene.bbox
        ? [
            (report.scene.bbox[1] + report.scene.bbox[3]) / 2,
            (report.scene.bbox[0] + report.scene.bbox[2]) / 2,
          ]
        : [15.25, 72.45];


  // Derive human-readable environmental variables
  const currentSpeed = environment["current_speed"] ?? environment["current_velocity"] ?? environment["surface_current_mps"];
  const windSpeed = environment["wind_speed"] ?? environment["wind_speed_mps"] ?? environment["wind_velocity"];
  const waveHeight = environment["wave_height"] ?? environment["significant_wave_height_m"];

  return (
    <div className="space-y-6">
      {/* 1. SECTION HEADER */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/70 pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-mono text-xs text-[var(--accent-amber)] uppercase tracking-wider">
            <Compass className="h-4 w-4" />
            Drift &middot; Hydrodynamic Advection Analysis
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground font-sans">
            Spill Drift Modeling &amp; Trajectory
          </h1>
          <p className="text-xs text-muted-foreground pt-0.5">
            What happens if we track the spill backward to its source, or forward to predict its spread?
          </p>
        </div>
        <OutcomeBadge outcome={outcome ?? report.status} />
      </div>

      {/* Outcome Banner if clean scene or inconclusive */}
      {(isNoSpill || isInconclusive) && (
        <div className="rounded-lg border border-border bg-card/70 p-4 text-xs font-mono space-y-1">
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <StatusDot label={outcome ?? report.status} />
            <span>Advection Simulation Status</span>
          </div>
          <p className="text-muted-foreground">
            {isNoSpill
              ? "Hydrodynamic drift backtracking is not executed when no oil spill is detected on the surface."
              : report.outcomeMessage || "Drift analysis inconclusive due to indeterminate surface spill geometry."}
          </p>
          {report.outcomeReason && (
            <p className="text-muted-foreground/80 italic">{report.outcomeReason}</p>
          )}
        </div>
      )}

      {/* 2. DIRECTION TOGGLE & OBJECTIVE STRIP */}
      {isSpillDetected && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-lg border border-border bg-card p-4">
          <div>
            <div className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground font-mono">
              Simulation Mode
            </div>
            <div className="text-sm font-semibold text-foreground mt-0.5">
              {direction === "backward"
                ? "Backward Advection — Locate Source Region"
                : "Forward Forecast — Predict Slick Spread"}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 max-w-xl">
              {direction === "backward"
                ? "Simulates reverse currents and leeway winds to backtrack from satellite detection back to the probable release point."
                : `Simulates hydrodynamic dispersion forward ${report.forecastHours} hours to forecast where the slick will travel and spread.`}
            </p>
          </div>

          <div className="inline-flex rounded border border-border bg-secondary/80 p-1 self-start sm:self-auto font-mono text-xs">
            <button
              type="button"
              onClick={() => {
                setDirection("backward");
                setSliderIndex(0);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-semibold transition-colors ${
                direction === "backward"
                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                  : "text-muted-foreground hover:text-foreground border border-transparent"
              }`}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Backward (Origin)</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setDirection("forward");
                setSliderIndex(0);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded font-semibold transition-colors ${
                direction === "forward"
                  ? "bg-[var(--primary)]/20 text-[var(--accent-blue)] border border-[var(--primary)]/30"
                  : "text-muted-foreground hover:text-foreground border border-transparent"
              }`}
            >
              <Navigation className="h-3.5 w-3.5" />
              <span>Forward (Forecast)</span>
            </button>
          </div>
        </div>
      )}

      {/* 3. MAIN WORKSPACE: MAP & INTERACTIVE SCRUBBER */}
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Panel
          title={
            direction === "backward"
              ? "Reverse Lagrangian Drift (Backtracking to Origin)"
              : `Forward Hydrodynamic Forecast (+${report.forecastHours}h Spread)`
          }
          badge={
            <span className="rounded bg-secondary/80 px-1.5 py-0.2 text-[9px] font-mono text-muted-foreground uppercase">
              {direction === "backward" ? "RK4 Reverse Advection" : "Eulerian-Lagrangian Forward"}
            </span>
          }
        >
          <OceanMap
            height={490}
            initialCenter={mapCenter}
            legend={
              <div className="space-y-1.5 text-xs">
                <div className="font-semibold text-foreground border-b border-border/50 pb-1">
                  DRIFT LAYERS
                </div>
                {spill && (
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent-blue)]" />
                    <span>Slick Centroid (t = 0h)</span>
                  </div>
                )}
                {direction === "backward" && origin && (
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
                    <span>Modeled Origin Cell</span>
                  </div>
                )}
                {hasPath && (
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block w-3 border-t-2 ${
                        direction === "backward"
                          ? "border-dashed border-amber-400"
                          : "border-cyan-400"
                      }`}
                    />
                    <span>
                      {direction === "backward" ? "Reverse Drift Path" : "Forecast Path"}
                    </span>
                  </div>
                )}
                {point && (
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-white" />
                    <span>Scrubbed Position (t = {point.hours > 0 ? `+${point.hours.toFixed(0)}` : point.hours.toFixed(0)}h)</span>
                  </div>
                )}
              </div>
            }
          >
            {/* Faint complete path */}
            {hasPath && (
              <MapPolyline
                positions={activePath.map((p) => [p.lat, p.lon])}
                pathOptions={{
                  color: "var(--map-label)",
                  dashArray: "4 6",
                  weight: 1.5,
                  opacity: 0.35,
                }}
              />
            )}

            {/* Active scrubbed portion */}
            {hasPath && (
              <MapPolyline
                positions={visible.map((p) => [p.lat, p.lon])}
                pathOptions={{
                  color: direction === "backward" ? "var(--accent-amber)" : "#22d3ee",
                  weight: 3,
                }}
              />
            )}

            {/* Slick Detection at t=0 */}
            {spill && (
              <Marker
                lat={spill.metrics.centroid.lat}
                lon={spill.metrics.centroid.lon}
                label="Observed Slick (t=0)"
                pulse
              />
            )}

            {/* Modeled Origin (backward mode) */}
            {direction === "backward" && origin && (
              <>
                <Marker
                  lat={origin.lat}
                  lon={origin.lon}
                  color="var(--accent-amber)"
                  label="Modeled Origin"
                />
                <MapCircle
                  center={[origin.lat, origin.lon]}
                  radius={(origin.uncertaintyKm || 5) * 1000}
                  pathOptions={{
                    color: "var(--accent-amber)",
                    fillColor: "var(--accent-amber)",
                    fillOpacity: 0.08,
                    dashArray: "4 4",
                    weight: 1.5,
                  }}
                />
              </>
            )}

            {/* Active scrubbed particle */}
            {point && (
              <Marker
                lat={point.lat}
                lon={point.lon}
                color={direction === "backward" ? "var(--accent-amber)" : "#22d3ee"}
                label={`t = ${point.hours > 0 ? `+${point.hours.toFixed(0)}` : point.hours.toFixed(0)}h`}
                pulse
                active
              />
            )}
          </OceanMap>

          {/* Interactive Timeline Scrubber */}
          {hasPath ? (
            <div className="mt-5 rounded-lg border border-border/80 bg-card/70 p-4 space-y-3 font-mono">
              <div className="flex items-baseline justify-between text-xs">
                <span className="uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-primary" />
                  <span>Timeline Scrubber ({direction === "backward" ? "Reverse Hours" : "Forecast Hours"})</span>
                </span>
                <span className="font-bold text-foreground tabular-nums">
                  {point
                    ? `t = ${point.hours > 0 ? `+${point.hours.toFixed(0)}` : point.hours.toFixed(0)}h · ${utc(point.timestamp)}`
                    : "t = 0 (detection)"}
                </span>
              </div>

              <input
                type="range"
                className="om-range w-full"
                min={0}
                max={MAX_IDX}
                step={1}
                value={sliderIndex}
                aria-label="Simulation time scrubber"
                style={{ ["--fill" as string]: `${(sliderIndex / (MAX_IDX || 1)) * 100}%` }}
                onChange={(e) => setSliderIndex(Number(e.target.value))}
              />

              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>t = 0h (Satellite Detection)</span>
                {activePath[MAX_IDX] && (
                  <span className={direction === "backward" ? "text-[var(--accent-amber)] font-medium" : "text-cyan-400 font-medium"}>
                    t = {activePath[MAX_IDX].hours > 0 ? `+${activePath[MAX_IDX].hours.toFixed(0)}` : activePath[MAX_IDX].hours.toFixed(0)}h ({direction === "backward" ? "Origin" : "End Forecast"})
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between pt-1">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSliderIndex(0)}
                    className="rounded border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/60 transition-colors"
                  >
                    Detection (t=0)
                  </button>
                  <button
                    type="button"
                    onClick={() => setSliderIndex(MAX_IDX)}
                    className={`rounded border px-2.5 py-1 text-[11px] transition-colors ${
                      direction === "backward"
                        ? "border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
                        : "border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10"
                    }`}
                  >
                    {direction === "backward" ? "Jump to Origin" : "Jump to Forecast"}
                  </button>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  Uncertainty Radius: ±{point?.uncertaintyKm ?? "—"} km
                </span>
              </div>
            </div>
          ) : (
            <div className="mt-4 rounded border border-border/80 bg-secondary/30 p-4 text-center text-xs font-mono text-muted-foreground">
              {isNoSpill
                ? "Drift tracking is not executed when no spill is detected."
                : "Simulation trajectory data unavailable for this selection."}
            </div>
          )}
        </Panel>

        {/* Right Telemetry Column */}
        <div className="space-y-5 font-mono">
          {/* Origin / Spread Target Card */}
          <Panel
            title={direction === "backward" ? "Estimated Origin Region" : "Spread Forecast Telemetry"}
            badge={
              <span className="rounded bg-secondary/80 px-1.5 py-0.2 text-[9px] font-mono text-muted-foreground uppercase">
                {direction === "backward" ? "Source Cell" : "Advection Vector"}
              </span>
            }
          >
            {direction === "backward" ? (
              origin ? (
                <div className="space-y-3">
                  <KeyVal k="Origin Lat" v={`${origin.lat.toFixed(5)}° N`} />
                  <KeyVal k="Origin Lon" v={`${origin.lon.toFixed(5)}° E`} />
                  <KeyVal k="Sensitivity Radius" v={`±${origin.uncertaintyKm} km`} />
                  <KeyVal k="Release Window Start" v={utc(origin.releaseWindow.start)} />
                  <KeyVal k="Release Window End" v={utc(origin.releaseWindow.end)} />
                  <KeyVal
                    k="Estimated Elapsed Time"
                    v={`${report.age ? `${report.age.minHours}–${report.age.maxHours}` : "6"} hours`}
                  />

                  <div className="rounded border border-amber-500/30 bg-amber-500/5 p-2.5 text-[11px] text-amber-200/90 flex items-start gap-2">
                    <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
                    <span>
                      Sensitivity radius represents hydrodynamic dispersion uncertainty, not a definitive legal boundary.
                    </span>
                  </div>
                </div>
              ) : (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  Origin point unavailable for this incident state.
                </div>
              )
            ) : (
              <div className="space-y-3">
                <KeyVal k="Forecast Horizon" v={`${report.forecastHours} hours`} />
                <KeyVal k="Simulation Steps" v={`${forwardPath.length} intervals`} />
                {point && (
                  <>
                    <KeyVal k="Step Coordinates" v={`${point.lat.toFixed(4)}°N, ${point.lon.toFixed(4)}°E`} />
                    <KeyVal k="Step Timestamp" v={utc(point.timestamp)} />
                    <KeyVal k="Step Dispersion" v={`±${point.uncertaintyKm} km`} />
                  </>
                )}
                <div className="rounded border border-cyan-500/30 bg-cyan-500/5 p-2.5 text-[11px] text-cyan-200/90">
                  Forward advection forecasts trajectory under prevailing CMEMS currents and wind forcing.
                </div>
              </div>
            )}
          </Panel>

          {/* Environmental Summary (Visible First) */}
          <Panel
            title="Environmental Forcing Summary"
            badge={
              <span className="rounded bg-secondary/80 px-1.5 py-0.2 text-[9px] font-mono text-muted-foreground uppercase">
                Observed Forcing
              </span>
            }
          >
            <div className="space-y-2.5 text-xs">
              <div className="flex items-center justify-between border-b border-border/50 pb-2">
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <Wind className="h-3.5 w-3.5 text-primary" /> Surface Wind
                </span>
                <span className="font-semibold text-foreground font-mono">
                  {windSpeed ? `${windSpeed} m/s` : "Normal (ERA5 reanalysis)"}
                </span>
              </div>
              <div className="flex items-center justify-between border-b border-border/50 pb-2">
                <span className="text-muted-foreground flex items-center gap-1.5">
                  <Waves className="h-3.5 w-3.5 text-primary" /> Ocean Currents
                </span>
                <span className="font-semibold text-foreground font-mono">
                  {currentSpeed ? `${currentSpeed} m/s` : "CMEMS Copernicus"}
                </span>
              </div>
              <div className="flex items-center justify-between border-b border-border/50 pb-2">
                <span className="text-muted-foreground">Advection Integration</span>
                <span className="font-semibold text-foreground font-mono">4th-order Runge-Kutta</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Windage Leeway</span>
                <span className="font-semibold text-emerald-400 font-mono">3.0% factor</span>
              </div>

              {/* Collapsible Model Details */}
              {environment && Object.keys(environment).length > 0 && (
                <div className="pt-2 border-t border-border/60">
                  <button
                    type="button"
                    onClick={() => setShowEnvDetails(!showEnvDetails)}
                    className="w-full flex items-center justify-between py-1 text-[11px] text-[var(--accent-blue)] hover:underline"
                  >
                    <span>{showEnvDetails ? "Hide" : "Show"} Environmental Model Details</span>
                    <span>{showEnvDetails ? "▲" : "▼"}</span>
                  </button>

                  {showEnvDetails && (
                    <div className="mt-2 space-y-1.5 pt-2 border-t border-border/40 text-[11px] text-muted-foreground">
                      {Object.entries(environment).map(([k, v]) => (
                        <KeyVal key={k} k={k.replaceAll("_", " ")} v={String(v)} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </Panel>

          {/* Next Stage Navigation */}
          <Panel title="Attribution Workflow">
            <div className="space-y-2 text-xs text-muted-foreground">
              <p className="leading-relaxed">
                The computed release origin and temporal release window directly constrain
                the spatiotemporal search corridor for AIS vessel correlation.
              </p>
              <Link
                to="/ais"
                className="mt-2 inline-flex items-center justify-center gap-2 rounded bg-primary px-3 py-2 text-xs font-semibold font-mono text-primary-foreground hover:opacity-90 transition-opacity w-full"
              >
                <span>Proceed to Vessel Attribution</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
