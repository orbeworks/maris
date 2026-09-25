import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

test("Android location icon loses its fill off GPS and preserves centered/course-up icons", async () => {
  const require = createRequire(__filename);
  const directory = await mkdtemp(path.join(os.tmpdir(), "maris-controls-test-"));
  let renderer: ReactTestRenderer | undefined;
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const output = await build({
      entryPoints: [path.join(__dirname, "MapControlsPanel.tsx")],
      bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
      plugins: [{ name: "native-controls-adapters", setup(builder) {
        builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, args => ({ path: require.resolve(args.path), external: true }));
        builder.onResolve({ filter: /^(react-native|expo-symbols|@expo\/vector-icons\/(MaterialCommunityIcons|FontAwesome6)|\.\/BlurPanel)$/ }, args => ({ path: args.path, namespace: "mock" }));
        builder.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ loader: "js", contents:
          args.path === "react-native" ? `export const Platform={OS:"android"}; export const StyleSheet={create:x=>x}; export const View="View", Pressable="Pressable", ActivityIndicator="ActivityIndicator";
            export const Easing={cubic:x=>x,inOut:x=>x};
            export const Animated={View:"AnimatedView",Value:class {constructor(value){this.value=value} interpolate({outputRange}){return {__getValue:()=>outputRange[0]+this.value*(outputRange[1]-outputRange[0])}}},timing:(value,options)=>({start(){value.value=options.toValue},stop(){}})};` :
          args.path === "expo-symbols" ? 'export const SymbolView="SymbolView";' :
          args.path === "./BlurPanel" ? 'export const BlurPanel="BlurPanel", BLUR_PANEL_ICON_SIZE=20, BLUR_PANEL_GAP=8;' :
          args.path.includes("FontAwesome6") ? 'export default "FontAwesome6";' :
          'export default "MaterialCommunityIcons";'
        }));
      }}],
    });
    const compiled = path.join(directory, "controls.cjs");
    await writeFile(compiled, output.outputFiles[0].contents);
    const { MapControlsPanel } = require(compiled);
    let presses = 0;
    let mapPresses = 0;
    const mapModes: string[] = [];
    const panel = (locationActive: boolean, courseUp: boolean, mapLoading = false, showMapButton = true) => React.createElement(MapControlsPanel, {
      locationActive, courseUp, mapLoading, showMapButton,
      onLocate: () => { presses++; },
      onMapPress: () => { mapPresses++; },
      onMapModeChange: (mode: string) => { mapModes.push(mode); },
    });
    await act(async () => { renderer = create(panel(true, false)); });
    const icons = () => renderer!.root.findAll(node => node.type === ("MaterialCommunityIcons" as unknown));
    const globeIcons = () => renderer!.root.findAll(node => node.type === ("FontAwesome6" as unknown));
    assert.equal(icons()[0].props.name, "near-me");
    await act(async () => { renderer!.update(panel(false, false)); });
    assert.equal(icons()[0].props.name, "navigation-variant-outline");
    assert.equal(globeIcons()[0].props.name, "globe");
    assert.equal(icons()[1].props.name, "map-outline");
    await act(async () => { renderer!.update(panel(true, true)); });
    assert.equal(icons()[0].props.name, "navigation");
    await act(async () => { renderer!.update(panel(false, false)); });
    assert.equal(icons()[0].props.name, "navigation-variant-outline");
    renderer!.root.find(node => node.props.accessibilityLabel === "Center on my location").props.onPress();
    assert.equal(presses, 1);
    await act(async () => {
      renderer!.root.find(node => node.props.accessibilityLabel === "Show satellite map").props.onPress();
    });
    assert.equal(mapModes.at(-1), "satellite");
    assert.equal(globeIcons()[0].props.name, "language");
    await act(async () => {
      renderer!.root.find(node => node.props.accessibilityLabel === "Show bright map").props.onPress();
    });
    assert.equal(globeIcons()[0].props.name, "globe");
    assert.equal(mapModes.at(-1), "bright");
    renderer!.root.find(node => node.props.accessibilityLabel === "Open map options").props.onPress();
    assert.equal(mapPresses, 1);
    await act(async () => renderer!.update(panel(false, false, true)));
    const loading = renderer!.root.find(node => node.props.accessibilityLabel === "Loading chart information");
    assert.equal(loading.props.disabled, true);
    assert.equal(loading.props.onPress, undefined);
    assert.equal(loading.props.accessibilityState.busy, true);
    assert.equal(renderer!.root.findAllByType("ActivityIndicator" as any).length, 1);
    assert.equal(icons().length, 1, "spinner replaces only the map icon");
    await act(async () => renderer!.update(panel(false, false)));
    assert.equal(icons()[1].props.name, "map-outline");
    assert.equal(renderer!.root.findAllByType("ActivityIndicator" as any).length, 0);
    await act(async () => renderer!.update(panel(false, false, false, false)));
    const mapButton = () => renderer!.root.find(node => node.props.accessibilityLabel === "Open map options");
    const slot = () => renderer!.root.findByType("AnimatedView" as any);
    assert.equal(mapButton().props.disabled, true);
    assert.equal(mapButton().props.onPress, undefined);
    assert.equal(slot().props.pointerEvents, "none");
    assert.equal(slot().props.accessibilityElementsHidden, true);
    assert.equal(slot().props.style[1].height.__getValue(), 0, "hidden button reserves no space or gap");
    await act(async () => renderer!.update(panel(false, false)));
    assert.equal(slot().props.style[1].height.__getValue(), 28, "expanded slot uses icon size plus shared gap");
    assert.equal(slot().props.style[1].opacity.value, 1);
    assert.equal(mapButton().props.disabled, false);
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
