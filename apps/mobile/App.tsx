import {
  Camera,
  type CameraRef,
  type MapRef,
  Layer,
  Map,
  OfflineManager,
  VectorSource,
} from "@maplibre/maplibre-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSharedValue } from "react-native-reanimated";
import { useCameraEvents } from "./map/use-camera-events";
import { isWithinChartBounds } from "./map/chart-bounds";
import { ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";

import { ScaleRuler } from "./components/ScaleRuler";
import { CompassPanel } from "./components/CompassPanel";
import { BlurBottomSheet } from "./components/BlurBottomSheet";
import { BlurText } from "./components/BlurText";
import { UserLocationMarker } from "./components/UserLocationMarker";
import {
  MapControlsPanel,
  type MapStyleMode,
} from "./components/MapControlsPanel";
import { GpsAccuracyPanel } from "./components/GpsAccuracyPanel";
import { CenterCoordinatesPanel } from "./components/CenterCoordinatesPanel";
import {
  NavigationDataPanel,
  GfsConditionsPanel,
} from "./components/NavigationDataPanel";
import { RouteStatusPanel } from "./components/RouteStatusPanel";
import { MapOverlayGrid, MapOverlaySlot } from "./components/MapOverlayGrid";
import { DrawerCompass } from "./components/DrawerCompass";
import { useDeviceLocation } from "./location/use-device-location";
import { NativeWindLayer, type NativeWindField } from "@maris/native-wind";
import { MAP_AMBIENT_CACHE_BYTES } from "./offline/offline-areas";
import { useAutomaticOffline } from "./offline/use-automatic-offline";
import { DEFAULT_MAP_ZOOM } from "./map-config";
import { useChartInformation, useOnlineChart } from "./charts/current-chart";
import { chartInformationRows } from "./charts/chart-information";
import { useGfsPoint, useGfsViewport } from "./weather/gfs-client";
import { viewportTileCoverage } from "./map/viewport-tile-coverage";
import type { GfsBounds, MapCenter } from "./weather/gfs-grid";

const BASE_MAP_STYLE = "https://tiles.openfreemap.org/styles/bright";
const GOOGLE_SATELLITE_STYLE = JSON.stringify({
  version: 8,
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {
    "google-satellite": {
      type: "raster",
      tiles: [
        "https://mt0.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
        "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
        "https://mt2.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
        "https://mt3.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
      ],
      tileSize: 256,
    },
  },
  layers: [
    {
      id: "google-satellite",
      type: "raster",
      source: "google-satellite",
    },
  ],
});
const API_URL =
  process.env.EXPO_PUBLIC_API_URL ??
  "https://api-production-7dc7.up.railway.app";
const LOCATION_MATCH_THRESHOLD_KM = 0.08;
const ROUTE_STATUS_ENABLED = false;
let nativeWindFieldPerfLastLog = Date.now();
let nativeWindFieldPerfCalls = 0;

function recordNativeWindFieldPerf() {
  if (!__DEV__) return;
  nativeWindFieldPerfCalls += 1;
  const now = Date.now();
  if (now - nativeWindFieldPerfLastLog < 1_000) return;
  console.debug("[GFS perf]", {
    nativeWindFieldPerSecond: nativeWindFieldPerfCalls,
  });
  nativeWindFieldPerfCalls = 0;
  nativeWindFieldPerfLastLog = now;
}
type SheetContent = "chart" | "empty";

function distanceKm(a: [number, number], b: [number, number]) {
  const [longitudeA, latitudeA] = a;
  const [longitudeB, latitudeB] = b;
  const latitudeDelta = ((latitudeB - latitudeA) * Math.PI) / 180;
  const longitudeDelta = ((longitudeB - longitudeA) * Math.PI) / 180;
  const meanLatitude = (((latitudeA + latitudeB) / 2) * Math.PI) / 180;
  const x = longitudeDelta * Math.cos(meanLatitude);
  const y = latitudeDelta;
  return Math.sqrt(x * x + y * y) * 6_371;
}

export default function App() {
  const { width } = useWindowDimensions();
  const deviceLocation = useDeviceLocation();
  const compassMapBearing = useSharedValue(0);
  const unavailableHeading = useSharedValue<number | null>(null);
  const mapRef = useRef<MapRef>(null);
  const [visibleBounds, setVisibleBounds] = useState<GfsBounds | null>(null);
  const {
    ready: offlineReady,
    area: offlineArea,
    onViewportSettled,
  } = useAutomaticOffline(mapRef, API_URL, BASE_MAP_STYLE);
  const initialCenter: MapCenter = deviceLocation?.coordinate ?? [0, 0];
  const [viewState, setViewState] = useState({
    longitude: initialCenter[0],
    latitude: initialCenter[1],
    zoom: DEFAULT_MAP_ZOOM,
    bearing: 0,
  });
  const [isZooming, setIsZooming] = useState(false);
  const lastZoom = useRef(DEFAULT_MAP_ZOOM);
  const cameraRef = useRef<CameraRef>(null);
  const [locationActive, setLocationActive] = useState(false);
  const [courseUp, setCourseUp] = useState(false);
  const [mapStyleMode, setMapStyleMode] = useState<
    MapStyleMode | "initial"
  >("initial");
  const windEnabled = true;
  const [mapSheetVisible, setMapSheetVisible] = useState(false);
  const [chartRequested, setChartRequested] = useState(false);
  const chartRequestPending = useRef(false);
  const [sheetContent, setSheetContent] = useState<SheetContent>("chart");
  const [mapSheetCloseSignal, setMapSheetCloseSignal] = useState(0);
  const [windSampleCoordinate, setWindSampleCoordinate] = useState<MapCenter | null>(null);
  const boundsRefreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const locationTarget = useRef(false);
  const initialLocationApplied = useRef(false);
  const courseUpTransitionPending = useRef(false);
  const onlineChart = useOnlineChart(API_URL, offlineReady && !offlineArea);
  const displayedChart = offlineArea?.chart ?? onlineChart;
  const mapButtonVisible = isWithinChartBounds(displayedChart?.bounds, viewState.longitude, viewState.latitude);
  const chartInformation = useChartInformation(API_URL, mapRef,
    chartRequested && mapButtonVisible && sheetContent === "chart", displayedChart?.version,
    viewState.longitude, viewState.latitude);
  const chartRows = chartInformation.chart ? chartInformationRows(chartInformation.chart) : [];

  useEffect(() => {
    if (!mapButtonVisible && chartRequested) {
      chartRequestPending.current = false;
      setChartRequested(false);
      if (sheetContent === "chart") setMapSheetVisible(false);
    }
  }, [mapButtonVisible, chartRequested, sheetContent]);

  useEffect(() => {
    if (chartRequested && chartInformation.ready && sheetContent === "chart") {
      chartRequestPending.current = false;
      setMapSheetVisible(true);
    }
  }, [chartRequested, chartInformation.ready, sheetContent]);

  useEffect(() => {
    if (deviceLocation && !initialLocationApplied.current) {
      initialLocationApplied.current = true;
      setLocationActive(true);
    }
  }, [deviceLocation]);

  useEffect(() => {
    if (
      !courseUp ||
      deviceLocation?.heading === null ||
      deviceLocation?.heading === undefined
    ) {
      return;
    }

    if (courseUpTransitionPending.current) {
      courseUpTransitionPending.current = false;
      return;
    }

    cameraRef.current?.jumpTo({
      center: deviceLocation.coordinate,
      zoom: lastZoom.current,
      bearing: deviceLocation.heading,
    });
  }, [
    courseUp,
    deviceLocation?.heading,
    deviceLocation?.coordinate[0],
    deviceLocation?.coordinate[1],
  ]);

  const scaleMaxWidth = Math.min(width - 96, 175);
  const gfs = useGfsViewport(
    API_URL,
    visibleBounds,
    [viewState.longitude, viewState.latitude],
    viewState.zoom,
    offlineReady,
  );
  const centerGfs = useGfsPoint(
    API_URL,
    [viewState.longitude, viewState.latitude],
    DEFAULT_MAP_ZOOM,
    offlineReady,
  );
  const windViewportCoverage = useMemo(
    () => viewportTileCoverage(visibleBounds, (gfs.activeTileEntries ?? []).map((entry) => entry.tile)),
    [
      visibleBounds?.north,
      visibleBounds?.south,
      visibleBounds?.east,
      visibleBounds?.west,
      gfs.activeTileEntries,
    ],
  );
  const nativeSentTiles = useRef<{
    identity: string;
    versions: globalThis.Map<string, string>;
  }>({ identity: '', versions: new globalThis.Map() });
  const nativeWindField = useMemo<NativeWindField | null>(() => {
    const activeEntries = gfs.activeTileEntries ?? [];
    const first = activeEntries[0]?.grid;
    if (!first || !activeEntries.length) {
      nativeSentTiles.current = { identity: '', versions: new globalThis.Map() };
      return null;
    }
    const sourceZoom = activeEntries[0]!.tile.z;
    const identity = [
      first.run,
      first.model,
      first.forecastTime,
      sourceZoom,
      first.resolution,
    ].join('|');
    if (nativeSentTiles.current.identity !== identity) {
      nativeSentTiles.current = { identity, versions: new globalThis.Map() };
    }
    const tiles = activeEntries
      .filter((entry) => {
        const tileKey = `${entry.tile.z}/${entry.tile.x}/${entry.tile.y}`;
        const version = `${entry.savedAt}|${entry.etag ?? ''}`;
        if (nativeSentTiles.current.versions.get(tileKey) === version) return false;
        nativeSentTiles.current.versions.set(tileKey, version);
        return true;
      })
      .map((entry) => {
        const grid = entry.grid;
        const windU = grid.fields.windU;
        const windV = grid.fields.windV;
        if (!windU || !windV) return null;
        return {
          z: entry.tile.z,
          x: entry.tile.x,
          y: entry.tile.y,
          version: `${entry.savedAt}|${entry.etag ?? ''}`,
          bounds: grid.bounds,
          width: grid.width,
          height: grid.height,
          windU,
          windV,
        };
      })
      .filter((tile): tile is NonNullable<typeof tile> => tile !== null);
    recordNativeWindFieldPerf();
    return {
      tiles,
      forecastTime: first.forecastTime,
      run: first.run,
      model: first.model,
      sourceZoom,
      resolution: first.resolution,
      fieldKey: identity,
    };
  }, [gfs.activeTileEntries]);

  const refreshVisibleBounds = (immediate = false) => {
    if (!immediate) {
      if (boundsRefreshTimer.current) return;
      boundsRefreshTimer.current = setTimeout(() => {
        boundsRefreshTimer.current = undefined;
        refreshVisibleBounds(true);
      }, 250);
      return;
    }
    if (boundsRefreshTimer.current) {
      clearTimeout(boundsRefreshTimer.current);
      boundsRefreshTimer.current = undefined;
    }
    void mapRef.current?.getBounds().then(([west, south, east, north]) => {
      if ([west, south, east, north].every(Number.isFinite)) {
        setVisibleBounds({ north, south, east, west });
      }
    }).catch(() => {});
  };

  useEffect(() => {
    void OfflineManager.setMaximumAmbientCacheSize(MAP_AMBIENT_CACHE_BYTES);
  }, []);

  const cameraEvents = useCameraEvents((view, settled) => {
    const zoomChanged = Math.abs(view.zoom - lastZoom.current) > 0.0001;
    lastZoom.current = view.zoom;
    if (settled) setIsZooming(false);
    else if (zoomChanged) setIsZooming(true);

    if (deviceLocation) {
      const atLocation = distanceKm(view.center, deviceLocation.coordinate) <= LOCATION_MATCH_THRESHOLD_KM;
      if (settled) {
        locationTarget.current = false;
        setLocationActive(atLocation);
      } else if (!locationTarget.current && !atLocation) {
        setLocationActive(false);
        setCourseUp(false);
      }
    }
    setViewState(previous => previous.longitude === view.center[0] &&
      previous.latitude === view.center[1] && previous.zoom === view.zoom &&
      previous.bearing === view.bearing ? previous : {
        longitude: view.center[0], latitude: view.center[1], zoom: view.zoom, bearing: view.bearing,
      });
    if (windEnabled) setWindSampleCoordinate(previous =>
      previous?.[0] === view.center[0] && previous?.[1] === view.center[1] ? previous : [...view.center]);
    if (settled) {
      void onViewportSettled().catch(() => {});
      refreshVisibleBounds(true);
    } else {
      // Preload the whole visible viewport while zooming/panning, not only
      // after its center reaches a previously uncovered area.
      refreshVisibleBounds();
    }
  }, (view) => { compassMapBearing.value = view.bearing; });

  useEffect(() => () => {
    if (boundsRefreshTimer.current) clearTimeout(boundsRefreshTimer.current);
  }, []);

  if (!offlineReady || (!deviceLocation && !offlineArea)) {
    return <View style={styles.container} />;
  }

  return (
    <View style={styles.container}>
      <Map
        ref={mapRef}
        style={styles.map}
        mapStyle={
          mapStyleMode === "satellite"
            ? GOOGLE_SATELLITE_STYLE
            : mapStyleMode === "bright"
                ? BASE_MAP_STYLE
                : offlineArea
              ? JSON.stringify(offlineArea.baseStyle)
              : BASE_MAP_STYLE
        }
        logo={false}
        attribution={false}
        compass={false}
        scaleBar={false}
        touchZoom
        touchRotate
        touchPitch={false}
        onDidFinishLoadingMap={() => {
          void onViewportSettled().catch(() => {});
          refreshVisibleBounds();
        }}
        onTouchStart={() => {
          if (mapSheetVisible) setMapSheetCloseSignal((signal) => signal + 1);
        }}
        onRegionIsChanging={cameraEvents.onRegionIsChanging}
        onRegionDidChange={cameraEvents.onRegionDidChange}
      >
        {mapStyleMode !== "satellite" ? (
          <>
            <Layer
              id="poi_r20"
              type="symbol"
              source="openmaptiles"
              source-layer="poi"
              filter={[
                "all",
                ["match", ["geometry-type"], ["MultiPoint", "Point"], true, false],
                [">=", ["get", "rank"], 20],
                ["match", ["get", "class"], ["bus"], false, true],
              ]}
            />
            <Layer
              id="poi_r7"
              type="symbol"
              source="openmaptiles"
              source-layer="poi"
              filter={[
                "all",
                ["match", ["geometry-type"], ["MultiPoint", "Point"], true, false],
                [">=", ["get", "rank"], 7],
                ["<", ["get", "rank"], 20],
                ["match", ["get", "class"], ["bus"], false, true],
              ]}
            />
            <Layer
              id="poi_r1"
              type="symbol"
              source="openmaptiles"
              source-layer="poi"
              filter={[
                "all",
                ["match", ["geometry-type"], ["MultiPoint", "Point"], true, false],
                [">=", ["get", "rank"], 1],
                ["<", ["get", "rank"], 7],
                ["match", ["get", "class"], ["bus"], false, true],
              ]}
            />
            <Layer
              id="poi_transit"
              type="symbol"
              source="openmaptiles"
              source-layer="poi"
              filter={["match", ["get", "class"], ["airport", "rail"], true, false]}
            />
          </>
        ) : null}
        <Camera
          ref={cameraRef}
          key="gps-camera"
          initialViewState={{
            center: deviceLocation?.coordinate ?? [(offlineArea!.bounds[0]+offlineArea!.bounds[2])/2,(offlineArea!.bounds[1]+offlineArea!.bounds[3])/2],
            zoom: offlineArea ? Math.min(offlineArea.maxZoom,Math.max(offlineArea.minZoom,DEFAULT_MAP_ZOOM)) : DEFAULT_MAP_ZOOM,
          }}
        />
        {displayedChart ? <VectorSource
          key={displayedChart.version}
          id="miami-soundg"
          tiles={displayedChart.tiles}
          minzoom={displayedChart.minzoom}
          maxzoom={displayedChart.maxzoom}
        >
          <Layer
            id="miami-soundg-depth"
            type="symbol"
            source-layer="soundings"
            beforeId={
              mapStyleMode !== "satellite"
                ? "water_name_point_label"
                : undefined
            }
            minzoom={10}
            layout={{
              "text-field": ["to-string", ["get", "DEPTH"]],
              "text-font": ["Noto Sans Regular"],
              "text-size": ["interpolate", ["linear"], ["zoom"], 10, 9, 14, 12],
              "text-padding": 1,
            }}
            paint={{
              "text-color": "#173f4d",
              "text-halo-color": "#dceef3",
              "text-halo-width": 1,
            }}
          />
        </VectorSource> : null}
        {deviceLocation ? (
          <UserLocationMarker
            coordinate={deviceLocation.coordinate}
            heading={deviceLocation.heading}
            mapBearing={viewState.bearing}
            courseUp={courseUp}
          />
        ) : null}
      </Map>
      <NativeWindLayer
        enabled={windEnabled}
        opacity={1.0}
        density={windViewportCoverage}
        animationSpeed={1}
        windField={nativeWindField}
        sampleCoordinate={windEnabled
          ? (windSampleCoordinate ?? [viewState.longitude, viewState.latitude])
          : null}
        style={{ width: 0, height: 0, position: "absolute" }}
      />
      <MapOverlayGrid>
        <MapOverlaySlot column={2} row={5} columnSpan={2} alignItems="center">
          <ScaleRuler
            latitude={viewState.latitude}
            maxWidth={scaleMaxWidth}
            viewportWidth={width}
            visible={isZooming}
            zoom={viewState.zoom}
          />
        </MapOverlaySlot>
        <MapOverlaySlot
          column={5}
          row={ROUTE_STATUS_ENABLED ? 4 : 8}
          rowSpan={ROUTE_STATUS_ENABLED ? 6 : 9}
          alignItems="flex-end"
          justifyContent="flex-end"
        >
          <View pointerEvents="box-none" style={styles.controlsStack}>
            <CompassPanel
              heading={deviceLocation?.heading ?? null}
              mapBearingValue={compassMapBearing}
              onPress={() => {
                const normalizedBearing =
                  ((compassMapBearing.value % 360) + 360) % 360;
                const distanceFromNorth = Math.min(
                  normalizedBearing,
                  360 - normalizedBearing,
                );
                if (distanceFromNorth < 0.001) {
                  chartRequestPending.current = false;
                  setChartRequested(false);
                  setSheetContent("empty");
                  setMapSheetVisible(true);
                  return;
                }
                setSheetContent("chart");
                locationTarget.current = false;
                setCourseUp(false);
                cameraRef.current?.flyTo({
                  center: [viewState.longitude, viewState.latitude],
                  zoom: viewState.zoom,
                  bearing: 0,
                  duration: 500,
                });
              }}
            />
            <MapControlsPanel
              locationActive={locationActive}
              courseUp={courseUp}
              onMapModeChange={setMapStyleMode}
              showMapButton={mapButtonVisible}
              mapLoading={chartRequested && chartInformation.loading && !mapSheetVisible}
              onMapPress={() => {
                if (!mapButtonVisible || chartRequestPending.current || (mapSheetVisible && sheetContent === "chart")) return;
                chartRequestPending.current = true;
                setMapSheetVisible(false);
                setSheetContent("chart");
                setChartRequested(true);
              }}
              onLocate={() => {
                if (!deviceLocation) return;
                locationTarget.current = true;
                const shouldEnableCourseUp = locationActive;
                const canAlignHeading = shouldEnableCourseUp && deviceLocation.heading !== null;
                courseUpTransitionPending.current = canAlignHeading && !courseUp;
                cameraRef.current?.flyTo({
                  center: deviceLocation.coordinate,
                  zoom: shouldEnableCourseUp ? viewState.zoom : DEFAULT_MAP_ZOOM,
                  ...(canAlignHeading ? { bearing: deviceLocation.heading! } : {}),
                  duration: 500,
                });
                setLocationActive(true);
                setCourseUp(shouldEnableCourseUp);
              }}
            />
          </View>
        </MapOverlaySlot>
        {ROUTE_STATUS_ENABLED ? (
          <MapOverlaySlot column={0} row={10} columnSpan={6} rowSpan={10} alignItems="stretch" justifyContent="flex-end">
            <RouteStatusPanel />
          </MapOverlaySlot>
        ) : null}
        <MapOverlaySlot column={0} row={20} columnSpan={6} rowSpan={3} alignItems="stretch" justifyContent="flex-end">
          <NavigationDataPanel
            cog={deviceLocation?.cog}
            heading={deviceLocation?.heading}
            speed={deviceLocation?.speed}
          />
        </MapOverlaySlot>
        <MapOverlaySlot column={0} row={23} columnSpan={2} rowSpan={1} alignItems="flex-start" justifyContent="flex-end">
          <GpsAccuracyPanel accuracy={deviceLocation?.accuracy ?? null} />
        </MapOverlaySlot>
        <MapOverlaySlot column={3} row={23} columnSpan={3} rowSpan={1} alignItems="flex-end" justifyContent="flex-end">
          <CenterCoordinatesPanel latitude={viewState.latitude} longitude={viewState.longitude} />
        </MapOverlaySlot>
        <MapOverlaySlot column={0} row={0} columnSpan={6} rowSpan={5} alignItems="stretch" justifyContent="flex-start">
          <GfsConditionsPanel sample={centerGfs.current ?? undefined} />
        </MapOverlaySlot>
      </MapOverlayGrid>
      <BlurBottomSheet
        visible={mapSheetVisible}
        closeSignal={mapSheetCloseSignal}
        onClose={() => {
          chartRequestPending.current = false;
          setChartRequested(false);
          setMapSheetVisible(false);
        }}
      >
        {sheetContent === "chart" ? (
          <>
            <BlurText style={styles.sheetTitle}>Chart information</BlurText>
            <ScrollView
              style={styles.chartInfoList}
              contentContainerStyle={styles.chartInfoContent}
              showsVerticalScrollIndicator
              persistentScrollbar
            >
              {chartInformation.message ? <BlurText style={styles.chartInfoMessage}>{chartInformation.message}</BlurText> : null}
              {chartRows.map(([label, value], index) => (
                <View key={label} style={styles.chartInfoRow}>
                  <BlurText style={styles.chartInfoLabel}>{label}</BlurText>
                  <BlurText style={styles.chartInfoValue}>{value}</BlurText>
                  {index < chartRows.length - 1 ? (
                    <View style={styles.chartInfoDivider} />
                  ) : null}
                </View>
              ))}
            </ScrollView>
          </>
        ) : (
          <DrawerCompass headingValue={deviceLocation?.headingValue ?? unavailableHeading} />
        )}
      </BlurBottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  sheetTitle: {
    fontSize: 22,
    fontWeight: "700",
    lineHeight: 28,
    marginBottom: 10,
  },
  chartInfoList: {
    maxHeight: 520,
    marginRight: -20,
  },
  chartInfoContent: {
    paddingBottom: 4,
    paddingRight: 20,
  },
  chartInfoRow: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
    position: "relative",
  },
  chartInfoLabel: {
    flex: 0.9,
    color: "rgba(255, 255, 255, 0.62)",
    fontSize: 13,
    fontWeight: "500",
    lineHeight: 18,
  },
  chartInfoMessage: {
    fontSize: 14,
    lineHeight: 19,
    textAlign: "left",
    alignSelf: "stretch",
  },
  chartInfoValue: {
    flex: 1.1,
    fontSize: 14,
    lineHeight: 19,
    textAlign: "right",
  },
  chartInfoDivider: {
    position: "absolute",
    right: 0,
    bottom: 0,
    left: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255, 255, 255, 0.18)",
  },
  container: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  controlsStack: {
    alignItems: "flex-end",
    gap: 8,
  },
});
