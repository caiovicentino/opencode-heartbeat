# opencode-heartbeat

[![CI](https://github.com/caiovicentino/opencode-heartbeat/actions/workflows/ci.yml/badge.svg)](https://github.com/caiovicentino/opencode-heartbeat/actions/workflows/ci.yml)

> OpenClaw-style heartbeat for [OpenCode](https://opencode.ai) — periodic autonomous pulses **in your session**, watch mode, worker waves with a boss postbox, and an eval gate that verifies instead of trusting.

Scheduled agents that run *outside* opencode (cron + `opencode run`) wake up headless, cold, and blind. `opencode-heartbeat` is the opposite: a live pulse inside your session that can watch, react, dispatch a fleet of worker sessions, talk to them while they work, and **refuse to ship anything the suite didn't prove**.

## Why

- OpenClaw proved the value of a periodic agent turn ("heartbeat") for autonomous monitoring.
- opencode has the primitives — plugins, child sessions, SDK, structured output, events — but no heartbeat, no boss↔worker channel, and no verification gate for multi-agent work.
- This fills all three, end-to-end tested.

## What it does

| Layer | Feature |
|---|---|
| **Heartbeat** | Timer-driven pulse injected into your TUI session (like you typed it), with busy-guard, cooldown, active hours, daily budget |
| **Liga/desliga fácil** | Tools (`heartbeat_on/off/now/interval`) so **you and the agent** can control cadence; temporary pauses that auto-resume; state survives restarts |
| **Watch mode** | Register goals with a shell check; output enters every pulse digest; per-watch autonomy dial (L0 observe → L3 act) |
| **Waves** | Dispatch N workers as child sessions in parallel, burst window for warm prompt cache, structured output collection, per-spec timeout |
| **Postbox** | Bidirectional boss↔worker channel: `report_progress`, blocking `ask_boss`, `god_steer` — and a pending worker question **wakes the boss up by itself** |
| **Eval gate** | Executable acceptance criteria run by a neutral runner, k judges that verify (they run the checks themselves), merge/retry/escalate decision, meta-eval report with per-wave cost and pulse usefulness |
| **Safety** | Constitution file, physical kill switch (delete one file → everything stops), observer-only pulses, full audit journal |

## Quickstart

Requires [bun](https://bun.sh) and opencode ≥ 1.x.

### Per-project (recommended)

```bash
git clone https://github.com/caiovicentino/opencode-heartbeat
cd your-project
cp -r /path/to/opencode-heartbeat/.opencode/plugins .opencode/
cp -r /path/to/opencode-heartbeat/.opencode/lib .opencode/
cp -r /path/to/opencode-heartbeat/.opencode/command .opencode/
cp -r /path/to/opencode-heartbeat/.opencode/skills .opencode/
# merge this into your .opencode/package.json (opencode runs bun install at startup):
cp /path/to/opencode-heartbeat/.opencode/package.json .opencode/
```

Restart opencode. First run creates `.opencode/state/` (heartbeat state, scratch, kill switch, blackboard, journal).

### Global (all projects)

```bash
ln -s "$PWD/plugins/heartbeat.ts" ~/.config/opencode/plugins/heartbeat.ts
ln -s "$PWD/lib" ~/.config/opencode/lib
```

State is always per-project (`<project>/.opencode/state/`), so each project gets an independent pulse.

### First beat

```
/heartbeat on 5m
```

or just tell the agent: *"monitor the build, ping me every 5 minutes until it's green"* — the agent calls the tools itself.

## The response contract

Every pulse prompt carries a marker and a protocol. The agent replies with exactly one of:

| Marker | Meaning | Effect |
|---|---|---|
| `HEARTBEAT_OK` | nothing needs attention | silent, cheap, journaled |
| `NOTIFY:` | worth saying | appears in chat |
| `ALERT:` | urgency | OS notification (toast) + chat |

Pulses are **observer-only**: no actions that require permission approval.

## Tools

### Session control

`heartbeat_on` · `heartbeat_off` · `heartbeat_status` · `heartbeat_now` · `heartbeat_interval` · `heartbeat_watch` · `heartbeat_unwatch`

### Boss (fleet)

`god_wave_create` · `god_wave_run` · `god_merge` · `god_eval` · `god_judge` · `god_report` · `god_answer` · `god_steer` · `god_board` · `god_learn`

### Worker (inside a `god:<spec>` child session)

`report_progress` · `ask_boss`

Slash command: `/heartbeat on|off|now|status|watch|unwatch`.

## Architecture

```
                 ┌──────────────────────────┐
                 │  BOSS (your session)     │  pulse wakes it: timer, manual, or worker-ask
                 └────────────┬─────────────┘
                              │ specs + acceptance criteria
         ┌────────────────────┼─────────────────────┐
         ▼                    ▼                     ▼
  ┌────────────┐       ┌────────────┐        ┌────────────┐
  │ Worker 1   │       │ Worker 2   │  ...   │ Worker N   │   child sessions (SDK, parallel burst)
  └─────┬──────┘       └─────┬──────┘        └─────┬──────┘
        └──── structured output + report_progress / ask_boss ───┘
                              ▼
                 ┌──────────────────────────┐
                 │  EVAL GATE               │  acceptance runner → judges (they verify) → merge/retry/escalate
                 └──────────────────────────┘
```

Everything flows through a file-based **blackboard** (`specs/ claims/ results/ verdicts/ waves/ asks/ steers/ progress/ learnings/`) — atomic writes, TTL claims, crash-safe, `git`-friendly, fully auditable.

## Proven end-to-end

Real outputs from the built-in smoke tests (no mocking):

**A wave with a green spec and an intentionally red spec:**

```
Onda: 2/2 done, 0 failed, 0 erro
✓ [spec-green]  (conf 100%) — "7 files: blackboard.ts, core.ts, digest.ts…"
✓ [spec-red]    (conf 100%) — "teste de falha proposital"
```

Worker said *done* on both. The acceptance runner ran the criteria anyway:

```
PORTÃO [spec-red]: RETRY — suite vermelha: exit 1
```

**Judges verify instead of trusting:**

```
judge 1/2: ACCEPT (100) — "ran the acceptance criterion myself: output identical to the worker's"
judge 2/2: ACCEPT (100) — "I ran ls .opencode/lib myself"
PORTÃO [spec-green]: MERGE — criteria satisfied
```

**A worker question wakes the boss up:**

```json
{"trigger":"worker-ask","asks":1,"digestChars":1783}
```

**Meta-eval report:**

```
## Pulsos: 2 disparados
- por trigger: timer: 1, worker-ask: 1
- resultados: OK silencioso 0 · NOTIFY 0 · ALERT 0 · sem resposta registrada 2
- taxa de utilidade: 0%
## Blackboard: specs 0 abertos / 4 done / 2 failed
- asks: 0 pendentes, 2 expiradas
```

## Configuration & state

| File | Purpose |
|---|---|
| `.opencode/state/heartbeat.json` | pulse state: enabled, interval, budget, watches |
| `.opencode/state/heartbeat.md` | your scratch checklist — injected into every pulse |
| `.opencode/state/constitution.json` | non-negotiable rules (merge gate, autonomy default) |
| `.opencode/state/kill.switch` | **presence = armed. Delete it and nothing runs.** |
| `.opencode/state/journal/pulses.jsonl` | audit trail: every pulse, trigger, outcome |
| `.opencode/state/blackboard/` | the fleet's shared memory |

## Safety model

- Pulses never execute permission-requiring actions (observer protocol).
- The merge gate is the single serial choke point — `main` is untouched without green checks + judge verdicts.
- Kill switch is checked *before every turn*; it's a file, not a config.
- Cross-process fire lock prevents double pulses (TUI + headless runs on the same project).

## Testing

```bash
bun install
bun test       # 60 tests
bun run typecheck
```

## Roadmap

Done: heartbeat core, watch mode, waves + structured output, postbox, eval gate + judges + meta-eval, global install.

Next (see [DESIGN.md](./DESIGN.md) for the full plan, in pt-BR):

- **F2-complete**: executable merge queue with git worktrees (decision engine is done; execution pending)
- **F3-governor**: token-bucket rate limiter + multi-key failover for large waves
- **F5**: multi-node fleet (`opencode serve` + attach)
- **F6**: predictive pulses, self-evolving prompts, colony of bosses

Notes: runtime prompts currently ship in **pt-BR** (edit `lib/wave.ts`, `lib/core.ts`, skill/command files to localize — i18n is on the roadmap). Works with any opencode model; developed and verified on GLM via opencode.

## License

MIT — see [LICENSE](./LICENSE).
