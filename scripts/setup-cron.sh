#!/bin/bash
# setup-cron.sh — Configura el cron de sincronización automática en macOS
#
# Uso: bash scripts/setup-cron.sh [horas]
#   horas: cada cuántas horas sincronizar (default: 4)
#
# Para remover: bash scripts/setup-cron.sh remove

set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(which node 2>/dev/null || echo '/opt/homebrew/bin/node')"
SYNC_SCRIPT="$PROJECT_DIR/scripts/sync-all.js"
LOG_FILE="$PROJECT_DIR/logs/sync.log"
PLIST_NAME="com.leadprofiler.sync"
PLIST_FILE="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

HOURS="${1:-4}"

# ─── Remover ──────────────────────────────────────────────────────────────────
if [ "$1" = "remove" ]; then
  launchctl unload "$PLIST_FILE" 2>/dev/null || true
  rm -f "$PLIST_FILE"
  echo "✅ Cron removido"
  exit 0
fi

# ─── Setup ────────────────────────────────────────────────────────────────────

mkdir -p "$PROJECT_DIR/logs"
INTERVAL_SECONDS=$((HOURS * 3600))

echo "📋 Configurando cron de sincronización..."
echo "   Proyecto: $PROJECT_DIR"
echo "   Node:     $NODE_BIN"
echo "   Intervalo: cada $HOURS horas"
echo "   Log: $LOG_FILE"
echo ""

# Verificar que node existe
if [ ! -f "$NODE_BIN" ]; then
  echo "❌ Node.js no encontrado en: $NODE_BIN"
  echo "   Instalá Node con: brew install node"
  exit 1
fi

# Crear launchd plist (más confiable que crontab en macOS)
cat > "$PLIST_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_NAME</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$SYNC_SCRIPT</string>
  </array>

  <key>StartInterval</key>
  <integer>$INTERVAL_SECONDS</integer>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>

  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>

  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

# Cargar el agente
launchctl unload "$PLIST_FILE" 2>/dev/null || true
launchctl load -w "$PLIST_FILE"

echo "✅ Cron configurado exitosamente"
echo ""
echo "   Primera sincronización: ahora mismo (RunAtLoad = true)"
echo "   Próximas: cada $HOURS horas"
echo "   Logs: tail -f $LOG_FILE"
echo ""
echo "   Para remover: bash scripts/setup-cron.sh remove"
echo "   Para cambiar intervalo: bash scripts/setup-cron.sh [horas]"
