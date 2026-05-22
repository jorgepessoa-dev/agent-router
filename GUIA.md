# Guia de utilização — ClaudeCode_router

Guia prático, em português. Para detalhes técnicos (arquitectura, formatos de
provider, configuração avançada), ver `README.md`.

## O que isto é, em duas frases

O router é um intermediário que corre no teu computador. Quando lanças o Claude
Code **através dele**, os pedidos passam a ir para o **MiniMax** (modelo mais
barato) em vez dos modelos da Anthropic — e o Claude Code continua a funcionar
exactamente igual, sem dares por nada.

## 1. Como se usa

Há **dois comandos** para arrancar o Claude Code. O comando que escolhes decide
tudo:

| Comando | O que acontece | Quem paga |
|---|---|---|
| `claude` | Claude Code normal, modelos Claude reais | subscrição Claude Pro |
| `scripts/cc.sh` | Claude Code com routing — tudo vai para MiniMax | créditos MiniMax |

**Atalho (define uma vez):** para não escreveres o caminho todo, cria um alias
no teu `~/.bashrc` — ajusta o caminho para onde clonaste o repositório:

```sh
alias ccrouter='/caminho/para/ClaudeCode_router/scripts/cc.sh'
```

A partir daí lanças o router com um comando só:

```sh
ccrouter
```

Isto arranca o router (se ainda não estiver a correr) e abre o Claude Code já
ligado a ele. A partir daí usas o Claude Code como sempre.

**Exemplo passo-a-passo:**

1. Abre um terminal.
2. Corre o lançador: `ccrouter`
3. Na 1ª vez vês `[cc] starting router on http://localhost:8787 ...` — é o
   router a arrancar. Nas vezes seguintes já está a correr e nem isso aparece.
4. O Claude Code abre normalmente. Trabalhas como sempre; as respostas passam
   a vir do MiniMax.

(Em Windows nativo o lançador é outro — ver a secção **Plataformas**.)

## 2. Aplica-se a todos os projectos?

**Não automaticamente.** O routing aplica-se **à sessão que lanças com `cc.sh`**,
não a todos os projectos de uma vez.

- Corres `cc.sh` a partir da pasta de um projecto qualquer → essa sessão fica
  routed, para esse projecto.
- Funciona com **qualquer** projecto — o router não é específico do
  `ClaudeCode_router`. Basta lançar `cc.sh` a partir da pasta onde queres
  trabalhar.
- Uma sessão aberta com `claude` normal **nunca** é routed.

Ou seja: é opt-in, sessão a sessão. Sempre que queres MiniMax, arrancas com
`cc.sh`; caso contrário, `claude`.

**Exemplo** — abrir o Claude Code routed noutro projecto:

```sh
cd ~/projects/outro-projecto
ccrouter
```

O Claude Code abre na pasta do `outro-projecto`, já routed para o MiniMax.

## 3. Como se escolhe o modelo

A escolha real é **qual comando usas para arrancar** (ponto 1) — não o `/model`.

- Numa sessão `cc.sh` (routed): o `/model` quase não conta. Com a configuração
  actual, todos os tiers (`haiku`, `sonnet`, `opus`) vão para o MiniMax.
- Numa sessão `claude` normal: o `/model` escolhe o modelo Claude real
  (Haiku / Sonnet / Opus).

Resumo: queres MiniMax → `cc.sh`. Queres Claude real → `claude` e depois
`/model`.

(O mapa tier-para-provider está em `config.json`, secção `routing.tiers`.
Hoje está tudo apontado a `minimax`; é aí que se mudaria para reencaminhar um
tier de volta para a Anthropic.)

## 4. Como se activa e desactiva

**Activar** (para uma sessão): arranca com `scripts/cc.sh` em vez de `claude`.

**Desactivar**: arranca com `claude` normal. O routing só existe nas sessões
lançadas via `cc.sh` — não há nada "ligado" que contamine o `claude` normal.

**O processo do router**: depois de arrancar, fica a correr em segundo plano em
`localhost:8787`. Deixá-lo a correr é inofensivo — só serve as sessões que
apontam para ele. Para o parar de vez (opcional):

```sh
lsof -ti:8787 | xargs kill
```

Não há um botão "on/off" dentro de uma sessão — decide-se sempre no arranque.

## 5. Contexto e impacto real

**Porquê usar**: o MiniMax-M2.7 custa uma fracção do Claude. Num teste real, um
pedido custou ~$0,00009 contra ~$0,001 no preço de referência do Sonnet — cerca
de **91% mais barato**. A percentagem é por token, por isso escala com o uso.

**O custo disso**: o MiniMax-M2.7 é um modelo competente para código, mas **não
é o Claude**. Em raciocínio difícil, decisões de arquitectura e problemas
subtis, a qualidade é inferior. Tende também a "pensar" bastante (mais tokens de
output).

**Estratégia prática**:

- Trabalho rotineiro, repetitivo, muito volume → `cc.sh` (MiniMax, barato).
- Raciocínio difícil, arquitectura, depuração complexa → `claude` (Claude real,
  pago pelo Pro).

**Ver o gasto**: com o router a correr, abre `http://localhost:8787/` no
browser. Vês uma tabela com uma linha por provider (`minimax`, etc.), e em cada
linha:

- número de pedidos feitos
- tokens de entrada / saída
- custo acumulado, em dólares
- poupança estimada face ao preço de referência do Sonnet

A página actualiza-se sozinha. É a forma de não seres surpreendido pela
factura.

## Usar com o Codex CLI

O router também serve o **Codex CLI** (o agente da OpenAI), não só o Claude
Code. O Codex fala a API da OpenAI; o router expõe um endpoint compatível em
`POST /v1/chat/completions` e traduz para MiniMax por baixo.

Configura o Codex em `~/.codex/config.toml`:

```toml
model_provider = "ccrouter"
model = "route-sonnet"

[model_providers.ccrouter]
name = "ClaudeCode_router"
base_url = "http://localhost:8787/v1"
wire_api = "chat"
env_key = "CCROUTER_KEY"
```

- `wire_api = "chat"` — usa a API Chat Completions, que é a que o router expõe.
- `env_key` — o router não valida a chave, mas o Codex exige a variável.
  Define-a com qualquer valor: `export CCROUTER_KEY=local`.
- `model` — `route-sonnet` encaminha para o MiniMax; qualquer nome desconhecido
  também cai no MiniMax por omissão.

O router tem de estar a correr (`ccrouter`, ou `scripts/cc.sh` /
`scripts\cc.ps1`). Funciona em WSL e em Windows.

## Plataformas

O router (Node.js) corre em qualquer sistema. O que muda é o **lançador**:

| Sistema | Lançador |
|---|---|
| WSL / Linux / macOS | `scripts/cc.sh` |
| Windows nativo (PowerShell) | `scripts\cc.ps1` |
| App de chat do Claude (claude.ai) | não aplicável |

**Windows nativo:** corre `scripts\cc.ps1` no PowerShell. Na primeira vez, o
Windows pode bloquear scripts não assinados — autoriza uma só vez com:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

**App de chat do Claude:** o router **não** funciona com a aplicação de chat do
Claude (claude.ai). Essa app usa a tua conta directamente e não pode ser
redireccionada. O router só serve o **Claude Code**, que aceita ser apontado a
um endereço próprio via `ANTHROPIC_BASE_URL`.

## Pré-requisitos

- `MINIMAX_API_KEY` definida no ficheiro `.env`, na raiz do `ClaudeCode_router`.
- Node.js versão 20 ou superior.
- Saldo na conta MiniMax (acompanha o gasto no dashboard).
