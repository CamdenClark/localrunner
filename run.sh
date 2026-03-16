#!/bin/bash
set -e

PORT=9637
RUNNER_DIR="$(cd "$(dirname "$0")/runner" && pwd)"

# Generate .runner config
RUNNER_CONFIG=$(cat <<EOF
{
  "AgentId": 1,
  "AgentName": "local-runner",
  "PoolId": 1,
  "PoolName": "default",
  "ServerUrl": "http://localhost:${PORT}",
  "ServerUrlV2": "http://localhost:${PORT}",
  "GitHubUrl": "http://localhost:${PORT}",
  "UseV2Flow": true,
  "WorkFolder": "_work",
  "Ephemeral": true,
  "DisableUpdate": true
}
EOF
)

CREDS_CONFIG=$(cat <<EOF
{
  "Scheme": "OAuthAccessToken",
  "Data": {
    "token": "local-token"
  }
}
EOF
)

# Build jitconfig: base64(JSON({filename: base64(content), ...}))
RUNNER_B64=$(echo -n "$RUNNER_CONFIG" | base64)
CREDS_B64=$(echo -n "$CREDS_CONFIG" | base64)

JITCONFIG=$(echo -n "{
  \".runner\": \"${RUNNER_B64}\",
  \".credentials\": \"${CREDS_B64}\"
}" | base64)

echo "=== Local GitHub Actions Runner ==="
echo "Starting mock server..."

# Start the server in background
bun run server.ts &
SERVER_PID=$!

# Wait for server to be ready
sleep 1

echo "Starting runner with jitconfig..."
echo ""

# Force GHES mode to skip hosted-only checks
export GITHUB_ACTIONS_RUNNER_FORCE_GHES=1
export RUNNER_ALLOW_RUNASROOT=1

cd "$RUNNER_DIR"
./run.sh --jitconfig "$JITCONFIG" 2>&1 || true

echo ""
echo "Runner exited. Stopping server..."
kill $SERVER_PID 2>/dev/null || true
