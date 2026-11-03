#!/usr/bin/env bash
# First setup of an upkeep server with its tokens kept in 1Password. Makes the
# server admin token, waits while you set it on the server, then adds your
# admin and each worker, saving every token as a new item, so none of them
# pass through the terminal or shell history. Run it again to pick up where it
# stopped: items that already exist are kept.
#
# Usage: setup-1password.sh <server URL> <admin name> [worker name...]
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <server URL> <admin name> [worker name...]" >&2
  exit 2
fi

for tool in op jq curl upkeep; do
  if ! command -v "$tool" > /dev/null; then
    echo "$tool isn't installed" >&2
    exit 1
  fi
done

server_item="Upkeep server admin token"
export UPKEEP_SERVER="${1%/}"
admin="$2"
shift 2

# Runs an upkeep command that prints a new token on its last line, and saves
# the token as a new item, unless the item is already there.
save() {
  local title="$1" output
  shift
  if op item get "$title" > /dev/null 2>&1; then
    echo "Kept $title, which is already saved"
    return
  fi
  output="$("$@")"
  jq -n --arg title "$title" --arg token "${output##*$'\n'}" '{
    title: $title,
    category: "API_CREDENTIAL",
    fields: [{ id: "credential", type: "CONCEALED", label: "credential", value: $token }]
  }' | op item create - > /dev/null
  echo "Saved $title"
}

if op item get "$server_item" > /dev/null 2>&1; then
  echo "Using the existing $server_item"
else
  op item create --category=password --title="$server_item" \
    --generate-password=letters,digits,48 > /dev/null
  echo "Saved $server_item"
fi

UPKEEP_ADMIN_TOKEN="$(op item get "$server_item" --fields password --reveal)"
export UPKEEP_ADMIN_TOKEN

if command -v wl-copy > /dev/null; then
  printf '%s' "$UPKEEP_ADMIN_TOKEN" | wl-copy
  echo "Copied it to the clipboard."
elif command -v pbcopy > /dev/null; then
  printf '%s' "$UPKEEP_ADMIN_TOKEN" | pbcopy
  echo "Copied it to the clipboard."
else
  echo "Copy it with: op item get \"$server_item\" --fields password --reveal"
fi

echo "Set it as the server's UPKEEP_SERVER_ADMIN_TOKEN, or the Home Assistant app's server_admin_token, and restart the server."
read -rp "Press Enter once it's running. "

until curl -fsS "$UPKEEP_SERVER/api/health" > /dev/null 2>&1; do
  echo "Waiting for $UPKEEP_SERVER..."
  sleep 5
done

save "Upkeep admin token - $admin" upkeep admins add "$admin"
for worker in "$@"; do
  save "Upkeep worker token - $worker" upkeep workers add "$worker"
done

echo "Done. Read a token with: op item get \"<title>\" --fields credential --reveal"
echo "Your own admin works now, so you can clear the server admin token."
