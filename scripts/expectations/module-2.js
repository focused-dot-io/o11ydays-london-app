'use strict';

// module-2: "Module 2 is done". invoke_agent wraps the run, chat spans from the openai one-liner
// nest under it, and every tool call has an execute_tool span with the pub guide fetch and the
// sqlite query nested under the right tool. Used by `npm run check-spans` on every checkpoint.

const { agentChecks, toolChecks } = require('./_gen-ai.js');

const checks = [...agentChecks, ...toolChecks];

module.exports = checks;
module.exports.MODULE_2 = checks;
