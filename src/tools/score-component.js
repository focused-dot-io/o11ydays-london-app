'use strict';

// score_component: a fixed, deterministic rubric. Each component starts from a base score;
// each positive keyword found in the notes adds its weight, each negative one subtracts it.
// The result is clamped to 0-10 and rounded to one decimal. Runs in-process.

const COMPONENT_BASE = {
  meat: 6,
  nut_roast: 5.5,
  roasties: 6,
  yorkshire: 6,
  gravy: 6,
  veg: 5.5,
};

const POSITIVE = [
  ['perfect', 1.5],
  ['crisp', 1],
  ['risen', 1],
  ['fluffy', 1],
  ['rich', 1],
  ['proper', 0.8],
  ['pink', 0.8],
  ['golden', 1],
  ['homemade', 1],
  ['glossy', 0.8],
  ['tender', 1],
  ['juicy', 1],
  ['crackling', 0.8],
  ['roasting juices', 0.8],
  ['seasoned', 0.5],
  ['generous', 0.5],
  ['banging', 1.5],
];

const NEGATIVE = [
  ['soggy', 1.5],
  ['flat', 1.2],
  ['burnt', 1.5],
  ['packet', 1.5],
  ['granules', 1.5],
  ['grey', 1.2],
  ['dry', 1],
  ['cold', 1],
  ['mushy', 1.2],
  ['boiled to death', 1.5],
  ['overcooked', 1],
  ['undercooked', 1.2],
  ['tough', 1],
  ['chewy', 0.8],
  ['bland', 0.8],
  ['watery', 1],
  ['lumpy', 0.8],
  ['microwaved', 1.5],
  ['frozen', 1],
  ['stingy', 0.5],
];

const name = 'score_component';
const type = 'function';

const definition = {
  type: 'function',
  name,
  description:
    'Score one component of a Sunday roast from 0 to 10 using the house rubric. Pass the component id and the reviewer notes about that component.',
  parameters: {
    type: 'object',
    properties: {
      component: {
        type: 'string',
        enum: Object.keys(COMPONENT_BASE),
        description: 'Which part of the roast to score.',
      },
      notes: {
        type: 'string',
        description: 'What the reviewer said about this component.',
      },
    },
    required: ['component'],
  },
  strict: false,
};

function scoreNotes(component, notes) {
  const text = String(notes || '').toLowerCase();
  let score = COMPONENT_BASE[component];
  for (const [kw, w] of POSITIVE) if (text.includes(kw)) score += w;
  for (const [kw, w] of NEGATIVE) if (text.includes(kw)) score -= w;
  score = Math.min(10, Math.max(0, score));
  return Math.round(score * 10) / 10;
}

async function execute(args = {}, ctx = {}) { // eslint-disable-line no-unused-vars
  const { component, notes } = args;
  if (!Object.prototype.hasOwnProperty.call(COMPONENT_BASE, component)) {
    throw new Error(`score_component: unknown component "${component}"`);
  }
  return { component, score: scoreNotes(component, notes) };
}

module.exports = { name, type, definition, execute, COMPONENT_BASE, POSITIVE, NEGATIVE };
