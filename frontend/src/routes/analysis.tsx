import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  OceanMap,
  Marker,
  MapRectangle,
  MapGeoJSON,
  MapPolyline,
  MapCircle,
} from "../components/OceanMap";

import { SARUpload } from "../components/SARUpload";
import { useIncident } from "../context/IncidentContext";
import { KeyVal, Meter, Modal, OutcomeBadge, Panel, Stat, StatusDot } from "../components/ui-kit";
import { getIncidentLabel } from "../api/incidents";
import {
  analyzeIncident,
  getIncident,
  listIncidentScenes,
  type IncidentReport,
  type Position,
} from "../api/incidents";
import {
  Layers,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
  Radar,
  Compass,
  Ship,
  Users,
  Download,
  Settings,
  Info,
} from "lucide-react";

export const Route = createFileRoute("/analysis")({
  validateSearch: (search: Record<string, unknown>): { id?: string } => {
    return { id: search.id as string | undefined };
  },
  component: InvestigationPage,
});
const colors = ["var(--accent-blue)", "#94a3b8", "#f59e0b"];
const utc = (time: string) => time.replace("T", " ").replace("Z", " UTC");

function Raster({ report, onImage }: { report: IncidentReport; onImage: (url: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const { width, height, pixels } = report.scene;
    if (!width || !height || !pixels.length) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(width, height);
    pixels.forEach((row, y) =>
      row.forEach((value, x) => {
        const i = (y * width + x) * 4;
        const gray = value === null ? 0 : Math.max(0, Math.min(255, ((value + 30) / 24) * 255));
        image.data.set([gray, gray, gray, value === null ? 0 : 255], i);
      }),
    );
    ctx.putImageData(image, 0, 0);
    onImage(canvas.toDataURL());
  }, [report, onImage]);
  return (
    <canvas
      ref={ref}
      className="w-full rounded bg-secondary"
      style={{ imageRendering: "pixelated" }}
      aria-label="SAR backscatter preview"
    />
  );
}

export function ReportView({ report }: { report: IncidentReport }) {
  return <InvestigationReport report={report} />;
}

/** The main investigation report view — evaluator-first layout */
function InvestigationReport({ report }: { report: IncidentReport }) {
  const [image, setImage] = useState("");
  const [selected, setSelected] = useState(report.leadingCandidate);
  const { spill, origin, age, candidates, anomalies, outcome } = report;
  const topCandidate = candidates[0] ?? null;
  const isDemo = report.mode === "DEMO" || !report.mode;

  // Map setup
  const [west, south, east, north] = report.scene.bbox ?? [72.3, 15.1, 72.6, 15.4];
  const mapCenter: [number, number] = spill
    ? [spill.metrics.centroid.lat, spill.metrics.centroid.lon]
    : origin
      ? [origin.lat, origin.lon]
      : [(south + north) / 2, (west + east) / 2];


  const exportReport = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `osis-${report.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Assessment label
  const assessmentLabel = outcome === "SPILL_DETECTED" && topCandidate
    ? "OIL-LIKE SIGNATURE WITH CANDIDATE SOURCE"
    : outcome === "NO_SPILL_DETECTED"
      ? "NO SPILL DETECTED"
      : outcome === "ANALYSIS_INCONCLUSIVE"
        ? "ANALYSIS INCONCLUSIVE"
        : outcome === "SPILL_DETECTED"
          ? "OIL-LIKE SIGNATURE DETECTED (INVESTIGATION PARTIAL)"
          : "INVESTIGATION COMPLETE";

  const assessmentColor = outcome === "SPILL_DETECTED"
    ? "border-rose-500/40 bg-rose-500/5"
    : outcome === "NO_SPILL_DETECTED"
      ? "border-emerald-500/40 bg-emerald-500/5"
      : "border-amber-500/40 bg-amber-500/5";

  return (
    <div className="space-y-5">
      {/* 1. ASSESSMENT BANNER */}
      <div className={`rounded border p-5 ${assessmentColor}`}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h2 className="text-lg font-bold text-foreground font-mono tracking-tight">
                {assessmentLabel}
              </h2>
              {isDemo && (
                <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-mono font-semibold uppercase text-amber-300">
                  Demo
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground max-w-xl">
              O.S.I.S. combines satellite evidence, drift modelling and AIS vessel correlation
              to identify potential spill sources. {report.outcomeMessage ?? ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <OutcomeBadge outcome={outcome ?? report.status} />
            <button
              onClick={exportReport}
              className="rounded border border-border bg-secondary px-3 py-1.5 text-xs font-mono text-foreground hover:bg-secondary/80 transition-colors cursor-pointer"
            >
              <Download className="h-3 w-3 inline mr-1" />
              Download report JSON
            </button>
          </div>
        </div>
      </div>

      {/* Analysis outcome status card */}
      <section className="rounded border border-border/70 bg-card/60 p-4 text-xs font-mono space-y-1.5" role="status" aria-label="Analysis outcome">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-foreground">
            {report.outcome ?? (spill ? "SPILL_DETECTED" : "ANALYSIS_INCONCLUSIVE")}
          </h3>
          <span className="text-muted-foreground">{report.status}</span>
        </div>
        {report.outcomeMessage && <p className="text-muted-foreground">{report.outcomeMessage}</p>}
        {report.outcomeReason && <p className="text-muted-foreground/80 italic">{report.outcomeReason}</p>}
        {report.availability === "REAL_DATA_UNAVAILABLE" && (
          <p className="text-amber-400">
            REAL_DATA_UNAVAILABLE · Use DEMO, upload compatible SAR, or configure the required real-data access.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Processing timestamp: {utc(report.processedAt ?? report.detectedAt)} · Source: {report.scene.source}
        </p>
        <p className="text-xs text-muted-foreground">
          {report.scene.bbox
            ? `Analyzed bounds: [${report.scene.bbox.join(", ")}]`
            : "Scene location unavailable. Map is contextual only; no analyzed footprint claimed."}
        </p>
      </section>

      {/* Stage Status & Evidence availability */}
      {report.stageStatus && (
        <section className="rounded border border-border/70 bg-card/60 p-4 text-xs font-mono space-y-2" aria-label="Evidence availability">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-foreground">Evidence availability · no synthetic substitution</h3>
            <span className="text-[10px] text-muted-foreground uppercase">{report.mode ?? "DEMO"}</span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {Object.entries(report.stageStatus).map(([name, stage]) => (
              <div key={name} className="rounded bg-secondary/30 p-2 text-xs border border-border/40">
                <span className="font-bold text-foreground capitalize">{name}: </span>
                <span className="text-muted-foreground">{stage.status} · {stage.kind}</span>
                <p className="text-[11px] text-muted-foreground/90 mt-0.5">{stage.reason}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground pt-1 border-t border-border/30">
            {report.mode === "DEMO"
              ? "Synthetic exercise; no real observations claimed."
              : `Hindcast scenario: ${report.hindcastHours}h before image time; AIS search ±1h. Not measured spill age.`}
          </p>
        </section>
      )}

      {/* 2. KEY FINDINGS */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="rounded border border-border bg-card p-3 space-y-1">
          <span className="text-[10px] uppercase text-muted-foreground tracking-wider font-mono block">Signature</span>
          <span className="text-xs font-bold text-foreground font-mono">{spill ? "Oil-Like Inferred" : "No Signature"}</span>
          {spill && (
            <span className="text-[9px] text-muted-foreground block mt-0.5 leading-tight">
              Experimental {report?.detector?.name ?? "hybrid"} detector<br/>
              Confidence: ~{(spill.confidence * 100).toFixed(1)}%
            </span>
          )}
        </div>
        <div className="rounded border border-border bg-card p-3 space-y-1">
          <span className="text-[10px] uppercase text-muted-foreground tracking-wider font-mono block">Spill Area</span>
          <span className="text-sm font-bold text-foreground font-mono tabular-nums">{spill ? `${(spill.maskAreaKm2 ?? spill.metrics.areaKm2)} km²` : "—"}</span>
        </div>
        <div className="rounded border border-border bg-card p-3 space-y-1">
          <span className="text-[10px] uppercase text-muted-foreground tracking-wider font-mono block" title="Approximate interval based on available observations">Est. Observation Age</span>
          <span className="text-sm font-bold text-foreground font-mono tabular-nums">{age ? `${age.minHours}–${age.maxHours}h` : "—"}</span>
        </div>
        <div className="rounded border border-border bg-card p-3 space-y-1">
          <span className="text-[10px] uppercase text-muted-foreground tracking-wider font-mono block">Origin Region</span>
          <span className="text-xs font-bold text-foreground font-mono">{origin ? `${origin.lat.toFixed(3)}°N` : "—"}</span>
        </div>
        <div className="rounded border border-border bg-card p-3 space-y-1">
          <span className="text-[10px] uppercase text-muted-foreground tracking-wider font-mono block">Top Vessel</span>
          <span className="text-xs font-bold text-foreground font-mono truncate block">{topCandidate?.name ?? "—"}</span>
        </div>
        <div className="rounded border border-border bg-card p-3 space-y-1">
          <span className="text-[10px] uppercase text-muted-foreground tracking-wider font-mono block">Attribution Score</span>
          <span className="text-sm font-bold text-foreground font-mono tabular-nums">{topCandidate ? `${topCandidate.score}/100` : "—"}</span>
        </div>
      </div>

      {/* 3. EVIDENCE MAP */}
      <Panel title="Evidence Map">
        <OceanMap
          key={report.id}
          height={480}
          initialZoom={1.4}
          initialCenter={mapCenter}
          legend={
            <div className="space-y-1.5 text-xs">
              <div className="font-semibold text-foreground border-b border-border/50 pb-1">
                EVIDENCE LAYERS
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-[#fb7185]" />
                <span>Spill Detection</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
                <span>Estimated Origin</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block w-3 border-t-2 border-dashed border-[#fb923c]" />
                <span>Backward Drift</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="inline-block w-3 border-t-2 border-[#22d3ee]" />
                <span>Forward Forecast</span>
              </div>
            </div>
          }
        >
          {/* Analyzed scene footprint rect */}
          {report.scene.bbox && (
            <MapRectangle
              bounds={[
                [report.scene.bbox[1], report.scene.bbox[0]],
                [report.scene.bbox[3], report.scene.bbox[2]],
              ]}
              aria-label="Analyzed scene footprint"
              title="Analyzed scene footprint"
              pathOptions={{
                fill: false,
                color: "#94a3b8",
                weight: 2,
                dashArray: "6 4",
              }}
            />
          )}

          {/* Spill polygons */}
          {report.detections.map((d, i) => (
            <MapGeoJSON
              key={i}
              data={d.geometry}
              style={{
                color: "#fb7185",
                fillColor: "#fb7185",
                fillOpacity: 0.4,
                weight: 2,
              }}
            />
          ))}

          {/* Origin */}
          {origin && (
            <Marker lon={origin.lon} lat={origin.lat} color="var(--accent-amber)" label="Modeled Origin" />
          )}

          {/* Backward drift */}
          {report.backward.length > 0 && (
            <MapPolyline
              positions={report.backward.map((p) => [p.lat, p.lon])}
              pathOptions={{
                color: "#fb923c",
                weight: 2.5,
                dashArray: "7 3",
              }}
            />
          )}

          {/* Forward forecast */}
          {report.forward.length > 0 && (
            <MapPolyline
              positions={report.forward.map((p) => [p.lat, p.lon])}
              pathOptions={{
                color: "#22d3ee",
                weight: 2,
              }}
            />
          )}

          {/* Vessel tracks */}
          {candidates.map((c, i) =>
            c.trackSegments.map((segment, j) => (
              <MapPolyline
                key={`${c.mmsi}-${j}`}
                positions={segment.map((p) => [p.latitude, p.longitude])}
                eventHandlers={{ click: () => setSelected(c.mmsi) }}
                pathOptions={{
                  color: colors[i % colors.length],
                  weight: selected === c.mmsi ? 3 : 1.5,
                  opacity: 0.8,
                }}
              />
            ))
          )}

          {/* AIS gaps */}
          {anomalies.map((a, i) => (
            <MapPolyline
              key={i}
              positions={[
                [a.start.latitude, a.start.longitude],
                [a.end.latitude, a.end.longitude],
              ]}
              pathOptions={{
                color: "#f87171",
                weight: 2,
                dashArray: "3 5",
              }}
            />
          ))}

          {/* Spill centroid */}
          {spill && (
            <Marker lon={spill.metrics.centroid.lon} lat={spill.metrics.centroid.lat} label="Detected Spill" pulse />
          )}
        </OceanMap>
      </Panel>

      {/* 4. SOURCE ATTRIBUTION */}
      <div className="rounded border border-border bg-card p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground font-mono">
            Source Attribution — Candidate Vessels
          </h3>
          <span className="text-xs font-mono text-muted-foreground">
            {candidates.length} candidate{candidates.length === 1 ? "" : "s"} evaluated
          </span>
        </div>

        {candidates.length === 0 ? (
          <div className="rounded border border-border/70 bg-secondary/20 p-4 text-xs font-mono text-muted-foreground space-y-1">
            <p className="font-semibold text-foreground">
              {report.stageStatus?.["ais"]?.status === "unavailable"
                ? `AIS unavailable: ${report.stageStatus["ais"].reason}. No attribution generated.`
                : "No observed vessel fixes met spatial/temporal criteria. No dark-slick candidates."}
            </p>
            <p>
              Attribution requires correlated automatic identification system (AIS) transponder fixes within the operational release window.
            </p>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">{report.scoring.note}</p>

            {/* Top candidate prominently */}
            {topCandidate && (
              <div className="rounded border border-[var(--primary)]/30 bg-secondary/30 p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="rounded bg-primary px-2 py-0.5 text-xs font-mono font-bold text-primary-foreground">
                        #{topCandidate.rank}
                      </span>
                      <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-[var(--accent-blue)]">
                        Leading Candidate
                      </span>
                    </div>
                    <div className="text-base font-bold text-foreground">{topCandidate.name}</div>
                    <div className="text-xs font-mono text-muted-foreground">
                      {topCandidate.type} &middot; MMSI {topCandidate.mmsi}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-mono font-bold text-foreground tabular-nums">
                      {topCandidate.score}
                      <span className="text-xs text-muted-foreground font-normal">/100</span>
                    </div>
                    <div className="text-[10px] uppercase font-mono text-muted-foreground">
                      Compatibility Score
                    </div>
                  </div>
                </div>

                {/* Evidence indicators */}
                <div className="mt-3 flex flex-wrap gap-2 text-xs font-mono">
                  {topCandidate.closestDistanceKm < 5 && (
                    <span className="flex items-center gap-1 text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" /> Spatial proximity
                    </span>
                  )}
                  {topCandidate.timeDifferenceHours < 3 && (
                    <span className="flex items-center gap-1 text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" /> Temporal compatibility
                    </span>
                  )}
                  {topCandidate.anomalies.length > 0 && (
                    <span className="flex items-center gap-1 text-amber-300">
                      <AlertTriangle className="h-3 w-3" /> AIS discontinuity
                    </span>
                  )}
                  {topCandidate.aisContinuity < 0.8 && (
                    <span className="flex items-center gap-1 text-amber-300">
                      <AlertTriangle className="h-3 w-3" /> Reduced AIS continuity
                    </span>
                  )}
                </div>

                {topCandidate.evidence && (
                  <p className="mt-2 text-xs text-muted-foreground">{topCandidate.evidence}</p>
                )}
              </div>
            )}

            {/* Other candidates */}
            {candidates.length > 1 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      <th className="py-2 pr-3">Rank</th>
                      <th className="py-2 pr-3">Vessel</th>
                      <th className="py-2 pr-3">MMSI</th>
                      <th className="py-2 pr-3">Score</th>
                      <th className="py-2 pr-3">Distance</th>
                      <th className="py-2 pr-3">Time Δ</th>
                      <th className="py-2 pr-3">AIS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.slice(1).map((c) => (
                      <tr key={c.mmsi} className="border-t border-border/50">
                        <td className="py-2 pr-3">#{c.rank}</td>
                        <td className="py-2 pr-3 font-semibold text-foreground">{c.name}</td>
                        <td className="py-2 pr-3">{c.mmsi}</td>
                        <td className="py-2 pr-3 tabular-nums">{c.score}/100</td>
                        <td className="py-2 pr-3 tabular-nums">{c.closestDistanceKm.toFixed(1)} km</td>
                        <td className="py-2 pr-3 tabular-nums">{c.timeDifferenceHours.toFixed(1)}h</td>
                        <td className="py-2 pr-3">{(c.aisContinuity * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* 5. EVIDENCE CHAIN */}
      <div className="rounded border border-border bg-card p-5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground font-mono mb-4">
          Evidence Chain
        </h3>
        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
          {[
            { label: "Satellite", ok: true },
            { label: "Detection", ok: !!spill },
            { label: "Characterization", ok: !!spill },
            { label: "Drift", ok: report.backward.length > 0 },
            { label: "Origin", ok: !!origin },
            { label: "AIS Correlation", ok: candidates.length > 0 },
            { label: "Attribution", ok: !!topCandidate },
          ].map((step, i, arr) => (
            <span key={step.label} className="flex items-center gap-1.5">
              {step.ok ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <span className={step.ok ? "text-foreground" : "text-muted-foreground"}>
                {step.label}
              </span>
              {i < arr.length - 1 && (
                <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
              )}
            </span>
          ))}
        </div>
      </div>

      {/* 6. LIMITATIONS */}
      <div className="rounded border border-border bg-card p-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground font-mono mb-2">
          Interpretation &amp; Limitations
        </h3>
        <ul className="space-y-1 text-xs text-muted-foreground">
          <li>&bull; SAR dark areas can have non-oil look-alikes (biogenic slicks, low-wind zones).</li>
          <li>&bull; AIS data may be incomplete due to reception gaps, not necessarily intentional disabling.</li>
          <li>&bull; Drift-based origin estimates depend on environmental model accuracy.</li>
          <li>&bull; Spill age is an observation-based estimate, not direct chemical dating.</li>
          <li>&bull; Vessel compatibility is investigative evidence, not proof of responsibility.</li>
        </ul>
        {report.disclaimer && (
          <p className="mt-2 text-xs text-muted-foreground italic border-t border-border/50 pt-2">
            {report.disclaimer}
          </p>
        )}
      </div>

      {/* 7. TECHNICAL DETAILS & EVIDENCE PROVENANCE (COLLAPSIBLE) */}
      <details className="rounded border border-border bg-card group">
        <summary className="flex cursor-pointer items-center justify-between px-5 py-3 text-left font-mono select-none hover:bg-secondary/40 transition-colors">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground flex items-center gap-2">
            <Settings className="h-3.5 w-3.5 text-primary" />
            Technical Details &amp; Evidence Provenance
          </h3>
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>

        <div className="border-t border-border px-5 py-4 space-y-4 text-xs font-mono">
          {/* SAR Input */}
          <div>
            <h4 className="font-semibold text-foreground mb-2">
              SAR Input &middot; {report.mode === "UPLOAD" ? "user-provided" : report.mode === "REAL" ? "real archived / on demand" : "synthetic"}
            </h4>
            <div className="grid gap-3 sm:grid-cols-2">
              {report.scene.pixels.length > 0 ? (
                <Raster report={report} onImage={setImage} />
              ) : (
                <p className="text-xs text-muted-foreground py-2">Preview unavailable; see detection stage.</p>
              )}
              <div className="space-y-1">
                <KeyVal k="Scene ID" v={report.scene.id} />
                <KeyVal k="Source" v={report.scene.source} />
                <KeyVal k="Dimensions" v={`${report.scene.width}×${report.scene.height} px`} />
                <KeyVal k="Polarization" v={String(report.scene.polarization)} />
                <KeyVal k="Resolution" v={`${report.scene.resolution_m.map((n) => n.toFixed(1)).join("×")} m/px`} />
                <KeyVal k="Acquired" v={utc(report.scene.acquiredAt)} />
                <KeyVal k="Detector" v={report.detector?.name ?? "unavailable"} />
                <KeyVal k="Detector Status" v={report.detector?.status ?? "—"} />
              </div>
            </div>
          </div>

          {/* Characterization & Age */}
          <div>
            <h4 className="font-semibold text-foreground mb-2">Characterization &amp; Age</h4>
            {spill ? (
              <div className="space-y-1">
                <p className="text-xs">
                  Perimeter: {spill.metrics.perimeterM.toFixed(0)} m<br />
                  Length × width: {spill.metrics.lengthM.toFixed(0)} × {spill.metrics.widthM.toFixed(0)} m
                </p>
                <KeyVal k="Geometry Method" v={spill.geometryMethod} />
                <p className="text-xs">
                  {age?.method.replaceAll("_", " ") ?? "Spill age unavailable"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {age?.caveat ?? "Hindcast duration is an analyst-selected scenario, not an age estimate."}
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Characterization unavailable</p>
                <p className="text-xs">Spill age unavailable</p>
              </div>
            )}
          </div>

          {/* Origin & Environment */}
          <div>
            <h4 className="font-semibold text-foreground mb-2">Origin &amp; Environment</h4>
            {origin ? (
              <div className="space-y-1">
                <p className="text-xs">
                  {origin.lat.toFixed(5)}° N, {origin.lon.toFixed(5)}° E
                </p>
                <p className="text-xs">
                  {utc(origin.releaseWindow.start)} → {utc(origin.releaseWindow.end)}
                </p>
                <p className="my-1 text-xs">
                  Origin sensitivity radius: {origin.uncertaintyKm} km · forecast {report.forecastHours}h
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Modeled origin unavailable. No release location inferred.</p>
            )}
            {Object.keys(report.environment).length > 0 && (
              <div className="mt-2 space-y-1">
                {Object.entries(report.environment).map(([k, v]) => (
                  <KeyVal key={k} k={k.replaceAll("_", " ")} v={String(v)} />
                ))}
              </div>
            )}
          </div>

          {/* AIS Discontinuities */}
          {anomalies.length > 0 && (
            <div>
              <h4 className="font-semibold text-foreground mb-2">
                AIS Discontinuities &middot; not proof of disabling
              </h4>
              {anomalies.map((a, i) => (
                <div className="border-t border-border/50 py-2" key={i}>
                  <strong>{a.mmsi}: {a.durationHours} hours</strong>
                  <p className="text-muted-foreground">{utc(a.start.timestamp)} → {utc(a.end.timestamp)}</p>
                  <p className="text-muted-foreground">{a.label} &middot; relevance {a.anomalyScore}</p>
                </div>
              ))}
            </div>
          )}

          {/* Evidence Provenance */}
          {report.evidenceProvenance && (
            <div>
              <h4 className="font-semibold text-foreground mb-2">Evidence provenance</h4>
              {Object.entries(report.evidenceProvenance).map(([name, evidence]) => (
                <p key={name} className="text-xs">
                  <strong>{name}: {evidence.kind}</strong> — {evidence.reason}
                </p>
              ))}
            </div>
          )}

          {/* Pipeline Audit */}
          <div>
            <h4 className="font-semibold text-foreground mb-2">Pipeline Audit Trail</h4>
            <div className="flex flex-wrap gap-2 mb-2">
              {report.stages.map((s, i) => (
                <span className="rounded bg-secondary px-2 py-1" key={s}>
                  {i + 1}. {s.replaceAll("_", " ")} ✓
                </span>
              ))}
            </div>
            {Object.entries(report.provenance).map(([k, v]) => (
              <p key={k}>{k}: {v}</p>
            ))}
            <p className="mt-2 text-muted-foreground">
              Storage: {report.persistence.local} &middot; database: {report.persistence.database}
            </p>
            <ul className="list-disc pl-5 mt-2 text-muted-foreground">
              {report.uncertainty.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </div>

          {/* Report ID & meta */}
          <div className="border-t border-border/50 pt-2 text-muted-foreground">
            <p>Report ID: {report.id}</p>
            <p>Processed: {utc(report.processedAt ?? report.detectedAt)}</p>
          </div>
        </div>
      </details>
    </div>
  );
}

function InvestigationPage() {
  const { id } = Route.useSearch();
  const navigate = useNavigate();
  const client = useQueryClient();
  const {
    setActiveReportId,
    setActiveReport,
    clearActiveReport,
    activeReport,
    activeReportId,
    history,
    historyLoading,
  } = useIncident();

  const [prevId, setPrevId] = useState(id);
  const hasMounted = useRef(false);

  useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      if (id && id !== activeReportId) {
        setActiveReportId(id);
      }
      return;
    }

    if (id !== prevId) {
      // URL changed!
      setPrevId(id);
      if (id && id !== activeReportId) {
        setActiveReportId(id);
      }
    } else if (activeReportId !== id) {
      // Global context changed (e.g. from dropdown)! Update URL.
      if (activeReportId) {
        navigate({ to: "/analysis", search: { id: activeReportId }, replace: true });
      }
    }
  }, [id, prevId, activeReportId, setActiveReportId, navigate]);
  const [showControls, setShowControls] = useState(false);
  const [horizon, setHorizon] = useState(24);
  const [sceneId, setSceneId] = useState("demo-arabian-sea");
  const [onDemand, setOnDemand] = useState(false);
  const [hindcastHours, setHindcastHours] = useState(6);
  const [detector, setDetector] = useState<"hybrid" | "classical">("hybrid");
  const scenes = useQuery({
    queryKey: ["incident-scenes"],
    queryFn: listIncidentScenes,
    retry: false,
  });
  const mode =
    sceneId === "upload" ? "UPLOAD" : (scenes.data?.find((s) => s.id === sceneId)?.mode ?? "DEMO");
  const [seconds, setSeconds] = useState(0);

  const [pendingSavedId, setPendingSavedId] = useState("");
  const savedFetch = useQuery({
    queryKey: ["incident", pendingSavedId],
    queryFn: () => getIncident(pendingSavedId),
    enabled: !!pendingSavedId,
    retry: false,
  });

  useEffect(() => {
    if (savedFetch.data && savedFetch.data.id === pendingSavedId) {
      setActiveReport(savedFetch.data);
      setPendingSavedId("");
    }
  }, [savedFetch.data, pendingSavedId, setActiveReport]);

  const [savedDropdownValue, setSavedDropdownValue] = useState("");
  useEffect(() => {
    setSavedDropdownValue(activeReportId);
  }, [activeReportId]);

  const analysis = useMutation({
    mutationFn: analyzeIncident,
    onSuccess: (r) => {
      client.setQueryData(["incident", r.id], r);
      setActiveReport(r);
      void client.invalidateQueries({ queryKey: ["incidents"] });
      navigate({ to: "/analysis", search: { id: r.id } });
    },
  });

  useEffect(() => {
    if (!analysis.isPending) return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [analysis.isPending]);

  const analysisError = analysis.error;
  const savedFetchError = savedFetch.isError && pendingSavedId ? savedFetch.error : null;

  const button =
    "rounded border border-border bg-secondary px-3 py-2 text-xs font-mono font-semibold hover:bg-secondary/80 text-foreground transition-colors disabled:opacity-40 cursor-pointer";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">Investigation</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Complete evidence report with all pipeline stages
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowControls(!showControls)}
          className={button}
        >
          <Settings className="h-3 w-3 inline mr-1.5" />
          {showControls ? "Hide" : "Show"} Analysis Controls
        </button>
      </div>

      {/* Analysis Controls — collapsed by default when report is loaded */}
      {showControls && (
        <section className="rounded border border-border bg-card p-4 space-y-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground font-mono">
            Run New Analysis
          </h3>
          <div className="flex flex-wrap items-end gap-4">
            <label className="text-xs">
              Input scene
              <select
                value={sceneId}
                onChange={(e) => setSceneId(e.target.value)}
                className="mt-1 block rounded bg-secondary p-2 text-sm border border-border"
              >
                <option value="demo-arabian-sea">DEMO · Arabian Sea</option>
                <option value="demo-no-spill">DEMO · No spill</option>
                <option value="demo-inconclusive">DEMO · Inconclusive</option>
                {scenes.data
                  ?.filter((s) => s.mode === "REAL")
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      REAL · {s.name}
                    </option>
                  ))}
                <option value="upload">UPLOAD · SAR (512×512 GeoTIFF)</option>
              </select>
            </label>
            {mode !== "DEMO" && (
              <>
                {mode === "REAL" && (
                  <>
                    <label className="text-xs">
                      <input type="checkbox" checked={onDemand} onChange={(e) => setOnDemand(e.target.checked)} />{" "}
                      On-demand CDSE fetch
                    </label>
                    <label className="text-xs">
                      Detector
                      <select value={detector} onChange={(e) => setDetector(e.target.value as "hybrid" | "classical")} className="mt-1 block rounded bg-secondary p-2 text-sm border border-border">
                        <option value="hybrid">Hybrid</option>
                        <option value="classical">Classical</option>
                      </select>
                    </label>
                  </>
                )}
                <label className="text-xs">
                  Hindcast hours
                  <input type="number" min={1} max={48} step={1} value={hindcastHours} onChange={(e) => setHindcastHours(Number(e.target.value))} className="mt-1 block w-28 rounded bg-secondary p-2 text-sm border border-border" />
                </label>
              </>
            )}
            <label className="text-xs">
              Forecast
              <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} className="mt-1 block rounded bg-secondary p-2 text-sm border border-border">
                {[24, 48, 72].map((h) => (
                  <option key={h} value={h}>{h}h</option>
                ))}
              </select>
            </label>
            {sceneId !== "upload" && (
              <button
                className="rounded bg-primary px-3.5 py-2 text-xs font-mono font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-40 cursor-pointer"
                disabled={analysis.isPending}
                onClick={() => {
                  setSeconds(0);
                  analysis.mutate(
                    mode === "REAL"
                      ? { mode, sceneId, forecastHours: horizon, hindcastHours, detector, onDemand }
                      : { mode: "DEMO", sceneId, forecastHours: horizon },
                  );
                }}
              >
                {analysis.isPending ? `Analyzing… ${seconds}s` : `Analyze ${mode}`}
              </button>
            )}
          </div>
          {sceneId === "upload" && (
            <SARUpload
              disabled={analysis.isPending}
              forecastHours={horizon}
              hindcastHours={hindcastHours}
              onSuccess={(r) => {
                client.setQueryData(["incident", r.id], r);
                setActiveReport(r);
                void client.invalidateQueries({ queryKey: ["incidents"] });
                navigate({ to: "/analysis", search: { id: r.id } });
              }}
            />
          )}

          {/* Saved reports selector */}
          <div className="border-t border-border/50 pt-3">
            <label className="text-xs">
              <span className="text-muted-foreground">Or load a saved report:</span>
              <select
                disabled={analysis.isPending}
                className="mt-1 block max-w-xs rounded bg-secondary p-2 text-sm border border-border"
                value={savedDropdownValue}
                onChange={(e) => {
                  analysis.reset();
                  const newId = e.target.value;
                  setSavedDropdownValue(newId);
                  if (!newId) {
                    clearActiveReport();
                    setPendingSavedId("");
                    navigate({ to: "/analysis", search: {} });
                  } else {
                    const cached = client.getQueryData<typeof activeReport>(["incident", newId]);
                    if (cached) {
                      setActiveReport(cached);
                    } else {
                      setPendingSavedId(newId);
                    }
                    navigate({ to: "/analysis", search: { id: newId } });
                  }
                }}
              >
                <option value="">Select report</option>
                {history.map((r) => (
                  <option value={r.id} key={r.id}>
                    {getIncidentLabel(r)} · {r.status} · {r.detectedAt.slice(0, 16)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
      )}

      {/* Status messages */}
      {analysis.isPending && (
        <div role="status" className="rounded border border-border bg-card p-4 text-xs font-mono">
          Computing scientific pipeline on backend · {seconds}s elapsed.
        </div>
      )}
      {(analysisError || savedFetchError) && (
        <div role="alert" className="rounded border border-red-400/40 bg-red-500/5 p-3 text-xs">
          <p className="font-semibold text-red-400">{(analysisError || savedFetchError)?.message}</p>
          <p className="text-muted-foreground mt-1">
            Ensure the backend is running. No mock result has been substituted.
          </p>
          <button className={button + " mt-2"} onClick={() => { analysis.reset(); setPendingSavedId(""); clearActiveReport(); }}>
            Retry
          </button>
        </div>
      )}

      {/* Main content */}
      {!activeReport && !analysis.isPending && (
        <div className="rounded border border-border bg-card p-12 text-center space-y-3">
          <p className="text-sm font-medium text-foreground">No incident loaded</p>
          <p className="text-xs text-muted-foreground max-w-sm mx-auto">
            Click "Show Analysis Controls" above to run a new analysis or select a saved report.
          </p>
          <button type="button" onClick={() => setShowControls(true)} className="rounded bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground mt-2">
            Show Analysis Controls
          </button>
        </div>
      )}
      {activeReport && <InvestigationReport key={activeReport.id} report={activeReport} />}
    </div>
  );
}
