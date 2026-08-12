#!/usr/bin/env bash
# Checks Mojang's official download API for a newer Bedrock Dedicated Server
# release than the one bedrock-server.service is currently running. Never
# applies anything -- migrate-bedrock-server.sh has never run against a real
# update yet, so this stays notify-only until that's been watched work once.
# On finding a new version it downloads the zip to ~/Downloads and sends the
# exact migrate-bedrock-server.sh command to run, via the same ops Telegram
# channel as service-watchdog.sh. Only notifies once per new version (a state
# file tracks the last version already alerted on), not on every run while
# it's sitting unapplied.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
STATE_FILE="${HOME}/.cache/ideavault-watchdog/bedrock-last-notified-version"
DOWNLOAD_DIR="${HOME}/Downloads"
LINKS_API="https://net-secondary.web.minecraft-services.net/api/v1.0/download/links"
BROWSER_UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

mkdir -p "$(dirname "${STATE_FILE}")" "${DOWNLOAD_DIR}"

env_value() {
  local val
  val="$(grep -E "^${1}=" "${ENV_FILE}" 2>/dev/null | tail -1 | cut -d= -f2-)" || true
  printf '%s' "${val}"
}

BOT_TOKEN="$(env_value NOTIFY_TELEGRAM_BOT_TOKEN)"
CHAT_ID="$(env_value NOTIFY_TELEGRAM_CHAT_ID)"

notify() {
  local text="$1"
  if [[ -z "${BOT_TOKEN}" || -z "${CHAT_ID}" ]]; then
    echo "bedrock-update-check: NOTIFY_TELEGRAM_BOT_TOKEN/NOTIFY_TELEGRAM_CHAT_ID not set, would have sent:" >&2
    echo "${text}" >&2
    return 0
  fi
  curl -fsS --max-time 10 "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=${text}" \
    >/dev/null || echo "bedrock-update-check: failed to notify Telegram" >&2
}

current_workdir="$(systemctl show -p WorkingDirectory --value bedrock-server.service 2>/dev/null || true)"
if [[ -z "${current_workdir}" ]]; then
  echo "bedrock-update-check: could not read bedrock-server.service WorkingDirectory, skipping" >&2
  exit 0
fi
current_version="$(basename "${current_workdir}" | sed -n 's/^bedrock-server-//p')"
if [[ -z "${current_version}" ]]; then
  echo "bedrock-update-check: could not parse a version out of '${current_workdir}', skipping" >&2
  exit 0
fi

links_json="$(curl -fsS --max-time 20 -H "User-Agent: ${BROWSER_UA}" "${LINKS_API}")" || {
  echo "bedrock-update-check: failed to reach Mojang's download API" >&2
  exit 0
}
download_url="$(jq -r '.result.links[] | select(.downloadType=="serverBedrockLinux") | .downloadUrl' <<<"${links_json}")"
if [[ -z "${download_url}" || "${download_url}" == "null" ]]; then
  echo "bedrock-update-check: serverBedrockLinux entry not found in API response, skipping" >&2
  exit 0
fi
latest_version="$(basename "${download_url}" .zip | sed -n 's/^bedrock-server-//p')"
if [[ -z "${latest_version}" ]]; then
  echo "bedrock-update-check: could not parse a version out of '${download_url}', skipping" >&2
  exit 0
fi

highest="$(printf '%s\n%s\n' "${current_version}" "${latest_version}" | sort -V | tail -1)"
if [[ "${highest}" == "${current_version}" ]]; then
  echo "bedrock-update-check: up to date (running ${current_version}, latest ${latest_version})"
  exit 0
fi

already_notified="$(cat "${STATE_FILE}" 2>/dev/null || true)"
if [[ "${already_notified}" == "${latest_version}" ]]; then
  echo "bedrock-update-check: ${latest_version} available but already notified, skipping"
  exit 0
fi

echo "bedrock-update-check: new version ${latest_version} available (currently running ${current_version}), downloading..."
zip_path="${DOWNLOAD_DIR}/bedrock-server-${latest_version}.zip"
if curl -fsS --max-time 1800 -H "User-Agent: ${BROWSER_UA}" -H "Cookie: eula=true" -o "${zip_path}" "${download_url}"; then
  notify="🎮 New Bedrock server version available: ${latest_version} (currently running ${current_version})

Downloaded to ${zip_path}. To apply:

migrate-bedrock-server.sh \\
  ${current_workdir} \\
  ${zip_path} \\
  ${HOME}/bedrock-server-${latest_version}"
  notify "${notify}"
  printf '%s' "${latest_version}" > "${STATE_FILE}"
else
  notify "🎮 New Bedrock server version detected: ${latest_version} (currently running ${current_version}), but the download failed. Check bedrock-update-check.sh manually."
fi
