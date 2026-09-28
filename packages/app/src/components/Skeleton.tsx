import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("animate-pulse rounded-lg bg-muted", className)} />
  );
}

/**
 * Estados de carregamento do shell: o invólucro anuncia-se aos leitores de
 * ecrã (role=status + aria-busy), as barras são decorativas e ficam aria-hidden.
 */
function LoadingShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label="A carregar" className={className}>
      {children}
    </div>
  );
}

export function SkeletonCard({ children, loading }: { children: React.ReactNode; loading: boolean }) {
  if (!loading) return <>{children}</>;
  return (
    <LoadingShell className="stat-card p-4 space-y-2">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-6 w-24" />
      <Skeleton className="h-1.5 w-full" />
    </LoadingShell>
  );
}

export function MetricBarSkeleton() {
  return (
    <LoadingShell className="stat-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Skeleton className="w-3.5 h-3.5" />
          <Skeleton className="h-3 w-10" />
        </div>
        <Skeleton className="h-3 w-8" />
      </div>
      <Skeleton className="h-2.5 w-full" />
    </LoadingShell>
  );
}

export function StatCardSkeleton() {
  return (
    <LoadingShell className="stat-card p-4 flex items-center gap-3">
      <Skeleton className="w-9 h-9 rounded-lg" />
      <div className="space-y-1">
        <Skeleton className="h-2.5 w-16" />
        <Skeleton className="h-5 w-12" />
      </div>
    </LoadingShell>
  );
}
