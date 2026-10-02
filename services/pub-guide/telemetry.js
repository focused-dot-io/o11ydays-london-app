'use strict';

// Same telemetry as the app (http/express/undici, exporter, key, seat), named pub-guide.
process.env.OTEL_SERVICE_NAME ||= 'pub-guide';
module.exports = require('../../src/telemetry.js');
