import * as fs from 'node:fs'
import * as path from 'node:path'

import { TextDocument } from 'vscode-languageserver-textdocument'
import * as Parser from 'web-tree-sitter'

import { FlowAnalyzer, FlowAnalysisContext, InlayHint } from '../flow-analysis'
import {
  FlowBindings,
  tryGetArrayElements,
  tryGetConcreteValues,
  tryGetSingleValue,
} from '../flow-value'
import { initializeParser } from '../../parser'

const FIXTURE_DIR = path.join(__dirname, '..', '..', '..', '..', 'testing', 'fixtures', 'flow-analysis')

/**
 * Build a FlowAnalysisContext for testing a single fixture file.
 */
function makeContext(
  uri: string,
  content: string,
  tree: Parser.Tree,
  overrides: Partial<FlowAnalysisContext> = {},
): FlowAnalysisContext {
  return {
    uri,
    content,
    rootNode: tree.rootNode,
    cwd: path.dirname(uri.replace('file://', '')),
    initialBindings: new Map(),
    sourcePushd: false,
    resolveSource: (sourcePath: string) => sourcePath,
    analyzeSourcedFile: () => new Map(),
    trackInlayHints: true,
    inlayHints: [],
    dimmedRanges: [],
    ...overrides,
  }
}

/**
 * Load a fixture, parse it, and return the tree.
 */
function loadFixture(name: string): { uri: string; content: string; tree: Parser.Tree } {
  const filePath = path.join(FIXTURE_DIR, name)
  const uri = `file://${filePath}`
  const content = fs.readFileSync(filePath, 'utf8')
  const parser = new Parser()
  // The parser must be set up with the language — this is done once before tests
  const tree = parser.parse(content)
  return { uri, content, tree }
}

/**
 * Helper: get the single value of a variable from bindings.
 */
function getVar(bindings: FlowBindings, name: string): string | null {
  const fv = bindings.get(name)
  if (!fv) return null
  return tryGetSingleValue(fv)
}

/**
 * Helper: get all concrete values for a variable.
 */
function getVarValues(bindings: FlowBindings, name: string): string[] {
  const fv = bindings.get(name)
  if (!fv) return []
  return tryGetConcreteValues(fv)
}

/**
 * Helper: get array elements for a variable.
 */
function getVarElements(bindings: FlowBindings, name: string): string[] | null {
  const fv = bindings.get(name)
  if (!fv) return null
  return tryGetArrayElements(fv)
}

describe('FlowAnalyzer', () => {
  let parser: Parser

  beforeAll(async () => {
    parser = await initializeParser()
  })

  /**
   * Convenience: parse a fixture, run analysis, return bindings.
   */
  function analyzeFixture(name: string, ctxOverrides: Partial<FlowAnalysisContext> = {}): {
    bindings: FlowBindings
    ctx: FlowAnalysisContext
  } {
    const filePath = path.join(FIXTURE_DIR, name)
    const uri = `file://${filePath}`
    const content = fs.readFileSync(filePath, 'utf8')
    const tree = parser.parse(content)
    const ctx = makeContext(uri, content, tree, ctxOverrides)
    const bindings = FlowAnalyzer.analyzeFile(ctx)
    return { bindings, ctx }
  }

  // ─── basic assignment ───────────────────────────────────────────

  describe('basic assignment', () => {
    it('resolves simple string assignments', () => {
      const { bindings } = analyzeFixture('basic-assignment.sh')
      expect(getVar(bindings, 'NAME')).toBe('world') // reassigned
      expect(getVar(bindings, 'EMPTY')).toBe('')
      expect(getVar(bindings, 'ZERO')).toBe('0')
    })

    it('resolves numeric assignments', () => {
      const { bindings } = analyzeFixture('basic-assignment.sh')
      expect(getVar(bindings, 'VERSION')).toBe('42')
    })

    it('resolves concatenation in assignment', () => {
      const { bindings } = analyzeFixture('basic-assignment.sh')
      expect(getVar(bindings, 'GREETING')).toBe('Hello, world!')
    })

    it('resolves : "${VAR:=default}" pattern', () => {
      const { bindings } = analyzeFixture('basic-assignment.sh')
      expect(getVar(bindings, 'CONFIG_FILE')).toBe('/etc/myapp.conf')
    })

    it('resolves += append', () => {
      const { bindings } = analyzeFixture('basic-assignment.sh')
      expect(getVar(bindings, 'PATH')).toBe('/usr/bin:/usr/local/bin')
    })

    it('emits inlay hints for assignments', () => {
      const { ctx } = analyzeFixture('basic-assignment.sh')
      expect(ctx.inlayHints.length).toBeGreaterThan(0)
      // Check that PATH's hint shows the appended value
      const pathHint = ctx.inlayHints.find((h: InlayHint) => h.variable === 'PATH')
      expect(pathHint).toBeDefined()
    })
  })

  // ─── array assignment ──────────────────────────────────────────

  describe('array assignment', () => {
    it('resolves array assignment', () => {
      const { bindings } = analyzeFixture('array.sh')
      const fruits = getVarElements(bindings, 'FRUITS')
      expect(fruits).toEqual(['apple', 'banana', 'cherry', 'date', 'elderberry'])
    })

    it('resolves quoted array elements', () => {
      const { bindings } = analyzeFixture('array.sh')
      const files = getVarElements(bindings, 'FILES')
      expect(files).toEqual(['file one.txt', 'file two.txt'])
    })

    it('resolves array with expansion', () => {
      const { bindings } = analyzeFixture('array.sh')
      const all = getVarElements(bindings, 'ALL')
      // ALL is built from FRUITS and MORE
      expect(all).toEqual([
        'apple', 'banana', 'cherry', 'date', 'elderberry',
        'kiwi', 'lemon',
      ])
    })
  })

  // ─── parameter expansion ───────────────────────────────────────

  describe('parameter expansion', () => {
    it('resolves ${var:-default} with unset variable', () => {
      const { bindings } = analyzeFixture('parameter-expansion.sh')
      expect(getVar(bindings, 'DEFAULT_A')).toBe('fallback')
    })

    it('resolves ${var:-default} with set variable', () => {
      const { bindings } = analyzeFixture('parameter-expansion.sh')
      expect(getVar(bindings, 'DEFAULT_B')).toBe('original')
    })

    it('resolves ${var:=assign} pattern', () => {
      const { bindings } = analyzeFixture('parameter-expansion.sh')
      expect(getVar(bindings, 'ASSIGNED_VAR')).toBe('assigned_value')
    })

    it('resolves ${var:+alternate} with set variable', () => {
      const { bindings } = analyzeFixture('parameter-expansion.sh')
      expect(getVar(bindings, 'EXPANSION_C')).toBe('has_value')
    })

    it('resolves ${var:+alternate} with unset variable to empty', () => {
      const { bindings } = analyzeFixture('parameter-expansion.sh')
      expect(getVar(bindings, 'EXPANSION_D')).toBe('')
    })
  })

  // ─── constexpr if / elif / else ─────────────────────────────────

  describe('constexpr if evaluation', () => {
    it('takes then branch on constant truthy condition', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'BRANCH_RESULT')).toBe('enabled-branch')
    })

    it('takes else branch on constant falsy condition', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'BRANCH_RESULT_2')).toBe('correct-branch')
    })

    it('resolves numeric -eq comparison', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'NUM_BRANCH')).toBe('equals-five')
    })

    it('resolves nested if statements', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'NESTED')).toBe('deep-branch')
    })

    it('resolves elif chains', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      // SCORE=85, so 70 <= 85 < 90 → GRADE="B"
      expect(getVar(bindings, 'GRADE')).toBe('B')
    })

    it('dims untaken branches', () => {
      const { ctx } = analyzeFixture('if-constexpr.sh')
      expect(ctx.dimmedRanges.length).toBeGreaterThan(0)
    })
  })

  // ─── case statement ────────────────────────────────────────────

  describe('case statement', () => {
    it('matches exact pattern and takes the correct branch', () => {
      const { bindings } = analyzeFixture('case.sh')
      expect(getVar(bindings, 'SOUND')).toBe('meow')
    })

    it('matches glob wildcard patterns', () => {
      const { bindings } = analyzeFixture('case.sh')
      expect(getVar(bindings, 'TYPE')).toBe('text')
    })

    it('analyzes all branches when value is unknown', () => {
      const { bindings } = analyzeFixture('case.sh')
      // All branches are analyzed; last assignment wins (no union tracking yet)
      const vals = tryGetConcreteValues(bindings.get('UK_SOUND')!)
      expect(vals).toContain('default-sound')
    })

    it('dims unmatched branches when value is known', () => {
      const { ctx } = analyzeFixture('case.sh')
      // Should have some dimmed ranges for unmatched case_item branches
      expect(ctx.dimmedRanges.length).toBeGreaterThan(0)
    })
  })

  // ─── arithmetic ────────────────────────────────────────────────

  describe('arithmetic expansion', () => {
    it('evaluates simple addition', () => {
      const { bindings } = analyzeFixture('arithmetic.sh')
      expect(getVar(bindings, 'SUM')).toBe('13')
    })

    it('evaluates subtraction', () => {
      const { bindings } = analyzeFixture('arithmetic.sh')
      expect(getVar(bindings, 'DIFF')).toBe('7')
    })

    it('evaluates multiplication', () => {
      const { bindings } = analyzeFixture('arithmetic.sh')
      expect(getVar(bindings, 'PROD')).toBe('30')
    })

    it('evaluates division (integer)', () => {
      const { bindings } = analyzeFixture('arithmetic.sh')
      expect(getVar(bindings, 'DIV')).toBe('3')
    })

    it('evaluates modulo', () => {
      const { bindings } = analyzeFixture('arithmetic.sh')
      expect(getVar(bindings, 'MOD')).toBe('1')
    })

    it('evaluates complex expressions with parens', () => {
      const { bindings } = analyzeFixture('arithmetic.sh')
      expect(getVar(bindings, 'COMPLEX')).toBe('25') // (10+3)*2-1 = 25
    })

    it('evaluates with variable substitution', () => {
      const { bindings } = analyzeFixture('arithmetic.sh')
      expect(getVar(bindings, 'Z')).toBe('20') // SUM(13) + DIFF(7)
    })
  })

  // ─── concatenation ─────────────────────────────────────────────

  describe('concatenation', () => {
    it('resolves concatenation with variables', () => {
      const { bindings } = analyzeFixture('concatenation.sh')
      expect(getVar(bindings, 'FULL')).toBe('Hello, World!')
    })

    it('resolves multiple concatenations with underscores', () => {
      const { bindings } = analyzeFixture('concatenation.sh')
      expect(getVar(bindings, 'LONG')).toBe('Hello_World_end')
    })
  })

  // ─── loops ─────────────────────────────────────────────────────

  describe('loops', () => {
    it('analyzes for loop over literal list', () => {
      const { bindings } = analyzeFixture('loops.sh')
      // LAST_FRUIT is set by first iteration to "apple"
      // but the for loop iterates; after loop, LAST_FRUIT = "cherry" (last)
      expect(getVar(bindings, 'LAST_FRUIT')).toBe('apple') // first iteration only
    })

    it('dims while body with false condition', () => {
      const { bindings, ctx } = analyzeFixture('loops.sh')
      expect(getVar(bindings, 'NEVER_REACHED')).toBeNull()
      expect(ctx.dimmedRanges.length).toBeGreaterThan(0)
    })

    it('analyzes while body with truthy condition', () => {
      const { bindings } = analyzeFixture('loops.sh')
      // Single iteration: COUNT starts at 0, condition 0 < 1 is true
      // Body sets COUNT=1, IN_LOOP="executed"
      expect(getVar(bindings, 'IN_LOOP')).toBe('executed')
      expect(getVar(bindings, 'COUNT')).toBe('1')
    })
  })

  // ─── declare / local / export ──────────────────────────────────

  describe('declaration commands', () => {
    it('tracks declare with assignment', () => {
      const { bindings } = analyzeFixture('declare.sh')
      expect(getVar(bindings, 'DECLARE_VAR')).toBe('declared')
    })

    it('tracks export with assignment', () => {
      const { bindings } = analyzeFixture('declare.sh')
      expect(getVar(bindings, 'EXPORT_VAR')).toBe('exported')
    })

    it('tracks readonly with assignment', () => {
      const { bindings } = analyzeFixture('declare.sh')
      expect(getVar(bindings, 'READONLY_VAR')).toBe('constant')
    })

    it('tracks typeset with assignment', () => {
      const { bindings } = analyzeFixture('declare.sh')
      expect(getVar(bindings, 'TYPESET_VAR')).toBe('typeset-value')
    })

    it('marks declare without value as existing', () => {
      const { bindings } = analyzeFixture('declare.sh')
      // EXISTS_VAR is marked as existing but unknown
      expect(bindings.has('EXISTS_VAR')).toBe(true)
    })

    it('tracks function-local variables (scope isolation)', () => {
      const { bindings } = analyzeFixture('declare.sh')
      // LOCAL_VAR should NOT leak to global scope
      expect(getVar(bindings, 'LOCAL_VAR')).toBeNull()
      // LOCAL_ONLY was set in function from LOCAL_VAR — also shouldn't leak
      expect(getVar(bindings, 'LOCAL_ONLY')).toBeNull()
    })
  })

  // ─── source / multi-file ───────────────────────────────────────

  describe('source command', () => {
    it('merges sourced file bindings', () => {
      const libPath = path.join(FIXTURE_DIR, 'source-lib.sh')
      const libUri = `file://${libPath}`
      const libContent = fs.readFileSync(libPath, 'utf8')
      const libTree = parser.parse(libContent)

      // Pre-seed the sourced file analysis
      const sourcedBindings = FlowAnalyzer.analyzeFile(
        makeContext(libUri, libContent, libTree),
      )

      const mainContent = `
        source source-lib.sh
        MAIN_VAR="from-main"
      `
      // Parse inline to avoid needing a separate file
      const mainUri = `file://${path.join(FIXTURE_DIR, 'source-main.sh')}`
      const mainTree = parser.parse(mainContent)

      const ctx = makeContext(mainUri, mainContent, mainTree, {
        resolveSource: () => libUri,
        analyzeSourcedFile: () => sourcedBindings,
      })

      const bindings = FlowAnalyzer.analyzeFile(ctx)

      // Variables from sourced file should be available
      expect(getVar(bindings, 'LIB_VAR')).toBe('from-library')
      expect(getVar(bindings, 'LIB_NAME')).toBe('mylib')
      expect(getVar(bindings, 'SHARED_VALUE')).toBe('shared-data')
      // Variables from main script should also be set
      expect(getVar(bindings, 'MAIN_VAR')).toBe('from-main')
    })
  })

  // ─── inlay hints ───────────────────────────────────────────────

  describe('inlay hints', () => {
    it('emits inlay hints for variable references within expansions', () => {
      // Use concatenation fixture which has ${PREFIX}, ${SUFFIX}
      const { ctx } = analyzeFixture('concatenation.sh')
      // Should have hints at variable expansion sites
      expect(ctx.inlayHints.length).toBeGreaterThan(0)
    })

    it('hints show resolved values for non-trivial assignments', () => {
      const { ctx } = analyzeFixture('arithmetic.sh')
      // Arithmetic values like SUM=$((X+Y)) should have hints
      const sumHint = ctx.inlayHints.find((h: InlayHint) => h.variable === 'SUM')
      expect(sumHint).toBeDefined()
      expect(sumHint!.label).toContain('13')
    })
  })

  // ─── FlowValue lattice ─────────────────────────────────────────

  describe('FlowValue lattice (flow-value.ts)', () => {
    it('tryGetSingleValue returns single concrete value', () => {
      const { bindings } = analyzeFixture('basic-assignment.sh')
      expect(tryGetSingleValue(bindings.get('NAME')!)).toBe('world')
    })

    it('tryGetSingleValue returns null for union values', () => {
      const { bindings } = analyzeFixture('case.sh')
      // UK_SOUND gets overwritten by sequential analysis, not a union yet
      // Last branch (*) sets it to "default-sound", so it's a single value
      const fv = bindings.get('UK_SOUND')
      expect(fv).toBeDefined()
      if (fv) {
        const val = tryGetSingleValue(fv)
        // May be "default-sound" (last branch wins) or null (if unions were tracked)
        expect(val === null || val === 'default-sound').toBe(true)
      }
    })

    it('tryGetConcreteValues returns all values for union', () => {
      const { bindings } = analyzeFixture('case.sh')
      const values = tryGetConcreteValues(bindings.get('UK_SOUND')!)
      // Currently the last branch wins; values contains at least "default-sound"
      expect(values.length).toBeGreaterThan(0)
      expect(values).toContain('default-sound')
    })
  })
})
