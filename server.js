/**
 * server.js — Lead Profiler unified server
 * Sirve el frontend React Y el endpoint de sincronización.
 *
 * Desarrollo: node server.js               → puerto 3001
 * Producción: NODE_ENV=production node server.js → sirve dist/ en PORT
 *
 * Variables de entorno:
 *   PORT        Puerto (Railway lo inyecta automáticamente)
 *   SYNC_TOKEN  Token secreto para proteger /sync (generalo con: openssl rand -hex 16)
 *   DATA_DIR    Directorio para guardar leads-live.json (default: ./public en dev, /data en prod)
 */

import express from 'express'
import cors from 'cors'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const IS_PROD    = process.env.NODE_ENV === 'production'
const PORT       = process.env.PORT || 3001
const SYNC_TOKEN = process.env.SYNC_TOKEN || 'dev-token-inseguro'

// En prod Railway puede montar un volumen en /data; fallback a dist/
const DATA_DIR   = process.env.DATA_DIR || (IS_PROD ? '/data' : resolve(__dirname, 'public'))
const LIVE_FILE  = resolve(DATA_DIR, 'leads-live.json')

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

const app = express()

// CORS: en dev abierto; en prod solo la misma URL
app.use(cors({
  origin: IS_PROD ? process.env.APP_URL || true : '*',
  methods: ['GET', 'POST'],
}))
app.use(express.json({ limit: '50mb' }))

// ─── API routes ────────────────────────────────────────────────────────────

// GET /api/status
app.get('/api/status', (req, res) => {
  const data = existsSync(LIVE_FILE)
    ? JSON.parse(readFileSync(LIVE_FILE, 'utf-8'))
    : null
  res.json({
    ok: true,
    syncedAt:    data?.syncedAt ?? null,
    sources:     data?.sources ?? [],
    totalMerged: data?.totalMerged ?? 0,
  })
})

// GET /api/leads — devuelve los leads para el frontend
app.get('/api/leads', (req, res) => {
  if (!existsSync(LIVE_FILE)) return res.json(null)
  res.json(JSON.parse(readFileSync(LIVE_FILE, 'utf-8')))
})

// POST /api/sync?token=SYNC_TOKEN — recibe leads de los bookmarklets
app.post('/api/sync', (req, res) => {
  // Validar token
  const token = req.query.token || req.headers['x-sync-token']
  if (token !== SYNC_TOKEN) {
    return res.status(401).json({ error: 'Token inválido' })
  }

  const { account, leads } = req.body
  if (!account || !Array.isArray(leads)) {
    return res.status(400).json({ error: 'Se requieren account y leads[]' })
  }

  console.log(`[sync] ${account}: ${leads.length} leads recibidos`)

  const existing = existsSync(LIVE_FILE)
    ? JSON.parse(readFileSync(LIVE_FILE, 'utf-8'))
    : { leads: [], sources: [] }

  const otherLeads = (existing.leads || []).filter(l => l._lnm?.account !== account)
  const merged = mergeLeads([...otherLeads, ...leads])
  const sources = [...new Set([...(existing.sources || []).filter(s => s !== account), account])]

  const output = {
    syncedAt:    new Date().toISOString(),
    sources,
    totalMerged: merged.length,
    leads:       merged,
  }

  writeFileSync(LIVE_FILE, JSON.stringify(output, null, 2))
  console.log(`[sync] ✅ Total: ${merged.length} leads de [${sources.join(', ')}]`)
  res.json({ ok: true, total: merged.length, sources })
})

// ─── Merge con deduplicación por teléfono ─────────────────────────────────
function mergeLeads(allLeads) {
  const seen = new Set()
  const merged = []
  const sorted = [...allLeads].sort((a, b) => (b._lnm?.score ?? 0) - (a._lnm?.score ?? 0))
  for (const lead of sorted) {
    const phone = lead.phone?.replace(/\D/g, '')
    if (phone && phone.length > 6) {
      if (seen.has(phone)) continue
      seen.add(phone)
    }
    merged.push(lead)
  }
  return merged
}

// ─── Servir frontend estático (producción) ─────────────────────────────────
if (IS_PROD) {
  const distDir = resolve(__dirname, 'dist')
  const { createRequire } = await import('module')
  const { default: serveStatic } = await import('serve-static')
  app.use(serveStatic(distDir))
  // SPA fallback
  app.get('*', (req, res) => {
    res.sendFile(resolve(distDir, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`\n✅ Lead Profiler ${IS_PROD ? 'PROD' : 'DEV'} → http://localhost:${PORT}`)
  if (!IS_PROD) {
    console.log(`   Frontend: http://localhost:5173  (npm run dev)`)
  }
  console.log(`   Sync token: ${SYNC_TOKEN === 'dev-token-inseguro' ? '⚠️  default (configurá SYNC_TOKEN en .env)' : '✅ configurado'}`)
  console.log(`   Datos: ${LIVE_FILE}\n`)
})
