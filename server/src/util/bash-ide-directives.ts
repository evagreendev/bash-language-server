/**
 * Parser for the `# bash-ide` directive namespace.
 *
 * Supported directives:
 *   # bash-ide cwd=<dir>
 *   # bash-ide env-init=<single line command>
 *   # bash-ide env-init-begin
 *   ... (commands to run for env init)
 *   # bash-ide env-init-end
 *   # bash-ide source-pushd
 *   # bash-ide source=<path>
 *   # bash-ide transitive-source=<path>
 */

/**
 * Types of bash-ide directives.
 */
export type BashIdeDirectiveType = 'cwd' | 'env-init' | 'env-init-begin' | 'env-init-end' | 'source-pushd' | 'source' | 'transitive-source'

/**
 * A parsed bash-ide directive.
 */
export interface BashIdeDirective {
  type: BashIdeDirectiveType
  /** The value for cwd, env-init, and source directives. */
  value?: string
  /** The line number (0-indexed) where this directive appears. */
  line: number
}

/**
 * A block of env-init commands.
 */
export interface EnvInitBlock {
  /** Start line (0-indexed) of env-init-begin. */
  startLine: number
  /** End line (0-indexed) of env-init-end. */
  endLine: number
  /** The commands within the block. */
  commands: string[]
}

const BASH_IDE_REGEX = /^[\s]*#[\s]*bash-ide[\s]+(.+)$/

/**
 * Parse bash-ide directives from a file's content.
 *
 * @param fileContent The full text content of the file.
 * @returns A tuple of [directives, envInitBlocks]
 */
export function parseBashIdeDirectives(fileContent: string): {
  directives: BashIdeDirective[]
  envInitBlocks: EnvInitBlock[]
} {
  const lines = fileContent.split('\n')
  const directives: BashIdeDirective[] = []
  const envInitBlocks: EnvInitBlock[] = []

  let inEnvInitBlock = false
  let envInitStartLine = -1
  let envInitCommands: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = line.match(BASH_IDE_REGEX)

    if (!match) {
      if (inEnvInitBlock) {
        envInitCommands.push(line)
      }
      continue
    }

    const content = match[1].trim()

    if (content === 'env-init-begin') {
      inEnvInitBlock = true
      envInitStartLine = i
      envInitCommands = []
      directives.push({ type: 'env-init-begin', line: i })
    } else if (content === 'env-init-end') {
      inEnvInitBlock = false
      directives.push({ type: 'env-init-end', line: i })
      envInitBlocks.push({
        startLine: envInitStartLine,
        endLine: i,
        commands: envInitCommands,
      })
    } else if (inEnvInitBlock) {
      // Inside a block, lines accumulate as commands
      envInitCommands.push(line)
    } else if (content.startsWith('cwd=')) {
      const value = content.slice(4).trim()
      directives.push({ type: 'cwd', value, line: i })
    } else if (content.startsWith('env-init=')) {
      const value = content.slice(9).trim()
      directives.push({ type: 'env-init', value, line: i })
    } else if (content === 'source-pushd') {
      directives.push({ type: 'source-pushd', line: i })
    } else if (content.startsWith('source=')) {
      const value = content.slice(7).trim()
      directives.push({ type: 'source', value, line: i })
    } else if (content.startsWith('transitive-source=')) {
      const value = content.slice(18).trim()
      directives.push({ type: 'transitive-source', value, line: i })
    }
  }

  return { directives, envInitBlocks }
}

/**
 * Extract variable assignments from a command string.
 * Matches patterns like `VAR=value`, `export VAR=value`, etc.
 */
export function extractVariableAssignments(command: string): Map<string, string> {
  const assignments = new Map<string, string>()

  // Match VAR=value (possibly quoted)
  const assignmentRegex = /(?:^|\s+)(?:export\s+)?(\w+)=(["']?)([^"'\s]*)\2(?:\s+|$)/g
  let match: RegExpExecArray | null
  while ((match = assignmentRegex.exec(command)) !== null) {
    assignments.set(match[1], match[3])
  }

  return assignments
}
