export interface SpillLocation {
  latitude: number;
  longitude: number;
}

export interface SpillEstimatedAge {
  min: number;
  max: number;
  unit: string;
}

export interface Spill {
  id: string;
  location: SpillLocation;
  areaKm2: number;
  confidence: number;
  estimatedAge: SpillEstimatedAge;
  detectedAt: string;
  status: string;
  satelliteSource: string;
}

/**
 * Formats the estimated age object or string into a clean display label (e.g. "6–9 hours")
 */
export function formatSpillAge(age: SpillEstimatedAge | string | undefined | null): string {
  if (!age) return "";
  if (typeof age === "string") return age;
  return `${age.min}–${age.max} ${age.unit}`;
}
export interface SpillOrigin {
  latitude: number;
  longitude: number;
  uncertaintyKm: number;
  releaseWindow: {
    start: string;
    end: string;
  };
}

export interface CandidateVessel {
  id: string;
  name: string;
  mmsi: string;
  imo?: string;
  type: string;
  flag: string;
  speedKn: number;
  headingDeg: number;
  lastSeen: string;
  aisGapMin: number;
  track: [number, number][];
}

export interface AttributionScore {
  vesselId: string;
  mmsi: string;
  rank: number;
  suspicion: number;
  proximity: number;
  temporal: number;
  aisGap: number;
  vesselType: number;
  summary: string;
}

export interface DriftTrajectoryPoint {
  hoursAgo: number;
  lat: number;
  lon: number;
  label: string;
}

export interface SpillInvestigationResponse {
  id: string;
  spill: Spill & { polygon?: [number, number][] };
  origin: SpillOrigin | null;
  driftPath: DriftTrajectoryPoint[];
  vessels: CandidateVessel[];
  attribution: AttributionScore[];
}
