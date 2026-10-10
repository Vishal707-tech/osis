import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { KeyVal, Meter, Modal, OutcomeBadge, Panel, StatusDot } from "../components/ui-kit";
import { useIncident } from "../context/IncidentContext";
import {
  Users,
  ShieldAlert,
  ArrowRight,
  Filter,
  CheckCircle2,
  ExternalLink,
  Info,
} from "lucide-react";

export const Route = createFileRoute("/suspects")({
  head: () => ({
    meta: [
      { title: "Candidate Vessel Attribution Ranking — O.S.I.S." },
      {
        name: "description",
        content:
          "Ranked candidate vessels scored across physical proximity, temporal coincidence, AIS continuity, and vessel classification.",
      },
      { property: "og:title", content: "Candidate Vessel Attribution Ranking — O.S.I.S." },
      {
        property: "og:description",
        content: "Explainable multi-factor attribution scores with per-vessel dossier inspection.",
      },
    ],
  }),
  component: SuspectsPage,
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

function SuspectsPage() {
  const { activeReport, autoLoading, historyLoading, isSwitchingIncident } = useIncident();
  const [sort, setSort] = useState<SortKey>("score");
  const [openMmsi, setOpenMmsi] = useState<string | null>(null);

  if (autoLoading || historyLoading || isSwitchingIncident) {
    return (
      <div className="mx-auto max-w-4xl py-16 text-center space-y-4">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded border border-border bg-secondary">
          <Users className="h-6 w-6 animate-spin text-primary" />
        </div>
        <div>
          <h2 className="text-base font-semibold text-foreground font-mono">
            Loading Attribution Rankings…
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Computing explainable multi-factor attribution compatibility.
          </p>
        </div>
      </div>
    );
  }

  if (!activeReport) {
    return (
      <div className="space-y-6 max-w-4xl mx-auto py-8">
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-mono text-xs text-primary uppercase tracking-wider">
            <Users className="h-4 w-4" />
            Attribution &middot; Source Ranking
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Candidate Vessel Attribution
          </h1>
          <p className="text-sm text-muted-foreground">
            No active incident loaded. Select an incident from the header dropdown or run an analysis from the Investigation page.
          </p>
        </div>
        <Panel className="flex flex-col items-center justify-center p-12 text-center space-y-4">
          <p className="text-sm font-medium text-foreground">No active incident analysis</p>
          <p className="text-xs text-muted-foreground max-w-sm">
            Load an incident to view explainable vessel attribution rankings.
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
  const { candidates, outcome, spill } = report;
  const noSpill = outcome === "NO_SPILL_DETECTED" || outcome === "ANALYSIS_INCONCLUSIVE" || !spill;
  const hasCandidates = candidates.length > 0;

  // Sort candidates
  const sorted = [...candidates].sort((a, b) => {
    if (sort === "score") return b.score - a.score;
    if (sort === "closestDistanceKm") return a.closestDistanceKm - b.closestDistanceKm;
    if (sort === "timeDifferenceHours") return a.timeDifferenceHours - b.timeDifferenceHours;
    if (sort === "aisContinuity") return b.aisContinuity - a.aisContinuity;
    return 0;
  });

  const activeCandidate = openMmsi ? (candidates.find((c) => c.mmsi === openMmsi) ?? null) : null;

  return (
    <div className="space-y-6">
      {/* 1. SECTION HEADER */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border/70 pb-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 font-mono text-xs text-primary uppercase tracking-wider">
            <Users className="h-4 w-4" />
            Attribution &middot; Explainable Source Ranking
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground font-sans">
            Candidate Vessel Attribution &amp; Ranking
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-muted-foreground pt-1">
            <span className="rounded bg-secondary/80 px-2 py-0.5 text-foreground font-semibold">
              {report.mode ?? "DEMO"}
            </span>
            <span>&middot;</span>
            <span>
              Pipeline Sequence:{" "}
              <strong className="text-foreground">
                Rank &rarr; Vessel &rarr; Compatibility &rarr; Confidence &rarr; Evidence
              </strong>
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <OutcomeBadge outcome={outcome ?? report.status} />
          {hasCandidates && (
            <div className="flex items-center gap-1.5 font-mono text-xs">
              <span className="text-muted-foreground mr-1 hidden sm:inline">Sort:</span>
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setSort(s.key)}
                  className={`rounded px-2 py-1 transition-colors ${
                    sort === s.key
                      ? "bg-secondary text-foreground font-bold border border-border"
                      : "text-muted-foreground hover:text-foreground border border-transparent"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Outcome Banner if clean scene */}
      {noSpill && (
        <div className="rounded-lg border border-border bg-card/70 p-4 text-xs font-mono space-y-1">
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <StatusDot label={outcome ?? report.status} />
            <span>Attribution Status</span>
          </div>
          <p className="text-muted-foreground">
            No oil spill detected — source attribution is not generated.
          </p>
          {report.outcomeReason && (
            <p className="text-muted-foreground/80 italic">{report.outcomeReason}</p>
          )}
        </div>
      )}

      {/* 2. RANKED CANDIDATE LIST */}
      {hasCandidates ? (
        <div className="space-y-4">
          {sorted.map((c, i) => {
            // Derived feature scores
            const proximityScore = Math.max(0, Math.min(100, 100 - c.closestDistanceKm * 5));
            const temporalScore = Math.max(0, Math.min(100, 100 - c.timeDifferenceHours * 10));
            const gapScore = Math.max(0, Math.min(100, (1 - c.aisContinuity) * 100));

            const features = c.features ?? {};
            const proximityMeter =
              "proximity" in features ? features["proximity"]! * 100 : proximityScore;
            const temporalMeter =
              "temporal" in features ? features["temporal"]! * 100 : temporalScore;
            const aisGapMeter = "ais_gap" in features ? features["ais_gap"]! * 100 : gapScore;
            const vesselTypeMeter = "vessel_type" in features ? features["vessel_type"]! * 100 : 50;

            const isLeading = i === 0 && sort === "score";

            return (
              <div
                key={c.mmsi}
                className={`rounded border transition-all p-4 ${
                  isLeading
                    ? "border-[var(--primary)]/70 bg-card"
                    : "border-border bg-card hover:border-border/90"
                }`}
              >
                <div className="grid gap-5 lg:grid-cols-[220px_1fr_130px] items-center">
                  {/* Left: Vessel Identity */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`font-mono text-xs font-bold px-2 py-0.5 rounded ${
                          isLeading
                            ? "bg-primary text-primary-foreground font-bold"
                            : "bg-secondary text-muted-foreground"
                        }`}
                      >
                        #{c.rank}
                      </span>
                      {isLeading && (
                        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-[var(--accent-blue)]">
                          Leading Candidate
                        </span>
                      )}
                    </div>
                    <div className="text-base font-bold text-foreground font-sans pt-0.5">
                      {c.name}
                    </div>
                    <div className="text-xs font-mono text-muted-foreground">
                      MMSI: <span className="text-foreground">{c.mmsi}</span>
                    </div>
                    <div className="text-xs font-mono text-muted-foreground">
                      Type: <span className="text-foreground">{c.type}</span>
                    </div>
                  </div>

                  {/* Center: 4 Attribute Micro-Meters */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 font-mono text-xs">
                    <div className="rounded border border-border/60 bg-secondary/40 p-2.5 space-y-1.5">
                      <Meter label="Proximity" value={proximityMeter} />
                      <span className="text-[10px] text-muted-foreground block truncate">
                        {c.closestDistanceKm} km away
                      </span>
                    </div>

                    <div className="rounded border border-border/60 bg-secondary/40 p-2.5 space-y-1.5">
                      <Meter label="Temporal" value={temporalMeter} />
                      <span className="text-[10px] text-muted-foreground block truncate">
                        &Delta;t: {c.timeDifferenceHours}h
                      </span>
                    </div>

                    <div className="rounded border border-border/60 bg-secondary/40 p-2.5 space-y-1.5">
                      <Meter label="AIS Quality" value={100 - aisGapMeter} tone="amber" />
                      <span className="text-[10px] text-muted-foreground block truncate">
                        {(c.aisContinuity * 100).toFixed(0)}% continuity
                      </span>
                    </div>

                    <div className="rounded border border-border/60 bg-secondary/40 p-2.5 space-y-1.5">
                      <Meter label="Vessel Type" value={vesselTypeMeter} tone="emerald" />
                      <span className="text-[10px] text-muted-foreground block truncate">
                        {c.type}
                      </span>
                    </div>
                  </div>

                  {/* Right: Overall Score & Action */}
                  <div className="flex flex-col items-end justify-center text-right space-y-2 border-l border-border/40 pl-4">
                    <div>
                      <div className="text-2xl font-bold font-mono text-foreground tabular-nums">
                        {c.score}
                        <span className="text-xs text-muted-foreground font-normal">/100</span>
                      </div>
                      <div className="text-[10px] uppercase font-mono tracking-wider text-muted-foreground">
                        {c.confidence} Confidence
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setOpenMmsi(c.mmsi)}
                      className="rounded bg-secondary border border-border px-3 py-1.5 text-xs font-mono font-medium text-foreground hover:bg-secondary/80 transition-colors whitespace-nowrap"
                    >
                      Inspect Evidence
                    </button>
                  </div>
                </div>

                {/* Evidence Note snippet */}
                {c.evidence && (
                  <div className="mt-3 border-t border-border/40 pt-2.5 text-xs text-muted-foreground font-sans leading-relaxed">
                    <strong className="text-foreground/90 font-mono text-[11px]">
                      Evidence Summary:
                    </strong>{" "}
                    {c.evidence}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <Panel className="p-12 text-center font-mono">
          <div className="text-base font-semibold text-foreground">
            {noSpill ? "No attribution generated" : "No candidate vessels identified"}
          </div>
          <p className="mt-2 text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
            {noSpill
              ? "No oil spill was detected in this scene — vessel attribution is not performed."
              : report.stageStatus?.["ais"]?.status === "unavailable"
                ? `AIS data unavailable: ${report.stageStatus["ais"].reason}. Real feeds require configured AIS archives.`
                : "No AIS-correlated vessels met the spatiotemporal intersection criteria with the modeled origin."}
          </p>
        </Panel>
      )}

      {/* 3. SCIENTIFIC & LEGAL METHODOLOGY CAVEAT */}
      <Panel
        title="Source Attribution Methodology &middot; Objective Standards"
        badge={
          <span className="rounded bg-secondary/80 px-1.5 py-0.2 text-[9px] font-mono text-muted-foreground uppercase">
            Protocol
          </span>
        }
      >
        <div className="space-y-2 text-xs font-mono text-muted-foreground leading-relaxed">
          <p>{report.scoring.note}</p>
          <div className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-[11px] text-amber-200/90 flex items-start gap-2.5">
            <ShieldAlert className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
            <span>
              <strong>Attribution Standard:</strong> Candidate vessel scores represent physical and
              temporal compatibility between vessel trajectories and the backward hydrodynamic drift
              hindcast. They do not constitute legal proof of discharge or establish operational
              guilt.
            </span>
          </div>
        </div>
      </Panel>

      {/* Candidate Dossier Modal */}
      <Modal
        open={Boolean(activeCandidate)}
        onClose={() => setOpenMmsi(null)}
        title={activeCandidate ? `Attribution Dossier: ${activeCandidate.name}` : ""}
        subtitle={
          activeCandidate
            ? `MMSI ${activeCandidate.mmsi} · Rank #${activeCandidate.rank} · Score: ${activeCandidate.score}/100`
            : undefined
        }
      >
        {activeCandidate && (
          <div className="space-y-4 font-mono text-xs">
            <div className="text-xs text-foreground/90 font-sans leading-relaxed bg-secondary/40 p-3 rounded border border-border/60">
              <strong>Evidence Synthesis:</strong> {activeCandidate.evidence}
            </div>

            <div className="space-y-2">
              <div className="text-[11px] uppercase font-bold text-muted-foreground">
                Sub-Feature Contribution Breakdown
              </div>
              <div className="space-y-2.5">
                {Object.entries(activeCandidate.features).map(([k, v]) => (
                  <Meter key={k} label={k.replaceAll("_", " ")} value={Math.round(v * 100)} />
                ))}
              </div>
            </div>

            <div className="border-t border-border/50 pt-3 space-y-1.5">
              <KeyVal k="MMSI Transponder" v={activeCandidate.mmsi} />
              <KeyVal k="Vessel Type" v={activeCandidate.type} />
              <KeyVal k="Attribution Score" v={`${activeCandidate.score} / 100`} />
              <KeyVal k="Confidence Tier" v={activeCandidate.confidence} />
              <KeyVal
                k="Origin Separation"
                v={`${activeCandidate.closestDistanceKm.toFixed(2)} km`}
              />
              <KeyVal
                k="Release Window Time Delta"
                v={`${activeCandidate.timeDifferenceHours.toFixed(1)} h`}
              />
              <KeyVal
                k="AIS Broadcast Continuity"
                v={`${(activeCandidate.aisContinuity * 100).toFixed(0)}%`}
              />
              <KeyVal k="Discontinuities" v={activeCandidate.anomalies.length} />
              {activeCandidate.track.length > 0 && (
                <KeyVal
                  k="Last Sighting UTC"
                  v={utc(activeCandidate.track[activeCandidate.track.length - 1]!.timestamp)}
                />
              )}
            </div>

            {activeCandidate.anomalies.length > 0 && (
              <div className="border-t border-border/50 pt-2 space-y-2">
                <div className="text-[11px] uppercase font-bold text-amber-300">
                  Detected Transmission Discontinuities
                </div>
                {activeCandidate.anomalies.map((a, i) => (
                  <div
                    key={i}
                    className="rounded border border-border/60 bg-secondary/50 p-2 text-[11px]"
                  >
                    <div className="flex justify-between font-bold text-foreground">
                      <span>{a.durationHours}h unobserved corridor</span>
                      <span className="text-amber-300">Relevance: {a.anomalyScore}</span>
                    </div>
                    <div className="text-muted-foreground text-[10px] mt-0.5">{a.label}</div>
                  </div>
                ))}
              </div>
            )}

            <p className="text-[10px] text-muted-foreground italic pt-2">
              Physical compatibility score &middot; Not legal attribution or proof of spill release.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
