/**
 * @file src/utils/git.js
 * @module utils/git
 *
 * Opções seguras para invoking git a partir do Viewer.
 *
 * Por que este módulo existe
 * --------------------------
 * `execFileSync('git', args, { stdio: 'pipe' })` pipeia apenas stdout e
 * stderr: o **stdin continua herdado do terminal**. Quando o repositório é
 * privado (ou o remoto exige credencial), o git abre um prompt interativo e
 * o processo fica bloqueado esperando digitação — o `./doctor.sh` parava no
 * meio do relatório com `Username for 'https://github.com':` na tela.
 *
 * Aqui o stdin é sempre `ignore` e o git é instruído a **nunca** abrir
 * prompt (`GIT_TERMINAL_PROMPT=0`), de modo que a falha volta
 * imediatamente como erro tratável em vez de travar o painel.
 */

/**
 * Variáveis de ambiente que desativam qualquer interação do git.
 *
 * - `GIT_TERMINAL_PROMPT=0` → git falha em vez de pedir usuário/senha.
 * - `GCM_INTERACTIVE=never` → mesma política no Git Credential Manager.
 * - `GIT_ASKPASS`/`SSH_ASKPASS` vazios → nenhum helper gráfico é aberto.
 *
 * @returns {NodeJS.ProcessEnv} Cópia do ambiente do processo com as travas.
 */
export function nonInteractiveEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  }
}

/**
 * Opções padrão para `execFileSync('git', ...)` sem risco de travar.
 * Valores passados pelo chamador têm precedência (inclusive `stdio`).
 *
 * @param {object} [overrides] Opções extras do `execFileSync`.
 * @returns {object} Opções mescladas.
 */
export function gitExecOptions(overrides = {}) {
  return {
    encoding: 'utf8',
    stdin: 'ignore',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: nonInteractiveEnv(),
    ...overrides,
  }
}

/**
 * Refspec explícito para `git fetch --depth 1 origin <refspec>`.
 *
 * Por que não apenas o nome da branch
 * -----------------------------------
 * `git fetch origin main` grava o resultado em `FETCH_HEAD`, mas **não
 * atualiza** `refs/remotes/origin/main` quando o repositório foi clonado com
 * um único refspec padrão (caso de `--depth 1`, muito comum em instalações
 * via `update.sh`). O leitor subsequente (`git show origin/main:...`,
 * `git diff HEAD origin/main`, `git reset --hard origin/main`) continuaria
 * enxergando o commit **anterior** — o update silenciaria justamente quando
 * houvesse novidade.
 *
 * @param {string} branch Nome da branch remota (ex.: `main`).
 * @returns {string} Refspec no formato `+refs/heads/X:refs/remotes/origin/X`.
 */
export function remoteBranchRefspec(branch) {
  return `+refs/heads/${branch}:refs/remotes/origin/${branch}`
}

/**
 * Inspeciona a falha de um comando git e diz se a causa é acesso/credencial.
 *
 * @param {unknown} error Erro capturado (tipicamente de `execFileSync`).
 * @returns {boolean} `true` quando parece falta de autenticação/permissão.
 */
export function isGitAuthError(error) {
  const text = [error?.stderr, error?.stdout, error?.message]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  if (!text) return false
  return [
    'authentication failed',
    'could not read username',
    'could not read password',
    'invalid username or password',
    'permission denied',
    'repository not found',
    '403',
    '401',
  ].some((marker) => text.includes(marker))
}
