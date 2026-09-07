/** Stable token replaced with the human-readable build identity during deployment. */
export const RELEASE_INFO_PLACEHOLDER = '{{RELEASE_INFO}}';

/** Inputs required to produce a release identity without consulting process or wall-clock state. */
export interface ReleaseMetadataInput {
  readonly buildTimestamp: Date;
  readonly runNumber: string | number;
  readonly commitSha: string;
}

/** The structured and rendered forms of the identity shown in the shared footer. */
export interface ReleaseMetadata {
  readonly version: string;
  readonly shortSha: string;
  readonly publishedAt: string;
  readonly text: string;
}

/** Formats an explicit build timestamp, run number, and full commit SHA deterministically in UTC. */
export function formatReleaseMetadata({
  buildTimestamp,
  runNumber,
  commitSha,
}: ReleaseMetadataInput): ReleaseMetadata {
  if (!Number.isFinite(buildTimestamp.getTime())) {
    throw new Error('buildTimestamp must be a valid date');
  }

  const normalizedRunNumber = String(runNumber).trim();
  if (!/^\d+$/.test(normalizedRunNumber)) {
    throw new Error('runNumber must contain only digits');
  }

  const normalizedSha = commitSha.trim();
  if (!/^[0-9a-fA-F]{7,}$/.test(normalizedSha)) {
    throw new Error('commitSha must contain at least 7 hexadecimal characters');
  }

  const year = buildTimestamp.getUTCFullYear();
  const month = pad(buildTimestamp.getUTCMonth() + 1);
  const day = pad(buildTimestamp.getUTCDate());
  const hours = pad(buildTimestamp.getUTCHours());
  const minutes = pad(buildTimestamp.getUTCMinutes());
  const version = `${year}.${month}.${day}.${normalizedRunNumber}`;
  const shortSha = normalizedSha.slice(0, 7);
  const publishedAt = `${day}.${month}.${year}, ${hours}:${minutes} UTC`;

  return {
    version,
    shortSha,
    publishedAt,
    text: `wersja ${version} · commit ${shortSha} · opublikowano ${publishedAt}`,
  };
}

/** Replaces every stable release token in a template with the already formatted footer text. */
export function renderReleaseInfo(template: string, metadata: ReleaseMetadata): string {
  return template.split(RELEASE_INFO_PLACEHOLDER).join(metadata.text);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
