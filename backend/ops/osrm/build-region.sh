#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${1:-${ROOT_DIR}/data/osrm}"
REGION_NAME="${2:-region}"
TMP_DIR="${OUT_DIR}/tmp"
PBF_OUT="${OUT_DIR}/${REGION_NAME}.osm.pbf"
OSRM_PREFIX="${OUT_DIR}/${REGION_NAME}.osrm"
OSRM_IMAGE="ghcr.io/project-osrm/osrm-backend:v5.27.1"
DOCKER_USE_SUDO="${DOCKER_USE_SUDO:-0}"

mkdir -p "${OUT_DIR}" "${TMP_DIR}"

if ! command -v osmium >/dev/null 2>&1; then
  echo "ERROR: osmium is required (brew install osmium-tool or apt install osmium-tool)." >&2
  exit 1
fi

fetch_region() {
  local region="$1"
  local out_file="$2"
  local url="https://download.geofabrik.de/north-america/us/${region}-latest.osm.pbf"
  if [[ -s "${out_file}" ]]; then
    echo "Using cached ${region} extract: ${out_file}"
    return 0
  fi
  echo "Downloading ${region} from ${url} ..."
  curl -fsSL "${url}" -o "${out_file}"
}

fetch_region "arkansas" "${TMP_DIR}/arkansas.osm.pbf"
fetch_region "missouri" "${TMP_DIR}/missouri.osm.pbf"
fetch_region "oklahoma" "${TMP_DIR}/oklahoma.osm.pbf"

if [[ ! -s "${PBF_OUT}" ]]; then
  echo "Merging AR+MO+OK extract -> ${PBF_OUT} ..."
  osmium merge \
    "${TMP_DIR}/arkansas.osm.pbf" \
    "${TMP_DIR}/missouri.osm.pbf" \
    "${TMP_DIR}/oklahoma.osm.pbf" \
    -o "${PBF_OUT}" --overwrite
else
  echo "Using cached merged extract: ${PBF_OUT}"
fi

echo "Building OSRM graph with ${OSRM_IMAGE} ..."
if [[ "${DOCKER_USE_SUDO}" == "1" ]]; then
  DOCKER_CMD=(sudo docker)
else
  DOCKER_CMD=(docker)
fi

if [[ ! -s "${OSRM_PREFIX}" ]]; then
  "${DOCKER_CMD[@]}" run --rm -t -v "${OUT_DIR}:/data" "${OSRM_IMAGE}" \
    osrm-extract -p /opt/car.lua "/data/${REGION_NAME}.osm.pbf"
else
  echo "Using cached extracted graph: ${OSRM_PREFIX}"
fi

if [[ ! -s "${OSRM_PREFIX}.partition" || ! -s "${OSRM_PREFIX}.cells" ]]; then
  "${DOCKER_CMD[@]}" run --rm -t -v "${OUT_DIR}:/data" "${OSRM_IMAGE}" \
    osrm-partition "/data/${REGION_NAME}.osrm"
else
  echo "Using cached partition files."
fi

if [[ ! -s "${OSRM_PREFIX}.mldgr" || ! -s "${OSRM_PREFIX}.datasource_names" ]]; then
  "${DOCKER_CMD[@]}" run --rm -t -v "${OUT_DIR}:/data" "${OSRM_IMAGE}" \
    osrm-customize "/data/${REGION_NAME}.osrm"
else
  echo "Using cached customize files."
fi

echo "Done. OSRM dataset ready at ${OSRM_PREFIX}*"
