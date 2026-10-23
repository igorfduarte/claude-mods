# claude-mods

Mods for [Claude Code](https://claude.com/claude-code). Each one is a standalone plugin under `plugins/`.

| Mod | What it does |
| --- | --- |
| [context-handoff](#context-handoff) | Watches the context window. Past a threshold, the agent writes a thorough handoff, the session compacts, and the handoff comes back with your next message, so long sessions keep their context. |
| [agent-deck](#agent-deck) | A live side panel of every subagent in the session (what it is doing, its steps, context and time) and a progress bar above the prompt for the subagents running now. |

## Install

At the prompt of a Claude Code terminal session, with the mod's name from the table:

```
/plugin install context-handoff --marketplace igorfduarte/claude-mods
/plugin install agent-deck --marketplace igorfduarte/claude-mods
```

Answer `y` to add the marketplace, pick a scope (user is the default), and set the options or keep the defaults.

From a shell:

```bash
claude plugin install agent-deck --marketplace igorfduarte/claude-mods
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `igorfduarte/claude-mods`, then **Add plugin**.

Start a new session afterwards; sessions already open do not pick it up.

Mods are built on function hooks, an early-access Claude Code API: tested on Claude Code 2.1.308, and it may change between releases.

## context-handoff

Long sessions fill the context window, and compaction alone keeps only a short summary. A common workaround is asking the agent, right before compacting, for a handoff to paste back afterwards. This mod does that for you.

### How it works

1. After each turn of the main session, the mod checks the context size. Past the threshold (300k tokens by default) it **arms** a handoff and shows a notice.
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
| `thresholdK` | `300` | Context size, in thousands of tokens, that arms a handoff. Keep it below the auto-compact window, or Claude Code's own compaction comes first. |
| `retentionDays` | `2` | When a session starts, handoff folders of other sessions untouched for this many days are deleted. `0` keeps them forever. |

Set them when installing, with `/plugin configure context-handoff@claude-mods` in a terminal session, or in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "context-handoff@claude-mods": { "options": { "thresholdK": 350, "retentionDays": 7 } } } }
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

## agent-deck

A live view of the subagents a session runs, in the background or not.

Inspired by [savvy-progress](https://github.com/JohnnyVizz/claude-kit/tree/main/plugins/savvy-progress) by [JohnnyVizz](https://github.com/JohnnyVizz): its agents panel and progress bar, made for any subagent rather than one workflow.

### Progress bar

Above the prompt, for the current batch (the subagents started while others still run): one segment per subagent in its type's color. A segment fills as the subagent reports its steps, pulses while it works without reporting, and turns red if it failed. Beside it: how many are done and running, the percent and the elapsed time. `×N` opens or closes the panel, and `✕` hides the bar until the next batch. Once every subagent has ended the bar reads **All done**, and it steps aside with your next message.

### Agents panel

`/subagents` opens or closes it, and `/subagents open` only opens it. It also opens by itself when a new batch starts.

- A header with the subagents running out of the total, output tokens and time.
- One row per subagent: a pixel robot that walks while it works, smiles when done and turns red-eyed on an error; the task's description; its type, model and effort, and whether it runs in the background; what it does now, read off its latest tool calls (`Grep · invalidateCache`); its reported steps (`2/5 · reading the tests`); context size, output tokens and time.
- Finished subagents collapse under their own heading and can be cleared.

In a terminal session both draw as text.

### Step reports

To fill each subagent's bar, the mod registers a `step` tool and appends one paragraph to every subagent's brief, asking it to report its plan and its progress through that tool. That changes every subagent's prompt slightly and costs a few cheap tool calls. With `stepReports` off, briefs are left as they are and each bar sweeps while its subagent works.

### Options

| Option | Default | What it sets |
| --- | --- | --- |
| `autoOpen` | `on` | Opens the panel by itself when a new batch of subagents starts; `off` opens it only with `/subagents`. |
| `stepReports` | `on` | Asks each subagent to report its steps, as above. |

Set them when installing, with `/plugin configure agent-deck@claude-mods` in a terminal session, or in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "agent-deck@claude-mods": { "options": { "autoOpen": "off" } } } }
```

### Limits

- No cost estimate: the panel counts tokens, not dollars.
- Context is shown in tokens (the latest request's prompt and output), not as a share of the window.
- A subagent stopped from outside, whose end no event reports, is marked ended once Claude Code's own agent list no longer has it.

### Uninstall

```bash
claude plugin uninstall agent-deck@claude-mods
```

## License

MIT
