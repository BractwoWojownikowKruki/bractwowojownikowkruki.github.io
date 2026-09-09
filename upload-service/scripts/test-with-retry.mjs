#!/usr/bin/env node
// Defensive mitigation for a known, pre-existing, unreproduced flaky-test issue in this suite
// (see the KRKG-0050 story's review notes: an external review hit 3 unrelated failures in one
// full-suite run; 18+ local reproduction attempts, including under artificial CPU/parallel load,
// never reproduced any failure - the mechanism is unconfirmed). This is deliberately NOT a root-
// cause fix: systematic-debugging investigation found no reproducible cause to fix, only a very
// low-frequency, order/timing-sensitive flake affecting seemingly random tests across runs.
//
// This wrapper runs the real test command once; if - and only if - it fails, it runs the exact
// same command a second time before giving up. A transient flake clears on retry and the run
// still ends green (with the first attempt's failure output kept visible above the retry, so a
// flake is never silently hidden). A REAL, reproducible failure fails identically both times and
// still fails the build - this never masks an actual regression, it only tolerates one-off noise.
//
// If this script's retry is ever seen firing in CI, that is itself worth investigating further -
// it means the flake is real and recurring, not a one-off it's safe to keep ignoring.
import { spawnSync } from 'node:child_process';

const args = ['--test', 'src/*.test.ts', 'scripts/*.test.ts'];

function run() {
  return spawnSync('tsx', args, { stdio: 'inherit', shell: true });
}

const first = run();
if (first.status === 0) process.exit(0);

console.error(
  '\n[test-with-retry] First run failed (exit ' +
    first.status +
    '). Retrying once before failing the build - ' +
    'see scripts/test-with-retry.mjs for why this retry exists.\n',
);

const second = run();
if (second.status === 0) {
  console.error(
    '\n[test-with-retry] Retry passed. Treating this as the known, unreproduced flake, not a real ' +
      'failure - but a retry firing in CI is worth investigating if it keeps happening.\n',
  );
  process.exit(0);
}

console.error(
  '\n[test-with-retry] Retry also failed - this is a real, reproducible failure, not the known flake. Failing the build.\n',
);
process.exit(second.status ?? 1);
