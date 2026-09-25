import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

test("repeated native camera events settle without a render/command feedback loop", async () => {
  const require = createRequire(__filename);
  const fixture = { renders: 0, bearing: 0, zoom: 14, longitude: -80.2, jumps: 0, heading: 0, chartReady: false };
  const globals = globalThis as typeof globalThis & { __cameraFeedback?: typeof fixture; IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  globalThis.cancelAnimationFrame = id => { if (id != null) frames.delete(id); };
  const flush = async () => {
    for (let i = 0; frames.size && i < 10; i++) {
      const callbacks = [...frames.values()]; frames.clear();
      await act(async () => callbacks.forEach(callback => callback(0)));
    }
    assert.equal(frames.size, 0, "native feedback must settle instead of producing frames forever");
  };
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  globals.__cameraFeedback = fixture;
  let renderer: ReactTestRenderer | undefined;
  try {
    const result = await build({ entryPoints: [path.join(__dirname, "../App.tsx")],
      bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
      plugins: [{ name: "native-feedback", setup(builder) {
        builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, args => ({ path: require.resolve(args.path), external: true }));
        builder.onResolve({ filter: /^react-native-reanimated$/ }, args => ({ path: args.path, namespace: "mock" }));
        builder.onResolve({ filter: /^(react-native|@maplibre\/maplibre-react-native|@maris\/native-wind|\.\/components\/.*|\.\/location\/.*|\.\/weather\/.*|\.\/offline\/.*|\.\/charts\/.*)$/ }, args => ({ path: args.path, namespace: "mock" }));
        builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path: name }) => {
          let contents: string;
          if (name === "react-native-reanimated") contents = 'import React from "react"; export const useSharedValue=value=>React.useRef({value}).current;';
          else if (name === "react-native") contents = 'export const StyleSheet={create:x=>x},View="View",ScrollView="ScrollView",useWindowDimensions=()=>({width:400});';
          else if (name === "@maplibre/maplibre-react-native") contents = `import React from "react";
            export function Map(props){const f=globalThis.__cameraFeedback;f.renders++;if(f.renders>30)throw Error("camera feedback loop");React.useLayoutEffect(()=>props.onRegionIsChanging({nativeEvent:{center:[f.longitude,25.7],zoom:f.zoom,bearing:f.bearing}}));return React.createElement("Map",props,props.children)};
            export const Camera=React.forwardRef((props,ref)=>{React.useImperativeHandle(ref,()=>({jumpTo(){globalThis.__cameraFeedback.jumps++},flyTo(){}}));return null});
            export const Layer="Layer",VectorSource="VectorSource",OfflineManager={setMaximumAmbientCacheSize:async()=>{}};`;
          else if (name === "@maris/native-wind") contents = 'export const NativeWindLayer="NativeWindLayer";';
          else if (name.includes("/location/")) contents = 'export const useDeviceLocation=()=>({coordinate:[-80.15,25.7],heading:globalThis.__cameraFeedback.heading});';
          else if (name.endsWith("wind-legend-band")) contents = 'export const windLegendBand=x=>x;';
          else if (name.includes("/weather/")) contents = 'export const useGfsViewport=()=>({current:null,loading:true}),useGfsPoint=()=>({current:null,loading:true});';
          else if (name.endsWith("use-automatic-offline")) contents = 'export const useAutomaticOffline=()=>({ready:true,area:null,onViewportSettled:async()=>{}});';
          else if (name.endsWith("MapOverlayGrid")) contents = 'export const MapOverlayGrid="MapOverlayGrid",MapOverlaySlot="MapOverlaySlot";';
          else if (name.endsWith("NavigationDataPanel")) contents = 'export const NavigationDataPanel="NavigationDataPanel",GfsConditionsPanel="GfsConditionsPanel";';
          else if (name.includes("/offline/")) contents = 'export const MAP_AMBIENT_CACHE_BYTES=1;';
          else if (name.endsWith("current-chart")) contents = 'export const useOnlineChart=()=>({version:"v1",bounds:[-81,25,-80,26],tiles:[],minzoom:8,maxzoom:16}),useChartInformation=(_api,_ref,enabled)=>({chart:null,message:enabled&&globalThis.__cameraFeedback.chartReady?"Chart information unavailable":"",loading:enabled&&!globalThis.__cameraFeedback.chartReady,ready:enabled&&globalThis.__cameraFeedback.chartReady});';
          else if (name.includes("/charts/")) contents = 'export const chartInformationRows=()=>[];';
          else { const component = path.basename(name); contents = `export const ${component}="${component}";` + (component === "ScaleRuler" ? 'export const isWeatherScaleVisible=()=>true,getScaleUnit=()=>"m";' : ''); }
          return { contents, loader: "js" };
        });
      }}],
    });
    const module = { exports: {} as { default: React.ComponentType } };
    new Function("require", "module", "exports", result.outputFiles[0].text)(require, module, module.exports);
    const App = module.exports.default;
    await act(async () => { renderer = create(React.createElement(App)); });
    await flush();
    const controls = () => renderer!.root.findByType("MapControlsPanel" as any);
    const map = () => renderer!.root.findByType("Map" as any);
    assert.equal(controls().props.locationActive, false);
    assert.ok(fixture.renders < 6, "identical events must stop rendering");
    assert.equal(map().props.mapStyle, "https://tiles.openfreemap.org/styles/bright");
    const genericPoiLayers = () => renderer!.root.findAll(node =>
      node.type === ("Layer" as unknown) && /^poi_r(?:1|7|20)$/.test(node.props.id));
    assert.equal(genericPoiLayers().length, 3);
    for (const layer of genericPoiLayers()) {
      assert.ok(JSON.stringify(layer.props.filter).includes('["match",["get","class"],["bus"],false,true]'),
        `${layer.props.id} must exclude bus stops`);
    }
    await act(async () => controls().props.onMapModeChange("satellite"));
    const satelliteStyle = JSON.parse(map().props.mapStyle);
    assert.equal(genericPoiLayers().length, 0, "satellite has no vector POI overrides");
    assert.equal(satelliteStyle.sources["google-satellite"].type, "raster");
    assert.deepEqual(satelliteStyle.sources["google-satellite"].tiles, [
      "https://mt0.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
      "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
      "https://mt2.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
      "https://mt3.google.com/vt/lyrs=s&x={x}&y={y}&z={z}",
    ]);
    await act(async () => controls().props.onMapModeChange("bright"));
    assert.equal(map().props.mapStyle, "https://tiles.openfreemap.org/styles/bright");
    await act(async () => renderer!.root.findByType("WindPanel" as any).props.onToggle());
    await flush();
    assert.ok(fixture.renders < 10, "unchanged wind coordinates must not restart rendering");
    fixture.longitude = -80.15;
    await act(async () => controls().props.onLocate());
    await flush();
    await act(async () => controls().props.onLocate());
    assert.equal(controls().props.courseUp, true);
    fixture.heading = 30;
    await act(async () => renderer!.update(React.createElement(App)));
    const jumps = fixture.jumps;
    fixture.zoom = 15;
    fixture.bearing = 30;
    await act(async () => renderer!.update(React.createElement(App)));
    await flush();
    assert.equal(fixture.jumps, jumps, "camera feedback and recreated GPS arrays must not command the camera again");
    fixture.heading = 45;
    await act(async () => renderer!.update(React.createElement(App)));
    assert.equal(fixture.jumps, jumps + 1, "new heading still follows immediately");
    fixture.renders = 0;
    const sheet = () => renderer!.root.findByType("BlurBottomSheet" as any);
    await act(async () => { controls().props.onMapPress(); controls().props.onMapPress(); });
    assert.equal(sheet().props.visible, false, "do not open the sheet during the request");
    assert.equal(controls().props.mapLoading, true);
    fixture.chartReady = true;
    await act(async () => renderer!.update(React.createElement(App)));
    assert.equal(sheet().props.visible, true, "open the sheet when the result arrives");
    assert.equal(controls().props.mapLoading, false);
    await act(async () => sheet().props.onClose());
    assert.equal(sheet().props.visible, false, "closing must not reopen from the previous result");
    fixture.longitude = -90;
    await act(async () => renderer!.update(React.createElement(App)));
    await flush();
    assert.equal(controls().props.showMapButton, false);
    await act(async () => controls().props.onMapPress());
    assert.equal(sheet().props.visible, false, "even a stale press cannot request a chart outside bounds");
    fixture.longitude = -80.2;
    await act(async () => renderer!.update(React.createElement(App)));
    await flush();
    assert.equal(controls().props.showMapButton, true);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    delete globals.__cameraFeedback;
    globalThis.requestAnimationFrame = previousRaf;
    globalThis.cancelAnimationFrame = previousCancel;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
