import { useState, useCallback, useMemo, useEffect } from 'react'
import {
  Upload, Download, TrendingUp, Users, Flame,
  ThermometerSun, Snowflake, ChevronDown, ChevronUp,
  DollarSign, Clock, AlertTriangle, MessageSquare, Calendar,
  CheckCircle, XCircle, AlertCircle, BarChart2, RefreshCw,
  Wifi, WifiOff, Database
} from 'lucide-react'
import sampleLeads from './data/leads.json'

// ─── Scoring Engine ────────────────────────────────────────────────────────────

const WEIGHTS = {
  presupuesto: 25,
  urgencia:    25,
  objeciones:  20,
  compromiso:  20,
  recencia:    10,
}

function scorePresupuesto(budget) {
  if (!budget) return 5
  const b = Number(String(budget).replace(/[^0-9]/g, ''))
  if (b >= 300000) return 25
  if (b >= 200000) return 20
  if (b >= 100000) return 15
  if (b >  0)      return 10
  return 5
}

function scoreUrgencia(urgency) {
  const map = {
    inmediato:  25,
    semana:     22,
    mes:        17,
    trimestre:  12,
    semestre:   7,
    sin_definir: 3,
  }
  return map[urgency] ?? 3
}

function scoreObjeciones(objections) {
  if (!Array.isArray(objections)) return 20
  const n = objections.length
  if (n === 0) return 20
  if (n === 1) return 14
  if (n === 2) return 9
  return 4
}

function scoreCompromiso(engagement) {
  const map = {
    visita_agendada:  20,
    reunion_agendada: 20,
    solicita_propuesta: 17,
    consulta_especifica: 13,
    consulta_general: 8,
    solo_curiosidad:  4,
  }
  return map[engagement] ?? 8
}

function scoreRecencia(lastContact) {
  if (!lastContact) return 2
  const days = Math.floor((Date.now() - new Date(lastContact)) / 86_400_000)
  if (days === 0)       return 10
  if (days <= 2)        return 8
  if (days <= 7)        return 6
  if (days <= 14)       return 4
  if (days <= 30)       return 2
  return 1
}

function calcScore(lead) {
  const breakdown = {
    presupuesto: scorePresupuesto(lead.budget),
    urgencia:    scoreUrgencia(lead.urgency),
    objeciones:  scoreObjeciones(lead.objections),
    compromiso:  scoreCompromiso(lead.engagement),
    recencia:    scoreRecencia(lead.lastContact),
  }
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0)
  return { total, breakdown }
}

function getCategory(score) {
  if (score >= 70) return 'HOT'
  if (score >= 40) return 'WARM'
  return 'COLD'
}

function getRecommendation(category, lead) {
  if (category === 'HOT') {
    return `Llamar en las próximas 2 horas. ${lead.engagement === 'visita_agendada' ? 'Confirmar visita.' : 'Proponer reunión hoy o mañana.'} Preparar propuesta con propiedades en rango $${(lead.budget || 0).toLocaleString()}.`
  }
  if (category === 'WARM') {
    return `Enviar catálogo personalizado por WhatsApp. Hacer seguimiento en 48hs. ${lead.objections?.length ? `Abordar objeción: "${lead.objections[0]}".` : ''}`
  }
  return `Agregar al newsletter semanal. Programar re-contacto en 30 días. Ofrecer contenido educativo sobre el mercado inmobiliario.`
}

function processLeads(rawLeads) {
  return rawLeads.map(lead => {
    const { total, breakdown } = calcScore(lead)
    // Cuando el lead viene de Leadnamics, usar su score nativo como primario
    const lnmScore = lead._lnm?.score ?? null
    const finalScore = lnmScore !== null ? lnmScore : total
    const category = getCategory(finalScore)
    return {
      ...lead,
      score: finalScore,
      ourScore: total,        // score de nuestro algoritmo (siempre disponible)
      breakdown,
      category,
      recommendation: getRecommendation(category, lead),
    }
  }).sort((a, b) => b.score - a.score)
}

// ─── UI Helpers ────────────────────────────────────────────────────────────────

const CATEGORY_STYLES = {
  HOT:  { badge: 'badge-hot',  icon: Flame,          bar: 'bg-red-500',   text: 'text-red-600',   bg: 'bg-red-50'   },
  WARM: { badge: 'badge-warm', icon: ThermometerSun, bar: 'bg-amber-400', text: 'text-amber-600', bg: 'bg-amber-50' },
  COLD: { badge: 'badge-cold', icon: Snowflake,       bar: 'bg-blue-400',  text: 'text-blue-600',  bg: 'bg-blue-50'  },
}

const SCORE_LABELS = {
  presupuesto: { label: 'Presupuesto',  icon: DollarSign,    max: WEIGHTS.presupuesto },
  urgencia:    { label: 'Urgencia',     icon: Clock,         max: WEIGHTS.urgencia    },
  objeciones:  { label: 'Objeciones',  icon: AlertTriangle, max: WEIGHTS.objeciones  },
  compromiso:  { label: 'Compromiso',   icon: MessageSquare, max: WEIGHTS.compromiso  },
  recencia:    { label: 'Recencia',     icon: Calendar,      max: WEIGHTS.recencia    },
}

const URGENCY_LABELS = {
  inmediato: 'Inmediato', semana: 'Esta semana', mes: 'Este mes',
  trimestre: '1-3 meses', semestre: '3-6 meses', sin_definir: 'Sin definir',
}

const ENGAGEMENT_LABELS = {
  visita_agendada: 'Visita agendada', reunion_agendada: 'Reunión agendada',
  solicita_propuesta: 'Pide propuesta', consulta_especifica: 'Consulta específica',
  consulta_general: 'Consulta general', solo_curiosidad: 'Solo curiosidad',
}

function ScoreCircle({ score, category }) {
  const style = CATEGORY_STYLES[category]
  const circumference = 2 * Math.PI * 20
  const offset = circumference - (score / 100) * circumference

  return (
    <div className="relative flex items-center justify-center w-14 h-14">
      <svg className="w-14 h-14 -rotate-90" viewBox="0 0 48 48">
        <circle cx="24" cy="24" r="20" fill="none" stroke="#e5e7eb" strokeWidth="4" />
        <circle
          cx="24" cy="24" r="20" fill="none"
          stroke={category === 'HOT' ? '#ef4444' : category === 'WARM' ? '#f59e0b' : '#3b82f6'}
          strokeWidth="4"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-700"
        />
      </svg>
      <span className={`absolute text-sm font-bold ${style.text}`}>{score}</span>
    </div>
  )
}

function ScoreBar({ value, max, color }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-gray-100 rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full ${color} transition-all duration-500`}
          style={{ width: `${(value / max) * 100}%` }}
        />
      </div>
      <span className="text-xs font-medium text-gray-500 w-8 text-right">{value}/{max}</span>
    </div>
  )
}

function LeadCard({ lead }) {
  const [expanded, setExpanded] = useState(false)
  const style = CATEGORY_STYLES[lead.category]
  const Icon = style.icon

  const daysSince = lead.lastContact
    ? Math.floor((Date.now() - new Date(lead.lastContact)) / 86_400_000)
    : null

  return (
    <div className="card overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center gap-4 p-4 cursor-pointer select-none"
        onClick={() => setExpanded(e => !e)}
      >
        <ScoreCircle score={lead.score} category={lead.category} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-gray-900 truncate">{lead.name}</h3>
            <span className={`badge inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${style.badge}`}>
              <Icon className="w-3 h-3" />
              {lead.category}
            </span>
          </div>
          <p className="text-sm text-gray-500 truncate mt-0.5">{lead.propertyInterest}</p>
          <div className="flex items-center gap-3 mt-1 text-xs text-gray-400 flex-wrap">
            {lead.budget > 0 && <span>${lead.budget.toLocaleString()}</span>}
            {lead.urgency && <span>{URGENCY_LABELS[lead.urgency] ?? lead.urgency}</span>}
            {daysSince !== null && (
              <span>{daysSince === 0 ? 'Hoy' : daysSince === 1 ? 'Ayer' : `Hace ${daysSince} días`}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 ml-auto flex-shrink-0">
          <span className="text-sm font-bold text-gray-700">{lead.score}/100</span>
          {expanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </div>
      </div>

      {/* Expanded Detail */}
      {expanded && (
        <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-4">

          {/* Score Breakdown */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Desglose de score</p>
              {lead._lnm?.score != null && (
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-gray-400">Leadnamics:</span>
                  <span className={`font-bold ${style.text}`}>{lead._lnm.score}</span>
                  {lead._lnm.stage && <span className="text-gray-300">·</span>}
                  {lead._lnm.stage && <span className="text-gray-400">{lead._lnm.stage}</span>}
                  {lead._lnm.account && (
                    <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 font-medium">
                      {lead._lnm.account}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="space-y-2">
              {Object.entries(SCORE_LABELS).map(([key, { label, icon: LabelIcon, max }]) => (
                <div key={key} className="grid grid-cols-[120px_1fr] items-center gap-2">
                  <div className="flex items-center gap-1.5 text-xs text-gray-600">
                    <LabelIcon className="w-3.5 h-3.5 text-gray-400" />
                    {label}
                  </div>
                  <ScoreBar
                    value={lead.breakdown[key]}
                    max={max}
                    color={style.bar}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Objections */}
          {lead.objections?.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Objeciones detectadas</p>
              <div className="flex flex-wrap gap-1.5">
                {lead.objections.map((obj, i) => (
                  <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-50 text-red-700 text-xs">
                    <XCircle className="w-3 h-3" /> {obj}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Lead Info */}
          <div className="grid grid-cols-2 gap-2 text-sm">
            {lead.phone && (
              <div className="flex items-center gap-1.5 text-gray-600">
                <span className="text-gray-400">📱</span> {lead.phone}
              </div>
            )}
            {lead.source && (
              <div className="flex items-center gap-1.5 text-gray-600">
                <span className="text-gray-400">📌</span> {lead.source}
              </div>
            )}
            {lead.engagement && (
              <div className="flex items-center gap-1.5 text-gray-600">
                <CheckCircle className="w-3.5 h-3.5 text-gray-400" />
                {ENGAGEMENT_LABELS[lead.engagement] ?? lead.engagement}
              </div>
            )}
            {lead.zone && (
              <div className="flex items-center gap-1.5 text-gray-600">
                <span className="text-gray-400">📍</span> {lead.zone}
              </div>
            )}
          </div>

          {/* Notes */}
          {lead.notes && (
            <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-600 italic">
              "{lead.notes}"
            </div>
          )}

          {/* Recommendation */}
          <div className={`rounded-lg p-3 ${style.bg}`}>
            <p className="text-xs font-semibold uppercase tracking-wider mb-1 ${style.text}">
              <span className={style.text}>Recomendación</span>
            </p>
            <p className="text-sm text-gray-700">{lead.recommendation}</p>
          </div>
        </div>
      )}
    </div>
  )
}

function KPICard({ label, value, sub, icon: Icon, color }) {
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">{label}</p>
          <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
          {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
        </div>
        <div className={`p-2 rounded-lg ${color.replace('text-', 'bg-').replace('600', '100')}`}>
          <Icon className={`w-5 h-5 ${color}`} />
        </div>
      </div>
    </div>
  )
}

// ─── CSV Parser ────────────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split('\n')
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''))
  return lines.slice(1).map((line, i) => {
    const values = line.match(/(".*?"|[^,]+)/g) ?? []
    const obj = { id: `csv-${i}` }
    headers.forEach((h, idx) => {
      const val = (values[idx] ?? '').replace(/"/g, '').trim()
      if (h === 'budget') obj[h] = Number(val) || 0
      else if (h === 'objections') obj[h] = val ? val.split(';').map(s => s.trim()) : []
      else obj[h] = val
    })
    return obj
  })
}

// ─── Main App ─────────────────────────────────────────────────────────────────

const FILTERS = ['TODOS', 'HOT', 'WARM', 'COLD']

export default function App() {
  const [leads, setLeads] = useState(() => processLeads(sampleLeads))
  const [activeFilter, setActiveFilter] = useState('TODOS')
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState('score')
  const [dragging, setDragging] = useState(false)
  const [syncInfo, setSyncInfo] = useState(null)   // { syncedAt, sources, totalMerged }
  const [accountFilter, setAccountFilter] = useState('TODOS')
  const [syncing, setSyncing] = useState(false)

  // URL del API — en prod usa /api/leads, en dev prueba el server local
  const API_URL = import.meta.env.VITE_API_URL || ''

  const fetchLiveLeads = useCallback(async () => {
    // Intentar /api/leads (server unificado en prod)
    let data = await fetch(`${API_URL}/api/leads?t=${Date.now()}`)
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)

    // Fallback: leads-live.json estático (dev local)
    if (!data) {
      data = await fetch(`/leads-live.json?t=${Date.now()}`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    }
    return data
  }, [API_URL])

  // Auto-carga al iniciar
  useEffect(() => {
    fetchLiveLeads().then(data => {
      if (!data?.leads?.length) return
      setLeads(processLeads(data.leads))
      setSyncInfo({ syncedAt: data.syncedAt, sources: data.sources, total: data.totalMerged })
      setActiveFilter('TODOS')
      setAccountFilter('TODOS')
    })
  }, [fetchLiveLeads])

  const handleManualSync = useCallback(() => {
    setSyncing(true)
    fetchLiveLeads()
      .then(data => {
        if (!data?.leads?.length) return
        setLeads(processLeads(data.leads))
        setSyncInfo({ syncedAt: data.syncedAt, sources: data.sources, total: data.totalMerged })
      })
      .finally(() => setSyncing(false))
  }, [fetchLiveLeads])

  const handleFileImport = useCallback((file) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        let raw
        if (file.name.endsWith('.json')) {
          raw = JSON.parse(e.target.result)
        } else if (file.name.endsWith('.csv')) {
          raw = parseCSV(e.target.result)
        } else {
          alert('Formato no soportado. Usá .json o .csv')
          return
        }
        setLeads(processLeads(Array.isArray(raw) ? raw : raw.leads ?? []))
        setActiveFilter('TODOS')
      } catch {
        alert('Error al parsear el archivo. Verificá el formato.')
      }
    }
    reader.readAsText(file)
  }, [])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFileImport(file)
  }, [handleFileImport])

  const handleExport = useCallback(() => {
    const data = JSON.stringify(leads, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `leads-scored-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [leads])

  const handleLoadSample = useCallback(() => {
    setLeads(processLeads(sampleLeads))
    setActiveFilter('TODOS')
    setAccountFilter('TODOS')
    setSyncInfo(null)
  }, [])

  const stats = useMemo(() => ({
    total: leads.length,
    hot:   leads.filter(l => l.category === 'HOT').length,
    warm:  leads.filter(l => l.category === 'WARM').length,
    cold:  leads.filter(l => l.category === 'COLD').length,
    avgScore: leads.length ? Math.round(leads.reduce((s, l) => s + l.score, 0) / leads.length) : 0,
  }), [leads])

  // Cuentas disponibles para filtrar
  const availableAccounts = useMemo(() => {
    const accounts = new Set(leads.map(l => l._lnm?.account).filter(Boolean))
    return [...accounts]
  }, [leads])

  const filtered = useMemo(() => {
    let list = leads
    if (activeFilter !== 'TODOS') list = list.filter(l => l.category === activeFilter)
    if (accountFilter !== 'TODOS') list = list.filter(l => l._lnm?.account === accountFilter)
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      list = list.filter(l =>
        l.name?.toLowerCase().includes(q) ||
        l.propertyInterest?.toLowerCase().includes(q) ||
        l.zone?.toLowerCase().includes(q) ||
        l.phone?.includes(q)
      )
    }
    if (sortBy === 'score') return [...list].sort((a, b) => b.score - a.score)
    if (sortBy === 'name')  return [...list].sort((a, b) => a.name.localeCompare(b.name))
    if (sortBy === 'recent') return [...list].sort((a, b) =>
      new Date(b.lastContact || 0) - new Date(a.lastContact || 0)
    )
    return list
  }, [leads, activeFilter, accountFilter, searchQuery, sortBy])

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top Bar */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <BarChart2 className="w-6 h-6 text-indigo-600" />
            <h1 className="text-lg font-bold text-gray-900">Lead Profiler</h1>
            <span className="text-xs text-gray-400 font-medium">Inmobiliario</span>
          </div>

          {/* Sync status */}
          {syncInfo ? (
            <div className="flex items-center gap-1.5 text-xs text-green-600 bg-green-50 border border-green-100 rounded-lg px-2.5 py-1">
              <Wifi className="w-3.5 h-3.5" />
              <span className="font-medium">Leadnamics live</span>
              <span className="text-green-400">·</span>
              <span className="text-green-500">
                {new Date(syncInfo.syncedAt).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}
              </span>
              {syncInfo.sources?.length > 0 && (
                <span className="text-green-400 ml-1">({syncInfo.sources.join(' + ')})</span>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs text-gray-400 bg-gray-50 border border-gray-100 rounded-lg px-2.5 py-1">
              <Database className="w-3.5 h-3.5" />
              <span>Datos de ejemplo</span>
            </div>
          )}

          <div className="ml-auto flex items-center gap-2 flex-wrap">
            {/* Sync manual */}
            <button
              onClick={handleManualSync}
              disabled={syncing}
              className="btn-filter border-green-200 bg-green-50 hover:bg-green-100 text-green-700 flex items-center gap-1.5 disabled:opacity-50"
              title="Recargar datos del cron"
            >
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
              Sync
            </button>
            <label className="btn-filter border-gray-200 bg-white hover:bg-gray-50 text-gray-700 cursor-pointer flex items-center gap-1.5">
              <Upload className="w-4 h-4" />
              Importar
              <input
                type="file"
                accept=".json,.csv"
                className="hidden"
                onChange={e => e.target.files[0] && handleFileImport(e.target.files[0])}
              />
            </label>
            <button
              onClick={handleLoadSample}
              className="btn-filter border-gray-200 bg-white hover:bg-gray-50 text-gray-700 flex items-center gap-1.5"
            >
              Demo
            </button>
            <button
              onClick={handleExport}
              className="btn-filter border-indigo-200 bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-1.5"
            >
              <Download className="w-4 h-4" />
              Exportar
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">

        {/* KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <KPICard label="Total Leads"   value={stats.total}    icon={Users}         color="text-gray-700" />
          <KPICard label="HOT"           value={stats.hot}      icon={Flame}         color="text-red-600"  sub="≥ 70 pts" />
          <KPICard label="WARM"          value={stats.warm}     icon={ThermometerSun} color="text-amber-600" sub="40-69 pts" />
          <KPICard label="COLD"          value={stats.cold}     icon={Snowflake}     color="text-blue-600" sub="< 40 pts" />
          <KPICard label="Score Promedio" value={stats.avgScore} icon={TrendingUp}   color="text-indigo-600" sub="de 100" />
        </div>

        {/* Drop Zone + Filters */}
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          {dragging && (
            <div className="fixed inset-0 bg-indigo-600/10 border-4 border-dashed border-indigo-400 z-50 flex items-center justify-center pointer-events-none">
              <div className="bg-white rounded-xl p-8 shadow-xl text-center">
                <Upload className="w-10 h-10 text-indigo-500 mx-auto mb-2" />
                <p className="text-lg font-semibold text-indigo-700">Soltá el archivo aquí</p>
                <p className="text-sm text-gray-400">JSON o CSV</p>
              </div>
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
            {/* Filter buttons */}
            <div className="flex gap-1.5 flex-wrap">
              {FILTERS.map(f => {
                const counts = { TODOS: stats.total, HOT: stats.hot, WARM: stats.warm, COLD: stats.cold }
                const isActive = activeFilter === f
                const colors = {
                  TODOS: isActive ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300',
                  HOT:   isActive ? 'bg-red-500 text-white border-red-500'   : 'bg-white text-red-600 border-red-200 hover:border-red-300',
                  WARM:  isActive ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-amber-600 border-amber-200 hover:border-amber-300',
                  COLD:  isActive ? 'bg-blue-500 text-white border-blue-500'  : 'bg-white text-blue-600 border-blue-200 hover:border-blue-300',
                }
                return (
                  <button
                    key={f}
                    onClick={() => setActiveFilter(f)}
                    className={`btn-filter ${colors[f]}`}
                  >
                    {f} <span className="ml-1 opacity-70 text-xs">({counts[f]})</span>
                  </button>
                )
              })}
            </div>

            {/* Search & Sort */}
            <div className="flex gap-2 ml-auto w-full sm:w-auto flex-wrap">
              {/* Filtro por cuenta */}
              {availableAccounts.length > 1 && (
                <select
                  value={accountFilter}
                  onChange={e => setAccountFilter(e.target.value)}
                  className="px-3 py-2 text-sm border border-indigo-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300 bg-white text-indigo-700 font-medium"
                >
                  <option value="TODOS">Todas las cuentas</option>
                  {availableAccounts.map(a => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              )}
              <input
                type="text"
                placeholder="Buscar lead..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="flex-1 sm:w-48 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
              />
              <select
                value={sortBy}
                onChange={e => setSortBy(e.target.value)}
                className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
              >
                <option value="score">Por score</option>
                <option value="recent">Más reciente</option>
                <option value="name">Por nombre</option>
              </select>
            </div>
          </div>
        </div>

        {/* Lead List */}
        <div className="space-y-2">
          {filtered.length === 0 ? (
            <div className="card p-12 text-center">
              <AlertCircle className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-400 font-medium">No se encontraron leads</p>
              <p className="text-sm text-gray-300 mt-1">Probá cambiando los filtros o importando un archivo</p>
            </div>
          ) : (
            filtered.map(lead => <LeadCard key={lead.id} lead={lead} />)
          )}
        </div>

        <p className="text-center text-xs text-gray-300 pb-4">
          Lead Profiler MVP · {filtered.length} de {leads.length} leads · Scores calculados localmente
        </p>
      </main>
    </div>
  )
}
