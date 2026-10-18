#!/usr/bin/env node
/**
 * @file scripts/fix-config.js
 *
 * Atualiza o `viewer.config.json` para o esquema atual SEM descartar as
 * escolhas do usuário.
 *
 * Por que existe
 * --------------
 * O arquivo de configuração é criado uma única vez, a partir do modelo da
 * versão instalada na época. Quando uma versão seguinte acrescenta chaves
 * (ex.: `features.recoverChannelsAuto`, adicionada depois do primeiro
 * release), o arquivo do usuário fica para trás e o `./doctor.sh` passa a
 * reportar "N chave(s) ausente(s)/inválida(s)" em todo diagnóstico — ainda
 * que o Viewer funcione normalmente usando os padrões.
 *
 * Este script é o complemento de {@link scripts/check-config.js}: aplica o
 * que ele lista. Faz backup, adiciona as chaves faltantes com o valor
 * padrão, normaliza valores obsoletos e preserva tudo o que o usuário
 * escolheu (número de pareamento, limites, caminhos, etc.).
 *
 * Uso:
 *   node scripts/fix-config.js             # aplica, com backup
 *   node scripts/fix-config.js --dry-run   # mostra o que faria, não grava
 */

import fs from 'node:fs'
import path from 'node:path'
import { ROOT_DIR, APP_NAME } from '../src/constants.js'
import {
  defaults,
  CONFIG_FILE_NAME,
  CONFIG_SAMPLE_NAME,
  LEGACY_REPO_OWNERS,
} from '../src/config/defaults.js'
import { mergeConfig } from '../src/config/Config.js'
import { atomicWrite } from '../src/utils/fs.js'

const dryRun = process.argv.includes('--dry-run')
const file = path.join(ROOT_DIR, CONFIG_FILE_NAME)

/**
 * Acrescenta recursivamente as chaves dos padrões que faltam no objeto do
 * usuário. Valores já presentes são preservados intactos — inclusive tipos
 * divergentes, que são relatados mas não sobrescritos (o script não decide
 * preferência do usuário por ele).
 *
 * @param {object} base Padrões.
 * @param {object} target Objeto do usuário (mutado).
 * @param {string} prefix Caminho atual, para os relatos.
 * @param {string[]} added Acumulador de chaves adicionadas.
 * @returns {object} O mesmo objeto, preenchido.
 */
function fillMissing(base, target, prefix, added) {
  for (const [key, defaultValue] of Object.entries(base)) {
    const fullPath = prefix ? `${prefix}.${key}` : key
    const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

    if (target[key] === undefined) {
      target[key] = JSON.parse(JSON.stringify(defaultValue))
      added.push(`${fullPath} = ${JSON.stringify(target[key])}`)
      continue
    }

    if (isPlainObject(defaultValue) && isPlainObject(target[key])) {
      fillMissing(defaultValue, target[key], fullPath, added)
    }
  }
  return target
}

if (!fs.existsSync(file)) {
  process.stdout.write(
    `\n[${APP_NAME}] ${CONFIG_FILE_NAME} não existe ainda — nada a corrigir.\n` +
      `Ele é criado automaticamente no primeiro \`npm start\`, a partir de ${CONFIG_SAMPLE_NAME}.\n\n`
  )
  process.exit(0)
}

let user
try {
  user = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch (error) {
  process.stdout.write(
    `\n[${APP_NAME}] ${CONFIG_FILE_NAME} é um JSON inválido: ${error.message}\n` +
      'Corrija o arquivo à mão (ou remova-o para recriar a partir do modelo).\n' +
      'Nada foi gravado.\n\n'
  )
  process.exit(1)
}

if (typeof user !== 'object' || user === null || Array.isArray(user)) {
  process.stdout.write(
    `\n[${APP_NAME}] ${CONFIG_FILE_NAME} não contém um objeto JSON. Nada foi gravado.\n\n`
  )
  process.exit(1)
}

/** 1) diagnóstico do estado atual (mesma validação do doctor/check-config). */
const before = []
mergeConfig(defaults, user, (keyPath, reason) => before.push(`${keyPath}: ${reason}`))

/** 2) preenche chaves ausentes. */
const added = []
fillMissing(defaults, user, '', added)

/** 3) normaliza valores obsoletos no arquivo (não só em tempo de execução). */
const legacyFixed = []
if (typeof user.update?.repoOwner === 'string' && LEGACY_REPO_OWNERS.has(user.update.repoOwner)) {
  legacyFixed.push(`update.repoOwner: "${user.update.repoOwner}" → "${defaults.update.repoOwner}"`)
  user.update.repoOwner = defaults.update.repoOwner
}

/** 4) tipos divergentes permanecem (são escolha do usuário): só relatamos. */
const stillInvalid = []
mergeConfig(defaults, user, (keyPath, reason) => {
  if (!reason.startsWith('ausente')) stillInvalid.push(`${keyPath}: ${reason}`)
})

process.stdout.write(
  `\n[${APP_NAME}] ${dryRun ? 'PRÉVIA — ' : ''}correção de ${CONFIG_FILE_NAME}\n`
)
process.stdout.write('─'.repeat(46) + '\n')

if (!added.length && !legacyFixed.length) {
  process.stdout.write('✔ nada a corrigir — o arquivo já está no esquema atual\n')
  if (stillInvalid.length) {
    process.stdout.write(
      `\nAinda assim, ${stillInvalid.length} valor(es) com tipo divergente (preservados):\n`
    )
    for (const item of stillInvalid) process.stdout.write(`  ⚠ ${item}\n`)
  }
  process.stdout.write('\n')
  process.exit(0)
}

if (before.length) {
  process.stdout.write(`\nAntes: ${before.length} ocorrência(s) detectada(s)\n`)
}

if (added.length) {
  process.stdout.write(`\nChaves adicionadas (${added.length}):\n`)
  for (const item of added) process.stdout.write(`  + ${item}\n`)
}

if (legacyFixed.length) {
  process.stdout.write(`\nValores obsoletos atualizados (${legacyFixed.length}):\n`)
  for (const item of legacyFixed) process.stdout.write(`  ~ ${item}\n`)
}

if (stillInvalid.length) {
  process.stdout.write(`\nTipos divergentes PRESERVADOS (${stillInvalid.length}) — decida você:\n`)
  for (const item of stillInvalid) process.stdout.write(`  ⚠ ${item}\n`)
}

if (dryRun) {
  process.stdout.write('\n[dry-run] Nenhum arquivo foi gravado.\n\n')
  process.exit(0)
}

try {
  const backup = `${file}.bak`
  fs.copyFileSync(file, backup)
  await atomicWrite(file, JSON.stringify(user, null, 2) + '\n')
  process.stdout.write(`\n✔ ${CONFIG_FILE_NAME} atualizado (backup: ${path.basename(backup)})\n`)
  process.stdout.write('Rode `npm run config:check` para confirmar.\n\n')
} catch (error) {
  process.stdout.write(`\n✖ falha ao gravar: ${error.message}\n\n`)
  process.exit(1)
}
