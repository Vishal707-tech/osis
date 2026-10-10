import { apiClient } from "./client";
export type AnalysisMode = "DEMO" | "REAL" | "UPLOAD";
export type AnalysisOutcome = "SPILL_DETECTED" | "NO_SPILL_DETECTED" | "ANALYSIS_INCONCLUSIVE";

export interface Position {
  lat: number;
  lon: number;
  timestamp: string;
  hours: number;
  uncertaintyKm: number;
}
export interface AISPosition {
  latitude: number;
  longitude: number;
  timestamp: string;
  speed: number;
  course: number;
}
export interface Anomaly {
  mmsi: string;
  start: AISPosition;
  end: AISPosition;
  durationHours: number;
  estimatedPosition: { lat: number; lon: number };
  label: string;
  anomalyScore: number;
}
export interface Candidate {
  mmsi: string;
  name: string;
  type: string;
  rank: number;
  score: number;
  confidence: string;
  closestDistanceKm: number;
  timeDifferenceHours: number;
  aisContinuity: number;
  continuityStatus: string;
  evidence: string;
  features: Record<string, number>;
  track: AISPosition[];
  trackSegments: AISPosition[][];
  anomalies: Anomaly[];
}
export interface Detection {
  geometry: { type: "Polygon"; coordinates: [number, number][][] };
  maskAreaKm2?: number;
  metrics: {
    areaKm2: number;
    perimeterM: number;
    lengthM: number;
    widthM: number;
    centroid: { lat: number; lon: number };
  };
  confidence: number;
  confidenceMeaning: string;
  geometryMethod: string;
}
export interface IncidentSummary {
  mode?: AnalysisMode;
  id: string;
  acquiredAt: string;
  detectedAt: string;
  status: string;
  outcome?: AnalysisOutcome;
  forecastHours: number;
  sceneId?: string;
  source?: string;
  leadingCandidate?: string | null;
}

/** Derive a human-readable incident name from a report or summary. */
export function getIncidentLabel(
  item: { mode?: string; sceneId?: string; source?: string; outcome?: string; id?: string; scene?: { id?: string; source?: string } } | null,
): string {
  if (!item) return "No incident selected";
  const sceneId = (item.sceneId ?? item.scene?.id ?? "").toLowerCase();
  const source = (item.source ?? item.scene?.source ?? "").toLowerCase();

  // Match specific scene IDs first to avoid colliding with common source strings
  if (sceneId === "demo-arabian-sea") return "Arabian Sea Demo";
  if (sceneId === "demo-no-spill") return "No-Spill Exercise";
  if (sceneId === "demo-inconclusive") return "Inconclusive Exercise";
  if (sceneId.includes("karnataka") || source.includes("karnataka")) return "Karnataka Sentinel-1A";
  if (sceneId.includes("wakashio") || source.includes("wakashio")) return "Wakashio";
  if (sceneId.includes("ulysse") || source.includes("ulysse")) return "Ulysse";

  if (source === "synthetic_demo") return "Arabian Sea Demo";
  if (source === "archived_sentinel1") return `Sentinel-1A (${sceneId.slice(0, 15)})`;
  if (item.mode === "UPLOAD") return "User Upload";
  if (item.mode === "REAL" && sceneId) {
    const s1Match = sceneId.match(/^s1([a-d])/i);
    const dateMatch = sceneId.match(/_(\d{4})(\d{2})(\d{2})t(\d{2})(\d{2})/i);
    if (s1Match) {
      const sat = `Sentinel-1${s1Match[1].toUpperCase()}`;
      if (dateMatch) {
        const [_, yyyy, mm, dd, hh, min] = dateMatch;
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const month = months[parseInt(mm, 10) - 1];
        return `${sat} · ${dd} ${month} ${yyyy} ${hh}:${min} UTC`;
      }
      return sat;
    }
    return `Real SAR — ${sceneId.slice(0, 20)}`;
  }
  if (item.mode === "REAL") return `Real SAR — ${item.id ? item.id.slice(0, 8) : "Active"}`;

  if (sceneId) {
    return sceneId.replace(/[-_]/g, " ").replace(/\b\w/g, (l) => l.toUpperCase());
  }
  if (item.id) {
    return `Incident ${item.id.slice(0, 8)}`;
  }
  return "Arabian Sea Demo";
}
export interface IncidentReport {
  mode?: AnalysisMode;
  outcome?: AnalysisOutcome;
  outcomeMessage?: string;
  outcomeReason?: string;
  availability?: string;
  processedAt?: string;
  evidenceProvenance?: Record<string, { kind: string; reason: string }>;
  hindcastHours?: number;
  stageStatus?: Record<string, { status: string; kind: string; reason: string }>;
  detector?: {
    name: string;
    status: string;
    checkpointSha256?: string | null;
    version?: string;
    quality?: Record<string, number | string>;
  };
  id: string;
  detectedAt: string;
  status: string;
  scene: {
    id: string;
    acquiredAt: string;
    source: string;
    width: number;
    height: number;
    bbox: [number, number, number, number] | null;
    pixels: (number | null)[][];
    polarization: string | string[];
    resolution_m: number[];
    nativeWidth?: number;
    nativeHeight?: number;
    assetSha256?: Record<string, string>;
    jointValidFraction?: number;
  };
  mask: number[][];
  detections: Detection[];
  spill?: Detection | null;
  age?: {
    minHours: number;
    maxHours: number;
    estimatedHours: number;
    confidence: string;
    method: string;
    caveat: string;
  } | null;
  origin?: (Position & { releaseWindow: { start: string; end: string } }) | null;
  backward: Position[];
  forward: Position[];
  forecastHours: number;
  candidates: Candidate[];
  anomalies: Anomaly[];
  leadingCandidate: string | null;
  environment: Record<string, number | string>;
  stages: string[];
  provenance: Record<string, string>;
  uncertainty: string[];
  disclaimer: string;
  persistence: { local: string; database: string };
  scoring: { weights: Record<string, number>; note: string };
}
export const listIncidents = () => apiClient<IncidentSummary[]>("/api/incidents");
export const getIncident = (id: string) =>
  apiClient<IncidentReport>(`/api/incidents/${encodeURIComponent(id)}`);
export interface AnalysisRequest {
  mode: "DEMO" | "REAL";
  sceneId: string;
  forecastHours: number;
  hindcastHours?: number;
  detector?: "hybrid" | "classical";
  onDemand?: boolean;
}
export interface IncidentScene {
  id: string;
  name: string;
  mode: "DEMO" | "REAL";
  source: string;
}
export const listIncidentScenes = () => apiClient<IncidentScene[]>("/api/incidents/scenes");
export const analyzeIncident = (request: number | AnalysisRequest) =>
  apiClient<IncidentReport>("/api/incidents/analyze", {
    method: "POST",
    body: JSON.stringify(
      typeof request === "number"
        ? { sceneId: "demo-arabian-sea", forecastHours: request }
        : request,
    ),
  });

export async function uploadSAR(
  vv: File,
  vh: File,
  acquiredAt: string,
  rasterUnits: string,
  sarAttested: boolean,
  forecastHours = 24,
  hindcastHours = 6,
) {
  if (vv.size > 8 * 1024 * 1024 || vh.size > 8 * 1024 * 1024)
    throw new Error(
      "UPLOAD ERROR: each polarization must be at most 8 MiB. Crop before uploading.",
    );
  return apiClient<IncidentReport>("/api/incidents/upload", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-OSIS-SAR-Metadata": encodeURIComponent(
        JSON.stringify({
          vvBytes: vv.size,
          vvName: vv.name,
          vhName: vh.name,
          acquiredAt,
          rasterUnits,
          sarAttested,
          forecastHours,
          hindcastHours,
        }),
      ),
    },
    body: new Blob([vv, vh]),
  });
}
