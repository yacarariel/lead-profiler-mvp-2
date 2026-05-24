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

// ─── Señales de conversación ───────────────────────────────────────────────────

const SIGNALS_POSITIVAS = [
  'interesad', 'quiere ver', 'quiero ver', 'visita', 'agend', 'confirm',
  'propuesta', 'comprar', 'compro', 'inversión', 'inversion', 'urgente',
  'listo', 'le gustó', 'le gusta', 'avanzar', 'negociac', 'muy bien',
  'sí quiere', 'si quiere', 'pidió info', 'pidio info', 'contactar',
]
const SIGNALS_NEGATIVAS = [
  'no interesa', 'no le interesa', 'no responde', 'no contesta', 'canceló',
  'cancelo', 'sin respuesta', 'no avanza', 'perdió', 'perdio', 'descartado',
  'no quiere', 'compró en', 'compro en', 'ya compró', 'ya tiene', 'no busca',
  'no puede', 'no está', 'no esta', 'fuera de presupuesto', 'muy caro',
  'no le gustó', 'no le gusto', 'no es lo que', 'arrepintió', 'arrepintio',
  // señales directas del cliente en conversación
  'no me sirve', 'no me va', 'nada de lo que', 'olvidate',
  'no necesito', 'ya resolví', 'ya resolvio',
  'no busco más', 'no busco mas', 'ya compré', 'ya compre',
  'gracias pero no', 'no aplica', 'no me conviene', 'me escapa',
]

// Señales de intención de visita (mensajes del cliente)
const VISIT_SIGNALS = [
  'visitar', 'visita', 'ver el depto', 'ver la unidad', 'ver el proyecto',
  'quiero ver', 'cuando puedo', 'cuándo puedo', 'me gustaría conocer',
  'puedo pasar', 'quiero ir', 'recorrido', 'showroom', 'ver en persona',
  'conocer el lugar', 'ir a ver', 'hacer una visita', 'puedo ir',
  'disponible para', 'agendar una', 'podemos reunirnos', 'reunión',
]

// Señales de intención de cierre
const CLOSE_SIGNALS = [
  'reserva', 'seña', 'señar', 'precio final', 'forma de pago', 'cuotas',
  'financiación', 'financiacion', 'hipoteca', 'crédito', 'credito',
  'escritura', 'boleto', 'firmar', 'quiero avanzar', 'me decido',
  'cuando empezamos', 'cómo sigo', 'como sigo', 'muy interesado',
  'me interesa mucho', 'lo quiero', 'cuánto hay que dar', 'que necesito para',
  'cuando hay que', 'lo tomamos', 'quiero reservar', 'para cerrar',
]

function analyzeConversation(notes, msgTexts) {
  // Analiza notas del agente + mensajes directos del cliente
  const text = [notes || '', msgTexts || ''].join(' ').toLowerCase()
  if (!text.trim()) return 0
  let signal = 0
  SIGNALS_POSITIVAS.forEach(kw => { if (text.includes(kw)) signal += 4 })
  SIGNALS_NEGATIVAS.forEach(kw => { if (text.includes(kw)) signal -= 8 })
  return Math.max(-40, Math.min(20, signal))
}

// ─── Potenciales de visita y cierre ───────────────────────────────────────────

function computePotentials(lnm, notes) {
  const ms = lnm?.msgStats
  // Texto combinado: mensajes del cliente + notas del agente
  const fullText = [ms?.texts || '', notes || ''].join(' ').toLowerCase()

  // Señales en texto
  const visitHits  = VISIT_SIGNALS.filter(kw => fullText.includes(kw))
  const closeHits  = CLOSE_SIGNALS.filter(kw => fullText.includes(kw))

  const visitFromText  = Math.min(40, visitHits.length  * 15)
  const closeFromText  = Math.min(40, closeHits.length  * 15)

  // Velocidad de respuesta del cliente (avgResponseMin = minutos que tarda el bot en responderle)
  // Lo que nos importa es qué tan activo está el cliente
  const clientCount = ms?.clientCount ?? 0
  const activityBonus = clientCount >= 8 ? 20 : clientCount >= 4 ? 12 : clientCount >= 2 ? 6 : 0

  // Recencia del último mensaje del cliente
  let recencyBonus = 0
  if (ms?.lastClientAt) {
    const daysSince = (Date.now() - new Date(ms.lastClientAt)) / 86_400_000
    recencyBonus = daysSince <= 1 ? 25 : daysSince <= 3 ? 18 : daysSince <= 7 ? 10 : daysSince <= 14 ? 4 : 0
  }

  // Profundidad de conversación (muchos mensajes = compromiso)
  const depthBonus = (ms?.total ?? 0) >= 15 ? 15 : (ms?.total ?? 0) >= 8 ? 8 : 0

  // Status bonus
  const statusKey = (lnm?.status || '').replace(/ /g, '_')
  const statusBonus = { 'Prioridad': 20, 'En_Contacto': 10, 'Seguimiento': 5 }[statusKey] ?? 0

  const visitPotential = Math.min(100, visitFromText + activityBonus + recencyBonus + depthBonus + statusBonus)
  const closePotential = Math.min(100, closeFromText + activityBonus + recencyBonus + depthBonus + statusBonus)

  return {
    visitPotential,
    closePotential,
    visitSignals: visitHits,
    closeSignals: closeHits,
    msgStats: ms,
  }
}

// Detecta si un lead fue descartado en Leadnamics por status o stage
// stageId 152 = "Descartado", 154 = "Expirado", 159 = "Descartado" en Leadnamics (confirmado empíricamente)
const DISCARDED_STAGE_IDS = new Set([152, 154, 159])

// endReasons que NO implican descarte — son handoffs positivos o cierres con compra
const POSITIVE_END_REASONS = [
  'se derivo al vendedor', 'se derivó al vendedor',
  'derivado al vendedor', 'derivado a vendedor',
  'vendedor asignado', 'asignado a vendedor',
  'compro', 'compró', 'compra realizada', 'venta cerrada',
  'cierre exitoso', 'reserva realizada',
]

function isPositiveEndReason(endReason) {
  if (!endReason) return false
  const normalized = endReason.toLowerCase().trim()
  return POSITIVE_END_REASONS.some(r => normalized.includes(r))
}

function detectDescartado(lnm) {
  // stageId es la fuente más confiable — si está en lista de descartados, es definitivo
  if (DISCARDED_STAGE_IDS.has(lnm?.stageId)) return true

  // endReason: ignorar si es un handoff positivo (ej: "Se derivó al vendedor")
  if (lnm?.endReason && !isPositiveEndReason(lnm.endReason)) return true

  // flag del bookmarklet (puede ser incorrecto para endReasons positivos — tolerar)
  if (lnm?.discarded === true && !isPositiveEndReason(lnm?.endReason)) return true

  const text = [lnm?.status, lnm?.stage, lnm?.funnelCol].filter(Boolean).join(' ').toLowerCase()
  return /descart|archiv|expir|no.interesa|sin.interes|cerrado.perdido|no.compra/.test(text)
}

// Status de Leadnamics → modificador de score
const STATUS_MODIFIER = {
  'Prioridad':      +12,
  'En_Contacto':    +5,
  'Seguimiento':    0,
  'Por_Contactar':  -5,
  'Descartado':     -60,
  'Archivado':      -50,
}

function processLeads(rawLeads) {
  return rawLeads.map(lead => {
    const { total: ourScore, breakdown } = calcScore(lead)
    const lnm = lead._lnm || {}

    // ── Detección de descarte / expirado ──────────────────────────────────────
    const isExpired   = lnm?.stageId === 154 ||
                        /expir/.test([lnm?.status, lnm?.stage].filter(Boolean).join(' ').toLowerCase())
    const isDiscarded = detectDescartado(lnm)

    if (isDiscarded) {
      const label = isExpired ? 'Expirado en Leadnamics' : 'Descartado en Leadnamics'
      return {
        ...lead,
        score: 0,
        ourScore,
        breakdown,
        category: 'COLD',
        isDiscarded: true,
        isExpired,
        scoreReason: label,
        recommendation: 'Lead inactivo. Sin acción requerida.',
      }
    }

    // ── Score combinado ────────────────────────────────────────────────────────
    // 60% score de Leadnamics (su modelo ML) + 40% nuestro algoritmo
    // + señales de conversación (notas) + modificador de status
    const lnmScore = lnm.score ?? null
    const conversationSignal = analyzeConversation(lead.notes, lead._lnm?.msgStats?.texts)
    const statusKey = (lnm.status || '').replace(/ /g, '_')
    const statusMod  = STATUS_MODIFIER[statusKey] ?? 0

    let finalScore
    let scoreReason

    if (lnmScore !== null && lnmScore > 0) {
      const base = Math.round(lnmScore * 0.6 + ourScore * 0.4)
      finalScore = Math.max(0, Math.min(100, base + conversationSignal + statusMod))
      scoreReason = `LNM ${lnmScore} + Nuestro ${ourScore} + Señales conversación`
    } else {
      // Sin score de Leadnamics → solo nuestro algoritmo + señales
      finalScore = Math.max(0, Math.min(100, ourScore + conversationSignal + statusMod))
      scoreReason = `Nuestro algoritmo ${ourScore} + Señales conversación`
    }

    const category = getCategory(finalScore)
    const potentials = computePotentials(lnm, lead.notes)

    return {
      ...lead,
      score: finalScore,
      ourScore,
      lnmScore,
      breakdown,
      category,
      isDiscarded: false,
      scoreReason,
      visitPotential:  potentials.visitPotential,
      closePotential:  potentials.closePotential,
      visitSignals:    potentials.visitSignals,
      closeSignals:    potentials.closeSignals,
      recommendation: getRecommendation(category, lead),
    }
  }).sort((a, b) => b.score - a.score)
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

// ─── UI Helpers ────────────────────────────────────────────────────────────────

const CATEGORY_STYLES = {
  HOT:  { badge: 'badge-hot',  icon: Flame,          bar: 'bg-red-500',   text: 'text-red-600',   bg: 'bg-red-50',   glow: '', stroke: '#ef4444', border: 'border-red-100'   },
  WARM: { badge: 'badge-warm', icon: ThermometerSun, bar: 'bg-amber-400', text: 'text-amber-600', bg: 'bg-amber-50', glow: '', stroke: '#f59e0b', border: 'border-amber-100' },
  COLD: { badge: 'badge-cold', icon: Snowflake,      bar: 'bg-blue-500',  text: 'text-blue-600',  bg: 'bg-blue-50',  glow: '', stroke: '#3b82f6', border: 'border-blue-100'  },
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
        <circle cx="24" cy="24" r="20" fill="none" stroke="#f3f4f6" strokeWidth="3.5" />
        <circle
          cx="24" cy="24" r="20" fill="none"
          stroke={style.stroke}
          strokeWidth="3.5"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-700"
          style={{ filter: `drop-shadow(0 0 4px ${style.stroke}88)` }}
        />
      </svg>
      <span className={`absolute text-sm font-bold ${style.text}`}>{score}</span>
    </div>
  )
}

function ScoreBar({ value, max, color }) {
  const pct = (value / max) * 100
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-gray-100 rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full ${color} transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs font-mono text-gray-400 w-8 text-right">{value}/{max}</span>
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

  const accentColor = lead.isDiscarded
    ? 'border-l-gray-200'
    : { HOT: 'border-l-red-400', WARM: 'border-l-amber-400', COLD: 'border-l-blue-400' }[lead.category]

  return (
    <div className={`card overflow-hidden border-l-2 ${accentColor}`}>
      {/* Header row */}
      <div
        className="flex items-center gap-4 p-4 cursor-pointer select-none"
        onClick={() => setExpanded(e => !e)}
      >
        <ScoreCircle score={lead.score} category={lead.category} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-gray-900 truncate">{lead.name}</h3>
            {lead._lnm?.id && (
              <span className="text-[10px] font-mono text-gray-400 shrink-0 bg-gray-100 px-1.5 py-0.5 rounded">#{lead._lnm.id}</span>
            )}
            {lead.isDiscarded ? (
              lead.isExpired ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-orange-50 text-orange-500 border border-orange-200">
                  <Clock className="w-3 h-3" /> Expirado
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-500 border border-gray-200">
                  <XCircle className="w-3 h-3" /> Descartado
                </span>
              )
            ) : (
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${style.badge}`}>
                <Icon className="w-3 h-3" />
                {lead.category}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-500 truncate mt-0.5">{lead.propertyInterest}</p>
          <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-400 flex-wrap">
            {lead.budget > 0 && <span>${lead.budget.toLocaleString()}</span>}
            {lead.urgency && <span>{URGENCY_LABELS[lead.urgency] ?? lead.urgency}</span>}
            {daysSince !== null && (
              <span className={daysSince <= 2 ? 'text-emerald-600' : daysSince > 14 ? 'text-red-400' : 'text-gray-400'}>
                {daysSince === 0 ? 'Hoy' : daysSince === 1 ? 'Ayer' : `${daysSince}d atrás`}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 ml-auto flex-shrink-0">
          {/* Potenciales — solo en leads activos con datos */}
          {!lead.isDiscarded && (lead.visitPotential > 0 || lead.closePotential > 0) && (
            <div className="hidden sm:flex flex-col gap-1 w-24">
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] text-gray-400 w-9 text-right">Visita</span>
                <div className="flex-1 bg-gray-100 rounded-full h-1">
                  <div className="h-1 rounded-full bg-violet-400 transition-all" style={{width:`${lead.visitPotential}%`}} />
                </div>
                <span className="text-[9px] font-mono text-gray-400 w-5">{lead.visitPotential}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] text-gray-400 w-9 text-right">Cierre</span>
                <div className="flex-1 bg-gray-100 rounded-full h-1">
                  <div className="h-1 rounded-full bg-emerald-400 transition-all" style={{width:`${lead.closePotential}%`}} />
                </div>
                <span className="text-[9px] font-mono text-gray-400 w-5">{lead.closePotential}</span>
              </div>
            </div>
          )}
          <span className={`text-sm font-bold font-mono ${lead.isDiscarded ? 'text-gray-400' : style.text}`}>
            {lead.score}<span className="text-[10px] font-normal text-gray-400">/100</span>
          </span>
          {expanded
            ? <ChevronUp className="w-4 h-4 text-gray-400" />
            : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </div>
      </div>

      {/* Expanded panel */}
      {expanded && (
        <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-4">

          {/* Score breakdown */}
          <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">Score breakdown</p>
              <div className="flex items-center gap-1.5 text-[10px] flex-wrap font-mono">
                {lead.lnmScore != null && (
                  <span className="px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600 border border-indigo-100">
                    LNM {lead.lnmScore}
                  </span>
                )}
                {lead.ourScore != null && (
                  <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 border border-gray-200">
                    LOCAL {lead.ourScore}
                  </span>
                )}
                {lead._lnm?.stage && (
                  <span className="text-gray-400">{lead._lnm.stage}</span>
                )}
                {lead._lnm?.account && (
                  <span className="px-1.5 py-0.5 rounded bg-violet-50 text-violet-600 border border-violet-100">
                    {lead._lnm.account}
                  </span>
                )}
              </div>
            </div>
            <div className="space-y-2.5">
              {Object.entries(SCORE_LABELS).map(([key, { label, icon: LabelIcon, max }]) => (
                <div key={key} className="grid grid-cols-[110px_1fr] items-center gap-2">
                  <div className="flex items-center gap-1.5 text-[10px] text-gray-500 uppercase tracking-wide">
                    <LabelIcon className="w-3 h-3 text-gray-400" />
                    {label}
                  </div>
                  <ScoreBar value={lead.breakdown[key]} max={max} color={style.bar} />
                </div>
              ))}
            </div>
          </div>

          {/* Objeciones */}
          {lead.objections?.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-2">Objeciones</p>
              <div className="flex flex-wrap gap-1.5">
                {lead.objections.map((obj, i) => (
                  <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-50 text-red-600 border border-red-100 text-[10px]">
                    <XCircle className="w-3 h-3" /> {obj}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Info grid */}
          <div className="grid grid-cols-2 gap-2">
            {lead.phone && (
              <div className="flex items-center gap-1.5 text-xs text-gray-600 bg-gray-50 rounded-lg px-2.5 py-2 border border-gray-100">
                <span className="text-gray-400">📱</span>
                <span className="font-mono">{lead.phone}</span>
                {lead._lnm?.id && <span className="text-[10px] text-gray-400 ml-1">#{lead._lnm.id}</span>}
              </div>
            )}
            {lead.source && (
              <div className="flex items-center gap-1.5 text-xs text-gray-600 bg-gray-50 rounded-lg px-2.5 py-2 border border-gray-100">
                <span className="text-gray-400">📌</span> {lead.source}
              </div>
            )}
            {lead.engagement && (
              <div className="flex items-center gap-1.5 text-xs text-gray-600 bg-gray-50 rounded-lg px-2.5 py-2 border border-gray-100">
                <CheckCircle className="w-3.5 h-3.5 text-gray-400" />
                {ENGAGEMENT_LABELS[lead.engagement] ?? lead.engagement}
              </div>
            )}
            {lead.zone && (
              <div className="flex items-center gap-1.5 text-xs text-gray-600 bg-gray-50 rounded-lg px-2.5 py-2 border border-gray-100">
                <span className="text-gray-400">📍</span> {lead.zone}
              </div>
            )}
          </div>

          {/* Notes */}
          {lead.notes && (
            <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">Notas</p>
              <p className="text-xs text-gray-500 italic leading-relaxed">"{lead.notes}"</p>
            </div>
          )}

          {/* Status / Razón de cierre */}
          {lead._lnm?.endReason && (
            isPositiveEndReason(lead._lnm.endReason) ? (
              <div className="rounded-lg p-3 bg-indigo-50 border border-indigo-100 flex items-center gap-2">
                <CheckCircle className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-widest mb-0.5 text-indigo-500">Status</p>
                  <p className="text-xs text-indigo-700 font-medium">{lead._lnm.endReason}</p>
                </div>
              </div>
            ) : (
              <div className="rounded-lg p-3 bg-orange-50 border border-orange-100">
                <p className="text-[10px] font-semibold uppercase tracking-widest mb-1 text-orange-500">Razón de cierre</p>
                <p className="text-xs text-gray-600">{lead._lnm.endReason}</p>
              </div>
            )
          )}

          {/* Potenciales de visita y cierre */}
          {!lead.isDiscarded && (lead.visitPotential > 0 || lead.closePotential > 0) && (
            <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
              <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-3">Análisis de conversación</p>
              <div className="grid grid-cols-2 gap-3">
                {/* Visita */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium text-violet-600">🏠 Potencial visita</span>
                    <span className="text-xs font-bold font-mono text-violet-600">{lead.visitPotential}%</span>
                  </div>
                  <div className="bg-gray-200 rounded-full h-1.5">
                    <div className="h-1.5 rounded-full bg-violet-400 transition-all" style={{width:`${lead.visitPotential}%`}} />
                  </div>
                  {lead.visitSignals?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {lead.visitSignals.slice(0,3).map((s,i) => (
                        <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-600 border border-violet-100">{s}</span>
                      ))}
                    </div>
                  )}
                </div>
                {/* Cierre */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium text-emerald-600">🤝 Potencial cierre</span>
                    <span className="text-xs font-bold font-mono text-emerald-600">{lead.closePotential}%</span>
                  </div>
                  <div className="bg-gray-200 rounded-full h-1.5">
                    <div className="h-1.5 rounded-full bg-emerald-400 transition-all" style={{width:`${lead.closePotential}%`}} />
                  </div>
                  {lead.closeSignals?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {lead.closeSignals.slice(0,3).map((s,i) => (
                        <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 border border-emerald-100">{s}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {/* Stats de mensajes */}
              {lead._lnm?.msgStats && (
                <div className="flex gap-3 mt-3 pt-3 border-t border-gray-200 text-[10px] text-gray-500 font-mono">
                  <span>💬 {lead._lnm.msgStats.total} mensajes</span>
                  <span>👤 {lead._lnm.msgStats.clientCount} del cliente</span>
                  {lead._lnm.msgStats.avgResponseMin != null && (
                    <span>⚡ respuesta promedio: {lead._lnm.msgStats.avgResponseMin < 60
                      ? `${lead._lnm.msgStats.avgResponseMin}min`
                      : `${Math.round(lead._lnm.msgStats.avgResponseMin/60)}h`}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Recommendation */}
          {!lead.isDiscarded && (
            <div className={`rounded-lg p-3 ${style.bg} border ${style.border}`}>
              <p className={`text-[10px] font-semibold uppercase tracking-widest mb-1 ${style.text}`}>
                Recomendación IA
              </p>
              <p className="text-xs text-gray-700 leading-relaxed">{lead.recommendation}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function KPICard({ label, value, sub, icon: Icon, color }) {
  const iconBg = color.replace('text-', 'bg-').replace(/\d+/, '100')
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-widest">{label}</p>
          <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
          {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}
        </div>
        <div className={`p-2 rounded-lg ${iconBg}`}>
          <Icon className={`w-4 h-4 ${color}`} />
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

// ─── Server URL helper ────────────────────────────────────────────────────────

// En dev, el server corre en :3001 independientemente de Vite (:5173)
// En prod, todo está en el mismo puerto → usamos rutas relativas
const SERVER_URL = import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV ? 'http://localhost:3001' : '')

// ─── Login Screen ─────────────────────────────────────────────────────────────

function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const r = await fetch(`${SERVER_URL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error || 'Credenciales incorrectas'); return }
      localStorage.setItem('lp_token',    d.token)
      localStorage.setItem('lp_username', d.username)
      localStorage.setItem('lp_role',     d.role)
      onLogin(d)
    } catch {
      setError('No se puede conectar al servidor. ¿Está corriendo npm run server?')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="relative w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/30">
            <svg viewBox="0 0 20 20" fill="none" className="w-5 h-5">
              <circle cx="10" cy="10" r="2.5" fill="white" />
              <path d="M10 3 L10 7" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M10 13 L10 17" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M3 10 L7 10" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M13 10 L17 10" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-white font-bold text-xl tracking-tight">LeadProfiler</span>
              <span className="text-indigo-400 text-[10px] font-semibold uppercase tracking-widest">AI</span>
            </div>
            <p className="text-gray-500 text-[10px]">Real Estate Intelligence</p>
          </div>
        </div>

        {/* Card */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 shadow-2xl">
          <h2 className="text-white font-semibold text-base mb-1">Iniciar sesión</h2>
          <p className="text-gray-500 text-xs mb-5">Acceso restringido a usuarios autorizados</p>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">
                Usuario
              </label>
              <input
                type="text"
                autoComplete="username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
                className="w-full px-3 py-2.5 text-sm bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
                placeholder="tu usuario"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-widest mb-1.5">
                Contraseña
              </label>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                className="w-full px-3 py-2.5 text-sm bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div className="flex items-center gap-2 px-3 py-2 bg-red-950 border border-red-800 rounded-lg">
                <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                <p className="text-xs text-red-400">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg transition shadow-lg shadow-indigo-500/20 mt-1"
            >
              {loading ? 'Verificando...' : 'Ingresar'}
            </button>
          </form>
        </div>

        <p className="text-center text-[10px] text-gray-700 mt-4">
          Lead Profiler AI · acceso privado
        </p>
      </div>
    </div>
  )
}

// ─── Main App ─────────────────────────────────────────────────────────────────

const FILTERS = ['TODOS', 'HOT', 'WARM', 'COLD']

export default function App() {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const [session, setSession] = useState(() => {
    const token    = localStorage.getItem('lp_token')
    const username = localStorage.getItem('lp_username')
    const role     = localStorage.getItem('lp_role')
    return token ? { token, username, role } : null
  })

  const handleLogin = (data) => setSession(data)
  const handleLogout = () => {
    localStorage.removeItem('lp_token')
    localStorage.removeItem('lp_username')
    localStorage.removeItem('lp_role')
    setSession(null)
  }

  const [leads, setLeads] = useState(() => processLeads(sampleLeads))
  const [activeFilter, setActiveFilter] = useState('TODOS')
  const [searchQuery, setSearchQuery] = useState('')
  const [sortBy, setSortBy] = useState('score')
  const [dragging, setDragging] = useState(false)
  const [syncInfo, setSyncInfo] = useState(null)   // { syncedAt, sources, totalMerged }
  const [accountFilter, setAccountFilter] = useState('TODOS')
  const [syncing, setSyncing] = useState(false)
  const [pullStatus, setPullStatus] = useState(null)   // estado del pull server-side
  const [projectFilter, setProjectFilter] = useState('TODOS')
  const [hideInactive, setHideInactive] = useState(true)
  const [daysFilter, setDaysFilter] = useState(null)   // null | 10 | 30 | 60
  const [serverOnline, setServerOnline] = useState(false)
  const [accountsReady, setAccountsReady] = useState([])  // cuentas con token registrado

  const [tokenBanner, setTokenBanner] = useState(null)  // { account } cuando se acaba de registrar

  // Detectar token de Leadnamics en URL params (viene del bookmarklet via window.open)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const lnmToken     = params.get('lnm_token')
    const lnmAccount   = params.get('lnm_account')
    const lnmProjectId = params.get('lnm_projectId')
    if (!lnmToken || !lnmAccount) return

    // Limpiar URL inmediatamente (el token no debe quedar en historial)
    window.history.replaceState({}, '', '/')

    // Registrar en el server (localhost → localhost, sin Chrome PNA blocking)
    fetch(`${SERVER_URL}/api/register-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: lnmAccount, token: lnmToken, projectId: lnmProjectId }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          setTokenBanner(lnmAccount)
          setAccountsReady(prev => [...new Set([...prev, lnmAccount])])
          setTimeout(() => setTokenBanner(null), 8000)
        }
      })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Ping server cada 15 segundos + verificar cuentas registradas
  useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch(`${SERVER_URL}/api/status`, { signal: AbortSignal.timeout(3000) })
        if (r.ok) {
          const data = await r.json()
          setServerOnline(true)
          setAccountsReady(data.accountsReady || [])
        } else {
          setServerOnline(false)
        }
      } catch {
        setServerOnline(false)
      }
    }
    check()
    const id = setInterval(check, 15_000)
    return () => clearInterval(id)
  }, [])

  const fetchLiveLeads = useCallback(async () => {
    const authHeaders = session?.token
      ? { Authorization: `Bearer ${session.token}` }
      : {}

    // Intentar /api/leads (server unificado en prod)
    let data = await fetch(`${SERVER_URL}/api/leads?t=${Date.now()}`, { headers: authHeaders })
      .then(r => {
        if (r.status === 401) { handleLogout(); return null }
        return r.ok ? r.json() : null
      })
      .catch(() => null)

    // Fallback: leads-live.json estático (dev local, sin auth)
    if (!data) {
      data = await fetch(`/leads-live.json?t=${Date.now()}`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    }
    return data
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token])

  // Auto-carga al iniciar
  useEffect(() => {
    fetchLiveLeads().then(data => {
      if (!data?.leads?.length) return
      setLeads(processLeads(data.leads))
      setSyncInfo({ syncedAt: data.syncedAt, sources: data.sources, total: data.totalMerged })
      setActiveFilter('TODOS')
      setAccountFilter('TODOS')
      setProjectFilter('TODOS')
    })
  }, [fetchLiveLeads])

  // Polling del estado del pull — corre mientras el pull está activo
  const pollPullStatus = useCallback(async () => {
    const r = await fetch(`${SERVER_URL}/api/pull/status`, {
      headers: session?.token ? { Authorization: `Bearer ${session.token}` } : {},
    }).then(r => r.ok ? r.json() : null).catch(() => null)
    if (!r) return

    setPullStatus(r)

    if (r.running) {
      // Seguir polleando cada 2 segundos mientras corre
      setTimeout(pollPullStatus, 2000)
    } else if (r.done && !r.error) {
      // Terminó OK — recargar leads
      setSyncing(false)
      fetchLiveLeads().then(data => {
        if (!data?.leads?.length) return
        setLeads(processLeads(data.leads))
        setSyncInfo({ syncedAt: data.syncedAt, sources: data.sources, total: data.totalMerged })
      })
      // Limpiar el estado después de 4s
      setTimeout(() => setPullStatus(null), 4000)
    } else if (r.done && r.error) {
      setSyncing(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token, fetchLiveLeads])

  const handleManualSync = useCallback(async () => {
    if (syncing) return
    setSyncing(true)
    setPullStatus({ running: false, progress: 0, step: 'Conectando...' })

    try {
      // Intentar pull server-side desde Leadnamics
      const resp = await fetch(`${SERVER_URL}/api/pull`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
        },
      })
      const r = await resp.json()

      if (r?.ok) {
        // Pull iniciado en el server — empezar polling
        setPullStatus({ running: true, progress: 2, step: 'Iniciando sincronización con Leadnamics...' })
        setTimeout(pollPullStatus, 1500)
        return  // no llamar setSyncing(false) acá — lo hace pollPullStatus
      }

      // Error del server — mostrarlo visiblemente
      const errMsg = r?.error || 'Error desconocido al iniciar el sync'
      const needsBookmarklet = errMsg.includes('No hay cuentas') || errMsg.includes('token')
      setPullStatus({
        running: false,
        done: true,
        error: needsBookmarklet
          ? '⚠️ Ejecutá el bookmarklet primero para registrar el token de Leadnamics. Solo necesitás hacerlo una vez (o cuando expire el token).'
          : errMsg,
      })

    } catch {
      // Server no disponible — intentar leer datos existentes
      const data = await fetchLiveLeads()
      if (data?.leads?.length) {
        setLeads(processLeads(data.leads))
        setSyncInfo({ syncedAt: data.syncedAt, sources: data.sources, total: data.totalMerged })
        setPullStatus(null)
      } else {
        setPullStatus({ running: false, done: true, error: 'Server no disponible. ¿Está corriendo npm run server?' })
      }
    } finally {
      setSyncing(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing, session?.token, fetchLiveLeads, pollPullStatus])

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
    setProjectFilter('TODOS')
    setSyncInfo(null)
  }, [])

  // Lista base: inactivos filtrados + filtro de días — base para los contadores de categoría
  const baseList = useMemo(() => {
    let list = hideInactive ? leads.filter(l => !l.isDiscarded) : leads
    if (daysFilter) {
      const cutoff = Date.now() - daysFilter * 86_400_000
      list = list.filter(l => l.lastContact ? new Date(l.lastContact) >= cutoff : false)
    }
    return list
  }, [leads, hideInactive, daysFilter])

  const stats = useMemo(() => ({
    total: baseList.length,
    hot:   baseList.filter(l => l.category === 'HOT').length,
    warm:  baseList.filter(l => l.category === 'WARM').length,
    cold:  baseList.filter(l => l.category === 'COLD').length,
    avgScore: baseList.length ? Math.round(baseList.reduce((s, l) => s + l.score, 0) / baseList.length) : 0,
  }), [baseList])

  // Cuentas disponibles para filtrar
  const availableAccounts = useMemo(() => {
    const accounts = new Set(leads.map(l => l._lnm?.account).filter(Boolean))
    return [...accounts]
  }, [leads])

  // Proyectos disponibles: solo _lnm.project (campo limpio del bookmarklet)
  const availableProjects = useMemo(() => {
    const source = accountFilter === 'TODOS'
      ? leads
      : leads.filter(l => l._lnm?.account === accountFilter)
    const projects = new Set(source.map(l => l._lnm?.project).filter(Boolean))
    return [...projects].sort()
  }, [leads, accountFilter])

  const filtered = useMemo(() => {
    let list = baseList   // ya tiene hideInactive y daysFilter aplicados
    if (activeFilter !== 'TODOS') list = list.filter(l => l.category === activeFilter)
    if (accountFilter !== 'TODOS') list = list.filter(l => l._lnm?.account === accountFilter)
    if (projectFilter !== 'TODOS') list = list.filter(l => l._lnm?.project === projectFilter)
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
  }, [baseList, activeFilter, accountFilter, projectFilter, searchQuery, sortBy])

  // Auth gate — si no hay sesión y el server está online, pedir login
  if (!session && serverOnline) {
    return <LoginScreen onLogin={handleLogin} />
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top Bar */}
      <header className="bg-gray-950 border-b border-gray-800 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3 flex-wrap">

          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <div className="relative flex items-center justify-center w-8 h-8">
              <div className="absolute inset-0 rounded-lg bg-indigo-500 opacity-20 blur-sm" />
              <div className="relative w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/30">
                <svg viewBox="0 0 20 20" fill="none" className="w-4 h-4">
                  <circle cx="10" cy="10" r="2.5" fill="white" />
                  <path d="M10 3 L10 7" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M10 13 L10 17" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M3 10 L7 10" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M13 10 L17 10" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M5.1 5.1 L7.9 7.9" stroke="white" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
                  <path d="M12.1 12.1 L14.9 14.9" stroke="white" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
                  <path d="M14.9 5.1 L12.1 7.9" stroke="white" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
                  <path d="M7.9 12.1 L5.1 14.9" stroke="white" strokeWidth="1.2" strokeLinecap="round" opacity="0.6" />
                </svg>
              </div>
            </div>
            <div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-white font-bold text-base tracking-tight">LeadProfiler</span>
                <span className="text-indigo-400 text-[10px] font-semibold uppercase tracking-widest">AI</span>
              </div>
              <p className="text-gray-500 text-[10px] leading-none tracking-wide">Real Estate Intelligence</p>
            </div>
          </div>

          {/* Sync / connection status pill */}
          {syncInfo ? (
            <div className="flex items-center gap-1.5 text-xs bg-emerald-950 border border-emerald-800 text-emerald-400 rounded-full px-3 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="font-medium">Live</span>
              <span className="text-emerald-600">·</span>
              <span>
                {new Date(syncInfo.syncedAt).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}
              </span>
              {syncInfo.sources?.length > 0 && (
                <span className="text-emerald-600 ml-0.5">· {syncInfo.sources.join(' + ')}</span>
              )}
            </div>
          ) : serverOnline ? (
            <div className="flex items-center gap-1.5 text-xs bg-emerald-950 border border-emerald-800 text-emerald-500 rounded-full px-3 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span>Online</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-xs bg-gray-900 border border-gray-700 text-gray-500 rounded-full px-3 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-gray-600" />
              <span>Sin conexión</span>
            </div>
          )}

          <div className="ml-auto flex items-center gap-2 flex-wrap">
            {/* Usuario logueado */}
            {session?.username && (
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-gray-500 hidden sm:inline">{session.username}</span>
                <button
                  onClick={handleLogout}
                  className="text-[10px] px-2 py-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition"
                  title="Cerrar sesión"
                >
                  Salir
                </button>
              </div>
            )}
            {/* Sync manual */}
            <button
              onClick={handleManualSync}
              disabled={syncing}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors disabled:opacity-40 ${
                accountsReady.length > 0
                  ? 'border-emerald-700 bg-emerald-950 hover:bg-emerald-900 text-emerald-400'
                  : 'border-yellow-700 bg-yellow-950 hover:bg-yellow-900 text-yellow-400'
              }`}
              title={
                accountsReady.length > 0
                  ? `Sync desde Leadnamics (${accountsReady.join(', ')})`
                  : 'Sin token — ejecutá el bookmarklet primero'
              }
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              {syncing
                ? 'Sincronizando...'
                : accountsReady.length > 0
                  ? `Sync (${accountsReady.join(' + ')})`
                  : 'Sync ⚠️'}
            </button>
            <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-700 bg-gray-900 hover:bg-gray-800 text-gray-300 transition-colors cursor-pointer">
              <Upload className="w-3.5 h-3.5" />
              Importar
              <input
                type="file"
                accept=".json,.csv"
                className="hidden"
                onChange={e => e.target.files[0] && handleFileImport(e.target.files[0])}
              />
            </label>
            <button
              onClick={handleExport}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition-colors shadow-lg shadow-indigo-500/20"
            >
              <Download className="w-3.5 h-3.5" />
              Exportar
            </button>
          </div>
        </div>
      </header>

      {/* Token registrado banner */}
      {tokenBanner && (
        <div className="bg-emerald-950 border-b border-emerald-800 px-4 py-2">
          <div className="max-w-5xl mx-auto flex items-center gap-2 text-xs text-emerald-400">
            <CheckCircle className="w-3.5 h-3.5 shrink-0" />
            <span>
              <span className="font-semibold">Token de Leadnamics registrado</span> para cuenta <span className="font-mono bg-emerald-900 px-1.5 py-0.5 rounded">{tokenBanner}</span> — ahora hacé click en <span className="font-semibold">Sync</span> para traer todos los leads.
            </span>
            <button onClick={() => setTokenBanner(null)} className="ml-auto text-emerald-700 hover:text-emerald-500">×</button>
          </div>
        </div>
      )}

      {/* Pull progress bar */}
      {pullStatus && (
        <div className="bg-gray-950 border-b border-gray-800 px-4 py-2">
          <div className="max-w-5xl mx-auto">
            {pullStatus.error ? (
              <div className="flex items-center gap-2 text-xs text-red-400">
                <XCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{pullStatus.error}</span>
                <button onClick={() => setPullStatus(null)} className="ml-auto text-gray-600 hover:text-gray-400">×</button>
              </div>
            ) : pullStatus.done ? (
              <div className="flex items-center gap-2 text-xs text-emerald-400">
                <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                <span>Sync completo — {pullStatus.result?.total} leads, {pullStatus.result?.msgsFetched} conversaciones leídas</span>
              </div>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[10px] text-gray-400">
                  <span className="flex items-center gap-1.5">
                    <RefreshCw className="w-3 h-3 animate-spin text-indigo-400" />
                    {pullStatus.step || 'Sincronizando con Leadnamics...'}
                  </span>
                  <span className="font-mono text-indigo-400">{pullStatus.progress ?? 0}%</span>
                </div>
                <div className="w-full bg-gray-800 rounded-full h-1">
                  <div
                    className="h-1 rounded-full bg-indigo-500 transition-all duration-500"
                    style={{ width: `${pullStatus.progress ?? 0}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">

        {/* KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <KPICard label="Total Leads"    value={stats.total}    icon={Users}          color="text-gray-600" />
          <KPICard label="HOT"            value={stats.hot}      icon={Flame}          color="text-red-600"    sub="≥ 70 pts" />
          <KPICard label="WARM"           value={stats.warm}     icon={ThermometerSun} color="text-amber-600"  sub="40-69 pts" />
          <KPICard label="COLD"           value={stats.cold}     icon={Snowflake}      color="text-blue-600"   sub="< 40 pts" />
          <KPICard label="Score Promedio" value={stats.avgScore} icon={TrendingUp}     color="text-indigo-600" sub="de 100" />
        </div>

        {/* Drop Zone + Filters */}
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          {dragging && (
            <div className="fixed inset-0 bg-indigo-500/5 border-2 border-dashed border-indigo-500/40 z-50 flex items-center justify-center pointer-events-none">
              <div className="bg-[#0f0f1a] border border-indigo-500/30 rounded-xl p-8 shadow-2xl text-center">
                <Upload className="w-8 h-8 text-indigo-400 mx-auto mb-2" />
                <p className="text-sm font-semibold text-indigo-300">Soltá el archivo aquí</p>
                <p className="text-xs text-gray-600 mt-1">JSON o CSV</p>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {/* Fila 1: categorías + búsqueda */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex gap-1">
                {FILTERS.map(f => {
                  const counts = { TODOS: stats.total, HOT: stats.hot, WARM: stats.warm, COLD: stats.cold }
                  const isActive = activeFilter === f
                  const colors = {
                    TODOS: isActive ? 'bg-gray-800 text-white border-gray-800'             : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300',
                    HOT:   isActive ? 'bg-red-500 text-white border-red-500'               : 'bg-white text-red-600 border-red-200 hover:border-red-300',
                    WARM:  isActive ? 'bg-amber-500 text-white border-amber-500'           : 'bg-white text-amber-600 border-amber-200 hover:border-amber-300',
                    COLD:  isActive ? 'bg-blue-500 text-white border-blue-500'             : 'bg-white text-blue-600 border-blue-200 hover:border-blue-300',
                  }
                  return (
                    <button
                      key={f}
                      onClick={() => setActiveFilter(f)}
                      className={`btn-filter ${colors[f]}`}
                    >
                      {f} <span className="ml-1 opacity-60 text-[10px]">{counts[f]}</span>
                    </button>
                  )
                })}
              </div>
              <input
                type="text"
                placeholder="Buscar nombre, teléfono..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="ml-auto w-52 px-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-200 bg-white text-gray-700 placeholder-gray-400"
              />
            </div>

            {/* Fila 2: filtros secundarios */}
            <div className="flex items-center gap-2 flex-wrap">
              {availableAccounts.length > 1 && (
                <select
                  value={accountFilter}
                  onChange={e => { setAccountFilter(e.target.value); setProjectFilter('TODOS') }}
                  className="px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none bg-white text-gray-600"
                >
                  <option value="TODOS">Todas las cuentas</option>
                  {availableAccounts.map(a => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              )}
              {availableProjects.length > 0 && (
                <select
                  value={projectFilter}
                  onChange={e => setProjectFilter(e.target.value)}
                  className="px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none bg-white text-gray-600 max-w-[200px]"
                >
                  <option value="TODOS">Todos los proyectos</option>
                  {availableProjects.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              )}
              <button
                onClick={() => setHideInactive(h => !h)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                  hideInactive
                    ? 'bg-white text-gray-400 border-gray-200 hover:border-gray-300 hover:text-gray-600'
                    : 'bg-gray-800 text-white border-gray-800'
                }`}
              >
                <XCircle className="w-3 h-3" />
                {hideInactive ? 'Mostrar inactivos' : 'Ocultar inactivos'}
              </button>

              {/* Filtro por recencia */}
              <div className="flex items-center gap-0.5 ml-auto">
                <span className="text-[10px] text-gray-400 mr-1 hidden sm:inline">Últimos</span>
                {[10, 30, 60].map(d => (
                  <button
                    key={d}
                    onClick={() => setDaysFilter(prev => prev === d ? null : d)}
                    className={`px-2.5 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                      daysFilter === d
                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm shadow-indigo-200'
                        : 'bg-white text-gray-500 border-gray-200 hover:border-indigo-300 hover:text-indigo-600'
                    }`}
                    title={`Últimos ${d} días`}
                  >
                    {d}d
                  </button>
                ))}
                {daysFilter && (
                  <button
                    onClick={() => setDaysFilter(null)}
                    className="ml-1 px-2 py-1.5 text-[10px] text-gray-400 hover:text-gray-600 transition-colors"
                    title="Ver todos los períodos"
                  >
                    ×
                  </button>
                )}
              </div>

              <select
                value={sortBy}
                onChange={e => setSortBy(e.target.value)}
                className="px-2.5 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none bg-white text-gray-600"
              >
                <option value="score">Score ↓</option>
                <option value="recent">Reciente ↓</option>
                <option value="name">Nombre A-Z</option>
              </select>
            </div>
          </div>
        </div>

        {/* Lead List */}
        <div className="space-y-2">
          {filtered.length === 0 ? (
            <div className="card p-12 text-center">
              <AlertCircle className="w-8 h-8 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500 font-medium text-sm">Sin resultados</p>
              <p className="text-xs text-gray-400 mt-1">Cambiá los filtros o sincronizá con Leadnamics</p>
            </div>
          ) : (
            filtered.map(lead => <LeadCard key={lead.id} lead={lead} />)
          )}
        </div>

        <p className="text-center text-[10px] text-gray-400 pb-4">
          LeadProfiler AI · {filtered.length} de {leads.length} leads · scores calculados localmente
        </p>
      </main>
    </div>
  )
}
