#!/bin/zsh

set -u

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="${HOME}/Desktop"
LAUNCHER_PATH="${DESKTOP_DIR}/启动本地监听.command"

pause_before_exit() {
  echo
  echo "Press Enter to close this window."
  read -r _
}

echo "Installing MasterGo2HTML desktop launcher..."
echo "Project: $PROJECT_DIR"
echo

if [ ! -d "$DESKTOP_DIR" ]; then
  echo "Desktop directory was not found: $DESKTOP_DIR"
  pause_before_exit
  exit 1
fi

cat > "$LAUNCHER_PATH" <<EOF
#!/bin/zsh

set -u

PROJECT_DIR="$PROJECT_DIR"

pause_before_exit() {
  echo
  echo "Press Enter to close this window."
  read -r _
}

echo "Starting MasterGo2HTML local MCP service..."
echo "Project: \$PROJECT_DIR"
echo

cd "\$PROJECT_DIR" || {
  echo "Failed to enter project directory: \$PROJECT_DIR"
  pause_before_exit
  exit 1
}

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. Please install Node.js first, then run this file again."
  pause_before_exit
  exit 1
fi

echo "Running: npm run mcp:dev"
echo

npm run mcp:dev

status=\$?
echo
echo "MCP service stopped with exit code \$status."
pause_before_exit
exit "\$status"
EOF

chmod +x "$LAUNCHER_PATH"

echo "Desktop launcher installed:"
echo "$LAUNCHER_PATH"
echo
echo "You can now double-click it to start the local MCP listener."
pause_before_exit
