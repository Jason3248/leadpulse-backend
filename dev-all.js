'use strict';

/**
 * Runs all three services together for local development: the main API
 * plus its two microservices. This is the only piece of "orchestration" in
 * the whole setup — no message broker, no service mesh, no Docker compose
 * required. Each service is a completely ordinary Node process; this
 * script just starts three of them and prefixes their output so you can
 * tell which log line came from where.
 *
 * Run: npm run dev  (from the workspace root)
 * Stop: Ctrl+C — kills all three together.
 */

const { spawn } = require('child_process');
const path = require('path');

const services = [
  { name: 'api', cwd: 'leadpulse-api', color: '\x1b[36m' }, // cyan
  { name: 'import', cwd: 'leadpulse-upload-service', color: '\x1b[33m' }, // yellow
  { name: 'email', cwd: 'leadpulse-email-service', color: '\x1b[35m' } // magenta
];
const RESET = '\x1b[0m';

const children = services.map(({ name, cwd, color }) => {
  const child = spawn('npm', ['run', 'dev'], {
    cwd: path.resolve(__dirname, cwd),
    shell: true
  });

  const prefix = `${color}[${name}]${RESET}`;
  child.stdout.on('data', (d) =>
    d
      .toString()
      .split('\n')
      .filter(Boolean)
      .forEach((line) => console.log(`${prefix} ${line}`))
  );
  child.stderr.on('data', (d) =>
    d
      .toString()
      .split('\n')
      .filter(Boolean)
      .forEach((line) => console.error(`${prefix} ${line}`))
  );

  return child;
});

process.on('SIGINT', () => {
  children.forEach((c) => c.kill('SIGINT'));
  process.exit(0);
});
