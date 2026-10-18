# 🩺 viwer — Session Doctor (WhatsApp / Baileys)

Ferramenta para **recriar a sessão do WhatsApp do zero** quando você remove o aparelho no celular
e o bot fica "carregando e tentando puxar a sessão anterior apagada".

Feita para o seu stack: **`@boruto_vk7/baileys`** (fork do Baileys v7), Node ≥ 20.

---

## ⚡ Por que isso acontece (resumo do seu caso)

Quando você toca em **"Aparelhos conectados → Desconectar"** no celular, o WhatsApp invalida as chaves
daquele aparelho **no servidor**. O Baileys **não fica sabendo**: ele continua vendo o `creds.json` no disco com
`registered: true` e tenta reabrir a sessão antiga. O servidor responde **`401 loggedOut`** (ou a conexão simplesmente
não sai do `connecting`), e o bot entra em loop — que é exatamente o "carrega e tenta puxar minha sessão anterior apagada".

Ou seja: **não existe "reativar" sessão desconectada. Só apagar as creds locais e parear de novo.**

### Os 3 comandos que resolvem

```bash
# 1) PARE o bot (2 processos na mesma sessão geram erro 440 connectionReplaced)
pm2 stop all          # ou: pkill -f node

# 2) Apague a pasta de auth — com o processo PARADO (senão ele regrava as creds na hora)
rm -rf ./session      # ← a pasta que o SEU código passa em useMultiFileAuthState(...)
rm -f ./store.json    # só se você usa makeInMemoryStore

# 3) Recrie: QR no terminal
npm run pair
#   ou por código de pareamento (sem QR)
npm run pair -- --phone 5519999999999
```

> 🔑 **O erro nº 1 é apagar a pasta errada.** Muita gente apaga `./session` enquanto o bot usa
> `./auth_info_baileys`, `./sessions/meu-bot`, etc. Use `npm run doctor` — ele varre o projeto e te diz
> quais pastas têm cara de sessão e qual delas está com `registered=true`.

---

## 🚀 Rodando

```bash
npm install
npm start          # painel web em http://localhost:3000
```

No painel você tem:

| Área | O que faz |
| --- | --- |
| **1. Parear de novo** | QR Code na tela (renova sozinho), código de pareamento por número, botões de apagar/conectar/parar |
| **2. Estado da sessão** | pasta de auth, `creds.registered`, conta conectada, versão do WA Web, teste de rede, `.zip` da sessão, lixeira |
| **3. Diagnóstico** | lista de problemas detectados com a correção de cada um |
| **4. Aplicar no SEU bot** | comandos + código pronto para colar no seu projeto |
| **Console** | log ao vivo (códigos de desconexão traduzidos) |

### CLI

```bash
npm run doctor                              # diagnóstico da pasta ./session
npm run doctor -- --dir ./auth_info_baileys # diagnóstico de outra pasta
npm run reset                               # apaga a sessão (move para .trash/, recuperável)
npm run reset  -- --purge --store           # apaga de vez + remove store.json da raiz
npm run pair                                # recria a sessão mostrando o QR no terminal
npm run pair   -- --phone 5519999999999     # recria usando código de pareamento
```

### Variáveis de ambiente

| Var | Padrão | Uso |
| --- | --- | --- |
| `SESSION_DIR` | `./session` | Pasta do `useMultiFileAuthState` (aponte para a do seu bot!) |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Servidor web |
| `WA_PHONE` | — | Número para código de pareamento (só dígitos, com DDI) |
| `WA_VERSION` | auto | Trava a versão do WhatsApp Web, ex.: `2.3000.1048579041` |
| `AUTO_WIPE_ON_LOGOUT` | `true` | Ao tomar `401`, apaga as creds e volta pro QR sozinho |
| `MAX_RECONNECT` | `15` | Tentativas de reconexão automática |
| `QR_TIMEOUT` | `45000` | Vida útil de cada QR (ms) |
| `BAILEYS_LOG` | `silent` | `silent` \| `info` \| `debug` |

**Rodando no seu servidor/VPS:**

```bash
SESSION_DIR=/caminho/do/seu/bot/session WA_PHONE=5519999999999 npm start
```

---

## 🔌 O teste de rede (por que às vezes o QR não nasce)

O QR só aparece quando o Baileys consegue abrir o websocket `wss://web.whatsapp.com/ws/chat` e receber o
stanza `pair-device`. Se a máquina não tem saída 443 para o WhatsApp (VPS bloqueada, proxy corporativo, VPN,
sandbox, DNS sujo), **nenhum QR vai aparecer por mais que você apague a sessão** — e o sintoma é confundido com
"sessão corrompida".

O Session Doctor testa isso sozinho (`🌐 Testar rede`) e, se falhar, para de tentar em vez de ficar em loop.

> ⚠️ **No sandbox do Arena (este preview) o WhatsApp é inalcançável** — TLS para `web.whatsapp.com:443` é bloqueado.
> Aqui você vê o painel e o diagnóstico funcionando; **o pareamento real precisa ser feito na máquina/VPS onde o seu
> bot roda** (que é onde as creds têm que existir mesmo). Rode `npm start` lá e escaneie o QR.

---

## 🩹 Correção permanente no SEU bot

Cole isso no lugar do seu `connectToWhatsApp()` atual. A diferença essencial é o tratamento do `401`:
em vez de reconectar com creds mortas, **apaga e re-pareia**.

```js
import { makeWASocket, useMultiFileAuthState, DisconnectReason,
         fetchLatestBaileysVersion, Browsers } from '@boruto_vk7/baileys'
import { Boom } from '@hapi/boom'
import { rm } from 'node:fs/promises'

const SESSION_DIR = './session'   // ⚠️ exatamente a pasta que o seu bot usa
const PHONE = ''                  // opcional: '5519999999999' para parear por código

async function start(fresh = false) {
  // fresh = true → sessão nova do zero (é o que falta no seu caso)
  if (fresh) await rm(SESSION_DIR, { recursive: true, force: true })

  const { version } = await fetchLatestBaileysVersion()
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR)

  const sock = makeWASocket({
    version,                          // ou: version: [2, 3000, 1048579041]
    auth: state,
    printQRInTerminal: true,
    browser: Browsers.ubuntu('Meu Bot'),
    qrTimeout: 45_000
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) console.log('🔳 QR gerado — escaneie no celular')

    // pareamento por número, sem QR (opcional)
    if (connection === 'connecting' && !sock.authState.creds.registered && PHONE) {
      setTimeout(async () => console.log('🔢 Código:', await sock.requestPairingCode(PHONE)), 1800)
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode

      // 👇 AQUI está o conserto: sessão morta = apagar creds e pedir pareamento novo
      if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
        console.warn(`Sessão inválida (${code}) — apagando creds e gerando novo QR`)
        return start(true)
      }
      // 440 = outro processo com a mesma sessão; reconectar não adianta
      if (code === DisconnectReason.connectionReplaced) {
        return console.error('Outro processo está usando essa sessão. Encerre o duplicado.')
      }
      console.warn('Reconectando… código', code)
      return start(false)
    }

    if (connection === 'open') console.log('✅ conectado como', sock.user?.id)
  })
}

start(false)
```

### Tabela de códigos (o que cada um significa na prática)

| Código | Nome | O que fazer |
| --- | --- | --- |
| **401** | `loggedOut` | **Sessão morta.** Apagar a pasta de auth e parear de novo (é o seu caso) |
| 408 | `timedOut` / `connectionLost` | Timeout/QR expirado → reconectar. Se nunca chegou QR: teste de rede |
| 411 | `multideviceMismatch` | Versão do WA Web incompatível → atualizar lib / `fetchLatestBaileysVersion()` |
| 428 | `connectionClosed` | Servidor fechou o socket → reconectar |
| 440 | `connectionReplaced` | **Dois processos na mesma sessão** → matar o duplicado (`pm2 list`) |
| 500 | `badSession` | Creds corrompidas → apagar e parear |
| 515 | `restartRequired` | Normal → reconectar |

---

## 📦 Versões / branches (o que pesquisei para você)

| Item | Situação em 27/09/2026 |
| --- | --- |
| `@boruto_vk7/baileys` no npm | **`1.0.28-rc14-eduh.0`** (`latest`, publicado em 16/08/2026) — é o que este repo instala |
| Repo do fork | `github.com/borutovk7/baileys` → redireciona para **`eduhdev021/Baileys`** (branch único: `main`, último push 01/08/2026) |
| Upstream oficial | `WhiskeySockets/Baileys` — `master` em 04/08/2026, `develop` em 05/08/2026 |
| **Branch mais recente do upstream** | **`update-version/stable`** — commit de **hoje, 27/09/2026 00:53 UTC**: `chore: update WhatsApp Web version` |
| Baileys "puro" no npm | `baileys@7.0.0-rc14` (29/07/2026) |

**O achado útil do branch `update-version/stable`:** o arquivo `src/Defaults/baileys-version.json` está em

```json
{ "version": [2, 3000, 1048579041] }
```

enquanto o fork `@boruto_vk7/baileys 1.0.28` (e o `master` do upstream) ainda traz o fallback antigo

```js
const version = [2, 3000, 1043857760]   // lib/Defaults/index.js do fork
```

Como o fork tenta buscar a versão online (cache de 12 h) e cai nesse fallback quando não consegue alcançar o WhatsApp,
o Session Doctor já **usa `2.3000.1048579041` automaticamente** quando o fetch falha, e você pode travar
a versão no painel ou com `WA_VERSION=2.3000.1048579041 npm start`. No seu bot:

```js
const sock = makeWASocket({ version: [2, 3000, 1048579041], /* ... */ })
```

> 📌 Sobre o "v2.1.0" que você citou: **não existe** versão 2.x de `@boruto_vk7/baileys` no npm
> (as versões vão de `0.3.18-final` a `1.0.28-rc14-eduh.0`). Se `2.1.0` é a versão do *seu bot*, tudo bem —
> a lib é essa mesma. Se for outro pacote (`@nexustechpro/baileys 2.2.7`, `@vanzxy/baileys 2.0.3`,
> `chat-adapter-baileys 2.1.0`…), me diga qual que eu ajusto o código.

---

## ✅ Checklist "apaguei e não adiantou"

1. [ ] **Processo parado?** Se o bot estiver rodando, ele regrava `creds.json` na hora (`sock.ev.on('creds.update', saveCreds)`).
2. [ ] **Pasta certa?** `grep -rn "useMultiFileAuthState" .` no seu projeto e confira o caminho exato.
3. [ ] **Apagou tudo?** Não só o `creds.json` — a pasta inteira (`pre-key-*.json`, `sender-key-*.json`, `app-state-*.json`, `session-*.json`).
4. [ ] **Resíduos na raiz?** `store.json` (makeInMemoryStore) e `session.json` (single-file auth) também guardam estado velho.
5. [ ] **Só um processo?** `pm2 list`, `ps aux | grep node`. Duplicado = `440`.
6. [ ] **Rede liberada?** `curl -v https://web.whatsapp.com` precisa completar o TLS. Sem isso, zero QR.
7. [ ] **Node ≥ 20** (`node -v`).
8. [ ] **Lib atualizada?** `npm i @boruto_vk7/baileys@latest` e version do WA Web recente (411/405 costumam ser isso).
9. [ ] **Não escaneou rápido demais?** O QR expira em ~20–60 s; o Baileys renova, mas cada renovação encurta o tempo.
10. [ ] **Celular**: WhatsApp → Aparelhos conectados → **Conectar aparelho** (não "Conectar com número" se for usar QR).

---

## 🔒 Segurança

- A pasta `session/`, `.trash/`, `creds.json` e `store.json` estão no **`.gitignore`**. **Nunca** versione credenciais do WhatsApp —
  quem tiver o `creds.json` tem o seu número.
- O "apagar" do painel **move** a sessão velha para `.trash/session-<timestamp>` (dá pra recuperar se você apagou sem querer).
  Use `npm run reset -- --purge` ou o botão "Esvaziar lixeira" para apagar de vez.
- O botão **"Parar e deslogar"** envia `logout()` ao WhatsApp: ele remove o aparelho do seu celular. Só use se for a intenção.

---

## 🗂 Estrutura

```
src/config.mjs           constantes, códigos de desconexão traduzidos, versão conhecida do WA Web
src/session-manager.mjs  conexão Baileys, QR/código de pareamento, auto-limpeza no 401, netTest, diagnóstico, zip
src/server.mjs           API Express + painel
src/cli.mjs              doctor / reset / pair no terminal
public/index.html        painel web
```
