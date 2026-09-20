import { useEffect, useState, type RefObject } from "react";
import { AppState } from "react-native";
import type { MapRef } from "@maplibre/maplibre-react-native";
import type { ChartSnapshot } from "../offline/offline-style";
import type { ChartInformation } from "./chart-information";

// The same immutable version is used in VectorSource and metadata requests.
export function useOnlineChart(apiUrl: string, enabled: boolean) {
  const [chart, setChart] = useState<ChartSnapshot | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false, running = false;
    let controller: AbortController | undefined;
    const load = async () => {
      if (disposed || running || AppState.currentState !== "active") return;
      running = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 8000);
      try {
        const response = await fetch(`${apiUrl}/tiles/soundg.json`, { signal: controller.signal });
        if (!response.ok) throw new Error("Chart catalog unavailable");
        const result = await response.json() as ChartSnapshot;
        if (!result.version || !result.tiles?.length || !result.tiles.every((url) => url.includes(`/${result.version}/`))) throw new Error("Invalid chart catalog");
        if (!disposed) setChart((current) =>
          current?.version === result.version ? current : result
        );
      } catch { /* retry while there is no usable catalog */ }
      finally { running = false; clearTimeout(timeout); }
    };
    void load();
    const interval = setInterval(() => void load(), 30_000);
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") void load(); });
    return () => { disposed = true; controller?.abort(); clearInterval(interval); subscription.remove(); };
  }, [apiUrl, enabled]);
  return chart;
}

type ChartState = { chart: ChartInformation | null; message: string };

export function useChartInformation(
  apiUrl: string,
  mapRef: RefObject<MapRef | null>,
  enabled: boolean,
  version: string | undefined,
  longitude: number,
  latitude: number,
) {
  const key = `${version}/${longitude}/${latitude}`;
  const [state, setResult] = useState<ChartState & { key: string | null; loading: boolean }>({ chart: null, message: "", key: null, loading: false });
  useEffect(() => {
    const setState = (result: ChartState) => setResult({ ...result, key, loading: false });
    if (!enabled) { setResult({ chart: null, message: "", key: null, loading: false }); return; }
    setResult({ chart: null, message: "", key, loading: true });
    if (!version) { setState({ chart: null, message: "Chart data unavailable" }); return; }
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => controller.abort(), 8500);
    const debounce = setTimeout(() => {
      void (async () => {
        try {
          const view = await mapRef.current?.getViewState();
          if (disposed) return;
          if (!view) throw new Error("Map center unavailable");
          const [lon, lat] = view.center;
          const response = await fetch(`${apiUrl}/charts/at-point?lat=${lat}&lon=${lon}&version=${encodeURIComponent(version)}`, { signal: controller.signal });
          if (disposed) return;
          if (!response.ok) {
            setState({ chart: null, message: response.status === 404 || response.status === 409 ? "No nautical chart is available for this area." : "Chart information unavailable" });
            return;
          }
          const chart = await response.json() as ChartInformation;
          if (!chart.id || !chart.name || chart.version !== version) throw new Error("Invalid chart response");
          if (!disposed) setState({ chart, message: "" });
        } catch {
          if (!disposed) setState({ chart: null, message: "Unable to load chart information. Check your connection." });
        } finally { clearTimeout(timeout); }
      })();
    }, 200);
    return () => { disposed = true; clearTimeout(debounce); clearTimeout(timeout); controller.abort(); };
  }, [apiUrl, enabled, version, longitude, latitude, mapRef, key]);
  const loading = enabled && (state.key !== key || state.loading);
  return { chart: loading ? null : state.chart, message: loading ? "" : state.message,
    loading, ready: enabled && state.key === key && !state.loading };
}
