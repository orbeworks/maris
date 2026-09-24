import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { build } from "esbuild";
import React from "react";
import {
  act,
  create,
  type ReactTestRenderer,
} from "react-test-renderer";

test("location marker stays pointed up while course-up camera catches the heading", async () => {
  const require = createRequire(__filename);
  const output = await build({
    entryPoints: [require.resolve("./UserLocationMarker.tsx")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    plugins: [{
      name: "location-marker-native-adapters",
      setup(builder) {
        builder.onResolve({ filter: /^react(?:\/jsx-runtime)?$/ }, args => ({
          path: require.resolve(args.path),
          external: true,
        }));
        builder.onResolve({
          filter: /^(react-native|@maplibre\/maplibre-react-native|expo-symbols|@expo\/vector-icons\/MaterialIcons)$/,
        }, args => ({ path: args.path, namespace: "mock" }));
        builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({
          loader: "js",
          contents:
            path === "react-native"
              ? 'export const Platform={OS:"ios"},StyleSheet={create:x=>x},View="View";'
              : path === "@maplibre/maplibre-react-native"
                ? 'export const Marker="Marker";'
                : path === "expo-symbols"
                  ? 'export const SymbolView="SymbolView";'
                  : 'export default "MaterialIcons";',
        }));
      },
    }],
  });
  const module = { exports: {} as { UserLocationMarker: React.ComponentType<any> } };
  new Function("require", "module", "exports", output.outputFiles[0].text)(
    require,
    module,
    module.exports,
  );

  const globals = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previous = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: ReactTestRenderer | undefined;
  const marker = (courseUp: boolean) => React.createElement(
    module.exports.UserLocationMarker,
    { coordinate: [-43, -23], heading: 80, mapBearing: 30, courseUp },
  );

  await act(async () => { renderer = create(marker(false)); });
  const normalView = renderer!.root.findByType("View" as any);
  assert.equal(normalView.props.style[0].transform[0].rotate, "50deg");

  await act(async () => { renderer!.update(marker(true)); });
  const courseUpView = renderer!.root.findByType("View" as any);
  assert.equal(courseUpView.props.style[0].transform[0].rotate, "0deg");

  await act(async () => { renderer!.unmount(); });
  globals.IS_REACT_ACT_ENVIRONMENT = previous;
});
