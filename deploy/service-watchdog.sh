#!/usr/bin/env bash
# Read-only health watcher for this box's systemd services. Never restarts
# anything (bedrock-server already has its own force-restart watchdog --
# this one is purely a notifier, so the two can't fight over remediation).
#
# "Active" alone isn't enough to call a service healthy -- a unit can be
# active while restart-looping in the background, or active with nothing
# actually bound to its port. So each unit is checked two ways: is its port
# really listening (skipped for port-less oneshot units, which are checked
# via is-failed instead), and has NRestarts grown since the last run. Only
# state *transitions* page Telegram -- newly broken, or newly recovered --
# so a service stuck down doesn't re-alert every 5 minutes.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"
STATE_DIR="${HOME}/.cache/ideavault-watchdog"
STATE_FILE="${STATE_DIR}/state"
mkdir -p "${STATE_DIR}"

# unit:protocol:port -- protocol/port blank for port-less oneshot units,
# checked via is-failed instead of a port probe. Loaded from services.json
# rather than hardcoded here, since src/opsControl.ts reads the same file to
# know which units a Telegram "/fix <unit>" reply is allowed to restart --
# one list gating a real privileged action beats two hand-kept copies.
mapfile -t SERVICES < <(jq -r '.services[] | "\(.unit):\(.proto):\(.port)"' "${SCRIPT_DIR}/services.json")

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
    echo "watchdog: NOTIFY_TELEGRAM_BOT_TOKEN/NOTIFY_TELEGRAM_CHAT_ID not set in .env, would have sent: ${text}" >&2
    return 0
  fi
  curl -fsS --max-time 10 "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=$(hostname): ${text}" \
    >/dev/null || echo "watchdog: failed to notify Telegram" >&2
}

port_listening() {
  local proto="$1" port="$2"
  if [[ "${proto}" == "udp" ]]; then
    ss -H -lun "sport = :${port}" 2>/dev/null | grep -q .
  else
    ss -H -ltn "sport = :${port}" 2>/dev/null | grep -q .
  fi
}

# Absolute path required: this script's PATH under systemd doesn't include
# ~/.local/bin where the claude CLI actually lives.
CLAUDE_BIN="/home/mephisto/.local/bin/claude"

# Best-effort LLM diagnosis of a newly-broken unit, for the alert message.
# --tools "" gives this zero write/exec capability of its own -- it can only
# produce a (possibly wrong) string, never take action itself; the only path
# to an actual restart is a human replying /fix <unit> in the ops chat,
# handled separately by src/opsControl.ts. Always returns 0 and always
# prints something, even on failure/timeout: this runs under set -e, so an
# unguarded failure here would otherwise abort every service check after it.
diagnose() {
  local unit="$1" status_out journal_out prompt
  status_out="$(systemctl status "${unit}" --no-pager -l 2>&1 | head -20)"
  journal_out="$(journalctl -u "${unit}" -n 50 --no-pager 2>&1 | head -c 6000)"
  prompt="You are a terse on-call SRE assistant looking at one systemd service on a personal homelab box. In 4 lines or fewer, plain text (no markdown, this goes straight into a Telegram message): (1) most likely root cause, (2) one concrete suggested fix. If the evidence doesn't point anywhere obvious, say so rather than guessing.

Unit: ${unit}

--- systemctl status ---
${status_out}

--- journalctl -n 50 ---
${journal_out}"

  if [[ ! -x "${CLAUDE_BIN}" ]]; then
    echo "(diagnosis unavailable: claude CLI not found at ${CLAUDE_BIN})"
    return 0
  fi
  timeout 45 "${CLAUDE_BIN}" -p "${prompt}" --tools "" --output-format text --no-session-persistence 2>/dev/null \
    || echo "(diagnosis unavailable: claude -p failed or timed out)"
}

prev_state_for() {
  local unit="$1" line
  line="$(grep -F "${unit}|" "${STATE_FILE}" 2>/dev/null | tail -1)" || true
  printf '%s' "${line}"
}

new_state_lines=""

for entry in "${SERVICES[@]}"; do
  IFS=: read -r unit proto port <<<"${entry}"

  nrestarts="$(systemctl show -p NRestarts --value "${unit}" 2>/dev/null || echo 0)"
  [[ "${nrestarts}" =~ ^[0-9]+$ ]] || nrestarts=0

  if [[ -n "${port}" ]]; then
    if systemctl is-active --quiet "${unit}" && port_listening "${proto}" "${port}"; then
      up=1
    else
      up=0
    fi
  else
    if [[ "$(systemctl is-failed "${unit}" 2>/dev/null || true)" == "failed" ]]; then
      up=0
    else
      up=1
    fi
  fi

  prev_line="$(prev_state_for "${unit}")"
  if [[ -n "${prev_line}" ]]; then
    IFS='|' read -r _ prev_up prev_nrestarts prev_alerted <<<"${prev_line}"
  else
    # First run: establish a baseline instead of alerting on pre-existing
    # restart counts we have no history for.
    prev_up=1
    prev_nrestarts="${nrestarts}"
    prev_alerted=0
  fi

  flapped=0
  if (( nrestarts > prev_nrestarts )); then flapped=1; fi
  problem=0
  if (( up == 0 || flapped == 1 )); then problem=1; fi

  alerted="${prev_alerted}"
  if (( problem == 1 && prev_alerted == 0 )); then
    diagnosis=""
    if [[ -n "${BOT_TOKEN}" && -n "${CHAT_ID}" ]]; then
      diagnosis="$(diagnose "${unit}")"
    fi
    if (( up == 0 )); then
      notify "❌ ${unit} is down

${diagnosis}

Reply /fix ${unit} to restart it."
    else
      notify "⚠️ ${unit} restarted $(( nrestarts - prev_nrestarts )) time(s) since last check (currently up)

${diagnosis}

Reply /fix ${unit} to restart it."
    fi
    alerted=1
  elif (( problem == 0 && prev_alerted == 1 )); then
    notify "✅ ${unit} recovered"
    alerted=0
  fi

  new_state_lines+="${unit}|${up}|${nrestarts}|${alerted}"$'\n'
done

printf '%s' "${new_state_lines}" > "${STATE_FILE}"
