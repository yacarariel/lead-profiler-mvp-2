#!/bin/bash
# launch-chrome.sh — Lanza Chrome con depuración remota habilitada.
# Ejecutá esto UNA VEZ para reemplazar tu Chrome normal.
# El puerto 9222 permite que el cron se conecte sin conflictos de perfil.

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [ ! -f "$CHROME" ]; then
  echo "❌ Chrome no encontrado en $CHROME"
  exit 1
fi

# Cerrar Chrome si está corriendo
osascript -e 'quit app "Google Chrome"' 2>/dev/null
sleep 1

echo "🚀 Abriendo Chrome con remote debugging en puerto 9222..."
"$CHROME" \
  --remote-debugging-port=9222 \
  --remote-allow-origins='*' \
  &

echo "✅ Chrome listo. Podés usarlo normalmente."
echo "   El cron de Lead Profiler se conectará automáticamente."
