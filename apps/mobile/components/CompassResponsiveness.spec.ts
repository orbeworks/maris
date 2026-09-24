import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { build } from "esbuild";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

test("both compass rotations consume shared values without rerendering or timed interpolation", async () => {
  const require = createRequire(__filename);
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const renderers: ReactTestRenderer[] = [];
  try {
    for (const name of ["DrawerCompass", "CompassPanel"]) {
      const output = await build({ entryPoints: [require.resolve(`./${name}.tsx`)], bundle: true,
        write: false, platform: "node", format: "cjs", jsx: "automatic",
        plugins: [{ name: "compass-native-adapters", setup(builder) {
          builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, args => ({ path: require.resolve(args.path), external: true }));
          builder.onResolve({ filter: /^(react-native|react-native-svg|react-native-reanimated|\.\/BlurPanel|\.\/BlurText)$/ }, args => ({ path: args.path, namespace: "mock" }));
          builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({ loader: "js", contents:
            path === "react-native" ? 'export const Platform={OS:"ios"},StyleSheet={create:x=>x},View="View",Pressable="Pressable";' :
            path === "react-native-svg" ? 'export default "Svg"; export const Circle="Circle",G="G",Line="Line",Polygon="Polygon",Text="SvgText",Path="Path";' :
            path === "react-native-reanimated" ? 'export default {createAnimatedComponent:x=>x,View:"AnimatedView"}; export const useDerivedValue=fn=>({get value(){return fn()}}),useAnimatedProps=fn=>fn,useAnimatedStyle=fn=>fn;' :
            path === "./BlurPanel" ? 'export const BlurPanel="BlurPanel";' :
            'export const BlurText="BlurText",BLUR_TEXT_FONT_SIZE=18,BLUR_TEXT_LINE_HEIGHT=22;'
          }));
        }}],
      });
      const module = { exports: {} as Record<string, React.ComponentType<any>> };
      new Function("require", "module", "exports", output.outputFiles[0].text)(require, module, module.exports);
      const headingValue = { value: 0 as number | null }, mapBearingValue = { value: 0 };
      let renderer!: ReactTestRenderer;
      await act(async () => { renderer = create(React.createElement(module.exports[name], { headingValue, mapBearingValue, heading: 0, onPress() {} })); });
      renderers.push(renderer);
      if (name === "DrawerCompass") {
        const dial = renderer.root.findByType("G" as any);
        headingValue.value = 90;
        const matrix = dial.props.animatedProps().transform;
        assert.ok(Math.abs(matrix[0]) < 1e-10);
        assert.equal(matrix[1], -1, "new sensor sample is applied directly without 160ms interpolation");
        headingValue.value = 359;
        const before = dial.props.animatedProps().transform;
        headingValue.value = 1;
        const after = dial.props.animatedProps().transform;
        assert.ok(Math.abs(before[1] - after[1]) < 0.04, "north crossing does not spin the long way around");
      } else {
        const dial = renderer.root.findByType("AnimatedView" as any);
        mapBearingValue.value = 75;
        assert.deepEqual(dial.props.style[1]().transform, [{ rotate: "-75deg" }]);
        headingValue.value = 180;
        assert.deepEqual(dial.props.style[1]().transform, [{ rotate: "-75deg" }], "small compass remains aligned with the map, not the device");
      }
    }
  } finally {
    for (const renderer of renderers) await act(async () => renderer.unmount());
    globals.IS_REACT_ACT_ENVIRONMENT = previous;
  }
});
