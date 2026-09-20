import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { AppState } from "react-native";
import type { MapRef } from "@maplibre/maplibre-react-native";
import { offlineAreas } from "./offline-areas";
import { activeAreas, type AreaRevision } from "./offline-engine";
import {
  usesCoordinateSoundgRoute,
  type AreaBounds,
} from "./offline-style";
import { DEFAULT_MAP_ZOOM } from "../map-config";

export const OFFLINE_VIEWPORT_DEBOUNCE_MS = 1500;
const CATALOG_TTL_MS = 10 * 60_000;
function contains(area: AreaRevision, bounds: AreaBounds) {
  return (
    area.bounds[0] <= bounds[0] &&
    area.bounds[1] <= bounds[1] &&
    area.bounds[2] >= bounds[2] &&
    area.bounds[3] >= bounds[3]
  );
}

// No new controls: native packs are prepared after the viewport settles.
export function useAutomaticOffline(
  mapRef: RefObject<MapRef | null>,
  apiUrl: string,
  baseStyleUrl: string,
) {
  const [ready, setReady] = useState(false);
  const [area, setArea] = useState<AreaRevision | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const request = useRef<{ bounds: AreaBounds; zoom: number } | null>(null);
  const checked = useRef(new Map<string, number>());
  const retryAfter = useRef(0);
  const [progress, setProgress] = useState({
    percentage: 0,
    bytes: 0,
    error: "",
  });
  useEffect(() => {
    mounted.current = true;
    void offlineAreas
      .recover()
      .then((records) => {
        if (mounted.current) {
          setArea(
            activeAreas(records)
              .filter((record) => usesCoordinateSoundgRoute(record.chart))
              .at(-1) ?? null,
          );
        }
      })
      .catch((e) => console.warn("Offline recovery", e))
      .finally(() => {
        if (mounted.current) setReady(true);
      });
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const run = useCallback(async () => {
    const target = request.current;
    if (!target || running.current || AppState.currentState !== "active")
      return;
    if (target.zoom < 10 || target.zoom > 16) return;
    running.current = true;
    try {
      const records = await offlineAreas.list();
      const existing = activeAreas(records).find((r) =>
        contains(r, target.bounds) &&
        r.minZoom <= DEFAULT_MAP_ZOOM && r.maxZoom >= DEFAULT_MAP_ZOOM,
      );
      const retry = records.find(
        (r) => r.state === "failed" && contains(r, target.bounds),
      );
      if (existing) {
        if (mounted.current) {
          setArea(usesCoordinateSoundgRoute(existing.chart) ? existing : null);
        }
        if (Date.now() < retryAfter.current) return;
        if (
          Date.now() - (checked.current.get(existing.id) ?? 0) <
          CATALOG_TTL_MS
        )
          return;
        if (!(await offlineAreas.isOutdated(existing, apiUrl))) {
          checked.current.set(existing.id, Date.now());
          return;
        }
      }
      if (Date.now() < retryAfter.current) return;
      const [w, s, e, n] = target.bounds;
      const dx = (e - w) * 0.15,
        dy = (n - s) * 0.15;
      const bounds: AreaBounds = existing?.bounds ??
        retry?.bounds ?? [
          Math.max(-180, w - dx),
          Math.max(-85, s - dy),
          Math.min(180, e + dx),
          Math.min(85, n + dy),
        ];
      const result = await offlineAreas.download(
        {
          name: `${((s + n) / 2).toFixed(3)}, ${((w + e) / 2).toFixed(3)}`,
          areaId: existing?.areaId ?? retry?.areaId,
          bounds,
          minZoom: DEFAULT_MAP_ZOOM,
          maxZoom: DEFAULT_MAP_ZOOM,
          apiUrl,
          baseStyleUrl,
        },
        (percentage, bytes) => {
          if (mounted.current) setProgress({ percentage, bytes, error: "" });
        },
      );
      checked.current.set(result.id, Date.now());
      if (
        mounted.current &&
        request.current &&
        contains(result, request.current.bounds)
      )
        setArea(result);
    } catch (error) {
      retryAfter.current = Date.now() + 60_000;
      if (mounted.current) setProgress((p) => ({ ...p, error: String(error) }));
      console.warn("Automatic offline", String(error));
    } finally {
      running.current = false;
      if (mounted.current && request.current !== target) {
        clearTimeout(timer.current);
        timer.current = setTimeout(
          () => void run(),
          OFFLINE_VIEWPORT_DEBOUNCE_MS,
        );
      }
    }
  }, [apiUrl, baseStyleUrl]);
  const onViewportSettled = useCallback(async () => {
    if (!ready || !mapRef.current) return;
    const [bounds, view] = await Promise.all([
      mapRef.current.getBounds(),
      mapRef.current.getViewState(),
    ]);
    request.current = { bounds, zoom: view.zoom };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(), OFFLINE_VIEWPORT_DEBOUNCE_MS);
  }, [ready, mapRef, run]);
  useEffect(() => {
    const interval = setInterval(() => void run(), 60_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void onViewportSettled().catch(() => {});
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [run, onViewportSettled]);
  return { ready, area, progress, onViewportSettled };
}
