import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import dns from 'node:dns/promises'
import net from 'node:net'
import tls from 'node:tls'
import path from 'node:path'
import process from 'node:process'

import { Boom } from '@hapi/boom'
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState
} from '@boruto_vk7/baileys'
import pino from 'pino'
import QRCode from 'qrcode'
import qrcodeTerminal from 'qrcode-terminal'
import { zipSync, strToU8 } from 'fflate'

import { ROOT, KNOWN_SESSION_DIRS, LEFTOVER_FILES, KNOWN_LATEST_WA_VERSION, KNOWN_LATEST_WA_VERSION_INFO, parseVersion, config, DISCONNECT_HELP, STATUS_LABEL } from './config.mjs'

qrcodeTerminal.setErrorLevel('L')

/** Extrai o status code de um erro Boom (ou de qualquer coisa parecida) */
function statusCodeOf(error) {
  if (!error) return undefined
  const boom = error instanceof Boom ? error : new Boom(error?.message || String(error), {
    statusCode: error?.output?.statusCode ?? error?.statusCode ?? error?.data?.statusCode
  })
  const code = boom.output?.statusCode
  return Number.isFinite(code) && code > 0 ? code : undefined
}

/** 55 19 99999-9999 -> 5519999999999 */
export function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '')
  if (!digits) return ''
  if (digits.length <= 11 && digits.startsWith('0')) return digits.slice(1)
  return digits
}

export class SessionManager extends EventEmitter {
  #logs = []
  #timers = new Set()
  #netCache = null

  constructor(opts = {}) {
    super()
    this.sessionDir = path.resolve(opts.sessionDir || config.sessionDir)
    this.trashDir = path.resolve(opts.trashDir || config.trashDir)
    this.autoWipeOnLogout = opts.autoWipeOnLogout ?? config.autoWipeOnLogout
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? config.maxReconnectAttempts
    this.qrTimeout = opts.qrTimeout ?? config.qrTimeout
    this.browserName = opts.browserName ?? config.browserName
    this.logLevel = opts.logLevel ?? config.logLevel
    this.waVersionOverride = parseVersion(opts.version) || config.waVersion || null

    this.sock = null
    this.saveCreds = null
    this.status = 'idle'
    this.statusDetail = ''
    this.me = null
    this.registered = false
    this.qr = null // string crua
    this.qrDataUrl = null // png base64 pro navegador
    this.qrAt = 0
    this.qrSeq = 0
    this.pairingCode = null
    this.pendingPhone = opts.phone || null
    this.waVersion = null
    this.reconnectAttempts = 0
    this.userStopped = true
    this.startedAt = 0
    this.connectedAt = 0
    this.libVersion = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/@boruto_vk7/baileys/package.json'), 'utf8')).version
      } catch {
        return 'desconhecida'
      }
    })()
  }

  /* ------------------------------------------------------------------ logs */

  log(level, msg, extra) {
    const entry = { ts: Date.now(), level, msg, extra }
    this.#logs.push(entry)
    if (this.#logs.length > 600) this.#logs.splice(0, this.#logs.length - 600)
    const line = `[${new Date(entry.ts).toLocaleTimeString('pt-BR')}] ${level.toUpperCase()} ${msg}`
    if (level === 'error') console.error(line)
    else console.log(line)
    this.emit('log', entry)
    return entry
  }

  setStatus(status, detail = '') {
    this.status = status
    this.statusDetail = detail
    this.emit('status', { status, label: STATUS_LABEL[status] || status, detail })
    this.log('status', `${STATUS_LABEL[status] || status}${detail ? ` — ${detail}` : ''}`)
  }

  #later(fn, ms) {
    const t = setTimeout(() => {
      this.#timers.delete(t)
      fn()
    }, ms)
    this.#timers.add(t)
    return t
  }

  #clearTimers() {
    for (const t of this.#timers) clearTimeout(t)
    this.#timers.clear()
  }

  /* -------------------------------------------------------- estado em disco */

  async wipe({ purge = false, wipeStore = false } = {}) {
    await this.#killSocket()

    const removed = []
    if (fs.existsSync(this.sessionDir)) {
      if (purge) {
        await rm(this.sessionDir, { recursive: true, force: true })
        removed.push(this.sessionDir)
        this.log('warn', `Pasta de sessão apagada definitivamente: ${this.sessionDir}`)
      } else {
        await mkdir(this.trashDir, { recursive: true })
        const dest = path.join(this.trashDir, `session-${Date.now()}`)
        try {
          await rename(this.sessionDir, dest)
          removed.push(dest)
          this.log('warn', `Sessão velha movida para a lixeira: ${dest}`)
        } catch {
          await rm(this.sessionDir, { recursive: true, force: true })
          removed.push(this.sessionDir)
          this.log('warn', `Não deu pra mover; pasta apagada: ${this.sessionDir}`)
        }
      }
    } else {
      this.log('info', `Nada pra apagar — ${this.sessionDir} não existe.`)
    }

    if (wipeStore) {
      for (const f of LEFTOVER_FILES) {
        const p = path.join(ROOT, f)
        if (fs.existsSync(p)) {
          await rm(p, { force: true })
          removed.push(p)
          this.log('warn', `Removido resíduo: ${f}`)
        }
      }
    }

    this.registered = false
    this.me = null
    this.qr = null
    this.qrDataUrl = null
    this.qrAt = 0
    this.pairingCode = null
    this.log('success', 'Estado limpo. Agora o Baileys vai pedir pareamento (QR ou código) em vez de reusar a sessão morta.')
    return { removed, sessionDir: this.sessionDir }
  }

  async listTrash() {
    if (!fs.existsSync(this.trashDir)) return []
    const items = await readdir(this.trashDir, { withFileTypes: true })
    const out = []
    for (const it of items) {
      const p = path.join(this.trashDir, it.name)
      const s = await stat(p).catch(() => null)
      out.push({ name: it.name, path: p, mtime: s?.mtimeMs || 0 })
    }
    return out.sort((a, b) => b.mtime - a.mtime)
  }

  async purgeTrash() {
    if (fs.existsSync(this.trashDir)) await rm(this.trashDir, { recursive: true, force: true })
    this.log('info', 'Lixeira esvaziada.')
    return { ok: true }
  }

  /** Gera um .zip com a pasta de sessão (útil pra levar a sessão criada aqui pro seu servidor) */
  async zip() {
    if (!fs.existsSync(this.sessionDir)) throw new Error('A pasta de sessão não existe ainda.')
    const files = {}
    const walk = async (dir, base = '') => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        const rel = base ? `${base}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(full, rel)
        else files[rel] = strToU8(await readFile(full, 'utf8'))
      }
    }
    await walk(this.sessionDir)
    if (!Object.keys(files).length) throw new Error('A pasta de sessão está vazia.')
    return Buffer.from(zipSync(files, { level: 6 }))
  }

  /* ------------------------------------------------------------- conexão WA */

  async start({ wipe = false, phone = null, wipeStore = false } = {}) {
    if (this.sock) await this.#killSocket()
    this.#clearTimers()
    this.userStopped = false
    this.reconnectAttempts = 0
    this.pairingCode = null
    if (phone) this.pendingPhone = normalizePhone(phone)

    if (wipe) {
      this.log('info', 'Modo "recriar do zero": apagando sessão antiga antes de conectar.')
      await this.wipe({ wipeStore })
    }
    await this.#connect()
  }

  /** Força a versão do WhatsApp Web (null = voltar ao automático) */
  setVersion(input) {
    this.waVersionOverride = input === null || input === '' ? null : parseVersion(input)
    this.log('info', this.waVersionOverride
      ? `Versão do WA Web travada em ${this.waVersionOverride.join('.')}`
      : 'Versão do WA Web voltou para o modo automático')
    return this.waVersionOverride
  }

  async stop({ logout = false } = {}) {
    this.userStopped = true
    this.#clearTimers()
    if (logout && this.sock && this.status === 'open') {
      try {
        await this.sock.logout()
        this.log('warn', 'logout() enviado — o dispositivo foi removido do seu WhatsApp.')
      } catch (e) {
        this.log('error', `Falha no logout: ${e?.message || e}`)
      }
    }
    await this.#killSocket()
    this.setStatus('idle', 'parado manualmente')
  }

  async #killSocket() {
    const sock = this.sock
    this.sock = null
    if (!sock) return
    try {
      sock.ev.removeAllListeners('connection.update')
      sock.ev.removeAllListeners('creds.update')
      await sock.end()
    } catch {
      try {
        sock.ws?.close()
      } catch {
        /* noop */
      }
    }
  }

  async #connect() {
    this.setStatus('starting')
    this.startedAt = Date.now()

    // 1) override manual  2) fetchLatestBaileysVersion (cache de 12h nessa lib)  3) versão conhecida mais recente
    if (this.waVersionOverride) {
      this.waVersion = this.waVersionOverride
      this.log('info', `WhatsApp Web version (forçada): ${this.waVersion.join('.')}`)
    } else {
      try {
        const { version, isLatest } = await fetchLatestBaileysVersion()
        this.waVersion = version
        this.log('info', `WhatsApp Web version: ${version.join('.')}${isLatest ? '' : ' (padrão da lib — pode estar defasada)'}`)
      } catch (e) {
        this.log('warn', `Não consegui buscar a versão do WA Web (${e?.message || e}).`)
      }
      if (!this.waVersion || this.waVersion.join('.') === KNOWN_LATEST_WA_VERSION_INFO.forkFallback.join('.')) {
        this.waVersion = KNOWN_LATEST_WA_VERSION
        this.log('info', `Usando a versão mais recente conhecida do WA Web: ${this.waVersion.join('.')} (${KNOWN_LATEST_WA_VERSION_INFO.branch}, verificado em ${KNOWN_LATEST_WA_VERSION_INFO.checkedAt})`)
      }
    }

    await mkdir(this.sessionDir, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir)
    this.saveCreds = saveCreds
    this.registered = !!state.creds.registered
    this.me = state.creds.me || null

    if (this.registered) {
      this.log('info', `Encontrei creds antigas (registered=true) em ${this.sessionDir} → tentando reusar sessão existente.`)
      this.log('info', '⚠️ Se você apagou esse dispositivo no celular, isso é exatamente o que trava: marque "apagar sessão" para forçar um QR novo.')
    } else {
      this.log('info', `Sem creds em ${this.sessionDir} → sessão nova, vou gerar QR/código de pareamento.`)
    }

    const logger = pino({ level: this.logLevel })
    const sock = makeWASocket({
      version: this.waVersion,
      auth: state,
      logger,
      printQRInTerminal: true,
      browser: Browsers.ubuntu(this.browserName),
      qrTimeout: this.qrTimeout,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      emitOwnEvents: false,
      fireInitQueries: false
    })

    this.sock = sock

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds()
      } catch (e) {
        this.log('error', `Não consegui salvar as creds em disco: ${e?.message || e}`)
      }
      this.registered = !!sock.authState.creds.registered
      if (sock.authState.creds.me) this.me = sock.authState.creds.me
    })

    sock.ev.on('connection.update', (update) => this.#onConnectionUpdate(update, sock))

    return sock
  }

  async #onConnectionUpdate(update, sock) {
    if (this.sock !== sock) return // socket antigo falando — ignora

    const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update

    if (qr) {
      this.qr = qr
      this.qrSeq += 1
      this.qrAt = Date.now()
      try {
        this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 360, errorCorrectionLevel: 'L' })
      } catch (e) {
        this.log('error', `Falha ao renderizar o QR: ${e?.message || e}`)
      }
      this.setStatus('qr', `QR #${this.qrSeq} — abra o WhatsApp → Aparelhos conectados → Conectar aparelho`)
      try {
        qrcodeTerminal.generate(qr, { small: true })
      } catch {
        /* noop */
      }
      this.#later(() => {
        const age = Date.now() - this.qrAt
        if (this.status === 'qr' && age > this.qrTimeout + 5000) {
          this.log('warn', 'QR expirou sem ser escaneado. Aguardando o Baileys gerar outro…')
        }
      }, this.qrTimeout + 6000)
    }

    if (isNewLogin) {
      this.pairingCode = null
      this.log('success', 'Pareamento aceito pelo celular! Reiniciando a conexão para completar o login…')
    }

    if (connection === 'connecting') {
      if (!sock.authState?.creds?.registered) {
        this.setStatus(this.pendingPhone ? 'pairing' : 'connecting', 'abrindo canal de pareamento…')
        if (this.pendingPhone && !this.pairingCode) {
          this.#later(async () => {
            if (this.sock !== sock || !this.pendingPhone) return
            try {
              const code = await sock.requestPairingCode(this.pendingPhone)
              this.pairingCode = code
              this.setStatus('pairing', `Digite ${code} no celular: WhatsApp → Aparelhos conectados → Conectar com número`)
              this.log('success', `🔢 Código de pareamento: ${code} (celular ${this.pendingPhone})`)
            } catch (e) {
              this.log('error', `Falha ao pedir o código de pareamento: ${e?.message || e}`)
              this.pendingPhone = null
            }
          }, 1800)
        }
      } else {
        this.setStatus('connecting', 'autenticando com as creds existentes…')
      }
      return
    }

    if (connection === 'open') {
      this.reconnectAttempts = 0
      this.connectedAt = Date.now()
      this.registered = true
      this.me = sock.user || sock.authState?.creds?.me || this.me
      this.qr = null
      this.qrDataUrl = null
      this.pairingCode = null
      this.pendingPhone = null
      this.setStatus('open', this.me?.id ? `conectado como ${this.me.id}` : 'conectado')
      this.log('success', `✅ Sessão recriada e ativa. Creds salvas em ${this.sessionDir}`)
      if (receivedPendingNotifications) this.log('info', 'Havia notificações pendentes sendo sincronizadas.')
      return
    }

    if (connection === 'close') {
      await this.#onClose(lastDisconnect?.error)
    }
  }

  async #onClose(error) {
    const code = statusCodeOf(error)
    const info = code ? DISCONNECT_HELP[code] : null
    const msg = error?.message || String(error || 'motivo não informado')

    this.log('warn', `Conexão fechada${code ? ` (código ${code})` : ''}: ${info?.label || msg}`)
    if (info?.hint) this.log('info', `💡 ${info.hint}`)

    if (this.userStopped) {
      this.setStatus('idle', 'parado')
      return
    }

    // 401 / 500 → sessão morta. Aqui está o pulo do gato: apagar e re-parear sozinho.
    if (info?.action === 'wipe-and-repair') {
      if (code === DisconnectReason.loggedOut) this.setStatus('loggedOut', 'as creds do disco não valem mais nada')
      if (this.autoWipeOnLogout) {
        this.log('warn', 'autoWipeOnLogout ativo → apagando creds mortas e abrindo um QR novo.')
        await this.wipe()
        this.reconnectAttempts = 0
        return this.#reconnect(1200)
      }
      this.setStatus('loggedOut', 'rode "Apagar sessão e reconectar"')
      return
    }

    if (info?.action === 'stop') {
      this.setStatus('error', 'conflito de sessão: outro processo está usando as mesmas creds')
      return
    }

    // 408 sem NENHUM QR até agora = quase sempre rede bloqueada, não problema de sessão.
    if (code === 408 && this.qrSeq === 0) {
      const net = await this.netTest()
      if (!net.ok) {
        this.log('error', '⛔ Não consigo abrir conexão com web.whatsapp.com a partir desta máquina.')
        this.log('error', `   Motivo: ${net.error || 'falha desconhecida'} (DNS: ${net.dns?.join(', ') || 'n/d'})`)
        this.log('info', '   Isso não é problema de sessão/creds: rode o Session Doctor na mesma máquina/VPS onde o seu bot roda, ou libere a saída 443 (whatsapp.net / whatsapp.com).')
        if (this.reconnectAttempts >= 2) {
          this.userStopped = true
          await this.#killSocket()
          this.setStatus('error', 'sem rota até o WhatsApp nesta máquina (rode o diagnóstico)')
          return
        }
      }
    }

    this.#reconnect()
  }

  #reconnect(baseDelay = 1500) {
    this.reconnectAttempts += 1
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      this.setStatus('error', `desisti depois de ${this.maxReconnectAttempts} tentativas`)
      this.log('error', 'Limite de reconexões atingido. Rode o diagnóstico e confira internet/versão da lib.')
      return
    }
    const delayMs = Math.min(30_000, baseDelay * 2 ** (this.reconnectAttempts - 1))
    this.setStatus('connecting', `reconectando em ${(delayMs / 1000).toFixed(1)}s (tentativa ${this.reconnectAttempts})`)
    this.#later(() => {
      if (!this.userStopped) this.#connect().catch((e) => this.log('error', `Erro ao reconectar: ${e?.message || e}`))
    }, delayMs)
  }

  /* ------------------------------------------------------------ teste de rede */

  /**
   * Sem isso o diagnóstico fica incompleto: muita gente acha que a sessão "não recria"
   * quando na verdade a máquina não consegue abrir TLS com web.whatsapp.com
   * (firewall, proxy, VPS bloqueada, sandbox, DNS sujo).
   */
  async netTest(force = false) {
    if (!force && this.#netCache && Date.now() - this.#netCache.at < 60_000) return this.#netCache

    const host = 'web.whatsapp.com'
    const port = 443
    const out = { at: Date.now(), host, dns: null, tcp: false, tls: false, ms: 0, error: null, ok: false }
    const t0 = Date.now()

    try {
      const addrs = await Promise.race([
        dns.lookup(host, { all: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('DNS timeout (8s)')), 8000))
      ])
      out.dns = addrs.map((a) => a.address)
    } catch (e) {
      out.error = `DNS falhou: ${e.message}`
      out.ms = Date.now() - t0
      this.#netCache = out
      this.log('error', out.error)
      return out
    }

    const target = out.dns.find((a) => !a.includes(':')) || out.dns[0]
    await new Promise((resolve) => {
      const sock = net.connect({ host: target, port, timeout: 8000 })
      sock.once('connect', () => {
        out.tcp = true
        sock.destroy()
        resolve()
      })
      sock.once('timeout', () => {
        out.error = `TCP ${target}:${port} timeout (8s) — porta 443 bloqueada`
        sock.destroy()
        resolve()
      })
      sock.once('error', (e) => {
        out.error = `TCP ${target}:${port} falhou: ${e.message}`
        resolve()
      })
    })

    if (out.tcp) {
      await new Promise((resolve) => {
        const sock = tls.connect({ host: target, port, servername: host, timeout: 10_000, rejectUnauthorized: false })
        sock.once('secureConnect', () => {
          out.tls = true
          sock.destroy()
          resolve()
        })
        sock.once('timeout', () => {
          out.error = `TLS handshake timeout com ${host} — MITM/proxy/firewall bloqueando`
          sock.destroy()
          resolve()
        })
        sock.once('error', (e) => {
          out.error = `TLS falhou: ${e.message}`
          resolve()
        })
      })
    }

    out.ok = out.tcp && out.tls
    out.ms = Date.now() - t0
    this.#netCache = out
    this.log(out.ok ? 'info' : 'error', out.ok
      ? `Rede OK: ${host} respondeu TLS em ${out.ms}ms (${out.dns.join(', ')})`
      : `Rede PROBLEMÁTICA: ${out.error || 'sem TLS'} (${out.dns?.join(', ') || 'sem DNS'})`)
    return out
  }

  /* ------------------------------------------------------------ diagnóstico */

  async diagnose() {
    const problems = []
    const scopes = [...new Set([ROOT, path.dirname(this.sessionDir)])]
    const dirInfo = await inspectDir(this.sessionDir)

    if (!dirInfo.exists || dirInfo.files === 0) {
      problems.push({
        severity: 'ok',
        title: 'Nenhuma sessão gravada aqui',
        detail: `${this.sessionDir} ${dirInfo.exists ? 'existe mas está vazia' : 'não existe'} → o Baileys vai pedir pareamento (QR ou código) no próximo start, que é o que você quer.`,
        fix: 'Clique em "Apagar sessão e reconectar" (ou só "Conectar") e escaneie o QR.'
      })
    } else if (!dirInfo.creds) {
      problems.push({
        severity: 'error',
        title: 'Pasta de sessão incompleta (sem creds.json)',
        detail: 'Existem arquivos de chave mas não existe creds.json — estado corrompido/pela metade.',
        fix: 'Apague a pasta inteira e re-pareie.'
      })
    } else if (dirInfo.creds.registered) {
      problems.push({
        severity: 'warn',
        title: 'creds.json diz registered=true → o bot tenta reusar a sessão antiga',
        detail:
          `Conta gravada: ${dirInfo.creds.me?.id || 'desconhecida'}. ` +
          'Se você removeu esse dispositivo no celular, o Baileys não fica sabendo: ele abre o websocket com essas creds, ' +
          'o servidor responde 401 (loggedOut) e o bot fica "carregando a sessão apagada" em loop.',
        fix: 'Apague a pasta de auth (botão vermelho / npm run reset) e escaneie um QR novo.'
      })
    }

    const others = await findOtherSessionDirs(this.sessionDir, scopes)
    if (others.length) {
      problems.push({
        severity: 'warn',
        title: `Achei ${others.length} outra(s) pasta(s) com cara de sessão`,
        detail: others.map((o) => `${o.path} (${o.files} arquivos${o.registered === true ? ', registered=true' : o.registered === false ? ', registered=false' : ''})`).join('\n'),
        fix: 'Confirme qual pasta o SEU código passa no useMultiFileAuthState(...). Apagar a pasta errada é a causa nº1 de "apaguei e não adiantou".'
      })
    }

    for (const f of LEFTOVER_FILES) {
      const p = scopes.map((scope) => path.join(scope, f)).find((cand) => fs.existsSync(cand))
      if (p) {
        problems.push({
          severity: 'info',
          title: `Resíduo na raiz: ${f}`,
          detail: 'Se o seu bot usa makeInMemoryStore ou single-file auth, esse arquivo também guarda dados da sessão antiga.',
          fix: `Marque "apagar store também" no reset, ou apague ${f} à mão com o bot PARADO.`
        })
      }
    }

    if (this.waVersion && this.waVersion.join('.') === KNOWN_LATEST_WA_VERSION_INFO.forkFallback.join('.') && !this.waVersionOverride) {
      problems.push({
        severity: 'info',
        title: `Versão do WhatsApp Web defasada (${this.waVersion.join('.')})`,
        detail: `O fallback da lib é de ${KNOWN_LATEST_WA_VERSION_INFO.checkedAt === '2026-09-27' ? '04/08/2026' : 'agosto/2026'}; a mais recente confirmada no upstream é ${KNOWN_LATEST_WA_VERSION.join('.')}.`,
        fix: `Force: makeWASocket({ version: [${KNOWN_LATEST_WA_VERSION.join(', ')}] }) ou WA_VERSION=${KNOWN_LATEST_WA_VERSION.join('.')} npm start`
      })
    }

    if (Number(process.versions.node.split('.')[0]) < 20) {
      problems.push({
        severity: 'error',
        title: `Node ${process.versions.node} é antigo demais`,
        detail: 'O @boruto_vk7/baileys exige Node >= 20.',
        fix: 'Atualize o Node (nvm install 22 && nvm use 22).'
      })
    }

    const net = await this.netTest()
    if (!net.ok) {
      problems.unshift({
        severity: 'error',
        title: '⛔ Sem rota até web.whatsapp.com (porta 443)',
        detail: `${net.error || 'falha desconhecida'} — DNS resolveu para: ${net.dns?.join(', ') || 'nada'}. ` +
          'Sem essa conexão o Baileys nunca recebe o stanza pair-device, ou seja: QR NENHUM aparece, por mais que você apague a sessão.',
        fix: 'Rode o Session Doctor (ou o seu bot) na máquina/VPS onde a sessão precisa existir, libere saída TCP 443 para *.whatsapp.com e *.whatsapp.net, e desative proxy/VPN/corporate MITM.'
      })
    }

    return {
      at: Date.now(),
      node: process.version,
      lib: this.libVersion,
      waVersion: this.waVersion,
      net,
      sessionDir: this.sessionDir,
      dir: dirInfo,
      others,
      problems,
      runtime: {
        status: this.status,
        statusLabel: STATUS_LABEL[this.status] || this.status,
        reconnectAttempts: this.reconnectAttempts,
        autoWipeOnLogout: this.autoWipeOnLogout
      }
    }
  }

  /* ----------------------------------------------------------------- estado */

  toJSON() {
    return {
      status: this.status,
      statusLabel: STATUS_LABEL[this.status] || this.status,
      statusDetail: this.statusDetail,
      sessionDir: this.sessionDir,
      libVersion: this.libVersion,
      waVersion: this.waVersion,
      waVersionOverride: this.waVersionOverride,
      knownLatestWaVersion: KNOWN_LATEST_WA_VERSION,
      me: this.me,
      registered: this.registered,
      qr: this.qrDataUrl,
      qrRaw: this.qr,
      qrAt: this.qrAt,
      qrSeq: this.qrSeq,
      qrTimeout: this.qrTimeout,
      pairingCode: this.pairingCode,
      pendingPhone: this.pendingPhone,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      autoWipeOnLogout: this.autoWipeOnLogout,
      net: this.#netCache,
      running: !!this.sock,
      startedAt: this.startedAt,
      connectedAt: this.connectedAt,
      logs: this.#logs.slice(-150)
    }
  }
}

/* ------------------------------------------------------------- utilidades */

async function inspectDir(dir) {
  const out = { path: dir, exists: false, files: 0, entries: [], totalBytes: 0, creds: null, credsError: null }
  if (!fs.existsSync(dir)) return out
  out.exists = true

  const walk = async (d, base = '') => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      const rel = base ? `${base}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(full, rel)
      else {
        const s = await stat(full).catch(() => null)
        out.files += 1
        out.totalBytes += s?.size || 0
        out.entries.push({ name: rel, size: s?.size || 0, mtime: s?.mtimeMs || 0 })
      }
    }
  }
  await walk(dir)
  out.entries.sort((a, b) => b.mtime - a.mtime)
  out.entries = out.entries.slice(0, 25)

  const credsPath = path.join(dir, 'creds.json')
  if (fs.existsSync(credsPath)) {
    try {
      const raw = JSON.parse(await readFile(credsPath, 'utf8'))
      out.creds = {
        registered: !!raw.registered,
        me: raw.me || null,
        noiseKey: !!raw.noiseKey,
        signedIdentityKey: !!raw.signedIdentityKey,
        advSecretKey: !!raw.advSecretKey,
        pairingCode: raw.pairingCode || null,
        firstUnuploadedPreKeyId: raw.firstUnuploadedPreKeyId ?? null,
        mtime: (await stat(credsPath).catch(() => null))?.mtimeMs || 0
      }
    } catch (e) {
      out.credsError = `creds.json ilegível/corrompido: ${e.message}`
    }
  }
  return out
}

async function findOtherSessionDirs(sessionDir, extraScopes = []) {
  const found = []
  const seen = new Set([path.resolve(sessionDir)])

  const consider = async (dir) => {
    const abs = path.resolve(dir)
    if (seen.has(abs)) return
    seen.add(abs)
    if (!fs.existsSync(abs)) return
    const credsPath = path.join(abs, 'creds.json')
    const hasCreds = fs.existsSync(credsPath)
    let entries = 0
    try {
      entries = (await readdir(abs)).length
    } catch {
      return
    }
    if (!hasCreds && entries < 3) return
    let registered = null
    if (hasCreds) {
      try {
        registered = !!JSON.parse(await readFile(credsPath, 'utf8')).registered
      } catch {
        registered = null
      }
    }
    found.push({ path: abs, files: entries, registered })
  }

  for (const name of KNOWN_SESSION_DIRS) await consider(path.join(ROOT, name))

  // varre 1 nível acima e 1 nível abaixo (muita gente guarda em ./sessions/<nome-do-bot>)
  for (const scope of [...new Set([ROOT, path.dirname(ROOT), path.dirname(sessionDir), ...extraScopes])]) {
    let entries = []
    try {
      entries = await readdir(scope, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (['node_modules', '.git', '.trash', 'public', 'src'].includes(e.name)) continue
      const abs = path.join(scope, e.name)
      if (fs.existsSync(path.join(abs, 'creds.json'))) await consider(abs)
    }
  }
  return found
}
