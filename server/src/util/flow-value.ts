/**
 * Flow-value lattice types for the bash flow-sensitive analysis engine.
 *
 * A flow value represents the possible values a variable can hold at a given
 * program point, forming a lattice:
 *
 *   Unknown (top)
 *    /   |   \
 *   Concrete values (union set)
 *    \   |   /
 *   Bottom (unreachable / undefined)
 *
 * Additionally, a flow value can be "dependent" — correlated with a discriminant
 * variable (e.g., inside `if [[ $x = "foo" ]]`, $x has dependent value "foo").
 */

import * as LSP from 'vscode-languageserver/node'

/**
 * A single concrete value resolved from flow analysis.
 */
export interface ConcreteValue {
  /** The string representation of this value. */
  text: string
  /** Optional location where this value was determined. */
  source?: LSP.Location
  /** Whether this value came from an arithmetic expression. */
  isArithmetic?: boolean
  /** The origin type (assignment, parameter-default, sourced-file, etc.) */
  origin: 'assignment' | 'parameter-expansion' | 'sourced-file' | 'env-init' | 'seed' | 'command-output'
  /** If this value originated from an array assignment, the individual elements. */
  elements?: string[]
}

/**
 * Represents a dependent value — a value that is correlated with a specific
 * discriminant variable being equal to one of a set of values.
 *
 * Example: inside `if [[ $x = "foo" ]]`, the discriminant is `x = foo`.
 */
export interface DependentValue {
  /** The discriminant variable name. */
  discriminant: string
  /** The values the discriminant must match. */
  discriminantValues: string[]
  /** The resulting values when the discriminant matches. */
  values: ConcreteValue[]
  /** Whether this dependent value is from a positive (==) or negative (!=) branch. */
  polarity: 'positive' | 'negative'
}

/**
 * A flow value — can be a concrete set of values, a set of dependent values,
 * unknown, or bottom.
 */
export type FlowValue =
  | { kind: 'concrete'; values: ConcreteValue[] }
  | { kind: 'dependent'; dependents: DependentValue[] }
  | { kind: 'union'; values: FlowValue[] }
  | { kind: 'unknown' }
  | { kind: 'bottom' }

/**
 * A map of variable names to their flow values.
 */
export type FlowBindings = Map<string, FlowValue>

/**
 * Helper to create a concrete flow value.
 */
export function concrete(value: string, origin: ConcreteValue['origin'] = 'assignment', source?: LSP.Location): FlowValue {
  return {
    kind: 'concrete',
    values: [{ text: value, origin, source }],
  }
}

/**
 * Helper to create a concrete flow value from an array of elements.
 */
export function concreteArray(elements: string[], origin: ConcreteValue['origin'] = 'assignment'): FlowValue {
  return {
    kind: 'concrete',
    values: [{ text: elements.join(' '), origin, elements }],
  }
}

/**
 * Helper to create an unknown flow value.
 */
export function unknown(): FlowValue {
  return { kind: 'unknown' }
}

/**
 * Helper to create a bottom flow value.
 */
export function bottom(): FlowValue {
  return { kind: 'bottom' }
}

/**
 * Merge two flow values (lattice join).
 */
export function join(a: FlowValue, b: FlowValue): FlowValue {
  if (a.kind === 'bottom') return b
  if (b.kind === 'bottom') return a
  if (a.kind === 'unknown' || b.kind === 'unknown') return { kind: 'unknown' }

  if (a.kind === 'concrete' && b.kind === 'concrete') {
    const allValues = [...a.values]
    for (const v of b.values) {
      if (!allValues.some(ev => ev.text === v.text)) {
        allValues.push(v)
      }
    }
    return { kind: 'concrete', values: allValues }
  }

  if (a.kind === 'union') {
    return { kind: 'union', values: [...a.values, b] }
  }
  if (b.kind === 'union') {
    return { kind: 'union', values: [a, ...b.values] }
  }

  if (a.kind === 'dependent' && b.kind === 'dependent') {
    return { kind: 'dependent', dependents: [...a.dependents, ...b.dependents] }
  }

  // mixed — widen to union
  return { kind: 'union', values: [a, b] }
}

/**
 * Try to get a single concrete string value, returning null if it's not
 * determinable.
 */
export function tryGetSingleValue(fv: FlowValue): string | null {
  if (fv.kind === 'concrete' && fv.values.length === 1) {
    return fv.values[0].text
  }
  return null
}

/**
 * Try to get all concrete values, deduplicated.
 */
export function tryGetConcreteValues(fv: FlowValue): string[] {
  if (fv.kind === 'concrete') {
    return fv.values.map(v => v.text)
  }
  if (fv.kind === 'union') {
    const results: string[] = []
    for (const v of fv.values) {
      results.push(...tryGetConcreteValues(v))
    }
    return [...new Set(results)]
  }
  if (fv.kind === 'dependent') {
    const results: string[] = []
    for (const d of fv.dependents) {
      for (const v of d.values) {
        results.push(v.text)
      }
    }
    return [...new Set(results)]
  }
  return []
}

/**
 * Try to get the array elements from a flow value, or null.
 */
export function tryGetArrayElements(fv: FlowValue): string[] | null {
  if (fv.kind === 'concrete') {
    for (const v of fv.values) {
      if (v.elements) return v.elements
    }
  }
  return null
}

/**
 * Whether the flow value represents a known value (concrete, union of concretes,
 * or dependents).
 */
export function hasKnownValue(fv: FlowValue): boolean {
  return fv.kind !== 'unknown' && fv.kind !== 'bottom'
}

/**
 * Format a flow value for display (used in inlay hints).
 */
export function formatFlowValue(fv: FlowValue): string | null {
  if (fv.kind === 'concrete') {
    if (fv.values.length === 0) return null
    if (fv.values.length === 1) {
      const v = fv.values[0]
      if (v.elements && v.elements.length > 0) {
        return `= (${v.elements.map(e => JSON.stringify(e)).join(' ')})`
      }
      return `= ${JSON.stringify(v.text)}`
    }
    return `∈ {${fv.values.map(v => JSON.stringify(v.text)).join(', ')}}`
  }
  if (fv.kind === 'dependent') {
    const parts = fv.dependents.map(d => {
      const vals = d.values.map(v => v.text)
      const op = d.polarity === 'positive' ? '=' : '≠'
      return `if ${d.discriminant} ${op} ${d.discriminantValues.join('|')} → ${vals.join('|')}`
    })
    return parts.join('; ')
  }
  if (fv.kind === 'union') {
    const parts = fv.values.map(v => formatFlowValue(v)).filter(Boolean)
    return parts.join(' | ') || null
  }
  return null
}
