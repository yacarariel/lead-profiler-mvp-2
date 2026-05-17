# Lead Profiler MVP 🏠

Herramienta de análisis y scoring de leads inmobiliarios. Importa conversaciones, calcula un score 0-100 y te dice en qué leads enfocarte primero.

## Inicio rápido

```bash
cd lead-profiler-mvp
npm install
npm run dev
```

Abre http://localhost:5173

---

## Algoritmo de Scoring

El score total es de **0 a 100 puntos**, calculado de 5 dimensiones:

| Dimensión    | Peso | Criterio                                                       |
|--------------|------|----------------------------------------------------------------|
| Presupuesto  | 25   | ≥$300k=25 / ≥$200k=20 / ≥$100k=15 / >$0=10 / sin dato=5     |
| Urgencia     | 25   | Inmediato=25 / Semana=22 / Mes=17 / Trimestre=12 / Semestre=7 |
| Objeciones   | 20   | Ninguna=20 / 1=14 / 2=9 / 3+=4                                |
| Compromiso   | 20   | Visita agendada=20 / Pide propuesta=17 / Consulta esp.=13     |
| Recencia     | 10   | Hoy=10 / 1-2 días=8 / 1 semana=6 / 2 semanas=4               |

### Categorías

- 🔴 **HOT** (≥70): Llamar en las próximas 2 horas
- 🟡 **WARM** (40-69): Seguimiento en 48hs
- 🔵 **COLD** (<40): Newsletter + re-contacto en 30 días

---

## Importar datos

### Formato JSON

```json
[
  {
    "id": "lead-001",
    "name": "Nombre Apellido",
    "phone": "+54 9 11 1234-5678",
    "source": "WhatsApp",
    "propertyInterest": "Departamento 3 ambientes en Palermo",
    "zone": "Palermo, CABA",
    "budget": 280000,
    "urgency": "semana",
    "engagement": "visita_agendada",
    "objections": ["espera crédito"],
    "lastContact": "2026-05-17",
    "notes": "Notas adicionales"
  }
]
```

**Valores válidos:**

`urgency`: `inmediato` | `semana` | `mes` | `trimestre` | `semestre` | `sin_definir`

`engagement`: `visita_agendada` | `reunion_agendada` | `solicita_propuesta` | `consulta_especifica` | `consulta_general` | `solo_curiosidad`

### Formato CSV

```csv
id,name,phone,source,propertyInterest,zone,budget,urgency,engagement,objections,lastContact,notes
lead-001,Juan Pérez,+54911...,WhatsApp,Depto 2 amb,Palermo,200000,mes,solicita_propuesta,precio alto,2026-05-17,Notas
```

> Las objeciones en CSV se separan con `;` dentro del campo.

---

## Scraper de Leadnamics (Puppeteer)

### Instalación

```bash
npm install puppeteer-extra puppeteer-extra-plugin-stealth minimist
```

### Uso

```bash
# Con usuario y contraseña
node scripts/scrape-leadnamics.js --email tu@email.com --pass tuPassword

# Guardar cookies para la próxima vez
node scripts/scrape-leadnamics.js --email tu@email.com --pass tuPassword --save-cookies cookies.json

# Reutilizar sesión guardada
node scripts/scrape-leadnamics.js --cookies cookies.json

# Limitar a N conversaciones (para testing)
node scripts/scrape-leadnamics.js --cookies cookies.json --limit 20

# Ver el navegador (modo no-headless, útil para debug)
node scripts/scrape-leadnamics.js --cookies cookies.json --headless false
```

El script genera un archivo `leads-leadnamics-YYYY-MM-DD.json` que podés importar directamente en la app.

> ⚠️ **Nota**: El scraper usa heurísticas de NLP básico para detectar urgencia, presupuesto y objeciones. Si el DOM de Leadnamics cambia, puede necesitar ajuste de selectores. Si el script no encuentra conversaciones, guarda un `debug-screenshot.png` para diagnosticar.

---

## Estructura del proyecto

```
lead-profiler-mvp/
├── src/
│   ├── App.jsx          # Componente principal + scoring engine
│   ├── main.jsx         # Entry point
│   ├── index.css        # Tailwind + estilos globales
│   └── data/
│       └── leads.json   # Leads de ejemplo (17 leads)
├── scripts/
│   └── scrape-leadnamics.js  # Scraper Puppeteer
├── index.html
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
└── package.json
```

---

## Scripts disponibles

| Comando         | Descripción                        |
|-----------------|------------------------------------|
| `npm run dev`   | Servidor de desarrollo (localhost:5173) |
| `npm run build` | Build de producción en `/dist`     |
| `npm run preview` | Preview del build de producción  |
