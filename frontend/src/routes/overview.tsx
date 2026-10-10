import { createFileRoute, Link } from "@tanstack/react-router";
import { useIncident } from "../context/IncidentContext";
import { getIncidentLabel } from "../api/incidents";
import { OceanMap, Marker, MapGeoJSON, MapPolyline, MapCircle } from "../components/OceanMap";

import { KeyVal, OutcomeBadge, Panel, Stat } from "../components/ui-kit";
import {
  Radar,
  Compass,
  Ship,
  Users,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  Loader2,
  Layers,
  MapPin,
  Clock,
  Target,
  Activity,
  LayoutDashboard,
} from "lucide-react";

export const Route = createFileRoute("/overview")(
  {
    head: () => ({
      meta: [
        {
          title:
            "O.S.I.S. — Oil Spill Identification & Source Attribution System",
        },
        {
          name: "description",
          content:
            "Operational satellite radar spill detection, Lagrangian hydrodynamic drift backtracking, and AIS vessel correlation for maritime surveillance.",
        },
      ],
    }),
    component: OverviewDashboard,
  },
);

const utc = (iso: string) => {
  if (!iso) return "N/A";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
};

function OverviewDashboard() {
  const { activeReport, autoLoading, historyLoading } = useIncident();

  // Loading state
  if (autoLoading || historyLoading) {
    return (
      <div className="mx-auto max-w-5xl py-20 text-center space-y-6">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-md border border-[var(--primary)]/20 bg-[var(--primary)]/5">
          <Loader2 className="h-7 w-7 animate-spin text-[var(--primary)]" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-foreground font-mono tracking-wide">
            O.S.I.S.
          </h1>
          <p className="text-sm text-muted-foreground mt-1.5">
            Initializing incident data…
          </p>
        </div>
      </div>
    );
  }

  // No report loaded — prompt to analyze
  if (!activeReport) {
    return (
      <div className="mx-auto max-w-3xl py-16 space-y-8">
        <div className="text-center space-y-4">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-md border border-[var(--primary)]/20 bg-[var(--primary)]/5">
            <LayoutDashboard className="h-6 w-6 text-[var(--primary)]" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            O.S.I.S.
          </h1>
          <p className="text-sm text-muted-foreground">
            Oil Spill Identification &amp; Source Attribution System
          </p>
          <p className="text-xs text-muted-foreground max-w-lg mx-auto leading-relaxed">
            Autonomous pipeline integrating Sentinel-1 SAR detection,
            Lagrangian drift backtracking, and AIS vessel correlation to detect
            marine spills, locate origins, and identify candidate sources.
          </p>
          <Link
            to="/analysis"
            className="inline-flex items-center gap-2 rounded-md bg-[var(--primary)] px-5 py-2.5 text-xs font-mono font-semibold text-[var(--primary-foreground)] mt-4 hover:opacity-90 transition-opacity"
          >
            Launch Investigation
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    );
  }

  const report = activeReport;
  const { spill, origin, candidates, anomalies, outcome, backward, forward } =
    report;
  const topCandidate = candidates[0] ?? null;
  const incidentLabel = getIncidentLabel(report);
  const isSpillDetected = outcome === "SPILL_DETECTED" && !!spill;
  const isNoSpill = outcome === "NO_SPILL_DETECTED";
  const isDemo = report.mode === "DEMO" || !report.mode;

  const hasPolygon = !!spill?.geometry;
  const driftPath = backward ?? [];
  const hasDrift = driftPath.length > 0;

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


  // Pipeline stages: Detection -> Drift -> AIS Correlation -> Attribution
  const pipelineSteps = [
    {
      stage: "Detection",
      label: "Satellite Spill Detection",
      icon: Radar,
      status: spill ? ("completed" as const) : isNoSpill ? ("completed" as const) : ("inconclusive" as const),
      statusBadge: spill ? "Completed" : isNoSpill ? "Clean (Completed)" : "Inconclusive",
      result: spill
        ? `Candidate spill identified (${(spill.maskAreaKm2 ?? spill.metrics.areaKm2)} km², ${(spill.confidence * 100).toFixed(0)}% confidence)`
        : isNoSpill
          ? "No dark-slick detected above backscatter threshold"
          : "SAR imagery classification inconclusive",
    },
    {
      stage: "Drift",
      label: "Hydrodynamic Drift & Origin",
      icon: Compass,
      status: origin
        ? ("completed" as const)
        : hasDrift
          ? (report.stageStatus?.["forecast"]?.status === "partial" ? ("partial" as const) : ("completed" as const))
          : isNoSpill
            ? ("not_assessed" as const)
            : ("unavailable" as const),
      statusBadge: origin ? "Completed" : hasDrift ? (report.stageStatus?.["forecast"]?.status === "partial" ? "Partial" : "Completed") : isNoSpill ? "Not Assessed" : "Unavailable",
      result: origin
        ? `${report.hindcastHours || 6}h Hindcast → Origin → ${report.forecastHours || 24}h Forecast (±${origin.uncertaintyKm} km)`
        : hasDrift
          ? (report.stageStatus?.["forecast"]?.status === "partial" ? (report.stageStatus?.["forecast"]?.reason || "Trajectory truncated: reached land or data boundary") : `Drift trajectory computed (${driftPath.length} steps)`)
          : isNoSpill
            ? "Drift analysis skipped — clean sea surface"
            : "Hydrodynamic advection data unavailable",
    },
    {
      stage: "AIS Correlation",
      label: "Spatiotemporal AIS Correlation",
      icon: Ship,
      status: candidates.length > 0
        ? ("completed" as const)
        : isNoSpill
          ? ("not_assessed" as const)
          : report?.stageStatus?.["ais"]?.status === "unavailable"
            ? ("unavailable" as const)
            : ("incomplete" as const),
      statusBadge: candidates.length > 0 ? "Completed" : isNoSpill ? "Not Assessed" : report?.stageStatus?.["ais"]?.status === "unavailable" ? "Unavailable" : "No Candidates",
      result:
        candidates.length > 0
          ? `${candidates.length} candidate vessel${candidates.length !== 1 ? "s" : ""} correlated with release corridor`
          : isNoSpill
            ? "Vessel correlation skipped — clean sea surface"
            : report?.stageStatus?.["ais"]?.status === "unavailable"
              ? "Historical AIS observations are unavailable for this replay period."
              : "No compatible vessels found within spatio-temporal window",
    },
    {
      stage: "Attribution",
      label: "Source Attribution & Ranking",
      icon: Users,
      status: topCandidate
        ? ("completed" as const)
        : isNoSpill
          ? ("not_assessed" as const)
          : ("inconclusive" as const),
      statusBadge: topCandidate ? "Completed" : isNoSpill ? "Not Assessed" : "Inconclusive",
      result: topCandidate
        ? `Leading source candidate: ${topCandidate.name} (Score: ${topCandidate.score}/100)`
        : isNoSpill
          ? "Attribution not required"
          : report?.stageStatus?.["ais"]?.status === "unavailable"
            ? "Vessel attribution cannot be established from the available evidence."
            : "Source attribution inconclusive from current evidence",
    },
  ];

  // KPI data
  const kpis = [
    {
      label: "Spill Area",
      value: spill ? `${(spill.maskAreaKm2 ?? spill.metrics.areaKm2)} km²` : isNoSpill ? "Clean" : "—",
      detail: spill ? `${spill.metrics.lengthM.toFixed(0)}m × ${spill.metrics.widthM.toFixed(0)}m` : "SAR segmentation",
      color: "var(--accent-blue)",
    },
    {
      label: "Estimated Age",
      value: report.age ? `${report.age.minHours}–${report.age.maxHours}h` : isNoSpill ? "N/A" : "—",
      detail: report.age ? `${report.age.confidence} confidence` : "Morphological window",
      color: "var(--accent-amber)",
    },
    {
      label: "Confidence",
      value: spill ? `${(spill.confidence * 100).toFixed(0)}%` : isNoSpill ? "High" : "—",
      detail: spill?.confidenceMeaning ?? "Classification quality",
      color: "var(--accent-emerald)",
    },
    {
      label: "Origin",
      value: origin ? `${origin.lat.toFixed(3)}°N` : isNoSpill ? "N/A" : "—",
      detail: origin ? `${origin.lon.toFixed(3)}°E · ±${origin.uncertaintyKm} km` : "Backtracked origin",
      color: "var(--accent-amber)",
    },
    {
      label: "Vessels",
      value: candidates.length > 0 ? `${candidates.length}` : isNoSpill ? "N/A" : "0",
      detail: topCandidate ? `Top: ${topCandidate.name}` : "AIS correlation",
      color: "var(--accent-blue)",
    },
  ];

  return (
    <div className="space-y-7">
      {/* 1. OPERATIONAL OVERVIEW HEADER */}
      <div className="space-y-5">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-mono text-[var(--primary)] uppercase tracking-[0.14em] mb-2">
            <LayoutDashboard className="h-3.5 w-3.5" />
            <span>Maritime Intelligence · Situational Awareness</span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Operational Overview
          </h1>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl leading-relaxed">
            {isSpillDetected
              ? `Active oil slick detected in Sentinel-1 SAR imagery with ${report.forecastHours}h hydrodynamic drift analysis and AIS vessel correlation.`
              : isNoSpill
                ? "Sentinel-1 SAR scene analyzed with verified clean surface conditions. No oil slick detected above threshold."
                : "Sentinel-1 SAR acquisition analyzed with inconclusive classification due to environmental backscatter characteristics."}
          </p>
        </div>

        {/* Incident Summary Card */}
        <div className="rounded-md border border-border bg-card p-5 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2.5 mb-1.5">
                <h2 className="text-lg font-bold tracking-tight text-foreground font-mono">
                  {incidentLabel}
                </h2>
                {isDemo && (
                  <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-mono font-semibold uppercase text-amber-300">
                    Synthetic Demo
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-muted-foreground">
                <span className="flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  {spill
                    ? `${spill.metrics.centroid.lat.toFixed(3)}°N, ${spill.metrics.centroid.lon.toFixed(3)}°E`
                    : report.scene.bbox
                      ? `${((report.scene.bbox[1] + report.scene.bbox[3]) / 2).toFixed(3)}°N, ${((report.scene.bbox[0] + report.scene.bbox[2]) / 2).toFixed(3)}°E`
                      : "Location unavailable"}
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {utc(report.scene.acquiredAt)}
                </span>
                <span>
                  Source: <strong className="text-foreground">{report.scene.source}</strong>
                </span>
                {report.scene.polarization && (
                  <span>
                    Pol: <strong className="text-foreground">{String(report.scene.polarization)}</strong>
                  </span>
                )}
              </div>
            </div>
            <OutcomeBadge outcome={outcome ?? report.status} />
          </div>

          {/* KPI Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {kpis.map((kpi) => (
              <div
                key={kpi.label}
                className="rounded-md border border-border bg-[var(--background)]/60 p-3.5 space-y-1.5 om-slide-up"
                style={{ borderTopColor: kpi.color, borderTopWidth: '2px' }}
              >
                <span className="text-[10px] uppercase text-muted-foreground tracking-wider font-mono block">
                  {kpi.label}
                </span>
                <span className="text-xl font-bold text-foreground tabular-nums font-mono block">
                  {kpi.value}
                </span>
                <span className="text-[9px] text-muted-foreground block font-mono truncate">
                  {kpi.detail}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 2. MAIN MAP */}
      <Panel
        title="Incident Map"
        action={
          <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
            <span>
              {spill
                ? `${spill.metrics.centroid.lat.toFixed(2)}°N, ${spill.metrics.centroid.lon.toFixed(2)}°E`
                : "Arabian Sea Sector"}
            </span>
          </div>
        }
      >
        <OceanMap
          height={440}
          initialCenter={mapCenter}
          initialZoom={1.4}
          legend={
            <div className="space-y-1.5 text-xs">
              <div className="font-semibold text-foreground border-b border-border/50 pb-1">
                MAP LAYERS
              </div>
              {hasPolygon && (
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 rounded bg-[var(--accent-blue)]" />
                  <span>Detected Spill</span>
                </div>
              )}
              {origin && (
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
                  <span>Estimated Origin</span>
                </div>
              )}
              {hasDrift && (
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 border-t-2 border-dashed border-amber-400" />
                  <span>Drift Path</span>
                </div>
              )}
              {candidates.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent-blue)]" />
                  <span>Vessel Positions ({candidates.length})</span>
                </div>
              )}
            </div>
          }
        >
          {/* Spill polygon via Leaflet GeoJSON */}
          {hasPolygon && spill?.geometry && (
            <MapGeoJSON
              data={spill.geometry}
              style={{
                color: "#38bdf8",
                fillColor: "#38bdf8",
                fillOpacity: 0.25,
                weight: 2,
              }}
            />
          )}
          {/* Drift path via Leaflet Polyline */}
          {hasDrift && (
            <MapPolyline
              positions={driftPath.map((p) => [p.lat, p.lon])}
              pathOptions={{
                color: "var(--accent-amber)",
                dashArray: "6 5",
                weight: 2,
              }}
            />
          )}
          {/* Origin marker & uncertainty circle */}
          {origin && (
            <>
              <Marker
                lat={origin.lat}
                lon={origin.lon}
                color="var(--accent-amber)"
                label="Estimated Origin"
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
          {/* Spill centroid */}
          {spill && (
            <Marker
              lat={spill.metrics.centroid.lat}
              lon={spill.metrics.centroid.lon}
              label="Detected Spill"
              pulse
            />
          )}
          {/* Vessel positions & tracks */}
          {candidates.map((c) => {
            const last = c.track[c.track.length - 1];
            if (!last) return null;
            return (
              <div key={c.mmsi}>
                <MapPolyline
                  positions={c.track.map((p) => [p.latitude, p.longitude])}
                  pathOptions={{
                    color: "#64748b",
                    weight: 1.5,
                    opacity: 0.6,
                  }}
                />
                <Marker
                  lat={last.latitude}
                  lon={last.longitude}
                  color="#94a3b8"
                  label={`${c.name} (${c.score}/100)`}
                />
              </div>
            );
          })}
        </OceanMap>
      </Panel>

      {/* 3. PIPELINE STATUS */}
      <div className="rounded-md border border-border bg-card p-5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground font-mono mb-4 flex items-center gap-2">
          <div className="w-0.5 h-4 rounded-full bg-[var(--primary)]" />
          What O.S.I.S. Found
        </h2>
        <div className="space-y-0">
          {pipelineSteps.map((step, i) => {
            const Icon = step.icon;
            const isCompleted = step.status === "completed";
            const isPartial = step.status === "partial";
            const isUnavailable = step.status === "unavailable";
            const isInconclusive = step.status === "inconclusive";
            const isIncomplete = step.status === "incomplete";

            const statusColor = isCompleted
              ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
              : isPartial
                ? "text-amber-400 border-amber-500/40 bg-amber-500/10"
                : isUnavailable
                  ? "text-amber-400 border-amber-500/30 bg-amber-500/10"
                  : isInconclusive
                    ? "text-amber-400 border-amber-500/30 bg-amber-500/10"
                    : isIncomplete
                      ? "text-muted-foreground border-border bg-secondary/50"
                      : "text-muted-foreground border-border bg-secondary/40";

            const statusIcon = isCompleted ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
            ) : isPartial || isUnavailable || isInconclusive ? (
              <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
            ) : (
              <HelpCircle className="h-4 w-4 text-muted-foreground shrink-0" />
            );

            return (
              <div key={step.stage}>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-3.5 border-b border-border/40 last:border-b-0">
                  <div className="flex items-center gap-3">
                    {statusIcon}
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-foreground">
                          {step.label}
                        </span>
                        <span className={`rounded-md px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border ${statusColor}`}>
                          {step.statusBadge}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                        {step.result}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 4. QUICK NAVIGATION CARDS */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { to: "/satellite" as const, icon: Radar, iconColor: "text-[var(--accent-blue)]", iconBg: "bg-[var(--accent-blue)]/10", title: "Detection", desc: "SAR imagery analysis & spill geometry" },
          { to: "/backtracking" as const, icon: Compass, iconColor: "text-amber-400", iconBg: "bg-amber-400/10", title: "Drift Analysis", desc: "Backward origin estimation & forward prediction" },
          { to: "/ais" as const, icon: Ship, iconColor: "text-[var(--accent-blue)]", iconBg: "bg-[var(--accent-blue)]/10", title: "Vessel Attribution", desc: "AIS correlation & candidate ranking" },
          { to: "/analysis" as const, icon: Layers, iconColor: "text-emerald-400", iconBg: "bg-emerald-400/10", title: "Full Investigation", desc: "Complete evidence report & technical details" },
        ].map((card) => {
          const CardIcon = card.icon;
          return (
            <Link
              key={card.to}
              to={card.to}
              className="rounded-md border border-border bg-card p-4 space-y-3 hover:border-[var(--primary)]/40 transition-colors group"
            >
              <div className="flex items-center justify-between">
                <div className={`flex h-8 w-8 items-center justify-center rounded-md ${card.iconBg}`}>
                  <CardIcon className={`h-4 w-4 ${card.iconColor}`} />
                </div>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-[var(--primary)] transition-colors" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">{card.title}</h3>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                  {card.desc}
                </p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
