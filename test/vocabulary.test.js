'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const loadVocab = () => require('../services/model-replay/vocabulary.js');

const COMPONENT_IDS = ['meat', 'nut_roast', 'roasties', 'yorkshire', 'gravy', 'veg'];
const LABELS = ['banging', 'decent', 'disappointing', 'a crime'];
const REQUIRED_PUBS = [
  'the-gravy-boat',
  'the-crispy-spud',
  'the-rising-yorkshire',
  'the-soggy-bottom',
  'the-burnt-end',
  'the-nut-roast-arms',
];

test('vocabulary exports components, pubs, labels and labelFor', () => {
  const v = loadVocab();
  assert.ok(Array.isArray(v.components), 'components is an array');
  assert.ok(Array.isArray(v.pubs), 'pubs is an array');
  assert.ok(Array.isArray(v.labels), 'labels is an array');
  assert.equal(typeof v.labelFor, 'function', 'labelFor is a function');
});

test('component ids are exactly meat, nut_roast, roasties, yorkshire, gravy, veg', () => {
  const { components } = loadVocab();
  assert.deepEqual(components.map((c) => c.id).sort(), [...COMPONENT_IDS].sort());
  assert.equal(components.length, COMPONENT_IDS.length, 'no duplicate component ids');
});

test('every component has a non-empty keywords array of non-empty strings', () => {
  const { components } = loadVocab();
  for (const c of components) {
    assert.ok(Array.isArray(c.keywords) && c.keywords.length > 0, `${c.id} has keywords`);
    for (const k of c.keywords) {
      assert.equal(typeof k, 'string', `${c.id} keyword is a string`);
      assert.ok(k.trim().length > 0, `${c.id} keyword is non-empty`);
    }
  }
});

test('labels are exactly banging, decent, disappointing, a crime (in that order)', () => {
  const { labels } = loadVocab();
  assert.deepEqual(labels, LABELS);
});

test('labelFor applies the score boundaries 8 / 6 / 4', () => {
  const { labelFor } = loadVocab();
  const cases = [
    [10, 'banging'],
    [8.5, 'banging'],
    [8, 'banging'],
    [7.9, 'decent'],
    [6.5, 'decent'],
    [6, 'decent'],
    [5.9, 'disappointing'],
    [4, 'disappointing'],
    [3.9, 'a crime'],
    [1, 'a crime'],
    [0, 'a crime'],
  ];
  for (const [score, label] of cases) {
    assert.equal(labelFor(score), label, `labelFor(${score})`);
  }
});

test('pubs have slug, name, keywords and a valid price_band', () => {
  const { pubs } = loadVocab();
  assert.ok(pubs.length >= REQUIRED_PUBS.length, 'at least the required pubs');
  for (const p of pubs) {
    assert.equal(typeof p.slug, 'string');
    assert.match(p.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, `slug ${p.slug} is kebab-case`);
    assert.equal(typeof p.name, 'string');
    assert.ok(p.name.length > 0, `${p.slug} has a name`);
    assert.ok(Array.isArray(p.keywords) && p.keywords.length > 0, `${p.slug} has keywords`);
    for (const k of p.keywords) {
      assert.equal(typeof k, 'string');
      assert.ok(k.trim().length > 0, `${p.slug} keyword is non-empty`);
    }
    assert.ok(['budget', 'mid', 'premium'].includes(p.price_band), `${p.slug} price_band ${p.price_band}`);
  }
});

test('pub slugs are unique', () => {
  const { pubs } = loadVocab();
  const slugs = pubs.map((p) => p.slug);
  assert.equal(new Set(slugs).size, slugs.length);
});

test('required fictional pubs are present', () => {
  const { pubs } = loadVocab();
  const slugs = new Set(pubs.map((p) => p.slug));
  for (const s of REQUIRED_PUBS) assert.ok(slugs.has(s), `missing pub ${s}`);
});

test('the-condemned-arms (pub-guide reserved failing slug) is absent', () => {
  const { pubs } = loadVocab();
  assert.ok(!pubs.some((p) => p.slug === 'the-condemned-arms'));
});

test('at least one budget pub and one premium pub exist (v2 price-band tracking needs both)', () => {
  const { pubs } = loadVocab();
  assert.ok(pubs.some((p) => p.price_band === 'budget'), 'a budget pub');
  assert.ok(pubs.some((p) => p.price_band === 'premium'), 'a premium pub');
});
