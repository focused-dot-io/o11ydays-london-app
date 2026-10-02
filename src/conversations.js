'use strict';

// In-memory conversation store. The app issues the conversation id (a real one, never
// fabricated from the trace), so judge -> appeal -> final can share it across three traces.
// One store per process; restarting the app forgets every conversation.

const crypto = require('node:crypto');

const store = new Map();

function create() {
  const conversation = { id: crypto.randomUUID(), turns: [] };
  store.set(conversation.id, conversation);
  return conversation;
}

function get(id) {
  return store.get(id);
}

/** Records one turn. Returns the conversation, or undefined for an unknown id. */
function append(id, entry) {
  const conversation = store.get(id);
  if (!conversation) return undefined;
  conversation.turns.push(entry);
  return conversation;
}

function reset() {
  store.clear();
}

module.exports = { create, get, append, reset };
