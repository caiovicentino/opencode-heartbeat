# GOD MODE — Heartbeat + Frota de 20 Agents no opencode

> Progressão: **Núcleo** (pulso vivo) → **Escada de resposta** → **Watch mode** → **Pulse Bus** → **Ondas** → **God Mode** (colmeia, preditivo, auto-evolução, constituição).
> Princípio: cada camada é um módulo que pluga no núcleo sem reescrevê-lo.

---

## 0. Mapa geral

```
.opencode/
  plugins/
    heartbeat.ts            ← NÚCLEO (F0 ✅): timer, tools, guardas, contrato de pulso
  lib/                      ← libs puras (testáveis sem opencode)
    core.ts                 ← durações, guardas, estado, fs helpers (F0 ✅)
    blackboard.ts           ← fonte de verdade de estado (F1 ✅)
    digest.ts               ← snapshot pré-cozido por pulso/onda (F1 ✅)
  state/
    heartbeat.json          ← estado do pulso ✅
    heartbeat.md            ← scratch: checklist
    kill.switch             ← PRESENÇA = ON (apagar = frota para) ✅
    blackboard/             ← specs/ claims/ results/ verdicts/ learnings/ waves/
    journal/
      pulses.jsonl          ← auditoria de cada pulso ✅
  skills/heartbeat/SKILL.md ← protocolo do pulso ✅
  command/heartbeat.md      ← /heartbeat on|off|10m|status|watch ✅
```

> Status: **F0, F1, F2-lite, F2.5 e F4 implementados e provados** (60 testes unitários; E2E: onda com workers → structured output; critérios de aceitação executáveis reais — spec vermelha bloqueada no portão com RETRY; judges que rodam os critérios eles mesmos → MERGE; canal ask_boss com fallback; wake por worker-ask; meta-eval com custo/onda e hit/miss de pulsos; instalação global com guarda de duplo-carregamento).
> Estrutura real: plugin único em `.opencode/plugins/heartbeat.ts` + libs puras em `.opencode/lib/` (core, blackboard, digest, postbox, wave, merge, eval). Instalado globalmente via symlinks em `~/.config/opencode/` (fonte de verdade no projeto).
> Faltando: F2-completo (merge queue executável com git/worktrees), F3-governor (taxa de tokens; budget de onda já existe), F5 (farm multi-nó), F6 (god extras).

---

## 1. NÚCLEO — Heartbeat Engine (F0)

**Responsabilidade**: pulso vivo dentro do opencode (Opção 2: injeção na TUI), com liga/desliga fácil pra você e pro agent.

### Estado: `state/heartbeat.json`
```json
{
  "version": 1,
  "enabled": true,
  "interval": "10m",
  "offUntil": null,
  "lastFired": "2026-10-07T12:00:00Z",
  "nextFire": "2026-10-07T12:10:00Z",
  "prompt": null,
  "model": null,
  "pulseCount": 0,
  "budget": { "dailyPulses": 48, "usedPulses": 0 },
  "activeHours": { "start": "08:00", "end": "23:00" }
}
```

### Tools (o agent liga/desliga sozinho)
- `heartbeat_on(interval?)` — liga; `heartbeat_off(duration?)` — desliga (com duração = pausa que volta sozinha)
- `heartbeat_status`, `heartbeat_now(reason)` — dispara pulso imediato
- `heartbeat_watch(goal, check, autonomy, expiresAt?)` / `heartbeat_unwatch(id)` — Watch mode
- `heartbeat_interval("5m")` — cadência adaptativa (escala 2min–1h, teto pelo constitution)

### Guardas do tick
1. Estado relido do arquivo a cada tick (mudanças aplicam na hora)
2. Só dispara com sessão **idle** (`session.status`/`session.idle`) e cooldown ≥ 90s após última mensagem do usuário; se busy → adia pro próximo tick (no-overlap)
3. Respeita `activeHours` e `offUntil`
4. Respeita `kill.switch` — ausente = nada roda (checado ANTES de cada pulso)
5. Prompt injetado com marcador `[🫀 pulse]` + contexto (digest se existir) + contrato abaixo

### Contrato de resposta (escada)
| Marcador | Significado | Efeito |
|---|---|---|
| `HEARTBEAT_OK` | nada a declarar | silencioso, registrada no journal, invisível |
| `NOTIFY:` | vale falar | aparece no chat |
| `ALERT:` | urgência | notificação SO (`tui.showToast`/osascript) + `NOTIFY` |

**Critérios de aceite F0**: pulso aparece como se você digitou; `/heartbeat off` mata na hora; restart preserva estado; busy não empilha; `HEARTBEAT_OK` custa < 200 tokens.

---

## 2. BLACKBOARD (F1) — fonte de verdade

Tudo em arquivos JSON (git-friendly, auditável, sobrevive a restart). Sessões são efêmeras; o blackboard é o sistema.

### Schemas
**spec.json** (unidade de trabalho)
```json
{
  "id": "spec-001", "wave": "w1", "role": "implementer",
  "title": "Retry no fetcher",
  "files": ["src/fetcher.ts"],
  "acceptance": ["bun test src/fetcher.test.ts", "bun run lint"],
  "digest": "w1-impl",
  "budgetTokens": 300000,
  "timeoutSec": 1800,
  "autonomy": 1,
  "status": "open|claimed|done|failed|cancelled"
}
```
**claim.json** (posse com TTL — evita zumbi)
```json
{ "spec": "spec-001", "session": "ses_x", "node": "local", "claimedAt": "...", "expiresAt": "..." }
```
**result.json**
```json
{
  "spec": "spec-001", "session": "ses_x", "branch": "god/spec-001",
  "status": "done", "checks": [{ "cmd": "...", "passed": true }],
  "confidence": 0.82, "notes": "..."
}
```
**verdict.json** (judge) — `{ spec, judge, verdict: accept|revise|reject, score, reasons[] }`
**learning.json** — `{ kind: strategy|ignore|prompt, text, source: user|judge|stats, weight }`
**wave.json** — ver §4.

### Regras
- Escrita atômica (tmp + rename); claims expiram (TTL = timeout do spec)
- Workers só **leem digest + spec próprio**; nunca o blackboard inteiro

**Aceite F1**: crash mid-write não corrompe; claim expirado é reciclável; `git status` limpo reflete o estado.

---

## 3. DIGEST GENERATOR (F1) — contexto pré-cozido

Monta snapshot **uma vez por onda** e injeta idêntico em todos os workers da role (hit de cache):
- todos da sessão via SDK, `git diff --stat`, estado dos watches, learnings relevantes (peso ≥ limiar), saída do último CI
- Formato: `digest-<wave>-<role>.md` — máx ~2k tokens
- **Aceite**: pulso não gasta tool calls para redescobrir estado; digest idêntico entre workers da mesma role.

---

## 4. WAVE RUNNER (F2) — o paralelismo

**wave.json**
```json
{
  "id": "w1", "objective": "consertar suite e abrir PR",
  "composition": { "explorer": 5, "implementer": 10, "reviewer": 3, "judge": 2 },
  "burstWindowSec": 120, "budgetTokens": 3000000, "timeboxMin": 60, "gate": "merge-queue"
}
```

### Tipos de onda
| Onda | Composição | Saída |
|---|---|---|
| Exploratória | N explorers | specs gerados, mapa do terreno |
| Implementação | 1 worker por spec disjunto | branches + results |
| Adversária | impl × reviewer × critic | dissensos → Queen |
| Consolidação | 1 merger | worktrees mesclados, conflitos escalados |
| Verificação | k impls do MESMO spec + judges | melhor candidato (qualidade) |

### Mecânica
1. Queen gera specs (via digest + learnings) → cria sessões filhas (`parentID`) por worker
2. Despacho **em rajada** dentro de `burstWindowSec` (cache quente compartilhado)
3. Monitor via SSE `/event`: conclusão, timeout (kill da sessão), falha → retry policy (1 retry, depois fail)
4. Workers respondem **structured output** (`json_schema`) — sem parsing de prose
5. Onda só avança quando todos results in (ou expiram)

**Aceite F2**: 10 specs disjuntos processados em paralelo sem interferência; timeout mata worker e recicla claim.

---

## 5. MERGE QUEUE (F2) — o portão serial

Único gargalo serial **de propósito** — aqui mora a constituição.
- Fila de branches `god/spec-*`; processa **um por vez**: rebase em main → suite integral → judge ≥ limiar → merge (fast-forward ou PR) → GC do worktree
- Conflito não-trivial → escada: re-tenta com contexto de conflito → se falha, escalaria pra você (NOTIFY)
- Worktrees mortos coletados (claim expirado → branch preservada, worktree removido)

**Aceite**: main nunca recebe código sem suite verde + verdict; conflito nunca trava a fila (escaleta).

---

## 6. GOVERNOR (F3) — taxa e budget

- **Token bucket por nó** + por provider key: RPM, input tokens/min (20 agents × tool calls estoura 429 facilmente)
- **Budget por onda** (`budgetTokens`) e diário; onda que estoura é abortada com relatório
- **Stagger com jitter** no despacho; backoff exponencial em 429
- Exposição: tool `god_budget(status|set)`

**Aceite**: rajada de 20 workers não gera tempestade de 429; custo diário tem teto duro.

---

## 7. JUDGE RUNNER (F3) — qualidade via votação

- 2–3 judges (modelo forte) pontuam result × critérios de aceite → verdict/score
- Dissenso (empate/divergência) → escada pra você (NOTIFY)
- Para specs críticos: **k implementações paralelas do mesmo spec**, judge escolhe

**Aceite**: worker "achou que terminou" não basta — portão exige verdict.

---

## 8. EVAL HARNESS (F4) — "testado e eval feito"

- Critérios de aceite = **comandos executáveis** no spec (não é o worker quem decide que terminou)
- **Meta-eval do sistema**: dashboard por onda — custo, taxa de aceite, retrabalho, tempo; eval dos pulsos (hit/miss, custo/pulso útil)
- Learnings alimentados por: feedback seu (implícito: aviso ignorado 3× → downgrade; explícito: "não me avise disso de novo"), stats e judges

**Aceite**: dá pra responder "quanto custou a onda w1 e o que rendeu" com um comando.

---

## 9. WORKTREE LIFECYCLE — isolamento

- 1 worktree por worker (`god/w<onda>/<spec>`), specs disjuntos por arquivo
- Install/build com cache compartilhado (bun cache global, sccache) — suite de unidade no worker, integral só no portão
- GC: claim expirado ou merged → worktree removido, branch preservada até veredito final

---

## 10. CONSTITUIÇÃO + KILL SWITCH + AUDITORIA

**constitution.json**
```json
{
  "version": 1,
  "absolute": [
    "nunca force-push em main", "nunca tocar .env/secrets",
    "custo diário máximo: configurado", "ações destrutivas exigem humano"
  ],
  "mergeGate": { "requireGreenSuite": true, "requireJudgeScore": 75, "maxOpenWaves": 2 },
  "autonomyDefault": 1,
  "pulse": { "maxIntervalMin": 60, "maxPulsesPerHour": 6 }
}
```

- **Kill switch**: arquivo `state/kill.switch`; ausente = NADA roda (nem pulso, nem onda, nem merge). Checado no início de todo turno, worker e Queen inclusos
- **Auditoria**: `journal/pulses.jsonl` — todo pulso/ação com trigger, resultado, custo, justificativa; reversão fácil via snapshot do opencode
- **Dial de autonomia por objetivo**: L0 observar → L1 sugerir → L2 agir c/ aprovação → L3 agir sozinho (nunca fora do portão)

---

## 11. INFRA TRANSVERSAL (eficiência e segurança)

| Tema | Decisão |
|---|---|
| Prompt cache | system prompt **template por role** (prefixo idêntico); task no fim; despacho em rajada (TTL ~5min) |
| Boot MCP/LSP | `opencode serve` de longa duração por nó; workers attacham (boot 1×, não 20×) |
| Queen context | lê só eventos→resumos; pulsos isolados; state no blackboard, não na memória |
| Snapshots | off nos workers; on na Queen e no portão |
| Sandbox | worktree isola arquivos, NÃO bash → devcontainer/permissões bash restritas por perfil |
| Permissions | hook `permission.ask`: pulso = observador (defer); workers = política do constitution |
| Modelo | workers baratos; Queen + Judge fortes; cache não cruza modelos |
| Storage | `OPENCODE_DISABLE_PRUNE` avaliado; política de GC de sessões |

---

## 12. ROTEIRO (ordem = dependência)

| Fase | Entrega | Critério de aceite |
|---|---|---|
| **F0** | Esqueleto heartbeat | pulso na TUI; on/off instantâneo; busy não empilha |
| **F1** | Blackboard + digest | crash-safe; digests idênticos por role |
| **F2** | Wave runner + merge queue | 10 specs paralelos; main intocável sem portão |
| **F3** | Governor + judge | zero tempestade 429; portão exige verdict |
| **F4** | Eval harness + learnings | relatório de onda por comando; learnings aplicados |
| **F5** | Farm multi-nó | worker remoto via serve+attach passa no mesmo eval |
| **F6** | God extras | preditivo, auto-evolução de prompts, colmeia de Queens |

## 13. Riscos mapeados

| Risco | Mitigação |
|---|---|
| Rate limit do provider | Governor F3 (token bucket, stagger, multi-key) |
| Merge hell | specs disjuntos + interfaces-primeiro + portão serial |
| Contexto da Queen explodindo | resumos de eventos + pulsos isolados |
| Worker escapando do sandbox | devcontainer/permissões; nunca L3 sem isso |
| Custo fora de controle | budget por onda + teto diário + kill switch |
| Workers zumbis | claims com TTL + reaper no tick |
| Pulso spammável | contrato HEARTBEAT_OK + learnings anti-spam |
