import { apiClient } from "./client";

export interface QueueScene {
  id: number;
  scene_id: string;
  collection: string;
  bbox: number[];
  acquired_at: string;
  platform: string;
  orbit_direction: string;
  polarization: string;
  status: "queued" | "processing" | "completed" | "failed";
  queued_at: string;
  processing_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  retry_count: number;
  incident_id: string | null;
}

export interface IngestionQueueResponse {
  ok: boolean;
  total: number;
  limit: number;
  offset: number;
  scenes: QueueScene[];
}

export interface IngestionStatusResponse {
  ok: boolean;
  poller: {
    running: boolean;
    intervalMs: number;
    pollCount: number;
    errorCount: number;
    lastPollAt: string | null;
    lastSceneAt: string | null;
    lastError: string | null;
  };
  db: {
    sceneCounts: Record<string, number>;
    checkpoint: any;
  };
}

export interface WorkerStatusResponse {
  ok: boolean;
  status: {
    running: boolean;
    workerId: string;
    inFlight: boolean;
    intervalMs: number;
    staleThresholdMs: number;
    processedCount: number;
    failedCount: number;
    lastActivity: string | null;
    lastError: string | null;
  };
}

export const getIngestionQueue = (status = "all", limit = 50, offset = 0) =>
  apiClient<IngestionQueueResponse>(`/api/ingestion/queue?status=${status}&limit=${limit}&offset=${offset}`);

export const getIngestionStatus = () =>
  apiClient<IngestionStatusResponse>("/api/ingestion/status");

export const getWorkerStatus = () =>
  apiClient<WorkerStatusResponse>("/api/worker/status");

export const replayScene = (sceneId: string) =>
  apiClient("/api/ingestion/replay", {
    method: "POST",
    body: JSON.stringify({ sceneId }),
  });

export const recoverStale = () =>
  apiClient("/api/worker/recover-stale", {
    method: "POST",
  });
