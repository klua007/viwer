/**
 * @file test/connection.test.js
 * Normalização do número de telefone para o Pairing Code: o servidor do
 * WhatsApp vincula o código ao número EXATO, então a normalização precisa
 * ser determinística e recusar formatos ambíguos.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePhoneNumber,
  normalizeBrPhoneNumber,
  formatPhoneForDisplay,
  nextRateLimitCooldownMs,
} from '../src/connection/Connection.js'

test('número completo com DDI passa sem ajustes', () => {
  const { digits, notes } = normalizePhoneNumber('5519912345678')
  assert.equal(digits, '5519912345678')
  assert.equal(notes.length, 0)
})

test('aceita formatação com máscara e espaços', () => {
  const { digits } = normalizePhoneNumber('+55 (19) 91234-5678')
  assert.equal(digits, '5519912345678')
})

test('número local (sem DDI) recebe 55 automaticamente', () => {
  const { digits, notes } = normalizePhoneNumber('19912345678')
  assert.equal(digits, '5519912345678')
  assert.ok(notes.some((n) => n.includes('55')))
})

test('prefixo de tronco 0 é removido', () => {
  const { digits } = normalizePhoneNumber('019912345678')
  assert.equal(digits, '5519912345678')
})

test('número fixo (10 dígitos locais) é aceito com aviso', () => {
  const { digits, notes } = normalizePhoneNumber('551934567890')
  assert.equal(digits, '551934567890')
  assert.ok(notes.some((n) => n.includes('fixo')))
})

// ── Pareamento internacional ────────────────────────────────────────────────
// Regression do bug que recusava "+57 350 4660693" com "use o DDI 55": o
// pareamento era exclusivo do Brasil, embora o Baileys aceite qualquer país.

test('número da Colômbia (+57) é aceito — caso real que motivou o fix', () => {
  const { digits, notes } = normalizePhoneNumber('+57 350 4660693')
  assert.equal(digits, '573504660693')
  assert.ok(notes.some((n) => n.includes('fora do Brasil')))
})

test('DDI de 1 dígito (EUA/Canadá) é aceito quando vem com +', () => {
  const { digits, notes } = normalizePhoneNumber('+1 (415) 555-2671')
  assert.equal(digits, '14155552671')
  assert.ok(notes.some((n) => n.includes('fora do Brasil')))
})

test('o + impede que a heurística brasileira reescreva um número estrangeiro', () => {
  // Sem esta regra, "+1 (415) 555-2671" (11 dígitos) seria lido como local BR
  // e viraria 5514155552671 — um número brasileiro inventado.
  assert.equal(normalizePhoneNumber('+14155552671').digits, '14155552671')
})

test('sem +, a hipótese Brasil é testada e abandonada se não se sustenta', () => {
  // 11 dígitos sem "+" dispara a heurística BR; como 14155552671 não é um
  // celular brasileiro válido (não começa em 9 após o DDD), cai para
  // internacional em vez de ser recusado com uma regra que não é do país.
  const { digits, notes } = normalizePhoneNumber('14155552671')
  assert.equal(digits, '14155552671')
  assert.ok(notes.some((n) => n.includes('internacional')))
})

test('a heurística Brasil continua valendo para número local BR sem +', () => {
  assert.equal(normalizePhoneNumber('19912345678').digits, '5519912345678')
  assert.equal(normalizePhoneNumber('1934567890').digits, '551934567890') // fixo, 10 dígitos
})

test('DDI de 3 dígitos é aceito', () => {
  const { digits } = normalizePhoneNumber('+234 802 123 4567')
  assert.equal(digits, '2348021234567')
})

test('regras brasileiras NÃO são aplicadas a número estrangeiro', () => {
  // Um colombiano "3" após o DDI reprovaria na regra BR de nono dígito;
  // não existe nono dígito fora do Brasil.
  const { digits } = normalizePhoneNumber('573504660693')
  assert.equal(digits, '573504660693')
})

test('número estrangeiro curto demais é recusado com motivo claro', () => {
  const { digits, notes } = normalizePhoneNumber('+57 350')
  assert.equal(digits, null)
  assert.ok(notes.some((n) => n.includes('comprimento inválido')))
})

test('acima do teto E.164 (15 dígitos) é recusado', () => {
  assert.equal(normalizePhoneNumber('5735046606931234').digits, null)
})

test('entradas inválidas continuam recusadas', () => {
  assert.equal(normalizePhoneNumber('551991234567').digits, null) // BR: celular sem o nono dígito
  assert.equal(normalizePhoneNumber('5519345678901').digits, null) // BR: 11 nacionais sem começar em 9
  assert.equal(normalizePhoneNumber('+55199123456').digits, null) // BR explícito, curto
  assert.equal(normalizePhoneNumber('').digits, null)
  assert.equal(normalizePhoneNumber(null).digits, null)
  assert.equal(normalizePhoneNumber('0000').digits, null) // só zeros
  assert.equal(normalizePhoneNumber('abcdef').digits, null) // sem dígitos
})

test('9 dígitos sem + não são número local BR: passam como internacional', () => {
  // A heurística BR só se aplica a 10–11 dígitos. Com 9, não há hipótese
  // brasileira a testar e o comprimento ainda é E.164 plausível.
  const { digits, notes } = normalizePhoneNumber('123456789')
  assert.equal(digits, '123456789')
  assert.ok(notes.some((n) => n.includes('fora do Brasil')))
})

test('11 dígitos sem + que não são BR válidos caem para internacional', () => {
  // O teste antigo rotulava "34612345678" como "DDI estrangeiro" e esperava
  // recusa, mas o código prepunha 55 e a recusa vinha das regras BR (34 +
  // 612345678 não começa em 9) — ou seja, o comentário descrevia uma recusa
  // que não acontecia pelo motivo alegado. Agora o motivo é explícito.
  const { digits, notes } = normalizePhoneNumber('34612345678')
  assert.equal(digits, '34612345678')
  assert.ok(notes.some((n) => n.includes('internacional')))
})

test('normalizeBrPhoneNumber segue exportado como alias compatível', () => {
  assert.equal(normalizeBrPhoneNumber, normalizePhoneNumber)
  assert.equal(normalizeBrPhoneNumber('+57 350 4660693').digits, '573504660693')
})

// ── Exibição na etapa de confirmação ────────────────────────────────────────
// O número formatado é o que o usuário confirma ANTES de criar o socket.
// Aplicar a máscara BR a um estrangeiro exibiria um número que não existe.

test('brasileiro mantém a máscara +55 (DD) XXXXX-XXXX', () => {
  assert.equal(formatPhoneForDisplay('5519912345678'), '+55 (19) 91234-5678')
  assert.equal(formatPhoneForDisplay('551934567890'), '+55 (19) 3456-7890')
})

test('estrangeiro NÃO recebe máscara brasileira (regression da confirmação)', () => {
  const pretty = formatPhoneForDisplay('573504660693')
  assert.equal(pretty, '+573504660693')
  assert.ok(!pretty.includes('('), 'não deve inventar DDD entre parênteses')
  assert.notEqual(pretty, '+57 (35) 0466-0693') // o que o código antigo exibia
})

test('estrangeiro não é agrupado de forma a engolir o DDI', () => {
  // Agrupar da esquerda produziria "+573 504 660 693" (DDI 573 inexistente);
  // da direita, "+57 3504 6606 93". Ambos afirmam fronteira não verificável,
  // então os dígitos são exibidos intactos.
  const pretty = formatPhoneForDisplay('14155552671')
  assert.equal(pretty, '+14155552671')
  assert.ok(!/\s/.test(pretty), 'nenhum espaço: nada de fronteira inventada')
})

test('a exibição preserva todos os dígitos normalizados', () => {
  for (const raw of ['+57 350 4660693', '+1 (415) 555-2671', '+55 (19) 91234-5678']) {
    const { digits } = normalizePhoneNumber(raw)
    assert.equal(formatPhoneForDisplay(digits).replace(/\D/g, ''), digits)
  }
})

test('cooldown do limite de tentativas escala até o teto de 1h', () => {
  const first = nextRateLimitCooldownMs(0)
  assert.equal(first, 5 * 60 * 1000)
  assert.equal(nextRateLimitCooldownMs(first), 15 * 60 * 1000)
  assert.equal(nextRateLimitCooldownMs(15 * 60 * 1000), 45 * 60 * 1000)
  assert.equal(nextRateLimitCooldownMs(45 * 60 * 1000), 60 * 60 * 1000)
  assert.equal(nextRateLimitCooldownMs(60 * 60 * 1000), 60 * 60 * 1000)
})
