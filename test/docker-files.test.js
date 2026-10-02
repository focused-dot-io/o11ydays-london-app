'use strict';

// Phase 8 (fast, no Docker daemon): the container and Codespace files.
// SPEC: "Run with `docker compose up` (three services, bind mount, `node --watch`)";
// `docker-compose.yml`, `Dockerfile` (one image, three commands, pinned `node:22.22.0-alpine`), `.nvmrc`;
// `.devcontainer/devcontainer.json` (javascript-node:22 image, postCreateCommand: npm ci + pinned global
// installs of the three coding-agent CLIs + checkout checkpoint-0 when on main with a clean tree,
// postStartCommand scripts/codespace-start.sh, ports 3000/4100/4200).
//
// ASSUMPTIONS (beyond SPEC.md; the implementer must follow these):
//  Dockerfile
//   - `FROM node:22.22.0-alpine` (optionally `AS <stage>`), `WORKDIR /app`, then
//     `COPY package.json package-lock.json ./` (or `package*.json`), then `RUN npm ci --omit=dev`,
//     then `COPY . .` (after npm ci, so the dependency layer caches), and `CMD ["npm", "start"]`.
//   - No secrets baked in: no ENV/ARG naming a KEY/TOKEN/SECRET, no `.env` copied explicitly.
//  .dockerignore lists (one per line; a leading `/` or `**/` or trailing `/` is fine):
//     node_modules  .git  .env  *.log  .dev.pid  .load.pid  .codex-home
//  docker-compose.yml
//   - services `roast-judge`, `pub-guide`, `model-replay`; each `build: .`, `restart: unless-stopped`,
//     volumes `.:/app` (bind) plus an anonymous volume `/app/node_modules`.
//   - commands (exactly, as argv):
//       roast-judge  node --watch --require ./src/telemetry.js --disable-warning=ExperimentalWarning src/server.js
//       pub-guide    node --watch --require ./services/pub-guide/telemetry.js --disable-warning=ExperimentalWarning services/pub-guide/server.js
//       model-replay node --watch --disable-warning=ExperimentalWarning services/model-replay/server.js
//   - ports `${ROASTJUDGE_PORT:-3000}:3000`, `${PUB_GUIDE_PORT:-4100}:4100`, `${REPLAY_PORT:-4200}:4200`.
//   - environment: roast-judge REPLAY_URL=http://model-replay:4200/v1, PUB_GUIDE_URL=http://pub-guide:4100,
//     PORT=3000; pub-guide PORT=4100; model-replay PORT=4200, REPLAY_FAIL_EVERY=${REPLAY_FAIL_EVERY:-25}.
//   - env_file `[{ path: .env, required: false }]` on roast-judge and pub-guide.
//   - healthcheck on every service: `wget -qO- http://localhost:<port>/healthz` (CMD or CMD-SHELL).
//   - roast-judge depends_on pub-guide and model-replay with `condition: service_healthy`.
//   When the docker CLI is present the file is checked through `docker compose config --format json`
//   (no YAML library in the repo); the static text checks always run too.
//  .devcontainer/devcontainer.json is plain JSON (no comments, no trailing commas: JSON.parse must work):
//   - image mcr.microsoft.com/devcontainers/javascript-node:22, forwardPorts [3000, 4100, 4200],
//     portsAttributes with a `label` for "3000", "4100", "4200",
//     postCreateCommand "bash .devcontainer/post-create.sh", postStartCommand "bash scripts/codespace-start.sh",
//     no docker-in-docker feature (the Codespace uses `npm run dev`, not compose).
//  .devcontainer/post-create.sh: bash, `npm ci`, `npm i -g` (or `npm install -g`) of
//     @anthropic-ai/claude-code, @openai/codex and @google/gemini-cli each pinned `@X.Y.Z`, and a
//     checkout of checkpoint-0 guarded by "on main" and an empty `git status --porcelain`.
//  .nvmrc is exactly `22.22.0` (trailing newline allowed).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT } = require('./helpers/run-script.js');
const { dockerCliSkipReason } = require('./helpers/docker.js');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// Dockerfile instructions with comments and blank lines removed and line continuations joined.
function dockerfileInstructions() {
  return read('Dockerfile')
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

test('.nvmrc pins Node 22.22.0', () => {
  assert.equal(read('.nvmrc').trim(), '22.22.0');
});

test('Dockerfile: pinned node:22.22.0-alpine, WORKDIR /app, npm ci before COPY . ., CMD npm start', () => {
  assert.ok(exists('Dockerfile'), 'Dockerfile missing at the repo root');
  const lines = dockerfileInstructions();
  const from = lines.filter((l) => /^FROM\s/i.test(l));
  assert.ok(from.length >= 1, 'no FROM');
  for (const f of from) assert.match(f, /^FROM\s+node:22\.22\.0-alpine(\s+AS\s+\S+)?$/i, `every FROM must pin node:22.22.0-alpine: ${f}`);
  assert.ok(lines.some((l) => /^WORKDIR\s+\/app\/?$/i.test(l)), 'WORKDIR /app missing');

  const iPkg = lines.findIndex((l) => /^COPY\s+(package\.json\s+package-lock\.json|package\*\.json)\s+\S+$/i.test(l));
  const iCi = lines.findIndex((l) => /^RUN\s+npm\s+ci\b.*--omit=dev/i.test(l));
  const iAll = lines.findIndex((l) => /^COPY\s+\.\s+\.\/?$/i.test(l));
  assert.ok(iPkg >= 0, 'COPY package.json package-lock.json ./ missing');
  assert.ok(iCi >= 0, 'RUN npm ci --omit=dev missing');
  assert.ok(iAll >= 0, 'COPY . . missing');
  assert.ok(iPkg < iCi && iCi < iAll, 'order must be: COPY package files, RUN npm ci, COPY . .');

  const cmd = lines.filter((l) => /^CMD\s/i.test(l));
  assert.equal(cmd.length, 1, 'exactly one CMD');
  assert.match(cmd[0], /^CMD\s+\[\s*"npm"\s*,\s*"start"\s*\]$/i);
});

test('Dockerfile bakes in no secrets', () => {
  const lines = dockerfileInstructions();
  for (const l of lines) {
    assert.doesNotMatch(l, /^(ENV|ARG)\s+.*(KEY|TOKEN|SECRET|PASSWORD)/i, `secret-looking ENV/ARG: ${l}`);
    assert.doesNotMatch(l, /^(COPY|ADD)\s+.*(^|\s)\.env(\s|$)/i, `copies .env: ${l}`);
  }
  assert.doesNotMatch(read('Dockerfile'), /HONEYCOMB_API_KEY|OPENAI_API_KEY/);
});

test('.dockerignore excludes node_modules, .git, .env, logs, pidfiles and .codex-home', () => {
  assert.ok(exists('.dockerignore'), '.dockerignore missing');
  const entries = new Set(
    read('.dockerignore')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.replace(/^\*\*\//, '').replace(/^\//, '').replace(/\/$/, '')),
  );
  for (const want of ['node_modules', '.git', '.env', '*.log', '.dev.pid', '.load.pid', '.codex-home']) {
    assert.ok(entries.has(want), `.dockerignore lacks ${want} (has: ${[...entries].join(', ')})`);
  }
  assert.ok(!entries.has('.env.example') && !entries.has('.env*'), '.env.example must stay in the build context');
});

const SERVICES = {
  'roast-judge': {
    port: 3000,
    portVar: 'ROASTJUDGE_PORT',
    command: 'node --watch --require ./src/telemetry.js --disable-warning=ExperimentalWarning src/server.js',
    env: { REPLAY_URL: 'http://model-replay:4200/v1', PUB_GUIDE_URL: 'http://pub-guide:4100', PORT: '3000' },
    envFile: true,
  },
  'pub-guide': {
    port: 4100,
    portVar: 'PUB_GUIDE_PORT',
    command:
      'node --watch --require ./services/pub-guide/telemetry.js --disable-warning=ExperimentalWarning services/pub-guide/server.js',
    env: { PORT: '4100' },
    envFile: true,
  },
  'model-replay': {
    port: 4200,
    portVar: 'REPLAY_PORT',
    command: 'node --watch --disable-warning=ExperimentalWarning services/model-replay/server.js',
    env: { PORT: '4200', REPLAY_FAIL_EVERY: '25' },
    envFile: false,
  },
};

test('docker-compose.yml (static text): three services, watch commands, ports, env, healthchecks', () => {
  assert.ok(exists('docker-compose.yml'), 'docker-compose.yml missing at the repo root');
  const y = read('docker-compose.yml');
  for (const [name, s] of Object.entries(SERVICES)) {
    assert.match(y, new RegExp(`^\\s+${name}:\\s*$`, 'm'), `service ${name} missing`);
    const entry = s.command.split(' ').pop();
    assert.ok(y.includes(entry), `${name}: entrypoint ${entry} missing`);
    assert.ok(y.includes(`\${${s.portVar}:-${s.port}}:${s.port}`), `${name}: port mapping \${${s.portVar}:-${s.port}}:${s.port} missing`);
    assert.match(y, new RegExp(`wget -qO-\\s+http://localhost:${s.port}/healthz`), `${name}: wget healthcheck missing`);
  }
  assert.equal((y.match(/--watch/g) || []).length, 3, 'each of the three commands uses node --watch');
  assert.match(y, /REPLAY_FAIL_EVERY[=:]\s*["']?\$\{REPLAY_FAIL_EVERY:-25\}/);
  assert.match(y, /http:\/\/model-replay:4200\/v1/);
  assert.match(y, /http:\/\/pub-guide:4100/);
  assert.ok((y.match(/path:\s*["']?(\.\/)?\.env["']?\s*$/gm) || []).length >= 2, 'env_file path: .env on roast-judge and pub-guide');
  assert.ok((y.match(/required:\s*false/g) || []).length >= 2, 'env_file required: false on roast-judge and pub-guide');
  assert.match(y, /service_healthy/);
  assert.match(y, /unless-stopped/);
  assert.match(y, /\/app\/node_modules/);
  assert.doesNotMatch(y, /HONEYCOMB_API_KEY\s*[:=]\s*\S/, 'no API key in the compose file');
});

test('docker-compose.yml (docker compose config): resolved services match the contract', (t) => {
  const reason = dockerCliSkipReason();
  if (reason) return t.skip(reason);
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'roastjudge-cfg-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const emptyEnv = path.join(tmp, 'empty.env');
  fs.writeFileSync(emptyEnv, '');
  // --env-file points interpolation at an empty file so a developer's .env cannot change the defaults.
  const r = spawnSync(
    'docker',
    ['compose', '-p', `rj-cfg-${process.pid}`, '-f', 'docker-compose.yml', '--env-file', emptyEnv, 'config', '--format', 'json'],
    { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(r.status, 0, `docker compose config failed:\n${r.stderr}`);
  const cfg = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(cfg.services).sort(), Object.keys(SERVICES).sort());
  const root = fs.realpathSync(ROOT);

  for (const [name, s] of Object.entries(SERVICES)) {
    const svc = cfg.services[name];
    const where = `service ${name}`;
    assert.ok(svc.build, `${where}: build missing`);
    assert.equal(fs.realpathSync(svc.build.context), root, `${where}: build context must be the repo root`);
    assert.equal(path.basename(svc.build.dockerfile || 'Dockerfile'), 'Dockerfile');
    const cmd = Array.isArray(svc.command) ? svc.command.join(' ') : String(svc.command);
    assert.equal(cmd, s.command, `${where}: command`);
    assert.equal(svc.restart, 'unless-stopped', `${where}: restart`);

    const ports = svc.ports || [];
    assert.equal(ports.length, 1, `${where}: one port mapping`);
    assert.equal(Number(ports[0].target), s.port);
    assert.equal(String(ports[0].published), String(s.port), `${where}: default host port`);

    const env = svc.environment || {};
    for (const [k, v] of Object.entries(s.env)) assert.equal(env[k], v, `${where}: environment ${k}`);

    const vols = svc.volumes || [];
    const bind = vols.find((v) => v.type === 'bind' && v.target === '/app');
    assert.ok(bind, `${where}: bind mount .:/app missing`);
    assert.equal(fs.realpathSync(bind.source), root);
    const nm = vols.find((v) => v.type === 'volume' && v.target === '/app/node_modules');
    assert.ok(nm, `${where}: anonymous volume /app/node_modules missing`);
    assert.ok(!nm.source, `${where}: /app/node_modules must be an anonymous volume`);

    const hc = svc.healthcheck && svc.healthcheck.test;
    assert.ok(hc, `${where}: healthcheck missing`);
    const hcText = Array.isArray(hc) ? hc.join(' ') : String(hc);
    assert.match(hcText, new RegExp(`wget\\s+-qO-\\s+http://localhost:${s.port}/healthz`), `${where}: healthcheck`);

    // `config` drops an optional env_file that does not exist, so only check it when it is listed
    // (a developer's .env is present); the static test checks `path: .env` + `required: false`.
    if (s.envFile) {
      for (const f of svc.env_file || []) {
        assert.equal(path.basename(f.path), '.env');
        assert.equal(f.required, false, `${where}: env_file must be required: false`);
      }
    } else {
      assert.ok(!svc.env_file || svc.env_file.length === 0, `${where}: no env_file`);
    }
  }
  const deps = cfg.services['roast-judge'].depends_on || {};
  for (const d of ['pub-guide', 'model-replay']) {
    assert.ok(deps[d], `roast-judge must depend on ${d}`);
    assert.equal(deps[d].condition, 'service_healthy', `roast-judge waits for ${d} to be healthy`);
  }

  // Host ports are overridable.
  const r2 = spawnSync(
    'docker',
    ['compose', '-p', `rj-cfg-${process.pid}`, '-f', 'docker-compose.yml', '--env-file', emptyEnv, 'config', '--format', 'json'],
    {
      cwd: ROOT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ROASTJUDGE_PORT: '13000', PUB_GUIDE_PORT: '14100', REPLAY_PORT: '14200', REPLAY_FAIL_EVERY: '0' },
      encoding: 'utf8',
      timeout: 30000,
    },
  );
  assert.equal(r2.status, 0, r2.stderr);
  const cfg2 = JSON.parse(r2.stdout);
  assert.equal(String(cfg2.services['roast-judge'].ports[0].published), '13000');
  assert.equal(String(cfg2.services['pub-guide'].ports[0].published), '14100');
  assert.equal(String(cfg2.services['model-replay'].ports[0].published), '14200');
  assert.equal(cfg2.services['model-replay'].environment.REPLAY_FAIL_EVERY, '0');
});

test('.devcontainer/devcontainer.json is plain JSON with the Codespace contract', () => {
  assert.ok(exists('.devcontainer/devcontainer.json'), '.devcontainer/devcontainer.json missing');
  const raw = read('.devcontainer/devcontainer.json');
  let dc;
  assert.doesNotThrow(() => {
    dc = JSON.parse(raw);
  }, 'devcontainer.json must be plain JSON (no comments, no trailing commas)');
  assert.equal(dc.image, 'mcr.microsoft.com/devcontainers/javascript-node:22');
  assert.deepEqual(dc.forwardPorts, [3000, 4100, 4200]);
  for (const p of ['3000', '4100', '4200']) {
    assert.ok(dc.portsAttributes && dc.portsAttributes[p], `portsAttributes.${p} missing`);
    assert.equal(typeof dc.portsAttributes[p].label, 'string');
    assert.ok(dc.portsAttributes[p].label.trim(), `portsAttributes.${p}.label empty`);
  }
  assert.equal(dc.postCreateCommand, 'bash .devcontainer/post-create.sh');
  assert.equal(dc.postStartCommand, 'bash scripts/codespace-start.sh');
  assert.doesNotMatch(raw, /docker-in-docker/, 'the Codespace runs npm run dev, not compose: no docker-in-docker');
  assert.doesNotMatch(raw, /HONEYCOMB_API_KEY\s*"\s*:\s*"\S|OPENAI_API_KEY\s*"\s*:\s*"\S/, 'no credentials in devcontainer.json');
});

test('.devcontainer/post-create.sh: npm ci, pinned agent CLIs, guarded checkout of checkpoint-0', () => {
  const rel = '.devcontainer/post-create.sh';
  assert.ok(exists(rel), `${rel} missing`);
  const src = read(rel);
  assert.match(src.split('\n')[0], /^#!\/usr\/bin\/env bash$|^#!\/bin\/bash$/, 'bash shebang');
  const syntax = spawnSync('bash', ['-n', path.join(ROOT, rel)], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, `bash -n: ${syntax.stderr}`);
  const code = src
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.match(code, /\bnpm ci\b/);
  assert.match(code, /\bnpm (i|install) (-g|--global)\b/);
  for (const pkg of ['@anthropic-ai/claude-code', '@openai/codex', '@google/gemini-cli']) {
    const re = new RegExp(`${pkg.replace(/[/.]/g, '\\$&')}@\\d+\\.\\d+\\.\\d+(?![\\w.-])`);
    assert.match(code, re, `${pkg} must be pinned to an exact version`);
  }
  assert.match(code, /checkpoint-0/);
  assert.match(code, /git status --porcelain/);
  assert.match(code, /\bmain\b/, 'the checkout is guarded by being on main');
});
