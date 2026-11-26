import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useT } from '../i18n'
import type { SpaceAccent, SpaceItem } from '../types'

const SPACE_SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: http: data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';"

const LOCAL_GATEWAY_IMG_RE = /\/api\/(?:spaces\/space-[0-9a-f]{8}\/assets\/[0-9a-f]{16}\.(?:png|jpg|webp|gif)|uploads\/[a-zA-Z0-9._-]+|screenshots\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)/g

const DARK_ACCENTS: Record<SpaceAccent, { accent: string; soft: string; border: string; glow: string }> = {
  blue: { accent: '#58a6ff', soft: 'rgba(88, 166, 255, 0.12)', border: 'rgba(88, 166, 255, 0.30)', glow: 'rgba(88, 166, 255, 0.16)' },
  indigo: { accent: '#818cf8', soft: 'rgba(129, 140, 248, 0.12)', border: 'rgba(129, 140, 248, 0.30)', glow: 'rgba(129, 140, 248, 0.16)' },
  emerald: { accent: '#34d399', soft: 'rgba(52, 211, 153, 0.11)', border: 'rgba(52, 211, 153, 0.28)', glow: 'rgba(52, 211, 153, 0.15)' },
  amber: { accent: '#f5b942', soft: 'rgba(245, 185, 66, 0.12)', border: 'rgba(245, 185, 66, 0.30)', glow: 'rgba(245, 185, 66, 0.15)' },
  rose: { accent: '#f47292', soft: 'rgba(244, 114, 146, 0.12)', border: 'rgba(244, 114, 146, 0.30)', glow: 'rgba(244, 114, 146, 0.16)' },
  slate: { accent: '#9aa3b2', soft: 'rgba(154, 163, 178, 0.12)', border: 'rgba(154, 163, 178, 0.28)', glow: 'rgba(154, 163, 178, 0.12)' },
}

const LIGHT_ACCENTS: Record<SpaceAccent, { accent: string; soft: string; border: string; glow: string }> = {
  blue: { accent: '#1d6ce0', soft: 'rgba(29, 108, 224, 0.09)', border: 'rgba(29, 108, 224, 0.28)', glow: 'rgba(29, 108, 224, 0.12)' },
  indigo: { accent: '#4f46e5', soft: 'rgba(79, 70, 229, 0.09)', border: 'rgba(79, 70, 229, 0.26)', glow: 'rgba(79, 70, 229, 0.12)' },
  emerald: { accent: '#0f9b6e', soft: 'rgba(15, 155, 110, 0.09)', border: 'rgba(15, 155, 110, 0.26)', glow: 'rgba(15, 155, 110, 0.11)' },
  amber: { accent: '#b86e0c', soft: 'rgba(184, 110, 12, 0.10)', border: 'rgba(184, 110, 12, 0.26)', glow: 'rgba(184, 110, 12, 0.12)' },
  rose: { accent: '#d93864', soft: 'rgba(217, 56, 100, 0.09)', border: 'rgba(217, 56, 100, 0.26)', glow: 'rgba(217, 56, 100, 0.12)' },
  slate: { accent: '#4c5566', soft: 'rgba(76, 85, 102, 0.08)', border: 'rgba(76, 85, 102, 0.24)', glow: 'rgba(76, 85, 102, 0.09)' },
}

function isSafeHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function currentThemeMode(): 'dark' | 'light' {
  if (typeof document === 'undefined') return 'dark'
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function hostTokensStyle(mode: 'dark' | 'light', accent: SpaceAccent): string {
  const palette = (mode === 'light' ? LIGHT_ACCENTS : DARK_ACCENTS)[accent]
  const vars = mode === 'light'
    ? `color-scheme: light;
      --bg: #f6f7f9; --bg-card: #ffffff; --bg-raised: #eef0f4; --bg-input: #ffffff; --bg-subtle: rgba(15,23,42,0.03);
      --text: #14161a; --text-dim: #525a69; --text-faint: #657082;
      --border: rgba(15,23,42,0.085); --border-strong: rgba(15,23,42,0.15);
      --green: #15803d; --amber: #b4690e; --red: #c93a33; --blue: #1d6ce0;`
    : `color-scheme: dark;
      --bg: #0c0f19; --bg-card: #1e2233; --bg-raised: #121625; --bg-input: #141827; --bg-subtle: rgba(71,81,122,0.14);
      --text: #ffffff; --text-dim: #aeb4c9; --text-faint: #7a7f93;
      --border: rgba(122,127,147,0.18); --border-strong: rgba(122,127,147,0.30);
      --green: #4ac976; --amber: #e3ad4b; --red: #ec5b53; --blue: #8c9ee8;`
  return `<style data-osb-host-tokens>
:root {
  ${vars}
  --space-accent: ${palette.accent};
  --space-accent-soft: ${palette.soft};
  --space-accent-border: ${palette.border};
  --space-accent-glow: ${palette.glow};
}
*, *::before, *::after { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: transparent;
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'PingFang SC', 'Helvetica Neue', sans-serif;
  font-size: 13px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
img { max-width: 100%; height: auto; }
a { color: var(--space-accent); }
</style>`
}

function canvasData(spaceTitle: string, theme: 'dark' | 'light', accent: SpaceAccent, locale: string, items: SpaceItem[]) {
  return {
    spaceTitle, theme, accent, locale,
    items: items.map(({ id, blockId, title, status, data, tainted, sortOrder, updatedAt }) => ({
      id, blockId, title, status, data, tainted, sortOrder, updatedAt,
    })),
  }
}

function hostBridgeScript(token: string, data: ReturnType<typeof canvasData>): string {
  const tokenJson = safeJsonForScript(token)
  const dataJson = safeJsonForScript(data)
  return `<script data-osb-host-bridge>
(function () {
  var TOKEN = ${tokenJson};
  window.SPACE_DATA = ${dataJson};
  var lastHeight = 0;
  function measure() {
    var body = document.body;
    if (!body) return;
    var h = Math.max(body.scrollHeight, body.offsetHeight);
    if (h > 0 && Math.abs(h - lastHeight) >= 2) {
      lastHeight = h;
      try { window.parent.postMessage({ type: 'osb-space-resize', token: TOKEN, height: h }, '*'); } catch (_) {}
    }
  }
  if (typeof ResizeObserver !== 'undefined') {
    var ro = new ResizeObserver(measure);
    if (document.body) ro.observe(document.body);
    else document.addEventListener('DOMContentLoaded', function () { if (document.body) ro.observe(document.body); measure(); });
  }
  window.addEventListener('load', measure);
  window.addEventListener('transitionend', measure);
  window.addEventListener('message', function (event) {
    var message = event.data;
    if (event.source !== window.parent || !message || message.token !== TOKEN || message.type !== 'osb-space-data') return;
    window.SPACE_DATA = message.data;
    window.dispatchEvent(new CustomEvent('space-data', { detail: window.SPACE_DATA }));
    requestAnimationFrame(measure);
  });
  setTimeout(measure, 80);
  setTimeout(measure, 320);
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (/^https?:\\/\\//i.test(href)) {
      ev.preventDefault();
      try { window.parent.postMessage({ type: 'osb-space-link', token: TOKEN, href: href }, '*'); } catch (_) {}
    }
  });
})();
</script>`
}

/** 剥离可能干扰沙箱的 <base> / meta refresh / meta CSP 标签后，拼装带强 CSP 与宿主主题变量的完整 HTML 文档 */
export function buildSandboxedHtmlDoc(opts: {
  html: string
  token: string
  themeMode: 'dark' | 'light'
  accent: SpaceAccent
  spaceTitle: string
  items: SpaceItem[]
  locale?: string
}): string {
  const cleaned = opts.html
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*['"]?(?:refresh|content-security-policy)['"]?[^>]*>/gi, '')

  const cspMeta = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${SPACE_SANDBOX_CSP}">`
  const tokens = hostTokensStyle(opts.themeMode, opts.accent)
  const head = cspMeta + tokens + hostBridgeScript(opts.token, canvasData(
    opts.spaceTitle, opts.themeMode, opts.accent, opts.locale ?? 'en', opts.items,
  ))

  if (/<html[\s>]/i.test(cleaned)) {
    return /<head[\s>]/i.test(cleaned)
      ? cleaned.replace(/<head([^>]*)>/i, (tag) => tag + head)
      : cleaned.replace(/<html([^>]*)>/i, (tag) => `${tag}<head>${head}</head>`)
  }

  return `<!doctype html><html><head>${head}</head><body>${cleaned}</body></html>`
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

export function SpaceHtmlFrame({
  title,
  html,
  fixedHeight,
  expanded,
  accent,
  spaceTitle,
  items,
}: {
  title: string
  html: string
  fixedHeight?: number
  expanded?: boolean
  accent: SpaceAccent
  spaceTitle: string
  items: SpaceItem[]
}) {
  const locale = useT().locale ?? 'en'
  const token = useId()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [themeMode, setThemeMode] = useState<'dark' | 'light'>(currentThemeMode)
  const [measuredHeight, setMeasuredHeight] = useState<number>(fixedHeight ?? 360)
  const [inlinedAssets, setInlinedAssets] = useState<Record<string, string>>({})

  // 跟随宿主明暗主题切换实时重绘
  useEffect(() => {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return
    const sync = () => setThemeMode(currentThemeMode())
    const obs = new MutationObserver(sync)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])

  const assetPaths = useMemo(() => {
    const paths = new Set(html.match(LOCAL_GATEWAY_IMG_RE) ?? [])
    for (const item of items) {
      for (const value of Object.values(item.data)) {
        if (typeof value === 'string' && value.startsWith('/api/') && value.match(LOCAL_GATEWAY_IMG_RE)?.[0] === value) {
          paths.add(value)
        }
      }
    }
    return [...paths].filter((path) => !path.includes('..'))
  }, [html, items])

  // Resolve authenticated image paths in markup and records before passing them into the opaque-origin frame.
  useEffect(() => {
    const missing = assetPaths.filter((p) => !inlinedAssets[p])
    if (!missing.length || typeof fetch !== 'function') return
    let cancelled = false
    void Promise.all(
      missing.map(async (path) => {
        try {
          const res = await fetch(path, { credentials: 'same-origin' })
          if (!res.ok) return null
          const blob = await res.blob()
          if (!blob.type.startsWith('image/')) return null
          const dataUrl = await blobToDataUrl(blob)
          return [path, dataUrl] as const
        } catch {
          return null
        }
      }),
    ).then((pairs) => {
      if (cancelled) return
      const next: Record<string, string> = {}
      for (const pair of pairs) {
        if (pair) next[pair[0]] = pair[1]
      }
      if (Object.keys(next).length) {
        setInlinedAssets((prev) => ({ ...prev, ...next }))
      }
    })
    return () => { cancelled = true }
  }, [assetPaths, inlinedAssets])

  // 监听来自该沙箱 iframe 的自动高度测量与安全外链点击
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return
      const payload = e.data as { type?: string; token?: string; height?: number; href?: string } | null
      if (!payload || payload.token !== token) return
      if (payload.type === 'osb-space-resize' && typeof payload.height === 'number' && Number.isFinite(payload.height)) {
        setMeasuredHeight(Math.max(160, Math.min(2400, Math.ceil(payload.height))))
      } else if (payload.type === 'osb-space-link' && typeof payload.href === 'string' && isSafeHttpUrl(payload.href)) {
        window.open(payload.href, '_blank', 'noopener,noreferrer')
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [token])

  const resolvedHtml = useMemo(() => {
    if (!Object.keys(inlinedAssets).length) return html
    return html.replace(LOCAL_GATEWAY_IMG_RE, (m) => inlinedAssets[m] ?? m)
  }, [html, inlinedAssets])

  const resolvedItems = useMemo(() => items.map((item) => ({
    ...item,
    data: Object.fromEntries(Object.entries(item.data).map(([key, value]) => [
      key, typeof value === 'string' ? inlinedAssets[value] ?? value : value,
    ])),
  })), [items, inlinedAssets])

  const live = /<html\b[^>]*\sdata-space-live(?:[\s=>])/i.test(html)
  const documentKey = JSON.stringify([resolvedHtml, themeMode, accent, spaceTitle, locale])
  const [initial, setInitial] = useState(() => ({ key: documentKey, items: resolvedItems }))
  if (live && initial.key !== documentKey) {
    setInitial({ key: documentKey, items: resolvedItems })
  }
  const documentItems = live ? initial.items : resolvedItems
  const srcDoc = useMemo(
    () => buildSandboxedHtmlDoc({ html: resolvedHtml, token, themeMode, accent, spaceTitle, locale, items: documentItems }),
    [resolvedHtml, token, themeMode, accent, spaceTitle, locale, documentItems],
  )
  const sendData = useCallback(() => {
    if (!live) return
    iframeRef.current?.contentWindow?.postMessage({
      type: 'osb-space-data',
      token,
      data: canvasData(spaceTitle, themeMode, accent, locale, resolvedItems),
    }, '*')
  }, [live, token, spaceTitle, themeMode, accent, locale, resolvedItems])
  useEffect(sendData, [sendData])

  const height = expanded
    ? Math.max(640, fixedHeight ?? measuredHeight)
    : (fixedHeight ?? measuredHeight)

  return (
    <iframe
      ref={iframeRef}
      className="space-html-iframe"
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={sendData}
      style={{ height: `${height}px` }}
    />
  )
}
