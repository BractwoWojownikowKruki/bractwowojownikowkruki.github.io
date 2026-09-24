#!/usr/bin/env bash
# Secret Manager bills every non-destroyed version. Run this after a rotated secret has been
# deployed and verified: it destroys every version except what `latest` resolves to and any
# version a traffic-serving Cloud Run revision pins explicitly. Shows the plan and asks first.
#
#   upload-service/scripts/prune-secret-versions.sh              # all secrets
#   upload-service/scripts/prune-secret-versions.sh <secret>...  # only these
set -euo pipefail

PROJECT=krucze-galery-upload
REGION=europe-west1
SERVICE=krucze-galery-upload

SERVING=$(gcloud run services describe "$SERVICE" --region="$REGION" --project="$PROJECT" --format=json \
  | jq -r '.status.traffic[] | select(.percent > 0) | .revisionName')
[ -z "$SERVING" ] && { echo "No revision is serving traffic - refusing to prune." >&2; exit 1; }

# "secret version" pairs referenced by serving revisions, with "latest" resolved to a real version.
IN_USE=""
for rev in $SERVING; do
  while read -r name key; do
    [ -z "$name" ] && continue
    if [ "$key" = latest ]; then
      key=$(gcloud secrets versions describe latest --secret="$name" --project="$PROJECT" --format='value(name.basename())')
    fi
    IN_USE+="$name $key"$'\n'
  done < <(gcloud run revisions describe "$rev" --region="$REGION" --project="$PROJECT" --format=json \
    | jq -r '.spec.containers[].env[]? | .valueFrom.secretKeyRef // empty | "\(.name) \(.key)"')
done

SECRETS=("$@")
[ ${#SECRETS[@]} -eq 0 ] && SECRETS=($(gcloud secrets list --project="$PROJECT" --format='value(name)'))

PLAN=""
for s in "${SECRETS[@]}"; do
  latest=$(gcloud secrets versions describe latest --secret="$s" --project="$PROJECT" --format='value(name.basename())')
  for v in $(gcloud secrets versions list "$s" --project="$PROJECT" --filter='state!=destroyed' --format='value(name.basename())'); do
    [ "$v" = "$latest" ] && continue
    grep -qx "$s $v" <<<"$IN_USE" && { echo "keeping $s v$v (pinned by a serving revision)"; continue; }
    PLAN+="$s $v"$'\n'
  done
done

[ -z "$PLAN" ] && { echo "Nothing to prune."; exit 0; }
echo "Serving revision(s): $SERVING"
echo "Will DESTROY (irreversible):"; printf '%s' "$PLAN" | sed 's/ / v/; s/^/  /'
read -r -p "Proceed? [y/N] " answer
[ "$answer" = y ] || { echo "Aborted."; exit 1; }

while read -r s v; do
  [ -z "$s" ] && continue
  gcloud secrets versions destroy "$v" --secret="$s" --project="$PROJECT" --quiet >/dev/null
  echo "destroyed $s v$v"
done <<<"$PLAN"
