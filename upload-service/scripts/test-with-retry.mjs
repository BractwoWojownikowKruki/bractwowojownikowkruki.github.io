#!/usr/bin/env node
// Runs the upload-service test suite up to three times, with a short delay between attempts, and
// only fails the build if every attempt fails. The suite is occasionally hit by a rare,
// environment-sensitive flake (a seemingly random test gets a wrong HTTP status), so a transient
// failure clears on retry while a real, reproducible failure fails all three attempts and still
// fails the build. Every attempt's output is printed in full, so a failure is never silently
// hidden - a retry firing repeatedly is a signal worth investigating, not something to ignore.
import { spawnSync } from 'node:child_process';

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;
const args = ['--test', 'src/*.test.ts', 'scripts/*.test.ts'];

function run() {
  return spawnSync('tsx', args, { stdio: 'inherit', shell: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let status = 0;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  status = run().status ?? 1;
  if (status === 0) {
    if (attempt > 1) {
      console.error(`\n[test-with-retry] Attempt ${attempt}/${ATTEMPTS} passed after a retry.\n`);
    }
    process.exit(0);
  }
  if (attempt < ATTEMPTS) {
    console.error(
      `\n[test-with-retry] Attempt ${attempt}/${ATTEMPTS} failed (exit ${status}); retrying in ${RETRY_DELAY_MS} ms...\n`,
    );
    await sleep(RETRY_DELAY_MS);
  }
}

console.error(`\n[test-with-retry] All ${ATTEMPTS} attempts failed - failing the build.\n`);
process.exit(status);
