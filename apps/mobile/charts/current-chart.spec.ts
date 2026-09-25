import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { build } from "esbuild";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

test("chart requests use the actual map center/version and discard obsolete responses", async () => {
  const require = createRequire(__filename);
  const output = await build({
    entryPoints: [require.resolve("./current-chart.ts")], bundle: true, write: false,
    platform: "node", format: "cjs", external: ["react"],
    plugins: [{ name: "native-adapter", setup(builder) {
      builder.onResolve({ filter: /^react-native$/ }, () => ({ path: "native", namespace: "mock" }));
      builder.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: 'export const AppState={currentState:"background",addEventListener:()=>({remove(){}})};' }));
    }}],
  });
  const module = {
    exports: {} as { useChartInformation: (...args: any[]) => any },
  };
  new Function("require", "module", "exports", output.outputFiles[0].text)(require, module, module.exports);
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  const previousFetch = globalThis.fetch;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const requests: { url: string; signal?: AbortSignal | null; resolve: (r: Response) => void }[] = [];
  globalThis.fetch = (input, init) => new Promise(resolve => requests.push({ url: String(input), signal: init?.signal, resolve }));
  let center = [-80.15, 25.7];
  const ref = { current: { getViewState: async () => ({ center }) } };
  let state: { chart: { name: string } | null; message: string; loading: boolean; ready: boolean };
  function Probe({ longitude, enabled = true }: { longitude: number; enabled?: boolean }) {
    state = module.exports.useChartInformation("https://api.example", ref, enabled, "soundg-v2", longitude, 25.7);
    return null;
  }
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 230)); });
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(React.createElement(Probe, { longitude: -80 })); });
    assert.equal(state!.loading, true);
    assert.equal(state!.ready, false);
    assert.equal(state!.message, "", "loading belongs to the button, not the sheet");
    await settle();
    assert.equal(requests.length, 1);
    const first = new URL(requests[0].url);
    assert.equal(first.searchParams.get("lon"), "-80.15");
    assert.equal(first.searchParams.get("version"), null);
    center = [-80.2, 25.8];
    await act(async () => renderer!.update(React.createElement(Probe, { longitude: -80.2 })));
    assert.equal(requests[0].signal?.aborted, true);
    await settle();
    await act(async () => {
      requests[1].resolve(Response.json({ id: "new", name: "NEW", version: "soundg-v2" }));
    });
    assert.equal(state!.chart?.name, "NEW");
    assert.equal(state!.ready, true);
    assert.equal(state!.loading, false);
    await act(async () => {
      requests[0].resolve(Response.json({ id: "old", name: "OLD", version: "soundg-v2" }));
    });
    assert.equal(state!.chart?.name, "NEW");
    await act(async () => renderer!.update(React.createElement(Probe, { longitude: -80.3, enabled: false })));
    await settle();
    assert.equal(requests.length, 2);
    assert.equal(state!.chart, null);
    await act(async () => renderer!.update(React.createElement(Probe, { longitude: -80.3 })));
    assert.equal(state!.ready, false, "reopening must wait for a fresh result");
    await settle();
    await act(async () => requests[2].resolve(new Response(null, { status: 409 })));
    assert.equal(state!.ready, true, "errors also finish loading and allow the sheet to open");
    assert.equal(state!.loading, false);
    assert.equal(state!.message, "No nautical chart is available for this area.");
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.fetch = previousFetch;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
