import { describe, expect, it } from 'vitest'

import { buildIframeHtml } from './artifact-preview'

const JS = 'console.log("hi")'

describe('buildIframeHtml', () => {
  it('injects css and the bundled script into a full document', () => {
    const html = buildIframeHtml(
      {
        'index.html': '<html><head><title>t</title></head><body><div/></body></html>',
        'style.css': 'body{color:red}',
        'script.js': JS,
      },
      'index.html',
    )
    expect(html).toContain('<style>')
    expect(html).toContain(JS)
    expect(html.indexOf(JS)).toBeLessThan(html.indexOf('</body>'))
  })

  it('appends the script when the fragment has </head> but no </body>', () => {
    const html = buildIframeHtml(
      {
        'index.html': '<html><head><title>t</title></head><div id="root"></div>',
        'script.js': JS,
      },
      'index.html',
    )
    expect(html).toContain(JS)
  })

  it('wraps a fragment without any document skeleton', () => {
    const html = buildIframeHtml(
      { 'index.html': '<div id="root"></div>', 'script.js': JS },
      'index.html',
    )
    expect(html).toContain('<!doctype html>')
    expect(html).toContain(JS)
  })
})
