'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CORPUS_PATH = path.join(__dirname, '..', 'replay', 'corpus.json');
const loadCorpus = () => JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
const loadVocab = () => require('../services/model-replay/vocabulary.js');

const LABELS = ['banging', 'decent', 'disappointing', 'a crime'];

test('corpus is a JSON array of 35-50 items', () => {
  const corpus = loadCorpus();
  assert.ok(Array.isArray(corpus));
  assert.ok(corpus.length >= 35 && corpus.length <= 50, `length ${corpus.length}`);
});

test('corpus ids are unique and look like roast-NNN', () => {
  const corpus = loadCorpus();
  const ids = corpus.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'ids unique');
  for (const id of ids) assert.match(id, /^roast-\d{3}$/);
});

test('every item has non-empty text', () => {
  for (const item of loadCorpus()) {
    assert.equal(typeof item.text, 'string', item.id);
    assert.ok(item.text.trim().length > 0, item.id);
  }
});

test("every item's pub exists in the vocabulary", () => {
  const slugs = new Set(loadVocab().pubs.map((p) => p.slug));
  for (const item of loadCorpus()) {
    assert.ok(slugs.has(item.pub), `${item.id}: unknown pub ${item.pub}`);
  }
});

test("every item's components are valid component ids with no duplicates", () => {
  const ids = new Set(loadVocab().components.map((c) => c.id));
  for (const item of loadCorpus()) {
    assert.ok(Array.isArray(item.components), `${item.id} components is an array`);
    for (const c of item.components) assert.ok(ids.has(c), `${item.id}: bad component ${c}`);
    assert.equal(new Set(item.components).size, item.components.length, `${item.id}: duplicate components`);
  }
});

test('every vocabulary pub appears at least once', () => {
  const used = new Set(loadCorpus().map((i) => i.pub));
  for (const p of loadVocab().pubs) assert.ok(used.has(p.slug), `pub ${p.slug} not in corpus`);
});

test('at least 3 items include nut_roast', () => {
  const n = loadCorpus().filter((i) => i.components.includes('nut_roast')).length;
  assert.ok(n >= 3, `nut_roast items: ${n}`);
});

test('at least 3 items include veg', () => {
  const n = loadCorpus().filter((i) => i.components.includes('veg')).length;
  assert.ok(n >= 3, `veg items: ${n}`);
});

test('expected_v1_label is always a valid label and all four labels appear', () => {
  const corpus = loadCorpus();
  for (const item of corpus) assert.ok(LABELS.includes(item.expected_v1_label), `${item.id}: ${item.expected_v1_label}`);
  const seen = new Set(corpus.map((i) => i.expected_v1_label));
  for (const l of LABELS) assert.ok(seen.has(l), `label ${l} never appears`);
});

test('every item has an appeal with text and a valid component', () => {
  const ids = new Set(loadVocab().components.map((c) => c.id));
  for (const item of loadCorpus()) {
    assert.ok(item.appeal && typeof item.appeal === 'object', `${item.id} has appeal`);
    assert.equal(typeof item.appeal.text, 'string', `${item.id} appeal.text`);
    assert.ok(item.appeal.text.trim().length > 0, `${item.id} appeal.text non-empty`);
    assert.ok(ids.has(item.appeal.component), `${item.id}: bad appeal component ${item.appeal.component}`);
  }
});
