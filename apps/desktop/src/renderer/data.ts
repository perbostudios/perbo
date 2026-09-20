import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isLive } from "../shared/jobs.js";
import { useEffect } from "react";
import type { DesktopBridge, Request } from "../shared/protocol.js";
import { sampleBridge } from "../sample-host/bridge.js";
import { workspaceRefresh } from "./workspace-refresh.js";

const missingHost: DesktopBridge = {
  async request() {
    throw new Error(
      "The desktop connection did not load. Restart Perbo to reconnect to your local records.",
    );
  },
  subscribe() {
    return () => undefined;
  },
};
export const bridge: DesktopBridge =
  window.perbo ??
  (navigator.userAgent.includes("Electron/") ? missingHost : sampleBridge);
function useRefresh() {
  const client = useQueryClient();
  const refresh = workspaceRefresh(client, bridge);
  useEffect(refresh.connect, [refresh]);
  return refresh;
}
export function useWorkspace() {
  const refresh = useRefresh();
  return useQuery({
    queryKey: ["workspace"],
    queryFn: refresh.snapshot,
    networkMode: "always",
    refetchInterval: (query) =>
      query.state.data?.jobs.some(isLive)
        ? 2000
        : 15_000,
    staleTime: 1000,
  });
}
export function useAction() {
  useRefresh();
  return useMutation({
    mutationFn: (request: Request) => bridge.request(request),
    networkMode: "always",
  });
}
export function useDetail(repoId: string, key: string) {
  const refresh = useRefresh();
  return useQuery({
    queryKey: ["detail", repoId, key],
    queryFn: () => refresh.detail(repoId, key),
    networkMode: "always",
    staleTime: 2000,
  });
}
export function useOutput(
  repoId: string,
  key: string,
  attemptId: string | undefined,
) {
  const refresh = useRefresh();
  return useQuery({
    queryKey: ["output", repoId, key, attemptId],
    queryFn: () => refresh.output(repoId, key, attemptId),
    networkMode: "always",
    enabled: Boolean(attemptId),
    staleTime: 30_000,
  });
}
/** What a card or row can say about a ticket's work; read on demand, never for the whole listing. */
export function useTaskSummary(repoId: string, key: string, enabled = true) {
  const refresh = useRefresh();
  return useQuery({
    queryKey: ["summary", repoId, key],
    queryFn: () => refresh.summary(repoId, key),
    networkMode: "always",
    enabled,
    staleTime: 30_000,
  });
}
/** A plan's execution graph and what the run's records say about it (D-100, SCP-317). */
export function useGraph(repoId: string, key: string | null) {
  const refresh = useRefresh();
  return useQuery({
    queryKey: ["graph", repoId, key],
    queryFn: () => refresh.graph(repoId, key ?? ""),
    networkMode: "always",
    enabled: key !== null,
    staleTime: 1000,
  });
}
/** The month's ledger and each provider's own account of its plan. Read when asked, never on a timer (S6E). */
export function useUsage() {
  return useQuery({
    queryKey: ["usage"],
    queryFn: () => bridge.request({ kind: "usage" }),
    networkMode: "always",
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
