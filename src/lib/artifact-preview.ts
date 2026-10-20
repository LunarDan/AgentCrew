import type { ArtifactContent } from '@/shared/types'

export function artifactPreviewPath(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/preview`
}

export function buildWebAppHtml(
  content: Extract<ArtifactContent, { type: 'web_app' }>,
): string {
  return buildIframeHtml(content.files, content.entry)
}

export function buildIframeHtml(files: Record<string, string>, entry: string): string {
  const html = files[entry] ?? files['index.html'] ?? ''
  const css = files['style.css'] ?? files['styles.css'] ?? ''
  const js = files['script.js'] ?? files['main.js'] ?? files['app.js'] ?? ''

  const styleTag = css ? `<style>\n${css}\n</style>` : ''
  const scriptTag = js ? `<script>(function(){\n${js}\n})();<` + '/script>' : ''

  if (/<\/head>/i.test(html)) {
    const withStyle = html.replace(/<\/head>/i, `${styleTag}\n</head>`)
    if (!scriptTag) return withStyle
    // 片段式 HTML 常常有 </head> 却没有 </body>：此时直接 replace 会静默丢掉脚本，
    // 产物的 JS 永远不执行（预览与部署后的运行时都受影响）。
    if (/<\/body>/i.test(withStyle)) {
      return withStyle.replace(/<\/body>/i, `${scriptTag}\n</body>`)
    }
    if (/<\/html>/i.test(withStyle)) {
      return withStyle.replace(/<\/html>/i, `${scriptTag}\n</html>`)
    }
    return `${withStyle}\n${scriptTag}`
  }

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    styleTag,
    '</head>',
    '<body>',
    html,
    scriptTag,
    '</body>',
    '</html>',
  ].join('\n')
}
