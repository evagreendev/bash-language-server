/**
 * Embedded language detection and token-based highlighting for heredocs
 * and inline string arguments (e.g., bash -c "...", python -c '...').
 *
 * Detects the language from the preceding command, the delimiter word
 * (heredocs), or the -c/-e flag pattern (inline strings), then emits
 * simple semantic token ranges for keywords, strings, numbers, and
 * comments in that language.
 */

import * as LSP from 'vscode-languageserver/node'
import { SyntaxNode } from 'web-tree-sitter'

/**
 * A lightweight language definition for token-based highlighting.
 */
interface HeredocLanguage {
  /** Language identifier (for display / future use). */
  id: string
  /** Keywords to highlight. */
  keywords: Set<string>
  /** Line-comment prefix characters (e.g., '#', '--', '//'). */
  lineComment?: string
  /** Block-comment delimiters [open, close]. */
  blockComment?: [string, string]
  /** String quote characters. */
  quotes?: string[]
}

/**
 * Registry of languages we can do basic highlighting for.
 */
const LANGUAGES: Record<string, HeredocLanguage> = {
  python: {
    id: 'python',
    keywords: new Set([
      'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
      'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
      'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
      'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
      'try', 'while', 'with', 'yield',
    ]),
    lineComment: '#',
    quotes: ['"', "'", '"""', "'''"],
  },
  ruby: {
    id: 'ruby',
    keywords: new Set([
      'BEGIN', 'END', 'alias', 'and', 'begin', 'break', 'case', 'class',
      'def', 'defined?', 'do', 'else', 'elsif', 'end', 'ensure', 'false',
      'for', 'if', 'in', 'module', 'next', 'nil', 'not', 'or', 'redo',
      'rescue', 'retry', 'return', 'self', 'super', 'then', 'true',
      'undef', 'unless', 'until', 'when', 'while', 'yield',
    ]),
    lineComment: '#',
    quotes: ['"', "'"],
  },
  sql: {
    id: 'sql',
    keywords: new Set([
      'ADD', 'ALL', 'ALTER', 'AND', 'AS', 'ASC', 'BETWEEN', 'BY',
      'CASE', 'CREATE', 'DATABASE', 'DEFAULT', 'DELETE', 'DESC',
      'DISTINCT', 'DROP', 'ELSE', 'END', 'EXISTS', 'FROM', 'GRANT',
      'GROUP', 'HAVING', 'IN', 'INDEX', 'INNER', 'INSERT', 'INTO',
      'IS', 'JOIN', 'KEY', 'LEFT', 'LIKE', 'LIMIT', 'NOT', 'NULL',
      'ON', 'OR', 'ORDER', 'OUTER', 'PRIMARY', 'RIGHT', 'SELECT',
      'SET', 'TABLE', 'THEN', 'UNION', 'UNIQUE', 'UPDATE', 'VALUES',
      'VIEW', 'WHERE', 'WITH',
    ]),
    lineComment: '--',
    quotes: ["'"],
  },
  javascript: {
    id: 'javascript',
    keywords: new Set([
      'async', 'await', 'break', 'case', 'catch', 'class', 'const',
      'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
      'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
      'import', 'in', 'instanceof', 'let', 'new', 'null', 'of',
      'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
      'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield',
    ]),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    quotes: ['"', "'", '`'],
  },
  json: {
    id: 'json',
    keywords: new Set(['true', 'false', 'null']),
    quotes: ['"'],
  },
  perl: {
    id: 'perl',
    keywords: new Set([
      'do', 'else', 'elsif', 'for', 'foreach', 'if', 'my', 'our',
      'package', 'return', 'sub', 'unless', 'until', 'use', 'while',
    ]),
    lineComment: '#',
    quotes: ['"', "'"],
  },
  php: {
    id: 'php',
    keywords: new Set([
      'abstract', 'and', 'array', 'as', 'break', 'callable', 'case',
      'catch', 'class', 'clone', 'const', 'continue', 'declare',
      'default', 'do', 'echo', 'else', 'elseif', 'empty', 'endfor',
      'endforeach', 'endif', 'endswitch', 'endwhile', 'extends',
      'final', 'finally', 'fn', 'for', 'foreach', 'function', 'global',
      'if', 'implements', 'include', 'instanceof', 'interface',
      'isset', 'list', 'match', 'namespace', 'new', 'or', 'print',
      'private', 'protected', 'public', 'readonly', 'require',
      'return', 'static', 'switch', 'throw', 'trait', 'try', 'unset',
      'use', 'var', 'while', 'xor', 'yield',
    ]),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
  },
  lua: {
    id: 'lua',
    keywords: new Set([
      'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for',
      'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or',
      'repeat', 'return', 'then', 'true', 'until', 'while',
    ]),
    lineComment: '--',
    blockComment: ['--[[', ']]'],
    quotes: ['"', "'"],
  },
  awk: {
    id: 'awk',
    keywords: new Set([
      'BEGIN', 'END', 'if', 'else', 'while', 'for', 'in', 'do',
      'break', 'continue', 'next', 'exit', 'return', 'function',
      'delete', 'print', 'printf', 'getline',
    ]),
    lineComment: '#',
    quotes: ['"'],
  },
  make: {
    id: 'make',
    keywords: new Set([
      'define', 'endef', 'ifdef', 'ifndef', 'ifeq', 'ifneq', 'else',
      'endif', 'include', 'override', 'export', 'unexport',
      'private', 'vpath',
    ]),
    lineComment: '#',
    quotes: ['"', "'"],
  },
  dockerfile: {
    id: 'dockerfile',
    keywords: new Set([
      'FROM', 'RUN', 'CMD', 'LABEL', 'MAINTAINER', 'EXPOSE', 'ENV',
      'ADD', 'COPY', 'ENTRYPOINT', 'VOLUME', 'USER', 'WORKDIR',
      'ARG', 'ONBUILD', 'STOPSIGNAL', 'HEALTHCHECK', 'SHELL',
    ]),
    lineComment: '#',
    quotes: ['"', "'"],
  },
}

/**
 * Map command names to language IDs.
 */
const COMMAND_LANGUAGE_MAP: Record<string, string> = {
  python: 'python',
  python3: 'python',
  python2: 'python',
  ruby: 'ruby',
  node: 'javascript',
  nodejs: 'javascript',
  perl: 'perl',
  php: 'php',
  lua: 'lua',
  awk: 'awk',
  gawk: 'awk',
  nawk: 'awk',
  sed: 'sed', // no highlighting for sed scripts
  R: 'r',     // no highlighting for R
  Rscript: 'r',
  sqlite3: 'sql',
  mysql: 'sql',
  psql: 'sql',
  make: 'make',
  jq: 'javascript', // jq is its own thing but JS-like enough
}

/**
 * Map delimiter words (case-insensitive) to language IDs.
 */
const DELIMITER_LANGUAGE_MAP: Record<string, string> = {
  python: 'python',
  py: 'python',
  ruby: 'ruby',
  rb: 'ruby',
  sql: 'sql',
  js: 'javascript',
  javascript: 'javascript',
  json: 'json',
  html: 'html',
  css: 'css',
  php: 'php',
  perl: 'perl',
  pl: 'perl',
  lua: 'lua',
  awk: 'awk',
  make: 'make',
  makefile: 'make',
  dockerfile: 'dockerfile',
  docker: 'dockerfile',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
}

/**
 * Detect the language of a heredoc based on the preceding command and delimiter.
 */
export function detectHeredocLanguage(
  commandName: string | undefined,
  delimiter: string,
): HeredocLanguage | null {
  // 1. Try the command name
  if (commandName) {
    const cmdLang = COMMAND_LANGUAGE_MAP[commandName]
    if (cmdLang && LANGUAGES[cmdLang]) {
      return LANGUAGES[cmdLang]
    }
  }

  // 2. Try the delimiter (case-insensitive)
  const delimLower = delimiter.toLowerCase()
  const delimLang = DELIMITER_LANGUAGE_MAP[delimLower]
  if (delimLang && LANGUAGES[delimLang]) {
    return LANGUAGES[delimLang]
  }

  return null
}

/**
 * A single semantic token produced from heredoc content.
 */
interface HeredocToken {
  line: number
  character: number
  length: number
  tokenType: LSP.SemanticTokenTypes
  /** Whether this token is inside embedded code (heredoc / -c string). */
  embedded?: boolean
}

/**
 * Tokenize an embedded code body and add filler tokens for the full range
 * so the entire string gets the 'embedded' modifier for background tinting.
 */
function tokenizeEmbeddedBody(
  body: string,
  lang: HeredocLanguage,
  startLine: number,
  startCol: number,
): HeredocToken[] {
  const tokens = tokenizeHeredocBody(body, lang, startLine, startCol)
  addFillerTokens(tokens, body, startLine, startCol)
  return tokens
}

/**
 * Tokenize the body of a heredoc for basic highlighting.
 *
 * Uses a simple line-by-line scanner that recognises:
 * - Line comments
 * - Strings (single- and double-quoted, limited to single-line)
 * - Numbers (integer and decimal)
 * - Keywords (word-boundary match)
 *
 * Returns tokens relative to the heredoc_body node's start position.
 */
export function tokenizeHeredocBody(
  body: string,
  lang: HeredocLanguage,
  bodyStartLine: number,
  bodyStartCol: number,
): HeredocToken[] {
  const tokens: HeredocToken[] = []
  const lines = body.split('\n')

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]
    const lineStartCol = lineIdx === 0 ? bodyStartCol : 0
    const absLine = bodyStartLine + lineIdx

    let col = 0

    // Skip leading whitespace
    const skipWS = () => {
      while (col < line.length && (line[col] === ' ' || line[col] === '\t')) col++
    }

    // Check for line comment
    if (lang.lineComment) {
      const commentIdx = line.indexOf(lang.lineComment)
      if (commentIdx >= 0) {
        // Make sure it's not inside a string — simple heuristic: not preceded by quote
        const before = line.slice(0, commentIdx)
        const inString = (before.split('"').length - 1) % 2 !== 0 ||
                         (before.split("'").length - 1) % 2 !== 0
        if (!inString) {
          tokens.push({
            line: absLine,
            character: lineStartCol + commentIdx,
            length: line.length - commentIdx,
            tokenType: LSP.SemanticTokenTypes.comment,
          embedded: true,
          })
          continue // rest of line is comment
        }
      }
    }

    // Scan the line character by character
    col = 0
    while (col < line.length) {
      const ch = line[col]
      const absCol = (lineIdx === 0 ? bodyStartCol : 0) + col

      // Whitespace
      if (ch === ' ' || ch === '\t') {
        col++
        continue
      }

      // Number literal
      if ((ch >= '0' && ch <= '9') || (ch === '.' && col + 1 < line.length && line[col + 1] >= '0' && line[col + 1] <= '9')) {
        const start = col
        let hasDot = false
        while (col < line.length) {
          const c = line[col]
          if (c >= '0' && c <= '9') { col++; continue }
          if (c === '.' && !hasDot) { hasDot = true; col++; continue }
          break
        }
        // Don't highlight hex prefixes etc. — keep it simple
        if (col > start) {
          tokens.push({
            line: absLine,
            character: absCol,
            length: col - start,
            tokenType: LSP.SemanticTokenTypes.number,
          embedded: true,
          })
        }
        continue
      }

      // String literals (single or double quoted)
      if (ch === '"' || ch === "'") {
        const quote = ch
        const start = col
        col++ // skip opening quote
        while (col < line.length && line[col] !== quote) {
          if (line[col] === '\\') col++ // skip escaped char
          col++
        }
        if (col < line.length) col++ // skip closing quote
        tokens.push({
          line: absLine,
          character: absCol,
          length: col - start,
          tokenType: LSP.SemanticTokenTypes.string,
          embedded: true,
        })
        continue
      }

      // Flag / option (starts with -)
      if (ch === '-' && col + 1 < line.length &&
          ((line[col + 1] >= 'a' && line[col + 1] <= 'z') ||
           (line[col + 1] >= 'A' && line[col + 1] <= 'Z'))) {
        const start = col
        col++ // skip -
        while (col < line.length) {
          const c = line[col]
          if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '-') {
            col++
          } else {
            break
          }
        }
        tokens.push({
          line: absLine,
          character: absCol,
          length: col - start,
          tokenType: LSP.SemanticTokenTypes.operator, // flags as operators for visual distinction
        })
        continue
      }

      // Word (potential keyword)
      if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
        const start = col
        while (col < line.length) {
          const c = line[col]
          if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_') {
            col++
          } else {
            break
          }
        }
        const word = line.slice(start, col)
        if (lang.keywords.has(word)) {
          tokens.push({
            line: absLine,
            character: absCol,
            length: col - start,
            tokenType: LSP.SemanticTokenTypes.keyword,
          embedded: true,
          })
        }
        continue
      }

      // Skip unknown characters
      col++
    }
  }

  return tokens
}

/**
 * Map of commands that accept inline code via -c/-e/-r flags.
 * Maps command name -> [flag, language ID].
 */
const INLINE_COMMAND_MAP: Record<string, [string, string]> = {
  bash: ['-c', 'shell'],
  sh: ['-c', 'shell'],
  zsh: ['-c', 'shell'],
  dash: ['-c', 'shell'],
  ksh: ['-c', 'shell'],
  python: ['-c', 'python'],
  python3: ['-c', 'python'],
  python2: ['-c', 'python'],
  ruby: ['-e', 'ruby'],
  perl: ['-e', 'perl'],
  php: ['-r', 'php'],
  lua: ['-e', 'lua'],
  node: ['-e', 'javascript'],
  nodejs: ['-e', 'javascript'],
}

/**
 * Commands where the first non-flag string/raw_string argument is code.
 * Maps command name -> language ID.
 */
const FIRST_ARG_LANGUAGE: Record<string, string> = {
  awk: 'awk',
  gawk: 'awk',
  nawk: 'awk',
}

/**
 * Shell-language definition (used for bash -c "...", ssh host "...", etc.)
 */
const SHELL_LANGUAGE: HeredocLanguage = {
  id: 'shell',
  keywords: new Set([
    // Flow control
    'if', 'then', 'else', 'elif', 'fi', 'case', 'esac',
    'for', 'while', 'until', 'do', 'done', 'in', 'select',
    'function', 'return', 'exit', 'break', 'continue',
    // Builtins
    'local', 'declare', 'typeset', 'export', 'readonly',
    'echo', 'printf', 'test', 'eval', 'exec', 'source', '.',
    'cd', 'pushd', 'popd', 'shift', 'set', 'unset',
    'true', 'false', 'read', 'mapfile', 'readarray',
    'alias', 'unalias', 'bg', 'fg', 'jobs', 'kill',
    'wait', 'disown', 'suspend', 'logout',
    'enable', 'disable', 'builtin', 'command', 'type',
    'hash', 'help', 'caller', 'compgen', 'complete',
    'dirs', 'getopts', 'let', 'times', 'trap', 'umask',
    // Common commands
    'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'ln',
    'ls', 'cat', 'head', 'tail', 'less', 'more',
    'grep', 'egrep', 'fgrep', 'find', 'xargs',
    'sort', 'uniq', 'wc', 'tr', 'cut', 'paste',
    'sed', 'awk', 'gawk', 'diff', 'patch',
    'chmod', 'chown', 'chgrp', 'touch',
    'tar', 'gzip', 'gunzip', 'zip', 'unzip',
    'curl', 'wget', 'scp', 'rsync',
    'ssh', 'ssh-keygen', 'ssh-agent', 'ssh-add',
    'git', 'docker', 'kubectl', 'systemctl',
    'apt', 'apt-get', 'yum', 'dnf', 'pacman',
    'npm', 'pnpm', 'yarn', 'npx', 'node',
    'pip', 'pip3', 'python', 'python3',
    'make', 'cmake', 'gcc', 'g++',
    'ps', 'top', 'htop', 'df', 'du', 'free',
    'mount', 'umount', 'dd',
    'env', 'printenv', 'which', 'whereis',
    'man', 'info', 'whatis',
    'sudo', 'su', 'passwd', 'useradd', 'usermod',
    'date', 'cal', 'sleep', 'watch',
    'basename', 'dirname', 'realpath', 'readlink',
    'tee', 'yes', 'seq', 'jq',
  ]),
  lineComment: '#',
  quotes: ['"', "'"],
}

/**
 * Scan a command node for inline string arguments that contain embedded code.
 * Looks for patterns like bash -c "...", python -c "...", awk '...',
 * ssh host "...", sudo ... bash -c "..." etc. — regardless of the top-level
 * command name (so wrapper functions like bu_run ... bash -c "..." also work).
 */
function getInlineStringTokens(
  cmdNode: SyntaxNode,
): HeredocToken[] {
  const tokens: HeredocToken[] = []

  const cmdNameNode = cmdNode.descendantsOfType('command_name')[0]
  if (!cmdNameNode) return tokens

  const cmdName = cmdNameNode.text

  // Get all named children after command_name (the arguments)
  const args = cmdNode.namedChildren.filter(c => c.type !== 'command_name')

  // Helper: check if an arg is a string-like node we can tokenize
  const isStringArg = (arg: SyntaxNode): boolean =>
    arg.type === 'string' || arg.type === 'raw_string' || arg.type === 'concatenation'

  // Helper: extract the body text from a string-like arg
  const extractBody = (arg: SyntaxNode): string => {
    if (arg.type === 'raw_string') return arg.text.slice(1, -1)
    if (arg.type === 'string') return extractStringContent(arg)
    if (arg.type === 'concatenation') {
      // Assemble from children: strings contribute their content, expansions contribute their text
      return arg.namedChildren.map(c => {
        if (c.type === 'string') return extractStringContent(c)
        if (c.type === 'raw_string') return c.text.slice(1, -1)
        return c.text
      }).join('')
    }
    return arg.text
  }

  // Helper: emit tokens for a string-like arg
  const emitStringTokens = (arg: SyntaxNode, lang: HeredocLanguage) => {
    if (arg.type === 'concatenation') {
      // Tokenize each string/raw_string child individually with its own position
      for (const child of arg.namedChildren) {
        if (child.type === 'string' || child.type === 'raw_string') {
          emitSingleString(child, lang)
        }
        // Skip expansions — they resolve to unknown values
      }
    } else {
      emitSingleString(arg, lang)
    }
  }

  // Tokenize a single string/raw_string node
  const emitSingleString = (arg: SyntaxNode, lang: HeredocLanguage) => {
    if (arg.type === 'raw_string') {
      tokens.push(...tokenizeEmbeddedBody(
        arg.text.slice(1, -1), lang,
        arg.startPosition.row,
        arg.startPosition.column + 1,
      ))
      return
    }
    // For string nodes, check if it's multi-line (multiple string_content children)
    if (arg.type === 'string') {
      if (arg.namedChildren.length === 0) {
        tokens.push(...tokenizeEmbeddedBody(
          arg.text.slice(1, -1), lang,
          arg.startPosition.row,
          arg.startPosition.column + 1,
        ))
        return
      }
      // If all children are string_content, tokenize each line individually
      // for accurate line/column positions
      if (arg.namedChildren.every(c => c.type === 'string_content')) {
        for (const sc of arg.namedChildren) {
          tokens.push(...tokenizeEmbeddedBody(
            sc.text, lang,
            sc.startPosition.row,
            sc.startPosition.column,
          ))
        }
        return
      }
      // Mixed content (expansions + string_content): tokenize each
      // string_content individually with its own position, skip expansions.
      for (const child of arg.namedChildren) {
        if (child.type === 'string_content') {
          tokens.push(...tokenizeEmbeddedBody(
            child.text, lang,
            child.startPosition.row,
            child.startPosition.column,
          ))
        }
        // Skip expansion children — they resolve to runtime values
      }
    }
  }

  /**
   * Scan a slice of args for the pattern: WORD(known-cmd) FLAG(-c/-e/-r) STRING
   * Returns true if a match was found and tokens were emitted.
   */
  const scanForInlinePattern = (argsSlice: SyntaxNode[]): boolean => {
    for (let i = 0; i < argsSlice.length - 1; i++) {
      const maybeCmd = argsSlice[i]
      if (maybeCmd.type !== 'word') continue
      const info = INLINE_COMMAND_MAP[maybeCmd.text]
      if (!info) continue
      const [flag, langId] = info
      // Look for flag immediately followed by string
      for (let j = i + 1; j < argsSlice.length - 1; j++) {
        if (argsSlice[j].type === 'word' && argsSlice[j].text === flag) {
          const nextArg = argsSlice[j + 1]
          if (isStringArg(nextArg)) {
            const lang = langId === 'shell' ? SHELL_LANGUAGE : LANGUAGES[langId]
            if (lang) {
              emitStringTokens(nextArg, lang)
              return true
            }
          }
        }
      }
    }
    return false
  }

  /**
   * Scan a slice of args for awk/sed pattern: first non-flag string arg is code.
   */
  const scanForFirstArgPattern = (argsSlice: SyntaxNode[]): boolean => {
    for (let i = 0; i < argsSlice.length; i++) {
      const maybeCmd = argsSlice[i]
      if (maybeCmd.type !== 'word') continue
      const langId = FIRST_ARG_LANGUAGE[maybeCmd.text]
      if (!langId) continue
      // Find the next string/raw_string arg
      for (let j = i + 1; j < argsSlice.length; j++) {
        if (isStringArg(argsSlice[j])) {
          const lang = LANGUAGES[langId]
          if (lang) {
            emitStringTokens(argsSlice[j], lang)
            return true
          }
        }
      }
    }
    return false
  }

  /**
   * Scan a slice of args for ssh/su/sudo patterns.
   */
  const scanForWrapperPattern = (argsSlice: SyntaxNode[]): boolean => {
    for (let i = 0; i < argsSlice.length; i++) {
      const arg = argsSlice[i]
      if (arg.type !== 'word') continue

      if (arg.text === 'ssh') {
        // ssh: find the last string/raw_string arg
        for (let j = argsSlice.length - 1; j > i; j--) {
          if (isStringArg(argsSlice[j])) {
            emitStringTokens(argsSlice[j], SHELL_LANGUAGE)
            return true
          }
        }
      }

      if (arg.text === 'su') {
        // su: find -c flag and next string
        for (let j = i + 1; j < argsSlice.length - 1; j++) {
          if (argsSlice[j].type === 'word' && argsSlice[j].text === '-c') {
            const nextArg = argsSlice[j + 1]
            if (isStringArg(nextArg)) {
              emitStringTokens(nextArg, SHELL_LANGUAGE)
              return true
            }
          }
        }
      }

      if (arg.text === 'sudo') {
        // sudo: scan the remaining args for known inline patterns
        const remaining = argsSlice.slice(i + 1)
        if (scanForInlinePattern(remaining)) return true
        if (scanForFirstArgPattern(remaining)) return true
        // Also try to recurse: any word that is itself a command wrapper
        for (let k = 0; k < remaining.length; k++) {
          if (remaining[k].type === 'word' &&
              ['sudo', 'ssh', 'su', 'docker'].includes(remaining[k].text)) {
            if (scanForWrapperPattern(remaining)) return true
          }
        }
      }
    }
    return false
  }

  // 1. Try scanning from the top-level command name
  if (scanForInlinePattern(args)) return tokens
  if (scanForFirstArgPattern(args)) return tokens

  // 2. Try ssh/su/sudo patterns from the top level
  if (['ssh', 'su', 'sudo'].includes(cmdName)) {
    scanForWrapperPattern(args)
    return tokens
  }

  // 3. Always scan ALL args for known patterns (handles wrapper functions)
  //    Look for any word that starts a known inline pattern
  scanForInlinePattern(args)
  scanForFirstArgPattern(args)
  scanForWrapperPattern(args)

  return tokens
}

/**
 * Extract the inner text content from a string node.
 * For strings with a single string_content child, returns its text.
 * For multi-line strings (multiple string_content children), returns null
 * to signal that the caller should tokenize each child individually.
 */
function extractStringContent(node: SyntaxNode): string {
  if (node.namedChildren.length === 0) {
    return node.text.slice(1, -1)
  }
  // Only string_content children: multi-line, join with newlines
  if (node.namedChildren.every(c => c.type === 'string_content')) {
    return node.namedChildren.map(c => c.text).join('\n')
  }
  // Mixed content (expansions etc.): best effort
  return node.namedChildren.map(c => c.text).join('')
}

/**
 * Find # bash-ide comment lines and emit fine-grained semantic tokens:
 *   bash-ide → keyword
 *   directive name (source, cwd, etc.) → parameter
 *   = → operator
 *   value → string
 */
function getBashIdeCommentTokens(rootNode: SyntaxNode): HeredocToken[] {
  const tokens: HeredocToken[] = []
  const commentNodes = rootNode.descendantsOfType('comment')
  const bashIdeRegex = /^(\s*#\s*bash-ide\s+)(\w[\w-]*)(=)?(.*)$/

  for (const node of commentNodes) {
    const text = node.text
    const match = text.match(bashIdeRegex)
    if (!match) continue

    const baseCol = node.startPosition.column
    const line = node.startPosition.row

    const prefixEnd = match[1]!.length          // "# bash-ide "
    const directiveName = match[2]!              // "source"
    const hasEquals = match[3] === '='           // "="
    const value = match[4]!                      // "./path"

    // "bash-ide" part (inside the prefix) as keyword
    const bashIdeStart = text.indexOf('bash-ide')
    tokens.push({
      line,
      character: baseCol + bashIdeStart,
      length: 'bash-ide'.length,
      tokenType: LSP.SemanticTokenTypes.keyword,
    })

    // Directive name as parameter
    const nameStart = baseCol + prefixEnd
    tokens.push({
      line,
      character: nameStart,
      length: directiveName.length,
      tokenType: LSP.SemanticTokenTypes.parameter,
    })

    // Equals sign as operator
    if (hasEquals) {
      tokens.push({
        line,
        character: nameStart + directiveName.length,
        length: 1,
        tokenType: LSP.SemanticTokenTypes.operator,
      })
    }

    // Value as string
    if (hasEquals && value.length > 0) {
      const valueStart = nameStart + directiveName.length + 1
      tokens.push({
        line,
        character: valueStart,
        length: value.length,
        tokenType: LSP.SemanticTokenTypes.string,
      })
    }
  }

  return tokens
}

/**
 * Walk a bash AST and extract semantic tokens for all embedded languages
 * found in heredocs and inline string arguments.
 */
export function getEmbeddedSemanticTokens(
  rootNode: SyntaxNode,
): LSP.SemanticTokens {
  const allTokens: HeredocToken[] = []

  // 0. bash-ide directive comments — highlight as decorators
  allTokens.push(...getBashIdeCommentTokens(rootNode))

  // 1. Heredocs
  const heredocs = rootNode.descendantsOfType('heredoc_redirect')
  for (const hd of heredocs) {
    const startNode = hd.namedChildren.find(c => c.type === 'heredoc_start')
    const bodyNode = hd.namedChildren.find(c => c.type === 'heredoc_body')
    if (!startNode || !bodyNode) continue

    const parent = hd.parent
    const cmd = parent?.namedChildren.find(c => c.type === 'command')
    const cmdName = cmd?.descendantsOfType('command_name')[0]?.text

    const delimiter = startNode.text
    const lang = detectHeredocLanguage(cmdName, delimiter)
    if (lang) {
      allTokens.push(...tokenizeEmbeddedBody(
        bodyNode.text, lang,
        bodyNode.startPosition.row, bodyNode.startPosition.column,
      ))
    }
  }

  // 2. Inline strings (-c/-e patterns)
  const commands = rootNode.descendantsOfType('command')
  for (const cmd of commands) {
    allTokens.push(...getInlineStringTokens(cmd))
  }

  return encodeSemanticTokens(allTokens)
}

/**
 * @deprecated Use getEmbeddedSemanticTokens instead.
 */
export const getHeredocSemanticTokens = getEmbeddedSemanticTokens

/**
 * Delta-encode a list of tokens per the LSP semantic tokens spec.
 *
 * Each token is encoded as [deltaLine, deltaStartChar, length, tokenType, tokenModifiers]
 * relative to the previous token.
 */
function encodeSemanticTokens(tokens: HeredocToken[]): LSP.SemanticTokens {
  if (tokens.length === 0) return { data: [] }

  // Sort by line, then character
  const sorted = [...tokens].sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line
    return a.character - b.character
  })

  const data: number[] = []
  let prevLine = 0
  let prevChar = 0

  for (const t of sorted) {
    const deltaLine = t.line - prevLine
    const deltaChar = deltaLine === 0 ? t.character - prevChar : t.character

    const modifierBits = t.embedded ? (MODIFIER_INDEX['embedded'] ?? 0) : 0

    data.push(deltaLine, deltaChar, t.length, LEGEND_INDEX[t.tokenType] ?? 0, modifierBits)

    prevLine = t.line
    prevChar = t.character
  }

  return { data }
}

/**
 * Add filler tokens to cover the full embedded range with the 'embedded'
 * modifier, so editors can apply a background tint to the entire string.
 *
 * Scans the tokenized lines and emits a 'comment' token for any whitespace
 * gap between actual tokens, tagged as embedded.
 */
function addFillerTokens(
  tokens: HeredocToken[],
  body: string,
  startLine: number,
  startCol: number,
): void {
  const lines = body.split('\n')

  // Build a set of covered positions: "line:col" strings
  const covered = new Set<string>()
  for (const t of tokens) {
    for (let c = 0; c < t.length; c++) {
      covered.add(`${t.line}:${t.character + c}`)
    }
  }

  // Scan each line of the body, emit filler for uncovered chars
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]
    const absLine = startLine + lineIdx
    const baseCol = lineIdx === 0 ? startCol : 0

    let col = 0
    while (col < line.length) {
      // Skip already-covered positions
      if (covered.has(`${absLine}:${baseCol + col}`)) {
        col++
        continue
      }

      // Find consecutive uncovered characters
      const start = col
      while (col < line.length && !covered.has(`${absLine}:${baseCol + col}`)) {
        col++
      }

      if (col > start) {
        tokens.push({
          line: absLine,
          character: baseCol + start,
          length: col - start,
          tokenType: LSP.SemanticTokenTypes.comment,
          embedded: true,
        })
      }
    }
  }
}

/**
 * Map LSP token type strings to the legend index.
 * The legend must match what we advertise in server capabilities.
 */
export const SEMANTIC_TOKEN_LEGEND: LSP.SemanticTokensLegend = {
  tokenTypes: [
    LSP.SemanticTokenTypes.keyword,
    LSP.SemanticTokenTypes.string,
    LSP.SemanticTokenTypes.number,
    LSP.SemanticTokenTypes.comment,
    LSP.SemanticTokenTypes.operator,
    LSP.SemanticTokenTypes.variable,
    LSP.SemanticTokenTypes.function,
    LSP.SemanticTokenTypes.type,
    LSP.SemanticTokenTypes.parameter,
    LSP.SemanticTokenTypes.decorator,
  ],
  tokenModifiers: [
    'embedded',
  ],
}

const LEGEND_INDEX: Record<string, number> = {}
for (let i = 0; i < SEMANTIC_TOKEN_LEGEND.tokenTypes.length; i++) {
  LEGEND_INDEX[SEMANTIC_TOKEN_LEGEND.tokenTypes[i]] = i
}
const MODIFIER_INDEX: Record<string, number> = {}
for (let i = 0; i < SEMANTIC_TOKEN_LEGEND.tokenModifiers.length; i++) {
  MODIFIER_INDEX[SEMANTIC_TOKEN_LEGEND.tokenModifiers[i]] = 1 << i
}
