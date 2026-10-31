/**
 * TP-UPDATE-UI (17/10) — liga o controller REAL ao React.
 *
 * O controller vive num `useRef` (um por montagem) e é consumido por
 * `useSyncExternalStore` — sem estados duplicados e com cleanup de subscrição
 * no unmount. A ponte vem do preload (`window.electronAPI.appUpdate`); fora do
 * Electron (dev/testes/SSR) é `null` e a UI declara-o sem inventar dados.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createUpdatesController } from "./appUpdateController";
import type { UpdatesActions, UpdatesViewState } from "./appUpdateController";

export function useAppUpdates(): { state: UpdatesViewState; actions: UpdatesActions } {
  const controllerRef = useRef<ReturnType<typeof createUpdatesController> | null>(null);
  if (controllerRef.current === null) {
    const bridge = typeof window !== "undefined" ? window.electronAPI?.appUpdate ?? null : null;
    controllerRef.current = createUpdatesController(bridge);
  }
  const controller = controllerRef.current;

  // React StrictMode (activo em main.tsx) faz este efeito correr
  // start → dispose → start com a MESMA instância (o ref sobrevive). O
  // controller sabe reiniciar: `start()`
  // cancela a leitura anterior, liberta o `busy` herdado e relê o snapshot.
  // Por isso o cleanup faz dispose mas nunca destrói nem substitui a instância.
  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  const actions = useMemo<UpdatesActions>(
    () => ({
      refresh: () => {
        void controller.refresh();
      },
      check: () => {
        void controller.check();
      },
      download: () => {
        void controller.download();
      },
      cancel: () => {
        void controller.cancel();
      },
      defer: () => {
        void controller.defer();
      },
      install: (expectedVersion) => {
        void controller.install(expectedVersion);
      },
      setAutomaticCheck: (enabled) => {
        void controller.setAutomaticCheck(enabled);
      },
    }),
    [controller],
  );

  return { state, actions };
}
