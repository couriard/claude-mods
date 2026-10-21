// Skill Switchboard: the skills and connectors of the session's project in one panel, each with
// a switch, and a search of a skills library (a folder on this computer, or on a server reached
// over ssh) with a switch that copies a skill in from it.
//
//   - A skill is "on" when its folder is in the project's own .claude/skills or in ~/.claude/skills,
//     and the project's .claude/settings.json does not say "off" for it under skillOverrides.
//   - Switching on from the library copies the folder into the project's own .claude/skills with a
//     receipt (.from-vault.json) inside it, and takes any "off" out of settings.json.
//   - Switching off writes "off" into settings.json and, when the copy is one that came from the
//     library, deletes that copy (the library still has it). A hand-written skill is never deleted.
// Nothing here ever writes to the library, and nothing writes into ~/.claude/skills.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Connector, Installed, VaultEntry, View } from '../types'

const PANE = 'skill-switchboard'
const COMMAND = 'skill-switchboard'

// Where the skills library is: the Library Location setting, read when the module loads (see
// register). Empty means no library is set up, and the panel says how to set one. One setting takes
// every kind of home, worked out from how it is written (see placeOf):
//   a folder here        ~/skills, /Volumes/Team/skills, a synced iCloud, Dropbox or OneDrive folder
//   a server over ssh    my-server:/srv/skills (a host or an ssh config alias, a colon, its path)
//   a git repository     github:owner/repo, gitlab:owner/repo, bitbucket:owner/repo, or any git
//                        address (https://…, git@…, ssh://…); kept as a local copy, updated by Refresh
//   a download           https://…/skills.zip, kept unpacked locally, fetched again by Refresh
type LibraryConfig = { location: string; skillsFolder: string }
let library: LibraryConfig = { location: '', skillsFolder: '' }
// The folder inside the library that holds the skills; '.' when they sit in the library folder itself.
const libraryFolders = (): string[] => [library.skillsFolder || '.']

const RECEIPT = '.from-vault.json'
// A fresh listing is asked for after this long (fifteen minutes).
const VAULT_STALE_MS = 15 * 60 * 1000
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']

// A path escaped for the server's shell, where rsync and ssh hand it on.
const remoteEscape = (s: string): string => s.replace(/([^A-Za-z0-9_\/.,:@%+=~-])/g, '\\$1')
// A path on this computer with a leading ~ made the home folder.
async function localPath($: EngineInterface, p: string): Promise<string> {
  return p === '~' || p.startsWith('~/') ? `${(await $.env.get('HOME')) ?? ''}${p.slice(1)}` : p
}

// What a location says, before anything is fetched.
type Place =
  | { kind: 'folder'; path: string }
  | { kind: 'server'; host: string; path: string }
  | { kind: 'git'; url: string }
  | { kind: 'download'; url: string }

const GIT_HOSTS: Record<string, string> = { github: 'https://github.com', gitlab: 'https://gitlab.com', bitbucket: 'https://bitbucket.org' }

function placeOf(location: string): Place {
  const l = location.trim()
  const short = /^(github|gitlab|bitbucket):([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(l)
  if (short) return { kind: 'git', url: `${GIT_HOSTS[(short[1] ?? '').toLowerCase()]}/${short[2]}.git` }
  if (/^https?:\/\/\S+\.zip(\?\S*)?$/i.test(l)) return { kind: 'download', url: l }
  if (/^(git@|ssh:\/\/|git:\/\/)\S+$/i.test(l) || /^https?:\/\/\S+\.git\/?$/i.test(l)) return { kind: 'git', url: l }
  // A web page of a repository on a known host (https://github.com/owner/repo) is its git address.
  const page = /^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/([^/\s]+\/[^/\s]+?)\/?$/i.exec(l)
  if (page) return { kind: 'git', url: `https://${page[1]}/${page[2]}.git` }
  // host:path, with no slash or tilde before the colon (a path on this computer never has one).
  const server = /^([A-Za-z0-9._@-]+):(.+)$/.exec(l)
  if (server && !/^[A-Za-z]:[\\/]/.test(l)) return { kind: 'server', host: server[1] ?? '', path: server[2] ?? '' }
  return { kind: 'folder', path: l }
}

// Where a git repository or a download is kept on this computer: one folder per location.
async function cacheDir($: EngineInterface, url: string): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  const slug = url.replace(/^[a-z]+:\/\//i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(-80)
  return `${home}/.claude/skill-switchboard/libraries/${slug}`
}

async function run($: EngineInterface, argv: string[], what: string, timeoutMs = 120000): Promise<void> {
  const { exitCode, stderr } = await $.process.run(argv, { timeoutMs })
  if (exitCode !== 0) throw new Error(`${what}: ${(stderr || '').trim().split('\n')[0] || 'no reason given'}`)
}

// The library as a folder the panel can read: on this computer, or on a server over ssh. A git
// repository is cloned on first use and pulled again when `isFresh` (Refresh); a download is fetched
// and unpacked the same way. Private repositories work wherever this computer's git can reach them.
async function whereIs($: EngineInterface, isFresh: boolean): Promise<{ host: string; path: string }> {
  const place = placeOf(library.location)
  if (place.kind === 'server') return { host: place.host, path: place.path }
  if (place.kind === 'folder') return { host: '', path: await localPath($, place.path) }
  const dir = await cacheDir($, place.url)
  if (place.kind === 'git') {
    if (!(await $.fs.exists(`${dir}/.git`))) {
      await run($, ['git', 'clone', '--depth', '1', place.url, dir], 'the library repository could not be copied')
    } else if (isFresh) {
      await run($, ['git', '-C', dir, 'pull', '--ff-only', '--depth', '1'], 'the library repository could not be updated')
    }
    return { host: '', path: dir }
  }
  // A download: fetched into the folder and unpacked there. A zip holding one top folder (as a
  // repository's download does) is read from inside it.
  if (isFresh || !(await $.fs.exists(`${dir}/files`))) {
    await run($, ['rm', '-rf', dir], 'the old download could not be cleared')
    await run($, ['mkdir', '-p', `${dir}/files`], 'the download folder could not be made')
    await run($, ['curl', '-fsSL', '-o', `${dir}/library.zip`, place.url], 'the library could not be downloaded')
    await run($, ['unzip', '-oq', `${dir}/library.zip`, '-d', `${dir}/files`], 'the library download could not be unpacked')
  }
  const inside = (await $.fs.list(`${dir}/files`)).filter(e => !e.name.startsWith('.') && !e.name.startsWith('__MACOSX'))
  const only = inside.length === 1 && inside[0]?.kind === 'dir' ? inside[0].name : ''
  return { host: '', path: only ? `${dir}/files/${only}` : `${dir}/files` }
}

const installed = atom({ plugin: 'skill-switchboard', key: 'installed' } as const, [])
const vault = atom({ plugin: 'skill-switchboard', key: 'vault' } as const, null)
const faulted = atom({ plugin: 'skill-switchboard', key: 'faulted' } as const, [])
const connectors = atom({ plugin: 'skill-switchboard', key: 'connectors' } as const, null)
// Servers switched off for this session by the panel itself (those the app's switch cannot reach).
const hiddenServers = atom({ plugin: 'skill-switchboard', key: 'hidden' } as const, [])
const view = atom({ plugin: 'skill-switchboard', key: 'view' } as const, { tab: 'skills', showActive: true, query: '', busy: '', note: '' })

// A skill's name: lower case letters, digits and hyphens, nothing that could be a path.
const NAME = /^[a-z0-9][a-z0-9-]*$/

// ---------------------------------------------------------------------------------------------
// Reading a SKILL.md's front matter: the few fields the panel shows.

type Front = { name: string; description: string; version: string; category: string; tags: string[] }

const frontOf = (text: string): Front => {
  const out: Front = { name: '', description: '', version: '', category: '', tags: [] }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return out
  const lines = (m[1] ?? '').split(/\r?\n/)
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const km = /^([A-Za-z][A-Za-z0-9 _-]*?):[ \t]*(.*)$/.exec(line)
    if (!km) continue
    const key = (km[1] ?? '').toLowerCase()
    let value = (km[2] ?? '').trim()
    // A block scalar ("description: |" or ">-"): the indented lines under it, folded into one.
    if (/^[|>][+-]?\d*$/.test(value)) {
      const block: string[] = []
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] ?? ''
        if (next.trim() === '') continue
        if (/^[ \t]/.test(next)) block.push(next.trim())
        else break
      }
      value = block.join(' ')
    }
    if (key === 'tags') {
      const items: string[] = []
      if (value) items.push(...value.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean))
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] ?? ''
        if (/^[ \t]*-/.test(next)) items.push(unquote(next.trim().slice(1)))
        else if (next.trim()) break
      }
      out.tags = items
    } else if (key === 'name') out.name = unquote(value)
    else if (key === 'description') out.description = unquote(value)
    else if (key === 'version') out.version = unquote(value)
    else if (key === 'category') out.category = unquote(value)
  }
  return out
}


// ---------------------------------------------------------------------------------------------
// Where things are: the project (the session's folder) and the skills in ~/.claude/skills.

const projectDir = async ($: EngineInterface): Promise<string> => $.session.cwd()
const libraryDir = async ($: EngineInterface): Promise<string> => `${(await $.env.get('HOME')) ?? ''}/.claude/skills`
const projectSkills = (project: string): string => `${project}/.claude/skills`
const settingsPath = (project: string): string => `${project}/.claude/settings.json`

// The project's settings file: read whole, changed in one key, written back
// whole with two-space indents. A file that cannot be parsed is a refusal, never an empty start.
async function readSettings($: EngineInterface, project: string): Promise<Record<string, unknown>> {
  const path = settingsPath(project)
  if (!(await $.fs.exists(path))) return {}
  const data = JSON.parse(await $.fs.read(path)) as unknown
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('the project\'s .claude/settings.json is not an object, so nothing was changed')
  return data as Record<string, unknown>
}

async function setOverride($: EngineInterface, project: string, name: string, isOff: boolean): Promise<void> {
  const data = await readSettings($, project)
  const raw = data.skillOverrides
  const overrides: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}
  if (isOff) overrides[name] = 'off'
  else delete overrides[name]
  data.skillOverrides = overrides
  await $.fs.write(settingsPath(project), JSON.stringify(data, null, 2) + '\n')
}

const offNames = (data: Record<string, unknown>): Set<string> => {
  const raw = data.skillOverrides
  const out = new Set<string>()
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (v === 'off') out.add(k)
  }
  return out
}

// Every skill folder in one place: a folder (or a link to one) with a SKILL.md at its top. The
// desktop app's own skill cache (~/.claude/skills/synced) has none at its top, so it is skipped.
async function readFolder($: EngineInterface, dir: string, where: Installed['where'], off: Set<string>): Promise<Installed[]> {
  if (!(await $.fs.exists(dir))) return []
  const out: Installed[] = []
  for (const entry of await $.fs.list(dir)) {
    if (entry.name.startsWith('.') || !NAME.test(entry.name)) continue
    const folder = `${dir}/${entry.name}`
    const skillMd = `${folder}/SKILL.md`
    if (!(await $.fs.exists(skillMd))) continue
    let front: Front
    try {
      front = frontOf(await $.fs.read(skillMd))
    } catch {
      continue
    }
    let isFromVault = false
    try {
      const receipt = JSON.parse(await $.fs.read(`${folder}/${RECEIPT}`)) as { name?: unknown; folder?: unknown }
      isFromVault = receipt?.name === entry.name
    } catch {
      // No receipt: a skill written by hand, or placed here some other way.
    }
    out.push({
      name: entry.name,
      kind: 'skill',
      version: front.version,
      description: front.description,
      isOff: off.has(entry.name),
      where,
      isFromVault,
    })
  }
  return out
}

// The project's folder first, then the library; a name in both is listed once, as the project's.
async function refresh($: EngineInterface): Promise<void> {
  const project = await projectDir($)
  let off = new Set<string>()
  try {
    off = offNames(await readSettings($, project))
  } catch {
    // Unreadable settings: nothing reads as off.
  }
  const mine = await readFolder($, projectSkills(project), 'project', off)
  const seen = new Set(mine.map(s => s.name))
  const library = (await readFolder($, await libraryDir($), 'library', off)).filter(s => !seen.has(s.name))
  const list = [...mine, ...library].sort((a, b) => a.name.localeCompare(b.name))
  await update($, installed, () => list)
}

// ---------------------------------------------------------------------------------------------
// The library: its listing, read by a small script run here or on the library's server, sent over
// its own input (so no path is ever quoted into a command line), and kept for fifteen minutes.

const vaultReader = (root: string): string => `
import json, os, re, sys
ROOT = os.path.expanduser(${JSON.stringify(root)})
FOLDERS = ${JSON.stringify(libraryFolders())}
def front(t):
    m = re.match(r'^---\\r?\\n(.*?)\\r?\\n---', t, re.S)
    if not m: return {}
    out = {}; lines = m.group(1).splitlines()
    for i, l in enumerate(lines):
        k = re.match(r'^([A-Za-z][A-Za-z0-9 _-]*?):[ \\t]*(.*)$', l)
        if not k: continue
        key, val = k.group(1).lower(), k.group(2).strip()
        if val:
            if re.match(r'^[|>][+-]?\\d*$', val):
                block = []
                for n in lines[i+1:]:
                    if n.strip() == '': continue
                    if re.match(r'^[ \\t]', n): block.append(n.strip())
                    else: break
                out[key] = ' '.join(block)
            else:
                out[key] = val.strip('"').strip("'")
            continue
        items = []
        for n in lines[i+1:]:
            if re.match(r'^[ \\t]*-', n): items.append(n.strip()[1:].strip().strip('"').strip("'"))
            elif n.strip(): break
        out[key] = items
    return out
rows = []
for folder in FOLDERS:
    base = os.path.join(ROOT, folder)
    if not os.path.isdir(base): continue
    for name in sorted(os.listdir(base)):
        d = os.path.join(base, name)
        if name.startswith('.') or not os.path.isdir(d): continue
        p = os.path.join(d, 'SKILL.md')
        if not os.path.isfile(p): continue
        try:
            f = front(open(p, encoding='utf-8', errors='replace').read())
        except OSError:
            continue
        tags = f.get('tags') or []
        if isinstance(tags, str): tags = [t.strip() for t in tags.strip('[]').split(',') if t.strip()]
        desc = f.get('description') or ''
        if isinstance(desc, list): desc = ' '.join(desc)
        ver = f.get('version') or ''
        if isinstance(ver, list): ver = ''
        cat = f.get('category') or ''
        if isinstance(cat, list): cat = ''
        rows.append({'name': name, 'folder': folder, 'version': ver, 'description': desc, 'tags': tags, 'category': cat})
json.dump(rows, sys.stdout)
`

type VaultCache = { at: number; list: VaultEntry[] }

async function fetchVault($: EngineInterface, isFresh: boolean): Promise<VaultEntry[]> {
  const now = await $.clock.now()
  if (!isFresh) {
    const cached = (await $.store.get('vault')) as VaultCache | undefined
    if (cached && Array.isArray(cached.list) && now - cached.at < VAULT_STALE_MS) return cached.list
  }
  if (!library.location) throw new Error(NOT_SET_UP)
  const at = await whereIs($, isFresh)
  const argv = at.host ? ['ssh', ...SSH_OPTIONS, at.host, 'python3', '-'] : ['python3', '-']
  const { exitCode, stdout, stderr } = await $.process.run(argv, { stdin: vaultReader(at.path), timeoutMs: 40000 })
  if (exitCode !== 0) throw new Error(`the library could not be read: ${(stderr || '').trim().split('\n')[0] || 'no reason given'}`)
  const rows = JSON.parse(stdout) as { name: string; folder: string; version: string; description: string; tags: string[]; category: string }[]
  const list: VaultEntry[] = rows
    .filter(r => NAME.test(r.name) && libraryFolders().includes(r.folder))
    .map(r => ({
      name: r.name,
      folder: r.folder,
      kind: 'skill',
      version: r.version,
      description: r.description,
      tags: r.tags,
    }))
  await $.store.set('vault', { at: now, list } satisfies VaultCache)
  return list
}

// The search: every word typed must appear somewhere in the name, description or tags.
const matches = (entry: VaultEntry, query: string): boolean => {
  const hay = `${entry.name} ${entry.description} ${entry.tags.join(' ')}`.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w))
}

// ---------------------------------------------------------------------------------------------
// Switching: on, off, and on from the library.

// The folder a name would take in the project, checked: a direct child of the project's own
// .claude/skills once every link is followed, so a planted link cannot lead the delete elsewhere.
async function projectCopy($: EngineInterface, project: string, name: string): Promise<{ path: string; exists: boolean }> {
  if (!NAME.test(name)) throw new Error('that is not a skill name')
  const root = projectSkills(project)
  const path = `${root}/${name}`
  if (!(await $.fs.exists(path))) return { path, exists: false }
  const rootReal = (await $.fs.stat(root, { resolve: true })).realPath ?? root
  const real = (await $.fs.stat(path, { resolve: true })).realPath ?? path
  if (real !== `${rootReal}/${name}`) throw new Error(`${name} points outside the project's skills folder, so it was left alone`)
  return { path, exists: true }
}

async function pullFromVault($: EngineInterface, entry: VaultEntry): Promise<void> {
  const project = await projectDir($)
  const copy = await projectCopy($, project, entry.name)
  if (copy.exists) {
    let isOurs = false
    try {
      isOurs = (JSON.parse(await $.fs.read(`${copy.path}/${RECEIPT}`)) as { name?: unknown }).name === entry.name
    } catch {
      // No receipt.
    }
    if (!isOurs) throw new Error(`this project already has a skill called ${entry.name} that did not come from the library, so it was left alone`)
  }
  // rsync, by argument vector. On a server the path is escaped for its shell, which would split
  // it at a space otherwise and land the copy somewhere else. --delete keeps the copy exact.
  const at = await whereIs($, false)
  const base = at.path.replace(/\/+$/, '')
  const source = at.host
    ? `${at.host}:${remoteEscape(`${base}/${entry.folder}/${entry.name}/`)}`
    : `${base}/${entry.folder}/${entry.name}/`
  const argv = at.host
    ? ['rsync', '-a', '--delete', '--exclude', '.git', '-e', `ssh ${SSH_OPTIONS.join(' ')}`, source, `${copy.path}/`]
    : ['rsync', '-a', '--delete', '--exclude', '.git', source, `${copy.path}/`]
  const { exitCode, stderr } = await $.process.run(argv, { timeoutMs: 120000 })
  if (exitCode !== 0) throw new Error(`the library could not be read: ${(stderr || '').trim().split('\n')[0] || 'no reason given'}`)
  if (!(await $.fs.exists(`${copy.path}/SKILL.md`))) throw new Error(`${entry.name} came down without a SKILL.md`)
  const today = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const receipt = { name: entry.name, folder: entry.folder, version: entry.version, from: library.location, pulled: today }
  await $.fs.write(`${copy.path}/${RECEIPT}`, JSON.stringify(receipt, null, 2) + '\n')
  await setOverride($, project, entry.name, false)
}

async function switchOn($: EngineInterface, name: string): Promise<string> {
  const project = await projectDir($)
  const have = (await read($, installed)).find(s => s.name === name)
  if (have) {
    await setOverride($, project, name, false)
    return `${name} switched on`
  }
  const entry = (await fetchVault($, true)).find(v => v.name === name)
  if (!entry) throw new Error(`${name} is not in the library`)
  await pullFromVault($, entry)
  return `${name} copied from the library and switched on`
}

async function switchOff($: EngineInterface, name: string): Promise<string> {
  const project = await projectDir($)
  const have = (await read($, installed)).find(s => s.name === name)
  if (!have) throw new Error(`${name} is not installed`)
  if (have.where === 'project' && have.isFromVault) {
    const copy = await projectCopy($, project, name)
    if (copy.exists) {
      const { exitCode, stderr } = await $.process.run(['rm', '-rf', copy.path])
      if (exitCode !== 0) throw new Error(`could not remove ${name}: ${(stderr || '').trim().split('\n')[0]}`)
    }
    await setOverride($, project, name, true)
    return `${name} switched off and its copy removed (the library still has it)`
  }
  await setOverride($, project, name, true)
  return `${name} switched off`
}

// Runs one switch with the row marked busy, then re-reads the folders and leaves a note.
async function act($: EngineInterface, name: string, job: () => Promise<string>): Promise<void> {
  await update($, view, v => ({ ...v, busy: name, note: '' }))
  let note: string
  try {
    note = await job()
  } catch (err) {
    note = err instanceof Error ? err.message : String(err)
  }
  await refresh($)
  await update($, view, v => ({ ...v, busy: '', note }))
}

// The search box is always shown. Ticked, it narrows what is switched on; unticked, what is off
// here and the library, which it reads if needed.
async function search($: EngineInterface, query: string): Promise<void> {
  const v = await update($, view, prev => ({ ...prev, query: query.trim(), note: '' }))
  if (!v.showActive) await loadVault($, false)
}


// Reads the library's listing (kept fifteen minutes) into state for the drawing.
async function loadVault($: EngineInterface, isFresh: boolean): Promise<void> {
  if (!isFresh && (await read($, vault)) !== null) return
  if (!library.location) return
  await update($, view, v => ({ ...v, note: 'Reading the library…' }))
  try {
    if (isFresh) await $.store.delete('vault')
    const list = await fetchVault($, isFresh)
    await update($, vault, () => list)
    await update($, view, v => ({ ...v, note: '' }))
  } catch (err) {
    await update($, view, v => ({ ...v, note: err instanceof Error ? err.message : String(err) }))
  }
}

// ---------------------------------------------------------------------------------------------
// Connectors: switched on and off for the session. The toolkit has no connector switch of its own, so
// the panel asks the desktop app's: its ccd_connectors server lists this session's connectors and
// turns a Claude-account connector on or off, the same switch as the composer's + menu. Only those
// ("connector" rows) can be switched; desktop extensions, plugin and project servers are listed
// without a switch, since they are managed in their own settings.
//
// The app's switch also becomes the default for new sessions. To keep a change to this session,
// the panel records each connector's state before its first change here and puts it back at
// session.end. A session that ends without that event firing (the app force-quit) keeps the new
// default; flip it back from the panel in the next session.

const CONNECTOR_SERVER = 'ccd_connectors'
const restoreKey = async ($: EngineInterface): Promise<string> => `restore:${await $.session.id()}`

const textOf = (result: { content?: { type?: string; text?: string }[] }): string =>
  (result.content ?? []).map(b => (b.type === 'text' ? b.text ?? '' : '')).join('')

async function loadConnectors($: EngineInterface): Promise<void> {
  try {
    const result = await $.mcp.call(CONNECTOR_SERVER, 'session_connectors_status', {})
    if (result.isError) throw new Error(textOf(result) || 'the app would not list its connectors')
    const data = JSON.parse(textOf(result)) as { servers?: { name?: string; id?: string; kind?: string; status?: string; tool_count?: number }[] }
    const list: Connector[] = (data.servers ?? [])
      .filter(x => typeof x.name === 'string' && x.name)
      .map(x => ({
        name: String(x.name),
        ...(x.id ? { id: String(x.id) } : {}),
        kind: String(x.kind ?? 'other'),
        status: String(x.status ?? 'unknown'),
        ...(typeof x.tool_count === 'number' ? { toolCount: x.tool_count } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    await update($, connectors, () => list)
  } catch (err) {
    await update($, view, v => ({ ...v, note: `Could not list the connectors: ${err instanceof Error ? err.message : String(err)}` }))
  }
}

async function setConnector($: EngineInterface, c: Connector, isOn: boolean): Promise<void> {
  const result = await $.mcp.call(CONNECTOR_SERVER, 'set_session_connector_enabled', { connector: c.id ?? c.name, enabled: isOn })
  if (result.isError) throw new Error(textOf(result) || `the app would not switch ${c.name}`)
}

// A server's tools are named mcp__<server>__<tool>, the server's name with anything but letters,
// digits, _ and - made _.
const toolPrefix = (server: string): string => `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}__`
const serverOfTool = (tool: string, hidden: readonly string[]): string | undefined => hidden.find(h => tool.startsWith(toolPrefix(h)))

// A server the app's switch cannot reach (a desktop extension, a plugin's or the project's server,
// one built into the app) is switched off for this session by the panel: its tools leave the
// prompt's list (behind tool search) and every call to them is refused, until it is switched back
// on or the session ends. Nothing in its own settings changes.
async function switchHidden($: EngineInterface, c: Connector): Promise<string> {
  const isOff = (await read($, hiddenServers)).includes(c.name)
  await update($, hiddenServers, list => (isOff ? list.filter(n => n !== c.name) : [...list, c.name]))
  $.ui.invalidate('tool.describe')
  return isOff
    ? `${c.name} switched back on for this session`
    : `${c.name} switched off for this session: its tools are hidden and refused until you switch it on`
}

async function switchConnector($: EngineInterface, name: string): Promise<string> {
  const c = (await read($, connectors))?.find(x => x.name === name)
  if (!c) throw new Error(`${name} is not one of this session's connectors`)
  if (c.kind !== 'connector') return switchHidden($, c)
  const isOn = c.status === 'disabled'
  // Its state before the first change this session, so session.end can put it back.
  const key = await restoreKey($)
  const before = ((await $.store.get(key)) ?? {}) as Record<string, { id?: string; wasOn: boolean }>
  if (!(c.name in before)) await $.store.set(key, { ...before, [c.name]: { ...(c.id ? { id: c.id } : {}), wasOn: !isOn } })
  await setConnector($, c, isOn)
  await loadConnectors($)
  return `${c.name} switched ${isOn ? 'on' : 'off'} for this session; it takes effect from your next message`
}

// Puts back every connector this session changed, so the change never outlives the session.
async function restoreConnectors($: EngineInterface): Promise<void> {
  const key = await restoreKey($)
  const before = ((await $.store.get(key)) ?? {}) as Record<string, { id?: string; wasOn: boolean }>
  for (const [name, b] of Object.entries(before)) {
    try {
      await setConnector($, { name, ...(b.id ? { id: b.id } : {}), kind: 'connector', status: '' }, b.wasOn)
    } catch {
      // The app has gone; the default stays as it was left.
    }
  }
  await $.store.delete(key)
}

// What a connector's row says beneath its name: where it comes from.
const KIND_WORDS: Record<string, string> = {
  connector: 'A connector from your Claude account.',
  desktop: 'A desktop extension. Switched off here, it is off for this session only.',
  server: 'A server from a plugin or this project’s settings. Switched off here, it is off for this session only.',
  plugin: 'A server from a plugin. Switched off here, it is off for this session only.',
  other: 'Built into the app. Switched off here, it is off for this session only.',
}
// Its state, beside its name.
const statusWords = (c: Connector): string =>
  c.status === 'connected'
    ? c.toolCount !== undefined ? `${c.toolCount} tool${c.toolCount === 1 ? '' : 's'}` : 'Connected'
    : c.status === 'needs_auth' ? 'Needs signing in (type /mcp)'
    : c.status === 'failed' ? 'Failed to connect'
    : c.status === 'pending' ? 'Connecting'
    : ''

async function openPane($: EngineInterface): Promise<void> {
  await refresh($)
  await $.ui.open({ id: PANE, title: 'Skill Switchboard', focus: true })
}

// ---------------------------------------------------------------------------------------------
// The layout: Skills | Connectors tabs, a search and an "Active Only" tick box on one line, then
// one row per skill or connector with its switch.
//
// Ticked, the rows are what is switched on here. Unticked, they are everything that is not: what
// is switched off here, then everything in the library not installed here; switching a library
// row on installs it. The switcher, the tick box and the
// cards are small drawings of the mod's own (Tabs.tsx, Check.tsx, Card.tsx), because the app gives
// a panel no segmented control, tick box or switch, and no way to click a drawing.

const TABS = [
  { value: 'skills', label: 'Skills' },
  { value: 'connectors', label: 'Connectors' },
]
const CARDS_MAX = 40

// A surface that failed to draw the panel's own pieces is noted, so it falls back to the app's own
// buttons and drawings there; the reason goes to the session's debug log.
async function noteFault($: EngineInterface, surface: string, reason: string): Promise<void> {
  await update($, faulted, list => (list.includes(surface) ? list : [...list, surface]))
  $.ui.log(`skill-switchboard: the ${surface} could not draw the panel's own pieces (${reason}); using the app's own instead`, { to: 'debug' })
}

// ---------------------------------------------------------------------------------------------
// The fallback drawing, for a surface that cannot draw the panel's own pieces: the same layout
// with the app's own buttons for the switcher and the tick box, and each card one SVG with its
// switch drawn inside, pressed through the button under it.

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
const ROW_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#3d3d3b}.m{fill:#8a8a86}.ln{stroke:#e4e4e1}
@media (prefers-color-scheme: dark){.t{fill:#f2f2f0}.s{fill:#cfcfcb}.m{fill:#8f8f8b}.ln{stroke:#3a3a38}}
</style>`
const xml = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
const charEm = (ch: string): number => (/[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-Z@%mw]/.test(ch) ? 0.72 : 0.56)
const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)
const wrapText = (s: string, size: number, maxW: number, maxLines: number): string[] => {
  const words = s.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (textWidth(next, size) <= maxW) {
      line = next
      continue
    }
    if (line) lines.push(line)
    line = w
    if (lines.length === maxLines) break
  }
  if (lines.length < maxLines && line) lines.push(line)
  if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) {
    let cut = lines[maxLines - 1] ?? ''
    while (cut && textWidth(cut + '…', size) > maxW) cut = cut.slice(0, -1).trimEnd()
    lines[maxLines - 1] = cut + '…'
  }
  return lines.slice(0, maxLines)
}
// The desktop row: a hairline above, the name with its version and where it lives
// beside it, the description on up to two lines in near-white, then the app's own small button
// under it, aligned left. The text starts a few pixels in, level with the button's own label.
const ROW_NAME = 12.5
const ROW_DESC = 11.5
const ROW_META = 10.5
const ROW_X = 4
// The last 12 is room between the description and the button under it.
const rowHeight = (lines: number): number => 24 + 6 + lines * 15 + 12
const rowSvg = (W: number, c: CardRow): string => {
  const desc = wrapText(c.description || 'No description in its file.', ROW_DESC, W - ROW_X * 2, 2)
  const H = rowHeight(desc.length)
  const meta = [c.version, c.tag].filter(Boolean).join('  ·  ')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${ROW_CSS}
<line class="ln" x1="0" y1="0.5" x2="${W}" y2="0.5"/>
<text class="t" x="${ROW_X}" y="23" font-family="${FONT}" font-size="${ROW_NAME}" font-weight="600"${c.isOn ? '' : ' opacity="0.6"'}>${xml(c.name)}</text>
${meta ? `<text class="m" x="${ROW_X + textWidth(c.name, ROW_NAME) + 10}" y="23" font-family="${FONT}" font-size="${ROW_META}">${xml(meta)}</text>` : ''}
${desc.map((l, i) => `<text class="s" x="${ROW_X}" y="${41 + i * 15}" font-family="${FONT}" font-size="${ROW_DESC}">${xml(l)}</text>`).join('')}
</svg>`
}

// The switch's words, and a blank label as wide as them for the button laid over them: no-break
// spaces (ordinary ones collapse), about a quarter of the type's size each, one extra for safety.
const switchWords = (c: { name: string; isOn: boolean }, busy: string): string => (busy === c.name ? '…' : c.isOn ? 'Switch Off' : 'Switch On')
// About 4px at the panel's text size: a four-per-em space and a hair space, neither of which collapses.
const SWITCH_INSET = '\u2005\u200a'

// One row's worth: an installed skill, a library entry not installed here, or a connector.
// `canSwitch` false draws the row without a switch (a connector managed in its own settings).
type CardRow = { name: string; version: string; description: string; tag: string; isOn: boolean; canSwitch?: boolean }

// ---------------------------------------------------------------------------------------------

// Shown where the library's rows would be, until a library is set up: how to set one.
const NOT_SET_UP =
  'No skills library is set up. To list skills you have not installed yet, tell the panel where yours live: ' +
  'in a terminal, type /config, find skill-switchboard and set Library Location to a folder (~/skills), ' +
  'a server (my-server:/srv/skills), a git repository (github:you/skills) or a download (https://…/skills.zip).'

const clean = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.trim() : fallback)

export const register: Register = (on, options) => {
  // The library, from the person's own settings (each a userConfig field in plugin.json).
  // An older install's Library Folder and Library Server settings still count, as one location.
  const oldFolder = clean(options.libraryFolder)
  const oldServer = clean(options.libraryServer)
  library = {
    location: clean(options.libraryLocation) || (oldFolder ? (oldServer ? `${oldServer}:${oldFolder}` : oldFolder) : ''),
    skillsFolder: clean(options.skillsFolder),
  }

  // Connectors this session changed go back to how they were, so a change stays the session's.
  on('session.end', async ($, e, next) => {
    try {
      await restoreConnectors($)
    } catch {
      // Nothing to put back, or the app has gone.
    }
    return next(e)
  })

  // A server switched off by the panel: its tools go behind tool search, and calls are refused.
  on('tool.describe', async ($, e, next) => {
    const answer = await next(e)
    return serverOfTool(e.tool, await read($, hiddenServers)) ? { ...answer, isDeferred: true } : answer
  })
  on('tool.check', async ($, e, next) => {
    const server = serverOfTool(e.tool, await read($, hiddenServers))
    if (server) return { decision: 'deny', reason: `${server} is switched off for this session in the Skill Switchboard` }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: COMMAND, description: 'Open the Skill Switchboard: your skills and connectors, each with a switch' })
    return started
  })

  on('command.run', { command: COMMAND }, async $ => {
    await openPane($)
    return { text: 'Skill Switchboard opened.' }
  })

  // A surface that could not draw one of the panel's own pieces: note it, so the next drawing on
  // that surface leaves them out and uses the fallback.
  on('ui.fault', async ($, e, next) => {
    if (e.requestId === PANE) await noteFault($, e.surface, `${e.module} (${e.phase}): ${e.reason}`)
    return next(e)
  })

  // The panel's own drawings tell this hook what was clicked: the switcher a tab, the tick box a
  // flip, a card its switch.
  on('ui.message', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const data = (e.data ?? {}) as { toggle?: unknown; tab?: unknown }
    if (e.element === 'tabs' && (data.tab === 'skills' || data.tab === 'connectors')) {
      const tab = data.tab
      await update($, view, v => ({ ...v, tab, note: '' }))
      if (tab === 'connectors') await loadConnectors($)
      return {}
    }
    if (e.element === 'show-active' && data.toggle === true) {
      const v = await update($, view, prev => ({ ...prev, showActive: !prev.showActive, note: '' }))
      if (!v.showActive) await loadVault($, false)
      return {}
    }
    const name = /^card-(.+)$/.exec(e.element)?.[1] ?? ''
    if (!name || data.toggle !== true || (await read($, view)).busy) return {}
    if ((await read($, view)).tab === 'connectors') {
      await act($, name, () => switchConnector($, name))
      return {}
    }
    const have = (await read($, installed)).find(x => x.name === name)
    await act($, name, () => (have && !have.isOff ? switchOff($, name) : switchOn($, name)))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, installed)
    const v = await read($, view)
    const vaultList = await read($, vault)
    const kind = 'skill'
    const connectorList = await read($, connectors)
    const hidden = await read($, hiddenServers)
    const mine = list
    const installedNames = new Set(list.map(s => s.name))

    const toCard = (s: Installed): CardRow => ({
      name: s.name,
      version: s.version,
      description: s.description,
      tag: s.where === 'library' ? 'All Projects' : '',
      isOn: !s.isOff,
    })
    const fromVault = (entry: VaultEntry): CardRow => ({ name: entry.name, version: entry.version, description: entry.description, tag: '', isOn: false })
    const fromConnector = (c: Connector): CardRow => ({
      name: c.name,
      version: '',
      description: KIND_WORDS[c.kind] ?? KIND_WORDS.other ?? '',
      tag: hidden.includes(c.name) ? 'Off for this session' : statusWords(c),
      isOn: c.status !== 'disabled' && !hidden.includes(c.name),
      canSwitch: true,
    })
    const cards: CardRow[] = (
      v.tab === 'connectors'
        ? (connectorList ?? []).filter(c => (c.status !== 'disabled' && !hidden.includes(c.name)) === v.showActive).map(fromConnector)
        : v.showActive
          ? mine.filter(s => !s.isOff).map(toCard)
          : [
              ...mine.filter(s => s.isOff).map(toCard),
              ...(vaultList ?? []).filter(entry => entry.kind === kind && !installedNames.has(entry.name)).map(fromVault),
            ]
    ).filter(c => !v.query || matches({ name: c.name, description: c.description, tags: [], folder: 'Skills', kind, version: c.version }, v.query))

    const shown = cards.slice(0, CARDS_MAX)
    const rowW = Math.max(240, Math.min(720, (e.props.bodyColumns || 40) * 8 - 8))
    const flip = (name: string) =>
      void (async () => {
        if ((await read($, view)).busy) return
        if ((await read($, view)).tab === 'connectors') {
          await act($, name, () => switchConnector($, name))
          return
        }
        const have = (await read($, installed)).find(x => x.name === name)
        await act($, name, () => (have && !have.isOff ? switchOff($, name) : switchOn($, name)))
      })()
    // The panel's own pieces (Tabs, Check, Card) are drawn only in the terminal. The desktop app
    // lists them as drawable but, as of Claude Code 2.1.299, leaves the whole pane blank when a
    // tree holds one ("has not drawn in this pane"), without raising ui.fault.
    // So the desktop gets the same layout from its own buttons and drawn cards.
    const canDrawOwn = e.surface === 'terminal' && 'Client' in ui && !(await read($, faulted)).includes(e.surface)
    const noun = v.tab === 'connectors' ? 'connectors' : 'skills'
    const empty = v.query
      ? `Nothing matches "${v.query}".`
      : v.showActive
        ? `No ${noun} switched on.`
        : v.tab === 'connectors'
          ? connectorList === null ? '' : 'Every connector is switched on.'
          : vaultList === null ? '' : `Every ${kind} is switched on.`

    return (
      // Two steps of room between the top rows and before the rows.
      <Box flexDirection="column" gap={2}>
        {/* The tabs, with the refresh link on the same line at the right. */}
        <Box key="top" flexDirection="row" justifyContent="space-between" alignItems="center">
          {canDrawOwn && 'Client' in ui ? (
            <ui.Client key="tabs" module="./Tabs.tsx" props={{ options: TABS, value: v.tab }} />
          ) : (
            <Box key="tabs-fallback" flexDirection="row" gap={1}>
              {TABS.map(t => (
                <Button
                  key={`tab-${t.value}`}
                  label={t.label}
                  variant={v.tab === t.value ? 'primary' : 'secondary'}
                  onPress={() =>
                    void (async () => {
                      await update($, view, prev => ({ ...prev, tab: t.value as View['tab'], note: '' }))
                      if (t.value === 'connectors') await loadConnectors($)
                    })()
                  }
                />
              ))}
            </Box>
          )}
          {v.tab === 'connectors' ? (
            <Button key="refresh-connectors" label="Refresh" plain dimColor onPress={() => void loadConnectors($)} />
          ) : (
            library.location ? <Button key="refresh-vault" label="Refresh" plain dimColor onPress={() => void loadVault($, true)} /> : null
          )}
        </Box>
        {/* Search and Active Only on one line: the search box takes the
            room, its ✕ beside it once something is typed, the tick box at the right. Search as you
            type, no label and no button; the desktop draws a submit button only when submitLabel
            is given, so none is. */}
        <Box key="search-row" flexDirection="row" alignItems="center" gap={2}>
          {'Input' in ui ? (
            <Box flexGrow={1} flexDirection="row" alignItems="center" gap={1}>
              <Box flexGrow={1}>
                <ui.Input key="search" placeholder="Search" value={v.query} onInput={text => void search($, text)} onSubmit={text => void search($, text)} />
              </Box>
              {v.query ? <Button key="clear-search" label="✕" plain dimColor onPress={() => void search($, '')} /> : null}
            </Box>
          ) : null}
          {canDrawOwn && 'Client' in ui ? (
            <ui.Client key="show-active" module="./Check.tsx" props={{ label: 'Active Only', isOn: v.showActive }} />
          ) : (
            <Button
              key="show-active-fallback"
              label={`${v.showActive ? '☑' : '☐'}\u00a0\u00a0Active Only`}
              plain
              onPress={() =>
                void (async () => {
                  const next = await update($, view, prev => ({ ...prev, showActive: !prev.showActive, note: '' }))
                  if (!next.showActive) await loadVault($, false)
                })()
              }
            />
          )}
        </Box>
        <Box key="cards" flexDirection="column">
          {v.tab !== 'connectors' && !v.showActive && !library.location ? (
            <Box key="setup">
              <Text dimColor>{NOT_SET_UP}</Text>
            </Box>
          ) : null}
          {shown.length === 0 && empty ? (
            <Text key="empty" dimColor>
              {empty}
            </Text>
          ) : null}
          {shown.map(c =>
            canDrawOwn && 'Client' in ui ? (
              <ui.Client
                key={`card-${c.name}`}
                module="./Card.tsx"
                width="100%"
                props={{ name: c.name, version: c.version, description: c.description, tag: c.tag, isOn: c.isOn, isBusy: v.busy === c.name, canSwitch: c.canSwitch !== false }}
              />
            ) : 'Svg' in ui ? (
              <Box key={`card-${c.name}`} flexDirection="column" marginBottom={1}>
                <ui.Svg source={rowSvg(rowW, c)} alt={`${c.name}: ${c.isOn ? 'on' : 'off'}`} width={rowW} height={rowHeight(wrapText(c.description || 'No description in its file.', ROW_DESC, rowW - ROW_X * 2, 2).length)} />
                {/* Underlined at rest, not on hover. A desktop button has no
                    underline setting, so the words are ordinary underlined text, and the button lies
                    exactly over them carrying the same words, so its hover highlight always fits them
                    whatever size the desktop draws them at. The keyed box is the hover group that takes the
                    underline off while the pointer is over it. */}
                {c.canSwitch === false ? null : (
                <Box key={`switch-box-${c.name}`} flexDirection="row">
                  {/* A sliver before the words, the button's own inner padding (about 4px), kept out
                      of the underline: the hover highlight then pads both sides evenly, and the
                      words line up with the row's text above. */}
                  <Text>{SWITCH_INSET}</Text>
                  <Text underline dimColor={c.isOn} hover={{ underline: false }}>
                    {switchWords(c, v.busy)}
                  </Text>
                  <Box position="absolute" left={0} top={0}>
                    <Button key={`switch-${c.name}`} label={switchWords(c, v.busy)} plain dimColor={c.isOn} onPress={() => flip(c.name)} />
                  </Box>
                </Box>
                )}
              </Box>
            ) : (
              <Box key={`card-${c.name}`} flexDirection="row" gap={1}>
                <Text bold>{c.name}</Text>
                <Button key={`switch-${c.name}`} label={c.isOn ? 'Switch Off' : 'Switch On'} plain dimColor onPress={() => flip(c.name)} />
              </Box>
            ),
          )}
          {cards.length > CARDS_MAX ? (
            <Text key="more" dimColor>
              {`${cards.length - CARDS_MAX} more. Search to narrow them down.`}
            </Text>
          ) : null}
        </Box>
        {v.note ? (
          <Box key="note">
            <Text>{v.note}</Text>
          </Box>
        ) : null}
      </Box>
    )
  })
}
