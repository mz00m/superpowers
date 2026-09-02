# Cortex — your skills and memory, everywhere

Cortex is a small local app that gives you **one vault** of skills and memory and
keeps every agent on every device pointed at it: Claude Code, Codex, OpenCode,
Cursor, Gemini CLI, ChatGPT (via paste/export), and your own agent.

- **Vault** — a plain folder: `skills/<name>/SKILL.md` + `memory/<id>.md`.
  Markdown only, so it survives any sync mechanism and any agent.
- **Storage preference** — keep it local, drop it in a synced folder
  (iCloud / Dropbox / Drive / Syncthing), or back it with a private git remote
  and press *Sync*.
- **Agents** — adapters that know where each agent reads skills and memory.
  Skills are symlinked (or copied) into each agent; memory is written into each
  agent's memory file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, …) inside a marked
  block Cortex owns, so your own content is never touched.
- **Devices** — every machine that opens the vault registers itself in
  `devices.json`, so you can see where things are.
- **UI + CLI + HTTP API** — a web UI for humans, a CLI for scripts, and a JSON
  API so your own agent can read and write the same vault.

Zero dependencies. Node 18+.

## Quick start

```bash
node cortex/cli.js serve          # opens http://localhost:4747
```

Or link it as a command:

```bash
npm link                          # from the repo root; gives you `cortex`
cortex status                     # what's on this device
cortex skills                     # skill × agent matrix
cortex adopt claude-code my-skill # copy a skill from an agent into the vault
cortex install my-skill all       # link it into every agent
cortex memory import claude-code  # pull CLAUDE.md + project memory into the vault
cortex memory add "Prefers TDD" --body "Write the failing test first." --tags workflow
cortex memory push all            # write vault memory into every agent's memory file
cortex memory export chatgpt      # plain text to paste into ChatGPT custom instructions
cortex sync                       # git pull/commit/push (git mode)
```

`--json` on any command gives machine-readable output.

## Setting up a second device

1. Put the vault somewhere shared — **Settings → Storage mode**:
   - *Synced folder*: set the vault path to e.g. `~/Library/Mobile Documents/com~apple~CloudDocs/cortex-vault`
   - *Git remote*: create a private repo, paste its URL, Save, Sync.
2. On the other device: same repo checkout, same settings (`~/.cortex/config.json`
   is per-device on purpose, since paths differ), then **Skills → Install everywhere**
   and **Memory → Push to agents**.

## Your own agent

Point the *Instinct* adapter (Agents tab) at wherever your agent reads skills and
memory, enable it, and it takes part in the matrix like everything else. From
the agent's side, read the vault directly (it's just markdown) or call the API:

```
GET  /api/state                          everything
GET  /api/skills/<name>                  one skill's files
GET  /api/memory/export?agent=instinct   memory bundle for a system prompt
POST /api/memory  {title, body, tags, scope, agents}
POST /api/skills/install  {name, agent}
```

The server binds to `127.0.0.1` only and rejects cross-origin browser requests.

## Layout

```
cortex/
  cli.js            command-line interface
  server.js         HTTP server + JSON API, serves ui/index.html
  ui/index.html     the web UI (single file, no build step)
  lib/config.js     ~/.cortex/config.json, device identity, default agent adapters
  lib/vault.js      vault layout, frontmatter, skills, memory, devices
  lib/agents.js     scan agents, link/copy skills, push/import memory
  lib/sync.js       git pull/commit/push
  lib/app.js        operations shared by CLI and server
tests/cortex/       node --test
```

## Config

`~/.cortex/config.json`:

```json
{
  "vaultPath": "~/.cortex/vault",
  "storage": { "mode": "local | folder | git", "gitRemote": "", "autoSync": false },
  "linkMode": "symlink | copy",
  "agents": [ { "id": "instinct", "kind": "fs", "enabled": true,
                "skillsDir": "~/.instinct/skills", "memoryFiles": ["~/.instinct/MEMORY.md"] } ]
}
```

Environment: `CORTEX_HOME` (default `~/.cortex`), `CORTEX_PORT` (4747), `CORTEX_HOST` (127.0.0.1).

## Status

Prototype. Known gaps worth doing next for a product:

- Real ChatGPT integration is paste/export only (there is no memory API).
- Git conflicts are reported, not resolved in the UI.
- No auth on the API (localhost-only); a hosted/multi-user version needs it.
- Memory items are flat; no dedupe/merge of near-duplicates across agents.
