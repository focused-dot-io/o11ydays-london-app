'use strict';

// checkpoint-3: Module 2 done plus Module 3 stamping (prompt and verdict attributes), ready to flip.
// Says nothing about gen_ai.conversation.id (that is checkpoint-4 / main).

const { module3Checks } = require('./_gen-ai.js');

module.exports = [...require('./module-2.js'), ...module3Checks];
