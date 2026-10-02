#!/usr/bin/env node
'use strict';

// `npm run verify [-- <set>]`: is this checkpoint healthy as shipped?
// Runs scripts/expectations/<set>.js, where <set> is the argument or the contents of CHECKPOINT,
// against one judge -> appeal -> final run of the app (in-memory exporter, replay model).
// Exit 0 and `PASS <set>: N checks`, or exit 1 and `FAIL <set>: ...` as the last line.

const { main, readCheckpoint } = require('./lib/run-checks.cjs');

main({ set: (process.argv[2] || '').trim() || readCheckpoint() });
