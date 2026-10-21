export type Phase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

/** A task of the round, as the orchestrator reports it. */
export type PlannedTask = {
  title: string
  tier: string
  after: number[]
  /** The task's own id on the board, used to match crews, gates and costs to it. */
  id?: string
  /** The crew it was handed to, by codename. */
  crew?: string
  /** The gates expected to check it, by name. */
  gates?: string[]
  /** Where it is: to do, building, gating, done, blocked. */
  status?: string
}

export type Health = {
  heartbeat?: boolean
  watchdog?: boolean
  paused?: boolean
  /** Crew slots in use, as words, e.g. "2 of 2". */
  slots?: string
}

export type Flow = {
  title: string
  total: number
  done: number
  running: number
  phase: Phase
  /** Free words for the pill, e.g. "Building", "Gating", "Merging"; the phase's own label when empty. */
  phaseLabel?: string
  isFinished: boolean
  tasks: PlannedTask[]
  skills?: string[]
  health?: Health
}

export type AgentStatus = 'running' | 'done' | 'failed'

/** One verdict line from a gate's report. */
export type GateRecord = { task: string; gate: string; verdict: string }

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  round: number
  /** Self-reported by the worker through the `step` tool, or read off its commands (stepSource says which). */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
  stepSource?: 'self' | 'watched'
  /** Tool calls the crew has made, which nudge its bar between stages. */
  calls?: number
  /** A gate run: its description starts with "Gate", or its report carried a GATE-RECORD line. */
  isGate?: boolean
  /** Verdicts read from the GATE-RECORD lines of a gate run's report. */
  verdicts?: { pass: number; fail: number; na: number }
  /** Every GATE-RECORD line of the report, one entry each. */
  gateRecords?: GateRecord[]
  /** The task names from the report's COST-RECORD lines. */
  costTasks?: string[]
  /** Board task ids found in the brief the crew was given. */
  taskIds?: string[]
  /** Skills this sub-agent used, by name: its Skill tool calls and the SKILL.md files it read. */
  skills?: string[]
  /** The crew's name, read from its description ("Crew A — …"). */
  crew?: string
  /** The rest of the description after the codename. */
  lane?: string
  /** The costume picked at spawn for a run that is not a savvy tier; never the plain crab. */
  costume?: string
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  autoOpenedFor: string
}

declare module 'claude-code' {
  interface PluginState {
    'savvy-progress': {
      flow: Flow | null
      agents: AgentRun[]
      panel: Panel
      now: number
      /** Skills the main session has invoked, by name, in order of first use. */
      skills: string[]
    }
  }
}
