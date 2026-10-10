import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  Radar,
  Compass,
  Ship,
  Users,
  LayoutDashboard,
  Layers,
  ChevronDown,
  Loader2,
  Activity,
} from "lucide-react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { IncidentProvider, useIncident } from "../context/IncidentContext";
import { OutcomeBadge } from "../components/ui-kit";
import { getIncidentLabel } from "../api/incidents";

const NAV: { to: string; label: string; icon: typeof LayoutDashboard; exact?: boolean }[] = [
  { to: "/overview", label: "Overview", icon: LayoutDashboard, exact: true },
  { to: "/operations", label: "Operations", icon: Activity },
  { to: "/satellite", label: "Detection", icon: Radar },
  { to: "/backtracking", label: "Drift", icon: Compass },
  { to: "/ais", label: "Vessel Attribution", icon: Ship },
  { to: "/analysis", label: "Investigation", icon: Layers },
];

function NotFoundComponent() {
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-5xl font-mono font-bold text-foreground">404</h1>
        <p className="mt-3 text-xs text-muted-foreground font-mono">
          Route not found in the operations console.
        </p>
        <div className="mt-5 flex justify-center gap-2.5">
          <Link
            to="/"
            className="inline-flex rounded border border-border bg-secondary px-3.5 py-1.5 text-xs font-mono text-foreground transition-colors hover:bg-secondary/80"
          >
            Overview
          </Link>
          <Link
            to="/analysis"
            className="inline-flex rounded bg-primary px-3.5 py-1.5 text-xs font-mono font-medium text-primary-foreground"
          >
            Investigation
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-foreground font-mono">
          Operations Console Error
        </h1>
        <p className="mt-2 text-xs text-muted-foreground font-mono">
          An exception occurred while executing this analytical component.
        </p>
        <button
          onClick={() => {
            router.invalidate();
            reset();
          }}
          className="mt-5 rounded bg-primary px-4 py-2 text-xs font-mono font-medium text-primary-foreground"
        >
          Reset Console
        </button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    head: () => ({
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        {
          title:
            "O.S.I.S. — Oil Spill Identification & Source Attribution System",
        },
        {
          name: "description",
          content:
            "Satellite SAR oil spill detection with hydrodynamic Lagrangian drift backtracking and AIS vessel attribution.",
        },
        { property: "og:type", content: "website" },
        { name: "twitter:card", content: "summary_large_image" },
      ],
      links: [
        { rel: "stylesheet", href: appCss },
        { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
      ],
    }),
    shellComponent: RootShell,
    component: RootComponent,
    notFoundComponent: NotFoundComponent,
    errorComponent: ErrorComponent,
  },
);

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <IncidentProvider>
        <RootLayout />
      </IncidentProvider>
    </QueryClientProvider>
  );
}

function IncidentSelector() {
  const { activeReport, history, historyLoading, setActiveReportId, autoLoading, isSwitchingIncident } = useIncident();
  const [open, setOpen] = useState(false);

  const currentLabel = activeReport ? getIncidentLabel(activeReport) : "No incident selected";

  // Group history by scene for cleaner display
  const grouped = history.reduce<Record<string, typeof history>>((acc, item) => {
    const label = getIncidentLabel(item);
    if (!acc[label]) acc[label] = [];
    acc[label].push(item);
    return acc;
  }, {});

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-2 rounded border border-border bg-secondary/80 px-3 py-1.5 text-xs font-mono text-foreground hover:bg-secondary transition-colors"
      >
        <span className="text-muted-foreground text-[10px] uppercase tracking-wider">Incident:</span>
        {autoLoading || historyLoading || isSwitchingIncident ? (
          <span className="flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Loading…</span>
          </span>
        ) : (
          <span className="font-semibold">{currentLabel}</span>
        )}
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 z-50 w-80 max-h-80 overflow-y-auto rounded border border-border bg-card shadow-xl">
            <div className="p-2 border-b border-border">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono font-semibold px-2 py-1">
                Available Incidents
              </div>
            </div>
            <div className="p-1">
              {Object.entries(grouped).map(([label, items]) => {
                // Show the most recent item for each scene type
                const latest = items[0];
                if (!latest) return null;
                const isActive = activeReport?.id === latest.id;
                const outcomeLabel = latest.outcome === "SPILL_DETECTED" ? "✓ Spill Detected"
                  : latest.outcome === "NO_SPILL_DETECTED" ? "✓ No Spill"
                  : latest.outcome === "ANALYSIS_INCONCLUSIVE" ? "⚠ Inconclusive"
                  : latest.status;
                const modeLabel = latest.mode ?? "DEMO";

                return (
                  <button
                    key={latest.id}
                    type="button"
                    onClick={() => {
                      setActiveReportId(latest.id);
                      setOpen(false);
                    }}
                    className={`w-full text-left rounded px-3 py-2 text-xs transition-colors ${
                      isActive
                        ? "bg-primary/10 border border-primary/30 text-foreground"
                        : "hover:bg-secondary text-foreground"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">{label}</span>
                      <span className="rounded bg-secondary px-1.5 py-0.5 text-[9px] font-mono uppercase text-muted-foreground border border-border">
                        {modeLabel}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-1 text-[10px] text-muted-foreground">
                      <span>{outcomeLabel}</span>
                      <span>{latest.detectedAt.slice(0, 16).replace("T", " ")}</span>
                    </div>
                    {latest.sceneId && (
                      <div className="mt-1 text-[9px] font-mono text-muted-foreground truncate opacity-70" title={latest.sceneId}>
                        {latest.sceneId}
                      </div>
                    )}
                    {items.length > 1 && (
                      <div className="text-[9px] text-muted-foreground/70 mt-0.5">
                        +{items.length - 1} older report{items.length > 2 ? "s" : ""}
                      </div>
                    )}
                  </button>
                );
              })}
              {history.length === 0 && !historyLoading && (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  No saved reports. Generating Arabian Sea Demo…
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function RootLayout() {
  const { activeReport, autoLoading, isSwitchingIncident } = useIncident();
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  const currentLabel = activeReport ? getIncidentLabel(activeReport) : null;
  const isDemo = !activeReport || activeReport.mode === "DEMO" || !activeReport.mode;

  /* Landing page gets a minimal layout — no operational chrome */
  const isLanding = currentPath === "/";

  if (isLanding) {
    return (
      <>
        {/* Deep ocean background */}
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: -1,
            pointerEvents: 'none',
            background: 'linear-gradient(180deg, #02070E 0%, #041424 35%, #03101C 70%, #01060B 100%)',
          }}
        />
        <div className="relative min-h-screen flex flex-col">
          {/* Minimal landing header */}
          <header
            className="sticky top-0 z-40 border-b border-border"
            style={{ backgroundColor: 'var(--header)' }}
          >
            <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
              <Link to="/" className="group flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--primary)]/30 bg-[var(--primary)]/10 font-mono text-xs font-bold text-[var(--primary)] group-hover:bg-[var(--primary)]/15 transition-colors">
                  OS
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-bold tracking-[0.08em] text-foreground font-mono">
                    O.S.I.S.
                  </div>
                  <div className="text-[10px] text-muted-foreground font-mono">
                    Oil Spill Identification &amp; Source Attribution
                  </div>
                </div>
              </Link>
              <Link
                to="/overview"
                className="inline-flex items-center gap-2 rounded-md bg-[var(--primary)] px-4 py-2 text-xs font-mono font-semibold text-[var(--primary-foreground)] hover:opacity-90 transition-opacity"
              >
                Open Dashboard
              </Link>
            </div>
          </header>

          {/* Full-bleed content area for landing */}
          <main className="flex-1 w-full">
            <div className="mx-auto max-w-7xl px-5 sm:px-6 py-0">
              <Outlet />
            </div>
          </main>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="om-stars" aria-hidden="true" />
      <div className="relative min-h-screen flex flex-col">
        {/* Main Header */}
        <header className="sticky top-0 z-40 border-b border-border" style={{ backgroundColor: 'var(--header)' }}>
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-y-3 px-6 py-3">
            {/* Left brand */}
            <Link to="/" className="group flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--primary)]/30 bg-[var(--primary)]/10 font-mono text-xs font-bold text-[var(--primary)] group-hover:bg-[var(--primary)]/15 transition-colors">
                OS
              </div>
              <div className="min-w-0">
                <div className="text-sm font-bold tracking-[0.08em] text-foreground font-mono">
                  O.S.I.S.
                </div>
                <div className="text-[10px] text-muted-foreground font-mono">
                  Oil Spill Identification &amp; Source Attribution
                </div>
              </div>
            </Link>

            {/* Center: Incident Selector */}
            <div className="flex items-center gap-3">
              <IncidentSelector />
              {isDemo && activeReport && (
                <span className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[9px] font-mono font-semibold uppercase tracking-wider text-amber-300">
                  Demo
                </span>
              )}
            </div>

            {/* Right: Compact status */}
            <div className="hidden lg:flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
              {activeReport && (
                <OutcomeBadge outcome={activeReport.outcome ?? activeReport.status} />
              )}
            </div>
          </div>

          {/* Navigation Bar */}
          <div className="border-t border-border/60 bg-[var(--background)]/40">
            <nav className="mx-auto flex max-w-7xl items-center gap-0 px-6">
              {NAV.map((n) => {
                const Icon = n.icon;
                const isActive = n.exact
                  ? currentPath === n.to
                  : currentPath.startsWith(n.to);
                return (
                  <Link
                    key={n.to}
                    to={n.to}
                    className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors border-b-2 ${
                      isActive
                        ? "border-[var(--primary)] text-[var(--primary)] font-semibold"
                        : "border-transparent text-muted-foreground hover:text-foreground hover:border-[var(--border)]"
                    }`}
                  >
                    <Icon className={`h-3.5 w-3.5 ${isActive ? "opacity-100" : "opacity-60"}`} />
                    <span>{n.label}</span>
                  </Link>
                );
              })}
            </nav>
          </div>
        </header>

        {/* Auto-loading / switching indicator */}
        {(autoLoading || isSwitchingIncident) && (
          <div className="bg-[var(--primary)]/8 border-b border-[var(--primary)]/15 px-6 py-2 text-center text-xs font-mono text-[var(--primary)]">
            <Loader2 className="inline h-3 w-3 animate-spin mr-2" />
            Loading incident data — please wait…
          </div>
        )}

        {/* Main Viewport */}
        <main className="mx-auto max-w-7xl flex-1 w-full px-5 sm:px-6 py-7">
          <Outlet />
        </main>

        {/* Footer */}
        <footer className="border-t border-border/60 py-3.5 px-6 text-[11px] text-muted-foreground/80 font-mono" style={{ backgroundColor: 'var(--header)' }}>
          <div className="mx-auto max-w-7xl flex flex-wrap items-center justify-between gap-3">
            <div>
              <span className="text-muted-foreground">O.S.I.S.</span>
              <span className="text-muted-foreground/50"> · </span>
              <span>SIH PS26143</span>
              <span className="hidden md:inline text-muted-foreground/50">
                {" "}· Analytical evidence only, not legal attribution
              </span>
            </div>
            <div className="flex items-center gap-4 text-[11px]">
              {NAV.map((n) => (
                <Link key={n.to} to={n.to} className="hover:text-foreground transition-colors">
                  {n.label}
                </Link>
              ))}
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
