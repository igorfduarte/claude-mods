# claude-mods

Mods for [Claude Code](https://claude.com/claude-code). Each one is a standalone plugin under `plugins/`.

| Mod | What it does |
| --- | --- |
| [context-handoff](#context-handoff) | Watches the context window. Past a threshold, the agent writes a thorough handoff, the session compacts, and the handoff comes back with your next message, so long sessions keep their context. |
| [agent-deck](#agent-deck) | A live side panel of every subagent in the session (what it is doing, its steps, context and time) and a progress bar above the prompt for the subagents running now. |
| [cache-clock](#cache-clock) | A pill above the prompt that says whether the prompt cache is warm or cold, counts down to cold, and pings to keep it warm. |
| [prompt-polish](#prompt-polish) | Before a prompt is sent, Jev decides whether it could be written better; if so, Claude rewrites it and puts it back in the prompt box for you to review. |

## Install

At the prompt of a Claude Code terminal session, with the mod's name from the table:

```
/plugin install context-handoff --marketplace igorfduarte/claude-mods
/plugin install agent-deck --marketplace igorfduarte/claude-mods
/plugin install cache-clock --marketplace igorfduarte/claude-mods
/plugin install prompt-polish --marketplace igorfduarte/claude-mods
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
2. With your next message, the mod writes a **conversation inventory** taken from the transcript, not from the model's memory: the messages received verbatim, each labeled by where it came from (you, another session, a subagent report, a task notification), every file touched and with which tools, shell commands, searches, subagents launched and tool errors.
3. In the same turn, before handling your message, the session's own agent goes through the whole conversation, reads the whole inventory as a checklist, consolidates the last handoff written into the new one (so it does not grow cycle after cycle), records `git status` and `git diff --stat`, and writes a **handoff** with:
   - goal and current state
   - your instructions and preferences, quoted where the wording matters
   - decisions, and approaches rejected and why
   - each relevant file: role, what changed and why, state
   - tools, commands and environment
   - work log and next steps
   - open questions, risks and errors
   - files to re-read after compaction

   Files are named by path, never copied. `handoffMaxWords` caps its size.

   Then it handles your message as usual and adds what it did to the handoff.
4. After that turn the mod compacts the session, asking for a minimal summary: the handoff is the source of truth. Where Claude Code does not let a mod compact directly (the desktop app and other SDK hosts), it runs `/compact` for you. With `afterHandoff: clear` it runs `/clear` instead, so nothing is kept but the handoff and a record of that last turn, written from the transcript: the message it handled, the tool calls, any messages delivered during it, and the final reply. The handoff's last section, **Last turn and next step**, says where the agent stopped and the exact next step.
5. Your following message carries the handoff to the agent, unseen in the chat (after a `/clear`, the last-turn record too); the inventory goes by its path only. The agent re-reads the files the handoff listed before answering.

`/context-handoff` arms a cycle on demand, without waiting for the threshold. `/context-handoff status` shows where the cycle stands.

### Autonomous sessions

By default only a message a person typed carries the handoff and the restore. A session driven by other sessions and background work (a planning session that delegates and reviews, say) may go a whole cycle without one: subagent hand-backs reach it as origin `peer`, side-session reports and background tasks as `task-notification`. List those origins in `carryOrigins` and the cycle runs on them too. The debug log (`claude --debug`) names the origin of every prompt the mod sees.

The handoff is written by the session's own model on purpose: the conversation is already in its prompt cache, so reading it back costs little, and only that agent can re-read files and run `git`. A separate model would read the whole conversation again uncached.

### Options

| Option | Default | What it sets |
| --- | --- | --- |
| `thresholdK` | `300` | Context size, in thousands of tokens, that arms a handoff. Keep it below the auto-compact window, or Claude Code's own compaction comes first. |
| `carryOrigins` | empty | Comma-separated prompt origins that, besides typed messages, carry the handoff request and the restore: `peer`, `peer-send-message`, `task-notification`, `scheduled-trigger`, `coordinator`, `projects-relay`, `channel`, `slack-ping`. `plugin`, `observer`, `observer-activity` and `auto-continuation` are never carried. |
| `handoffMaxWords` | `0` | Asks the agent to keep the handoff under this many words. `0` sets no cap. |
| `afterHandoff` | `compact` | `compact`, or `clear` to run `/clear` after the handoff (compacting where the host refuses it). |
| `retentionDays` | `2` | When a session starts, handoff folders of other sessions untouched for this many days are deleted. `0` keeps them forever. |

Set them when installing, with `/plugin configure context-handoff@claude-mods` in a terminal session, or in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "context-handoff@claude-mods": { "options": { "thresholdK": 350, "retentionDays": 7, "afterHandoff": "clear", "carryOrigins": "peer,task-notification", "handoffMaxWords": 1500 } } } }
```

### Files

Each session gets a folder `~/.claude/handoffs/<session-id>/` with `handoff-N.md`, `inventory-N.md` and `last-turn-N.md` per cycle. They stay on your machine. They hold your messages verbatim and what the agent wrote about your work, so treat them like the transcript itself.

### Limits

- The mod acts at the end of a turn. If Claude Code's auto-compaction fires first, in the middle of a very long turn, the mod does not intercept it: keep the threshold well below the auto-compact window.
- The handoff rides on the next message rather than a turn of its own, because the desktop app does not run turns started by a mod. The cycle needs one more message from you to start, or one of the `carryOrigins`.
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

Above the prompt, for the current batch (the subagents started while others still run): one segment per subagent. A segment fills as the subagent reports its steps, pulses while it works without reporting, and turns red if it failed. Beside it: how many are done and running, the percent and the elapsed time. `×N` opens or closes the panel, and `✕` hides the bar until the next batch. Once every subagent has ended the bar reads **All done**, and it steps aside with your next message.

### Agents panel

`/subagents` opens or closes it, and `/subagents open` only opens it. It also opens by itself when a new batch starts.

- A header with the subagents running out of the total, output tokens and time.
- One row per subagent: a pixel robot that walks while it works, smiles when done and turns red-eyed on an error, dressed for its task (see below); the task's description; its type, model and effort, and whether it runs in the background; what it does now, read off its latest tool calls (`Grep · invalidateCache`); its reported steps (`2/5 · reading the tests`); context size, output tokens and time.
- Finished subagents collapse under their own heading and can be cleared.

In a terminal session both draw as text.

### Outfits

Each robot in the panel wears something for the job it was given, read off its agent type first and then its description (English or Portuguese):

| Role | Wears | Picked by |
| --- | --- | --- |
| Reviewer | Sherlock's deerstalker and round glasses | review, audit, verify, check, revisar |
| Tester | Lab goggles | test, benchmark, reproduce |
| Planner | A beret and a pencil | the `Plan` type; plan, design, planejar |
| Explorer | A pith helmet | the `Explore` type; search, find, map, buscar |
| Researcher | A mortarboard | `claude-code-guide`; research, docs, investigate, pesquisar |
| Builder | A hard hat | implement, fix, build, write, refactor, corrigir |

A subagent that matches none keeps its antenna. The band's robot stands for the whole batch and wears nothing.

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

## cache-clock

Claude caches the prompt it has already read, and a request that reuses the cache is cheaper and faster. The cache lapses after a while with no request: an hour on Claude subscriptions, five minutes on most API keys. This mod shows where that stands.

### The pill

At the right end of the band above the prompt, beside agent-deck's bar when it shows:

- **♨ warm** and the time left before the cache lapses. The background goes from red-orange, just refreshed, to amber as it nears the end.
- **❄ cold** on blue: nothing cached, or it lapsed.

Each request the main conversation sends resets the countdown. A subagent's requests do not, as they cache a prefix of their own. After a compaction the pill reads cold until the next request.

### Ping

`ping` asks the model one line ("pong") over the session's own conversation, which reads the cached prefix and renews it. A toast reports what the API said: how many tokens were read from the cache (a hit, the TTL renewed), or written to it again (it had lapsed, and the ping re-cached it at the cache-write price). The countdown resets only when the API reports cache use. The button hides while a turn runs, since the turn keeps the cache warm itself.

### Options

| Option | Default | What it sets |
| --- | --- | --- |
| `ttl` | `1h` | How long the cache stays warm: `1h` on Claude subscriptions, `5m` on most API keys. |

```json
{ "pluginConfigs": { "cache-clock@claude-mods": { "options": { "ttl": "5m" } } } }
```

### Limits

- The countdown is an estimate from the time of the last request and the `ttl` option: Claude Code does not tell a mod which TTL a session uses.
- After `/model`, the new model's cache is cold, but the pill reads warm until the next request.

### Uninstall

```bash
claude plugin uninstall cache-clock@claude-mods
```

## prompt-polish

A vague prompt costs a turn: the agent guesses, or asks back. This mod checks each prompt when you press Enter and offers a clearer one before anything is sent.

### How it works

1. [Jev](https://docs.typesafe.ai), TypeSafe's decision model, is asked whether the prompt could be restructured so the agent understands it clearly better: whether the goal or expected result is stated, constraints that matter are stated, and several requests are separated and ordered. Spelling, accents, capitalization, punctuation and informal tone do not count. It answers a probability.
2. Below the threshold, the prompt is sent as typed, with nothing shown.
3. At or above it, the prompt is held, Claude restructures it (same language, intent, facts, file names and constraints; nothing added), and the rewrite replaces your draft in the prompt box. A toast shows Jev's score, and the original is kept as a line in the transcript.
4. Enter sends the rewrite, or whatever you edited it into, without a second check.

Prompts pass unchecked when they are shorter than 25 characters or 5 words, are slash commands, carry images or other attachments, did not come from you (task notifications, other sessions' messages), or start with `##` (the prefix is removed). If Jev or the rewrite fails, the prompt is sent as typed.

### Setup

The mod reads a TypeSafe API key from `JEV_API_KEY`. Without it, every prompt is sent unchecked. Set it in your environment, or in `~/.claude/settings.json`:

```json
{ "env": { "JEV_API_KEY": "..." } }
```

### Options

| Option | Default | What it sets |
| --- | --- | --- |
| `threshold` | `0.8` | Jev's probability at or above which a prompt is held and rewritten. Higher holds fewer prompts. |
| `rewriteModel` | `haiku` | The model that rewrites, at effort low: `haiku` is faster and cheaper, `sonnet` keeps facts and constraints more reliably. |

```json
{ "pluginConfigs": { "prompt-polish@claude-mods": { "options": { "threshold": 0.85, "rewriteModel": "sonnet" } } } }
```

### Limits

- Every checked prompt goes to TypeSafe's API, hosted in the US, and Jev costs US$ 0.042 per million input tokens. The rewrite uses your Claude session.
- Each checked prompt waits for Jev before it is sent, and a held one for the rewrite as well.
- Jev's score varies with the wording: a rewrite can score above the threshold too.

### Uninstall

```bash
claude plugin uninstall prompt-polish@claude-mods
```

## License

MIT
