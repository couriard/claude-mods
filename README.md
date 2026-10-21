# claude-mods

Mods for [Claude Code](https://code.claude.com): small additions to its own interface, drawn inside the app. Each one installs on its own.

**The mods**

- [Skill Switchboard](#skill-switchboard): your skills and connectors in one panel, each with a switch.
- [Fun Savvy Progress](#fun-savvy-progress): a live panel of your sub-agents, with a progress bar above the prompt.

[How installing works](#how-installing-works) · [Requirements](#requirements) · [Licence](#licence)

---

## Skill Switchboard

One panel for your skills and connectors, each with a switch, a search, and a one-click install from your own skills library. Open it with `/skill-switchboard`.

<img src="plugins/skill-switchboard/docs/skills.png" alt="The Skill Switchboard: the Skills tab with three skills, each with a Switch Off link" width="360">

```
/plugin install skill-switchboard --marketplace couriard/claude-mods
```

**[Full guide: what it shows, its settings, and how its switches work →](plugins/skill-switchboard)**

---

## Fun Savvy Progress

A live panel of your sub-agents, each with its name, model, the skills it used and a creature of its own, plus a progress bar above the prompt. Open it with `/agents-info`. A fork of [johnnyvizz's savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress).

<img src="plugins/fun-savvy-progress/docs/agents-panel.png" alt="The Fun Savvy Progress agents panel: totals, two sub-agents running and one finished" width="360">

```
/plugin install fun-savvy-progress --marketplace couriard/claude-mods
```

**[Full guide: what it shows, its settings, and how a workflow feeds it →](plugins/fun-savvy-progress)**

---

## How installing works

This repository is a plugin marketplace: the first install adds it, and every mod after that installs from it.

- **In a terminal session of Claude Code**, type the mod's install line (under each mod above) at the prompt. Answer `y` to add the marketplace, pick a scope (your user scope makes it work in every project), and fill in the mod's settings when asked. Every setting can be left empty or at its default, and changed later with `/config`.
- **From a shell**, put `claude` in front of the same line without the slash, for example `claude plugin install skill-switchboard --marketplace couriard/claude-mods`.
- **In the Claude desktop app**, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace**, enter `couriard/claude-mods`, then **Add plugin** and pick the mod.

## Requirements

- A Claude Code version with mods (plugins that draw their own interface), tested on 2.1.299. On an older version the mods do not load.
- The terminal and the desktop app both draw the panels. The desktop app draws a few parts with its own buttons where the terminal draws custom pieces; each mod's guide says which.

## Licence

MIT. Fun Savvy Progress keeps its original author's licence and credit; see its folder.
