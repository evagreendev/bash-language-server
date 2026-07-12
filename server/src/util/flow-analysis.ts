/**
 * Flow-sensitive analysis engine for bash.
 *
 * Resolves variable values through control flow — arithmetic, parameter
 * expansion, and constant if/case branch evaluation — combining per-branch,
 * per-loop-iteration, and sourced-file values into a flow-value lattice.
 */
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as LSP from 'vscode-languageserver/node'
import { SyntaxNode } from 'web-tree-sitter'

import { parseShellCheckDirective } from '../shellcheck/directive'
import {
  ConcreteValue,
  concrete,
  concreteArray,
  DependentValue,
  FlowBindings,
  FlowValue,
  formatFlowValue,
  join,
  tryGetArrayElements,
  tryGetConcreteValues,
  tryGetSingleValue,
  unknown,
} from './flow-value'
import { untildify } from './fs'
import * as TreeSitterUtil from './tree-sitter'

/**
 * Context for flow analysis of a single file.
 */
export interface FlowAnalysisContext {
  /** URI of the file being analyzed. */
  uri: string
  /** The file content. */
  content: string
  /** The tree-sitter tree. */
  rootNode: SyntaxNode
  /** Current working directory for this file. */
  cwd: string
  /** Initial bindings (from env-init, seed variables, etc.). */
  initialBindings: FlowBindings
  /** Whether source-pushd is enabled. */
  sourcePushd: boolean
  /** Callback to resolve a sourced file. */
  resolveSource: (sourcePath: string, fromUri: string) => string | null
  /** Callback to analyze a sourced file and return its exported bindings. */
  analyzeSourcedFile: (uri: string) => FlowBindings
  /** Whether to track inlay hint ranges. */
  trackInlayHints: boolean
  /** Accumulated inlay hints for this file. */
  inlayHints: InlayHint[]
  /** Accumulated dimmed ranges for this file. */
  dimmedRanges: LSP.Range[]
}

/**
 * An inlay hint showing a resolved variable value.
 */
export interface InlayHint {
  /** The range where the inlay hint should be displayed. */
  position: LSP.Position
  /** The value to display. */
  label: string
  /** The variable name this hint is for. */
  variable?: string
  /** Optional padding text before the hint. */
  paddingLeft?: boolean
}

/**
 * A branch context captures the flow state for a specific branch.
 */
interface BranchContext {
  bindings: FlowBindings
  discriminator: { variable: string; values: string[]; polarity: 'positive' | 'negative' } | null
}

/**
 * Result of evaluating an expression node.
 */
interface EvalResult {
  success: boolean
  value?: FlowValue
  /** For arithmetic, the numeric result. */
  numericValue?: number
  /** Whether the expression is a constant truthy value. */
  isConstTruthy?: boolean
  /** Whether the expression is a constant falsy value. */
  isConstFalsy?: boolean
}

/**
 * The main flow analysis engine.
 */
export class FlowAnalyzer {
  /**
   * Analyze a single file and return the final flow bindings.
   * Also populates inlayHints and dimmedRanges on the context.
   */
  static analyzeFile(ctx: FlowAnalysisContext): FlowBindings {
    const bindings = new Map(ctx.initialBindings)

    // Track cd/pushd/popd for PWD updates
    let currentPwd = ctx.cwd

    // Walk the top-level nodes sequentially
    const programNode = ctx.rootNode
    if (!programNode) return bindings

    const children = programNode.namedChildren
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      FlowAnalyzer.analyzeNode(child, bindings, ctx, { pwd: currentPwd })
    }

    return bindings
  }

  /**
   * Analyze a single AST node in the given bindings context.
   */
  private static analyzeNode(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
    state: { pwd: string },
  ): void {
    switch (node.type) {
      case 'variable_assignment':
        FlowAnalyzer.analyzeAssignment(node, bindings, ctx)
        break

      case 'declaration_command':
        FlowAnalyzer.analyzeDeclarationCommand(node, bindings, ctx)
        break

      case 'command':
        FlowAnalyzer.analyzeCommand(node, bindings, ctx, state)
        break

      case 'if_statement':
        FlowAnalyzer.analyzeIfStatement(node, bindings, ctx, state)
        break

      case 'case_statement':
        FlowAnalyzer.analyzeCaseStatement(node, bindings, ctx, state)
        break

      case 'for_statement':
        FlowAnalyzer.analyzeForStatement(node, bindings, ctx, state)
        break

      case 'while_statement':
        FlowAnalyzer.analyzeWhileStatement(node, bindings, ctx, state)
        break

      case 'until_statement':
        FlowAnalyzer.analyzeWhileStatement(node, bindings, ctx, state) // same logic
        break

      case 'function_definition':
        // Functions are analyzed but we don't inline them into the parent scope
        // (they only affect parent scope when called, which requires full interprocedural
        // analysis — beyond scope for now)
        FlowAnalyzer.analyzeFunction(node, bindings, ctx, state)
        break

      case 'compound_statement':
        for (const child of node.namedChildren) {
          FlowAnalyzer.analyzeNode(child, bindings, ctx, state)
        }
        break

      case 'subshell':
        // Subshells get a copy of bindings; side effects on variable assignments
        // (without export/declare -g) don't affect parent
        // But we analyze them to find source commands etc.
        {
          const subshellBindings = new Map(bindings)
          for (const child of node.namedChildren) {
            FlowAnalyzer.analyzeNode(child, subshellBindings, ctx, state)
          }
        }
        break

      case 'simple_expansion':
      case 'expansion':
        // Generate reference inlay hints for variable references
        FlowAnalyzer.evaluateExpansion(node, bindings, ctx)
        break

      default:
        // For other nodes, recurse into children
        if (node.namedChildren && node.namedChildren.length > 0) {
          for (const child of node.namedChildren) {
            FlowAnalyzer.analyzeNode(child, bindings, ctx, state)
          }
        }
        break
    }
  }

  /**
   * Analyze a variable assignment and update bindings.
   */
  private static analyzeAssignment(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
  ): void {
    const varNameNode = node.descendantsOfType('variable_name')[0]
    if (!varNameNode) return

    const varName = varNameNode.text

    // Check if this is an array element assignment like ARR[0]=value
    const subscriptNode = node.descendantsOfType('subscript')[0]
    if (subscriptNode) {
      // Extract the index from the subscript's children (skip variable_name)
      const idxNode = subscriptNode.namedChildren.find(c => c.type !== 'variable_name')
      let idxText = idxNode?.text || ''
      const idx = parseInt(idxText, 10)

      // Find the value node after '='
      const subEqIndex = node.children.findIndex(c => c.type === '=')
      const subValueNode = subEqIndex >= 0 ? node.children.slice(subEqIndex + 1).find(
        c => c.type !== ';' && c.type !== '\n'
      ) : null

      const existing = bindings.get(varName)
      const existingElements = existing ? tryGetArrayElements(existing) : null
      const elements = existingElements ? [...existingElements] : []

      if (subValueNode && !isNaN(idx)) {
        const flowValue = FlowAnalyzer.evaluateExpression(subValueNode, bindings, ctx)
        const val = flowValue.success && flowValue.value ? tryGetSingleValue(flowValue.value) : null
        if (val !== null) {
          // Ensure array is large enough
          while (elements.length <= idx) elements.push('')
          elements[idx] = val
          bindings.set(varName, concreteArray(elements))

          if (ctx.trackInlayHints) {
            const hintLabel = formatFlowValue(concreteArray(elements))
            if (hintLabel) {
              ctx.inlayHints.push({
                position: LSP.Position.create(node.endPosition.row, node.endPosition.column),
                label: hintLabel,
                variable: varName,
                paddingLeft: true,
              })
            }
          }
        } else {
          bindings.set(varName, unknown())
        }
      }
      return
    }

    // Find the value node: children after the '=' or '+=' sign
    let eqIndex = node.children.findIndex(c => c.type === '=')
    if (eqIndex < 0) eqIndex = node.children.findIndex(c => c.type === '+=')
    const valueNode = eqIndex >= 0 ? node.children.slice(eqIndex + 1).find(
      c => c.type !== ';' && c.type !== '\n'
    ) : null

    if (!valueNode) {
      bindings.set(varName, unknown())
      return
    }

    // Handle += (append to array/string) — must check before array/scalar
    const plusEq = node.children.find(c => c.type === '+=')
    if (plusEq && valueNode) {
      const existing = bindings.get(varName)
      const existingElements = existing ? tryGetArrayElements(existing) : null

      // Check if valueNode is an array
      if (valueNode.type === 'array') {
        const newElements = FlowAnalyzer.extractArrayElements(valueNode, bindings)
        if (existingElements) {
          bindings.set(varName, concreteArray([...existingElements, ...newElements]))
        } else {
          bindings.set(varName, concreteArray(newElements))
        }
      } else {
        const flowValue = FlowAnalyzer.evaluateExpression(valueNode, bindings, ctx)
        const newVal = flowValue.success && flowValue.value ? tryGetSingleValue(flowValue.value) : null

        if (existingElements && newVal !== null) {
          bindings.set(varName, concreteArray([...existingElements, newVal]))
        } else if (existing && newVal !== null) {
          const oldVal = tryGetSingleValue(existing) || ''
          bindings.set(varName, concrete(oldVal + newVal))
        } else {
          bindings.set(varName, unknown())
        }
      }

      if (ctx.trackInlayHints) {
        const newBinding = bindings.get(varName)
        const hintLabel = newBinding ? formatFlowValue(newBinding) : null
        if (hintLabel) {
          ctx.inlayHints.push({
            position: LSP.Position.create(node.endPosition.row, node.endPosition.column),
            label: hintLabel,
            variable: varName,
            paddingLeft: true,
          })
        }
      }
      return
    }

    // Handle array assignment: ARR=(elem1 elem2 ...)
    if (valueNode.type === 'array') {
      const elements = FlowAnalyzer.extractArrayElements(valueNode, bindings)
      bindings.set(varName, concreteArray(elements))

      if (ctx.trackInlayHints) {
        const hintLabel = formatFlowValue(concreteArray(elements))
        if (hintLabel) {
          ctx.inlayHints.push({
            position: LSP.Position.create(node.endPosition.row, node.endPosition.column),
            label: hintLabel,
            variable: varName,
            paddingLeft: true,
          })
        }
      }
      return
    }

    // Regular scalar assignment
    const flowValue = FlowAnalyzer.evaluateExpression(valueNode, bindings, ctx)
    if (flowValue.success && flowValue.value) {
      bindings.set(varName, flowValue.value)

      // Track inlay hint
      if (ctx.trackInlayHints) {
        const hintLabel = formatFlowValue(flowValue.value)
        if (hintLabel) {
          ctx.inlayHints.push({
            position: LSP.Position.create(
              node.endPosition.row,
              node.endPosition.column,
            ),
            label: hintLabel,
            variable: varName,
            paddingLeft: true,
          })
        }
      }
    } else {
      // If we can't determine the value, set it to unknown
      bindings.set(varName, unknown())
    }
  }

  /**
   * Analyze a declaration command (local, declare, typeset, export, readonly).
   */
  private static analyzeDeclarationCommand(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
  ): void {
    // Treat like a variable assignment for the variables declared
    for (const child of node.namedChildren) {
      if (child.type === 'variable_assignment') {
        FlowAnalyzer.analyzeAssignment(child, bindings, ctx)
      } else if (child.type === 'variable_name') {
        // Bare name without assignment — just mark as existing but unknown
        bindings.set(child.text, unknown())
      }
    }
  }

  /**
   * Analyze a command node — handle cd, pushd, popd, source, export, etc.
   */
  private static analyzeCommand(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
    state: { pwd: string },
  ): void {
    const cmdNameNode = node.descendantsOfType('command_name')[0]
    if (!cmdNameNode) return

    const cmdName = cmdNameNode.text
    const args = node.namedChildren
      .filter(c => c !== cmdNameNode && c.type !== 'command_name')
    // For first argument, find the word
    const firstArg = args.length > 0 ? args[0] : null

    switch (cmdName) {
      case 'cd': {
        // Update PWD
        const newDir = FlowAnalyzer.resolvePathFromArg(firstArg, bindings, ctx, state.pwd)
        if (newDir) {
          state.pwd = newDir
          bindings.set('PWD', concrete(newDir, 'command-output'))
        }
        break
      }
      case 'pushd': {
        const newDir = FlowAnalyzer.resolvePathFromArg(firstArg, bindings, ctx, state.pwd)
        if (newDir) {
          // Track a stack (simplified: just update PWD)
          state.pwd = newDir
          bindings.set('PWD', concrete(newDir, 'command-output'))
        }
        break
      }
      case 'popd': {
        // Simplified: popd would need a stack. For now, set PWD to unknown.
        bindings.set('PWD', unknown())
        break
      }
      case 'source':
      case '.': {
        FlowAnalyzer.analyzeSourceCommand(node, bindings, ctx, state)
        break
      }
      case 'export':
      case 'readonly': {
        // export/readonly with assignment — analyze any variable assignments
        for (const child of node.namedChildren) {
          if (child.type === 'variable_assignment') {
            FlowAnalyzer.analyzeAssignment(child, bindings, ctx)
          }
        }
        break
      }
      default: {
        // For unrecognized commands, still check for : "${VAR:=default}" pattern
        FlowAnalyzer.analyzeColonDefaultPattern(node, bindings, ctx)
        // Also recurse into arguments to find variable references
        for (const child of node.namedChildren) {
          if (child.type !== 'command_name') {
            FlowAnalyzer.analyzeNode(child, bindings, ctx, state)
          }
        }
        break
      }
    }
  }

  /**
   * Resolve a path from a command argument, using flow analysis.
   */
  private static resolvePathFromArg(
    argNode: SyntaxNode | null,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
    currentPwd: string,
  ): string | null {
    if (!argNode) return null

    // Try to statically resolve the path
    const staticPath = TreeSitterUtil.resolveStaticString(argNode)
    if (staticPath !== null) {
      return FlowAnalyzer.resolveAbsolutePath(staticPath, currentPwd)
    }

    // Try to resolve using concatenation with known variables
    if (argNode.type === 'concatenation') {
      const resolved = FlowAnalyzer.resolveConcatenationWithBindings(argNode, bindings, ctx)
      if (resolved) {
        return FlowAnalyzer.resolveAbsolutePath(resolved, currentPwd)
      }
    }

    // Try to resolve using known variable values
    if (argNode.type === 'word') {
      const varName = argNode.text
      const binding = bindings.get(varName)
      if (binding) {
        const val = tryGetSingleValue(binding)
        if (val) {
          return FlowAnalyzer.resolveAbsolutePath(val, currentPwd)
        }
      }
    }

    if (argNode.type === 'string' && argNode.namedChildren.length === 1) {
      const child = argNode.namedChildren[0]
      if (TreeSitterUtil.isExpansion(child)) {
        const varName = child.text.startsWith('$') ? child.text.slice(1).replace(/[{}]/g, '') : child.text
        const binding = bindings.get(varName)
        if (binding) {
          const val = tryGetSingleValue(binding)
          if (val) {
            return FlowAnalyzer.resolveAbsolutePath(val, currentPwd)
          }
        }
      }
    }

    return null
  }

  /**
   * Resolve a path string to absolute, handling tilde and relative paths.
   */
  private static resolveAbsolutePath(filePath: string, currentPwd: string): string | null {
    let resolved = filePath
    if (resolved.startsWith('~')) {
      resolved = untildify(resolved)
    }
    if (!path.isAbsolute(resolved)) {
      resolved = path.join(currentPwd, resolved)
    }
    // Normalize but don't check existence (that's for the caller)
    try {
      return path.resolve(resolved)
    } catch {
      return null
    }
  }

  /**
   * Try to resolve a concatenation node using known variable bindings.
   */
  private static resolveConcatenationWithBindings(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
  ): string | null {
    if (node.type !== 'concatenation') return null

    const parts: string[] = []
    for (const child of node.namedChildren) {
      const staticPart = TreeSitterUtil.resolveStaticString(child)
      if (staticPart !== null) {
        parts.push(staticPart)
        continue
      }
      // Try variable resolution
      if (child.type === 'word') {
        const binding = bindings.get(child.text)
        if (binding) {
          const val = tryGetSingleValue(binding)
          if (val !== null) {
            parts.push(val)
            continue
          }
        }
      }
      if (child.type === 'expansion' || child.type === 'simple_expansion') {
        const varNameNode = child.descendantsOfType('variable_name')[0]
        if (varNameNode) {
          const binding = bindings.get(varNameNode.text)
          if (binding) {
            const val = tryGetSingleValue(binding)
            if (val !== null) {
              parts.push(val)
              continue
            }
          }
        }
      }
      // Can't resolve
      return null
    }

    return parts.join('')
  }

  /**
   * Analyze a source command, merging sourced file bindings.
   */
  private static analyzeSourceCommand(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
    state: { pwd: string },
  ): void {
    // Get the sourced path argument
    const cmdNameNode = node.descendantsOfType('command_name')[0]
    if (!cmdNameNode) return

    const namedChildren = node.namedChildren.filter(c => c !== cmdNameNode && c.type !== 'command_name')
    const sourcePathArg = namedChildren.length > 0 ? namedChildren[0] : null
    if (!sourcePathArg) return

    // Check for directives (shellcheck source=, source-fallback=)
    const commentNode = node.previousSibling?.type === 'comment' ? node.previousSibling : null
    let explicitPath: string | null = null
    let fallbackPath: string | null = null

    if (commentNode?.text.includes('shellcheck')) {
      const directives = parseShellCheckDirective(commentNode.text)
      for (const d of directives) {
        if (d.type === 'source') {
          explicitPath = d.path
        } else if ('path' in d && d.type === 'source-fallback') {
          fallbackPath = d.path
        }
      }
    }

    // Try to resolve the source path
    let resolvedUri: string | null = null

    if (explicitPath) {
      // Use the explicit source= path
      const resolved = FlowAnalyzer.resolveAbsolutePath(
        explicitPath,
        ctx.sourcePushd ? path.dirname(fileURLToPath(ctx.uri)) : state.pwd,
      )
      if (resolved) {
        resolvedUri = `file://${resolved}`
      }
    } else {
      // Try to resolve using flow analysis
      const resolvedPath = FlowAnalyzer.resolvePathFromArg(sourcePathArg, bindings, ctx, state.pwd)
      if (resolvedPath) {
        resolvedUri = `file://${resolvedPath}`
      } else if (fallbackPath) {
        // Use the source-fallback path
        const resolved = FlowAnalyzer.resolveAbsolutePath(
          fallbackPath,
          ctx.sourcePushd ? path.dirname(fileURLToPath(ctx.uri)) : state.pwd,
        )
        if (resolved) {
          resolvedUri = `file://${resolved}`
        }
      }
    }

    if (resolvedUri && ctx.resolveSource) {
      // Allow the context to resolve further
      const finalUri = ctx.resolveSource(resolvedUri, ctx.uri)
      if (finalUri) {
        // Merge sourced file bindings
        const sourcedBindings = ctx.analyzeSourcedFile(finalUri)
        for (const [key, value] of sourcedBindings) {
          const existing = bindings.get(key)
          if (existing) {
            bindings.set(key, join(existing, value))
          } else {
            bindings.set(key, value)
          }
        }
      }
    }
  }

  /**
   * Analyze an if statement with constant condition evaluation.
   */
  private static analyzeIfStatement(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
    state: { pwd: string },
  ): void {
    // Find condition
    const conditionNode = node.children.find(c =>
      ['test_command', 'bracket_expression', 'command', 'word'].includes(c.type)
    )

    const evalResult = conditionNode
      ? FlowAnalyzer.evaluateCondition(conditionNode, bindings, ctx)
      : { success: false }

    // Find the if body (the first command or compound_statement after 'then')
    const thenIdx = node.children.findIndex(c => c.type === 'then')
    let thenBody: SyntaxNode | null = null
    if (thenIdx >= 0) {
      for (let i = thenIdx + 1; i < node.children.length; i++) {
        const c = node.children[i]
        if (c.type === 'command' || c.type === 'compound_statement' || c.type === 'subshell') {
          thenBody = c
          break
        }
      }
    }

    // Find else/elif clauses — track position relative to 'then' keyword
    const thenChildIdx = node.children.findIndex(c => c.type === 'then')
    const elseClauses: { condition: SyntaxNode | null; body: SyntaxNode | null }[] = []
    for (const child of node.children) {
      const childIdx = node.children.indexOf(child)
      if (childIdx <= thenChildIdx) continue
      if (child.type === 'elif_clause') {
        const elifCondition = child.children.find(c =>
          c.type === 'test_command' || c.type === 'bracket_expression' || c.type === 'command'
        )
        const elifBody = child.children.find(c =>
          c.type === 'command' || c.type === 'compound_statement' || c.type === 'subshell'
        )
        elseClauses.push({ condition: elifCondition || null, body: elifBody || null })
      } else if (child.type === 'else_clause') {
        const elseBody = child.children.find(c =>
          c.type === 'command' || c.type === 'compound_statement' || c.type === 'subshell'
        )
        elseClauses.push({ condition: null, body: elseBody || null })
      }
    }

    // If condition is constant truthy, only analyze then branch, dim the rest
    if (evalResult.success && evalResult.isConstTruthy && thenBody) {
      // Analyze then body
      FlowAnalyzer.analyzeNode(thenBody, bindings, ctx, state)

      // Dim untaken branches
      if (ctx.trackInlayHints) {
        for (const clause of elseClauses) {
          if (clause.body) {
            ctx.dimmedRanges.push(TreeSitterUtil.range(clause.body))
          }
        }
      }
      return
    }

    // If condition is constant falsy, dim the then body, analyze else/elifs
    if (evalResult.success && evalResult.isConstFalsy) {
      if (thenBody && ctx.trackInlayHints) {
        ctx.dimmedRanges.push(TreeSitterUtil.range(thenBody))
      }

      // Analyze else/elif branches
      for (const clause of elseClauses) {
        if (clause.body) {
          if (clause.condition) {
            // For elif, we need to evaluate its condition too
            const elifEvalResult = FlowAnalyzer.evaluateCondition(clause.condition, bindings, ctx)
            if (elifEvalResult.isConstFalsy && ctx.trackInlayHints) {
              ctx.dimmedRanges.push(TreeSitterUtil.range(clause.body))
              continue
            }
          }
          FlowAnalyzer.analyzeNode(clause.body, bindings, ctx, state)
        }
      }
      return
    }

    // Fallback: analyze all branches (standard path-insensitive analysis)
    // But still try to carry discriminants into branches
    const discriminant = evalResult.success
      ? FlowAnalyzer.extractDiscriminant(conditionNode!, bindings, ctx)
      : null

    // Analyze then branch with discriminant
    if (thenBody) {
      const branchBindings = new Map(bindings)
      if (discriminant) {
        FlowAnalyzer.applyDiscriminant(branchBindings, discriminant, 'positive')
      }
      FlowAnalyzer.analyzeNode(thenBody, branchBindings, ctx, state)

      // Merge branch bindings back
      FlowAnalyzer.mergeBranchBindings(bindings, branchBindings)
    }

    // Analyze else/elif branches (with negated discriminant)
    for (const clause of elseClauses) {
      if (clause.body) {
        const branchBindings = new Map(bindings)
        if (discriminant && !clause.condition) {
          // Negate discriminant for else branch
          FlowAnalyzer.applyDiscriminant(branchBindings, discriminant, 'negative')
        }
        FlowAnalyzer.analyzeNode(clause.body, branchBindings, ctx, state)
        FlowAnalyzer.mergeBranchBindings(bindings, branchBindings)
      }
    }
  }

  /**
   * Analyze a case statement.
   */
  private static analyzeCaseStatement(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
    state: { pwd: string },
  ): void {
    // Get the case word — the value being matched (after 'case', before 'in')
    const caseWord = node.children.find(c =>
      c.type === 'word' || c.type === 'string' || c.type === 'concatenation' ||
      c.type === 'expansion' || c.type === 'simple_expansion' || c.type === 'variable_name'
    )
    if (!caseWord) return

    // Resolve the case word value
    const caseValue = FlowAnalyzer.tryResolveValue(caseWord, bindings)

    // Find case items
    const caseItems = node.descendantsOfType('case_item')
    let anyMatched = false

    for (const item of caseItems) {
      // The pattern is the first named child before the ')'
      const patternNode = item.namedChildren.find(c => c.type !== 'command' && c.type !== 'compound_statement')
      const bodyNode = item.namedChildren.find(c =>
        c.type === 'command' || c.type === 'compound_statement' || c.type === 'subshell'
      )

      if (patternNode && bodyNode) {
        const patternMatches = FlowAnalyzer.checkCasePattern(patternNode, caseValue)

        if (caseValue !== null && patternMatches) {
          FlowAnalyzer.analyzeNode(bodyNode, bindings, ctx, state)
          anyMatched = true
          break
        }

        if (caseValue !== null && !patternMatches && ctx.trackInlayHints) {
          ctx.dimmedRanges.push(TreeSitterUtil.range(item))
        }
      }
    }

    // If no branch matched but we had a known value, still need to analyze none
    // If the value was unknown, analyze all branches
    if (!anyMatched && caseValue === null) {
      for (const item of caseItems) {
        const bodyNode = item.namedChildren.find(c =>
          c.type === 'command' || c.type === 'compound_statement' || c.type === 'subshell'
        )
        if (bodyNode) {
          FlowAnalyzer.analyzeNode(bodyNode, bindings, ctx, state)
        }
      }
    }
  }

  /**
   * Check if a case pattern matches a value.
   */
  private static checkCasePattern(patternNode: SyntaxNode, value: string | null): boolean {
    if (value === null) return false

    // Get pattern text from the node
    const patternText = patternNode.text.trim()

    // Handle * wildcard (extglob_pattern or word containing *)
    if (patternText === '*') return true

    // Handle exact match - strip quotes if present
    let cleanPattern = patternText
    if ((cleanPattern.startsWith('"') && cleanPattern.endsWith('"')) ||
        (cleanPattern.startsWith("'") && cleanPattern.endsWith("'"))) {
      cleanPattern = cleanPattern.slice(1, -1)
    }

    // Handle multiple patterns separated by | (tree-sitter may split these)
    const patterns = cleanPattern.split('|').map(p => p.trim())

    for (const p of patterns) {
      if (p === value) return true

      // Handle * prefix/suffix (glob patterns)
      if (p.includes('*') || p.includes('?') || p.includes('[')) {
        if (FlowAnalyzer.globMatch(value, p)) return true
      }
    }

    return false
  }

  /**
   * Basic glob matching.
   */
  private static globMatch(str: string, pattern: string): boolean {
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
    try {
      const regex = new RegExp(`^${regexStr}$`)
      return regex.test(str)
    } catch {
      return false
    }
  }

  /**
   * Analyze a for statement.
   */
  private static analyzeForStatement(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
    state: { pwd: string },
  ): void {
    const varNode = node.descendantsOfType('variable_name')[0]
    if (!varNode) return

    const varName = varNode.text

    // Find the body
    const bodyNode = node.children.find(c =>
      c.type === 'compound_statement' || c.type === 'subshell'
    )
    if (!bodyNode) return

    // Find the word list
    const wordListNode = node.children.find(c => c.type === 'word')
    if (wordListNode) {
      const value = FlowAnalyzer.tryResolveValue(wordListNode, bindings)
      if (value !== null) {
        // Split by whitespace (simplified)
        const parts = value.split(/\s+/).filter(Boolean)
        if (parts.length > 0) {
          // Analyze body with first value (first iteration)
          // For full per-iteration, we'd analyze each value separately — simplified here
          const bodyBindings = new Map(bindings)
          bodyBindings.set(varName, concrete(parts[0]))
          FlowAnalyzer.analyzeNode(bodyNode, bodyBindings, ctx, state)
          // Merge back — for now, set var to union of all iteration values
          bindings.set(varName, {
            kind: 'concrete',
            values: parts.map(p => ({ text: p, origin: 'assignment' as const })),
          })
          return
        }
      }
    }

    // Unknown — analyze body with unknown
    const bodyBindings = new Map(bindings)
    bodyBindings.set(varName, unknown())
    FlowAnalyzer.analyzeNode(bodyNode, bodyBindings, ctx, state)
    bindings.set(varName, unknown())
  }

  /**
   * Analyze a while/until statement.
   */
  private static analyzeWhileStatement(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
    state: { pwd: string },
  ): void {
    const conditionNode = node.children.find(c =>
      ['test_command', 'bracket_expression', 'command', 'word'].includes(c.type)
    )

    const bodyNode = node.children.find(c =>
      c.type === 'compound_statement' || c.type === 'subshell'
    )
    if (!bodyNode) return

    // Evaluate condition
    if (conditionNode) {
      const evalResult = FlowAnalyzer.evaluateCondition(conditionNode, bindings, ctx)
      const isWhile = node.type === 'while_statement'

      if (evalResult.success) {
        const shouldRun = isWhile ? evalResult.isConstTruthy : evalResult.isConstFalsy

        if (shouldRun === false && ctx.trackInlayHints) {
          // Never executes — dim the body
          ctx.dimmedRanges.push(TreeSitterUtil.range(bodyNode))
          return
        }

        if (shouldRun === true) {
          // Always executes — analyze body (one iteration for now)
          FlowAnalyzer.analyzeNode(bodyNode, bindings, ctx, state)
          return
        }
      }
    }

    // Unknown — analyze body
    FlowAnalyzer.analyzeNode(bodyNode, bindings, ctx, state)
  }

  /**
   * Analyze a function definition (for function-scoped variable analysis).
   */
  private static analyzeFunction(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
    state: { pwd: string },
  ): void {
    // Functions create a new scope for local variables
    const bodyNode = node.children.find(c =>
      c.type === 'compound_statement' || c.type === 'subshell'
    )
    if (bodyNode) {
      const funcBindings = new Map(bindings)
      FlowAnalyzer.analyzeNode(bodyNode, funcBindings, ctx, state)
      // Function bodies are not automatically merged into parent scope
      // Shell functions only export when called
    }
  }

  /**
   * Merge branch bindings back into the parent.
   */
  private static mergeBranchBindings(parent: FlowBindings, branch: FlowBindings): void {
    for (const [key, value] of branch) {
      const existing = parent.get(key)
      if (existing && value !== existing) {
        parent.set(key, join(existing, value))
      } else if (!existing) {
        parent.set(key, value)
      }
    }
  }

  /**
   * Evaluate an expression (arithmetic, parameter expansion, etc.) in the
   * given bindings context.
   */
  private static evaluateExpression(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
  ): EvalResult {
    // Handle string/word literals
    const staticValue = TreeSitterUtil.resolveStaticString(node)
    if (staticValue !== null) {
      return {
        success: true,
        value: concrete(staticValue),
        isConstTruthy: staticValue.length > 0 && staticValue !== '0',
        isConstFalsy: staticValue.length === 0 || staticValue === '0',
      }
    }

    // Handle number literals
    if (node.type === 'number') {
      return {
        success: true,
        value: concrete(node.text, 'assignment'),
        isConstTruthy: node.text !== '0',
        isConstFalsy: node.text === '0',
      }
    }

    // Handle variable references
    if (node.type === 'variable_name') {
      const binding = bindings.get(node.text)
      if (binding) {
        return { success: true, value: binding }
      }
      return { success: true, value: unknown() }
    }

    // Handle expansions
    if (node.type === 'expansion' || node.type === 'simple_expansion') {
      return FlowAnalyzer.evaluateExpansion(node, bindings, ctx)
    }

    // Handle arithmetic expansion
    if (node.type === 'arithmetic_expansion') {
      return FlowAnalyzer.evaluateArithmetic(node, bindings, ctx)
    }

    // Handle command substitution
    if (node.type === 'command_substitution') {
      // Can't statically evaluate command output easily
      return { success: false }
    }

    // Handle concatenation
    if (node.type === 'concatenation') {
      return FlowAnalyzer.evaluateConcatenation(node, bindings, ctx)
    }

    // Handle word (could be a variable reference or a literal)
    if (node.type === 'word') {
      // First check if it's a known variable name
      const binding = bindings.get(node.text)
      if (binding) {
        return { success: true, value: binding }
      }
      // Otherwise return as literal
      return {
        success: true,
        value: concrete(node.text),
        isConstTruthy: node.text.length > 0 && node.text !== '0',
        isConstFalsy: node.text.length === 0 || node.text === '0',
      }
    }

    // Handle array nodes
    if (node.type === 'array') {
      // Collect all string/word children
      const parts: string[] = []
      for (const child of node.namedChildren) {
        const childVal = TreeSitterUtil.resolveStaticString(child)
        if (childVal !== null) {
          parts.push(childVal)
        } else if (child.type === 'word') {
          parts.push(child.text)
        } else if (child.type === 'string' && child.namedChildren.length === 0) {
          parts.push(child.text.slice(1, -1))
        }
      }
      if (parts.length > 0) {
        return {
          success: true,
          value: concrete(parts.join(' ')),
          isConstTruthy: true,
          isConstFalsy: false,
        }
      }
      return { success: false }
    }

    // Handle string with internal content
    if (node.type === 'string') {
      if (node.namedChildren.length === 0) {
        const innerText = node.text.slice(1, -1)
        return {
          success: true,
          value: concrete(innerText),
          isConstTruthy: innerText.length > 0 && innerText !== '0',
          isConstFalsy: innerText.length === 0 || innerText === '0',
        }
      }
      if (node.namedChildren.length === 1) {
        return FlowAnalyzer.evaluateExpression(node.namedChildren[0], bindings, ctx)
      }
    }

    return { success: false }
  }

  /**
   * Evaluate a condition expression for constant truthiness.
   */
  private static evaluateCondition(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
  ): EvalResult {
    // Handle [[ ... ]] / [ ... ]
    if (node.type === 'test_command') {
      const children = node.namedChildren

      // Handle binary_expression: [[ $x -eq 1 ]]
      if (children.length === 1 && children[0].type === 'binary_expression') {
        return FlowAnalyzer.evaluateBinaryExpression(children[0], bindings, ctx)
      }

      // Handle unary_expression: [[ -z "$VAR" ]]
      if (children.length === 1 && children[0].type === 'unary_expression') {
        return FlowAnalyzer.evaluateUnaryExpression(children[0], bindings, ctx)
      }

      if (children.length === 1) {
        // Simple test like [[ $x ]]
        const result = FlowAnalyzer.evaluateExpression(children[0], bindings, ctx)
        if (result.success && result.value) {
          const val = tryGetSingleValue(result.value)
          if (val !== null) {
            const truthy = val.length > 0 && val !== '0'
            return { success: true, isConstTruthy: truthy, isConstFalsy: !truthy }
          }
        }
        return { success: false }
      }

      return { success: false }
    }

    // Handle [[ ... ]] (extended test)
    if (node.type === 'bracket_expression') {
      // Simple: check for variable truthiness
      const result = FlowAnalyzer.evaluateExpression(node, bindings, ctx)
      if (result.success && result.value) {
        const val = tryGetSingleValue(result.value)
        if (val !== null) {
          return {
            success: true,
            isConstTruthy: val.length > 0 && val !== '0',
            isConstFalsy: val.length === 0 || val === '0',
          }
        }
      }
    }

    // Handle command conditions
    if (node.type === 'command') {
      const cmdNameNode = node.descendantsOfType('command_name')[0]
      if (cmdNameNode) {
        // [[, [, test commands with known outcomes
        const cmdName = cmdNameNode.text
        // Try to get args
        const args = node.namedChildren
          .filter(c => c.type === 'word' || c.type === 'string')
          .map(c => c.text)

        if (cmdName === 'true' || (cmdName === ':' && args.length === 0)) {
          return { success: true, isConstTruthy: true, isConstFalsy: false }
        }
        if (cmdName === 'false') {
          return { success: true, isConstTruthy: false, isConstFalsy: true }
        }

        // For 'test' or '[' commands, try evaluating the expression
        if (cmdName === 'test' || cmdName === '[') {
          if (args.length >= 2) {
            // Simple binary test
            const op = args[0]
            const left = args[1]
            const right = args[2]

            if (right !== undefined) {
              // Try to resolve left and right through bindings
              const leftBind = bindings.get(left)
              const rightBind = bindings.get(right)
              const leftVal = leftBind ? tryGetSingleValue(leftBind) : left
              const rightVal = rightBind ? tryGetSingleValue(rightBind) : right

              if (leftVal !== null && rightVal !== null) {
                switch (op) {
                  case '=':
                  case '==':
                    return {
                      success: true,
                      isConstTruthy: leftVal === rightVal,
                      isConstFalsy: leftVal !== rightVal,
                    }
                  case '!=':
                    return {
                      success: true,
                      isConstTruthy: leftVal !== rightVal,
                      isConstFalsy: leftVal === rightVal,
                    }
                }
              }
            }
          }
        }
      }
    }

    return { success: false }
  }

  /**
   * Extract a discriminant from a condition for dependent value tracking.
   */
  private static extractDiscriminant(
    conditionNode: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
  ): { variable: string; values: string[]; comparison: 'eq' | 'ne' } | null {
    if (conditionNode.type === 'test_command') {
      const children = conditionNode.namedChildren

      // Handle binary_expression: [[ $x -eq 1 ]]
      if (children.length === 1 && children[0].type === 'binary_expression') {
        const be = children[0]
        if (be.namedChildren.length >= 3) {
          return FlowAnalyzer.extractDiscriminantFromBinaryExpression(be.namedChildren)
        }
      }

      if (children.length === 3) {
        const op = children[0].text
        const left = children[1]
        const right = children[2]

        // Check if left is a variable name
        let varName: string | null = null
        let value: string | null = null

        if (left.type === 'expansion' || left.type === 'simple_expansion') {
          const varNode = left.descendantsOfType('variable_name')[0]
          if (varNode) varName = varNode.text
        } else if (left.type === 'word') {
          varName = left.text
        }

        const rightStatic = TreeSitterUtil.resolveStaticString(right)
        if (rightStatic !== null) {
          value = rightStatic
        }

        if (varName && value !== null) {
          if (op === '==' || op === '=') {
            return { variable: varName, values: [value], comparison: 'eq' }
          }
          if (op === '!=') {
            return { variable: varName, values: [value], comparison: 'ne' }
          }
        }

        // Swap: check if right is variable
        if (right.type === 'expansion' || right.type === 'simple_expansion') {
          const varNode = right.descendantsOfType('variable_name')[0]
          if (varNode) varName = varNode.text
        } else if (right.type === 'word') {
          varName = right.text
        }

        const leftStatic = TreeSitterUtil.resolveStaticString(left)
        if (leftStatic !== null) {
          value = leftStatic
        }

        if (varName && value !== null) {
          if (op === '==' || op === '=') {
            return { variable: varName, values: [value], comparison: 'eq' }
          }
          if (op === '!=') {
            return { variable: varName, values: [value], comparison: 'ne' }
          }
        }
      }
    }

    if (conditionNode.type === 'command') {
      // Check for [[ $x == foo ]] etc.
      const firstArg = conditionNode.namedChildren.find(c => c.type === 'word')
      if (firstArg) {
        const varName = firstArg.text
        if (varName && varName.startsWith('$')) {
          const cleanName = varName.replace(/^[$]+/, '').replace(/[{}]/g, '')
          // Check next args for operator and value
          const remaining = conditionNode.namedChildren.slice(1)
          if (remaining.length >= 2) {
            const op = remaining[0].text
            const val = TreeSitterUtil.resolveStaticString(remaining[1])
            if (val !== null && (op === '==' || op === '=' || op === '!=')) {
              return {
                variable: cleanName,
                values: [val],
                comparison: op === '!=' ? 'ne' : 'eq',
              }
            }
          }
        }
      }
    }

    return null
  }

  /**
   * Extract a discriminant from a binary_expression's named children [left, op, right]
   */
  private static extractDiscriminantFromBinaryExpression(
    children: SyntaxNode[],
  ): { variable: string; values: string[]; comparison: 'eq' | 'ne' } | null {
    if (children.length < 3) return null

    const op = children[1].text
    if (op !== '==' && op !== '=' && op !== '!=' && op !== '-eq' && op !== '-ne') return null

    let varName: string | null = null
    let value: string | null = null

    // Try left as variable
    if (children[0].type === 'simple_expansion' || children[0].type === 'expansion') {
      const vn = children[0].descendantsOfType('variable_name')[0]
      if (vn) varName = vn.text
    } else if (children[0].type === 'variable_name') {
      varName = children[0].text
    }
    value = TreeSitterUtil.resolveStaticString(children[2])
    // Also try number nodes
    if (value === null && children[2].type === 'number') value = children[2].text

    if (varName && value !== null) {
      const comp = (op === '!=' || op === '-ne') ? 'ne' as const : 'eq' as const
      return { variable: varName, values: [value], comparison: comp }
    }

    // Try right as variable
    varName = null
    value = null
    if (children[2].type === 'simple_expansion' || children[2].type === 'expansion') {
      const vn = children[2].descendantsOfType('variable_name')[0]
      if (vn) varName = vn.text
    } else if (children[2].type === 'variable_name') {
      varName = children[2].text
    }
    value = TreeSitterUtil.resolveStaticString(children[0])
    if (value === null && children[0].type === 'number') value = children[0].text

    if (varName && value !== null) {
      const comp = (op === '!=' || op === '-ne') ? 'ne' as const : 'eq' as const
      return { variable: varName, values: [value], comparison: comp }
    }

    return null
  }

  /**
   * Apply a discriminant to a set of bindings.
   */
  private static applyDiscriminant(
    bindings: FlowBindings,
    discriminant: { variable: string; values: string[]; comparison: 'eq' | 'ne' },
    polarity: 'positive' | 'negative',
  ): void {
    const varName = discriminant.variable
    const actualPolarity =
      discriminant.comparison === 'ne'
        ? polarity === 'positive'
          ? 'negative'
          : 'positive'
        : polarity

    if (actualPolarity === 'positive') {
      // Variable equals discriminant values
      bindings.set(varName, {
        kind: 'concrete',
        values: discriminant.values.map(v => ({
          text: v,
          origin: 'assignment' as const,
        })),
      })
    }
    // For negative polarity, we could add dependent value but for now just don't set
  }

  /**
   * Evaluate a binary_expression node (e.g., $x -eq 1 inside [[ ... ]])
   */
  private static evaluateBinaryExpression(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
  ): EvalResult {
    if (node.type !== 'binary_expression' || node.namedChildren.length < 3) {
      return { success: false }
    }

    const left = FlowAnalyzer.evaluateExpression(node.namedChildren[0], bindings, ctx)
    const op = node.namedChildren[1].text
    const right = FlowAnalyzer.evaluateExpression(node.namedChildren[2], bindings, ctx)

    if (!left.success || !right.success || !left.value || !right.value) {
      return { success: false }
    }

    const leftVal = tryGetSingleValue(left.value)
    const rightVal = tryGetSingleValue(right.value)

    if (leftVal === null || rightVal === null) {
      return { success: false }
    }

    const leftNum = Number(leftVal)
    const rightNum = Number(rightVal)
    const hasNumbers = !isNaN(leftNum) && !isNaN(rightNum)

    switch (op) {
      case '==':
      case '=':
        return { success: true, isConstTruthy: leftVal === rightVal, isConstFalsy: leftVal !== rightVal }
      case '!=':
        return { success: true, isConstTruthy: leftVal !== rightVal, isConstFalsy: leftVal === rightVal }
      case '-eq':
        return { success: true, isConstTruthy: hasNumbers && leftNum === rightNum, isConstFalsy: hasNumbers && leftNum !== rightNum }
      case '-ne':
        return { success: true, isConstTruthy: hasNumbers && leftNum !== rightNum, isConstFalsy: hasNumbers && leftNum === rightNum }
      case '-lt':
        return { success: true, isConstTruthy: hasNumbers && leftNum < rightNum, isConstFalsy: hasNumbers && leftNum >= rightNum }
      case '-gt':
        return { success: true, isConstTruthy: hasNumbers && leftNum > rightNum, isConstFalsy: hasNumbers && leftNum <= rightNum }
      case '-le':
        return { success: true, isConstTruthy: hasNumbers && leftNum <= rightNum, isConstFalsy: hasNumbers && leftNum > rightNum }
      case '-ge':
        return { success: true, isConstTruthy: hasNumbers && leftNum >= rightNum, isConstFalsy: hasNumbers && leftNum < rightNum }
      default:
        return { success: false }
    }
  }

  /**
   * Evaluate a unary_expression node (e.g., -z "$VAR" inside [[ ... ]])
   */
  private static evaluateUnaryExpression(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
  ): EvalResult {
    if (node.type !== 'unary_expression' || node.namedChildren.length < 2) {
      return { success: false }
    }

    const op = node.namedChildren[0].text
    const arg = FlowAnalyzer.evaluateExpression(node.namedChildren[1], bindings, ctx)

    if (!arg.success || !arg.value) {
      return { success: false }
    }

    const argVal = tryGetSingleValue(arg.value)

    switch (op) {
      case '-z':
        if (argVal !== null) {
          return { success: true, isConstTruthy: argVal.length === 0, isConstFalsy: argVal.length > 0 }
        }
        break
      case '-n':
        if (argVal !== null) {
          return { success: true, isConstTruthy: argVal.length > 0, isConstFalsy: argVal.length === 0 }
        }
        break
    }

    return { success: false }
  }

  /**
   * Evaluate a parameter expansion.
   */
  private static evaluateExpansion(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
  ): EvalResult {
    const varNameNode = node.descendantsOfType('variable_name')[0]
    if (!varNameNode) {
      return { success: false }
    }

    const varName = varNameNode.text
    const binding = bindings.get(varName)
    const expansionText = node.text

    // Handle array subscript: ${ARR[0]}, ${ARR[@]}, $ARR[@], etc.
    const subscriptNode = node.descendantsOfType('subscript')[0]
    if (subscriptNode) {
      const result = FlowAnalyzer.resolveArraySubscript(varName, subscriptNode, binding, node, ctx)
      if (result) return result
    }

    // ${var:-word}
    const defaultMatch = expansionText.match(/^\$\{(\w+):-(.+)\}$/)
    if (defaultMatch) {
      if (binding) {
        const val = tryGetSingleValue(binding)
        if (val !== null && val.length > 0) {
          // Variable is set — use its value
          FlowAnalyzer.emitReferenceHint(varName, binding, node, ctx)
          return { success: true, value: binding }
        }
        // Variable is empty or unset — use default
        const defaultVal = defaultMatch[2]
        return {
          success: true,
          value: concrete(defaultVal, 'parameter-expansion'),
        }
      }
      // Variable not in bindings — use default
      const defaultVal = defaultMatch[2]
      return {
        success: true,
        value: concrete(defaultVal, 'parameter-expansion'),
      }
    }

    // ${var:=word} — assign default
    const assignMatch = expansionText.match(/^\$\{(\w+):=(.+)\}$/)
    if (assignMatch) {
      if (binding) {
        const val = tryGetSingleValue(binding)
        if (val !== null && val.length > 0) {
          FlowAnalyzer.emitReferenceHint(varName, binding, node, ctx)
          return { success: true, value: binding }
        }
      }
      const assignVal = concrete(assignMatch[2], 'parameter-expansion')
      bindings.set(varName, assignVal)
      return { success: true, value: assignVal }
    }

    // ${var:+word} — alternate value
    const altMatch = expansionText.match(/^\$\{(\w+):\+(.+)\}$/)
    if (altMatch) {
      if (binding) {
        const val = tryGetSingleValue(binding)
        if (val !== null && val.length > 0) {
          return {
            success: true,
            value: concrete(altMatch[2], 'parameter-expansion'),
          }
        }
      }
      return { success: true, value: concrete('') }
    }

    // ${var:?word} — error if unset/null
    // Just passthrough for analysis

    // Simple $var or ${var}
    if (binding) {
      // Emit inlay hint for this variable reference
      FlowAnalyzer.emitReferenceHint(varName, binding, node, ctx)
      return { success: true, value: binding }
    }

    return { success: true, value: unknown() }
  }

  /**
   * Resolve an array subscript access like ${ARR[0]} or ${ARR[@]}.
   */
  private static resolveArraySubscript(
    varName: string,
    subscriptNode: SyntaxNode,
    binding: FlowValue | undefined,
    node: SyntaxNode,
    ctx: FlowAnalysisContext,
  ): EvalResult | null {
    if (!binding) return { success: true, value: unknown() }

    const elements = tryGetArrayElements(binding)
    if (!elements) return null // Not an array, fall through to normal handling

    // Extract the subscript value from the node's children — skip the variable_name
    // and the bracket punctuation. The subscript children are: variable_name, [, <value>, ]
    const idxNode = subscriptNode.namedChildren.find(
      c => c.type !== 'variable_name'
    )
    if (!idxNode) return { success: true, value: unknown() }

    const subscriptText = idxNode.text

    if (subscriptText === '@' || subscriptText === '*') {
      // ${ARR[@]} — return all elements
      const val = concreteArray(elements)
      FlowAnalyzer.emitReferenceHint(varName, val, node, ctx)
      return { success: true, value: val }
    }

    // Numeric index or variable index
    const idx = parseInt(subscriptText, 10)
    if (!isNaN(idx) && idx >= 0) {
      const elem = idx < elements.length ? elements[idx] : ''
      const val = concrete(elem)
      FlowAnalyzer.emitReferenceHint(varName, val, node, ctx)
      return { success: true, value: val }
    }

    // Could be a variable as index — try to resolve
    return { success: true, value: unknown() }
  }

  /**
   * Emit an inlay hint for a resolved variable reference.
   */
  private static emitReferenceHint(
    varName: string,
    binding: FlowValue,
    node: SyntaxNode,
    ctx: FlowAnalysisContext,
  ): void {
    if (!ctx.trackInlayHints) return

    const hintLabel = formatFlowValue(binding)
    if (!hintLabel) return

    // Place the hint at the end of the variable reference
    ctx.inlayHints.push({
      position: LSP.Position.create(
        node.endPosition.row,
        node.endPosition.column,
      ),
      label: hintLabel,
      variable: varName,
      paddingLeft: true,
    })
  }

  /**
   * Extract string elements from an array node, resolving variable references.
   */
  private static extractArrayElements(
    arrayNode: SyntaxNode,
    bindings: FlowBindings,
  ): string[] {
    const elements: string[] = []
    for (const child of arrayNode.namedChildren) {
      // Try static string resolution first
      const staticVal = TreeSitterUtil.resolveStaticString(child)
      if (staticVal !== null) {
        elements.push(staticVal)
        continue
      }

      // Direct word literal
      if (child.type === 'word') {
        // Check if it's a known variable
        const b = bindings.get(child.text)
        if (b) {
          const v = tryGetSingleValue(b)
          if (v !== null) { elements.push(v); continue }
        }
        elements.push(child.text)
        continue
      }

      // Direct number
      if (child.type === 'number') {
        elements.push(child.text)
        continue
      }

      // Direct expansion at top level: ( $VAR )
      if (child.type === 'simple_expansion' || child.type === 'expansion') {
        const varNode = child.descendantsOfType('variable_name')[0]
        if (varNode) {
          const b = bindings.get(varNode.text)
          if (b) {
            const v = tryGetSingleValue(b)
            if (v !== null) { elements.push(v); continue }
          }
        }
        elements.push(child.text)
        continue
      }

      // String with a single nested expansion: "$VAR"
      if (child.type === 'string' && child.namedChildren.length === 1) {
        const inner = child.namedChildren[0]
        if (inner.type === 'simple_expansion' || inner.type === 'expansion') {
          const varNode = inner.descendantsOfType('variable_name')[0]
          if (varNode) {
            const b = bindings.get(varNode.text)
            if (b) {
              const v = tryGetSingleValue(b)
              if (v !== null) { elements.push(v); continue }
            }
          }
        }
        // Empty quoted string
        elements.push(child.text.slice(1, -1))
        continue
      }

      // Bare string without expansions
      if (child.type === 'string' && child.namedChildren.length === 0) {
        elements.push(child.text.slice(1, -1))
        continue
      }

      // Raw string (single-quoted)
      if (child.type === 'raw_string') {
        elements.push(child.text.slice(1, -1))
        continue
      }

      // Concatenation: "$VAR"/suffix or prefix"$VAR"
      if (child.type === 'concatenation') {
        const parts: string[] = []
        for (const part of child.namedChildren) {
          const partStatic = TreeSitterUtil.resolveStaticString(part)
          if (partStatic !== null) {
            parts.push(partStatic)
          } else if (part.type === 'simple_expansion' || part.type === 'expansion') {
            const pvn = part.descendantsOfType('variable_name')[0]
            if (pvn) {
              const pb = bindings.get(pvn.text)
              if (pb) {
                const pv = tryGetSingleValue(pb)
                if (pv !== null) { parts.push(pv); continue }
              }
            }
            parts.push(part.text)
          } else if (part.type === 'word') {
            parts.push(part.text)
          } else if (part.type === 'string') {
            // Could contain a nested expansion
            if (part.namedChildren.length === 1) {
              const inner = part.namedChildren[0]
              if (inner.type === 'simple_expansion' || inner.type === 'expansion') {
                const ivn = inner.descendantsOfType('variable_name')[0]
                if (ivn) {
                  const ib = bindings.get(ivn.text)
                  if (ib) {
                    const iv = tryGetSingleValue(ib)
                    if (iv !== null) { parts.push(iv); continue }
                  }
                }
              }
            }
            parts.push(part.text.slice(1, -1))
          } else {
            parts.push(part.text)
          }
        }
        elements.push(parts.join(''))
        continue
      }

      // Fallback: push the raw text
      elements.push(child.text)
    }
    return elements
  }

  /**
   * Evaluate an arithmetic expression.
   */
  private static evaluateArithmetic(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
  ): EvalResult {
    // Arithmetic expressions can be complex. For now, handle simple cases.
    // The text is inside $(( ... )) or (( ... ))
    let expr = node.text
    // Strip outer $(( / )) or (( / ))
    if (expr.startsWith('$((')) expr = expr.slice(3, -2)
    else if (expr.startsWith('((')) expr = expr.slice(2, -2)

    // Replace known variables with their values
    let evalExpr = expr
    for (const [varName, flowVal] of bindings) {
      const val = tryGetSingleValue(flowVal)
      if (val !== null) {
        // Check if it's a valid number
        if (/^-?\d+$/.test(val)) {
          // Replace all occurrences of the variable name
          const varRegex = new RegExp(`\\b${varName}\\b`, 'g')
          evalExpr = evalExpr.replace(varRegex, val)
        }
      }
    }

    // Try to evaluate the arithmetic expression
    try {
      // Safe eval: only allow numbers, operators, and parens
      const safeExpr = evalExpr.replace(/[^0-9+\-*/().%\s]/g, '')
      if (safeExpr === evalExpr || safeExpr.length > 0) {
        const result = Function(`"use strict"; return (${safeExpr})`)()
        if (typeof result === 'number' && !isNaN(result)) {
          return {
            success: true,
            value: concrete(String(result), 'assignment', undefined),
            numericValue: result,
            isConstTruthy: result !== 0,
            isConstFalsy: result === 0,
          }
        }
      }
    } catch {
      // Can't evaluate
    }

    return { success: false }
  }

  /**
   * Evaluate a concatenation node.
   */
  private static evaluateConcatenation(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
  ): EvalResult {
    const parts: string[] = []
    let allStatic = true

    for (const child of node.namedChildren) {
      const staticPart = TreeSitterUtil.resolveStaticString(child)
      if (staticPart !== null) {
        parts.push(staticPart)
        continue
      }

      const childEval = FlowAnalyzer.evaluateExpression(child, bindings, ctx)
      if (childEval.success && childEval.value) {
        const val = tryGetSingleValue(childEval.value)
        if (val !== null) {
          parts.push(val)
          continue
        }
      }

      allStatic = false
    }

    if (allStatic || parts.length > 0) {
      const result = parts.join('')
      return {
        success: true,
        value: concrete(result),
        isConstTruthy: result.length > 0 && result !== '0',
        isConstFalsy: result.length === 0 || result === '0',
      }
    }

    return { success: false }
  }

  /**
   * Try to resolve a node to a single string value.
   */
  private static tryResolveValue(
    node: SyntaxNode,
    bindings: FlowBindings,
  ): string | null {
    const result = FlowAnalyzer.evaluateExpression(node, bindings, {
      uri: '',
      content: '',
      rootNode: node,
      cwd: '/',
      initialBindings: new Map(),
      sourcePushd: false,
      resolveSource: () => null,
      analyzeSourcedFile: () => new Map(),
      trackInlayHints: false,
      inlayHints: [],
      dimmedRanges: [],
    })

    if (result.success && result.value) {
      return tryGetSingleValue(result.value)
    }
    return null
  }

  /**
   * Analyze the ': "${VAR:=default}"' pattern.
   */
  private static analyzeColonDefaultPattern(
    node: SyntaxNode,
    bindings: FlowBindings,
    ctx: FlowAnalysisContext,
  ): void {
    if (node.type !== 'command') return
    if (!node.text.startsWith(': ')) return

    // Look for ${VAR:=default} patterns inside the command
    const stringNodes = node.namedChildren.filter(c => c.type === 'string')
    for (const strNode of stringNodes) {
      const assignMatch = strNode.text.match(/"\$\{(\w+):=(.+)\}"/)
      if (assignMatch) {
        const varName = assignMatch[1]
        const defaultVal = assignMatch[2]
        const existing = bindings.get(varName)
        if (!existing || existing.kind === 'bottom') {
          bindings.set(varName, concrete(defaultVal, 'parameter-expansion'))
        }
      }
    }
  }
}
