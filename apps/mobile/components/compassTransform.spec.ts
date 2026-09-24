import assert from "node:assert/strict";
import { test } from "node:test";
import { compassRotationMatrix, svgMatrixAdapter } from "./compassTransform";

function apply(m: number[], x: number, y: number) {
  return [m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!];
}
function close(actual: number[], expected: number[]) {
  actual.forEach((n, i) => assert.ok(Math.abs(n - expected[i]!) < 1e-9));
}

test("compass matrix preserves its pivot and rotates clockwise in SVG coordinates", () => {
  for (const angle of [0, 90, -90, 180, 359, 360, 721]) {
    close(apply(compassRotationMatrix(angle, 120, 120), 120, 120), [120, 120]);
  }
  close(apply(compassRotationMatrix(90, 120, 120), 120, 20), [220, 120]);
  close(apply(compassRotationMatrix(-90, 120, 120), 120, 20), [20, 120]);
});

test("counter-rotation keeps all four labels horizontal while orbiting the dial", () => {
  for (const [x, y] of [[120, 48], [196, 120], [120, 196], [44, 120]]) {
    for (const angle of [0, 45, 180, 359]) {
      const dial = compassRotationMatrix(angle, 120, 120);
      const text = compassRotationMatrix(-angle, x!, y!);
      const center = apply(dial, x!, y!);
      const offset = apply(text, x! + 10, y!);
      close(apply(dial, offset[0]!, offset[1]!), [center[0]! + 10, center[1]!]);
    }
  }
});

test("adapter sends numeric matrix without leaving an invalid transform for Reanimated", () => {
  const matrix = compassRotationMatrix(42, 120, 120);
  const props: Record<string, unknown> = { transform: matrix, opacity: 0.7 };
  svgMatrixAdapter(props);
  assert.deepEqual(props, { matrix, opacity: 0.7 });
  svgMatrixAdapter(props);
  assert.deepEqual(props, { matrix, opacity: 0.7 });
});
