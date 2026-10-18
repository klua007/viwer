import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Raiz do projeto */
export const ROOT = path.resolve(__dirname, '..')

/**
 * Nomes de pasta que os bots Baileys costumam usar para guardar as creds.
 * Usado pelo "doctor" para descobrir se você apagou a pasta ERRADA.
 */
export const KNOWN_SESSION_DIRS = [
  'session',
  'sessions',
  'auth',
  'auth_info',
  'auth_info_baileys',
  'baileys_auth',
  'baileys-auth',
  '.baileys',
  'creds',
  'whatsapp',
  'whatsapp-session',
  'store'
]

/** Arquivos que indicam "sobrou lixo de sessão antiga" */
export const LEFTOVER_FILES = ['store.json', 'baileys_store.json', 'session.json', 'creds.json']

/**
 * Versão do WhatsApp Web mais recente confirmada no upstream.
 * Fonte: branch `update-version/stable` do WhiskeySockets/Baileys
 *        (src/Defaults/baileys-version.json), commit de 2026-09-27.
 * O fork @boruto_vk7/baileys 1.0.28 ainda traz o fallback antigo
 * [2, 3000, 1043857760] (= master de 2026-08-04), então vale forçar esta aqui
 * quando o fetchLatestBaileysVersion() não consegue reaching o WhatsApp.
 */
export const KNOWN_LATEST_WA_VERSION = [2, 3000, 1048579041]
export const KNOWN_LATEST_WA_VERSION_INFO = {
  branch: 'WhiskeySockets/Baileys@update-version/stable',
  file: 'src/Defaults/baileys-version.json',
  checkedAt: '2026-09-27',
  forkFallback: [2, 3000, 1043857760]
}

/** '2.3000.1048579041' -> [2, 3000, 1048579041] */
export function parseVersion(input) {
  if (Array.isArray(input)) return input.map(Number)
  if (!input) return null
  const parts = String(input).trim().split(/[.,\s-]+/).filter(Boolean).map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null
  return parts
}

export const config = {
  /** Pasta de auth (useMultiFileAuthState). Sobrescreva com SESSION_DIR=/caminho/da/sua/sessao */
  sessionDir: path.resolve(process.env.SESSION_DIR || path.join(ROOT, 'session')),
  /** Lixeira interna: em vez de apagar, movemos a sessão velha para cá (recuperação de emergência) */
  trashDir: path.resolve(process.env.TRASH_DIR || path.join(ROOT, '.trash')),
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  browserName: process.env.BROWSER_NAME || 'Session Doctor',
  /** Tempo de vida de cada QR (o Baileys renova sozinho) */
  qrTimeout: Number(process.env.QR_TIMEOUT || 45_000),
  /** Ao tomar 401 (loggedOut) apaga as creds e volta pro QR sozinho? */
  autoWipeOnLogout: process.env.AUTO_WIPE_ON_LOGOUT !== 'false',
  /** Limite de tentativas de reconexão automática */
  maxReconnectAttempts: Number(process.env.MAX_RECONNECT || 15),
  /** Log do Baileys: silent | info | debug */
  logLevel: process.env.BAILEYS_LOG || 'silent',
  /** Força a versão do WhatsApp Web (ex.: WA_VERSION=2.3000.1048579041). Vazio = fetchLatestBaileysVersion() */
  waVersion: parseVersion(process.env.WA_VERSION)
}

export const STATUS_LABEL = {
  idle: 'Parado',
  starting: 'Iniciando…',
  connecting: 'Conectando…',
  qr: 'Aguardando você escanear o QR',
  pairing: 'Aguardando o código de pareamento',
  open: 'Conectado ✅',
  closed: 'Conexão fechada',
  loggedOut: 'Sessão inválida (401) — precisa recriar',
  error: 'Erro / limite de tentativas'
}

/**
 * Códigos de desconexão do Baileys traduzidos para gente + o que fazer.
 */
export const DISCONNECT_HELP = {
  401: {
    label: 'loggedOut (401) — a sessão foi deslogada',
    hint: 'Você removeu o dispositivo no celular (ou as creds corromperam). O Baileys NÃO descobre isso sozinho: ele continua tentando "puxar" a sessão antiga. Solução: apagar a pasta de auth e parear de novo.',
    action: 'wipe-and-repair'
  },
  408: {
    label: 'timedOut / connectionLost (408)',
    hint: 'Timeout de conexão ou QR expirado. Normalmente resolve reconectando; se repetir muito, cheque internet/proxy.',
    action: 'reconnect'
  },
  411: {
    label: 'multideviceMismatch (411)',
    hint: 'A versão do WhatsApp Web usada pela lib ficou incompatível. Atualize a lib (npm i @boruto_vk7/baileys@latest) e use fetchLatestBaileysVersion().',
    action: 'reconnect'
  },
  428: {
    label: 'connectionClosed (428)',
    hint: 'O servidor fechou o websocket. Reconectar resolve na maioria das vezes.',
    action: 'reconnect'
  },
  440: {
    label: 'connectionReplaced (440)',
    hint: 'Outro processo abriu a MESMA sessão. Só UM processo pode usar uma sessão por vez — mate o processo duplicado (pm2 list, ps aux | grep node).',
    action: 'stop'
  },
  500: {
    label: 'badSession (500)',
    hint: 'Sessão corrompida. Apague a pasta de auth e pareie novamente.',
    action: 'wipe-and-repair'
  },
  515: {
    label: 'restartRequired (515)',
    hint: 'O WhatsApp pediu restart. Reconectar em seguida é o comportamento correto.',
    action: 'reconnect'
  }
}
