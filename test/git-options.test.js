/**
 * @file test/git-options.test.js
 *
 * Regressão do travamento do `./doctor.sh`: comandos git criados com
 * `stdio: 'pipe'` herdavam o stdin do terminal e, em repositório privado,
 * o git abria `Username for 'https://github.com':` — o relatório parava no
 * meio esperando digitação.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  gitExecOptions,
  isGitAuthError,
  nonInteractiveEnv,
  remoteBranchRefspec,
} from '../src/utils/git.js'

test('gitExecOptions nunca herda o stdin do terminal', () => {
  const opts = gitExecOptions({ cwd: '/tmp' })
  assert.equal(opts.stdin, 'ignore')
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(opts.cwd, '/tmp')
})

test('gitExecOptions desativa prompt de credencial no ambiente', () => {
  const { env } = gitExecOptions()
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GCM_INTERACTIVE, 'never')
  assert.equal(env.GIT_ASKPASS, '')
  assert.equal(env.SSH_ASKPASS, '')
})

test('nonInteractiveEnv preserva o ambiente do processo', () => {
  const before = process.env.PATH
  const env = nonInteractiveEnv()
  assert.equal(env.PATH, before)
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
})

test('gitExecOptions permite sobrescrever opções (precedência do chamador)', () => {
  const opts = gitExecOptions({ timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] })
  assert.equal(opts.timeout, 10000)
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'ignore'])
  // A trava de stdin permanece mesmo com stdio customizado.
  assert.equal(opts.stdin, 'ignore')
})

test('isGitAuthError identifica falha de credencial/permissão', () => {
  assert.equal(
    isGitAuthError({ stderr: 'fatal: Authentication failed for https://github.com/' }),
    true
  )
  assert.equal(
    isGitAuthError({ stderr: 'error: could not read Username: terminal prompts disabled' }),
    true
  )
  assert.equal(isGitAuthError({ message: 'remote: Repository not found.' }), true)
  assert.equal(
    isGitAuthError({ stderr: 'ssh: connect to host github.com port 22: Network is unreachable' }),
    false
  )
})

test('isGitAuthError tolera erro vazio/inesperado', () => {
  assert.equal(isGitAuthError(undefined), false)
  assert.equal(isGitAuthError({}), false)
  assert.equal(isGitAuthError(new Error('boom')), false)
})

test('remoteBranchRefspec atualiza o ref de rastreamento (não só FETCH_HEAD)', () => {
  // `git fetch origin main` grava apenas FETCH_HEAD em clones com refspec
  // único; o leitor seguinte (git show/diff/reset origin/main) veria revisão
  // obsoleta e o update silenciaria mesmo havendo versão nova.
  assert.equal(remoteBranchRefspec('main'), '+refs/heads/main:refs/remotes/origin/main')
  assert.equal(remoteBranchRefspec('beta'), '+refs/heads/beta:refs/remotes/origin/beta')
})
