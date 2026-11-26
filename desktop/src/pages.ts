import type { FailReason } from './supervisor.js'

/**
 * 网关还没起来时窗口里显示的两页（「正在启动」和「出错了」）以及 macOS 菜单栏的「关于」小窗。
 * 都是 data: URL，不经网关、不带脚本以外的东西；错误页的 `osb:` 链接与关于页的 https 链接都由主进程 secureContents 接住。
 * 「复制诊断信息」只在页面里选中文字再复制（data: 页不是安全上下文，用不了 navigator.clipboard）。
 */
export type PageLang = 'en' | 'zh-CN'

export const AUTHOR_URL = 'https://github.com/wolfqing'
export const REPO_URL = 'https://github.com/wolfqing/OpenSuperBot'
export const CONTRIBUTORS_URL = 'https://github.com/wolfqing/OpenSuperBot/graphs/contributors'

const TEXT = {
  en: {
    starting: 'Starting OpenSuperBot…',
    startingHint: 'Your teammates’ gateway is coming up. This usually takes a second or two.',
    title: 'OpenSuperBot could not start',
    timeout: 'The gateway did not say it was ready within 30 seconds.',
    exited: 'The gateway stopped while it was starting.',
    crashed: 'The gateway stopped unexpectedly several times in a row, so it is no longer being restarted.',
    next: 'Try again. If it keeps happening, copy the diagnostics and open an issue on GitHub with them.',
    retry: 'Try again',
    copy: 'Copy diagnostics',
    copied: 'Copied',
    logs: 'Open the log folder',
    lastLines: 'Last lines of the log',
    aboutTitle: 'About OpenSuperBot',
    version: (v: string) => `Version ${v}`,
    creditsLead: 'Created and maintained by ',
    creditsMiddle: '. Thanks to all the ',
    contributors: 'open-source contributors',
    creditsTail: ' for their code, feedback, and ideas.',
    repo: 'GitHub',
    license: 'MIT License',
  },
  'zh-CN': {
    starting: '正在启动 OpenSuperBot…',
    startingHint: '同事们的网关正在起来，一般一两秒。',
    title: 'OpenSuperBot 没能启动',
    timeout: '网关 30 秒内没有说它准备好了。',
    exited: '网关在启动过程中退出了。',
    crashed: '网关接连意外退出了好几次，已经不再自动重启。',
    next: '先点「重试」。还不行的话，复制诊断信息，到 GitHub 上开一个 issue 贴上。',
    retry: '重试',
    copy: '复制诊断信息',
    copied: '已复制',
    logs: '打开日志所在文件夹',
    lastLines: '日志最后几行',
    aboutTitle: '关于 OpenSuperBot',
    version: (v: string) => `版本 ${v}`,
    creditsLead: '由 ',
    creditsMiddle: ' 发起并维护，感谢每一位提交代码、反馈问题和分享想法的',
    contributors: '开源贡献者',
    creditsTail: '。',
    repo: 'GitHub 仓库',
    license: 'MIT 开源协议',
  },
} as const

export const pageLang = (locale: string): PageLang => (locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en')

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

const STYLE = `
:root { color-scheme: dark light; --bg: #0c0f19; --card: #1e2233; --text: #ffffff; --dim: #aeb4c9; --border: rgba(122, 127, 147, 0.24); --red: #f06c6c; --glow: rgba(71, 81, 122, 0.22); --card-top: rgba(255, 255, 255, 0.065); --shadow: rgba(3, 5, 11, 0.56); }
@media (prefers-color-scheme: light) { :root { --bg: #f6f7f9; --card: #fff; --text: #14161a; --dim: #5c6270; --border: #dfe2e8; --red: #c93a33; --glow: transparent; --card-top: rgba(255, 255, 255, 0.8); --shadow: rgba(15, 23, 42, 0.12); } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 48px 24px 24px;
  background: radial-gradient(ellipse 72% 44% at 50% -10%, var(--glow), transparent 72%), var(--bg); color: var(--text); font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'PingFang SC', sans-serif;
  -webkit-font-smoothing: antialiased; }
.drag { position: fixed; top: 0; left: 0; right: 0; height: 44px; -webkit-app-region: drag; }
.card { width: min(620px, 100%); background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 24px 26px;
  box-shadow: inset 0 1px 0 var(--card-top), 0 22px 54px var(--shadow); }
h1 { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 8px; }
p { margin: 0 0 10px; color: var(--dim); }
.why { color: var(--red); }
.buttons { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
a.button, button { font: inherit; font-size: 13px; font-weight: 500; padding: 7px 13px; border-radius: 7px; border: 1px solid var(--border);
  background: transparent; color: var(--text); text-decoration: none; cursor: pointer; -webkit-app-region: no-drag; }
a.primary { background: var(--text); color: var(--bg); border-color: var(--text); }
textarea { width: 100%; height: 220px; font: 11.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text);
  background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; resize: vertical; -webkit-app-region: no-drag; }
label { display: block; font-size: 12px; color: var(--dim); margin-bottom: 5px; }
.spin { width: 18px; height: 18px; border: 2px solid var(--border); border-top-color: var(--text); border-radius: 50%;
  animation: s 0.9s linear infinite; margin-bottom: 14px; }
@keyframes s { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
`

function page(lang: PageLang, title: string, body: string, script = ''): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">`
    + `<title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="drag" aria-hidden="true"></div><main class="card">${body}</main>${script}</body></html>`
}

export function startingPage(lang: PageLang): string {
  const t = TEXT[lang]
  return page(lang, 'OpenSuperBot', `<div class="spin" aria-hidden="true"></div><h1>${esc(t.starting)}</h1><p>${esc(t.startingHint)}</p>`)
}

export function errorPage(lang: PageLang, reason: FailReason, diagnostics: string, tail: string[]): string {
  const t = TEXT[lang]
  const body = `<h1>${esc(t.title)}</h1>`
    + `<p class="why">${esc(t[reason])}</p><p>${esc(t.next)}</p>`
    + `<div class="buttons"><a class="button primary" href="osb:retry">${esc(t.retry)}</a>`
    + `<button id="copy" type="button">${esc(t.copy)}</button>`
    + `<a class="button" href="osb:logs">${esc(t.logs)}</a></div>`
    + `<label for="diag">${esc(t.lastLines)} (${tail.length})</label>`
    + `<textarea id="diag" readonly spellcheck="false">${esc(diagnostics)}</textarea>`
  const script = `<script>
document.getElementById('copy').addEventListener('click', function () {
  var box = document.getElementById('diag'); box.focus(); box.select();
  try { document.execCommand('copy'); this.textContent = ${JSON.stringify(t.copied)}; } catch (e) {}
});
</script>`
  return page(lang, t.title, body, script)
}

const ABOUT_STYLE = `
:root { color-scheme: dark light; --bg: #0c0f19; --text: #ffffff; --dim: #aeb4c9; --faint: #7a7f93; --border: rgba(122, 127, 147, 0.22); --link: #8c9ee8; --glow: rgba(71, 81, 122, 0.22); }
@media (prefers-color-scheme: light) { :root { --bg: #f6f7f9; --text: #14161a; --dim: #5c6270; --faint: #7d8594; --border: #dfe2e8; --link: #0969da; --glow: transparent; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
  padding: 36px 28px 24px; background: radial-gradient(ellipse 80% 48% at 50% -10%, var(--glow), transparent 72%), var(--bg); color: var(--text);
  font: 13px/1.6 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'PingFang SC', sans-serif;
  -webkit-font-smoothing: antialiased; user-select: none; }
.drag { position: fixed; top: 0; left: 0; right: 0; height: 36px; -webkit-app-region: drag; }
.icon { width: 64px; height: 64px; margin-bottom: 12px; filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.32)); }
h1 { font-size: 17px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 2px; }
.ver { margin: 0 0 16px; font-size: 12px; color: var(--faint); }
.credits { margin: 0 0 18px; color: var(--dim); max-width: 316px; user-select: text; }
.meta { width: 100%; padding-top: 14px; border-top: 1px solid var(--border); font-size: 12px; color: var(--faint); }
a { color: var(--link); text-decoration: none; -webkit-app-region: no-drag; }
a:hover { text-decoration: underline; }
`

const APP_ICON_SVG = `<svg class="icon" viewBox="0 0 100 100" aria-hidden="true">`
  + `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#282e3c"/><stop offset="100%" stop-color="#181c26"/></linearGradient></defs>`
  + `<rect width="100" height="100" rx="22.5" fill="url(#bg)"/>`
  + `<ellipse cx="50" cy="52.4" rx="26.4" ry="24" fill="#4d9fff"/>`
  + `<ellipse cx="41.6" cy="47.6" rx="6.6" ry="9" fill="#ffffff"/>`
  + `<ellipse cx="58.4" cy="47.6" rx="6.6" ry="9" fill="#ffffff"/>`
  + `<ellipse cx="42.8" cy="49.4" rx="3" ry="4.2" fill="#141820"/>`
  + `<ellipse cx="59.6" cy="49.4" rx="3" ry="4.2" fill="#141820"/>`
  + `</svg>`

export function aboutPage(lang: PageLang, version: string): string {
  const t = TEXT[lang]
  const body = `${APP_ICON_SVG}`
    + `<h1>OpenSuperBot</h1>`
    + `<p class="ver">${esc(t.version(version))}</p>`
    + `<p class="credits">${esc(t.creditsLead)}`
    + `<a href="${AUTHOR_URL}" target="_blank" rel="noreferrer">wolfqing</a>`
    + `${esc(t.creditsMiddle)}`
    + `<a href="${CONTRIBUTORS_URL}" target="_blank" rel="noreferrer">${esc(t.contributors)}</a>`
    + `${esc(t.creditsTail)}</p>`
    + `<div class="meta"><a href="${REPO_URL}" target="_blank" rel="noreferrer">${esc(t.repo)}</a>`
    + ` <span aria-hidden="true">·</span> ${esc(t.license)}</div>`
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`
    + `<title>${esc(t.aboutTitle)}</title><style>${ABOUT_STYLE}</style></head>`
    + `<body><div class="drag" aria-hidden="true"></div>${body}</body></html>`
}

/** 给 loadURL 用 */
export const dataUrl = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
