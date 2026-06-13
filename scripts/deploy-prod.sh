#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deploy-prod.sh [options]

Build and deploy the production GKE stack through Google Cloud Build.

Options:
  --project ID          GCP project ID. Default: vectant-proj
  --region REGION      Artifact Registry region. Default: europe-west10
  --cluster NAME       GKE cluster name. Default: synthi-beta-cluster
  --zone ZONE          GKE cluster zone/location. Default: europe-west10-a
  --registry REGISTRY  Artifact Registry repo. Default: <region>-docker.pkg.dev/<project>/synthi
  --tag TAG            Immutable image tag. Default: prod-<UTC timestamp>-<git sha>
  --branch BRANCH      Branch to push when --push is used. Default: main
  --push               Push HEAD to origin/<branch> before submitting Cloud Build
  --allow-dirty        Allow deploying a dirty local checkout
  -h, --help           Show this help

Environment:
  GCLOUD_BIN           gcloud executable path. Default: gcloud
  CLOUDSDK_CONFIG      Optional gcloud config directory

Examples:
  scripts/deploy-prod.sh
  scripts/deploy-prod.sh --push
  scripts/deploy-prod.sh --tag prod-20260611-a1b2c3d4
EOF
}

PROJECT_ID="vectant-proj"
REGION="europe-west10"
GKE_CLUSTER="synthi-beta-cluster"
GKE_ZONE="europe-west10-a"
REGISTRY=""
IMAGE_TAG=""
DEPLOY_BRANCH="main"
PUSH_FIRST="false"
ALLOW_DIRTY="false"
GCLOUD_BIN="${GCLOUD_BIN:-gcloud}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT_ID="${2:?--project requires a value}"
      shift 2
      ;;
    --region)
      REGION="${2:?--region requires a value}"
      shift 2
      ;;
    --cluster)
      GKE_CLUSTER="${2:?--cluster requires a value}"
      shift 2
      ;;
    --zone)
      GKE_ZONE="${2:?--zone requires a value}"
      shift 2
      ;;
    --registry)
      REGISTRY="${2:?--registry requires a value}"
      shift 2
      ;;
    --tag)
      IMAGE_TAG="${2:?--tag requires a value}"
      shift 2
      ;;
    --branch)
      DEPLOY_BRANCH="${2:?--branch requires a value}"
      shift 2
      ;;
    --push)
      PUSH_FIRST="true"
      shift
      ;;
    --allow-dirty)
      ALLOW_DIRTY="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  echo "git is required." >&2
  exit 1
fi

if ! command -v "$GCLOUD_BIN" >/dev/null 2>&1; then
  echo "gcloud is required. Set GCLOUD_BIN if it is not on PATH." >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if [[ -z "$REGISTRY" ]]; then
  REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/synthi"
fi

GIT_SHA="$(git rev-parse --short=12 HEAD)"
if [[ -z "$IMAGE_TAG" ]]; then
  IMAGE_TAG="prod-$(date -u +%Y%m%d%H%M%S)-${GIT_SHA}"
fi

if [[ ! "$IMAGE_TAG" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  echo "Invalid Docker tag: $IMAGE_TAG" >&2
  echo "Use only letters, digits, underscore, dot, and dash." >&2
  exit 1
fi

if [[ "$ALLOW_DIRTY" != "true" ]]; then
  if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
    echo "Refusing to deploy a dirty checkout." >&2
    echo "Commit/stash changes first, or pass --allow-dirty for an intentional local snapshot deploy." >&2
    git status --short | sed -n '1,40p' >&2
    exit 1
  fi
fi

if [[ "$PUSH_FIRST" == "true" ]]; then
  echo "Pushing HEAD to origin/${DEPLOY_BRANCH}..."
  git push origin "HEAD:${DEPLOY_BRANCH}"
fi

echo "Submitting Cloud Build production deploy..."
echo "  project:  ${PROJECT_ID}"
echo "  cluster:  ${GKE_CLUSTER}"
echo "  location: ${GKE_ZONE}"
echo "  registry: ${REGISTRY}"
echo "  tag:      ${IMAGE_TAG}"

"$GCLOUD_BIN" builds submit "$REPO_ROOT" \
  --project="$PROJECT_ID" \
  --config="$REPO_ROOT/cloudbuild.yaml" \
  --ignore-file="$REPO_ROOT/.gcloudignore" \
  --substitutions="_REGION=${REGION},_GKE_CLUSTER=${GKE_CLUSTER},_GKE_ZONE=${GKE_ZONE},_REGISTRY=${REGISTRY},_IMAGE_TAG=${IMAGE_TAG}"
