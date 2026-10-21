import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Flow, GateRecord, Health, Panel, Phase, PlannedTask } from '../types'

const flow = atom({ plugin: 'savvy-progress', key: 'flow' } as const, null)
const agents = atom({ plugin: 'savvy-progress', key: 'agents' } as const, [])
const panel = atom({ plugin: 'savvy-progress', key: 'panel' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  autoOpenedFor: '',
})
const now = atom({ plugin: 'savvy-progress', key: 'now' } as const, 0)
const skillsUsed = atom({ plugin: 'savvy-progress', key: 'skills' } as const, [])

const TOOL = 'mcp__savvy-progress__progress'
const STEP_TOOL = 'mcp__savvy-progress__step'
const PANE = 'savvy-agents'
const PHASES: readonly Phase[] = ['plan', 'design', 'delegate', 'review', 'close']
const ACCENT = '#8f8cf4'
const DONE = '#5fbf8f'

type ProgressInput = {
  title?: string
  total?: number
  done?: number
  phase?: Phase
  phaseLabel?: string
  finished?: boolean
  tasks?: { title?: string; tier?: string; after?: number[]; id?: string; crew?: string; gates?: string[]; status?: string }[]
  skills?: string[]
  health?: Health
}

// ---------------------------------------------------------------------------
// Language: the `language` option, else Claude Code's `language` setting, else the
// process locale; English when nothing says Russian.

type Lang = 'en' | 'ru'

const STRINGS = {
  en: {
    pane: 'Agents',
    cost: 'Cost',
    tokens: 'Tokens',
    time: 'Time',
    collapse: 'Collapse',
    expand: 'Expand',
    running: 'Running',
    finished: 'Finished',
    planned: 'Planned',
    empty: 'No Sub-agents Yet',
    round: 'Round',
    failed: 'Error',
    after: 'After',
    tokensWord: 'Tokens',
    agentsCount: 'Agents',
    isRunning: 'Running',
    isFinished: 'Finished',
    isPlanned: 'Planned',
    opened: 'Agents Panel Opened',
    closed: 'Agents Panel Closed',
    done: 'Done',
    plan: 'Plan',
    design: 'Design',
    tasks: 'Tasks',
    review: 'Review',
    busy: 'Running',
    tasksHead: 'Tasks',
    skills: 'Skills',
    gatesWord: 'Gates',
    health: 'Health',
    task: 'Task',
    model: 'Model',
    crew: 'Name',
    gate: 'Gate',
    context: 'Context',
    shared: 'Shared',
    heartbeat: 'Heartbeat',
    watchdog: 'Watchdog',
    paused: 'Paused',
    slots: 'Slots',
    openTask: 'Open Task',
    openFailed: 'Could Not Open the Task',
    none: 'None',
  },
  ru: {
    pane: 'Агенты',
    cost: 'Стоимость',
    tokens: 'Токены',
    time: 'Время',
    collapse: 'Свернуть',
    expand: 'Развернуть',
    running: 'Работают',
    finished: 'Завершены',
    planned: 'Запланированы',
    empty: 'Субагентов пока нет.',
    round: 'раунд',
    failed: 'ошибка',
    after: 'после',
    tokensWord: 'токенов',
    agentsCount: 'агентов',
    isRunning: 'работает',
    isFinished: 'завершён',
    isPlanned: 'запланирована',
    opened: 'Панель агентов открыта.',
    closed: 'Панель агентов закрыта.',
    done: 'Готово',
    plan: 'План',
    design: 'Дизайн',
    tasks: 'Задачи',
    review: 'Ревью',
    busy: 'в работе',
    tasksHead: 'Задачи',
    skills: 'Навыки',
    gatesWord: 'Проверки',
    health: 'Состояние',
    task: 'Задача',
    model: 'Модель',
    crew: 'Имя',
    gate: 'Проверка',
    context: 'контекст',
    shared: 'общая',
    heartbeat: 'пульс',
    watchdog: 'сторож',
    paused: 'пауза',
    slots: 'слоты',
    openTask: 'Открыть задачу',
    openFailed: 'Не удалось открыть задачу',
    none: 'Нет',
  },
} as const

// Module scope is fine here: session.start sets it again on every (re)load.
let lang: Lang = 'en'
const tr = () => STRINGS[lang]

const isRussian = (v: unknown): boolean => typeof v === 'string' && /^(ru|russian|рус)/i.test(v.trim())

async function detectLang($: EngineInterface, option: unknown): Promise<Lang> {
  if (option === 'en' || option === 'ru') return option
  try {
    const settings = (await $.settings.read()) as Record<string, unknown>
    if (typeof settings.language === 'string' && settings.language.trim()) return isRussian(settings.language) ? 'ru' : 'en'
  } catch {
    // No settings: fall through to the locale.
  }
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG'))
  return isRussian(locale) ? 'ru' : 'en'
}

const blank = (): Flow => ({
  title: 'savvy-flow',
  total: 0,
  done: 0,
  running: 0,
  phase: 'plan',
  phaseLabel: undefined,
  isFinished: false,
  tasks: [],
  skills: undefined,
  health: undefined,
})

const isNewFlow = (prev: Flow | null, input: ProgressInput): boolean =>
  !prev || prev.isFinished || (input.title !== undefined && input.title.trim() !== prev.title)

const cleanTasks = (tasks: ProgressInput['tasks']): PlannedTask[] | undefined =>
  tasks
    ?.filter(t => t.title?.trim())
    .map(t => ({
      title: (t.title ?? '').trim(),
      tier: (t.tier ?? '').replace(/^savvy-/, '').trim().toLowerCase(),
      after: (t.after ?? []).filter(n => Number.isInteger(n) && n > 0),
      ...(t.id?.trim() ? { id: t.id.trim() } : {}),
      ...(t.crew?.trim() ? { crew: t.crew.trim() } : {}),
      ...(t.gates?.length ? { gates: t.gates.map(g => g.trim()).filter(Boolean) } : {}),
      ...(t.status?.trim() ? { status: t.status.trim().toLowerCase() } : {}),
    }))

const merge = (prev: Flow | null, input: ProgressInput): Flow => {
  // A new title means a new flow: never carry counters over from an earlier one.
  const base = isNewFlow(prev, input) || !prev ? blank() : { ...blank(), ...prev }
  const tasks = cleanTasks(input.tasks) ?? base.tasks
  // A count the report leaves out follows the tasks' own statuses when they carry any.
  const statused = tasks.filter(t => t.status)
  const doneByStatus = statused.filter(t => t.status === 'done').length
  const total = Math.max(0, Math.round(input.total ?? (input.tasks ? tasks.length : base.total)))
  const done = Math.min(total || Infinity, Math.max(0, Math.round(input.done ?? (input.tasks && statused.length ? doneByStatus : base.done))))
  const phase = input.phase && PHASES.includes(input.phase) ? input.phase : base.phase
  return {
    ...base,
    title: input.title?.trim() || base.title,
    total,
    done,
    phase: input.finished ? 'close' : phase,
    phaseLabel: input.finished ? undefined : (input.phaseLabel?.trim() ?? base.phaseLabel),
    isFinished: input.finished === true,
    tasks,
    skills: input.skills?.length ? [...new Set(input.skills.map(x => x.trim()).filter(Boolean))] : base.skills,
    health: input.health ? { ...base.health, ...input.health } : base.health,
  }
}

const label = (f: Flow): string => {
  const s = tr()
  if (f.isFinished) return s.done
  const count = f.total ? `${f.done}/${f.total}` : `${f.running} ${s.busy}`
  if (f.phaseLabel) return `${titleCase(f.phaseLabel)} ${count}`
  if (f.phase === 'plan') return s.plan
  if (f.phase === 'design') return s.design
  return `${f.phase === 'review' ? s.review : s.tasks} ${count}`
}

const ratio = (f: Flow): number => (f.isFinished ? 1 : f.total ? f.done / f.total : 0)

// Deterministic noise so the dither does not shimmer between redraws.
const noise = (x: number, y: number): number => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// The whole row is one SVG: the desktop wraps sibling elements onto new lines,
// so title, bar, percent and the crab live in one drawing; only the count and
// the dismiss are Buttons beside it.
const H = 22
const BAR_H = 16
const CRAB_W = 26
const CELL = 3
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)

// Rough advance of system UI text, in em; good enough to size the title's slot.
const charEm = (ch: string): number =>
  /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut.
const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

const rowSvg = (f: Flow, W: number, isWorking: boolean): string => {
  // The title takes what it needs, up to 40% of the row; the bar takes the rest.
  const title = fitText(titleCase(f.title), 13, Math.max(60, W * 0.4))
  const BAR_X = Math.round(16 + textWidth(title, 13) + 12)
  const BAR_W = Math.max(60, W - BAR_X - 46 - CRAB_W)
  const color = f.isFinished ? DONE : ACCENT
  const y0 = (H - BAR_H) / 2
  const fillW = Math.round(BAR_W * ratio(f))
  const runW = f.total ? Math.round((BAR_W * Math.min(f.total, f.done + f.running)) / f.total) : 0
  const dots: string[] = []

  // Dithered fill: sparse at the start, dense toward the head.
  const cols = Math.floor(fillW / CELL)
  const rows = Math.floor(BAR_H / CELL)
  for (let c = 0; c < cols; c++) {
    const density = 0.35 + 0.6 * Math.pow(c / Math.max(1, cols), 1.2)
    for (let r = 0; r < rows; r++) {
      if (noise(c, r) < density) dots.push(`<rect class="t${Math.floor(noise(r, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="2" height="2"/>`)
    }
  }
  // Handed to workers, not yet accepted: a faint second layer.
  const faint: string[] = []
  for (let c = cols; c < Math.floor(runW / CELL); c++) {
    for (let r = 0; r < rows; r++) {
      if (noise(c + 7, r + 3) < 0.2) faint.push(`<rect class="t${Math.floor(noise(r + 5, c) * 4)}" x="${c * CELL + 1}" y="${r * CELL + 1}" width="1.7" height="1.7"/>`)
    }
  }

  const ticks: string[] = []
  for (let i = 1; i < f.total; i++) {
    const x = Math.round((BAR_W * i) / f.total)
    if (x > fillW + 4) ticks.push(`<rect x="${x}" y="${BAR_H / 2 - 4}" width="1.5" height="8" rx="0.75"/>`)
  }

  const text = label(f)
  const pillW = Math.round(18 + text.length * 6.6)
  const pillX = Math.max(0, Math.min(BAR_W - pillW, fillW - pillW))
  const percent = `${Math.round(ratio(f) * 100)}%`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>
.t{fill:#1f1f1f}.m{fill:#8a8a8a}.k{fill:#e4e4e2}.tk{fill:#b4b4b0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.m{fill:#9a9a9a}.k{fill:#2c2c2c}.tk{fill:#5a5a5a}}
/* Pixels twinkle in four out-of-phase groups; a finished bar settles to a slow glow. */
.t0,.t1,.t2,.t3{animation:tw ${f.isFinished ? 3.2 : 2.2}s ease-in-out infinite}
.t1{animation-duration:${f.isFinished ? 3.8 : 2.8}s;animation-delay:-.7s}.t2{animation-duration:${f.isFinished ? 4.4 : 1.9}s;animation-delay:-1.3s}.t3{animation-duration:${f.isFinished ? 3.5 : 3.3}s;animation-delay:-.4s}
@keyframes tw{0%,100%{opacity:1}50%{opacity:${f.isFinished ? 0.8 : 0.3}}}
@media (prefers-reduced-motion: reduce){.t0,.t1,.t2,.t3{animation:none}}
</style>
<defs><clipPath id="c"><rect x="0" y="0" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/></clipPath></defs>
<circle cx="5" cy="${H / 2}" r="4" fill="${color}"/>
<text class="t" x="16" y="${H / 2 + 4.5}" font-family="${FONT}" font-size="13" font-weight="500">${xml(title)}</text>
<g transform="translate(${BAR_X},${y0})">
<rect class="k" width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}"/>
<g clip-path="url(#c)">
<g fill="${color}">${dots.join('')}</g>
<g fill="${color}" opacity="0.45">${faint.join('')}</g>
<g class="tk">${ticks.join('')}</g>
</g>
<rect x="${pillX}" width="${pillW}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>
<text x="${pillX + pillW / 2}" y="${BAR_H / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="#ffffff">${xml(text)}</text>
</g>
<text class="m" x="${W - CRAB_W - 6}" y="${H / 2 + 4.5}" text-anchor="end" font-family="${FONT}" font-size="12.5" font-variant-numeric="tabular-nums">${percent}</text>
${CRAB_CSS}${crab(W - CRAB_W + 1, 0, 'other', false, isWorking, 0.8)}
</svg>`
}

const barText = (f: Flow, width: number): string => {
  const filled = Math.round(width * ratio(f))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// ---------------------------------------------------------------------------
// Agents panel: every subagent of the session, plus the tasks the flow planned.

const TIER_COLOR: Record<string, string> = {
  fable: '#7F77DD',
  heavy: '#D85A30',
  careful: '#BA7517',
  medium: '#378ADD',
  light: '#1D9E75',
  other: '#888780',
}

// What each savvy tier runs on, for planned tasks that have no run yet.
const colorOf = (tier: string): string => TIER_COLOR[tier] ?? '#888780'

const TIER_MODEL: Record<string, string> = {
  fable: 'Fable · High',
  heavy: 'Opus · Extra High',
  careful: 'Opus · High',
  medium: 'Opus · Medium',
  light: 'Opus · Low',
}

// USD per million tokens: input, output, cache read, cache write (5-minute TTL).
// The engine reports tokens, not money, so the panel's cost is an estimate.
const PRICES: [RegExp, [number, number, number, number]][] = [
  [/fable|mythos/, [10, 50, 0.25, 12.5]],
  [/opus-5-5/, [4, 20, 0.2, 5]],
  [/opus/, [5, 25, 0.5, 6.25]],
  [/sonnet/, [2, 10, 0.2, 2.5]],
  [/haiku/, [1, 5, 0.1, 1.25]],
]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const priceOf = (model: string): [number, number, number, number] =>
  PRICES.find(([re]) => re.test(model.toLowerCase()))?.[1] ?? [4, 20, 0.2, 5]

const costOf = (model: string, u: Usage): number => {
  const [i, o, r, w] = priceOf(model)
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

const windowOf = (model: string): number => (/haiku/i.test(model) ? 200_000 : 1_000_000)

// `savvy-careful`, or `savvy-flow:savvy-careful` when the agents ship in a plugin.
const tierOf = (type: string): string => {
  const bare = type.replace(/^[^:]*:/, '')
  const t = bare.replace(/^savvy-/, '').toLowerCase()
  return t in TIER_COLOR && bare.startsWith('savvy-') ? t : 'other'
}

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// ---------------------------------------------------------------------------
// Crews, tasks and gates: how a run's description, brief and report name them.

// Gates: a run is a gate when its description carries the word ("Design gate, …", "Gate: …")
// or its report carries GATE-RECORD lines.
const GATE_DESC = /\bgates?\b/i

// "Crew A — three asks" → crew "Crew A", lane "three asks".
// "Design gate, CTA lane" → crew "Design gate", lane "CTA lane".
const splitDescription = (desc: string): { crew: string; lane: string } => {
  const d = (desc || '').trim()
  const m = /^(.*?)\s*(?:—|–|-{1,2}|:|,)\s+(.*)$/.exec(d)
  if (m && m[1] && m[2]) return { crew: m[1].trim(), lane: m[2].trim() }
  return { crew: d, lane: '' }
}

// Task ids in a brief: the ids the round reported through the progress tool, found as whole words.
// Nothing is assumed about how a board spells its ids.
const taskIdsOf = (text: string, known: readonly (string | undefined)[]): string[] => {
  const t = text || ''
  return [...new Set(known.filter((id): id is string => !!id && new RegExp(`(^|[^A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`).test(t)))]
}
const knownIds = (f: Flow | null): (string | undefined)[] => (f?.tasks ?? []).map(t => t.id)

// ---------------------------------------------------------------------------
// Opening a task where it lives: the Task Link setting, a web address with {id} where the task's
// id goes (https://app.clickup.com/t/{id}, https://linear.app/team/issue/{id}, a tracker's own
// app link). Left empty, task rows carry no open button.

let taskLink = ''
const canOpen = (id: string | undefined): id is string => !!id && !!taskLink
const taskUrl = (id: string): string => taskLink.replaceAll('{id}', encodeURIComponent(id))

async function openTask($: EngineInterface, id: string): Promise<void> {
  const url = taskUrl(id)
  // macOS opens with `open`, Linux with `xdg-open`, Windows through `cmd /c start`.
  for (const argv of [['open', url], ['xdg-open', url], ['cmd', '/c', 'start', '', url]]) {
    try {
      const { exitCode } = await $.process.run(argv)
      if (exitCode === 0) return
    } catch {
      // Not this system's opener: try the next.
    }
  }
  $.ui.toast(`${tr().openFailed} ${id}`)
}

const openLabel = (): string => tr().openTask

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'its', 'is', 'not'])
// Words with a spelling of their own, kept as their owners write them.
const SPELLED: Record<string, string> = { clickup: 'ClickUp', seo: 'SEO', aeo: 'AEO', cro: 'CRO', cta: 'CTA', ui: 'UI', ux: 'UX', ai: 'AI' }
const titleCase = (s: string): string =>
  s
    .split(/\s+/)
    .map((w, i) => {
      const lower = w.toLowerCase()
      if (SPELLED[lower]) return SPELLED[lower]
      // A small word is lowered only when written lower case already, so a name like "Crew A" keeps its capital.
      if (i > 0 && SMALL.has(lower) && w === lower) return lower
      if (/^[A-Z0-9]{2,}$/.test(w)) return w
      return w.charAt(0).toUpperCase() + w.slice(1)
    })
    .join(' ')

// A machine name read as words: "gate-design-system" → "Gate Design System".
const nameCase = (s: string): string => titleCase(s.replace(/[-_]+/g, ' ').trim())

// Effort as words: "high" → "High", "xhigh" → "Extra High".
const effortName = (e: string): string => (e.toLowerCase() === 'xhigh' ? 'Extra High' : titleCase(e))

// The heading a run shows: the board task it works (by id, then by crew name), else its lane, else its description.
const taskOfRun = (a: AgentRun, f: Flow | null): PlannedTask | undefined => {
  const tasks = f?.tasks ?? []
  const byId = tasks.filter(t => t.id && a.taskIds?.includes(t.id))
  if (byId.length === 1) return byId[0]
  if (byId.length > 1) return undefined
  if (a.crew) {
    const byCrew = tasks.filter(t => t.crew && norm(t.crew) === norm(a.crew ?? ''))
    if (byCrew.length === 1) return byCrew[0]
  }
  return undefined
}

// A gate is one whatever its spawn recorded: the description says so, or its report did.
const isGateRun = (a: AgentRun): boolean => a.isGate === true || GATE_DESC.test(a.description || '')

// A gate's kind and what it is checking, read from its description in either order:
// "Design gate, hover green" → Design, "hover green";
// "Gate: design system check, hover green" → Design System, "hover green".
// The word "gate" (and "check") never becomes the kind, so a row never reads "Gate Gate" or
// "Gate: Gate".
const GATE_FIRST = /^\s*gates?\b\s*(?:—|–|-{1,2}|:|,)?\s*(.*)$/i
const gateParts = (a: AgentRun): { kind: string; lane: string } => {
  const named = GATE_FIRST.exec(a.description || '')
  const { crew, lane } = named ? splitDescription(named[1] ?? '') : splitDescription(a.description)
  const kind = (crew || '').replace(/\b(?:gates?|checks?)\b/gi, '').replace(/\s+/g, ' ').trim()
  // No kind named: none is made up; the row then reads "Gate: <task>" alone.
  return { kind: titleCase(kind), lane }
}

// "Design gate" → "Design"; the kind of gate, for the heading and the grey line.
const gateKindOf = (a: AgentRun): string => gateParts(a).kind

// A crew's heading is the task it works; a gate's says what it checks: "Design gate: Scroller Centring".
const headingOf = (a: AgentRun, f: Flow | null): string => {
  const task = taskOfRun(a, f)
  const ids = a.taskIds ?? []
  const named = (f?.tasks ?? []).filter(t => t.id && ids.includes(t.id)).map(t => titleCase(t.title))
  const { lane, crew } = isGateRun(a) ? { ...gateParts(a), crew: '' } : splitDescription(a.description)
  const subject = task ? titleCase(task.title) : named.length > 1 ? named.join(' · ') : titleCase(lane || crew || a.type)
  if (isGateRun(a)) return gateKindOf(a) ? `${gateKindOf(a)} ${tr().gate}: ${subject}` : `${tr().gate}: ${subject}`
  return subject
}

// Every GATE-RECORD line of a report: {task, gate, verdict}.
const gateRecordsOf = (answer: string): GateRecord[] =>
  answer
    .split('\n')
    .filter(l => l.includes('GATE-RECORD:'))
    .map(l => {
      const get = (k: string) => new RegExp(`"${k}"\\s*:\\s*"([^"]*)"`, 'i').exec(l)?.[1]?.trim() ?? ''
      return { task: get('task'), gate: get('gate'), verdict: get('verdict').toLowerCase() }
    })

// Every COST-RECORD line's task name.
const costTasksOf = (answer: string): string[] =>
  answer
    .split('\n')
    .filter(l => l.includes('COST-RECORD:'))
    .map(l => /"task"\s*:\s*"([^"]*)"/i.exec(l)?.[1]?.trim() ?? '')
    .filter(Boolean)

// Does this gate record speak of this task? By id, or by the task's words.
const recordNamesTask = (r: GateRecord, t: PlannedTask): boolean => {
  const key = norm(r.task)
  if (!key) return false
  if (t.id && key === norm(t.id)) return true
  const title = norm(t.title)
  return key === title || (key.length > 12 && title.includes(key)) || (title.length > 12 && key.includes(title))
}

type TaskView = {
  task: PlannedTask
  n: number
  crew: string
  status: string
  gates: { name: string; verdict: string; attempts: number }[]
  costUsd: number | null
  isShared: boolean
}

// One row per task of the round: its crew, its gates' latest verdicts and attempts, and its cost.
const taskViews = (f: Flow | null, list: AgentRun[]): TaskView[] => {
  if (!f) return []
  return (f.tasks ?? []).map((t, i) => {
    const crews = list.filter(a => !a.isGate && ((t.id && a.taskIds?.includes(t.id)) || (t.crew && a.crew && norm(a.crew) === norm(t.crew))))
    const latest = crews[crews.length - 1]
    const crew = t.crew || latest?.crew || ''
    const records = list.flatMap(a => (a.gateRecords ?? []).filter(r => recordNamesTask(r, t)))
    const names = [...new Set([...(t.gates ?? []), ...records.map(r => r.gate)])]
    const gates = names.map(name => {
      const mine = records.filter(r => norm(r.gate) === norm(name))
      const last = mine[mine.length - 1]
      const running = list.some(a => a.isGate && a.status === 'running' && (t.id ? taskIdsOf(a.description + ' ' + (a.lane ?? ''), knownIds(f)).includes(t.id) : false))
      return { name, verdict: last?.verdict ?? (running ? 'running' : 'expected'), attempts: mine.length }
    })
    // A crew that worked several tasks is left unattributed: its total is exact, no split of it would be.
    const single = crews.filter(a => (a.taskIds?.length ?? 0) <= 1 && (a.costTasks?.length ?? 0) <= 1)
    const isShared = crews.length > 0 && single.length < crews.length
    const costUsd = crews.length ? single.reduce((s, a) => s + a.costUsd, 0) : null
    const status =
      t.status ??
      (latest ? (latest.status === 'running' ? 'building' : gates.some(g => g.verdict === 'running') ? 'gating' : 'done') : 'to do')
    return { task: t, n: i + 1, crew, status, gates, costUsd, isShared }
  })
}

const gateGlyph = (verdict: string): string =>
  verdict === 'pass' ? '✓' : verdict === 'fail' ? '✗' : verdict === 'running' ? '◷' : verdict === 'expected' ? '○' : '–'
const gateColor = (verdict: string): string =>
  verdict === 'pass' ? '#3B9C5F' : verdict === 'fail' ? '#D0453F' : verdict === 'running' ? ACCENT : '#9a9a96'

// Short gate names for a chip: "gate-design-system" → "Design System".
const gateShort = (name: string): string => nameCase(name.replace(/^gate-/, ''))

// Gates by name across the session, for the chip: name → pass/fail/na counts.
const gatesByName = (list: AgentRun[]): { name: string; pass: number; fail: number; na: number }[] => {
  const map = new Map<string, { name: string; pass: number; fail: number; na: number }>()
  for (const a of list) {
    for (const r of a.gateRecords ?? []) {
      const key = norm(r.gate)
      if (!key) continue
      const g = map.get(key) ?? { name: r.gate, pass: 0, fail: 0, na: 0 }
      if (r.verdict === 'pass') g.pass++
      else if (r.verdict === 'fail') g.fail++
      else g.na++
      map.set(key, g)
    }
  }
  return [...map.values()]
}

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

// Costs are worked out in US dollars (the price table above) and shown in the Currency setting,
// at the Exchange Rate setting (how much of that currency one US dollar buys).
const CURRENCY_SIGN: Record<string, string> = { USD: '$', GBP: '£', EUR: '€' }
let currency = { sign: '$', perUsd: 1 }
const fmtCost = (usd: number): string => {
  const v = usd * currency.perUsd
  return `${currency.sign}${v < 10 ? v.toFixed(2) : v.toFixed(1)}`
}

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

type Planned = PlannedTask & { n: number }

const plannedOf = (f: Flow | null, list: AgentRun[]): Planned[] => {
  if (!f || f.isFinished) return []
  // A round whose tasks carry ids is shown in the Tasks list already, with each task's state.
  if ((f.tasks ?? []).some(t => t.id)) return []
  const started = new Set(list.map(a => norm(a.description)))
  return (f.tasks ?? []).map((t, i) => ({ ...t, n: i + 1 })).filter(t => !started.has(norm(t.title)))
}

const totals = (list: AgentRun[], at: number) => {
  const cost = list.reduce((s, a) => s + a.costUsd, 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { cost, tokens, time: list.length ? end - start : 0 }
}

// --- desktop drawings: each row is one SVG, as the band above the prompt is.

const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

// Pixel Clawd from DockCrab (Clawdy): a 24×18 crab on a 30×28 grid, one costume per tier.
// The body keeps the brand clay; the tier's color lives in the costume's accent.
const CLAY = '#D97757'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// costume, `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

// `armCls` lets a raised claw travel with the prop it holds.
const crabBody = (f: Fill, armFront = 0, armCls?: string): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14 + armFront, 4, 4, CLAY, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Every crab walks;
// each costume adds its prop's own motion on top.
const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.c-fable.run{animation:float 1s ease-in-out infinite}
.c-fable.run .la,.c-fable.run .lb,.c-fable.run .bd{animation:none}
.c-fable.run .ant{animation:blink 1s steps(1) infinite}
.c-fable.run .star{animation:blink .5s steps(1) infinite -.25s}
@keyframes float{50%{transform:translateY(-2px)}}@keyframes blink{50%{opacity:.15}}
.c-heavy.run .it{animation:scan 1s steps(1) infinite}
.c-heavy.run .gl{animation:blink 1s steps(1) infinite -.5s}
@keyframes scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.c-careful.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.c-medium.run .pan{transform-origin:0 50%;animation:tilt 1s ease-in-out infinite}
.c-medium.run .egg{animation:flip 1s ease-in-out infinite}
@keyframes tilt{20%,40%{transform:rotate(-12deg)}}@keyframes flip{30%{transform:translateY(-5px) scaleY(-1)}60%{transform:translateY(0)}}
.c-light.run .la{animation-duration:.25s}.c-light.run .lb{animation-duration:.25s;animation-delay:-.125s}
.c-light.run .flag{transform-origin:0 50%;animation:wave .25s steps(1) infinite}
@keyframes wave{50%{transform:skewY(-12deg) scaleX(.85)}}
.c-explore.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const COSTUMES: Record<string, (f: Fill, t: string) => void> = {
  // Fable: astronaut in a glass dome; floats instead of walking, the antenna and the star blink.
  fable: (f, t) => {
    crabBody(f)
    f(6, 7, 18, 1, '#E6E8EE'); f(5, 8, 1, 14, '#E6E8EE'); f(24, 8, 1, 14, '#E6E8EE'); f(6, 22, 18, 1, '#C9CCD2')
    f(6, 8, 18, 14, 'rgba(169,214,245,.32)'); f(8, 9, 2, 1, '#fff'); f(8, 10, 1, 2, '#fff')
    f(14, 4, 2, 3, '#C9CCD2'); f(14, 2, 2, 2, t, 'ant'); f(13, 18, 4, 2, t)
    f(27, 3, 1, 3, '#F5C542', 'star'); f(26, 4, 3, 1, '#F5C542', 'star')
  },
  // Heavy: detective with a deerstalker; the magnifier sweeps and glints.
  heavy: (f, t) => {
    crabBody(f, -4, 'it')
    stamp(f, 6, 3, ['......bbbbbb......', '....bbcbbcbbbb....', '...bbbbbbbbbbbb...', '..bcbbcbbcbbcbbb..', '.bbbbbbbbbbbbbbbb.', 'dddddddddddddddddd'], { b: '#7A4A26', c: '#A0703F', d: '#5A3519' })
    f(6, 9, 18, 1, t)
    stamp(f, 23, 1, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(24, 2, 3, 3, 'rgba(169,214,245,.7)', 'it'); f(25, 6, 1, 4, '#7A4A26', 'it'); f(24, 2, 1, 1, '#fff', 'gl')
  },
  // Careful: engineer in a hard hat; the wrench turns a bolt.
  careful: (f, t) => {
    crabBody(f)
    stamp(f, 6, 4, ['.....yyyyyyyy.....', '...yyyyyhhyyyyy...', '..yyyyyyhhyyyyyy..', '..yyyyyyhhyyyyyy..', '.yyyyyyyhhyyyyyyy.', 'dddddddddddddddddd'], { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' })
    f(13, 5, 4, 2, t)
    stamp(f, 0, 10, ['.s.s', 'sss.', '.s..', '.s..'], { s: '#8E929A' }, 'it')
  },
  // Medium: chef, the toque traced from DockCrab's Sprites.chefHat; tosses the omelette.
  medium: (f, t) => {
    crabBody(f, -4, 'pan')
    stamp(f, 6, 0, ['........lll.......', '.......lllll......', '.wwwwgwwwwwwgwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwgwwwwwggwwwww', '.wwwwgwwwwwggwwwww', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.'], { w: '#F4F3EE', l: '#F7F6F2', g: '#D2D1C8', b: t, d: '#B45F43' })
    f(22, 8, 7, 2, '#4A4A48', 'pan'); f(26, 10, 1, 1, '#4A4A48', 'pan'); f(24, 7, 3, 1, '#F5B731', 'egg')
  },
  // Light: racer in a helmet; runs at double pace, the checkered flag flutters.
  light: (f, t) => {
    crabBody(f, -4)
    stamp(f, 6, 5, ['....rrrrrrrrrr....', '..rrrrrrwwrrrrrr..', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.kkkkkkkkkkkkkkkkr'], { r: t, w: '#F8F6F1', k: INK })
    f(25, 1, 1, 9, '#8E929A')
    stamp(f, 26, 1, ['wkwk', 'kwkw', 'wkwk'], { w: '#F8F6F1', k: INK }, 'flag')
  },
  // Explore: pirate scouting the code; the cutlass fences.
  explore: f => {
    crabBody(f)
    stamp(f, 5, 3, ['.kk..............kk.', '.kkk....kkkk....kkk.', '..kkkkkkkwwkkkkkkk..', '..kkkkkkkkkkkkkkkk..', '.gggggggggggggggggg.'], { k: '#55514C', w: '#F8F6F1', g: '#F5C542' })
    f(7, 11, 11, 1, INK); f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it'); f(26, 15, 3, 1, '#7A4A26', 'it')
  },
  other: f => crabBody(f),
}

const costumeOf = (type: string): string => (type === 'Explore' ? 'explore' : tierOf(type))

// A sub-agent that is not a savvy tier (a crew, a gate, any other type) gets a costume
// chosen when it spawns: the costume least worn by the runs already in the list, ties
// broken by its own id, so neighbours differ and a crab keeps its look on every redraw.
// The plain crab is never used. Its accent colour is its own too,
// from a palette by id, so two crabs in the same costume still read apart.
const RANDOM_COSTUMES = ['fable', 'heavy', 'careful', 'medium', 'light', 'explore']
const ACCENTS = ['#7F77DD', '#D85A30', '#BA7517', '#378ADD', '#1D9E75', '#C13584', '#2A9D8F', '#E9A23B', '#5B8DEF', '#8E44AD']
const hashOf = (s: string): number => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
const pickCostume = (id: string, worn: string[]): string => {
  const counts = new Map(RANDOM_COSTUMES.map(c => [c, 0]))
  for (const w of worn) if (counts.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1)
  const least = Math.min(...counts.values())
  const pool = RANDOM_COSTUMES.filter(c => counts.get(c) === least)
  return pool[hashOf(id) % pool.length] ?? 'explore'
}
const accentFor = (id: string): string => ACCENTS[hashOf(id + ':accent') % ACCENTS.length] ?? ACCENTS[0] ?? '#888780'
const costumeFor = (a: { id: string; type: string; costume?: string }): string => {
  const c = costumeOf(a.type)
  if (c !== 'other') return c
  return a.costume ?? (RANDOM_COSTUMES[hashOf(a.id) % RANDOM_COSTUMES.length] ?? 'explore')
}

const verdictsOf = (answer: string): { pass: number; fail: number; na: number } | undefined => {
  const lines = answer.split('\n').filter(l => l.includes('GATE-RECORD:'))
  if (lines.length === 0) return undefined
  const v = { pass: 0, fail: 0, na: 0 }
  for (const l of lines) {
    const m = /"verdict"\s*:\s*"([^"]+)"/i.exec(l)
    const word = (m?.[1] ?? '').toLowerCase()
    if (word === 'pass') v.pass++
    else if (word === 'fail') v.fail++
    else if (word) v.na++
  }
  return v
}
type GateSum = { running: number; pass: number; fail: number; na: number; runs: number }
const gatesOf = (list: AgentRun[]): GateSum => {
  const g: GateSum = { running: 0, pass: 0, fail: 0, na: 0, runs: 0 }
  for (const a of list) {
    if (!a.isGate) continue
    g.runs++
    if (a.status === 'running') g.running++
    if (a.verdicts) {
      g.pass += a.verdicts.pass
      g.fail += a.verdicts.fail
      g.na += a.verdicts.na
    }
  }
  return g
}
const gateLabel = (g: GateSum): string => {
  const parts = [`✓${g.pass}`, `✗${g.fail}`]
  if (g.na) parts.push(`–${g.na}`)
  if (g.running) parts.push(`◷${g.running}`)
  return `Gates ${parts.join(' ')}`
}

const CRAB_SCALE = 1.1

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// legs stay outside it and step on their own.
const crab = (x: number, y: number, costume: string, dim = false, isWalking = false, scale = CRAB_SCALE, accent?: string): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`)
  }
  const draw = COSTUMES[costume] ?? ((g: Fill) => crabBody(g))
  draw(f, accent ?? colorOf(costume))
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  return `<g transform="translate(${x},${y}) scale(${scale})" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}

const statusMark = (x: number, y: number, status: string, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="#D0453F" stroke-width="1.8" stroke-linecap="round"/>`
  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/><path d="M${x} ${y - 2.5}v2.8l1.8 1.2" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round"/>`
}

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

// The pane's own title already says "Agents": the header names the flow, if any.
// Four tiles: the round's tasks (done of total, from the board,
// whatever the orchestrator reports), then cost, tokens and time.
const headerSvg = (W: number, title: string, t: ReturnType<typeof totals>, tasks?: { done: number; total: number }): string => {
  const s = tr()
  // Tiles spaced apart with room inside them.
  const gap = TILE_GAP
  const n = tasks ? 4 : 3
  const tw = (W - gap * (n - 1)) / n
  const top = title ? 32 : 0
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${i * (tw + gap)}" y="${top}" width="${tw}" height="${TILE_H}" rx="10"/>
<text class="s" x="${i * (tw + gap) + TILE_PAD}" y="${top + 22}" font-family="${FONT}" font-size="11">${k}</text>
<text class="t" x="${i * (tw + gap) + TILE_PAD}" y="${top + 44}" font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  const tiles = [
    ...(tasks ? [tile(0, s.tasksHead, `${tasks.done}/${tasks.total}`)] : []),
    tile(n - 3, s.cost, fmtCost(t.cost)),
    tile(n - 2, s.tokens, fmtTokens(t.tokens)),
    tile(n - 1, s.time, fmtTime(t.time)),
  ]
  return svg(
    W,
    headerHeight(title),
    `${title ? `<text class="t" x="0" y="15" font-family="${FONT}" font-size="14" font-weight="600">${xml(fitText(title, 14, W))}</text>` : ''}
${tiles.join('')}`,
  )
}

const TILE_GAP = 12
const TILE_H = 58
const TILE_PAD = 16
// Room under the tiles before the next section.
const headerHeight = (title: string): number => (title ? 32 : 0) + TILE_H + 8

// The task's own progress when the worker reports steps; a finished run is full.
const progressOf = (a: AgentRun): number | null => {
  if (a.status === 'done') return 1
  if (a.stepTotal) return Math.min(1, (a.stepDone ?? 0) / a.stepTotal)
  return null
}

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

// The grey lines under a run's heading, one each: who it is, what it runs on, which board task.
const metaOf = (a: AgentRun, f: Flow | null): string[] => {
  const s = tr()
  const { crew } = splitDescription(a.description)
  const model = a.effort ? `${modelName(a.model)} · ${effortName(a.effort)}` : modelName(a.model)
  // A gate reads "Gate: Design", a crew "Name: Ada": the same shape on every row, and a gate's kind is never shown as a name.
  const who = a.crew || crew || a.type
  const first = isGateRun(a) ? (gateKindOf(a) ? `${s.gate}: ${gateKindOf(a)}` : '') : `${s.crew}: ${titleCase(who)}`
  const parts = [first, `${s.model}: ${model}`].filter(Boolean)
  const task = taskOfRun(a, f)
  const ids = task?.id ? [task.id] : (a.taskIds ?? [])
  if (ids.length) parts.push(`${s.task}: ${ids.join(', ')}`)
  // The skills this sub-agent used, under its task. Every row carries the line, "None" when it used none.
  parts.push(`${s.skills}: ${a.skills?.length ? a.skills.map(nameCase).join(', ') : s.none}`)
  if (a.round > 1) parts.push(`${s.round} ${a.round}`)
  if (a.status === 'failed') parts.push(s.failed)
  return parts
}

const META_LINE = 16
// Heading, then one grey line per meta part, then the bar (and the crew's own step note beside it when it reports one).
// Room under the bar before the next row's rule.
const agentHeight = (a: AgentRun, f: Flow | null): number => Math.max(64, 30 + metaOf(a, f).length * META_LINE + 30)

// The row's crab is drawn larger than the band's.
const ROW_CRAB = 1.9
const ROW_TEXT_X = 72
// The row's bar, taller than the band's hairline.
const ROW_BAR_H = 8

const agentSvg = (W: number, a: AgentRun, at: number, f: Flow | null): string => {
  const s = tr()
  const tier = tierOf(a.type)
  const color = isGateRun(a) ? '#9a9a96' : colorOf(tier)
  const ctx = ctxOf(a)
  const textW = W - ROW_TEXT_X - 22
  const barW = textW
  const progress = progressOf(a)
  // Without reported steps the bar falls back to the context, drawn grey. No figures are drawn
  // on the row, and no step count either; the header's tiles carry the totals.
  const fillW = Math.round(barW * (progress ?? ctx / 100))
  const meta = metaOf(a, f)
  const H = agentHeight(a, f)
  const barY = 30 + meta.length * META_LINE + 4
  void at
  return svg(
    W,
    H,
    `${crab(2, Math.max(2, Math.round(H / 2) - Math.round(14 * ROW_CRAB)), costumeFor(a), false, a.status === 'running', ROW_CRAB, tierOf(a.type) === 'other' ? accentFor(a.id) : undefined)}
<text class="t" x="${ROW_TEXT_X}" y="22" font-family="${FONT}" font-size="13.5" font-weight="600">${xml(fitText(headingOf(a, f), 13.5, textW))}</text>
${meta.map((m, i) => `<text class="s" x="${ROW_TEXT_X}" y="${40 + i * META_LINE}" font-family="${FONT}" font-size="11">${xml(fitText(m, 11, textW))}</text>`).join('')}
<rect class="k" x="${ROW_TEXT_X}" y="${barY}" width="${barW}" height="${ROW_BAR_H}" rx="${ROW_BAR_H / 2}"/><rect${progress === null ? ' class="m"' : ''} x="${ROW_TEXT_X}" y="${barY}" width="${fillW}" height="${ROW_BAR_H}" rx="${ROW_BAR_H / 2}"${progress === null ? '' : ` fill="${color}"`}/>
${statusMark(W - 8, 20, a.status, color)}
<line class="ln" x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}"/>`,
  )
}

const TASK_H = 52
// Room the open button takes beside a task row's drawing on the desktop.
const OPEN_W = 160

// One board task of the round: its heading, who has it, its gates and its cost.
const taskSvg = (W: number, v: TaskView): string => {
  const s = tr()
  const textW = W - 22
  const statusColor =
    v.status === 'done' ? '#3B9C5F' : v.status === 'blocked' ? '#D0453F' : v.status === 'building' || v.status === 'gating' ? ACCENT : '#9a9a96'
  const gates = v.gates
    .map(g => {
      const att = g.attempts > 1 ? ` ${g.attempts}` : ''
      return `<tspan fill="${gateColor(g.verdict)}">${gateGlyph(g.verdict)}</tspan><tspan class="s"> ${xml(gateShort(g.name))}${att}</tspan>`
    })
    .join('<tspan class="s">   </tspan>')
  const cost = v.costUsd === null ? '' : v.isShared ? `${fmtCost(v.costUsd)} + ${s.shared}` : fmtCost(v.costUsd)
  const left = [v.crew ? `${s.crew}: ${titleCase(v.crew)}` : '', v.task.id ? `${s.task}: ${v.task.id}` : ''].filter(Boolean).join('   ·   ')
  return svg(
    W,
    TASK_H,
    `<circle cx="6" cy="16" r="4" fill="${statusColor}"${v.status === 'building' || v.status === 'gating' ? ' class="live"' : ''}/>
<text class="t" x="18" y="20" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(`${v.n}. ${titleCase(v.task.title)}`, 13, textW - 80))}</text>
<text class="s" x="${W}" y="20" text-anchor="end" font-family="${FONT}" font-size="11">${xml(titleCase(v.status))}</text>
<text x="18" y="38" font-family="${FONT}" font-size="11"><tspan class="s">${xml(fitText(left, 11, textW * 0.45))}</tspan>${left && gates ? '<tspan class="s">   ·   </tspan>' : ''}${gates}</text>
<text class="s" x="${W}" y="38" text-anchor="end" font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(cost)}</text>
<line class="ln" x1="0" y1="${TASK_H - 0.5}" x2="${W}" y2="${TASK_H - 0.5}"/>`,
  )
}

// The chips row: skills used, gates by name, and the run's health.
const chipsSvg = (W: number, skills: string[], gates: ReturnType<typeof gatesByName>, health: Health | undefined): string => {
  const s = tr()
  const lines: string[] = []
  if (skills.length) lines.push(`<tspan class="s">${s.skills}:</tspan> <tspan class="t">${xml(skills.join(' · '))}</tspan>`)
  // The gates by name are not drawn here; each task row carries its own gates.
  void gates
  if (health) {
    const dot = (ok: boolean | undefined, word: string) =>
      ok === undefined ? '' : `<tspan fill="${ok ? '#3B9C5F' : '#D0453F'}">●</tspan> <tspan class="t">${word}</tspan>`
    const bits = [dot(health.heartbeat, s.heartbeat), dot(health.watchdog, s.watchdog), health.paused ? `<tspan fill="#D0453F">●</tspan> <tspan class="t">${s.paused}</tspan>` : '', health.slots ? `<tspan class="t">${xml(health.slots)} ${s.slots}</tspan>` : ''].filter(Boolean)
    if (bits.length) lines.push(`<tspan class="s">${s.health}:</tspan> ${bits.join('<tspan class="s">   ·   </tspan>')}`)
  }
  const h = lines.length * 20 + 6
  return svg(W, h, lines.map((l, i) => `<text x="0" y="${16 + i * 20}" font-family="${FONT}" font-size="11.5">${l}</text>`).join(''))
}
const chipsHeight = (skills: string[], gates: unknown[], health: Health | undefined): number => {
  let n = 0
  void gates
  if (skills.length) n++
  if (health && (health.heartbeat !== undefined || health.watchdog !== undefined || health.paused || health.slots)) n++
  return n * 20 + 6
}

const plannedSvg = (W: number, p: Planned): string => {
  const tier = p.tier in TIER_COLOR && p.tier !== 'other' ? p.tier : 'explore'
  const color = colorOf(tier)
  const textW = W - 42 - 22
  const meta = [TIER_MODEL[tier] ?? '']
  if (p.after.length) meta.push(`${tr().after} ${p.after.join(', ')}`)
  return svg(
    W,
    46,
    `${crab(0, 6, tier, true)}
<text class="s" x="42" y="18" font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(`${p.n}. ${titleCase(p.title)}`, 13, textW))}</text>
<text x="42" y="34" font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(titleCase(tier))}</tspan><tspan class="m">  ${xml(meta.filter(Boolean).join('  ·  '))}</tspan></text>
${statusMark(W - 8, 16, 'planned', color)}
<line class="ln" x1="0" y1="45.5" x2="${W}" y2="45.5"/>`,
  )
}

const compactSvg = (W: number, list: AgentRun[], planned: Planned[], t: ReturnType<typeof totals>): string => {
  const icons = [
    ...list.filter(a => a.status === 'running').map(a => ({ k: costumeFor(a), c: colorOf(tierOf(a.type)), s: 'running', dim: false, ac: tierOf(a.type) === 'other' ? accentFor(a.id) : undefined })),
    ...list.filter(a => a.status !== 'running').map(a => ({ k: costumeFor(a), c: colorOf(tierOf(a.type)), s: a.status, dim: false, ac: tierOf(a.type) === 'other' ? accentFor(a.id) : undefined })),
    ...planned.map(p => ({ k: p.tier in TIER_COLOR ? p.tier : 'explore', c: colorOf(p.tier), s: 'planned', dim: true, ac: undefined as string | undefined })),
  ]
  const fit = Math.max(1, Math.floor((W - 150) / 36))
  const shown = icons.slice(0, fit)
  const more = icons.length - shown.length
  const body = shown
    .map((ic, i) => crab(i * 36, 0, ic.k, ic.dim, ic.s === 'running', CRAB_SCALE, ic.ac) + (ic.s === 'running' ? `<circle class="live" cx="${i * 36 + 32}" cy="4" r="3" fill="${ic.c}"/>` : ''))
    .join('')
  const x = shown.length * 36 + (more ? 4 : 0)
  return svg(
    W,
    32,
    `${body}${more ? `<text class="s" x="${x}" y="21" font-family="${FONT}" font-size="12">+${more}</text>` : ''}
<text class="s" x="${W}" y="21" text-anchor="end" font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} · ${fmtTime(t.time)}</text>`,
  )
}

// --- terminal drawing: the same rows in text.

const ctxBar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<string, string> = { running: '●', done: '✓', failed: '✗', planned: '◷' }

// Opens the agents pane, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: tr().pane })
  return true
}

async function autoOpen($: EngineInterface, key: string): Promise<void> {
  const p = await read($, panel)
  if (p.autoOpenedFor === key) return
  await update($, panel, prev => ({ ...prev, autoOpenedFor: key }))
  void $.ui.open({ id: PANE, title: tr().pane })
}

// A skill read from its own folder: ".../skills/<name>/SKILL.md" gives <name>. Lower-case "skills"
// only, so a crew writing a skill back to the vault's "Skills" library is not counted as using it.
const SKILL_PATH = /\/skills\/([^/\s"']+)\/SKILL\.md\b/
const skillOfPath = (text: string): string => SKILL_PATH.exec(text)?.[1] ?? ''

// Adds a skill to the sub-agent's own list, once.
async function noteSkill($: EngineInterface, agentId: string, name: string): Promise<void> {
  await update($, agents, list =>
    list.map(a => (a.agentId !== agentId || a.skills?.includes(name) ? a : { ...a, skills: [...(a.skills ?? []), name] })),
  )
}

export const register: Register = (on, options) => {
  // The person's own settings (userConfig in plugin.json).
  taskLink = typeof options.taskLink === 'string' && options.taskLink.includes('{id}') ? options.taskLink.trim() : ''
  const code = typeof options.currency === 'string' && options.currency in CURRENCY_SIGN ? options.currency : 'USD'
  const rate = Number.parseFloat(typeof options.exchangeRate === 'string' ? options.exchangeRate : '1')
  currency = { sign: CURRENCY_SIGN[code] ?? '$', perUsd: code === 'USD' || !(rate > 0) ? 1 : rate }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lang = await detectLang($, options.language)
    await $.tool.register({
      name: 'progress',
      description:
        'Report the round to the progress bar above the prompt and the agents panel: a savvy-flow, or a work-through of tasks from a task board. ' +
        'Call it when the round is planned (title, tasks with their ids, crews and expected gates, phaseLabel), whenever a task changes status or crew, ' +
        'when the phase changes (phaseLabel: Building, Gating, Merging, Snapshot), and once at the end with finished: true. Fields left out keep their previous value.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall task or the parent task, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Number of planned tasks; left out, the tasks list counts.' },
          done: { type: 'integer', minimum: 0, description: 'Number of tasks finished (at review); left out, the tasks with status done count.' },
          phase: { type: 'string', enum: [...PHASES] },
          phaseLabel: { type: 'string', description: 'Free words for the pill, e.g. Building, Gating, Merging, Snapshot.' },
          finished: { type: 'boolean', description: 'True once the round is closed.' },
          tasks: {
            type: 'array',
            description:
              'The tasks of the round in order, numbered from 1. For a savvy-flow each title equals the Agent description; for a work-through each carries its board id, so the panel matches crews (by the ids in their briefs), gates (by the GATE-RECORD task field) and costs (COST-RECORD) to it.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'The task name, as on the board.' },
                tier: { type: 'string', enum: ['fable', 'heavy', 'careful', 'medium', 'light', 'other'] },
                after: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tasks this one waits for.' },
                id: { type: 'string', description: 'The task id on the board, as it appears in the briefs handed to sub-agents.' },
                crew: { type: 'string', description: 'The crew codename it was handed to.' },
                gates: { type: 'array', items: { type: 'string' }, description: 'The gates expected to check it, by name.' },
                status: { type: 'string', enum: ['to do', 'building', 'gating', 'done', 'blocked'] },
              },
              required: ['title'],
            },
          },
          skills: { type: 'array', items: { type: 'string' }, description: 'Skills in use this run, by name.' },
          health: {
            type: 'object',
            description: 'The run\'s health: heartbeat touched, watchdog armed, paused, crew slots in use.',
            properties: {
              heartbeat: { type: 'boolean' },
              watchdog: { type: 'boolean' },
              paused: { type: 'boolean' },
              slots: { type: 'string', description: 'e.g. "2 of 2"' },
            },
          },
        },
      },
    })
    await $.tool.register({
      name: 'step',
      description:
        'For savvy-flow workers: report progress on your own task to the agents panel. ' +
        'Right after reading the brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
        'call it again as each step finishes. Cheap and silent: it only draws a bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
    })
    await $.command.register({
      name: 'agents-info',
      description: 'Show or hide the panel of subagents: running, finished and planned, with model, context, cost and time',
    })

    // The panel opens by itself in every session unless the autoOpen option says otherwise. Opened unasked it
    // seats from 144 columns and waits below that.
    if (options.autoOpen !== false && options.autoOpen !== 'off') void $.ui.open({ id: PANE, title: tr().pane })

    // Ticks the running agents' clocks; quiet when nothing runs.
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, agents)
        if (!list.some(a => a.status === 'running')) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })
    return started
  })

  on('command.run', { command: 'agents-info' }, async $ => {
    const isOpen = await togglePane($)
    return { text: isOpen ? tr().opened : tr().closed }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as ProgressInput
    const prev = await read($, flow)
    if (isNewFlow(prev, input) && input.title !== undefined) {
      // A new flow starts with a clean list; agents still running stay.
      await update($, agents, list => list.filter(a => a.status === 'running'))
    }
    const next = await update($, flow, p => merge(p, input))
    if (next && input.tasks?.length) await autoOpen($, next.title)
    return { result: `ok: ${label(next ?? blank())}` }
  })

  // A worker's own progress: the call runs in the worker's loop, so agentId names it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const input = e as unknown as { done?: number; total?: number; note?: string }
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    await update($, agents, list =>
      list.map(a => {
        if (a.agentId !== agentId) return a
        const total = Math.max(0, Math.round(input.total ?? a.stepTotal ?? 0))
        const done = Math.max(0, Math.round(input.done ?? a.stepDone ?? 0))
        return { ...a, stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: input.note?.trim() || undefined, stepSource: 'self' }
      }),
    )
    return { result: 'ok' }
  })

  // Skills by name: the main session's for the chips row, a sub-agent's on its own row.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const raw = e as unknown as Record<string, unknown>
    const name = String(raw.skill ?? raw.name ?? '').trim()
    if (name && !e.agentId) await update($, skillsUsed, list => (list.includes(name) ? list : [...list, name]))
    if (name && e.agentId) await noteSkill($, e.agentId, name)
    return next(e)
  })

  // A sub-agent also uses a skill by reading its SKILL.md, as crews are briefed to.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const name = skillOfPath(String((e as unknown as { file_path?: string }).file_path ?? ''))
    if (name && e.agentId) await noteSkill($, e.agentId, name)
    return next(e)
  })

  // A crew's progress when it does not report its own steps (sub-agents may not get the step tool):
  // every tool call it makes nudges its bar, a typical crew making about eighty, so the bar moves
  // from its first minute and never fills before the crew finishes.
  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (!agentId || e.tool === STEP_TOOL) return next(e)
    await update($, agents, list =>
      list.map(a => {
        if (a.agentId !== agentId || a.isGate || a.stepSource === 'self') return a
        const calls = (a.calls ?? 0) + 1
        const n = Math.max(1, a.taskIds?.length ?? 1)
        const total = n * 5
        const byCalls = Math.min(total - 1, Math.floor((calls / (80 * n)) * total))
        return { ...a, calls, stepTotal: total, stepDone: byCalls, stepSource: 'watched' }
      }),
    )
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const agentId = e.agentId
    const cmd = String((e as unknown as { command?: string }).command ?? '')
    if (!agentId || !cmd) return next(e)
    const skill = skillOfPath(cmd)
    if (skill) await noteSkill($, agentId, skill)
    return next(e)
  })

  // Safety net: worker launches move the faint layer even if the orchestrator forgets to report.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = String(e.subagent_type ?? '')
    if (!type.startsWith('savvy-')) return next(e)

    await update($, flow, prev => {
      const base = prev && !prev.isFinished ? { ...blank(), ...prev } : blank()
      return { ...base, running: base.running + 1, phase: base.phase === 'plan' ? 'delegate' : base.phase }
    })
    try {
      return await next(e)
    } finally {
      await update($, flow, prev => (prev ? { ...prev, running: Math.max(0, prev.running - 1) } : prev))
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    const ids = knownIds(await read($, flow))
    await update($, agents, list => {
      const round = 1 + list.filter(a => norm(a.description) === norm(e.description) && e.description).length
      const { crew, lane } = splitDescription(e.description ?? '')
      const run: AgentRun = {
        id: started.agentId ?? e.tool_use_id,
        agentId: started.agentId,
        type: e.subagentType,
        description: e.description,
        model: started.model,
        status: 'running',
        startedAt: at,
        contextTokens: 0,
        contextMax: windowOf(started.model),
        tokens: 0,
        costUsd: 0,
        steps: 0,
        round,
        isGate: GATE_DESC.test(e.description ?? ''),
        taskIds: taskIdsOf(e.prompt ?? '', ids),
        crew,
        lane,
        costume: costumeOf(e.subagentType) === 'other' ? pickCostume(started.agentId ?? e.tool_use_id, list.slice(-RANDOM_COSTUMES.length + 1).map(r => costumeFor(r))) : undefined,
      }
      return [...list.filter(a => a.id !== run.id), run].slice(-200)
    })
    await update($, now, () => at)
    if (e.subagentType.startsWith('savvy-')) {
      const f = await read($, flow)
      await autoOpen($, f && !f.isFinished ? f.title : 'savvy-flow')
    }
    return started
  })

  // Each model request of a subagent: live context, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId || !usage) return result

    const model = usage.model || e.model
    await update($, agents, list =>
      list.map(a =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model,
              effort: typeof e.effort === 'string' ? e.effort : a.effort,
              status: 'running',
              endedAt: undefined,
              contextTokens:
                (usage.input_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0) +
                (usage.output_tokens || 0),
              contextMax: windowOf(model),
              tokens:
                a.tokens +
                (usage.input_tokens || 0) +
                (usage.output_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0),
              costUsd: a.costUsd + costOf(model, usage),
              steps: a.steps + 1,
            },
      ),
    )
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      await update($, agents, list =>
        list.map(a => {
          if (a.agentId !== agentId) return a
          // A run whose steps went unseen still gets the turn's own sum.
          const fallback = a.steps === 0 && e.usage
          const verdicts = verdictsOf(e.answer ?? '')
          const gateRecords = gateRecordsOf(e.answer ?? '')
          const costTasks = costTasksOf(e.answer ?? '')
          return {
            ...a,
            status: e.reason === 'answer' ? 'done' : 'failed',
            endedAt: at,
            ...(verdicts ? { isGate: true, verdicts, gateRecords } : {}),
            ...(costTasks.length ? { costTasks } : {}),
            ...(fallback && e.usage
              ? {
                  model: e.usage.model || a.model,
                  tokens:
                    e.usage.input_tokens +
                    e.usage.output_tokens +
                    e.usage.cache_read_input_tokens +
                    e.usage.cache_creation_input_tokens,
                  costUsd: costOf(e.usage.model || a.model, e.usage),
                }
              : {}),
          }
        }),
      )
      await update($, now, () => at)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = tr()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const f = await read($, flow)
    const p: Panel = await read($, panel)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)

    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const planned = plannedOf(f, list)
    const views = taskViews(f, list)
    const t = totals(list, at)
    const skills = [...new Set([...(await read($, skillsUsed)), ...(f?.skills ?? [])].map(nameCase))]
    const gateChips = gatesByName(list)
    const health = f?.health
    // Tasks: done of total, as the round reports them.
    const taskCount = f && !f.isFinished && (f.total || views.length) ? { done: views.length ? views.filter(v => v.status === 'done').length : f.done, total: f.total || views.length } : undefined
    // The pane's title says "Agents"; inside, only the flow's own name.
    const title = f && !f.isFinished ? titleCase(f.title) : ''

    // No Collapse button; the compact drawing stays for a saved compact state.
    const toggleCompact = null
    void toggleCompact
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? '▸' : '▾'} ${s.finished} · ${finished.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
      />
    )
    const isEmpty = list.length === 0 && planned.length === 0
    // Each task's way out to where it lives, through the Task Link setting.
    const openButton = (id: string) => (
      <Button key={`open-${id}`} label={openLabel()} plain dimColor onPress={() => void openTask($, id)} />
    )
    const summary = `${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} ${s.tokensWord}, ${fmtTime(t.time)}`

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const section = (key: string, text: string) => (
        <Text key={key} dimColor>
          {text}
        </Text>
      )

      if (p.isCompact) {
        return (
          <Box flexDirection="column" gap={1}>
            <Svg source={compactSvg(W, list, planned, t)} alt={`${list.length} ${s.agentsCount}, ${summary}`} width={W} height={32} />
            {toggleCompact}
          </Box>
        )
      }
      const chipsH = chipsHeight(skills, gateChips, health)
      const gap = <Text key="gap"> </Text>
      return (
        <Box flexDirection="column">
          <Svg source={headerSvg(W, title, t, taskCount)} alt={title ? `${title}: ${summary}` : summary} width={W} height={headerHeight(title)} />
          {chipsH > 6 && <Svg source={chipsSvg(W, skills, gateChips, health)} alt={`${s.skills}: ${skills.join(', ')}`} width={W} height={chipsH} />}
          {isEmpty && views.length === 0 && <Text dimColor>{s.empty}</Text>}
          {views.length > 0 && <Text key="gap-tasks"> </Text>}
          {views.length > 0 && section('h-tasks', `${s.tasksHead} · ${views.filter(v => v.status === 'done').length}/${views.length}`)}
          {views.map(v =>
            canOpen(v.task.id) ? (
              <Box key={`task-${v.task.id}`} flexDirection="row" alignItems="center" gap={1}>
                <Svg source={taskSvg(W - OPEN_W, v)} alt={`${v.n}. ${titleCase(v.task.title)}: ${titleCase(v.status)}`} width={W - OPEN_W} height={TASK_H} />
                {openButton(v.task.id)}
              </Box>
            ) : (
              <Svg key={`task-${v.task.id ?? v.n}`} source={taskSvg(W, v)} alt={`${v.n}. ${titleCase(v.task.title)}: ${titleCase(v.status)}`} width={W} height={TASK_H} />
            ),
          )}
          {running.length > 0 && <Text key="gap-run"> </Text>}
          {running.length > 0 && section('h-run', `${s.running} · ${running.length}`)}
          {running.map(a => (
            <Svg key={a.id} source={agentSvg(W, a, at, f)} alt={`${headingOf(a, f)}: ${modelName(a.model)}, ${s.isRunning}`} width={W} height={agentHeight(a, f)} />
          ))}
          {finished.length > 0 && gap}
          {finished.length > 0 && toggleDone}
          {!p.isDoneCollapsed &&
            finished.map(a => (
              <Svg key={a.id} source={agentSvg(W, a, at, f)} alt={`${headingOf(a, f)}: ${modelName(a.model)}, ${s.isFinished}`} width={W} height={agentHeight(a, f)} />
            ))}
          {planned.length > 0 && <Text key="gap-plan"> </Text>}
          {planned.length > 0 && section('h-plan', `${s.planned} · ${planned.length}`)}
          {planned.map(pl => (
            <Svg key={`plan-${pl.n}`} source={plannedSvg(W, pl)} alt={`${pl.n}. ${pl.title}: ${s.isPlanned}`} width={W} height={46} />
          ))}
        </Box>
      )
    }

    // Terminal: the same content in text rows.
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))
    const row = (a: AgentRun) => {
      const tier = tierOf(a.type)
      const color = colorOf(tier)
      const ctx = ctxOf(a)
      const progress = progressOf(a)
      return (
        <Box key={a.id} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={color}>▣</Text>
            <Text bold wrap="truncate-end">
              {headingOf(a, f)}
            </Text>
            <Text color={a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : color}>{STATUS_GLYPH[a.status]}</Text>
          </Box>
          {metaOf(a, f).map((m, i) => (
            <Text key={`meta-${i}`} dimColor wrap="truncate-end">
              {'  '}
              {m}
            </Text>
          ))}
          <Text wrap="truncate-end">
            {'  '}
            {progress === null ? <Text dimColor>{ctxBar(ctx, barW)}</Text> : <Text color={color}>{ctxBar(progress * 100, barW)}</Text>}
          </Text>
        </Box>
      )
    }
    const taskRow = (v: TaskView) => (
      <Box key={`task-${v.task.id ?? v.n}`} flexDirection="column" marginBottom={1}>
        <Text bold wrap="truncate-end">
          {v.n}. {titleCase(v.task.title)} <Text dimColor>{titleCase(v.status)}</Text>
        </Text>
        <Text dimColor wrap="truncate-end">
          {'  '}
          {[v.crew ? `${s.crew}: ${titleCase(v.crew)}` : '', v.task.id ? `${s.task}: ${v.task.id}` : '', ...v.gates.map(g => `${gateGlyph(g.verdict)} ${gateShort(g.name)}${g.attempts > 1 ? ' ' + g.attempts : ''}`), v.costUsd === null ? '' : `${fmtCost(v.costUsd)}${v.isShared ? ' + ' + s.shared : ''}`]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        {canOpen(v.task.id) && (
          <Box flexDirection="row">
            <Text dimColor>{'  '}</Text>
            {openButton(v.task.id)}
          </Box>
        )}
      </Box>
    )
    const chipLines = [
      skills.length ? `${s.skills}: ${skills.join(' · ')}` : '',
      health ? `${s.health}: ${[health.heartbeat === undefined ? '' : `${health.heartbeat ? '●' : '○'} ${s.heartbeat}`, health.watchdog === undefined ? '' : `${health.watchdog ? '●' : '○'} ${s.watchdog}`, health.paused ? s.paused : '', health.slots ? `${health.slots} ${s.slots}` : ''].filter(Boolean).join(' · ')}` : '',
    ].filter(Boolean)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">
            {title}
          </Text>
        </Box>
        <Text dimColor>
          {taskCount ? `${s.tasksHead}: ${taskCount.done}/${taskCount.total} · ` : ''}{fmtCost(t.cost)} · {fmtTokens(t.tokens)} {s.tokensWord} · {fmtTime(t.time)}
        </Text>
        {chipLines.map((l, i) => (
          <Box key={`chip-${i}`} flexDirection="row">
            <Text dimColor wrap="truncate-end">
              {l}
            </Text>
          </Box>
        ))}
        {p.isCompact ? (
          <Text wrap="truncate-end">
            {[...running, ...finished].map(a => (
              <Text key={a.id} color={colorOf(tierOf(a.type))}>
                {STATUS_GLYPH[a.status]}{' '}
              </Text>
            ))}
            {planned.map(pl => (
              <Text key={`plan-${pl.n}`} dimColor>
                ◷{' '}
              </Text>
            ))}
          </Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {isEmpty && views.length === 0 && <Text dimColor>{s.empty}</Text>}
            {views.length > 0 && <Text dimColor>{s.tasksHead} · {views.filter(v => v.status === 'done').length}/{views.length}</Text>}
            {views.map(taskRow)}
            {running.length > 0 && <Text dimColor>{s.running} · {running.length}</Text>}
            {running.map(row)}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed && finished.map(row)}
            {planned.length > 0 && <Text dimColor>{s.planned} · {planned.length}</Text>}
            {planned.map(pl => {
              const tier = pl.tier in TIER_COLOR ? pl.tier : 'other'
              return (
                <Box key={`plan-${pl.n}`} flexDirection="column" marginBottom={1}>
                  <Text dimColor wrap="truncate-end">
                    <Text color={colorOf(tier)}>▢</Text> {pl.n}. {titleCase(pl.title)} ◷
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    {'  '}
                    {titleCase(tier)} · {TIER_MODEL[tier] ?? ''}
                    {pl.after.length ? ` · ${s.after} ${pl.after.join(', ')}` : ''}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, flow)
    const list = await read($, agents)
    const gates = gatesOf(list)
    // No flow reported: nothing above the prompt (the gates live in the panel, per task).
    if (e.props.hasSurvey || f === null) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const gateButton =
      gates.runs > 0 ? (
        <Button key="savvy-gates" label={gateLabel(gates)} plain onPress={() => void togglePane($)} />
      ) : null

    const crew = list.length + plannedOf(f, list).length
    const isWorking = list.some(a => a.status === 'running')
    const crewButton = (
      <Button key="savvy-agents" label={`×${crew}`} plain onPress={() => void togglePane($)} />
    )
    const percent = `${Math.round(ratio(f) * 100)}%`
    const dismiss = (
      <Button
        key="savvy-dismiss"
        label="✕"
        plain
        role="dismiss"
        onPress={() => update($, flow, () => null)}
      />
    )

    if ('Svg' in ui) {
      const { Svg } = ui
      // About 8 CSS px per reported column; the rest is the count, the dismiss
      // and their gaps. No floor above the slot: a row wider than it would wrap.
      // The gates counter sits beside the bar, so the bar gives up its width when it shows.
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96 - (gateButton ? 120 : 0)))
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Svg source={rowSvg(f, width, isWorking)} alt={`${f.title}: ${label(f)}, ${percent}`} width={width} height={H} />
          {gateButton}
          {crewButton}
          {dismiss}
        </Box>
      )
    }

    const cols = e.props.bodyColumns
    const titleW = Math.max(8, Math.min(30, f.title.length + 2, Math.floor(cols / 3)))
    const width = Math.max(6, Math.min(40, cols - titleW - 32))
    return (
      <Box flexDirection="row" gap={2}>
        <Box width={titleW} flexShrink={0}>
          <Text color={f.isFinished ? DONE : ACCENT}>● </Text>
          <Text wrap="truncate-end">{titleCase(f.title)}</Text>
        </Box>
        <Text color={f.isFinished ? DONE : ACCENT}>{barText(f, width)}</Text>
        <Text bold>{label(f)}</Text>
        <Text dimColor>{percent}</Text>
        <Text color={CLAY}>▣</Text>
        {gateButton}
        {crewButton}
        {dismiss}
      </Box>
    )
  })
}
