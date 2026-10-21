import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

// A pretend computer in memory: a project with two skills switched on and one skill
// switched off, a one-entry personal library, and a vault that answers over a mocked ssh and
// rsync. Every file call the mod makes is answered from this map, so nothing touches the disk.
const PROJECT = '/pretend/project'
const OPTIONS = { libraryServer: 'skills-host', libraryFolder: '/srv/skills library', skillsFolder: 'Skills' }
const HOME = '/pretend/home'

const skillMd = (name: string, category: string, tags: string[]) =>
  `---\nType: skill\nCategory: ${category}\nName: ${name}\nVersion: "1.0.0"\nDescription: "What ${name} does."\nTags:\n${tags.map(t => `  - ${t}`).join('\n')}\n---\n# ${name}\n`

const VAULT_ROWS = [
  { name: 'copywriting', folder: 'Skills', version: '2.1.0', description: 'Write copy that sells.', tags: ['marketing', 'skill-type/general'], category: '' },
  { name: 'security-review', folder: 'Skills', version: '1.0.0', description: 'Check the code for security.', tags: ['security'], category: '' },
  { name: 'persona-writer', folder: 'Skills', version: '1.0.0', description: 'Draft a persona-writer.', tags: ['skill-type/general'], category: 'Design' },
]

const seed = (): Map<string, string> =>
  new Map([
    [`${PROJECT}/.claude/settings.json`, JSON.stringify({ hooks: { Stop: [] }, skillOverrides: { 'old-skill': 'off' } }, null, 2)],
    [`${PROJECT}/.claude/skills/persona-writer/SKILL.md`, skillMd('persona-writer', 'Design', ['skill-type/general'])],
    [`${PROJECT}/.claude/skills/persona-writer/.from-vault.json`, JSON.stringify({ name: 'persona-writer', folder: 'Skills' })],
    [`${PROJECT}/.claude/skills/style-check/SKILL.md`, skillMd('style-check', 'Review', ['review'])],
    [`${PROJECT}/.claude/skills/old-skill/SKILL.md`, skillMd('old-skill', '', ['skill-type/general'])],
    [`${HOME}/.claude/skills/plan-interview/SKILL.md`, skillMd('plan-interview', '', ['skill-type/general']).replace('What plan-interview does.', 'Ask questions about a plan one at a time until every open decision is settled, then write down what was agreed before anything is built.')],
    // The desktop app's own cache folder: no SKILL.md at its top, so it must not be listed.
    [`${HOME}/.claude/skills/synced/manifest.json`, '{}'],
  ])

const engine = (on: On, files: Map<string, string>, ran: string[][]): Map<string, unknown> => {
  mock.clock(on)
  const store = new Map<string, unknown>()
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(path + '/'))
  on('session.cwd', async () => ({ value: PROJECT }))
  on('env.get', async (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) return { deny: `no such file: ${e.path}` } as never
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', async (_$, e) => {
    const names = new Set<string>()
    for (const k of files.keys()) if (k.startsWith(e.path + '/')) names.add(k.slice(e.path.length + 1).split('/')[0] ?? '')
    return { value: [...names].map(name => ({ name, kind: isDir(`${e.path}/${name}`) ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: false })) } as never
  })
  on('fs.stat', async (_$, e) => ({ value: { kind: isDir(e.path) ? 'dir' : 'file', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }) as never)
  on('store.get', async (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', async (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', async (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('process.run', async (_$, e) => {
    ran.push([...e.argv])
    if (e.argv[0] === 'ssh') return { value: { exitCode: 0, stdout: JSON.stringify(VAULT_ROWS), stderr: '' } } as never
    if (e.argv[0] === 'rsync') {
      // The library's copy arriving.
      const target = String(e.argv[e.argv.length - 1]).replace(/\/$/, '')
      files.set(`${target}/SKILL.md`, skillMd('security-review', '', ['security']))
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    }
    if (e.argv[0] === 'rm') {
      const target = String(e.argv[2])
      for (const k of [...files.keys()]) if (k.startsWith(target + '/')) files.delete(k)
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'unexpected command' } } as never
  })
  return store
}

// A press on one of the panel's own drawings, at a place inside it: the switcher's halves, the
// tick box, or a card's switch (its last inside row, at the right).
const CARD_W = 60
const CARD_H = 5

for (const surface of ['terminal'] as const) {
  test(`the panel: Skills | Connectors, Active Only, and cards with a switch (${surface})`, { options: OPTIONS }, async ($, on) => {
    const files = seed()
    const ran: string[][] = []
    engine(on, files, ran)

    await $.command.run({ command: 'skills-panel', args: '' } as never)
    const pane = await $.ui.mount({ plugin: 'skills-panel', surface, component: 'Pane', requestId: 'skills-panel', props: { bodyColumns: 70, title: 'Skills Panel' } } as never)
    const card = (name: string) => pane.find({ key: `card-${name}` })
    const flip = async (name: string) => {
      await pane.resize({ in: `card-${name}`, columns: CARD_W, rows: CARD_H } as never)
      await pane.pointer({ type: 'down', x: CARD_W - 4, y: CARD_H - 2, button: 'left', in: `card-${name}` })
    }

    // Skills, Active Only ticked: the skills switched on, each a card with its switch on.
    expect(await card('persona-writer')).toBeDefined()
    expect(await card('plan-interview')).toBeDefined()
    expect(await card('style-check')).toBeDefined()
    expect(await card('old-skill')).toBeUndefined()
    expect(await card('synced')).toBeUndefined()
    expect(JSON.stringify(await pane.drawn({ in: 'card-plan-interview' }))).toContain('    ●')
    expect(JSON.stringify(await pane.drawn({ in: 'card-plan-interview' }))).toContain('All Projects')
    expect(ran.filter(a => a[0] === 'ssh').length).toBe(0)

    // The search box: no label, "Search" as its placeholder, no button; it narrows as you type,
    // with Active Only ticked too, and an ✕ clears it.
    const box = JSON.stringify(await pane.find({ key: 'search' }))
    expect(box).toContain('"placeholder":"Search"')
    expect(box).not.toContain('"label"')
    expect(box).not.toContain('submitLabel')
    expect(await pane.find({ key: 'clear-search' })).toBeUndefined()
    await pane.input({ key: 'search', text: 'interview', kind: 'change' })
    expect(await card('plan-interview')).toBeDefined()
    expect(await card('persona-writer')).toBeUndefined()
    expect(ran.filter(a => a[0] === 'ssh').length).toBe(0)
    await pane.press({ key: 'clear-search' })
    expect(await card('persona-writer')).toBeDefined()
    expect(await pane.find({ key: 'clear-search' })).toBeUndefined()

    // A click on the card away from its switch changes nothing.
    await pane.resize({ in: 'card-plan-interview', columns: CARD_W, rows: CARD_H } as never)
    await pane.pointer({ type: 'down', x: 3, y: 1, button: 'left', in: 'card-plan-interview' })
    expect(JSON.parse(files.get(`${PROJECT}/.claude/settings.json`) ?? '{}').skillOverrides['plan-interview']).toBeUndefined()

    // Unticking Active Only: what is off here, then the library's skills not installed.
    await pane.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'show-active' })
    expect(ran.filter(a => a[0] === 'ssh').length).toBe(1)
    expect(await card('old-skill')).toBeDefined()
    expect(await card('copywriting')).toBeDefined()
    expect(await card('security-review')).toBeDefined()
    expect(await card('persona-writer')).toBeUndefined()
    expect(await card('style-check')).toBeUndefined()
    expect(JSON.stringify(await pane.drawn({ in: 'card-security-review' }))).toContain('●    ')
    await pane.input({ key: 'search', text: 'security' })
    expect(await card('security-review')).toBeDefined()
    expect(await card('copywriting')).toBeUndefined()
    await pane.input({ key: 'search', text: '' })

    // Flipping a library card's switch installs it: rsync from the Skills folder and the receipt;
    // it leaves the unticked list and shows when Active Only is ticked.
    await flip('security-review')
    const rsync = ran.find(a => a[0] === 'rsync')
    expect(rsync?.[rsync.length - 2]).toBe('skills-host:/srv/skills\\ library/Skills/security-review/')
    expect(rsync?.[rsync.length - 1]).toBe(`${PROJECT}/.claude/skills/security-review/`)
    expect(JSON.parse(files.get(`${PROJECT}/.claude/skills/security-review/.from-vault.json`) ?? '{}').folder).toBe('Skills')
    expect(await card('security-review')).toBeUndefined()
    await pane.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'show-active' })
    expect(await card('security-review')).toBeDefined()
    await pane.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'show-active' })

    // Turning the switched-off skill back on takes its mark out of settings.json.
    await flip('old-skill')
    let settings = JSON.parse(files.get(`${PROJECT}/.claude/settings.json`) ?? '{}')
    expect(settings.skillOverrides['old-skill']).toBeUndefined()
    expect(settings.hooks).toBeDefined()

    // Ticked again: turning off a hand-written skill only marks it; a vault copy is removed too.
    await pane.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'show-active' })
    await flip('plan-interview')
    settings = JSON.parse(files.get(`${PROJECT}/.claude/settings.json`) ?? '{}')
    expect(settings.skillOverrides['plan-interview']).toBe('off')
    expect(ran.some(a => a[0] === 'rm')).toBe(false)
    await flip('persona-writer')
    settings = JSON.parse(files.get(`${PROJECT}/.claude/settings.json`) ?? '{}')
    expect(settings.skillOverrides['persona-writer']).toBe('off')
    expect(ran.some(a => a[0] === 'rm' && a[2] === `${PROJECT}/.claude/skills/persona-writer`)).toBe(true)
    expect(await card('persona-writer')).toBeUndefined()
    expect(await card('old-skill')).toBeDefined()

    await pane.unmount()
  })
}


// Every desktop drawing must be one valid SVG: no attribute written twice in a tag, every tag
// closed. A broken drawing shows as a broken-image icon with its alt text.
const checkSvg = (source: string): string[] => {
  const faults: string[] = []
  for (const m of source.matchAll(/<([a-zA-Z]+)((?:\s+[a-zA-Z:-]+="[^"]*")*)\s*\/?>/g)) {
    const names = [...(m[2] ?? '').matchAll(/([a-zA-Z:-]+)="/g)].map(a => a[1])
    const twice = names.filter((n, i) => names.indexOf(n) !== i)
    if (twice.length) faults.push(`<${m[1]}> has ${twice.join(', ')} twice`)
  }
  const open = (source.match(/<(?!\/|\?|!)[a-zA-Z][^>]*[^/]>/g) ?? []).length
  const close = (source.match(/<\/[a-zA-Z]+>/g) ?? []).length
  if (open !== close) faults.push(`${open} tags opened, ${close} closed`)
  return faults
}

// The desktop: the same layout from the app's own buttons and drawn cards, never a self-drawn
// piece (they leave the desktop pane blank), and every card a valid drawing.
test('the desktop: Skills | Connectors buttons, Active Only, drawn rows with a switch under each', { options: OPTIONS }, async ($, on) => {
  const files = seed()
  const ran: string[][] = []
  engine(on, files, ran)
  await $.command.run({ command: 'skills-panel', args: '' } as never)
  const pane = await $.ui.mount({ plugin: 'skills-panel', surface: 'desktop', component: 'Pane', requestId: 'skills-panel', props: { bodyColumns: 70, title: 'Skills Panel' } } as never)
  const svgsValid = async () => {
    for (const el of await pane.findAll({ type: 'Svg' })) expect({ alt: el.props.alt, faults: checkSvg(String(el.props.source)) }).toEqual({ alt: el.props.alt, faults: [] })
  }
  expect(await pane.findAll({ type: 'Client' })).toHaveLength(0)
  // Search and Active Only share one line.
  const row = JSON.stringify(await pane.find({ key: 'search-row' }))
  expect(row).toContain('"key":"search"')
  expect(row).toContain('show-active-fallback')
  // Read the Vault Again sits on the tabs' line, at its right.
  const top = JSON.stringify(await pane.find({ key: 'top' }))
  expect(top).toContain('space-between')
  expect(top).toContain('Refresh')
  expect(top).toContain('tab-skills')
  // No cards: each row a drawing with a hairline above, and a small plain button under it, at the left.
  const holder = JSON.stringify(await pane.find({ key: 'card-plan-interview' }))
  expect(holder).toContain('"plain":true')
  expect(holder).toContain('<line class=\\"ln\\"')
  expect(await pane.find({ key: 'card-plan-interview' })).toBeDefined()
  expect(await pane.find({ key: 'card-style-check' })).toBeDefined()
  expect(await pane.find({ key: 'tab-gates' })).toBeUndefined()
  // The switch's words are underlined text at rest, not on hover, with a blank button laid over them.
  const sw = JSON.stringify(await pane.find({ key: 'switch-box-plan-interview' }))
  expect(sw).toContain('Switch Off')
  expect(sw).toContain('"underline":true')
  expect(sw).toContain('"hover":{"underline":false}')
  expect(sw).toContain('"position":"absolute"')
  expect(JSON.stringify(await pane.find({ key: 'switch-plan-interview' }))).toContain('Switch Off')
  await svgsValid()

  // Off, then the switched-off list and the vault, then on again.
  await pane.press({ key: 'switch-plan-interview' })
  expect(JSON.parse(files.get(`${PROJECT}/.claude/settings.json`) ?? '{}').skillOverrides['plan-interview']).toBe('off')
  await pane.press({ key: 'show-active-fallback' })
  expect(JSON.stringify(await pane.find({ key: 'show-active-fallback' }))).toContain('☐\u00a0\u00a0Active Only')
  expect(await pane.find({ key: 'card-plan-interview' })).toBeDefined()
  expect(await pane.find({ key: 'card-copywriting' })).toBeDefined()
  await svgsValid()
  await pane.press({ key: 'switch-plan-interview' })
  expect(JSON.parse(files.get(`${PROJECT}/.claude/settings.json`) ?? '{}').skillOverrides['plan-interview']).toBeUndefined()

  // Installing a skill from the library.
  expect(await pane.find({ key: 'card-security-review' })).toBeDefined()
  await pane.press({ key: 'switch-security-review' })
  expect(JSON.parse(files.get(`${PROJECT}/.claude/skills/security-review/.from-vault.json`) ?? '{}').folder).toBe('Skills')
  await pane.press({ key: 'show-active-fallback' })
  expect(await pane.find({ key: 'card-security-review' })).toBeDefined()
  await svgsValid()
  await pane.unmount()
})

// The Connectors tab: this session's connectors from the desktop app's own switch, a Switch On /
// Switch Off for the Claude-account ones, none for the rest, and each change put back when the
// session ends so it stays the session's.
test('the Connectors tab switches a connector for the session and records how to put it back', { options: OPTIONS }, async ($, on) => {
  const files = seed()
  const ran: string[][] = []
  const store = engine(on, files, ran)
  const servers = [
    { name: 'Docs', id: 'id-docs', kind: 'connector', status: 'connected', tool_count: 8 },
    { name: 'Video', id: 'id-video', kind: 'connector', status: 'disabled' },
    { name: 'pdf-viewer', kind: 'desktop', status: 'connected', tool_count: 3 },
  ]
  const switched: { connector: unknown; enabled: unknown }[] = []
  on('mcp.call', async (_$, e) => {
    if (e.server !== 'ccd_connectors') return { value: { content: [], isError: true } } as never
    if (e.tool === 'set_session_connector_enabled') {
      switched.push({ connector: e.args.connector, enabled: e.args.enabled })
      const s = servers.find(x => x.id === e.args.connector || x.name === e.args.connector)
      if (s) s.status = e.args.enabled ? 'connected' : 'disabled'
      return { value: { content: [{ type: 'text', text: 'ok' }], isError: false } } as never
    }
    return { value: { content: [{ type: 'text', text: JSON.stringify({ servers }) }], isError: false } } as never
  })
  on('session.id', async () => ({ value: 'session-1' }) as never)
  on('tool.check', async () => ({ decision: 'allow' }) as never)
  await $.command.run({ command: 'skills-panel', args: '' } as never)
  const pane = await $.ui.mount({ plugin: 'skills-panel', surface: 'desktop', component: 'Pane', requestId: 'skills-panel', props: { bodyColumns: 70, title: 'Skills Panel' } } as never)
  await pane.press({ key: 'tab-connectors' })

  // Active Only ticked: the connected ones; the desktop extension has no switch.
  expect(await pane.find({ key: 'card-Docs' })).toBeDefined()
  expect(await pane.find({ key: 'card-pdf-viewer' })).toBeDefined()
  expect(await pane.find({ key: 'card-Video' })).toBeUndefined()
  expect(await pane.find({ key: 'switch-pdf-viewer' })).toBeDefined()
  expect(JSON.stringify(await pane.find({ key: 'card-Docs' }))).toContain('8 tools')

  // Switching Docs off goes through the app's switch, by its id.
  await pane.press({ key: 'switch-Docs' })
  expect(switched).toEqual([{ connector: 'id-docs', enabled: false }])
  expect(await pane.find({ key: 'card-Docs' })).toBeUndefined()

  // Unticked: the switched-off ones; Video on.
  await pane.press({ key: 'show-active-fallback' })
  expect(await pane.find({ key: 'card-Docs' })).toBeDefined()
  await pane.press({ key: 'switch-Video' })
  expect(switched[1]).toEqual({ connector: 'id-video', enabled: true })

  // A server the app's switch cannot reach is switched off by the panel for the session: no call to
  // the app, its tools refused, and it lists with the switched-off ones until switched back on.
  await pane.press({ key: 'show-active-fallback' })
  await pane.press({ key: 'switch-pdf-viewer' })
  expect(switched.some(x => x.connector === 'pdf-viewer')).toBe(false)
  expect(await pane.find({ key: 'card-pdf-viewer' })).toBeUndefined()
  const refused = await $.tool.check({ tool: 'mcp__pdf-viewer__display_pdf', input: {} } as never)
  expect(JSON.stringify(refused)).toContain('deny')
  const other = await $.tool.check({ tool: 'mcp__Docs__read', input: {} } as never)
  expect(JSON.stringify(other)).not.toContain('deny')
  await pane.press({ key: 'show-active-fallback' })
  expect(JSON.stringify(await pane.find({ key: 'card-pdf-viewer' }))).toContain('Off for this session')
  await pane.press({ key: 'switch-pdf-viewer' })
  expect(JSON.stringify(await $.tool.check({ tool: 'mcp__pdf-viewer__display_pdf', input: {} } as never))).not.toContain('deny')

  // Each connector's state before its first change is kept, for session.end to put back. (The test
  // kit cannot raise session.end itself, so the putting back is not exercised here.)
  expect(store.get('restore:session-1')).toEqual({ Docs: { id: 'id-docs', wasOn: true }, Video: { id: 'id-video', wasOn: false } })
  await pane.unmount()
})

// With no library set up, the panel still lists what is installed, never reaches for a server, and
// says how to set a library up where the library's rows would be.
test('without a library: installed skills only, and a note saying how to set one up', async ($, on) => {
  const files = seed()
  const ran: string[][] = []
  engine(on, files, ran)
  await $.command.run({ command: 'skills-panel', args: '' } as never)
  const pane = await $.ui.mount({ plugin: 'skills-panel', surface: 'desktop', component: 'Pane', requestId: 'skills-panel', props: { bodyColumns: 70, title: 'Skills Panel' } } as never)
  expect(await pane.find({ key: 'card-plan-interview' })).toBeDefined()
  expect(await pane.find({ key: 'refresh-vault' })).toBeUndefined()
  await pane.press({ key: 'show-active-fallback' })
  expect(JSON.stringify(await pane.find({ key: 'setup' }))).toContain('/config')
  expect(await pane.find({ key: 'card-old-skill' })).toBeDefined()
  expect(ran.some(a => a[0] === 'ssh' || a[0] === 'python3')).toBe(false)
  await pane.unmount()
})
