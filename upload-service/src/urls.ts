// Mirrors scripts/utils.ts's extractDriveFolderId - kept as a small local copy rather than a
// cross-package import since upload-service and the root scripts are separate deployables.
export function extractDriveFolderId(url: string): string | null {
  const m = url.match(/^https:\/\/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}
