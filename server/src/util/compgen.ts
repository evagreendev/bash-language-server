/**
 * Shell-native completion utilities using bash's compgen.
 *
 * Provides file-path completions via filesystem traversal and
 * compgen-based command/option completions via bash subprocess.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Get file and directory completions for a partial path.
 * Supports ~, relative, and absolute paths.
 */
export function getFileCompletions(partial: string, cwd: string): string[] {
  // Expand tilde
  let expanded = partial
  if (expanded.startsWith('~')) {
    const home = process.env.HOME || '/root'
    expanded = path.join(home, expanded.slice(1))
  }

  const dir = path.isAbsolute(expanded)
    ? path.dirname(expanded)
    : path.dirname(path.join(cwd, expanded))

  const base = path.basename(expanded)

  // If the partial ends with /, list inside that directory
  const searchDir = partial.endsWith('/')
    ? (path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded))
    : dir

  const prefix = partial.endsWith('/') ? '' : base

  try {
    const entries = fs.readdirSync(searchDir, { withFileTypes: true })
    const completions: string[] = []

    for (const entry of entries) {
      if (entry.name.startsWith('.') && !prefix.startsWith('.')) continue
      if (prefix && !entry.name.startsWith(prefix)) continue

      const suffix = entry.isDirectory() ? '/' : ''
      completions.push(entry.name + suffix)
    }

    // Reconstruct the full path for the label
    if (partial.endsWith('/')) {
      return completions
    }

    // For partial paths, we need to return the suffix to append
    // The LSP completion will replace based on the word prefix
    return completions
  } catch {
    return []
  }
}

/**
 * Get completions using bash's compgen builtin.
 * Types: command, file, directory, function, variable, alias, builtin, keyword
 */
export function getCompgenCompletions(
  type: string,
  prefix: string,
): string[] {
  try {
    const result = spawnSync(
      'bash',
      ['-c', `compgen -A ${type} -- '${prefix.replace(/'/g, "'\\''")}'`],
      { timeout: 2000, encoding: 'utf-8', maxBuffer: 1024 * 1024 },
    )

    if (result.status !== 0) return []

    return result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
  } catch {
    return []
  }
}

/**
 * Get completions from a command's registered bash completion function.
 * This calls `complete -p <cmd>` to find the completion function, then
 * sets up the COMP_LINE/COMP_WORDS environment and invokes it.
 */
export function getCommandSpecificCompletions(
  commandName: string,
  partial: string,
  cwd: string,
): string[] {
  try {
    // Use a script that invokes bash's programmable completion
    const script = `
# Find the completion function for this command
complete_func=$(complete -p '${commandName}' 2>/dev/null | sed -n 's/.*-F \\([^ ]*\\).*/\\1/p')
if [[ -z "$complete_func" ]]; then
  # Try loading completion dynamically
  if declare -f _completion_loader &>/dev/null; then
    _completion_loader '${commandName}' 2>/dev/null
    complete_func=$(complete -p '${commandName}' 2>/dev/null | sed -n 's/.*-F \\([^ ]*\\).*/\\1/p')
  fi
fi
if [[ -z "$complete_func" ]]; then
  exit 0
fi

# Set up the completion environment
COMP_LINE='${commandName} ${partial}'
COMP_WORDS=(${commandName} ${partial})
COMP_CWORD=1
COMP_POINT=\${#COMP_LINE}

# Invoke the completion function
$complete_func '${commandName}' '${partial}' '${partial}'

# Output results
printf '%s\\n' "\${COMPREPLY[@]}"
`

    const result = spawnSync('bash', ['-c', script], {
      timeout: 3000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
      env: { ...process.env, HOME: process.env.HOME || '/root' },
    })

    if (result.status !== 0) return []

    return result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
  } catch {
    return []
  }
}

/**
 * Determine if a word looks like it's a file path argument.
 */
export function isFilePathContext(word: string): boolean {
  if (!word) return false
  return (
    word.startsWith('./') ||
    word.startsWith('../') ||
    word.startsWith('/') ||
    word.startsWith('~/') ||
    word.includes('/')
  )
}

/**
 * Try to resolve a path string by expanding $VAR and ${VAR} references
 * using environment variables from process.env.
 *
 * Also handles concatenation patterns like "$HOME"/.local/ —
 * stripping quotes from string parts and joining with unquoted parts.
 */
export function resolvePathWithEnv(pathStr: string): string {
  let result = ''
  let i = 0

  while (i < pathStr.length) {
    if (pathStr[i] === '"' || pathStr[i] === "'") {
      // Quoted section: extract content, expand vars, skip the quotes
      const quote = pathStr[i]
      i++ // skip opening quote
      let content = ''
      while (i < pathStr.length && pathStr[i] !== quote) {
        content += pathStr[i]
        i++
      }
      if (i < pathStr.length) i++ // skip closing quote
      // Expand variables inside the quoted content
      result += expandEnvVars(content)
    } else {
      result += pathStr[i]
      i++
    }
  }

  // Also expand any remaining unquoted $VAR references in the full result
  return expandEnvVars(result)
}

/** Expand $VAR and ${VAR} patterns using process.env. */
function expandEnvVars(s: string): string {
  return s
    .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '')
    .replace(/\$(\w+)/g, (_, name) => process.env[name] || '')
}

/**
 * Given a concatenation text like '"$HOME"/.local/', resolve the full
 * path by expanding environment variables and stripping quotes.
 * Returns the resolved absolute path, or null if it can't be resolved.
 */
export function resolveConcatenationPath(concatText: string): string | null {
  // Split concatenation into parts: quoted strings, unquoted words
  // e.g. '"$HOME"/.local/' -> expand $HOME, join with /.local/
  const resolved = resolvePathWithEnv(concatText)
  if (!resolved) return null

  // Expand tilde
  if (resolved.startsWith('~')) {
    const home = process.env.HOME || '/root'
    return home + resolved.slice(1)
  }

  return resolved
}

/**
 * Determine the search directory for a file path completion.
 */
export function getSearchDirForPath(
  partial: string,
  currentFileDir: string,
): string {
  if (partial.startsWith('/')) {
    return path.dirname(partial) || '/'
  }
  if (partial.startsWith('~')) {
    const home = process.env.HOME || '/root'
    const expanded = path.join(home, partial.slice(1))
    return path.dirname(expanded)
  }
  // Relative path
  return path.join(currentFileDir, path.dirname(partial) || '.')
}
