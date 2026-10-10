import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Marker, OceanMap, MapPolyline, MapCircle } from "../components/OceanMap";

import { KeyVal, Meter, Modal, OutcomeBadge, Panel, StatusDot } from "../components/ui-kit";
import { useIncident } from "../context/IncidentContext";
import {
  Ship,
  Compass,
  AlertCircle,
  Radio,
  ArrowRight,
  ShieldCheck,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Filter,
} from "lucide-react";

export const Route = createFileRoute("/ais")({
  head: () => ({
    meta: [
      { title: "AIS Vessel Correlation — O.S.I.S. Maritime Intelligence" },
      {
        name: "description",
        content:
          "Spatiotemporal correlation of automatic identification system (AIS) vessel tracks with the backtracked oil spill release envelope.",
      },
      { property: "og:title", content: "AIS Vessel Correlation — O.S.I.S." },
      {
        property: "og:description",
        content: "Candidate vessel tracks, reporting discontinuities, and temporal compatibility.",
      },
    ],
  }),
  component: AisPage,
});

const utc = (iso: string) => {
  if (!iso) return "N/A";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
};

type SortKey = "score" | "closestDistanceKm" | "timeDifferenceHours" | "aisContinuity";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "score", label: "Compatibility Score" },
  { key: "closestDistanceKm", label: "Origin Proximity" },
  { key: "timeDifferenceHours", label: "Temporal Offset" },
  { key: "aisContinuity", label: "AIS Continuity" },
];

function AisPage() {
  const { activeReport, autoLoading, historyLoading, isSwitchingIncident } = useIncident();
  const [selectedMmsi, setSelectedMmsi] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("score");
  const [open, setOpen] = useState(false);

  if (autoLoading || historyLoading || isSwitchingIncident) {
    return (
      <div className="mx-auto max-w-4xl py-16 text-center space-y-4">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded border border-border bg-secondary">
          <Ship className="h-6 w-6 animate-spin text-[var(--accent-blue)]" />
        </div>
        <div>
          <h2 className="text-base font-semibold text-foreground font-mono">
            Loading AIS Vessel Correlation…
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Matching vessel trajectories against release envelope.
          </p>
        </div>
      </div>
    );
  }

  if (!activeReport) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto py-8">
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-mono text-xs text-[var(--accent-blue)] uppercase tracking-wider">
            <Ship className="h-4 w-4" />
            Vessel Attribution &middot; AIS Correlation
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            AIS Spatiotemporal Vessel Correlation
          </h1>
          <p className="text-sm text-muted-foreground">
            No active incident loaded. Select an incident from the header dropdown or run an analysis from the Investigation page.
          </p>
        </div>
        <Panel className="flex flex-col items-center justify-center p-12 text-center space-y-4">
          <p className="text-sm font-medium text-foreground">No active incident analysis</p>
          <p className="text-xs text-muted-foreground max-w-sm">
            Load an incident to correlate AIS vessel tracks against the estimated spill release corridor.
          </p>
          <Link
            to="/analysis"
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90"
          >
            <span>Open Investigation</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Panel>
      </div>
    );
  }

  const report = activeReport;
  const { candidates, anomalies, origin, spill, outcome } = report;
  const isSpillDetected = outcome === "SPILL_DETECTED" && !!spill;
  const isNoSpill = outcome === "NO_SPILL_DETECTED";
  const isInconclusive = outcome === "ANALYSIS_INCONCLUSIVE" || (!isSpillDetected && !isNoSpill);
  const hasVessels = candidates.length > 0;
  const hasAnomalies = anomalies.length > 0;

  // Sort candidates
  const sortedCandidates = [...candidates].sort((a, b) => {
    if (sort === "score") return b.score - a.score;
    if (sort === "closestDistanceKm") return a.closestDistanceKm - b.closestDistanceKm;
    if (sort === "timeDifferenceHours") return a.timeDifferenceHours - b.timeDifferenceHours;
    if (sort === "aisContinuity") return b.aisContinuity - a.aisContinuity;
    return 0;
  });

  const selected = candidates.find((c) => c.mmsi === selectedMmsi) ?? sortedCandidates[0] ?? null;
  const effectiveMmsi = selected?.mmsi ?? null;

  const select = (mmsi: string) => {
    setSelectedMmsi(mmsi);
    setOpen(true);
  };

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


  return (
    <div className="space-y-6">
      {/* 1. SECTION HEADER */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/70 pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-mono text-xs text-[var(--accent-blue)] uppercase tracking-wider">
            <Ship className="h-4 w-4" />
            Vessel Attribution &middot; Spatiotemporal AIS Correlation
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground font-sans">
            Candidate Vessel Attribution &amp; Corridor Analysis
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-muted-foreground pt-1">
            <span className="rounded bg-secondary/80 px-2 py-0.5 text-foreground font-semibold">
              {report.mode ?? "DEMO"}
            </span>
            <span>&middot;</span>
            <span>
              Correlated Candidates:{" "}
              <strong className="text-[var(--accent-blue)]">{candidates.length} Vessels</strong>
            </span>
            <span>&middot;</span>
            <span>
              Discontinuities:{" "}
              <strong className="text-amber-300">{anomalies.length} Detected</strong>
            </span>
          </div>
        </div>
        <OutcomeBadge outcome={outcome ?? report.status} />
      </div>

      {/* Outcome Banner if clean scene or inconclusive */}
      {(isNoSpill || isInconclusive) && (
        <div className="rounded-lg border border-border bg-card/70 p-4 text-xs font-mono space-y-1">
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <StatusDot label={outcome ?? report.status} />
            <span>AIS Correlation Status</span>
          </div>
          <p className="text-muted-foreground">
            {isNoSpill
              ? "AIS vessel correlation is not performed when no oil spill is detected on the water."
              : report.outcomeMessage || "AIS vessel correlation inconclusive due to uncertain release origin window."}
          </p>
        </div>
      )}

      {isSpillDetected && !hasVessels && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-xs font-mono text-amber-200">
          <div className="flex items-center gap-2 font-bold mb-1">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            <span>No Compatible Vessel Identified</span>
          </div>
          <p className="text-muted-foreground">
            No AIS transponder tracks intersected the modeled origin region (±{origin?.uncertaintyKm ?? 5} km) during the estimated release window ({utc(origin?.releaseWindow.start ?? "")} – {utc(origin?.releaseWindow.end ?? "")}).
          </p>
        </div>
      )}

      {/* 2. MAIN WORKSPACE: MAP WITH TRACKS & CANDIDATE SELECTOR */}
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Panel
          title="Vessel Track Cartography &amp; Corridor Intersections"
          badge={
            <span className="rounded bg-secondary/80 px-1.5 py-0.2 text-[9px] font-mono text-muted-foreground uppercase">
              Temporal Tracks
            </span>
          }
        >
          <OceanMap
            height={510}
            initialCenter={mapCenter}
            legend={
              <div className="space-y-1.5 text-xs">
                <div className="font-semibold text-foreground border-b border-border/50 pb-1">
                  CORRELATION LAYERS
                </div>
                {spill && (
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent-blue)]" />
                    <span>Detected Slick (t=0)</span>
                  </div>
                )}
                {origin && (
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
                    <span>Modeled Origin Cell</span>
                  </div>
                )}
                {hasVessels && (
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-2.5 w-2.5 rounded bg-[var(--accent-blue)]" />
                    <span>Candidate Vessel Tracks</span>
                  </div>
                )}
                {hasAnomalies && (
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-3 border-t-2 border-dashed border-red-400" />
                    <span>AIS Discontinuity Corridor</span>
                  </div>
                )}
              </div>
            }
          >
            {/* Spill Centroid */}
            {spill && (
              <Marker
                lat={spill.metrics.centroid.lat}
                lon={spill.metrics.centroid.lon}
                label="Detected Slick"
                pulse
              />
            )}

            {/* Modeled Origin Cell */}
            {origin && (
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

            {/* Candidate Tracks */}
            {hasVessels &&
              candidates.map((c) => {
                const active = c.mmsi === effectiveMmsi;
                const segments: { longitude: number; latitude: number }[][] =
                  c.trackSegments && c.trackSegments.length > 0 ? c.trackSegments : [c.track];
                const last = c.track[c.track.length - 1];
                const hasAnomalyForVessel = anomalies.some((a) => a.mmsi === c.mmsi);

                return (
                  <div key={c.mmsi}>
                    {segments.map((seg, j) => (
                      <MapPolyline
                        key={`seg-${j}`}
                        positions={seg.map((p) => [p.latitude, p.longitude])}
                        pathOptions={{
                          color: active ? "var(--accent-blue)" : "#64748b",
                          weight: active ? 2.5 : 1.4,
                          dashArray: hasAnomalyForVessel ? "7 5" : undefined,
                          opacity: active ? 1 : 0.6,
                        }}
                      />
                    ))}

                    {/* AIS gap corridors */}
                    {anomalies
                      .filter((a) => a.mmsi === c.mmsi)
                      .map((a, i) => (
                        <MapPolyline
                          key={`gap-${i}`}
                          positions={[
                            [a.start.latitude, a.start.longitude],
                            [a.end.latitude, a.end.longitude],
                          ]}
                          pathOptions={{
                            color: "#ef4444",
                            weight: 2,
                            dashArray: "4 6",
                          }}
                        />
                      ))}

                    {last && (
                      <Marker
                        lat={last.latitude}
                        lon={last.longitude}
                        color={active ? "var(--accent-blue)" : "#94a3b8"}
                        active={active}
                        label={`${c.name} (${c.score}/100)`}
                        onClick={() => select(c.mmsi)}
                      />
                    )}
                  </div>
                );
              })}
          </OceanMap>

          <div className="mt-3 flex items-center justify-between text-xs font-mono text-muted-foreground">
            <span>
              {hasVessels
                ? "Click any vessel record on the right to highlight track trajectory."
                : "No AIS tracks to display."}
            </span>
            <span className="text-[11px] text-amber-300">
              Dashed red corridor = unobserved interval
            </span>
          </div>
        </Panel>

        {/* Right Candidate Vessel Selector Column */}
        <div className="space-y-5 font-mono">
          <Panel
            title="Correlated Candidate Vessels"
            badge={
              <span className="rounded bg-secondary/80 px-1.5 py-0.2 text-[9px] font-mono text-muted-foreground uppercase">
                {candidates.length} Ranked
              </span>
            }
          >
            {hasVessels ? (
              <div className="space-y-3">
                <ul className="space-y-2">
                  {candidates.map((c) => {
                    const active = c.mmsi === effectiveMmsi;
                    const gapCount = anomalies.filter((a) => a.mmsi === c.mmsi).length;

                    return (
                      <li key={c.mmsi}>
                        <button
                          type="button"
                          onClick={() => select(c.mmsi)}
                          className={`w-full rounded border p-2.5 text-left transition-all ${
                            active
                              ? "border-primary bg-secondary shadow-xs"
                              : "border-border bg-card hover:bg-secondary/50"
                          }`}
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-xs font-bold font-sans text-foreground">
                              #{c.rank} {c.name}
                            </span>
                            <span className="text-xs font-bold text-foreground tabular-nums">
                              {c.score} / 100
                            </span>
                          </div>
                          <div className="text-[11px] text-muted-foreground mt-1">
                            {c.type} &middot; MMSI {c.mmsi}
                          </div>
                          <div className="flex items-center justify-between text-[10px] text-muted-foreground/90 mt-2 border-t border-border/40 pt-1.5">
                            <span>Origin Dist: {c.closestDistanceKm.toFixed(1)} km</span>
                            <span>Time Δ: {c.timeDifferenceHours.toFixed(1)} h</span>
                            {gapCount > 0 && (
                              <span className="text-amber-300 font-medium">
                                {gapCount} Discontinuity
                              </span>
                            )}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>

                {selected && (
                  <button
                    type="button"
                    onClick={() => setOpen(true)}
                    className="w-full rounded bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
                  >
                    Inspect Full Dossier: {selected.name}
                  </button>
                )}
              </div>
            ) : (
              <div className="py-8 text-center text-xs text-muted-foreground">
                {isNoSpill
                  ? "Vessel correlation not performed — no spill detected."
                  : "No candidate vessels identified for this analysis."}
              </div>
            )}
          </Panel>

          {/* AIS Gap Protocol Card */}
          <Panel title="AIS Discontinuity Protocol">
            <div className="space-y-2 text-xs text-muted-foreground leading-relaxed">
              <p>
                Unobserved intervals represent periods without valid satellite or terrestrial AIS
                reception.
              </p>
              <div className="rounded border border-border/70 bg-secondary/40 p-2.5 text-[11px] space-y-1">
                <div className="font-semibold text-foreground">Objective Criteria:</div>
                <div>&bull; Transponder transmission cadence</div>
                <div>&bull; Coastal radar antenna shadowing</div>
                <div>&bull; Severe weather atmospheric attenuation</div>
              </div>
              <p className="text-[10px] text-muted-foreground/80 italic">
                Discontinuities are evaluated as mathematical factors, never assumed criminal proof.
              </p>
            </div>
          </Panel>

          {/* Navigation to Investigation */}
          <Panel title="Next Stage">
            <div className="space-y-2 text-xs">
              <p className="text-muted-foreground leading-relaxed">
                Review complete analytical findings, evidence chain, and limitation audit on the final Investigation dashboard.
              </p>
              <Link
                to="/analysis"
                className="inline-flex items-center justify-center gap-2 rounded bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 transition-opacity w-full"
              >
                <span>View Full Investigation</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </Panel>
        </div>
      </div>

      {/* 3. RANKED CANDIDATE ATTRIBUTION TABLE */}
      {hasVessels && (
        <Panel
          title="Ranked Candidate Vessel Attribution Dossiers"
          badge={
            <span className="rounded bg-primary/20 text-primary border border-primary/30 px-1.5 py-0.2 text-[9px] font-mono font-semibold uppercase">
              {candidates.length} Scored Candidates
            </span>
          }
          action={
            <div className="flex items-center gap-1.5 font-mono text-xs">
              <span className="text-muted-foreground mr-1 hidden sm:inline">Sort by:</span>
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSort(s.key)}
                  className={`rounded px-2 py-1 text-[11px] transition-colors ${
                    sort === s.key
                      ? "bg-secondary text-foreground font-bold border border-border"
                      : "text-muted-foreground hover:text-foreground border border-transparent"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          }
        >
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Candidate vessels evaluated across physical proximity to the modeled origin, temporal coincidence, AIS broadcast continuity, and vessel classification priors.
            </p>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs font-mono">
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="py-2.5 pr-4">Rank</th>
                    <th className="py-2.5 pr-4">Vessel Identification</th>
                    <th className="py-2.5 pr-4">Attribution Score</th>
                    <th className="py-2.5 pr-4">Origin Proximity</th>
                    <th className="py-2.5 pr-4">Temporal Δ</th>
                    <th className="py-2.5 pr-4">AIS Continuity</th>
                    <th className="py-2.5 pr-4">Evidence Assessment</th>
                    <th className="py-2.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {sortedCandidates.map((c) => {
                    const isTop = c.rank === 1;
                    const isRowActive = c.mmsi === effectiveMmsi;
                    return (
                      <tr
                        key={c.mmsi}
                        className={`transition-colors cursor-pointer ${
                          isRowActive
                            ? "bg-primary/10 hover:bg-primary/15"
                            : "hover:bg-secondary/40"
                        }`}
                        onClick={() => select(c.mmsi)}
                      >
                        <td className="py-3 pr-4">
                          <span className={`inline-flex items-center justify-center rounded px-2 py-0.5 text-xs font-bold font-mono ${
                            isTop ? "bg-amber-500/20 text-amber-300 border border-amber-500/30" : "bg-secondary text-foreground border border-border"
                          }`}>
                            #{c.rank}
                          </span>
                        </td>
                        <td className="py-3 pr-4">
                          <div className="font-sans font-semibold text-foreground">{c.name}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {c.type} &middot; MMSI {c.mmsi}
                          </div>
                        </td>
                        <td className="py-3 pr-4 min-w-[130px]">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-foreground tabular-nums text-sm">
                              {c.score}
                            </span>
                            <span className="text-[10px] text-muted-foreground">/ 100</span>
                          </div>
                          <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-secondary">
                            <div
                              className={`h-full rounded ${
                                c.score >= 70
                                  ? "bg-[var(--accent-blue)]"
                                  : c.score >= 40
                                    ? "bg-amber-400"
                                    : "bg-muted-foreground"
                              }`}
                              style={{ width: `${Math.min(100, c.score)}%` }}
                            />
                          </div>
                        </td>
                        <td className="py-3 pr-4 tabular-nums">
                          <span className={c.closestDistanceKm < 5 ? "text-emerald-400 font-semibold" : "text-foreground"}>
                            {c.closestDistanceKm.toFixed(1)} km
                          </span>
                        </td>
                        <td className="py-3 pr-4 tabular-nums">
                          <span className={c.timeDifferenceHours < 3 ? "text-emerald-400 font-semibold" : "text-foreground"}>
                            {c.timeDifferenceHours.toFixed(1)} h
                          </span>
                        </td>
                        <td className="py-3 pr-4 tabular-nums">
                          <span className={c.aisContinuity < 0.8 ? "text-amber-400 font-semibold" : "text-foreground"}>
                            {(c.aisContinuity * 100).toFixed(0)}%
                          </span>
                        </td>
                        <td className="py-3 pr-4 text-[11px] font-sans text-muted-foreground max-w-xs">
                          {c.evidence || "Proximity & trajectory match"}
                        </td>
                        <td className="py-3 text-right">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              select(c.mmsi);
                            }}
                            className="rounded border border-border bg-secondary px-2.5 py-1 text-[11px] font-mono hover:bg-secondary/80 text-foreground transition-colors"
                          >
                            Inspect
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </Panel>
      )}

      {/* 3. AIS DISCONTINUITIES BREAKDOWN TABLE */}
      {hasAnomalies && (
        <Panel
          title="AIS Discontinuity Log &middot; Objective Observations"
          badge={
            <span className="rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1.5 py-0.2 text-[9px] font-mono font-semibold uppercase">
              {anomalies.length} Incident Gaps
            </span>
          }
        >
          <div className="space-y-3 font-mono text-xs">
            <p className="text-muted-foreground">
              Unobserved transmission intervals in correlated candidate tracks. Does not establish
              intentional disabling.
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {anomalies.map((a, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-border/80 bg-card/80 p-3 space-y-1.5 shadow-sm"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-foreground">MMSI {a.mmsi}</span>
                    <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-300 border border-amber-500/30">
                      {a.durationHours}h unobserved
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {utc(a.start.timestamp)} &rarr; {utc(a.end.timestamp)}
                  </div>
                  <div className="text-[11px] text-foreground/80 font-sans">{a.label}</div>
                  <div className="text-[10px] text-muted-foreground pt-1 border-t border-border/40">
                    Relevance Metric: {a.anomalyScore}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      )}

      {/* Selected Vessel Modal */}
      {selected && (
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title={`Candidate Vessel: ${selected.name}`}
          subtitle={`MMSI ${selected.mmsi} · Type: ${selected.type} · Rank #${selected.rank}`}
        >
          <div className="space-y-2 font-mono text-xs">
            <KeyVal k="Compatibility Rank" v={`#${selected.rank} of ${candidates.length}`} />
            <KeyVal k="Attribution Score" v={`${selected.score} / 100`} />
            <KeyVal k="Confidence Rating" v={selected.confidence} />
            <KeyVal k="Proximity to Origin" v={`${selected.closestDistanceKm.toFixed(2)} km`} />
            <KeyVal k="Release Time Delta" v={`${selected.timeDifferenceHours.toFixed(1)} hours`} />
            <KeyVal k="AIS Track Continuity" v={`${(selected.aisContinuity * 100).toFixed(0)}%`} />
            <KeyVal k="Discontinuities" v={selected.anomalies.length} />
            <KeyVal k="Observed Fixes" v={`${selected.track.length} points`} />
            {selected.track.length > 0 && (
              <KeyVal
                k="Last Position"
                v={`${selected.track[selected.track.length - 1]!.latitude.toFixed(4)}°N, ${selected.track[selected.track.length - 1]!.longitude.toFixed(4)}°E`}
              />
            )}
            <div className="border-t border-border/50 pt-3 text-[11px] text-foreground/90 font-sans leading-relaxed">
              <strong>Evidence Summary:</strong> {selected.evidence}
            </div>
            <p className="text-[10px] text-muted-foreground italic pt-1">
              Analytical compatibility score — not legal attribution or proof of discharge.
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}
