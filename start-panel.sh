#!/bin/bash
# ServerBrowser Live Panel Launcher
# Starts the control panel with 0.0.0.0 binding and displays
# the UI URL and authentication token in color.

cd /projects/ServerBrowser2

echo ""
echo "\033[96m╔══════════════════════════════════════════════════════════════════\033[0m"
echo "\033[96m║\033[1m\033[95m  SERVERBROWSER LIVE SESSION MANAGER\033[0m\033[96m                                                  \033[0m"
echo "\033[96m║\033[92m  Live VNC + Chrome Browser Access                              \033[96m║\033[0m"
echo "\033[96m╠══════════════════════════════════════════════════════════════════\033[0m"

# Start panel server with 0.0.0.0 binding
PANEL_ADDR=0.0.0.0 PANEL_NO_AUTH=1 node control/panel-server.js &
PANEL_PID=$!

# Wait for server to start
for i in $(seq 1 20); do
  if curl -s http://127.0.0.1:6180/api/health > /dev/null 2>&1; then
    echo -e "\033[92m✓ Panel server is ready!\033[0m"
    break
  fi
  sleep 1
done

# Get the authentication token
TOKEN=$(cat datastore/panel-state.json 2>/dev/null | grep -o '"token": "[^"]*"' | cut -d'"' -f4 | head -1)

if [ -z "$TOKEN" ]; then
  TOKEN=$(openssl rand -hex 24)
echo "{\"token\": \"$TOKEN\"}" > datastore/panel-state.json
  chmod 600 datastore/panel-state.json
fi

# Display UI with colors
echo ""
echo -e "\033[96m║\033[1m\033[95m  LIVE SESSION ACCESS\033[0m\033[96m                                                  \033[0m"
echo -e "\033[96m╠══════════════════════════════════════════════════════════════════\033[0m"

echo -e "\033[96m║\033[0m\033[92m  ↳\033[0m\033[94m\033[1m http://127.0.0.1:6180/\033[0m\033[96m                                              \033[0m"
echo -e "\033[96m║\033[0m\033[92m  Token: \033[1m\033[96m$TOKEN\033[0m\033[92m                                                  \033[0m"
echo -e "\033[96m║\033[0m\033[92m  ↳\033[0m\033[94m\033[1m Open the URL in your browser\033[0m\033[92m (\033[0m\033[3mhttp://127.0.0.1:6180/\033[0m\033[92m)\033[0m\033[96m              \033[0m"
echo -e "\033[96m║\033[0m\033[92m  ↳\033[0m\033[94m\033[1m OR use HTTP Basic Auth\033[0m\033[92m                                                  \033[0m"
echo -e "\033[96m║\033[0m\033[92m  \033[3m   Username:\033[0m\033[93m any\033[0m\033[92m                                              \033[0m"
echo -e "\033[96m║\033[0m\033[92m  \033[3m   Password:\033[0m\033[96m $TOKEN\033[0m\033[92m                                              \033[0m"
echo -e "\033[96m╠══════════════════════════════════════════════════════════════════\033[0m"
echo -e "\033[96m║\033[0m\033[92m  ↳\033[0m\033[94m\033[1m Viewer URLs with built-in auth\033[0m\033[92m                                    \033[0m"
echo "\033[96m╠══════════════════════════════════════════════════════════════════\033[0m"
echo -e "\033[96m║\033[0m\033[92m  ↳\033[0m\033[94m http://127.0.0.1:6080/novnc/vnc.html?pw=$TOKEN\033[0m\033[92m          \033[0m"
echo -e "\033[96m║\033[0m\033[92m  ↳\033[0m\033[94m http://127.0.0.1:6080/?pw=$TOKEN\033[0m\033[92m                           \033[0m"
echo -e "\033[96m╠══════════════════════════════════════════════════════════════════\033[0m"
echo -e "\033[96m║\033[0m\033[92m  ↳\033[0m\033[94m API Endpoints\033[0m\033[92m                                         \033[0m"
echo "\033[96m╠══════════════════════════════════════════════════════════════════\033[0m"
echo -e "\033[96m║\033[0m\033[92m  ↳\033[0m\033[94m  Health:\033[0m\033[94m http://127.0.0.1:6180/api/health\033[0m\033[92m                          \033[0m"
echo -e "\033[96m║\033[0m\033[92m  ↳\033[0m\033[94m  Sessions:\033[0m\033[94m http://127.0.0.1:6180/api/sessions\033[0m\033[92m                             \033[0m"
echo -e "\033[96m║\033[0m\033[92m  ↳\033[0m\033[94m  Viewer URL:\033[0m\033[94m http://127.0.0.1:6180/api/sessions/:name/viewer-url\033[0m\033[92m ║\033[0m"
echo -e "\033[96m╚══════════════════════════════════════════════════════════════════\033[0m"
echo -e "\033[92m\033[1m  ℹ Share the viewer URL above with end-users.\033[0m\033[96m                              \033[0m"
echo -e "\033[92m\033[1m  ℹ The ?pw= token is already embedded in the URL for automatic auth.\033[0m\033[96m   \033[0m"
echo -e "\033[92m\033[1m  ℹ PANEL_NO_AUTH=1 disables auth for local development only.\033[0m\033[96m       \033[0m"
echo ""
echo -e "\033[92mPanel is running in the background (PID: $PANEL_PID).\033[0m\033[96m Press Ctrl-C to stop, or the panel runs independently.\033[0m"
echo ""
