# claude-mods

Mods for [Claude Code](https://claude.com/claude-code). Each one is a standalone plugin under `plugins/`.

| Mod | What it does |
| --- | --- |
| [context-handoff](#context-handoff) | Watches the context window. Past a threshold, the agent writes a thorough handoff, the session compacts, and the handoff comes back with your next message, so long sessions keep their context. |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install context-handoff --marketplace igorfduarte/claude-mods
```

Answer `y` to add the marketplace, pick a scope (user is the default), and set the options or keep the defaults.

From a shell:

```bash
claude plugin install context-handoff --marketplace igorfduarte/claude-mods
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `igorfduarte/claude-mods`, then **Add plugin**.

Start a new session afterwards; sessions already open do not pick it up.

Mods are built on function hooks, an early-access Claude Code API: tested on Claude Code 2.1.308, and it may change between releases.

## context-handoff

Long sessions fill the context window, and compaction alone keeps only a short summary. A common workaround is asking the agent, right before compacting, for a handoff to paste back afterwards. This mod does that for you.

### How it works

1. After each turn of the main session, the mod checks the context size. Past the threshold (350k tokens by default) it **arms** a handoff and shows a notice.
2. With your next message, the mod writes a **conversation inventory** taken from the transcript, not from the model's memory: your messages verbatim, every file touched and with which tools, shell commands, searches, subagents launched and tool errors.
3. In the same turn, before handling your message, the session's own agent goes through the whole conversation, uses the inventory as a checklist, carries over the previous handoff if there is one, records `git status` and `git diff --stat`, and writes a **handoff** with:
   - goal and current state
   - your instructions and preferences, quoted where the wording matters
   - decisions, and approaches rejected and why
   - each relevant file: role, what changed and why, state
   - tools, commands and environment
   - work log and next steps
   - open questions, risks and errors
   - files to re-read after compaction

   Then it handles your message as usual and adds what it did to the handoff.
4. After that turn the mod compacts the session. Where Claude Code does not let a mod compact directly (the desktop app and other SDK hosts), it runs `/compact` for you.
5. Your following message carries the handoff and the inventory to the agent, unseen in the chat, and the agent re-reads the files it listed before answering.

`/context-handoff` arms a cycle on demand, without waiting for the threshold.

The handoff is written by the session's own model on purpose: the conversation is already in its prompt cache, so reading it back costs little, and only that agent can re-read files and run `git`. A separate model would read the whole conversation again uncached.

### Options

| Option | Default | What it sets |
| --- | --- | --- |
| `thresholdK` | `350` | Context size, in thousands of tokens, that arms a handoff. Keep it below the auto-compact window, or Claude Code's own compaction comes first. |
| `retentionDays` | `7` | When a session starts, handoff folders of other sessions untouched for this many days are deleted. `0` keeps them forever. |

Set them when installing, with `/plugin configure context-handoff@claude-mods` in a terminal session, or in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "context-handoff@claude-mods": { "options": { "thresholdK": 300, "retentionDays": 14 } } } }
```

### Files

Each session gets a folder `~/.claude/handoffs/<session-id>/` with `handoff-N.md` and `inventory-N.md` per cycle. They stay on your machine. They hold your messages verbatim and what the agent wrote about your work, so treat them like the transcript itself.

### Limits

- The mod acts at the end of a turn. If Claude Code's auto-compaction fires first, in the middle of a very long turn, the mod does not intercept it: keep the threshold well below the auto-compact window.
- The handoff rides on your next message rather than a turn of its own, because the desktop app does not run turns started by a mod. The cycle needs one more message from you to start.
- If a cycle is interrupted or the handoff is not written, the mod does not retry by itself until the session compacts; `/context-handoff` arms it again.
- If the session cannot compact by itself, a notice asks you to run `/compact`; the handoff still comes back with your next message.

### Uninstall

```bash
claude plugin uninstall context-handoff@claude-mods
```

## License

MIT
