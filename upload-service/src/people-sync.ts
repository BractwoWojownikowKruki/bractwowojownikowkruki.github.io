// Asks GitHub to refresh the static people data (public/people-data + public/people-photos) soon
// after a public person/photo change, instead of waiting for the nightly job.
//
// Debouncing lives in the workflow, not here: Cloud Run may throttle or stop an instance right
// after a response, so an in-process timer is not reliable. Every request just dispatches
// sync-people-photos.yml with a `debounce_seconds` input; the workflow sleeps that long before
// reading the data, and its concurrency group keeps at most one run queued, so a burst of edits
// collapses into one or two runs.
//
// request() never throws: a failed dispatch (e.g. the token lacks "Actions: write") must not fail
// the admin's or member's actual action - the nightly run is the safety net.

export interface PeopleSyncTrigger {
  request(): Promise<void>;
}

export interface PeopleSyncDeps {
  token: string;
  repo: string;
  fetchImpl: typeof fetch;
  debounceSeconds?: number;
  // Per-instance guard against dispatching for every edit of a burst.
  minIntervalMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

const WORKFLOW_FILE = 'sync-people-photos.yml';

export function createPeopleSyncTrigger(deps: PeopleSyncDeps): PeopleSyncTrigger {
  const debounceSeconds = deps.debounceSeconds ?? 120;
  const minIntervalMs = deps.minIntervalMs ?? 60_000;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((m: string) => console.warn(m));
  let lastDispatchAt = -Infinity;

  return {
    async request() {
      if (now() - lastDispatchAt < minIntervalMs) return;
      lastDispatchAt = now();
      try {
        const res = await deps.fetchImpl(
          `https://api.github.com/repos/${deps.repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${deps.token}`,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ref: 'main', inputs: { debounce_seconds: String(debounceSeconds) } }),
            signal: AbortSignal.timeout(5000),
          },
        );
        if (!res.ok) log(`[people-sync] dispatch failed: HTTP ${res.status}`);
      } catch (err) {
        log(`[people-sync] dispatch failed: ${(err as Error).message}`);
      }
    },
  };
}
