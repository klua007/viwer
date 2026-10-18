#!/usr/bin/env node
/**
 * CLI do Session Doctor.
 *
 *   npm run doctor                       → diagnostica a pasta de sessão
 *   npm run doctor -- --dir ./sessions   → diagnostica outra pasta
 *   npm run reset                        → apaga (move pra .trash) e deixa pronto pro QR
 *   npm run reset  -- --purge --store    → apaga de vez + remove store.json da raiz
 *   npm run pair   -- --phone 5519999999999   → recria a sessão e mostra QR/código no terminal
 */
import path from 'node:path'
import process from 'node:process'

import { config, STATUS_LABEL } from './config.mjs'
import { SessionManager, normalizePhone } from './session-manager.mjs'

const argv = process.argv.slice(3)
const command = process.argv[2] || 'doctor'

function flag(name, fallback = true) {
  const on = argv.includes(`--${name}`)
  const off = argv.includes(`--no-${name}`)
  if (on) return true
  if (off) return false
  return fallback
}

function value(name) {
  const i = argv.indexOf(`--${name}`)
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  const inline = argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.split('=')[1] : undefined
}

const sessionDir = path.resolve(value('dir') || process.env.SESSION_DIR || config.sessionDir)
const manager = new SessionManager({ sessionDir, logLevel: value('log') || 'silent' })

const HELP = `
Session Doctor — WhatsApp (Baileys)

Uso:
  npm run doctor  [-- --dir <pasta>]                 Diagnóstico completo da sessão
  npm run reset   [-- --dir <pasta> --purge --store]  Apaga a sessão velha com segurança
  npm run pair    [-- --phone 55DDDNÚMERO --dir <pasta> --no-wipe]
                                                      Recria a sessão e mostra o QR no terminal
  npm start                                           Painel web (QR no navegador)

Flags:
  --dir <pasta>   pasta usada no useMultiFileAuthState (padrão: ${sessionDir})
  --purge         apaga definitivamente em vez de mover para .trash/
  --store         remove também store.json/session.json da raiz do projeto
  --phone <num>   pede código de pareamento em vez de QR (só dígitos, com DDI)
  --no-wipe       NÃO apaga antes de conectar (só reconecta)
`

async function runDoctor() {
  const report = await manager.diagnose()
  const line = '─'.repeat(70)
  console.log(line)
  console.log('DIAGNÓSTICO DA SESSÃO')
  console.log(line)
  console.log(`lib            : @boruto_vk7/baileys ${report.lib}`)
  console.log(`node           : ${report.node}`)
  console.log(`pasta analisada: ${report.sessionDir}`)
  console.log(`existe?        : ${report.dir.exists ? `sim (${report.dir.files} arquivos, ${(report.dir.totalBytes / 1024).toFixed(1)} KB)` : 'não'}`)
  if (report.dir.creds) {
    const c = report.dir.creds
    console.log(`creds.registered: ${c.registered}`)
    console.log(`conta gravada   : ${c.me?.id || '—'} (${c.me?.name || 'sem nome'})`)
    console.log(`última gravação : ${new Date(c.mtime).toLocaleString('pt-BR')}`)
  }
  if (report.dir.credsError) console.log(`ERRO nas creds  : ${report.dir.credsError}`)

  console.log(line)
  if (!report.problems.length) console.log('Nada suspeito encontrado.')
  for (const p of report.problems) {
    const icon = p.severity === 'error' ? '✖' : p.severity === 'warn' ? '⚠' : p.severity === 'ok' ? '✔' : 'ℹ'
    console.log(`${icon} ${p.title}`)
    console.log(`   ${p.detail}`)
    console.log(`   ➜ ${p.fix}`)
    console.log('')
  }
  if (report.others.length) {
    console.log(line)
    console.log('Outras pastas com cara de sessão:')
    for (const o of report.others) console.log(`  • ${o.path} (${o.files} itens, registered=${o.registered})`)
  }
  console.log(line)
}

async function runReset() {
  const purge = flag('purge', false)
  const wipeStore = flag('store', false)
  console.log(`Apagando sessão em: ${manager.sessionDir}${purge ? ' (definitivo)' : ' (vai para .trash/)'}\n`)
  const res = await manager.wipe({ purge, wipeStore })
  console.log('\nPronto. Próximo passo:')
  console.log('  • Terminal : npm run pair -- --phone SEUNUMERO   (ou npm start e escaneie o QR no navegador)')
  console.log('  • Seu bot  : reinicie o processo; com a pasta limpa ele vai imprimir o QR em vez de reusar a sessão morta.')
  return res
}

async function runPair() {
  const phone = normalizePhone(value('phone') || process.env.WA_PHONE || '')
  const wipe = flag('wipe', true)
  manager.pendingPhone = phone || null
  console.log('')
  console.log(`Pasta de sessão : ${manager.sessionDir}`)
  console.log(`Modo            : ${phone ? `código de pareamento (${phone})` : 'QR Code no terminal'}`)
  console.log(`Apagar antes?   : ${wipe ? 'sim' : 'não'}`)
  console.log('')

  manager.on('log', () => {}) // logs já saem no console
  await manager.start({ wipe, phone: phone || null })

  const done = new Promise((resolve) => {
    const check = setInterval(() => {
      const s = manager.status
      if (s === 'open') {
        clearInterval(check)
        resolve('open')
      } else if (s === 'error') {
        clearInterval(check)
        resolve('error')
      }
    }, 500)
    setTimeout(() => {
      clearInterval(check)
      resolve('timeout')
    }, 5 * 60 * 1000)
  })

  const result = await done
  if (result === 'open') {
    console.log('\n✅ SESSÃO RECRIADA!')
    console.log(`   Conta: ${manager.me?.id || '—'}`)
    console.log(`   Creds: ${manager.sessionDir}`)
    console.log('   Agora é só reiniciar o seu bot apontando para essa mesma pasta.\n')
    await manager.stop()
    process.exit(0)
  }
  if (result === 'error') {
    console.log('\n✖ Não consegui concluir. Rode: npm run doctor\n')
    process.exit(1)
  }
  console.log('\n⏱  Tempo esgotado (5 min). Rode de novo e escaneie/ digite o código mais rápido.\n')
  await manager.stop()
  process.exit(2)
}

switch (command) {
  case 'doctor':
    await runDoctor()
    break
  case 'reset':
    await runReset()
    break
  case 'pair':
    await runPair()
    break
  case 'help':
  case '--help':
  case '-h':
    console.log(HELP)
    break
  default:
    console.log(`Comando desconhecido: ${command}`)
    console.log(HELP)
    process.exitCode = 1
}

console.log(`(status atual: ${STATUS_LABEL[manager.status] || manager.status})`)
