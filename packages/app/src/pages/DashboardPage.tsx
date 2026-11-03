/** Real data container. Presentation is the original Design Lab composition. */
import { useEffect, useState } from "react";
import LabDashboard, {
  type DashboardProps,
  type HistoryReading,
} from "@/v2/dashboard/LabDashboard";
import { decidePaginaHistorico } from "@/components/ScanHistoryPanel";
import { isAppShuttingDown } from "@/lib/shutdownState";
import { isHistoryEntry } from "@/v2/dashboard/model";

export default function DashboardPage(props: DashboardProps) {
  const [history, setHistory] = useState<HistoryReading>({
    phase: "a_consultar",
    entry: null,
  });

  useEffect(() => {
    const api = window.electronAPI;
    if (props.serviceConnected !== true || !api) {
      setHistory({ phase: "sem_ligacao", entry: null });
      return;
    }

    let live = true;
    let reading = false;
    let pending = false;
    const canRead = () => live && !isAppShuttingDown();
    setHistory({ phase: "a_consultar", entry: null });

    const refresh = async () => {
      if (!canRead()) return;
      pending = true;
      if (reading) return;
      reading = true;
      try {
        while (pending && canRead()) {
          pending = false;
          try {
            const page = await api.getScanHistory({ limit: 1 });
            if (!canRead() || pending) continue;
            const read = decidePaginaHistorico(page);
            const entry = read.confirmada ? read.entradas[0] ?? null : null;
            setHistory(
              read.confirmada && (entry === null || isHistoryEntry(entry))
                ? { phase: "pronto", entry }
                : { phase: "sem_confirmacao", entry: null },
            );
          } catch {
            if (canRead() && !pending) setHistory({ phase: "erro", entry: null });
          }
        }
      } finally {
        reading = false;
      }
    };

    // The service queues the history write before publishing terminal progress.
    const unsubscribe = api.onScanProgress?.((scan) => {
      if (scan?.id && ["completed", "cancelled", "failed"].includes(scan.status)) {
        void refresh();
      }
    });
    void refresh();
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [props.serviceConnected, props.serviceGeneration]);

  return (
    <LabDashboard
      {...props}
      history={
        props.serviceConnected === true
          ? history
          : { phase: "sem_ligacao", entry: null }
      }
    />
  );
}
