'use strict';

// Phase 4: src/conversations.js, the in-memory conversation store.
// SPEC: exports { create(), get(id), append(id, entry), reset() }; create() returns { id, turns: [] }.
// ASSUMPTIONS (beyond SPEC.md):
//  - The store is module-level state (one store per process).
//  - get(id) returns the SAME object create() returned (no copies).
//  - append(id, entry) pushes `entry` onto conversation.turns and returns the conversation;
//    append on an unknown id returns undefined or throws (either is fine) and creates nothing.
//  - reset() empties the store (previous ids no longer resolve).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const load = () => require('../src/conversations.js');

beforeEach(() => {
  load().reset();
});

test('conversations: exports create, get, append, reset', () => {
  const c = load();
  for (const fn of ['create', 'get', 'append', 'reset']) assert.equal(typeof c[fn], 'function', fn);
});

test('conversations: create() returns { id, turns: [] } with a non-empty string id', () => {
  const conv = load().create();
  assert.equal(typeof conv.id, 'string');
  assert.ok(conv.id.length > 0);
  assert.deepEqual(conv.turns, []);
});

test('conversations: ids are unique', () => {
  const { create } = load();
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add(create().id);
  assert.equal(ids.size, 200);
});

test('conversations: get(id) returns the same object; unknown id -> undefined', () => {
  const { create, get } = load();
  const conv = create();
  assert.equal(get(conv.id), conv);
  assert.equal(get('nope'), undefined);
});

test('conversations: append(id, entry) pushes onto turns and returns the conversation', () => {
  const { create, get, append } = load();
  const conv = create();
  const entry = { turn: 1, text: 'The Gravy Boat, beef.' };
  const ret = append(conv.id, entry);
  assert.equal(ret, conv);
  assert.equal(get(conv.id).turns.length, 1);
  assert.equal(get(conv.id).turns[0], entry);
  append(conv.id, { turn: 2 });
  assert.equal(get(conv.id).turns.length, 2);
  // unknown id: either returns undefined or throws, but never invents a conversation
  let ret2;
  try {
    ret2 = append('nope', { turn: 1 });
  } catch {
    ret2 = undefined;
  }
  assert.equal(ret2, undefined);
  assert.equal(get('nope'), undefined);
});

test('conversations: reset() empties the store', () => {
  const { create, get, reset } = load();
  const a = create();
  const b = create();
  reset();
  assert.equal(get(a.id), undefined);
  assert.equal(get(b.id), undefined);
  const c = create();
  assert.equal(get(c.id), c);
});
