/** One skill on this computer: in the project's own .claude/skills or in ~/.claude/skills. */
export type Installed = {
  name: string
  kind: 'skill'
  version: string
  description: string
  /** "off" in the project's .claude/settings.json skillOverrides. */
  isOff: boolean
  /** Which folder holds it: the project's .claude/skills or ~/.claude/skills. */
  where: 'project' | 'library'
  /** True when the folder carries the library's receipt (.from-vault.json), so switching it off may delete it. */
  isFromVault: boolean
}

/** One entry of the skills library's listing. */
export type VaultEntry = {
  name: string
  /** The library folder it sits in: the Skills Folder setting, or '.' for the library folder itself. */
  folder: string
  kind: 'skill'
  version: string
  description: string
  tags: string[]
}

/** One of this session's connectors, as the desktop app's ccd_connectors server lists it. */
export type Connector = {
  name: string
  /** A Claude-account connector's id, which the app's switch takes. */
  id?: string
  /** connector (a Claude-account connector: the only kind the panel switches), desktop, server, plugin or other. */
  kind: string
  /** connected, needs_auth, failed, pending or disabled. */
  status: string
  toolCount?: number
}

export type View = {
  /** Which list is open: the project's skills, or this session's connectors. */
  tab: 'skills' | 'connectors'
  /** Ticked: what is switched on. Unticked: what is switched off here, and the library's not installed. */
  showActive: boolean
  /** The search box's text, as last submitted. */
  query: string
  /** The name being switched or pulled right now, so its button reads busy. */
  busy: string
  /** The last outcome or error, one line under the lists. */
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    'skills-panel': {
      installed: Installed[]
      vault: VaultEntry[] | null
      view: View
      /** Surfaces that failed to draw the panel's own pieces, so it falls back on them. */
      faulted: string[]
      /** This session's connectors, read when the Connectors tab opens; null before. */
      connectors: Connector[] | null
      /** Servers switched off for this session by the panel itself, by name. */
      hidden: string[]
    }
  }
}
