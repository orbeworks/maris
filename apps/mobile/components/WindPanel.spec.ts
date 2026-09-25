import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { build } from "esbuild";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

test("wind panel presents speed and replaces its icon while loading", async () => {
  const require = createRequire(__filename);
  const globals = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
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
                  ? 'export const View="View",ActivityIndicator="ActivityIndicator",StyleSheet={create:x=>x};'
                  : path === "expo-symbols"
                    ? 'export const SymbolView="SymbolView";'
                    : path === "./BlurPanel"
                      ? 'export const BlurPanel="BlurPanel",BLUR_PANEL_ICON_SIZE=28;'
                      : 'export const BlurText="BlurText";',
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
      });
    const content = () =>
      renderer!.root.find(
        (node) =>
          node.type === ("View" as unknown) &&
          typeof node.props.accessibilityLabel === "string",
      );
    const hasText = (value: string) =>
      renderer!.root
        .findAllByType("BlurText" as any)
        .some((node) => node.props.children === value);

    await act(async () => {
      renderer = create(panel());
    });
    assert.equal(content().props.accessibilityLabel, "Wind");
    assert.equal(renderer!.root.findAllByType("SymbolView" as any).length, 1);
    assert.equal(
      renderer!.root.findAllByType("ActivityIndicator" as any).length,
      0,
    );
    assert.ok(hasText("kt"));

    await act(async () => renderer!.update(panel(5, true)));
    assert.equal(content().props.accessibilityLabel, "Wind: 9.7 kt");
    assert.ok(hasText("9.7"));
    assert.ok(hasText("kt"));

    await act(async () => renderer!.update(panel(0, true)));
    assert.equal(content().props.accessibilityLabel, "Wind: 0.0 kt");
    assert.ok(hasText("0.0"));

    await act(async () => renderer!.update(panel(5, true, true)));
    assert.equal(content().props.accessibilityLabel, "Loading wind");
    assert.equal(renderer!.root.findAllByType("SymbolView" as any).length, 0);
    const spinner = renderer!.root.findByType("ActivityIndicator" as any);
    assert.equal(spinner.props.size, 22);
    assert.ok(hasText("9.7"), "loading preserves the latest wind speed");
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
