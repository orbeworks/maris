import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GfsTileMemoryStore, MAX_GFS_TILES_IN_MEMORY } from './gfs-tile-memory';

test('keeps multiple runs and forecast hours without duplicating a tile key', () => {
  const store = new GfsTileMemoryStore<string>();
  store.upsert('0/13/6', 'run-a|0/13/6', 'a');
  store.upsert('0/13/6', 'run-b|0/13/6', 'b');
  store.upsert('3/13/6', 'run-b|3/13/6', 'b+3');

  assert.equal(store.getLatest('0/13/6'), 'b');
  assert.equal(store.getLatest('3/13/6'), 'b+3');
  assert.equal(store.size, 3);
});

test('evicts the least recently used inactive tile and protects active tiles', () => {
  const store = new GfsTileMemoryStore<number>();
  store.setActiveAddresses(['0/0/0']);
  for (let index = 0; index < MAX_GFS_TILES_IN_MEMORY; index += 1) {
    store.upsert(`0/${index}/0`, `run|0/${index}/0`, index);
  }
  store.getLatest('0/1/0');
  store.upsert('0/32/0', 'run|0/32/0', 32);

  assert.equal(store.getLatest('0/0/0'), 0);
  assert.equal(store.getLatest('0/1/0'), 1);
  assert.equal(store.getLatest('0/2/0'), undefined);
  assert.equal(store.size, MAX_GFS_TILES_IN_MEMORY);
});
