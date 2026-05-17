/**
 * Leadnamics Scraper — extrae conversaciones y las convierte al formato Lead Profiler.
 *
 * Uso:
 *   node scripts/scrape-leadnamics.js --email tu@email.com --pass tuPassword
 *   node scripts/scrape-leadnamics.js --cookies cookies.json   (reutiliza sesión)
 *
 * Output: leads-leadnamics-YYYY-MM-DD.json (listo para importar en Lead Profiler)
 *
 * Requiere:
 *   npm install puppeteer-extra puppeteer-extra-plugin-stealth minimist
 */

import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import fs from 'fs/promises'
import path from 'path'
import minimist from 'minimist'

puppeteer.use(StealthPlugin())

const args = minimist(process.argv.slice(2))
const BASE_URL = 'https://portal.leadnamics.io'

// ─── Keyword Maps for NLP scoring hints ───────────────────────────────────────

const URGENCY_KEYWORDS = {
  inmediato:   ['hoy', 'urgente', 'ya', 'inmediato', 'enseguida', 'cuanto antes'],
  semana:      ['esta semana', 'en días', 'próxima semana'],
  mes:         ['este mes', 'fin de mes', '30 días', 'próximo mes'],
  trimestre:   ['2 meses', '3 meses', 'en unos meses', 'antes de fin de año'],
  semestre:    ['6 meses', 'el año que viene', 'sin apuro'],
  sin_definir: ['quizás', 'tal vez', 'viendo', 'averiguando'],
}

const OBJECTION_KEYWORDS = [
  'caro', 'costoso', 'no tengo', 'esperar', 'pendiente', 'crédito', 'vender primero',
  'comparando', 'consultando', 'no convence', 'dudo', 'no estoy seguro',
]

const ENGAGEMENT_KEYWORDS = {
  visita_agendada:     ['visita agendada', 'voy a ver', 'quiero ver la propiedad', 'coordinamos visita'],
  reunion_agendada:    ['reunión', 'nos juntamos', 'me paso por', 'agendamos'],
  solicita_propuesta:  ['mandame', 'enviame', 'manda info', 'quiero la propuesta', 'cotización'],
  consulta_especifica: ['cuánto sale', 'qué expensas', 'cuántos ambientes', 'antigüedad'],
  consulta_general:    ['me interesa', 'quiero saber', 'tengo consulta'],
  solo_curiosidad:     ['solo mirando', 'averiguando', 'para más adelante'],
}

function detectUrgency(text) {
  const lower = text.toLowerCase()
  for (const [level, keywords] of Object.entries(URGENCY_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return level
  }
  return 'sin_definir'
}

function detectObjecciones(text) {
  const lower = text.toLowerCase()
  return OBJECTION_KEYWORDS.filter(k => lower.includes(k))
}

function detectEngagement(text) {
  const lower = text.toLowerCase()
  for (const [level, keywords] of Object.entries(ENGAGEMENT_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return level
  }
  return 'consulta_general'
}

function extractBudget(text) {
  const matches = text.match(/\$?\s*([\d.,]+)\s*(k|mil|usd|dólares|dolares)?/gi) ?? []
  for (const m of matches) {
    const num = parseFloat(m.replace(/[^0-9.]/g, '').replace(',', '.'))
    if (!num || num < 1000) continue
    if (m.toLowerCase().includes('k') || m.toLowerCase().includes('mil')) return num * 1000
    if (num < 10000) return num * 1000  // asume miles si es número chico
    return num
  }
  return 0
}

// ─── Browser Helpers ──────────────────────────────────────────────────────────

async function login(page, email, password) {
  console.log('🔐 Iniciando sesión en Leadnamics...')
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle2' })

  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10000 })
  await page.type('input[type="email"], input[name="email"]', email, { delay: 50 })

  await page.waitForSelector('input[type="password"]')
  await page.type('input[type="password"]', password, { delay: 50 })

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }),
    page.click('button[type="submit"]'),
  ])

  console.log('✅ Sesión iniciada')
}

async function loadCookies(page, cookiePath) {
  const raw = await fs.readFile(cookiePath, 'utf-8')
  const cookies = JSON.parse(raw)
  await page.setCookie(...cookies)
  console.log(`🍪 Cookies cargadas desde ${cookiePath}`)
}

async function saveCookies(page, cookiePath) {
  const cookies = await page.cookies()
  await fs.writeFile(cookiePath, JSON.stringify(cookies, null, 2))
  console.log(`💾 Cookies guardadas en ${cookiePath}`)
}

// ─── Scraping Logic ───────────────────────────────────────────────────────────

async function getConversationList(page) {
  console.log('📋 Buscando lista de conversaciones...')
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2' })

  // Esperar a que cargue la lista (ajustar selector según el DOM real)
  await page.waitForSelector('[class*="conversation"], [class*="lead"], [class*="chat"]', {
    timeout: 15000,
  }).catch(() => console.warn('⚠️  No se encontró el selector de conversaciones, adaptá el selector'))

  const conversations = await page.evaluate(() => {
    // Intentar diferentes selectores comunes de CRMs
    const selectors = [
      '[data-conversation-id]',
      '[data-lead-id]',
      '[href*="/conversation/"]',
      '[href*="/lead/"]',
      '[href*="/chat/"]',
    ]

    for (const sel of selectors) {
      const els = document.querySelectorAll(sel)
      if (els.length > 0) {
        return Array.from(els).map(el => ({
          id: el.dataset.conversationId || el.dataset.leadId || el.href?.split('/').pop(),
          href: el.href || el.dataset.href,
          name: el.querySelector('[class*="name"], h2, h3, strong')?.textContent?.trim() ?? 'Sin nombre',
        }))
      }
    }
    return []
  })

  console.log(`   Encontradas ${conversations.length} conversaciones`)
  return conversations
}

async function scrapeConversation(page, conv) {
  if (!conv.href) return null

  await page.goto(conv.href, { waitUntil: 'networkidle2', timeout: 15000 })
    .catch(() => null)

  const data = await page.evaluate(() => {
    const getText = sel => document.querySelector(sel)?.textContent?.trim() ?? ''
    const getAll = sel => Array.from(document.querySelectorAll(sel)).map(e => e.textContent.trim())

    // Recolectar todo el texto de los mensajes
    const msgSelectors = ['[class*="message"]', '[class*="bubble"]', '[class*="chat-text"]', 'p']
    let allMessages = []
    for (const sel of msgSelectors) {
      const msgs = getAll(sel).filter(t => t.length > 5)
      if (msgs.length > 2) { allMessages = msgs; break }
    }

    const phone = getText('[class*="phone"]') ||
      document.body.innerText.match(/(\+54|0)[- 9\d]{8,14}/)?.[0] ?? ''

    const source = getText('[class*="source"], [class*="channel"], [class*="origen"]') || 'Leadnamics'

    // Fecha del último mensaje
    const dates = Array.from(document.querySelectorAll('time, [class*="date"], [class*="time"]'))
      .map(el => el.getAttribute('datetime') || el.textContent.trim())
      .filter(Boolean)

    return {
      rawText: allMessages.join(' '),
      phone,
      source,
      lastContactRaw: dates[dates.length - 1] ?? null,
    }
  })

  if (!data.rawText) return null

  const text = data.rawText

  // Intentar parsear la fecha
  let lastContact = new Date().toISOString().slice(0, 10)
  if (data.lastContactRaw) {
    const parsed = new Date(data.lastContactRaw)
    if (!isNaN(parsed)) lastContact = parsed.toISOString().slice(0, 10)
  }

  return {
    id: `lnm-${conv.id}`,
    name: conv.name,
    phone: data.phone,
    source: data.source,
    propertyInterest: text.slice(0, 120).trim() + '...',
    zone: '',
    budget: extractBudget(text),
    urgency: detectUrgency(text),
    engagement: detectEngagement(text),
    objections: detectObjecciones(text),
    lastContact,
    notes: text.slice(0, 300).trim(),
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const browser = await puppeteer.launch({
    headless: args.headless !== false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 900 },
  })

  const page = await browser.newPage()
  page.setDefaultTimeout(20000)

  try {
    // Auth
    if (args.cookies) {
      await page.goto(BASE_URL, { waitUntil: 'networkidle2' })
      await loadCookies(page, args.cookies)
      await page.reload({ waitUntil: 'networkidle2' })
    } else if (args.email && args.pass) {
      await login(page, args.email, args.pass)
      if (args['save-cookies']) {
        await saveCookies(page, args['save-cookies'])
      }
    } else {
      console.error('❌ Necesitás proveer --email y --pass, o --cookies <archivo>')
      console.error('   Ejemplo: node scripts/scrape-leadnamics.js --email tu@mail.com --pass tuPass')
      process.exit(1)
    }

    const conversations = await getConversationList(page)

    if (conversations.length === 0) {
      console.warn('⚠️  No se encontraron conversaciones. El script necesita ajuste de selectores.')
      console.warn('   Tomando screenshot para debug...')
      await page.screenshot({ path: 'debug-screenshot.png', fullPage: true })
      console.warn('   Guardado: debug-screenshot.png')
      await browser.close()
      return
    }

    const limit = args.limit ? Number(args.limit) : conversations.length
    const toScrape = conversations.slice(0, limit)
    console.log(`\n🔄 Scrapeando ${toScrape.length} conversaciones...`)

    const leads = []
    for (const [i, conv] of toScrape.entries()) {
      process.stdout.write(`   [${i + 1}/${toScrape.length}] ${conv.name}... `)
      const lead = await scrapeConversation(page, conv)
      if (lead) {
        leads.push(lead)
        process.stdout.write('✓\n')
      } else {
        process.stdout.write('skipped\n')
      }
      // Pausa cortés para no triggerear rate limiting
      await new Promise(r => setTimeout(r, 800 + Math.random() * 400))
    }

    const filename = `leads-leadnamics-${new Date().toISOString().slice(0, 10)}.json`
    const outPath = path.resolve(filename)
    await fs.writeFile(outPath, JSON.stringify(leads, null, 2))

    console.log(`\n✅ Exportados ${leads.length} leads → ${outPath}`)
    console.log('   Importá este archivo en Lead Profiler con el botón "Importar"\n')

  } finally {
    await browser.close()
  }
}

main().catch(err => {
  console.error('💥 Error fatal:', err.message)
  process.exit(1)
})
