// KRKG-0050 (batch 4/6, fix round 1): pure, unit-testable validation logic for
// `.github/workflows/deploy-upload-service.yml`'s Scheduler/IAM steps, extracted out of inline
// bash so plan-addendum.md's "workflow/config tests ... for missing secret, wrong audience,
// missing invoker binding, and job-describe verification" has real coverage instead of parity
// with the pre-existing untested CLOUD_RUN_RUNTIME_SA guard.
//
// This module intentionally never calls `gcloud`/`jq`/the GitHub Actions runtime itself - the
// workflow still runs those for real; only the *shape checks* on their output move here, so the
// checks can be exercised directly with `node:test` without a live GCP project or Actions runner.
// See scripts/deploy-validation.test.ts for the four cases plan-addendum.md names, and the
// batch-4 fix-round-1 report for what this does and doesn't cover.

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

/** Case 1: missing secret - e.g. `AUDIT_RECONCILER_SERVICE_ACCOUNT` unset before deploy. */
export function validateRequiredSecret(secretName: string, value: string | undefined): ValidationResult {
  if (!value || value.trim() === '') {
    return { ok: false, errors: [`${secretName} secret is not set - refusing to deploy without a configured audit reconciler identity. See reconciler-runbook.md.`] };
  }
  return { ok: true };
}

export interface IamPolicyBinding {
  role?: string;
  members?: string[];
}

export interface IamPolicy {
  bindings?: IamPolicyBinding[];
}

/** Case 3: missing invoker binding - the reconciler service account must hold `roles/run.invoker`
 * on the Cloud Run service, or `POST /internal/audit/reconcile` is unreachable by Cloud Scheduler
 * even though the route itself is correctly configured. */
export function validateInvokerBinding(policy: IamPolicy, expectedServiceAccountEmail: string): ValidationResult {
  const expectedMember = `serviceAccount:${expectedServiceAccountEmail}`;
  const hasBinding = (policy.bindings ?? []).some(b => b.role === 'roles/run.invoker' && (b.members ?? []).includes(expectedMember));
  if (!hasBinding) {
    return { ok: false, errors: [`Cloud Run IAM policy is missing a roles/run.invoker binding for ${expectedServiceAccountEmail}.`] };
  }
  return { ok: true };
}

export interface SchedulerJobDescribe {
  schedule?: string;
  httpTarget?: {
    uri?: string;
    oidcToken?: {
      serviceAccountEmail?: string;
      audience?: string;
    };
  };
}

export const EXPECTED_RECONCILE_SCHEDULE = '*/15 * * * *';
const RECONCILE_PATH = '/internal/audit/reconcile';

/** Cases 2 and 4: wrong OIDC audience, and job-describe verification as a whole - the live
 * `audit-reconcile` Cloud Scheduler job's schedule/URI/OIDC service account/OIDC audience must
 * all match what was just deployed, per plan-addendum.md's "Deployment is not complete until
 * `gcloud scheduler jobs describe` confirms the 15-minute OIDC job." */
export function validateSchedulerJob(job: SchedulerJobDescribe, expectedServiceUrl: string, expectedServiceAccountEmail: string): ValidationResult {
  const errors: string[] = [];
  const expectedUri = `${expectedServiceUrl}${RECONCILE_PATH}`;
  if (job.schedule !== EXPECTED_RECONCILE_SCHEDULE) {
    errors.push(`audit-reconcile job schedule is '${job.schedule}', expected '${EXPECTED_RECONCILE_SCHEDULE}'.`);
  }
  if (job.httpTarget?.uri !== expectedUri) {
    errors.push(`audit-reconcile job URI is '${job.httpTarget?.uri}', expected '${expectedUri}'.`);
  }
  if (job.httpTarget?.oidcToken?.serviceAccountEmail !== expectedServiceAccountEmail) {
    errors.push('audit-reconcile job OIDC service account does not match AUDIT_RECONCILER_SERVICE_ACCOUNT.');
  }
  if (job.httpTarget?.oidcToken?.audience !== expectedServiceUrl) {
    errors.push('audit-reconcile job OIDC audience does not match the deployed service URL.');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

// --- CLI --------------------------------------------------------------------------------------
// Invoked from the workflow itself (see .github/workflows/deploy-upload-service.yml) so the exact
// logic covered by deploy-validation.test.ts is what actually gates the deploy, not a
// hand-maintained bash copy of it that can drift out of sync.

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function fail(errors: string[]): never {
  for (const error of errors) console.error(`::error::${error}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'require-secret': {
      const [secretName, value] = args;
      const result = validateRequiredSecret(secretName, value);
      if (!result.ok) fail(result.errors);
      return;
    }
    case 'verify-invoker-binding': {
      const [expectedServiceAccountEmail] = args;
      const policy = JSON.parse(await readStdin()) as IamPolicy;
      const result = validateInvokerBinding(policy, expectedServiceAccountEmail);
      if (!result.ok) fail(result.errors);
      console.log(`roles/run.invoker binding for ${expectedServiceAccountEmail} verified.`);
      return;
    }
    case 'verify-scheduler-job': {
      const [expectedServiceUrl, expectedServiceAccountEmail] = args;
      const job = JSON.parse(await readStdin()) as SchedulerJobDescribe;
      const result = validateSchedulerJob(job, expectedServiceUrl, expectedServiceAccountEmail);
      if (!result.ok) fail(result.errors);
      console.log(`audit-reconcile Scheduler job verified: 15-minute OIDC job targeting ${expectedServiceUrl}.`);
      return;
    }
    default:
      console.error(`Unknown command: ${command}. Expected require-secret | verify-invoker-binding | verify-scheduler-job.`);
      process.exit(1);
  }
}

// Only run the CLI when this file is executed directly (`tsx scripts/deploy-validation.ts ...`),
// not when deploy-validation.test.ts imports the pure functions above.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
