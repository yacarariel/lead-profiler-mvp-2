/**
 * extract-account.js
 * Extrae todos los leads de UNA cuenta de Leadnamics.
 *
 * Modo CDP (recomendado): se conecta al Chrome ya abierto vía puerto 9222.
 * Modo Puppeteer (fallback): lanza un Chrome headless con el perfil guardado
 *   → solo funciona cuando Chrome NO está corriendo con ese perfil.
 */

import puppeteer from 'puppeteer'
import { existsSync } from 'fs'

const API_BASE  = 'https://lidz-back-jipksosbaq-tl.a.run.app'
const PORTAL    = 'https://portal.leadnamics.io'
const LIMIT     = 100
const CDP_PORT  = 9222

// Script de extracción que corre dentro del tab del browser
const EXTRACTION_SCRIPT = `
(async () => {
  const raw = localStorage.getItem('persist:root-lidz');
  if (!raw) throw new Error('No session found');

  const user = JSON.parse(JSON.parse(raw).user);
  const token = user.accessToken;
  if (!token) throw new Error('Token not found');

  const base = '${API_BASE}/clients/v2/table';
  const projectId = new URLSearchParams(location.search).get('projectId') || '1287';

  const first = await fetch(
    base + '?offset=0&limit=1&filterModel=%7B%22items%22%3A%5B%5D%7D&sortModel=&searchTerm=&projectId=' + projectId,
    { headers: { Authorization: 'Bearer ' + token } }
  );
  const { total } = await first.json();
  const pages = Math.ceil(total / ${LIMIT});
  const all = [];

  for (let i = 0; i < pages; i++) {
    const r = await fetch(
      base + '?offset=' + (i * ${LIMIT}) + '&limit=${LIMIT}&filterModel=%7B%22items%22%3A%5B%5D%7D&sortModel=&searchTerm=&projectId=' + projectId,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    const d = await r.json();
    all.push(...(d.clients || []));
    await new Promise(res => setTimeout(res, 120));
  }

  return { total, clients: all, projectId };
})()
`

function mapToLeadProfiler(client, accountLabel) {
  const scoreVal = client.score ?? 0
  const category = scoreVal >= 70 ? 'HOT' : scoreVal >= 40 ? 'WARM' : 'COLD'
  const engagementMap = {
    'En Contacto':   'consulta_especifica',
    'Prioridad':     'solicita_propuesta',
    'Seguimiento':   'solicita_propuesta',
    'Por Contactar': 'consulta_general',
  }
  const name = [client.firstName, client.lastName, client.motherLastName]
    .filter(Boolean).join(' ').trim() || client.alias || `Cliente ${client.id}`

  return {
    id:               `lnm-${accountLabel}-${client.id}`,
    name,
    phone:            client.phone || '',
    source:           client.source || `Leadnamics (${accountLabel})`,
    propertyInterest: client.topics?.join(', ') || client.subProject?.name || '',
    zone:             '',
    budget:           client.budget || 0,
    urgency:          'sin_definir',
    engagement:       engagementMap[client.status] || 'consulta_general',
    objections:       [],
    lastContact:      client.lastMessageDate?.slice(0, 10) || client.createdAt?.slice(0, 10) || null,
    notes:            [client.notes, client.adminNotes].filter(Boolean).join(' | '),
    _lnm: {
      id:       client.id,
      score:    scoreVal,
      category,
      status:   client.status || '',
      stage:    client.activeClientStage?.name || '',
      account:  accountLabel,
      project:  client.project?.name || '',
    },
  }
}

// ─── Modo CDP: conectar al Chrome en ejecución ─────────────────────────────

async function extractViaCDP(account) {
  const { label, email } = account
  console.log(`[${label}] Conectando al Chrome en ejecución (puerto ${CDP_PORT})...`)

  let browser
  try {
    browser = await puppeteer.connect({
      browserURL: `http://127.0.0.1:${CDP_PORT}`,
      defaultViewport: null,
    })
  } catch {
    throw new Error(
      `No se pudo conectar al puerto ${CDP_PORT}. ` +
      `Cerrá Chrome y abrilo con: bash scripts/launch-chrome.sh`
    )
  }

  const pages = await browser.pages()

  // Buscar tab de Leadnamics logueado con esta cuenta
  let targetPage = null
  for (const page of pages) {
    const url = page.url()
    if (!url.includes('leadnamics.io')) continue

    // Verificar que es la cuenta correcta leyendo el email del store
    const pageEmail = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem('persist:root-lidz')
        if (!raw) return null
        return JSON.parse(JSON.parse(raw).user).email
      } catch { return null }
    }).catch(() => null)

    if (email && pageEmail !== email) continue
    targetPage = page
    break
  }

  if (!targetPage) {
    // Abrir el portal en un nuevo tab
    console.log(`[${label}] Abriendo nueva pestaña de Leadnamics...`)
    targetPage = await browser.newPage()
    await targetPage.goto(`${PORTAL}/funnel?view=table`, { waitUntil: 'networkidle2', timeout: 30000 })
    await targetPage.waitForFunction(
      () => !!localStorage.getItem('persist:root-lidz'),
      { timeout: 15000 }
    )
  }

  console.log(`[${label}] Sesión encontrada. Extrayendo leads...`)
  const result = await targetPage.evaluate(EXTRACTION_SCRIPT)

  // Desconectar sin cerrar el browser
  await browser.disconnect()

  console.log(`[${label}] ✅ ${result.clients.length} / ${result.total} leads extraídos`)
  return result.clients.map(c => mapToLeadProfiler(c, label))
}

// ─── Modo Puppeteer: lanzar Chrome headless ────────────────────────────────

async function extractViaPuppeteer(account) {
  const { label, profileDir, headless = true } = account
  console.log(`[${label}] Modo headless con perfil: ${profileDir}`)

  if (!existsSync(profileDir)) {
    throw new Error(`Perfil no encontrado: ${profileDir}`)
  }

  const browser = await puppeteer.launch({
    headless,
    userDataDir: profileDir,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    defaultViewport: { width: 1280, height: 900 },
  })

  const page = await browser.newPage()
  try {
    await page.goto(`${PORTAL}/funnel?view=table`, { waitUntil: 'networkidle2', timeout: 30000 })
    const url = page.url()
    if (url.includes('/login') || url.includes('/auth')) {
      throw new Error(`Sesión expirada en "${label}". Abrí Leadnamics y volvé a loguearte.`)
    }
    await page.waitForFunction(
      () => !!localStorage.getItem('persist:root-lidz'),
      { timeout: 15000 }
    )
    console.log(`[${label}] Sesión encontrada. Extrayendo leads...`)
    const result = await page.evaluate(EXTRACTION_SCRIPT)
    console.log(`[${label}] ✅ ${result.clients.length} / ${result.total} leads extraídos`)
    return result.clients.map(c => mapToLeadProfiler(c, label))
  } finally {
    await browser.close()
  }
}

// ─── Punto de entrada público ──────────────────────────────────────────────

export async function extractAccount(account) {
  // Intentar CDP primero (Chrome corriendo con debug port)
  try {
    return await extractViaCDP(account)
  } catch (cdpErr) {
    if (cdpErr.message.includes('puerto')) {
      // CDP no disponible — intentar modo headless
      console.log(`[${account.label}] CDP no disponible. Intentando modo headless...`)
      return await extractViaPuppeteer(account)
    }
    throw cdpErr
  }
}
