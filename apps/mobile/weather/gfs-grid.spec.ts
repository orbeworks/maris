import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  sampleGridAtCoordinate,
  windCardinal,
  windDirectionDegrees,
  windSpeedKt,
  precipitationRateMillimetresPerHour,
  pressureHpa,
  temperatureCelsius,
} from './gfs-grid';

const grid = {
  model: 'gfs' as const,
  run: '2026-09-18T12:00:00Z',
  forecastTime: '2026-09-18T15:00:00Z',
  forecastHour: 3,
  resolution: 0.25,
  bounds: { north: 1, south: 0, east: 1, west: 0 },
  width: 2,
  height: 2,
  longitudeConvention: '-180..180' as const,
  units: {
    wind: 'm/s' as const,
    temperature: 'K' as const,
    precipitation: 'kg/m2' as const,
    precipitationRate: 'kg/m2/s' as const,
    cloudCover: '%' as const,
    pressure: 'Pa' as const,
    gust: 'm/s' as const,
    humidity: '%' as const,
  },
  fields: {
    windU: [0, 2, 4, 6],
    windV: [10, 20, 30, 40],
    temperature: [273.15, 274.15, 275.15, 276.15],
    precipitationRate: [0, 1, 2, 3],
    pressure: [100000, 100100, 100200, 100300],
  },
};

test('bilinearly samples a point between four GFS cells', () => {
  const sample = sampleGridAtCoordinate(grid, 0.5, 0.5);
  assert.equal(sample?.windU, 3);
  assert.equal(sample?.windV, 25);
  assert.equal(sample?.temperature, 274.65);
});

test('samples grid edges and rejects coordinates outside coverage', () => {
  assert.equal(sampleGridAtCoordinate(grid, 1, 0)?.windU, 0);
  assert.equal(sampleGridAtCoordinate(grid, -1, 0), null);
});

test('supports conventional negative longitudes', () => {
  const westernGrid = {
    ...grid,
    bounds: { north: 1, south: 0, east: 0, west: -1 },
  };
  assert.equal(sampleGridAtCoordinate(westernGrid, 0.5, -0.5)?.windU, 3);
  assert.equal(sampleGridAtCoordinate(westernGrid, 0.5, 0.5), null);
});

test('preserves null cells instead of fabricating environmental values', () => {
  const withMissing = { ...grid, fields: { ...grid.fields, pressure: [100000, null, 100200, 100300] } };
  assert.equal(sampleGridAtCoordinate(withMissing, 0.5, 0.5)?.pressure, null);
});

test('converts GFS SI values and computes meteorological direction', () => {
  assert.equal(windSpeedKt(3, 4), 9.7192);
  assert.equal(windDirectionDegrees(1, 0), 270);
  assert.equal(windCardinal(45), 'NE');
  assert.equal(temperatureCelsius(299.15), 26);
  assert.ok(Math.abs(precipitationRateMillimetresPerHour(0.0001)! - 0.36) < 1e-9);
  assert.equal(pressureHpa(101400), 1014);
});
