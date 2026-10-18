#!/usr/bin/env node
/**
 * @file scripts/check-config.js
 *
 * Lista nominalmente as chaves do `viewer.config.json` que estão ausentes ou
 * com tipo divergente do padrão.
 *
 * Por que existe
 * --------------
 * O `./doctor.sh` resume o problema em uma contagem ("1 chave(s)
 * ausente(s)/inválida(s)"), que não basta para agir. Este script reusa a
 * MESMA validação da configuração ({@link module:config}.mergeConfig) e
 * imprime o caminho pontuado de cada chave, o motivo e o valor que o Viewer
 * vai usar no lugar — sem alterar nenhum arquivo.
 *
 * Uso:
 *   node scripts/check-config.js
 *   node scripts/check-config.js --json
 */

import fs from 'node:fs'
import path from 'node:path'
import { ROOT_DIR, APP_NAME } from '../src/constants.js'
import { defaults, CONFIG_FILE_NAME, CONFIG_SAMPLE_NAME } from '../src/config/defaults.js'
import { mergeConfig, normalizeLegacyValues } from '../src/config/Config.js'

const asJson = process.argv.includes('--json')
const file = path.join(ROOT_DIR, CONFIG_FILE_NAME)

/**
 * Resolve o valor que o Viewer efetivamente usaria para uma chave.
 * @param {string} keyPath Caminho pontuado (ex.: `cache.maxEntries`).
 * @returns {unknown} Valor final (padrão ou o do usuário).
 */
function valueAt(keyPath) {
  return keyPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), defaults)
}

if (!fs.existsSync(file)) {
  if (asJson) {
    process.stdout.write(
      JSON.stringify({ file: CONFIG_FILE_NAME, exists: false, issues: [] }, null, 2) + '\n'
    )
  } else {
    process.stdout.write(
      `\n[${APP_NAME}] ${CONFIG_FILE_NAME} não existe ainda.\n` +
        `Ele é criado automaticamente no primeiro \`npm start\`, a partir de ${CONFIG_SAMPLE_NAME}.\n\n`
    )
  }
  process.exit(0)
}

let user
try {
  user = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch (error) {
  process.stdout.write(`\n[${APP_NAME}] ${CONFIG_FILE_NAME} é um JSON inválido: ${error.message}\n`)
  process.stdout.write('Corrija o arquivo (ou remova-o para recriar a partir do modelo).\n\n')
  process.exit(1)
}

/** @type {{key: string, reason: string, willUse: unknown}[]} */
const issues = []
const merged = mergeConfig(defaults, user, (keyPath, reason) => {
  issues.push({ key: keyPath, reason, willUse: valueAt(keyPath) })
})

/** Valores obsoletos que a validação de tipo não captura. */
const legacy = []
normalizeLegacyValues(JSON.parse(JSON.stringify(merged)), (message) => legacy.push(message))

if (asJson) {
  process.stdout.write(
    JSON.stringify({ file: CONFIG_FILE_NAME, exists: true, issues, legacy }, null, 2) + '\n'
  )
  process.exit(issues.length || legacy.length ? 1 : 0)
}

process.stdout.write(`\n[${APP_NAME}] ${CONFIG_FILE_NAME}\n`)
process.stdout.write('─'.repeat(46) + '\n')

if (!issues.length && !legacy.length) {
  process.stdout.write('✔ configuração consistente — nenhuma chave ausente ou inválida\n\n')
  process.exit(0)
}

for (const issue of issues) {
  process.stdout.write(`  ⚠ ${issue.key}\n`)
  process.stdout.write(`      motivo : ${issue.reason}\n`)
  process.stdout.write(`      em uso : ${JSON.stringify(issue.willUse)} (padrão)\n`)
}

for (const message of legacy) {
  process.stdout.write(`  ⚠ valor obsoleto normalizado em tempo de execução\n`)
  process.stdout.write(`      ${message}\n`)
}

process.stdout.write(
  `\n${issues.length + legacy.length} ocorrência(s). O Viewer funciona assim mesmo (usa os padrões),\n` +
    `mas convém editar ${CONFIG_FILE_NAME} — modelo de referência: ${CONFIG_SAMPLE_NAME}.\n\n`
)
process.exit(1)
