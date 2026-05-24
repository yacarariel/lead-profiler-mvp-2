/**
 * server.js — Lead Profiler unified server
 *
 * Desarrollo: node server.js               → puerto 3001
 * Producción: NODE_ENV=production node server.js → sirve dist/ en PORT
 *
 * Variables de entorno:
 *   PORT        Puerto (Railway lo inyecta automáticamente)
 *   SYNC_TOKEN  Token para proteger /sync del bookmarklet
 *   SECRET_KEY  Clave para hashear contraseñas
 *   DATA_DIR    Directorio de datos (default: ./public en dev, /data en prod)
 */

import express from 'express'
import cors from 'cors'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createHmac, randomBytes } from 'crypto'

const __dirname  = dirname(fileURLToPath(import.meta.url))
const IS_PROD    = process.env.NODE_ENV === 'production'
const PORT       = process.env.PORT || 3001
const SYNC_TOKEN = process.env.SYNC_TOKEN || 'dev-token-inseguro'
const SECRET_KEY = process.env.SECRET_KEY || 'lp-secret-dev-2026'

const DATA_DIR      = process.env.DATA_DIR || (IS_PROD ? '/data' : resolve(__dirname, 'public'))
const LIVE_FILE     = resolve(DATA_DIR, 'leads-live.json')
const USERS_FILE    = resolve(DATA_DIR, 'users.json')
const ACCOUNTS_FILE = resolve(DATA_DIR, 'accounts.json')  // tokens de Leadnamics

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── Auth ─────────────────────────────────────────────────────────────────────

function hashPassword(pwd) {
  return createHmac('sha256', SECRET_KEY).update(pwd).digest('hex')
}

const SESSIONS = new Map()

function createSession(username, role) {
  const token = randomBytes(32).toString('hex')
  SESSIONS.set(token, { username, role, expiresAt: Date.now() + 24 * 60 * 60 * 1000 })
  return token
}

function getSession(token) {
  if (!token) return null
  const s = SESSIONS.get(token)
  if (!s) return null
  if (s.expiresAt < Date.now()) { SESSIONS.delete(token); return null }
  return s
}

function loadUsers() {
  if (existsSync(USERS_FILE)) {
    try { return JSON.parse(readFileSync(USERS_FILE, 'utf-8')) } catch {}
  }
  const defaults = [
    { username: 'ariel', password: hashPassword('leadprofiler2026'), role: 'admin', active: true },
  ]
  writeFileSync(USERS_FILE, JSON.stringify(defaults, null, 2))
  return defaults
}

function requireAuth(req, res, next) {
  const header  = req.headers.authorization || ''
  const token   = header.startsWith('Bearer ') ? header.slice(7) : null
  const session = getSession(token)
  if (!session) return res.status(401).json({ error: 'No autenticado o sesión expirada' })
  req.session = session
  next()
}

// ─── Accounts (tokens de Leadnamics) ─────────────────────────────────────────

function loadAccounts() {
  if (existsSync(ACCOUNTS_FILE)) {
    try { return JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf-8')) } catch {}
  }
  return {}
}

function saveAccounts(accounts) {
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2))
}

// ─── Server-side Leadnamics pull ──────────────────────────────────────────────

const LNM_API = 'https://lidz-back-jipksosbaq-tl.a.run.app'

// stageIds que son descarte definitivo en Leadnamics
const DISC_STAGES = new Set([152, 154, 159])

// endReasons que NO son descarte — handoffs positivos
const POSITIVE_END_PATTERNS = ['se deriv', 'derivado al vendedor', 'compro', 'compró', 'venta cerrada', 'cierre exitoso', 'reserva realizada']
const isPositiveEnd = e => e ? POSITIVE_END_PATTERNS.some(p => e.toLowerCase().includes(p)) : false

// Estado del pull actual (una sola instancia — servidor single-user)
let pullState = { running: false, progress: 0, step: '', done: false, error: null, startedAt: null, result: null }

async function fetchWithAuth(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (r.status === 401) throw new Error('TOKEN_EXPIRED')
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`)
  return r.json()
}

async function runPull(account, token, projectId) {
  pullState = { running: true, progress: 0, step: 'Conectando con Leadnamics...', done: false, error: null, startedAt: new Date().toISOString(), result: null }

  try {
    const base        = `${LNM_API}/clients/v2/table`
    const filterModel = '%7B%22items%22%3A%5B%5D%7D'
    const baseParams  = `filterModel=${filterModel}&sortModel=&searchTerm=&projectId=${projectId}`

    // ── 1. Total de leads ──────────────────────────────────────────────────
    pullState.step = 'Obteniendo total de leads...'
    const first = await fetchWithAuth(`${base}?offset=0&limit=1&${baseParams}`, token)
    const total = first.total || 0
    pullState.step = `Descargando ${total} leads...`
    console.log(`[pull] ${account}: ${total} leads totales`)

    // ── 2. Descargar todos los leads ───────────────────────────────────────
    const LIMIT = 100
    const pages = Math.ceil(total / LIMIT)
    const all   = []

    for (let i = 0; i < pages; i++) {
      const data = await fetchWithAuth(
        `${base}?offset=${i * LIMIT}&limit=${LIMIT}&${baseParams}`,
        token
      )
      all.push(...(data.clients || []))
      pullState.progress = Math.round(((i + 1) / pages) * 55)  // 0→55%
      pullState.step = `Leads: ${all.length} / ${total}`
      await sleep(100)
    }

    // ── 3. Mensajes de leads activos recientes ─────────────────────────────
    const cutoff  = Date.now() - 60 * 24 * 60 * 60 * 1000  // últimos 60 días
    const forMsgs = all
      .filter(c =>
        (!c.endReason || isPositiveEnd(c.endReason)) &&
        !DISC_STAGES.has(c.activeClientStage?.stageId) &&
        new Date(c.lastMessageDate || c.createdAt) > cutoff
      )
      .sort((a, b) => new Date(b.lastMessageDate || b.createdAt) - new Date(a.lastMessageDate || a.createdAt))
      .slice(0, 120)  // máximo 120 conversaciones

    console.log(`[pull] ${account}: leyendo ${forMsgs.length} conversaciones...`)
    const msgStats = {}

    for (let i = 0; i < forMsgs.length; i++) {
      const c = forMsgs[i]
      try {
        const msgs = await fetchWithAuth(`${LNM_API}/clients/${c.id}/messages`, token)
        if (Array.isArray(msgs) && msgs.length) {
          const sorted = [...msgs].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
          const cMsgs  = sorted.filter(m => m.sender === 'client')
          const rts    = []
          for (let j = 0; j < sorted.length - 1; j++) {
            if (sorted[j].sender === 'client' && sorted[j + 1].sender !== 'client') {
              const dif = (new Date(sorted[j + 1].createdAt) - new Date(sorted[j].createdAt)) / 60000
              if (dif > 0 && dif < 1440) rts.push(Math.round(dif))
            }
          }
          const lastC = cMsgs[cMsgs.length - 1]
          msgStats[c.id] = {
            total:          msgs.length,
            clientCount:    cMsgs.length,
            agentCount:     sorted.length - cMsgs.length,
            lastClientAt:   lastC?.createdAt || null,
            avgResponseMin: rts.length ? Math.round(rts.reduce((a, b) => a + b, 0) / rts.length) : null,
            texts:          cMsgs.map(m => m.text).filter(Boolean).join(' '),
          }
        }
      } catch (e) {
        if (e.message === 'TOKEN_EXPIRED') throw e  // propagar expiración
      }
      pullState.progress = 55 + Math.round(((i + 1) / forMsgs.length) * 35)  // 55→90%
      pullState.step = `Conversaciones: ${i + 1} / ${forMsgs.length}`
      await sleep(100)
    }

    // ── 4. Construir leads normalizados ────────────────────────────────────
    pullState.step = 'Procesando leads...'
    pullState.progress = 92

    const STATUS_ENGAGEMENT = {
      'En Contacto': 'consulta_especifica',
      'Prioridad':   'solicita_propuesta',
      'Seguimiento': 'solicita_propuesta',
      'Por Contactar': 'consulta_general',
    }

    const leads = all.map(c => {
      const proj      = c.subProject?.name || c.project?.name || ''
      const st        = c.status || ''
      const endReason = c.endReason || null
      const isDisc    = DISC_STAGES.has(c.activeClientStage?.stageId) || (Boolean(endReason) && !isPositiveEnd(endReason))
      const conv      = [c.notes, c.adminNotes].filter(Boolean).join(' | ')
      return {
        id:               `lnm-${account}-${c.id}`,
        name:             [c.firstName, c.lastName, c.motherLastName].filter(Boolean).join(' ').trim() || c.alias || `Cliente ${c.id}`,
        phone:            c.phone || '',
        source:           c.source || `Leadnamics (${account})`,
        propertyInterest: proj,
        zone:             '',
        budget:           c.budget || 0,
        urgency:          'sin_definir',
        engagement:       STATUS_ENGAGEMENT[st] || 'consulta_general',
        objections:       [],
        lastContact:      c.lastMessageDate?.slice(0, 10) || c.createdAt?.slice(0, 10) || null,
        notes:            conv,
        _lnm: {
          id:        c.id,
          score:     c.score ?? 0,
          status:    st,
          stage:     c.activeClientStage?.name || '',
          stageId:   c.activeClientStage?.stageId || null,
          account,
          project:   proj,
          endReason,
          discarded: isDisc,
          topics:    c.topics || [],
          msgStats:  msgStats[c.id] || null,
        },
      }
    })

    // ── 5. Merge con otras cuentas y guardar ───────────────────────────────
    pullState.step = 'Guardando...'
    pullState.progress = 97

    const existing  = existsSync(LIVE_FILE)
      ? JSON.parse(readFileSync(LIVE_FILE, 'utf-8'))
      : { leads: [], sources: [] }
    const otherLeads = (existing.leads || []).filter(l => l._lnm?.account !== account)
    const merged     = mergeLeads([...otherLeads, ...leads])
    const sources    = [...new Set([...(existing.sources || []).filter(s => s !== account), account])]

    writeFileSync(LIVE_FILE, JSON.stringify({
      syncedAt:    new Date().toISOString(),
      sources,
      totalMerged: merged.length,
      leads:       merged,
    }, null, 2))

    const result = { total: leads.length, msgsFetched: Object.keys(msgStats).length, sources }
    pullState = { running: false, progress: 100, step: 'Listo', done: true, error: null, startedAt: pullState.startedAt, finishedAt: new Date().toISOString(), result }
    console.log(`[pull] ✅ ${account}: ${leads.length} leads, ${Object.keys(msgStats).length} conversaciones leídas`)

  } catch (err) {
    const isExpired = err.message === 'TOKEN_EXPIRED'
    const errorMsg  = isExpired
      ? 'El token de Leadnamics expiró. Ejecutá el bookmarklet una vez para renovarlo.'
      : err.message
    pullState = { ...pullState, running: false, done: true, error: errorMsg }
    console.error(`[pull] ❌ ${account}:`, errorMsg)
  }
}

// ─── Merge con deduplicación por teléfono ─────────────────────────────────────

function mergeLeads(allLeads) {
  const seen   = new Set()
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

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express()

app.use(cors({
  origin: IS_PROD ? process.env.APP_URL || true : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Access-Control-Request-Private-Network'],
}))

// Chrome Private Network Access — permite que páginas HTTPS hagan fetch a localhost
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
  next()
})

app.use(express.json({ limit: '50mb' }))

// ── Públicos ──────────────────────────────────────────────────────────────────

// GET /api/status — ping de conexión (público)
app.get('/api/status', (req, res) => {
  const data = existsSync(LIVE_FILE)
    ? JSON.parse(readFileSync(LIVE_FILE, 'utf-8'))
    : null
  const accounts = loadAccounts()
  res.json({
    ok:           true,
    syncedAt:     data?.syncedAt ?? null,
    sources:      data?.sources ?? [],
    totalMerged:  data?.totalMerged ?? 0,
    accountsReady: Object.keys(accounts),  // cuentas con token guardado
  })
})

// POST /api/login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' })
  const users = loadUsers()
  const user  = users.find(u => u.username === username && u.password === hashPassword(password) && u.active !== false)
  if (!user) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' })
  const token = createSession(username, user.role)
  console.log(`[auth] ✅ Login: ${username} (${user.role})`)
  res.json({ token, username, role: user.role })
})

// POST /api/logout
app.post('/api/logout', (req, res) => {
  const header = req.headers.authorization || ''
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null
  if (token) SESSIONS.delete(token)
  res.json({ ok: true })
})

// ── Protegidos ────────────────────────────────────────────────────────────────

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.session.username, role: req.session.role })
})

app.get('/api/users', requireAuth, (req, res) => {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Solo admin' })
  res.json(loadUsers().map(u => ({ username: u.username, role: u.role, active: u.active !== false })))
})

app.post('/api/users', requireAuth, (req, res) => {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Solo admin' })
  const { username, password, role = 'viewer', active = true } = req.body || {}
  if (!username || !password) return res.status(400).json({ error: 'username y password requeridos' })
  const users = loadUsers()
  const idx   = users.findIndex(u => u.username === username)
  const entry = { username, password: hashPassword(password), role, active }
  if (idx >= 0) users[idx] = entry; else users.push(entry)
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2))
  console.log(`[auth] Usuario ${username} ${idx >= 0 ? 'actualizado' : 'creado'} por ${req.session.username}`)
  res.json({ ok: true, username, role })
})

// POST /api/register-token — guarda el token de Leadnamics (llamado desde localhost:5173, sin PNA issue)
app.post('/api/register-token', (req, res) => {
  const { account, token, projectId } = req.body || {}
  if (!account || !token) return res.status(400).json({ error: 'account y token requeridos' })
  const accounts = loadAccounts()
  accounts[account] = { token, projectId: projectId || '1287', registeredAt: new Date().toISOString() }
  saveAccounts(accounts)
  console.log(`[auth] ✅ Token registrado para cuenta: ${account} (projectId: ${projectId || '1287'})`)
  res.json({ ok: true, account })
})

// GET /api/leads — datos del frontend
app.get('/api/leads', requireAuth, (req, res) => {
  if (!existsSync(LIVE_FILE)) return res.json(null)
  res.json(JSON.parse(readFileSync(LIVE_FILE, 'utf-8')))
})

// GET /api/accounts — lista de cuentas con token guardado
app.get('/api/accounts', requireAuth, (req, res) => {
  const accounts = loadAccounts()
  // No devolver el token completo — solo metadata
  res.json(Object.entries(accounts).map(([name, cfg]) => ({
    name,
    projectId:   cfg.projectId,
    registeredAt: cfg.registeredAt,
    tokenPreview: cfg.token ? cfg.token.slice(0, 12) + '...' : null,
  })))
})

// POST /api/pull — trigger de sincronización server-side desde Leadnamics
app.post('/api/pull', requireAuth, async (req, res) => {
  if (pullState.running) {
    return res.json({ ok: false, alreadyRunning: true, message: 'Ya hay una sincronización en curso', state: pullState })
  }

  const accounts = loadAccounts()
  const accountNames = Object.keys(accounts)
  if (!accountNames.length) {
    return res.status(400).json({
      error: 'No hay cuentas registradas. Ejecutá el bookmarklet al menos una vez para registrar el token de Leadnamics.',
    })
  }

  // Puede pedir una cuenta específica o todas
  const requested = req.body?.account
  const toSync    = requested ? [requested] : accountNames
  const missing   = toSync.filter(a => !accounts[a])
  if (missing.length) {
    return res.status(400).json({ error: `Cuenta(s) sin token: ${missing.join(', ')}` })
  }

  console.log(`[pull] Iniciando pull para: ${toSync.join(', ')}`)

  // Run en background (no bloqueamos la respuesta)
  ;(async () => {
    for (const acc of toSync) {
      await runPull(acc, accounts[acc].token, accounts[acc].projectId || '1287')
    }
  })().catch(console.error)

  res.json({ ok: true, message: `Sincronización iniciada para: ${toSync.join(', ')}`, accounts: toSync })
})

// GET /api/pull/status — estado del pull en curso
app.get('/api/pull/status', requireAuth, (req, res) => {
  res.json(pullState)
})

// ── Bookmarklet endpoint — guarda token + leads ───────────────────────────────

// POST /sync o /api/sync — recibido del bookmarklet (sin auth, corre en localhost)
app.post(['/sync', '/api/sync'], (req, res) => {

  const { account, leads, leadnamicsToken, projectId } = req.body
  if (!account || !Array.isArray(leads)) return res.status(400).json({ error: 'Se requieren account y leads[]' })

  // Guardar token de Leadnamics para futuros pulls desde el server
  if (leadnamicsToken) {
    const accounts = loadAccounts()
    accounts[account] = {
      token:        leadnamicsToken,
      projectId:    projectId || accounts[account]?.projectId || '1287',
      registeredAt: new Date().toISOString(),
    }
    saveAccounts(accounts)
    console.log(`[sync] Token de Leadnamics guardado para cuenta: ${account}`)
  }

  console.log(`[sync] ${account}: ${leads.length} leads recibidos`)

  const existing   = existsSync(LIVE_FILE) ? JSON.parse(readFileSync(LIVE_FILE, 'utf-8')) : { leads: [], sources: [] }
  const otherLeads = (existing.leads || []).filter(l => l._lnm?.account !== account)
  const merged     = mergeLeads([...otherLeads, ...leads])
  const sources    = [...new Set([...(existing.sources || []).filter(s => s !== account), account])]

  writeFileSync(LIVE_FILE, JSON.stringify({
    syncedAt:    new Date().toISOString(),
    sources,
    totalMerged: merged.length,
    leads:       merged,
  }, null, 2))

  console.log(`[sync] ✅ Total: ${merged.length} leads de [${sources.join(', ')}]`)
  res.json({ ok: true, total: merged.length, sources })
})

// ─── Frontend estático (producción) ───────────────────────────────────────────
if (IS_PROD) {
  const distDir = resolve(__dirname, 'dist')
  const { default: serveStatic } = await import('serve-static')
  app.use(serveStatic(distDir))
  app.get('*', (req, res) => res.sendFile(resolve(distDir, 'index.html')))
}

app.listen(PORT, () => {
  loadUsers()
  const accounts = loadAccounts()
  console.log(`\n✅ Lead Profiler ${IS_PROD ? 'PROD' : 'DEV'} → http://localhost:${PORT}`)
  if (!IS_PROD) console.log(`   Frontend:  http://localhost:5173  (npm run dev)`)
  console.log(`   Cuentas:   ${Object.keys(accounts).join(', ') || 'ninguna aún → ejecutá el bookmarklet para registrar el token'}`)
  console.log(`   Datos:      ${LIVE_FILE}\n`)
})
