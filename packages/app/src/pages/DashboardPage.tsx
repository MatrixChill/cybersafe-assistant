/** Real data container. Presentation is the original Design Lab composition. */
import { useEffect, useState, useMemo, useRef } from "react";
import LabDashboard, {
  type DashboardProps,
  type HistoryReading,
} from "@/v2/dashboard/LabDashboard";
import { decidePaginaHistorico } from "@/components/ScanHistoryPanel";
import { isAppShuttingDown } from "@/lib/shutdownState";
import { isHistoryEntry } from "@/v2/dashboard/model";
import { singleFlight } from "@/lib/progressiveRead";
export default function DashboardPage(props: DashboardProps) {
  const [history, setHistory] = useState<HistoryReading>({
    phase: "a_consultar",
    entry: null,
  });
  const generation = useRef(0);
  // One bounded summary read per connected mount. Full history/pagination is
  // still owned by ScanHistoryPanel; this is not a second history store/poller.
  const readSummary = useMemo(
    () =>
      singleFlight(async () =>
        window.electronAPI
          ? window.electronAPI.getScanHistory({ limit: 1 })
          : null,
      ),
    [props.serviceConnected, props.serviceGeneration],
  );
  useEffect(() => {
    let live = true;
    const epoch = ++generation.current;
    const api = window.electronAPI;
    if (props.serviceConnected !== true || !api) {
      setHistory({ phase: "sem_ligacao", entry: null });
      return;
    }
    setHistory({ phase: "a_consultar", entry: null });
    void readSummary()
      .then((page) => {
        if (!live || epoch !== generation.current || isAppShuttingDown())
          return;
        const read = decidePaginaHistorico(page);
        const valid =
          read.confirmada &&
          (!read.entradas.length || isHistoryEntry(read.entradas[0]));
        setHistory(
          valid && read.confirmada
            ? { phase: "pronto", entry: read.entradas[0] ?? null }
            : { phase: "sem_confirmacao", entry: null },
        );
      })
      .catch(() => {
        if (live && epoch === generation.current && !isAppShuttingDown())
          setHistory({ phase: "erro", entry: null });
      });
    return () => {
      live = false;
      generation.current++;
    };
  }, [props.serviceConnected, props.serviceGeneration, readSummary]);
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
