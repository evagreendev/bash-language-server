import * as fs from 'fs'
import * as path from 'path'
import * as LSP from 'vscode-languageserver'
import * as Parser from 'web-tree-sitter'

import { parseBashIdeDirectives } from './bash-ide-directives'
import { parseShellCheckDirective } from '../shellcheck/directive'
import { discriminate } from './discriminate'
import { resolveFlowVariable } from './flow-value'
import { untildify } from './fs'
import * as TreeSitterUtil from './tree-sitter'

const SOURCING_COMMANDS = ['source', '.']

export type SourceCommand = {
  range: LSP.Range
  uri: string | null // resolved URIs
  error: string | null
}

/**
 * Options for getSourceCommands.
 */
export interface GetSourceCommandsOptions {
  fileUri: string
  rootPath: string | null
  tree: Parser.Tree
  /** Optional flow bindings for dynamic path resolution. */
  flowBindings?: Map<string, import('./flow-value').FlowValue>
  /** Current working directory (from bash-ide cwd directive). */
  cwd?: string
}

/**
 * Analysis the given tree for source commands.
 */
export function getSourceCommands({
  fileUri,
  rootPath,
  tree,
  flowBindings,
  cwd,
}: GetSourceCommandsOptions): SourceCommand[] {
  const sourceCommands: SourceCommand[] = []

  const defaultRootPaths = [path.dirname(fileUri), rootPath].filter(Boolean) as string[]

  // Check for bash-ide source-path directives
  const fileContent = tree.rootNode?.text || ''
  const bashIdeDir = parseBashIdeDirectives(fileContent)

  // Extract source-path from bash-ide directives (using cwd already set)
  const effectiveCwd = cwd || path.dirname(fileUri)

  TreeSitterUtil.forEach(tree.rootNode, (node) => {
    const sourcedPathInfo = getSourcedPathInfoFromNode({
      node,
      flowBindings,
      defaultRootPaths,
      cwd: effectiveCwd,
    })

    if (sourcedPathInfo) {
      const { sourcedPath, parseError } = sourcedPathInfo
      const uri = sourcedPath
        ? resolveSourcedUri({ rootPaths: defaultRootPaths, sourcedPath, cwd: effectiveCwd })
        : null

      sourceCommands.push({
        range: TreeSitterUtil.range(node),
        uri,
        error: uri ? null : parseError || 'failed to resolve path',
      })
    }

    return true
  })

  return sourceCommands
}

function getSourcedPathInfoFromNode({
  node,
  flowBindings,
  defaultRootPaths,
  cwd,
}: {
  node: Parser.SyntaxNode
  flowBindings?: Map<string, import('./flow-value').FlowValue>
  defaultRootPaths: string[]
  cwd?: string
}): null | { sourcedPath?: string; parseError?: string } {
  if (node.type === 'command') {
    const [commandNameNode, argumentNode] = node.namedChildren

    if (!commandNameNode || !argumentNode) {
      return null
    }

    if (
      commandNameNode.type === 'command_name' &&
      SOURCING_COMMANDS.includes(commandNameNode.text)
    ) {
      const previousCommentNode =
        node.previousSibling?.type === 'comment' ? node.previousSibling : null

      if (previousCommentNode?.text.includes('shellcheck')) {
        const directives = parseShellCheckDirective(previousCommentNode.text)
        const sourcedPath = directives.find(discriminate('type', 'source'))?.path

        if (sourcedPath === '/dev/null') {
          return null
        }

        if (sourcedPath) {
          return {
            sourcedPath,
          }
        }

        const isNotFollowErrorDisabled = !!directives
          .filter(discriminate('type', 'disable'))
          .flatMap(({ rules }) => rules)
          .find((rule) => rule === 'SC1091')

        if (isNotFollowErrorDisabled) {
          return null
        }

        const rootFolder = directives.find(discriminate('type', 'source-path'))?.path
        if (rootFolder && rootFolder !== 'SCRIPTDIR' && argumentNode.type === 'word') {
          return {
            sourcedPath: path.join(rootFolder, argumentNode.text),
          }
        }
      }

      const strValue = TreeSitterUtil.resolveStaticString(argumentNode)
      if (strValue !== null) {
        return {
          sourcedPath: strValue,
        }
      }

      // Strip one leading dynamic section.
      if (argumentNode.type === 'string' && argumentNode.namedChildren.length === 1) {
        const [variableNode] = argumentNode.namedChildren
        if (TreeSitterUtil.isExpansion(variableNode)) {
          const stringContents = argumentNode.text.slice(1, -1)
          
          // Try to resolve using flow bindings or env vars
          const varNameNode = variableNode.descendantsOfType('variable_name')[0]
          if (varNameNode) {
            const val = resolveFlowVariable(varNameNode.text, flowBindings)
            if (val !== null) {
              const remainingPath = stringContents.slice(variableNode.text.length)
              return { sourcedPath: val + remainingPath }
            }
          }
          
          if (stringContents.startsWith(`${variableNode.text}/`)) {
            return {
              sourcedPath: `.${stringContents.slice(variableNode.text.length)}`,
            }
          }
        }
      }

      // Handle string with an expansion and additional static content (e.g. "$HOME/.bashrc")
      if (argumentNode.type === 'string' && argumentNode.namedChildren.length > 1) {
        // Try to resolve any expansions inside the string
        const parts: string[] = []
        let canFullyResolve = true
        for (const child of argumentNode.namedChildren) {
          if (child.type === 'string_content') {
            parts.push(child.text)
          } else if (TreeSitterUtil.isExpansion(child)) {
            const varNameNode = child.descendantsOfType('variable_name')[0]
            if (varNameNode) {
              const val = resolveFlowVariable(varNameNode.text, flowBindings)
              if (val !== null) {
                parts.push(val)
                continue
              }
            }
            canFullyResolve = false
            break
          }
        }
        if (canFullyResolve && parts.length > 0) {
          return { sourcedPath: parts.join('') }
        }
      }

      if (argumentNode.type === 'concatenation') {
        // Strip one leading dynamic section from a concatenation node.
        const sourcedPath = resolveSourceFromConcatenation(argumentNode, flowBindings)
        if (sourcedPath) {
          return {
            sourcedPath,
          }
        }
      }

      // Try to resolve using flow bindings or env vars for variable references
      if (argumentNode.type === 'word') {
        const val = resolveFlowVariable(argumentNode.text, flowBindings)
        if (val !== null) {
          return { sourcedPath: val }
        }
      }

      // TODO: we could try to parse any ShellCheck "source "directive
      // # shellcheck source=src/examples/config.sh
      return {
        parseError: `non-constant source not supported`,
      }
    }
  }

  return null
}

/**
 * Tries to resolve the given sourced path and returns a URI if possible.
 * - Converts a relative paths to absolute paths
 * - Converts a tilde path to an absolute path
 * - Resolves the path
 *
 * NOTE: for future improvements:
 * "If filename does not contain a slash, file names in PATH are used to find
 *  the directory containing filename." (see https://ss64.com/osx/source.html)
 */
function resolveSourcedUri({
  rootPaths,
  sourcedPath,
  cwd,
}: {
  rootPaths: string[]
  sourcedPath: string
  cwd?: string
}): string | null {
  if (sourcedPath.startsWith('~')) {
    sourcedPath = untildify(sourcedPath)
  }

  if (sourcedPath.startsWith('/')) {
    if (fs.existsSync(sourcedPath)) {
      return `file://${sourcedPath}`
    }
    return null
  }

  // If cwd is explicitly set (via bash-ide cwd directive), use it first
  const allRootPaths = cwd ? [cwd, ...rootPaths] : rootPaths

  // resolve  relative path
  for (const rootPath of allRootPaths) {
    const potentialPath = path.join(rootPath.replace('file://', ''), sourcedPath)

    // check if path is a file
    if (fs.existsSync(potentialPath)) {
      return `file://${potentialPath}`
    }
  }

  return null
}

/*
 * Resolves the source path from a concatenation node, stripping a leading dynamic directory segment.
 * Returns null if the source path can't be statically determined after stripping a segment.
 * Note: If a non-concatenation node is passed, null will be returned. This is likely a programmer error.
 */
function resolveSourceFromConcatenation(
  node: Parser.SyntaxNode,
  flowBindings?: Map<string, import('./flow-value').FlowValue>,
): string | null {
  if (node.type !== 'concatenation') return null
  const stringValue = TreeSitterUtil.resolveStaticString(node)
  if (stringValue !== null) return stringValue // This string is fully static.

  const values: string[] = []
  // Since the string must begin with the variable, the variable must be in the first child.
  const [firstNode, ...rest] = node.namedChildren
  
  // Try to resolve first node via flow bindings or env vars
  if (TreeSitterUtil.isExpansion(firstNode)) {
    const varNameNode = firstNode.descendantsOfType('variable_name')[0]
    if (varNameNode) {
      const val = resolveFlowVariable(varNameNode.text, flowBindings)
      if (val !== null) {
        for (const child of rest) {
          const childValue = TreeSitterUtil.resolveStaticString(child)
          if (childValue === null) return null
          values.push(childValue)
        }
        return val + values.join('')
      }
    }
  }
  
  // The first child is static, this means one of the other children is not!
  if (TreeSitterUtil.resolveStaticString(firstNode) !== null) return null

  // Handle a string child containing an expansion (quoted case: "$HOME"/...)
  if (!TreeSitterUtil.isExpansion(firstNode)) {
    // Find the expansion inside the string (e.g. $HOME within "$HOME")
    const varNode = firstNode.namedChildren.find(
      c => TreeSitterUtil.isExpansion(c)
    )
    if (varNode) {
      const varNameNode = varNode.descendantsOfType('variable_name')[0]
      if (varNameNode) {
        const val = resolveFlowVariable(varNameNode.text, flowBindings)
        if (val !== null) {
          // Build the resolved path: resolved variable + rest of string + rest of concatenation
          const stringContents = firstNode.text.slice(1, -1)
          const afterVar = stringContents.slice(
            stringContents.indexOf(varNode.text) + varNode.text.length,
          )
          values.push(val + afterVar)
          for (const child of rest) {
            const childValue = TreeSitterUtil.resolveStaticString(child)
            if (childValue === null) return null
            values.push(childValue)
          }
          return values.join('')
        }
      }
    }

    // Fallback: old behaviour — strip leading variable, return relative path
    if (firstNode.namedChildCount > 1) return null
    const variableNode = firstNode.namedChildren[0]
    if (!TreeSitterUtil.isExpansion(variableNode)) return null
    const stringContents = firstNode.text.slice(1, -1)
    if (!stringContents.startsWith(variableNode.text)) return null
    values.push(stringContents.slice(variableNode.text.length))
  }

  for (const child of rest) {
    const value = TreeSitterUtil.resolveStaticString(child)
    // The other values weren't statically determinable!
    if (value === null) return null
    values.push(value)
  }

  // Join all our found static values together.
  const staticResult = values.join('')
  // The path starts with slash, so trim the leading variable and replace with a dot
  if (staticResult.startsWith('/')) return `.${staticResult}`
  // The path doesn't start with a slash, so it's invalid
  // PERF: can we fail earlier than this?
  return null
}
