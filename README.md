# claude-mods

Two mods for [Claude Code](https://code.claude.com): small additions to its own interface, drawn inside the app.

| Mod | What it adds |
|---|---|
| [**Skills Panel**](plugins/skills-panel) | One panel for your skills and connectors, each with a switch, a search, and a one-click install from your own skills library. |
| [**Fun Savvy Progress**](plugins/fun-savvy-progress) | A live panel of your sub-agents, each with its model, progress, the skills it used and a creature of its own, plus a progress bar above the prompt. A fork of [johnnyvizz's savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress). |

<p>
  <img src="plugins/skills-panel/docs/skills.png" alt="The Skills Panel showing three skills, each with a Switch Off link" width="40%">
  <img src="plugins/fun-savvy-progress/docs/agents-panel.png" alt="The Fun Savvy Progress agents panel showing two running sub-agents and one finished" width="40%">
</p>

## Install

This repository is a plugin marketplace. Add it once, then install either mod or both.

**In a terminal session of Claude Code**, at the prompt:

```
/plugin install skills-panel --marketplace couriard/claude-mods
```

```
/plugin install fun-savvy-progress --marketplace couriard/claude-mods
```

Answer `y` to add the marketplace, pick a scope (your user scope makes it work in every project), and fill in the mod's settings when asked. Every setting can be left empty and changed later with `/config`.

**From a shell:**

```
claude plugin install skills-panel --marketplace couriard/claude-mods
```

**In the Claude desktop app**, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace**, enter `couriard/claude-mods`, then **Add plugin**.

## Requirements

- A Claude Code version with mods (plugins that draw their own interface), tested on 2.1.299. On an older version the mods do not load.
- The terminal and the desktop app both draw the panels. The desktop app draws a few parts with its own buttons where the terminal draws custom pieces; each mod's page says which.

## Licence

MIT. Fun Savvy Progress keeps its original author's licence and credit; see its folder.
