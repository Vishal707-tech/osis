import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { getIngestionQueue, getIngestionStatus, getWorkerStatus, replayScene, recoverStale } from "../api/operations";
import { analyzeIncident } from "../api/incidents";
import { useIncident } from "../context/IncidentContext";
import { Panel, StatusDot } from "../components/ui-kit";
import { Activity, Database, Server, Loader2, ArrowRight, HardDrive, Cpu, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/operations")({
  component: OperationsDashboard,
});

function OperationsDashboard() {
  const navigate = useNavigate();
  const { setActiveReportId } = useIncident();

  const { data: ingestion, isLoading: ingestionLoading } = useQuery({
    queryKey: ["ingestionStatus"],
    queryFn: getIngestionStatus,
    refetchInterval: 5000,
  });

  const { data: worker, isLoading: workerLoading } = useQuery({
    queryKey: ["workerStatus"],
    queryFn: getWorkerStatus,
    refetchInterval: 5000,
  });

  const { data: queue, isLoading: queueLoading, refetch: refetchQueue } = useQuery({
    queryKey: ["ingestionQueue"],
    queryFn: () => getIngestionQueue("all", 50, 0),
    refetchInterval: 5000,
  });

  const analyzeMutation = useMutation({
    mutationFn: async (sceneId: string) => {
      const report = await analyzeIncident({ mode: "REAL", sceneId, forecastHours: 24 });
      return report;
    },
    onSuccess: (report) => {
      navigate({ to: "/analysis", search: { id: report.id } });
    },
  });

  const replayMutation = useMutation({
    mutationFn: replayScene,
    onSuccess: () => refetchQueue(),
  });

  const recoverStaleMutation = useMutation({
    mutationFn: recoverStale,
    onSuccess: () => refetchQueue(),
  });

  const utc = (iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}Z`;
  };

  return (
    <div className="space-y-6 pb-20">
      <div>
        <div className="flex items-center gap-2 text-[11px] font-mono text-[var(--primary)] uppercase tracking-[0.14em] mb-2">
          <Activity className="h-3.5 w-3.5" />
          <span>System Telemetry</span>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Operations Center
        </h1>
        <p className="text-xs text-muted-foreground mt-1 max-w-2xl leading-relaxed">
          Monitor autonomous Sentinel-1 acquisition and processing queue.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Poller Status */}
        <Panel className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Database className="h-4 w-4 text-[var(--primary)]" />
              CDSE Ingestion Poller
            </h2>
            <StatusDot label={ingestion?.poller.running ? "ACTIVE" : "STOPPED"} />
          </div>
          <div className="grid grid-cols-2 gap-4 text-xs font-mono text-muted-foreground bg-secondary/30 p-3 rounded border border-border">
            <div>
              <span className="block text-[10px] uppercase tracking-wider opacity-60 mb-1">Last Poll</span>
              <span className="text-foreground">{utc(ingestion?.poller.lastPollAt ?? null)}</span>
            </div>
            <div>
              <span className="block text-[10px] uppercase tracking-wider opacity-60 mb-1">DB Queued</span>
              <span className="text-foreground">{ingestion?.db.sceneCounts?.["queued"] ?? 0}</span>
            </div>
          </div>
        </Panel>

        {/* Worker Status */}
        <Panel className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Cpu className="h-4 w-4 text-[var(--primary)]" />
              Acquisition Worker
            </h2>
            <div className="flex items-center gap-3">
              <button
                onClick={() => recoverStaleMutation.mutate()}
                disabled={recoverStaleMutation.isPending}
                className="rounded border border-border bg-secondary px-2 py-1 text-[10px] font-mono font-medium text-foreground hover:bg-secondary/80 disabled:opacity-50 transition-colors"
              >
                {recoverStaleMutation.isPending ? "RECOVERING..." : "RECOVER STALE"}
              </button>
              <StatusDot label={worker?.status.running ? (worker?.status.inFlight ? "PROCESSING" : "IDLE") : "STOPPED"} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 text-xs font-mono text-muted-foreground bg-secondary/30 p-3 rounded border border-border">
            <div>
              <span className="block text-[10px] uppercase tracking-wider opacity-60 mb-1">Processed</span>
              <span className="text-foreground">{worker?.status.processedCount ?? 0}</span>
            </div>
            <div>
              <span className="block text-[10px] uppercase tracking-wider opacity-60 mb-1">Failed</span>
              <span className="text-foreground">{worker?.status.failedCount ?? 0}</span>
            </div>
            <div>
              <span className="block text-[10px] uppercase tracking-wider opacity-60 mb-1">Last Activity</span>
              <span className="text-foreground">{utc(worker?.status.lastActivity ?? null)}</span>
            </div>
          </div>
        </Panel>
      </div>

      <div className="space-y-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Server className="h-5 w-5" />
          Processing Queue
        </h2>
        
        <div className="rounded-md border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-secondary/50 border-b border-border text-[10px] uppercase font-mono tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Scene ID</th>
                  <th className="px-4 py-3 font-medium">Acquired (UTC)</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {!queueLoading && queue?.scenes.map((scene) => {
                  const isCompleted = scene.status === "completed";
                  const isFailed = scene.status === "failed";
                  const isProcessing = scene.status === "processing";
                  const detectionFailed = isCompleted && !scene.incident_id && scene.error_message?.startsWith("[detection_failed]");

                  let displayStatus = scene.status.toUpperCase();
                  if (isCompleted) {
                    if (scene.incident_id) displayStatus = "ANALYSIS READY";
                    else if (detectionFailed) displayStatus = "ANALYSIS FAILED";
                    else displayStatus = "ANALYSIS PENDING";
                  } else if (isFailed) {
                    displayStatus = "ACQUISITION FAILED";
                  }
                  
                  return (
                    <tr key={scene.id} className="hover:bg-secondary/20 transition-colors">
                      <td className="px-4 py-3 font-mono">
                        {scene.scene_id.slice(0, 30)}...
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {utc(scene.acquired_at)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusDot label={displayStatus} />
                        {scene.error_message && (
                          <div className="mt-1 text-[10px] text-rose-400 flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            <span className="truncate max-w-[200px]" title={scene.error_message}>
                              {scene.error_message}
                            </span>
                          </div>
                        )}
                        {scene.retry_count > 0 && (
                          <div className="mt-1 text-[10px] text-muted-foreground">
                            Retries: {scene.retry_count}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {scene.incident_id ? (
                          <button
                            onClick={() => {
                              setActiveReportId(scene.incident_id as string);
                              navigate({ to: "/analysis", search: { id: scene.incident_id as string } });
                            }}
                            className="inline-flex items-center gap-1.5 rounded bg-[var(--primary)]/10 px-2.5 py-1 text-[11px] font-mono font-medium text-[var(--primary)] hover:bg-[var(--primary)]/20 transition-colors"
                          >
                            VIEW ANALYSIS <ArrowRight className="h-3 w-3" />
                          </button>
                        ) : detectionFailed || isFailed ? (
                          <button
                            onClick={() => replayMutation.mutate(scene.scene_id)}
                            disabled={replayMutation.isPending}
                            className="inline-flex items-center gap-1.5 rounded border border-border bg-secondary px-2.5 py-1 text-[11px] font-mono font-medium text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
                          >
                            {replayMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "REPLAY"}
                          </button>
                        ) : isCompleted ? (
                          <button
                            onClick={() => analyzeMutation.mutate(scene.scene_id)}
                            disabled={analyzeMutation.isPending}
                            className="inline-flex items-center gap-1.5 rounded border border-border bg-secondary px-2.5 py-1 text-[11px] font-mono font-medium text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
                          >
                            {analyzeMutation.isPending ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              "ANALYZE PIPELINE"
                            )}
                          </button>
                        ) : (
                          <span className="text-muted-foreground text-[10px] uppercase">
                            {isProcessing ? "Working..." : "Waiting"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {queue?.scenes.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground font-mono">
                      Queue is empty
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
