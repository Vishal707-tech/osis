import { useQuery } from "@tanstack/react-query";
import { apiClient } from "./client";
import type { Spill, SpillInvestigationResponse } from "./types";

export * from "./types";

export async function fetchSpills(): Promise<Spill[]> {
  return apiClient<Spill[]>("/api/spills");
}

export async function fetchSpillById(id: string): Promise<SpillInvestigationResponse> {
  return apiClient<SpillInvestigationResponse>(`/api/spills/${id}`);
}

export async function fetchSpillInvestigation(id: string): Promise<SpillInvestigationResponse> {
  return apiClient<SpillInvestigationResponse>(`/api/spills/${id}`);
}

export function useSpills(initialData?: Spill[]) {
  return useQuery<Spill[], Error>({
    queryKey: ["spills"],
    queryFn: fetchSpills,
    staleTime: 30_000,
    retry: 2,
    ...(initialData !== undefined ? { initialData } : {}),
  });
}

export function useSpill(id?: string) {
  return useQuery<SpillInvestigationResponse>({
    queryKey: ["spills", id],
    queryFn: () => (id ? fetchSpillById(id) : Promise.reject("No id provided")),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function useSpillInvestigation(id?: string) {
  return useQuery<SpillInvestigationResponse>({
    queryKey: ["spills-investigation", id],
    queryFn: () => (id ? fetchSpillInvestigation(id) : Promise.reject("No id provided")),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}
