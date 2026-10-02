'use strict';

// Fixed vocabulary for the replay engine. Keywords are matched case-insensitively as
// substrings. Pub names are matched first and blanked out of the text before component
// matching, so "The Gravy Boat" does not count as a mention of gravy.
// Every pub here is fictional.

const components = [
  {
    id: 'meat',
    keywords: ['beef', 'lamb', 'pork', 'chicken', 'turkey', 'gammon', 'venison', 'crackling', 'sirloin', 'brisket', 'topside', 'meat'],
  },
  { id: 'nut_roast', keywords: ['nut roast', 'nut loaf', 'lentil roast', 'mushroom wellington'] },
  { id: 'roasties', keywords: ['roasties', 'roast potato', 'roast spud', 'spuds', 'potatoes'] },
  { id: 'yorkshire', keywords: ['yorkshire', 'yorkie'] },
  { id: 'gravy', keywords: ['gravy'] },
  {
    id: 'veg',
    keywords: ['veg', 'carrot', 'parsnip', 'cabbage', 'broccoli', 'greens', 'sprouts', 'cauliflower', 'peas', 'leeks', 'kale'],
  },
];

const pubs = [
  { slug: 'the-gravy-boat', name: 'The Gravy Boat', keywords: ['gravy boat'], price_band: 'mid' },
  { slug: 'the-crispy-spud', name: 'The Crispy Spud', keywords: ['crispy spud'], price_band: 'budget' },
  { slug: 'the-rising-yorkshire', name: 'The Rising Yorkshire', keywords: ['rising yorkshire'], price_band: 'premium' },
  { slug: 'the-soggy-bottom', name: 'The Soggy Bottom', keywords: ['soggy bottom'], price_band: 'budget' },
  { slug: 'the-burnt-end', name: 'The Burnt End', keywords: ['burnt end'], price_band: 'mid' },
  { slug: 'the-nut-roast-arms', name: 'The Nut Roast Arms', keywords: ['nut roast arms'], price_band: 'mid' },
  { slug: 'the-gilded-parsnip', name: 'The Gilded Parsnip', keywords: ['gilded parsnip'], price_band: 'premium' },
  { slug: 'the-duke-of-dripping', name: 'The Duke of Dripping', keywords: ['duke of dripping'], price_band: 'premium' },
  { slug: 'the-pickled-ploughman', name: 'The Pickled Ploughman', keywords: ['pickled ploughman'], price_band: 'budget' },
  { slug: 'the-lamb-and-lantern', name: 'The Lamb & Lantern', keywords: ['lamb & lantern', 'lamb and lantern'], price_band: 'mid' },
];

const labels = ['banging', 'decent', 'disappointing', 'a crime'];

function labelFor(score) {
  if (score >= 8) return 'banging';
  if (score >= 6) return 'decent';
  if (score >= 4) return 'disappointing';
  return 'a crime';
}

module.exports = { components, pubs, labels, labelFor };
