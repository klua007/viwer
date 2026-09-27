import fs from 'node:fs'
import path from 'node:path'
import express from 'express'

import { ROOT, config, KNOWN_LATEST_WA_VERSION, KNOWN_LATEST_WA_VERSION_INFO, parseVersion } from './config.mjs'
import { SessionManager, normalizePhone } from './session-manager.mjs'

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', etag: false }))

const manager = new SessionManager({
  sessionDir: process.env.SESSION_DIR ? path.resolve(process.env.SESSION_DIR) : config.sessionDir,
  phone: process.env.WA_PHONE || null
})

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  manager.log('error', `Falha na rota ${req.method} ${req.path}: ${err?.message || err}`)
  if (!res.headersSent) res.status(500).json({ ok: false, error: String(err?.message || err) })
})

app.get('/healthz', (_req, res) => res.json({ ok: true, status: manager.status }))

app.get('/api/state', (_req, res) => res.json({ ok: true, state: manager.toJSON() }))

app.get('/api/doctor', wrap(async (_req, res) => {
  const report = await manager.diagnose()
  res.json({ ok: true, report })
}))

app.post('/api/start', wrap(async (req, res) => {
  const wipe = Boolean(req.body?.wipe)
  const wipeStore = Boolean(req.body?.wipeStore)
  const phone = normalizePhone(req.body?.phone || '') || null
  if (req.body?.version !== undefined) manager.setVersion(req.body?.version)
  await manager.start({ wipe, phone, wipeStore })
  res.json({ ok: true, state: manager.toJSON() })
}))

app.post('/api/version', wrap(async (req, res) => {
  const raw = req.body?.version
  if (raw !== null && raw !== '' && !parseVersion(raw)) {
    return res.status(400).json({ ok: false, error: 'Formato inválido. Use algo como 2.3000.1048579041' })
  }
  const v = manager.setVersion(raw ?? null)
  res.json({ ok: true, version: v, state: manager.toJSON() })
}))

app.get('/api/version', (_req, res) => res.json({
  ok: true,
  current: manager.waVersion,
  override: manager.waVersionOverride,
  knownLatest: KNOWN_LATEST_WA_VERSION,
  knownLatestInfo: KNOWN_LATEST_WA_VERSION_INFO
}))

app.post('/api/stop', wrap(async (req, res) => {
  await manager.stop({ logout: Boolean(req.body?.logout) })
  res.json({ ok: true, state: manager.toJSON() })
}))

app.post('/api/wipe', wrap(async (req, res) => {
  const result = await manager.wipe({ purge: Boolean(req.body?.purge), wipeStore: Boolean(req.body?.wipeStore) })
  res.json({ ok: true, ...result, state: manager.toJSON() })
}))

app.post('/api/pair', wrap(async (req, res) => {
  const phone = normalizePhone(req.body?.phone || '')
  if (!phone || phone.length < 10) {
    return res.status(400).json({ ok: false, error: 'Informe o número com DDI+DDD, só dígitos. Ex.: 5519999999999' })
  }
  manager.pendingPhone = phone
  manager.pairingCode = null
  if (!manager.sock || manager.status === 'open') {
    await manager.start({ wipe: Boolean(req.body?.wipe), phone })
  } else {
    manager.log('info', `Código de pareamento será pedido para ${phone} na próxima janela de conexão.`)
  }
  res.json({ ok: true, state: manager.toJSON() })
}))

app.get('/api/download', wrap(async (_req, res) => {
  const buf = await manager.zip()
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Content-Disposition', `attachment; filename="session-${Date.now()}.zip"`)
  res.send(buf)
}))

app.get('/api/nettest', wrap(async (req, res) => {
  const net = await manager.netTest(req.query.force === '1')
  res.json({ ok: true, net })
}))

app.get('/api/trash', wrap(async (_req, res) => res.json({ ok: true, items: await manager.listTrash() })))
app.delete('/api/trash', wrap(async (_req, res) => res.json({ ok: true, ...(await manager.purgeTrash()) })))

// SPA fallback (express 5: não use '*')
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next()
  const index = path.join(ROOT, 'public', 'index.html')
  if (fs.existsSync(index)) return res.sendFile(index)
  next()
})

const server = app.listen(config.port, config.host, () => {
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`
  console.log('')
  console.log('┌──────────────────────────────────────────────────────────────┐')
  console.log('│  Session Doctor — WhatsApp (Baileys)                         │')
  console.log('└──────────────────────────────────────────────────────────────┘')
  console.log(`  lib          : @boruto_vk7/baileys ${manager.libVersion}`)
  console.log(`  node         : ${process.version}`)
  console.log(`  pasta sessão : ${manager.sessionDir}`)
  console.log(`  web          : ${url}`)
  console.log('')
  manager.log('info', 'Servidor de pé. Use os botões da página para apagar a sessão velha e gerar um QR novo.')
})

process.on('SIGINT', () => {
  manager.log('warn', 'Encerrando…')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000)
})
