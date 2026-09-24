import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeGfsTile } from './gfs-tile-codec';

function makeTile() {
  return {
    model: 'gfs' as const,
    run: '2026-09-18T12:00:00Z',
    forecastTime: '2026-09-18T12:00:00Z',
    forecastHour: 0,
    resolution: 0.25,
    bounds: { north: 0, south: -10, east: -40, west: -50 },
    width: 2,
    height: 2,
    longitudeConvention: '-180..180' as const,
    gridOrder: 'north-to-south,west-to-east' as const,
    units: {
      wind: 'm/s' as const, temperature: 'K' as const, precipitation: 'kg/m2' as const,
      precipitationRate: 'kg/m2/s' as const, cloudCover: '%' as const, pressure: 'Pa' as const,
      gust: 'm/s' as const, humidity: '%' as const,
    },
    fields: { windU: [1, null, 3, 4], windV: [5, 6, 7, 8] },
  };
}

test('decodes the versioned binary tile and preserves invalid cells', () => {
  const tile = makeTile();
  const header = {
    version: 1 as const,
    ...tile,
    fields: ['windU', 'windV'],
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const count = 4;
  const bytes = new Uint8Array(12 + headerBytes.length + 2 * (count + count * 4));
  bytes.set(new TextEncoder().encode('MGFS'), 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 1, true);
  view.setUint32(8, headerBytes.length, true);
  bytes.set(headerBytes, 12);
  let offset = 12 + headerBytes.length;
  for (const values of [[1, null, 3, 4], [5, 6, 7, 8]]) {
    values.forEach((value, index) => { bytes[offset + index] = value === null ? 0 : 1; });
    values.forEach((value, index) => view.setFloat32(offset + count + index * 4, value ?? 0, true));
    offset += count * 5;
  }
  const decoded = decodeGfsTile(bytes);
  assert.deepEqual(decoded.fields.windU, [1, null, 3, 4]);
  assert.deepEqual(decoded.fields.windV, [5, 6, 7, 8]);
  assert.equal(decoded.bounds.west, -50);
});
