import * as fs from 'fs'
import { Node, Project, ScriptKind, SyntaxKind } from 'ts-morph'
import type { SearchProvider, SearchProviderContext, ProviderMatch } from './types'

const SOURCE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx'])

interface StructuralMatcher {
  matchesQuery(query: string): boolean
  find(sourceFile: import('ts-morph').SourceFile): Node[]
  describe(count: number, firstLine: number): string
}

const MATCHERS: StructuralMatcher[] = [
  {
    matchesQuery: query => /catch\s+blocks?/.test(query) && /swallow(?:s|ed|ing)?\s+(?:errors?|exceptions?)/.test(query),
    find: sourceFile => sourceFile.getDescendantsOfKind(SyntaxKind.CatchClause)
      .filter(clause => clause.getBlock().getDescendantsOfKind(SyntaxKind.ThrowStatement).length === 0),
    describe: (count, line) => `${count} catch block${count === 1 ? '' : 's'} swallowing errors, first at line ${line}`,
  },
  {
    matchesQuery: query => /jsx\s+elements?/.test(query) && /onclick\s+(?:prop|property|attribute)/.test(query),
    find: sourceFile => sourceFile.getDescendants().filter(node => {
      if (!Node.isJsxElement(node) && !Node.isJsxSelfClosingElement(node)) return false
      const opening = Node.isJsxElement(node) ? node.getOpeningElement() : node
      return opening.getAttributes().some(attribute =>
        Node.isJsxAttribute(attribute) && attribute.getNameNode().getText().toLowerCase() === 'onclick')
    }),
    describe: (count, line) => `${count} JSX element${count === 1 ? '' : 's'} with an onClick prop, first at line ${line}`,
  },
]

export class ASTSearchProvider implements SearchProvider {
  readonly kind = 'ast' as const
  readonly label = 'AST'
  readonly defaultWeight = 0.6

  isAvailable(ctx: SearchProviderContext): boolean {
    return findMatcher(ctx.query) !== undefined
  }

  async search(ctx: SearchProviderContext): Promise<ProviderMatch[]> {
    const matcher = findMatcher(ctx.query)
    if (!matcher) return []
    const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
    const results: ProviderMatch[] = []

    for (const file of ctx.index.files) {
      const extension = file.extension.replace(/^\./, '').toLowerCase()
      if (!SOURCE_EXTENSIONS.has(extension)) continue
      let content: string
      try { content = fs.readFileSync(file.path, 'utf8') } catch { continue }

      const sourceFile = project.createSourceFile(file.relativePath, content, {
        overwrite: true,
        scriptKind: scriptKindFor(extension),
      })
      const matches = matcher.find(sourceFile)
      if (matches.length === 0) continue
      const firstLine = matches[0].getStartLineNumber()
      results.push({
        relativePath: file.relativePath,
        score: matches.length,
        confidence: Math.min(1, 0.7 + matches.length * 0.1),
        detail: matcher.describe(matches.length, firstLine),
      })
    }
    return results
  }
}

function findMatcher(query: string): StructuralMatcher | undefined {
  const normalized = query.trim().toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ')
  return MATCHERS.find(matcher => matcher.matchesQuery(normalized))
}

function scriptKindFor(extension: string): ScriptKind {
  if (extension === 'tsx') return ScriptKind.TSX
  if (extension === 'jsx') return ScriptKind.JSX
  if (extension === 'js') return ScriptKind.JS
  return ScriptKind.TS
}
