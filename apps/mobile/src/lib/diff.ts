/* Pure line-diff helpers — no dependencies. Used by the approvals file-write preview
   (old vs new) and the diff-artifact renderer. */

export type DiffLineKind = "add" | "del" | "context" | "hunk"

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

const MAX_LINES = 600

/** 超长文件走截断的「全删 + 全增」，避免把整份文件铺进 WebView。 */
const MAX_FALLBACK_LINES = 400

/** LCS-based line diff. Falls back to "all removed + all added" for very large inputs. */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length ? oldText.split("\n") : []
  const b = newText.length ? newText.split("\n") : []
  const m = a.length
  const n = b.length

  if (m > MAX_LINES || n > MAX_LINES) {
    const removed = a.slice(0, MAX_FALLBACK_LINES).map((text): DiffLine => ({ kind: "del", text }))
    const added = b.slice(0, MAX_FALLBACK_LINES).map((text): DiffLine => ({ kind: "add", text }))
    const omitted = m - removed.length + (n - added.length)
    return omitted > 0
      ? [...removed, ...added, { kind: "hunk", text: `… 省略 ${omitted} 行（文件过大）` }]
      : [...removed, ...added]
  }

  // lcs[i][j] = length of longest common subsequence of a[i:] and b[j:]
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", text: a[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "del", text: a[i] })
      i++
    } else {
      out.push({ kind: "add", text: b[j] })
      j++
    }
  }
  while (i < m) out.push({ kind: "del", text: a[i++] })
  while (j < n) out.push({ kind: "add", text: b[j++] })
  return out
}

/** Classify a unified-diff hunk line by its leading character. */
export function classifyHunkLine(line: string): DiffLineKind {
  if (line.startsWith("+")) return "add"
  if (line.startsWith("-")) return "del"
  return "context"
}

/** Leading sign shown for a diff line, keeping +/-/space alignment. */
export function diffSign(kind: DiffLineKind): string {
  if (kind === "add") return "+"
  if (kind === "del") return "-"
  if (kind === "hunk") return ""
  return " "
}
