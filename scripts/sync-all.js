/**
 * sync-all.js — Orquestador de sincronización multi-cuenta
 *
 * Uso manual:
 *   node scripts/sync-all.js
 *   node scripts/sync-all.js --headless false   (ver el browser abrirse)
 *
 * El cron lo llama automáticamente. Resultado en: public/leads-live.json
 */

import { extractAccount } from './extract-account.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import minimist from 'minimist'
import os from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, 'public')
const OUT_FILE = resolve(OUT_DIR, 'leads-live.json')
const CONFIG_FILE = resolve(ROOT, 'scripts', 'accounts.json')

// Rutas de perfil por defecto según SO
const DEFAULT_CHROME_PROFILE = resolve(os.homedir(), 'Library/Application Support/Google/Chrome/Default')
const DEFAULT_SAFARI_PROFILE  = resolve(os.homedir(), 'Library/Application Support/Google/Chrome/Profile 1')

const args = minimist(process.argv.slice(2))

// ─── Cargar configuración ─────────────────────────────────────────────────────

function loadConfig() {
  if (existsSync(CONFIG_FILE)) {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'))
  }

  // Configuración por defecto si no existe el archivo
  const defaultConfig = {
    accounts: [
      {
        label: 'chrome',
        enabled: true,
        profileDir: DEFAULT_CHROME_PROFILE,
        description: 'Cuenta principal (Chrome)',
      },
      {
        label: 'safari',
        enabled: true,
        profileDir: DEFAULT_SAFARI_PROFILE,
        description: 'Cuenta secundaria (Safari → Chrome Profile 2)',
      },
    ],
    syncIntervalHours: 4,
    outputFile: OUT_FILE,
  }

  writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2))
  console.log(`📋 Archivo de config creado: ${CONFIG_FILE}`)
  console.log('   Editalo para ajustar los profileDir de cada cuenta.\n')
  return defaultConfig
}

// ─── Merge de leads de múltiples cuentas ─────────────────────────────────────

function mergeLeads(leadsByAccount) {
  const merged = []
  const seenPhones = new Set()

  // Prioridad: leads con score más alto primero al deduplicar por teléfono
  const allLeads = leadsByAccount.flat().sort((a, b) => (b._lnm?.score ?? 0) - (a._lnm?.score ?? 0))

  for (const lead of allLeads) {
    const phone = lead.phone?.replace(/\D/g, '')
    if (phone && phone.length > 6) {
      if (seenPhones.has(phone)) {
        // Lead duplicado entre cuentas — agregar referencia cruzada
        const existing = merged.find(l => l.phone?.replace(/\D/g, '') === phone)
        if (existing) {
          existing._duplicateIn = existing._duplicateIn || []
          existing._duplicateIn.push(lead._lnm?.account)
        }
        continue
      }
      seenPhones.add(phone)
    }
    merged.push(lead)
  }

  return merged
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════')
  console.log('  Lead Profiler — Sincronización multi-cuenta')
  console.log(`  ${new Date().toLocaleString('es-AR')}`)
  console.log('═══════════════════════════════════════════\n')

  const config = loadConfig()
  const headless = args.headless !== 'false' && args.headless !== false
  const enabledAccounts = config.accounts.filter(a => a.enabled !== false)

  if (enabledAccounts.length === 0) {
    console.error('❌ No hay cuentas habilitadas en accounts.json')
    process.exit(1)
  }

  console.log(`📂 Cuentas a sincronizar: ${enabledAccounts.map(a => a.label).join(', ')}\n`)

  const results = []
  const errors = []

  // Extraer secuencialmente (paralelo puede causar conflictos de perfil)
  for (const account of enabledAccounts) {
    try {
      const leads = await extractAccount({ ...account, headless })
      results.push(leads)
      console.log(`   → ${leads.length} leads de "${account.label}"`)
    } catch (err) {
      errors.push({ account: account.label, error: err.message })
      console.error(`❌ Error en "${account.label}": ${err.message}`)

      // Intentar cargar datos anteriores de esa cuenta si los hay
      if (existsSync(OUT_FILE)) {
        const prev = JSON.parse(readFileSync(OUT_FILE, 'utf-8'))
        const prevLeads = (prev.leads || []).filter(l => l._lnm?.account === account.label)
        if (prevLeads.length > 0) {
          results.push(prevLeads)
          console.log(`   ↩ Usando ${prevLeads.length} leads anteriores de "${account.label}"`)
        }
      }
    }
  }

  if (results.length === 0) {
    console.error('\n❌ No se pudo extraer datos de ninguna cuenta')
    process.exit(1)
  }

  // Merge y deduplicación
  const merged = mergeLeads(results)
  console.log(`\n🔀 Merge: ${results.flat().length} total → ${merged.length} únicos`)

  // Estadísticas
  const hot  = merged.filter(l => (l._lnm?.score ?? 0) >= 70).length
  const warm = merged.filter(l => (l._lnm?.score ?? 0) >= 40 && (l._lnm?.score ?? 0) < 70).length
  const cold = merged.filter(l => (l._lnm?.score ?? 0) < 40).length
  console.log(`   HOT: ${hot} | WARM: ${warm} | COLD: ${cold}`)

  // Guardar
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

  const output = {
    syncedAt: new Date().toISOString(),
    sources: enabledAccounts.map(a => a.label),
    errors: errors.length > 0 ? errors : undefined,
    totalRaw: results.flat().length,
    totalMerged: merged.length,
    leads: merged,
  }

  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2))
  console.log(`\n✅ Guardado en: ${OUT_FILE}`)

  if (errors.length > 0) {
    console.warn(`\n⚠️  ${errors.length} cuenta(s) con errores — revisá arriba`)
  }

  console.log('\n   Abrí Lead Profiler para ver los datos actualizados.')
}

main().catch(err => {
  console.error('\n💥 Error fatal:', err.message)
  process.exit(1)
})
