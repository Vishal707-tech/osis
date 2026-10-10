import { createContext, useContext, useState, useCallback, useMemo, useEffect, useRef, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getIncident,
  listIncidents,
  type IncidentReport,
  type IncidentSummary,
} from "../api/incidents";

export interface IncidentContextType {
  /** The fully-loaded active report, or null if none selected. */
  activeReport: IncidentReport | null;
  /** Convenience: id of the active report ("" when none). */
  activeReportId: string;
  /**
   * Store a freshly-received IncidentReport as the active report.
   * Also seeds React Query cache so subsequent fetches hit the cache.
   */
  setActiveReport: (report: IncidentReport) => void;
  /**
   * Select a report by its UUID.  The full report is fetched from the API
   * (or resolved from the React Query cache) and then stored as the active report.
   */
  setActiveReportId: (id: string) => void;
  /** Clear the active report – shows the empty state on all pages. */
  clearActiveReport: () => void;

  /** History list from GET /api/incidents. */
  history: IncidentSummary[];
  historyLoading: boolean;
  historyError: Error | null;
  refetchHistory: () => void;

  /** Whether the system is auto-loading the first incident */
  autoLoading: boolean;
  /** Whether an incident switch is currently in flight */
  isSwitchingIncident: boolean;
}

const IncidentContext = createContext<IncidentContextType | null>(null);

export function IncidentProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [activeReport, setActiveReportState] = useState<IncidentReport | null>(null);
  // Track which report ID is "pending" when we want to load by ID.
  const [pendingId, setPendingId] = useState<string>("");
  // Track auto-loading state
  const autoLoadAttempted = useRef(false);
  const [autoLoading, setAutoLoading] = useState(false);

  // Fetch the history list.
  const {
    data: historyData,
    isLoading: historyLoading,
    error: historyError,
    refetch: refetchHistory,
  } = useQuery<IncidentSummary[], Error>({
    queryKey: ["incidents"],
    queryFn: listIncidents,
    staleTime: 30_000,
    retry: false,
  });

  // When a report ID is pending (from setActiveReportId), fetch it.
  const { data: fetchedReport, isLoading: isFetchingPending } = useQuery<IncidentReport>({
    queryKey: ["incident", pendingId],
    queryFn: () => getIncident(pendingId),
    enabled: !!pendingId,
    staleTime: 60_000,
    retry: false,
  });

  // Auto-load: when history arrives and no report is selected, pick the best default
  useEffect(() => {
    if (autoLoadAttempted.current) return;
    if (historyLoading || !historyData) return;
    if (activeReport || pendingId) return; // already have something or currently loading something

    autoLoadAttempted.current = true;

    if (historyData.length > 0) {
      // Find the most recent DEMO + SPILL_DETECTED report for demo-arabian-sea
      const arabianSeaSpill = historyData.find(
        (r) =>
          (r.sceneId === "demo-arabian-sea" || r.source === "synthetic_demo") &&
          r.outcome === "SPILL_DETECTED"
      );
      const bestDemo = historyData.find(
        (r) => (r.mode === "DEMO" || !r.mode) && r.outcome === "SPILL_DETECTED"
      );
      const target = arabianSeaSpill ?? bestDemo ?? historyData[0]; // fallback to most recent
      if (target) {
        setAutoLoading(true);
        // Try cache first
        const cached = queryClient.getQueryData<IncidentReport>(["incident", target.id]);
        if (cached) {
          setActiveReportState(cached);
          setAutoLoading(false);
        } else {
          setPendingId(target.id);
        }
      }
    } else {
      // History is empty; keep loading false and let the incident list provide reports
      setAutoLoading(false);
    }
  }, [historyData, historyLoading, activeReport, pendingId, queryClient]);

  // When pending report arrives, synchronize state & query client cache
  useEffect(() => {
    if (fetchedReport && pendingId && fetchedReport.id === pendingId) {
      queryClient.setQueryData(["incident", fetchedReport.id], fetchedReport);
      setActiveReportState(fetchedReport);
      setPendingId("");
      setAutoLoading(false);
    }
  }, [fetchedReport, pendingId, queryClient]);

  const setActiveReport = useCallback(
    (report: IncidentReport) => {
      // Seed cache so a subsequent setActiveReportId for this id is instant.
      queryClient.setQueryData(["incident", report.id], report);
      setActiveReportState(report);
      setPendingId(""); // clear pending
    },
    [queryClient],
  );

  const setActiveReportId = useCallback(
    (id: string) => {
      if (!id) return;
      // Try to resolve from cache immediately.
      const cached = queryClient.getQueryData<IncidentReport>(["incident", id]);
      if (cached) {
        setActiveReportState(cached);
        setPendingId("");
      } else {
        setActiveReportState(null); // clear stale report while loading new one
        setPendingId(id);
      }
    },
    [queryClient],
  );

  const clearActiveReport = useCallback(() => {
    setActiveReportState(null);
    setPendingId("");
  }, []);

  const finalReport: IncidentReport | null = (() => {
    if (!pendingId) return activeReport;
    if (fetchedReport && fetchedReport.id === pendingId) return fetchedReport;
    return null; // still loading
  })();

  const value = useMemo<IncidentContextType>(
    () => ({
      activeReport: finalReport,
      activeReportId: finalReport?.id ?? "",
      setActiveReport,
      setActiveReportId,
      clearActiveReport,
      history: (historyData ?? []).filter(r => !r.sceneId?.startsWith('test_')),
      historyLoading,
      historyError: historyError ?? null,
      refetchHistory: () => void refetchHistory(),
      autoLoading,
      isSwitchingIncident: !!pendingId || isFetchingPending,
    }),
    [
      finalReport,
      setActiveReport,
      setActiveReportId,
      clearActiveReport,
      historyData,
      historyLoading,
      historyError,
      refetchHistory,
      autoLoading,
      pendingId,
      isFetchingPending,
    ],
  );

  return <IncidentContext.Provider value={value}>{children}</IncidentContext.Provider>;
}

export function useIncident(): IncidentContextType {
  const context = useContext(IncidentContext);
  if (!context) {
    throw new Error("useIncident must be used within an IncidentProvider");
  }
  return context;
}
