import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

// What the engine would answer beneath the mod: the clock, a finished turn, and no band of its own.
const engine = (on: On): void => {
  mock.clock(on)
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('ui.render', async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  // The mod opens its pane by itself; the test engine takes the request and does nothing.
  on('ui.open', async () => ({ value: undefined }) as never)
}

// No gate run and no flow: the band stays out of the way.
test('nothing shows above the prompt before any gate or flow', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({
    plugin: 'fun-savvy-progress',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120 },
  } as never)
  expect(await ui.find({ key: 'savvy-gates' })).toBeUndefined()
  await ui.unmount()
})

// A gate's verdicts without a reported round: still nothing above the prompt (the old "Checks" band is gone).
test('gate verdicts alone draw no band above the prompt', async ($, on) => {
  engine(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5', agentId: 'gate-1' }))
  await $.agent.spawn({ tool_use_id: 't1', prompt: 'check TASK-41', description: 'Style gate, basket total', subagentType: 'claude', provider: 'user' } as never)
  await $.turn.complete({
    agentId: 'gate-1',
    answer: 'done\nGATE-RECORD: {"project": "p", "task": "TASK-41", "gate": "gate-style", "verdict": "pass", "reason": "ok"}',
    durationMs: 10,
    isAborted: false,
    turnId: 'turn-1',
    reason: 'answer',
  } as never)
  const ui = await $.ui.mount({
    plugin: 'fun-savvy-progress',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 3, bodyColumns: 120 },
  } as never)
  expect(await ui.find({ key: 'savvy-gates' })).toBeUndefined()
  await ui.unmount()
})

// A reported round: the band shows the gates counter, and each sub-agent is headed by the task it
// works, with its name, model, task and the skills it used.
test('a reported round heads each sub-agent with its task, and the gates counter shows above the prompt', async ($, on) => {
  engine(on)
  on('agent.spawn', async (_$, e) => ({ model: /gate/i.test(e.description) ? 'claude-sonnet-5' : 'claude-opus-5-5', agentId: /gate/i.test(e.description) ? 'gate-2' : 'crew-1' }))
  on('tool.call', { tool: 'Skill' }, async () => ({ result: 'ok' }) as never)
  on('tool.call', { tool: 'Read' }, async () => ({ result: 'ok' }) as never)
  await $.tool.call({
    tool: 'mcp__fun-savvy-progress__progress',
    title: 'Release 2.0',
    phaseLabel: 'Building',
    tasks: [
      {
        title: 'checkout page: the total updates when the basket changes',
        id: 'TASK-41',
        crew: 'Ada',
        gates: ['gate-style', 'gate-record'],
        status: 'building',
      },
    ],
    skills: ['task-runner'],
    health: { heartbeat: true, watchdog: true, slots: '1 of 2' },
  } as never)
  await $.agent.spawn({ tool_use_id: 't-crew', prompt: 'work TASK-41 in the shop', description: 'Ada — basket total', subagentType: 'claude', provider: 'user' } as never)
  // The crew's skills: one called, one read from its folder.
  await $.tool.call({ tool: 'Skill', skill: 'frontend-design', agentId: 'crew-1' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/home/someone/.claude/skills/brand-voice/SKILL.md', agentId: 'crew-1' } as never)
  await $.turn.complete({
    agentId: 'crew-1',
    answer: 'done\nCOST-RECORD: {"project": "p", "task": "checkout page: the total updates when the basket changes", "parent": "Release 2.0"}',
    durationMs: 10,
    isAborted: false,
    turnId: 'turn-c',
    reason: 'answer',
  } as never)
  await $.agent.spawn({ tool_use_id: 't-gate', prompt: 'check TASK-41', description: 'Style gate, basket total', subagentType: 'claude', provider: 'user' } as never)
  await $.turn.complete({
    agentId: 'gate-2',
    answer: 'GATE-RECORD: {"project": "p", "task": "TASK-41", "gate": "gate-style", "verdict": "pass", "reason": "ok"}',
    durationMs: 10,
    isAborted: false,
    turnId: 'turn-g',
    reason: 'answer',
  } as never)

  const band = await $.ui.mount({
    plugin: 'fun-savvy-progress',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: true, maxRows: 3, bodyColumns: 120 },
  } as never)
  const gates = await band.find({ key: 'savvy-gates' })
  expect(gates).toBeDefined()
  expect(JSON.stringify(gates)).toContain('Gates ✓1 ✗0')
  await band.unmount()

  const pane = await $.ui.mount({
    plugin: 'fun-savvy-progress',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'savvy-agents',
    props: { bodyColumns: 120, title: 'Agents' },
  } as never)
  // No Tasks list: the round's tasks head the sub-agents that work them instead.
  expect(await pane.find({ key: 'task-TASK-41' })).toBeUndefined()
  const crewRow = JSON.stringify(await pane.find({ key: 'crew-1' }))
  expect(crewRow).not.toContain('Task:')
  expect(crewRow).toContain('Name: Ada')
  expect(crewRow).toContain('Model: Opus 5.5')
  expect(crewRow).toContain('Skills: Frontend Design, Brand Voice')
  const gateRow = JSON.stringify(await pane.find({ key: 'gate-2' }))
  expect(gateRow).toContain('Style Gate: Checkout Page: the Total Updates When the Basket Changes')
  // Every row reads Name, Model, Skills, gates included; the gate's kind is in its heading only.
  expect(gateRow).toMatch(/Name: [A-Z][a-z]+/)
  expect(gateRow).not.toContain('Gate: Style')
  expect(gateRow).toContain('Model: Sonnet 5')
  expect(gateRow).toContain('Skills: None')
  expect(JSON.stringify(await pane.find({ key: 'chip-0' }))).toContain('Skills: Task Runner')
  // Costs in US dollars by default.
  expect(JSON.stringify(await pane.drawn())).toContain('$0.00')
  await pane.unmount()
})

// The Currency setting: costs in the chosen currency at the chosen rate.
test('costs show in the Currency setting', { options: { currency: 'GBP', exchangeRate: '0.5' } }, async ($, on) => {
  engine(on)
  on('agent.spawn', async () => ({ model: 'claude-opus-5-5', agentId: 'crew-9' }))
  await $.agent.spawn({ tool_use_id: 'z', prompt: 'work', description: 'Crew Z — anything', subagentType: 'claude', provider: 'user' } as never)
  const pane = await $.ui.mount({ plugin: 'fun-savvy-progress', surface: 'terminal', component: 'Pane', requestId: 'savvy-agents', props: { bodyColumns: 120, title: 'Agents' } } as never)
  expect(JSON.stringify(await pane.drawn())).toContain('£0.00')
  await pane.unmount()
})

// A gate named the other way round, "Gate: <kind> check, <what>", reads the same as "<kind> gate, <what>":
// the word "Gate" appears once in the heading and the grey line names the kind.
test('a gate named "Gate: design system check" reads Design System Gate, never Gate Gate', async ($, on) => {
  engine(on)
  on('agent.spawn', async () => ({ model: 'claude-sonnet-5', agentId: 'gate-3' }))
  await $.agent.spawn({ tool_use_id: 't3', prompt: 'check it', description: 'Gate: design system check, toolbar spacing', subagentType: 'claude', provider: 'user' } as never)
  const pane = await $.ui.mount({
    plugin: 'fun-savvy-progress',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'savvy-agents',
    props: { bodyColumns: 120, title: 'Agents' },
  } as never)
  const row = JSON.stringify(await pane.find({ key: 'gate-3' }))
  expect(row).toContain('Design System Gate: Toolbar Spacing')
  expect(row).toMatch(/Name: [A-Z][a-z]+/)
  expect(row).not.toContain('Gate Gate')
  expect(row).not.toContain('Gate: Gate')
  await pane.unmount()
})

// A sub-agent whose description does not start with a first name is given one, and two running
// sub-agents never share one.
test('sub-agents without a first name are given one, never twice at once', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', async () => ({ model: 'claude-opus-5-5', agentId: `run-${++n}` }))
  await $.agent.spawn({ tool_use_id: 'x1', prompt: 'look', description: 'Explore — the repo layout', subagentType: 'Explore', provider: 'user' } as never)
  await $.agent.spawn({ tool_use_id: 'x2', prompt: 'look', description: 'Crew A — the same thing', subagentType: 'claude', provider: 'user' } as never)
  const pane = await $.ui.mount({ plugin: 'fun-savvy-progress', surface: 'terminal', component: 'Pane', requestId: 'savvy-agents', props: { bodyColumns: 120, title: 'Agents' } } as never)
  const one = /Name: ([A-Za-z]+)/.exec(JSON.stringify(await pane.find({ key: 'run-1' })))?.[1]
  const two = /Name: ([A-Za-z]+)/.exec(JSON.stringify(await pane.find({ key: 'run-2' })))?.[1]
  expect(one).toBeDefined()
  expect(two).toBeDefined()
  expect(['Explore', 'Crew', 'Gate']).not.toContain(one)
  expect(['Explore', 'Crew', 'Gate']).not.toContain(two)
  expect(one).not.toBe(two)
  await pane.unmount()
})
