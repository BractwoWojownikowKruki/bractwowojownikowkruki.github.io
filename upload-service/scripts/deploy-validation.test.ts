// KRKG-0050 (batch 4/6, fix round 1): unit tests for scripts/deploy-validation.ts, covering the
// four cases plan-addendum.md names for the deploy workflow's Scheduler/IAM steps - missing
// secret, wrong OIDC audience, missing invoker binding, and job-describe verification. These
// exercise the pure validation functions directly (no `gcloud`, no Actions runner, no live GCP
// project available in this environment - see the batch-4 fix-round-1 report for what is and
// isn't covered by this).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPECTED_RECONCILE_SCHEDULE,
  validateInvokerBinding,
  validateRequiredSecret,
  validateSchedulerJob,
  type SchedulerJobDescribe,
} from './deploy-validation.ts';

const SERVICE_URL = 'https://krucze-galery-upload-abc123-ew.a.run.app';
const RECONCILER_SA = 'audit-reconciler@krucze-galery-upload.iam.gserviceaccount.com';

// --- Case 1: missing secret ---------------------------------------------------------------------

test('validateRequiredSecret rejects an unset AUDIT_RECONCILER_SERVICE_ACCOUNT secret', () => {
  const result = validateRequiredSecret('AUDIT_RECONCILER_SERVICE_ACCOUNT', undefined);
  assert.equal(result.ok, false);
  assert.match((result as { errors: string[] }).errors[0], /AUDIT_RECONCILER_SERVICE_ACCOUNT secret is not set/);
});

test('validateRequiredSecret rejects an empty-string secret the same as unset (GitHub Actions renders a missing secret as "")', () => {
  const result = validateRequiredSecret('AUDIT_RECONCILER_SERVICE_ACCOUNT', '');
  assert.equal(result.ok, false);
});

test('validateRequiredSecret rejects a whitespace-only secret', () => {
  const result = validateRequiredSecret('AUDIT_RECONCILER_SERVICE_ACCOUNT', '   ');
  assert.equal(result.ok, false);
});

test('validateRequiredSecret accepts a configured secret', () => {
  assert.deepEqual(validateRequiredSecret('AUDIT_RECONCILER_SERVICE_ACCOUNT', RECONCILER_SA), { ok: true });
});

// --- Case 3: missing invoker binding ------------------------------------------------------------

test('validateInvokerBinding rejects a policy with no roles/run.invoker binding at all', () => {
  const result = validateInvokerBinding({ bindings: [{ role: 'roles/run.viewer', members: [`serviceAccount:${RECONCILER_SA}`] }] }, RECONCILER_SA);
  assert.equal(result.ok, false);
  assert.match((result as { errors: string[] }).errors[0], /missing a roles\/run\.invoker binding/);
});

test('validateInvokerBinding rejects a roles/run.invoker binding for a different member', () => {
  const result = validateInvokerBinding(
    { bindings: [{ role: 'roles/run.invoker', members: ['serviceAccount:someone-else@project.iam.gserviceaccount.com'] }] },
    RECONCILER_SA,
  );
  assert.equal(result.ok, false);
});

test('validateInvokerBinding rejects an empty/undefined bindings array', () => {
  assert.equal(validateInvokerBinding({}, RECONCILER_SA).ok, false);
  assert.equal(validateInvokerBinding({ bindings: [] }, RECONCILER_SA).ok, false);
});

test('validateInvokerBinding accepts a policy carrying the expected roles/run.invoker binding, alongside unrelated bindings', () => {
  const result = validateInvokerBinding(
    {
      bindings: [
        { role: 'roles/run.admin', members: ['user:someone@example.com'] },
        { role: 'roles/run.invoker', members: ['serviceAccount:unrelated@project.iam.gserviceaccount.com', `serviceAccount:${RECONCILER_SA}`] },
      ],
    },
    RECONCILER_SA,
  );
  assert.deepEqual(result, { ok: true });
});

// --- Cases 2 & 4: wrong OIDC audience, and job-describe verification -----------------------------

function validJobDescribe(): Required<Pick<SchedulerJobDescribe, 'schedule'>> & {
  httpTarget: { uri: string; oidcToken: { serviceAccountEmail: string; audience: string } };
} {
  return {
    schedule: EXPECTED_RECONCILE_SCHEDULE,
    httpTarget: {
      uri: `${SERVICE_URL}/internal/audit/reconcile`,
      oidcToken: { serviceAccountEmail: RECONCILER_SA, audience: SERVICE_URL },
    },
  };
}

test('validateSchedulerJob accepts a job matching schedule, URI, OIDC service account, and OIDC audience', () => {
  assert.deepEqual(validateSchedulerJob(validJobDescribe(), SERVICE_URL, RECONCILER_SA), { ok: true });
});

test('validateSchedulerJob rejects a wrong OIDC audience (Case 2)', () => {
  const job = validJobDescribe();
  job.httpTarget.oidcToken.audience = 'https://someone-elses-service.run.app';
  const result = validateSchedulerJob(job, SERVICE_URL, RECONCILER_SA);
  assert.equal(result.ok, false);
  assert.deepEqual((result as { errors: string[] }).errors, ['audit-reconcile job OIDC audience does not match the deployed service URL.']);
});

test('validateSchedulerJob rejects a wrong schedule', () => {
  const job = validJobDescribe();
  job.schedule = '0 * * * *';
  const result = validateSchedulerJob(job, SERVICE_URL, RECONCILER_SA);
  assert.equal(result.ok, false);
  assert.match((result as { errors: string[] }).errors[0], /schedule is '0 \* \* \* \*', expected '\*\/15 \* \* \* \*'/);
});

test('validateSchedulerJob rejects a wrong URI (e.g. a stale service URL from a previous deploy)', () => {
  const job = validJobDescribe();
  job.httpTarget.uri = 'https://old-revision-xyz.run.app/internal/audit/reconcile';
  const result = validateSchedulerJob(job, SERVICE_URL, RECONCILER_SA);
  assert.equal(result.ok, false);
  assert.match((result as { errors: string[] }).errors[0], /audit-reconcile job URI is/);
});

test('validateSchedulerJob rejects a wrong OIDC service account', () => {
  const job = validJobDescribe();
  job.httpTarget.oidcToken.serviceAccountEmail = 'someone-else@project.iam.gserviceaccount.com';
  const result = validateSchedulerJob(job, SERVICE_URL, RECONCILER_SA);
  assert.equal(result.ok, false);
  assert.deepEqual((result as { errors: string[] }).errors, ['audit-reconcile job OIDC service account does not match AUDIT_RECONCILER_SERVICE_ACCOUNT.']);
});

test('validateSchedulerJob (Case 4: job-describe verification) reports every mismatched field at once, not just the first', () => {
  const job = validJobDescribe();
  job.schedule = '0 * * * *';
  job.httpTarget.oidcToken.audience = 'https://someone-elses-service.run.app';
  const result = validateSchedulerJob(job, SERVICE_URL, RECONCILER_SA);
  assert.equal(result.ok, false);
  assert.equal((result as { errors: string[] }).errors.length, 2);
});

test('validateSchedulerJob rejects a completely missing httpTarget (job describe for a job of the wrong type)', () => {
  const result = validateSchedulerJob({ schedule: EXPECTED_RECONCILE_SCHEDULE }, SERVICE_URL, RECONCILER_SA);
  assert.equal(result.ok, false);
  assert.equal((result as { errors: string[] }).errors.length, 3); // uri, oidc SA, oidc audience all unresolvable
});
