import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { build } from "esbuild";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

test("wind width and fade use the shared transition when speed arrives, disappears or changes width", async () => {
  const require = createRequire(__filename);
  const globals = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    __panelAnimations?: {
      toValue: number;
      duration: number;
      stopped: boolean;
    }[];
  };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  const previousAnimations = globals.__panelAnimations;
  const animations: NonNullable<typeof globals.__panelAnimations> = [];
  globals.__panelAnimations = animations;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: ReactTestRenderer | undefined;
  try {
    const output = await build({
      entryPoints: [require.resolve("./WindPanel.tsx")],
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      jsx: "automatic",
      plugins: [
        {
          name: "panel-adapters",
          setup(builder) {
            builder.onResolve(
              { filter: /^react(?:\/jsx-runtime)?$/ },
              (args) => ({ path: require.resolve(args.path), external: true }),
            );
            builder.onResolve(
              {
                filter:
                  /^(react-native|expo-symbols|\.\/BlurPanel|\.\/BlurText)$/,
              },
              (args) => ({ path: args.path, namespace: "mock" }),
            );
            builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({
              loader: "js",
              contents:
                path === "react-native"
                  ? `export const View="View",Pressable="Pressable",ActivityIndicator="ActivityIndicator",StyleSheet={create:x=>x},Easing={cubic:x=>x,inOut:x=>x},useWindowDimensions=()=>({width:400});
            export const Animated={View:"AnimatedView",Value:class {constructor(value){this.value=value} interpolate(options){return {value:this,options}}},timing:(value,options)=>{const record={...options,stopped:false};globalThis.__panelAnimations.push(record);return {start(){value.value=options.toValue},stop(){record.stopped=true}}}};`
                  : path === "expo-symbols"
                    ? 'export const SymbolView="SymbolView";'
                    : path === "./BlurPanel"
                      ? 'export const BlurPanel="BlurPanel",BLUR_PANEL_ICON_SIZE=28,BLUR_PANEL_PADDING_VERTICAL=6;'
                      : 'export const BlurText="BlurText",BLUR_TEXT_LINE_HEIGHT=22;',
            }));
          },
        },
      ],
    });
    const module = { exports: {} as { WindPanel: React.ComponentType<any> } };
    new Function("require", "module", "exports", output.outputFiles[0].text)(
      require,
      module,
      module.exports,
    );
    const panel = (
      currentWindSpeed?: number,
      enabled = false,
      loading = false,
    ) =>
      React.createElement(module.exports.WindPanel, {
        currentWindSpeed,
        enabled,
        loading,
        onToggle() {},
      });
    await act(async () => {
      renderer = create(panel());
    });
    const content = () =>
      renderer!.root
        .findAllByType("AnimatedView" as any)
        .find(
          (node) =>
            Array.isArray(node.props.style) && node.props.style[1]?.width,
        )!;
    const header = () => renderer!.root.findByType("Pressable" as any);
    assert.equal(
      header().props.onLayout,
      undefined,
      "animated content must not feed widths back into the target",
    );
    assert.equal(
      header().props.style({ pressed: false })[1].width,
      66,
      "header width stays fixed independently of weather data",
    );
    assert.equal(content().props.style[1].width.value, 28);
    await act(async () => renderer!.update(panel(5)));
    assert.equal(content().props.style[1].width.value, 66);
    assert.equal(
      header().props.style({ pressed: false })[1].width,
      66,
      "current weather speed does not shift the expanded header label",
    );
    const expansion = animations.findLast((a) => a.toValue === 66)!;
    assert.equal(expansion.duration, 280);
    await act(async () => renderer!.update(panel(0)));
    assert.ok(
      renderer!.root
        .findAllByType("BlurText" as any)
        .some((node) => node.props.children === "0.0"),
      "compact integer speeds keep one decimal place",
    );
    await act(async () => renderer!.update(panel(0, true, true)));
    assert.equal(
      content().props.style[1].width.value,
      66,
      "loading wind keeps the compact speed width",
    );
    assert.ok(
      renderer!.root
        .findAllByType("BlurText" as any)
        .some((node) => node.props.children === "0.0"),
      "loading wind keeps the compact speed visible",
    );
    assert.equal(
      renderer!.root.findAllByType("ActivityIndicator" as any).length,
      1,
      "only the wind icon changes to a spinner",
    );
    await act(async () => renderer!.update(panel()));
    assert.equal(content().props.style[1].width.value, 28);
    assert.equal(
      expansion.stopped,
      true,
      "cancel the previous transition before retargeting",
    );
    await act(async () => renderer!.update(panel(undefined, true, true)));
    assert.equal(
      content().props.style[1].width.value,
      28,
      "first load stays collapsed until MET data is ready",
    );
    assert.equal(content().props.style[1].height.value.value, 0);
    assert.equal(
      renderer!.root.findAllByType("ActivityIndicator" as any).length,
      1,
    );
    await act(async () => renderer!.update(panel(undefined, true)));
    assert.equal(
      content().props.style[1].width.value,
      66,
      "legend uses the fixed expanded width",
    );
    assert.ok(
      animations.every((a) => a.duration === 280),
      "width, height and fade share a single timing",
    );
    const count = animations.length;
    await act(async () => renderer!.update(panel(undefined, true)));
    assert.equal(
      animations.length,
      count,
      "unchanged sizes must not restart animations",
    );
    await act(async () => renderer!.update(panel(undefined, true, true)));
    assert.equal(header().props.disabled, true);
    assert.equal(header().props.accessibilityState.busy, true);
    assert.equal(
      content().props.style[1].width.value,
      66,
      "an open legend keeps its width during a later load",
    );
    assert.equal(
      content().props.style[1].height.value.value,
      1,
      "an open legend stays expanded while loading a new area",
    );
    assert.equal(
      renderer!.root.findAllByType("ActivityIndicator" as any).length,
      1,
    );
    assert.equal(
      renderer!.root.findAllByType("SymbolView" as any).length,
      0,
      "spinner replaces the wind icon while MET data loads",
    );
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
    globals.__panelAnimations = previousAnimations;
  }
});
