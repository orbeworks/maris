import assert from "node:assert/strict";
import { test } from "node:test";
import React, { useLayoutEffect, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useCameraEvents, type CameraEvent } from "./use-camera-events";

test("native commit events are deferred, coalesced, deduplicated and cancelled on unmount", async () => {
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const oldAct = globals.IS_REACT_ACT_ENVIRONMENT;
  const oldRaf = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0, inCommit = false;
  globalThis.requestAnimationFrame = callback => { frames.set(++id, callback); return id; };
  globalThis.cancelAnimationFrame = key => { if (key != null) frames.delete(key); };
  const calls: { view: CameraEvent; settled: boolean }[] = [];
  const immediateSamples: CameraEvent[] = [];
  let events: ReturnType<typeof useCameraEvents>;
  let renderer: ReactTestRenderer | undefined;
  const view = { center: [-80, 25] as [number, number], zoom: 14, bearing: 0 };
  function Probe() {
    const [, render] = useState(0);
    events = useCameraEvents((view, settled) => {
      assert.equal(inCommit, false, "state must never be updated inside a native commit event");
      calls.push({ view, settled }); render(value => value + 1);
    }, view => immediateSamples.push(view));
    useLayoutEffect(() => {
      inCommit = true;
      events.onRegionIsChanging({ nativeEvent: view });
      inCommit = false;
    });
    return null;
  }
  const flush = async () => {
    const callbacks = [...frames.values()]; frames.clear();
    await act(async () => callbacks.forEach(callback => callback(0)));
  };
  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    assert.equal(calls.length, 0);
    assert.equal(immediateSamples.length, 1, "shared compass bearing is updated before the React frame queue");
    assert.equal(frames.size, 1);
    await flush();
    await flush();
    assert.equal(calls.length, 1, "commit replay is ignored without another render");
    assert.equal(frames.size, 0);
    const handler = events!.onRegionIsChanging;
    for (let zoom = 15; zoom < 100; zoom++) events!.onRegionIsChanging({ nativeEvent: { ...view, zoom } });
    events!.onRegionDidChange({ nativeEvent: { ...view, zoom: 100 } });
    assert.equal(frames.size, 1);
    assert.equal(calls.length, 1);
    await flush();
    assert.equal(calls.at(-1)!.view.zoom, 100);
    assert.equal(calls.at(-1)!.settled, true, "final event supersedes intermediate zoom samples");
    assert.equal(handler, events!.onRegionIsChanging, "native handler identity is stable");
    assert.equal(frames.size, 1);
    await act(async () => renderer!.unmount()); renderer = undefined;
    assert.equal(frames.size, 0);
    events!.onRegionIsChanging({ nativeEvent: view });
    assert.equal(frames.size, 0);
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    globalThis.requestAnimationFrame = oldRaf; globalThis.cancelAnimationFrame = oldCancel;
    globals.IS_REACT_ACT_ENVIRONMENT = oldAct;
  }
});
