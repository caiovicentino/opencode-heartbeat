---
name: heartbeat
description: Protocolo do pulso do heartbeat e das tools heartbeat_* e god_*. Use quando um pulso com marcador [🫀 pulse] chegar, ou quando o usuário pedir para monitorar, acompanhar, ligar, desligar, pausar ou acelerar o heartbeat, registrar watches, ou consultar o blackboard da frota.
---

# Heartbeat

O heartbeat é um pulso periódico que te acorda nesta sessão para acompanhar as tasks em andamento. Cada pulso chega como uma mensagem do usuário com o marcador `[🫀 pulse]` e um contexto (digest) pronto — todos, git, watches.

## Contrato de resposta (obrigatório)

- Nada precisa de atenção → responda **apenas**: `HEARTBEAT_OK`
- Vale falar → comece a resposta com `NOTIFY:` (aparece no chat normalmente)
- Urgência → comece com `ALERT:` (dispara notificação do SO e fica no chat)

Nunca execute ações que pedem aprovação durante um pulso — o pulso é **observador**. Se uma ação for necessária, reporte em `NOTIFY:` e espere o usuário decidir.

## Tools

| Tool | Uso |
|---|---|
| `heartbeat_on(interval?)` | liga o pulso; intervalo ex: `5m`, `10m`, `1h` |
| `heartbeat_off(duration?)` | desliga; com duração vira pausa que volta sozinha |
| `heartbeat_status` | estado atual, watches e últimos pulsos |
| `heartbeat_now(reason?)` | enfileira pulso imediato (dispara após o turno atual) |
| `heartbeat_interval(v)` | muda cadência (2m–1h) |
| `heartbeat_watch(goal, check, autonomy?, expires_in?)` | registra objetivo monitorado; `check` é um comando shell cuja saída entra no digest |
| `heartbeat_unwatch(id)` | encerra um watch |
| `god_board(scope?)` | inspeciona blackboard (specs/waves/learnings) |
| `god_learn(text, kind?)` | registra learning persistente que muda pulsos e ondas futuras |

## Modo god — boss

| Tool | Uso |
|---|---|
| `god_wave_create(objective, specs, ...)` | cria onda com specs disjuntas (JSON array) |
| `god_wave_run(wave_id?)` | despacha workers em sessões filhas, em paralelo, e coleta resultados estruturados |
| `god_merge(spec_id?)` | portão de merge: decide merge/retry/escalate pela constituição |
| `god_answer(ask_id, answer)` | responde ask de worker (desbloqueia a tool dele) |
| `god_steer(spec_id, instruction)` | envia direção ao worker (processa no próximo turno dele) |
| `god_eval(spec_id)` | roda os critérios de aceitação executáveis do spec e grava os checks |
| `god_judge(spec_id, judges?)` | convoca k judges que VERIFICAM (rodando os critérios), grava verdicts e retorna a decisão do portão |
| `god_report()` | relatório meta-eval: ondas, custo, utilidade dos pulsos, asks, learnings |

## Modo god — worker (você é worker quando a sessão tem título god:<spec>)

| Tool | Uso |
|---|---|
| `report_progress(text, status?)` | reporta progresso ao boss (entra no digest do próximo pulso) |
| `ask_boss(question, options?, timeout_sec?)` | pergunta bloqueante ao boss; no timeout, siga no nível L0 e registre a decisão |

## Autonomia dos watches

- **L0** — observar e reportar (padrão)
- **L1** — sugerir ação no `NOTIFY:`
- **L2** — agir pedindo aprovação
- **L3** — agir sozinho (requer constituição; não use sem configuração explícita)

## Estado e arquivos

- Estado: `.opencode/state/heartbeat.json` (sobrevive a restart)
- Checklist: `.opencode/state/heartbeat.md` (scratch viva — leia no pulso quando o digest mandar)
- Journal: `.opencode/state/journal/pulses.jsonl` (auditoria)
- Kill switch: `.opencode/state/kill.switch` — **se o arquivo não existir, nada roda**. Nunca recrie sem pedir ao usuário.

## Cadência adaptativa

Você pode ajustar a própria cadência conforme o contexto: acelere (`heartbeat_interval`/`heartbeat_on` com intervalo curto) quando algo está prestes a mudar (build, deploy, teste rodando) e desacelere quando tudo está estável. Para acordar em um momento específico, use `heartbeat_now` com o motivo.

## Limitações conhecidas

- O pulso entra como mensagem na sessão atual (como se o usuário tivesse digitado). Se o usuário estiver digitando no input, pode haver colisão rara — a guarda de cooldown de 90s mitiga, mas não elimina.
- O pulso só existe enquanto o opencode está aberto.
