import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ApiError, FieldErrors, SignedOut, downloadBrowser, fetchAbout, fetchDiagnostics, fetchLlmQueue, fetchQuietDigest, fetchSettings, fetchSetup, flushQuietDigest, saveSettings,
} from '../api'
import { desktopApi, type DesktopInfo } from '../desktop'
import { useT, type MessageKey } from '../i18n'
import { errorText } from '../i18n/describe'
import type {
  AboutInfo, BrowserStatus, ConnectionsState, FieldError, LlmQueueSnapshot, ProviderPreset, QuietDigestSummary, SettingsView, SetupInfo, ThemeSetting,
} from '../types'
import { connectionLabel, fieldText, isDefaultConnection } from './ModelsDialog'
import { BrowserLine, type LanguageSetting } from './SetupWizard'
import { StartAtLogin } from './StartAtLogin'
import { useEscape } from './ConfirmDialog'
import { XIcon } from './Icons'

type Computers = SettingsView['values']['computers']
const COMPUTERS: Computers[] = ['auto', 'local', 'docker']
const THEMES: ThemeSetting[] = ['dark', 'light', 'system']
const LOCAL_LLM_PRESETS = [1, 2, 4, 8] as const

function localLlmOptions(current: number): number[] {
  const set = new Set<number>(LOCAL_LLM_PRESETS)
  if (Number.isInteger(current) && current > 0) set.add(current)
  return [...[...set].sort((a, b) => a - b), 0]
}

function diagnosticsFilename(generatedAt?: string): string {
  const parsed = generatedAt ? new Date(generatedAt) : new Date()
  const d = Number.isNaN(parsed.getTime()) ? new Date() : parsed
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `opensuperbot-diagnostics-${stamp}.json`
}

/** 一块设置：标题 + 内容 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h2 className="settings-heading">{title}</h2>
      {children}
    </section>
  )
}

/**
 * 设置页：AI 模型（总表在「AI 模型」窗口里，这里给摘要、入口和重开向导）、语言、同事的电脑（种类、浏览器、镜像）、关于。
 * 被环境变量定死的项只读，说清楚去哪改；改了要重启才生效的，写明。
 * 桌面版多一块「桌面版」：开机自启（浏览器里打开没有这块）。
 */
export function SettingsDialog({ llms, providers, browser, language, onLanguage, theme, onTheme, onBrowser, onModels, onWizard, quietDigestTick, onSignedOut, onClose }: {
  llms: ConnectionsState | null
  providers: ProviderPreset[]
  /** 浏览器此刻的状态（经 /ws 实时更新）；null = 还没收到过，用拉回来的那份 */
  browser: BrowserStatus | null
  language: LanguageSetting
  onLanguage: (next: LanguageSetting) => void
  theme?: ThemeSetting
  onTheme?: (next: ThemeSetting) => void
  onBrowser: (next: BrowserStatus) => void
  onModels: () => void
  /** 重开设置向导：换服务商、从演示模式接真模型 */
  onWizard: () => void
  /** 经 /ws 推送的免打扰待投递变化计数 */
  quietDigestTick?: number
  onSignedOut: () => void
  onClose: () => void
}) {
  const t = useT()
  useEscape(onClose)
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [setup, setSetup] = useState<SetupInfo | null>(null)
  const [about, setAbout] = useState<AboutInfo | null>(null)
  /** 桌面版才有（preload 给的）；浏览器里打开是 null */
  const [desktop, setDesktop] = useState<DesktopInfo | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [errors, setErrors] = useState<FieldError[]>([])
  const [mirror, setMirror] = useState('')
  const [quietStart, setQuietStart] = useState('22:00')
  const [quietEnd, setQuietEnd] = useState('08:00')
  const [quietDigest, setQuietDigest] = useState<QuietDigestSummary | null>(null)
  const [llmQueue, setLlmQueue] = useState<LlmQueueSnapshot | null>(null)
  const [delivering, setDelivering] = useState(false)
  const [deliverMessage, setDeliverMessage] = useState<string | null>(null)
  const [deliverError, setDeliverError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [diagBusy, setDiagBusy] = useState<'copy' | 'download' | null>(null)
  const [diagMessage, setDiagMessage] = useState<string | null>(null)
  const [diagError, setDiagError] = useState<string | null>(null)

  const mountedRef = useRef(true)
  const digestReqSeqRef = useRef(0)
  const llmQueueReqSeqRef = useRef(0)
  const deliveringRef = useRef(false)
  const diagBusyRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    let live = true
    const digestSeq = ++digestReqSeqRef.current
    const queueSeq = ++llmQueueReqSeqRef.current
    const api = desktopApi()
    const desktopPromise: Promise<DesktopInfo | null> = api
      ? Promise.resolve(api.info()).catch(() => null)
      : Promise.resolve(null)
    const digestPromise: Promise<{ ok: true; value: QuietDigestSummary } | { ok: false; notFound: boolean }> = fetchQuietDigest()
      .then((value) => ({ ok: true as const, value }))
      .catch((err: unknown) => {
        if (err instanceof SignedOut) throw err
        return { ok: false as const, notFound: err instanceof ApiError && err.status === 404 }
      })
    const queuePromise: Promise<{ ok: true; value: LlmQueueSnapshot } | { ok: false; notFound: boolean }> = fetchLlmQueue()
      .then((value) => ({ ok: true as const, value }))
      .catch((err: unknown) => {
        if (err instanceof SignedOut) throw err
        return { ok: false as const, notFound: err instanceof ApiError && err.status === 404 }
      })
    Promise.all([fetchSettings(), fetchSetup(), fetchAbout(), desktopPromise, digestPromise, queuePromise])
      .then(([s, su, a, d, qd, lq]) => {
        if (!live) return
        setSettings(s)
        setMirror(s.values.browserMirror)
        setQuietStart(s.values.quietHoursStart ?? '22:00')
        setQuietEnd(s.values.quietHoursEnd ?? '08:00')
        setSetup(su)
        setAbout(a)
        setDesktop(d)
        if (digestSeq === digestReqSeqRef.current) {
          if (qd.ok) setQuietDigest(qd.value)
          else if (qd.notFound) setQuietDigest(null)
        }
        if (queueSeq === llmQueueReqSeqRef.current) {
          if (lq.ok) setLlmQueue(lq.value)
          else if (lq.notFound) setLlmQueue(null)
        }
      })
      .catch((err: unknown) => {
        if (err instanceof SignedOut) onSignedOut()
        else if (live) setLoadError(true)
      })
    return () => { live = false }
  }, [onSignedOut])

  const prevDigestTick = useRef(quietDigestTick)
  useEffect(() => {
    if (prevDigestTick.current === quietDigestTick) return
    prevDigestTick.current = quietDigestTick
    let live = true
    const seq = ++digestReqSeqRef.current
    void fetchQuietDigest()
      .then((qd) => {
        if (!live || seq !== digestReqSeqRef.current) return
        setQuietDigest(qd)
        if (qd.pendingCount > 0) setDeliverMessage(null)
      })
      .catch((err: unknown) => {
        if (err instanceof SignedOut) onSignedOut()
        else if (live && seq === digestReqSeqRef.current && err instanceof ApiError && err.status === 404) {
          setQuietDigest(null)
        }
      })
    return () => { live = false }
  }, [quietDigestTick, onSignedOut])

  const refreshQuietDigest = async () => {
    const seq = ++digestReqSeqRef.current
    try {
      const qd = await fetchQuietDigest()
      if (!mountedRef.current || seq !== digestReqSeqRef.current) return
      setQuietDigest(qd)
    } catch (err: unknown) {
      if (err instanceof SignedOut) onSignedOut()
      else if (mountedRef.current && seq === digestReqSeqRef.current && err instanceof ApiError && err.status === 404) {
        setQuietDigest(null)
      }
    }
  }

  const refreshLlmQueue = async () => {
    const seq = ++llmQueueReqSeqRef.current
    try {
      const lq = await fetchLlmQueue()
      if (!mountedRef.current || seq !== llmQueueReqSeqRef.current) return
      setLlmQueue(lq)
    } catch (err: unknown) {
      if (err instanceof SignedOut) onSignedOut()
      else if (mountedRef.current && seq === llmQueueReqSeqRef.current && err instanceof ApiError && err.status === 404) {
        setLlmQueue(null)
      }
    }
  }

  const deliverNow = async () => {
    if (delivering || saving || deliveringRef.current) return
    deliveringRef.current = true
    setDelivering(true)
    setErrors([])
    setDeliverMessage(null)
    setDeliverError(null)
    try {
      const res = await flushQuietDigest()
      if (!mountedRef.current) return
      setDeliverMessage(
        res.flushed === 1
          ? t('settings.quietHours.deliveredOne')
          : t('settings.quietHours.delivered', { count: res.flushed }),
      )
      await refreshQuietDigest()
    } catch (err: unknown) {
      if (err instanceof SignedOut) { onSignedOut(); return }
      if (!mountedRef.current) return
      const msg = err instanceof ApiError ? errorText(t, err).trim() : ''
      setDeliverError(msg || t('settings.quietHours.deliverFailed'))
    } finally {
      deliveringRef.current = false
      if (mountedRef.current) setDelivering(false)
    }
  }

  const clearQuietFeedback = () => {
    setErrors((prev) => (
      prev.some((x) => x.key === 'quietHoursStart' || x.key === 'quietHoursEnd')
        ? prev.filter((x) => x.key !== 'quietHoursStart' && x.key !== 'quietHoursEnd')
        : prev
    ))
    setDeliverMessage(null)
    setDeliverError(null)
  }

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true)
    setErrors([])
    try {
      const next = await saveSettings(patch)
      setSettings(next)
      return next
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut(); return null }
      setErrors(err instanceof FieldErrors ? err.errors : [{ key: '', code: 'invalid' }])
      return null
    } finally {
      setSaving(false)
    }
  }

  const download = async () => {
    setDownloading(true)
    try {
      onBrowser(await downloadBrowser())
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut(); return }
      const message = err instanceof ApiError ? errorText(t, err) : err instanceof Error ? err.message : String(err)
      setErrors([{ key: 'browser', code: message }])
    } finally {
      setDownloading(false)
    }
  }

  const copyDiagnostics = async () => {
    if (diagBusyRef.current) return
    diagBusyRef.current = true
    setDiagBusy('copy')
    setDiagMessage(null)
    setDiagError(null)
    try {
      const bundle = await fetchDiagnostics()
      if (!mountedRef.current) return
      const text = desktop
        ? `Desktop: ${desktop.version} (Electron ${desktop.electron})\n${bundle.summaryText}`
        : bundle.summaryText
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(text)
      if (!mountedRef.current) return
      setDiagMessage(t('settings.diagnostics.copied'))
    } catch (err: unknown) {
      if (err instanceof SignedOut) { onSignedOut(); return }
      if (mountedRef.current) setDiagError(t('settings.diagnostics.failed'))
    } finally {
      diagBusyRef.current = false
      if (mountedRef.current) setDiagBusy(null)
    }
  }

  const downloadDiagnostics = async () => {
    if (diagBusyRef.current) return
    diagBusyRef.current = true
    setDiagBusy('download')
    setDiagMessage(null)
    setDiagError(null)
    try {
      const bundle = await fetchDiagnostics()
      if (!mountedRef.current) return
      const payload = desktop
        ? { ...bundle, desktop: { version: desktop.version, electron: desktop.electron } }
        : bundle
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      try {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = diagnosticsFilename(bundle.generatedAt)
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      } finally {
        URL.revokeObjectURL(url)
      }
      if (!mountedRef.current) return
      setDiagMessage(t('settings.diagnostics.downloaded'))
    } catch (err: unknown) {
      if (err instanceof SignedOut) { onSignedOut(); return }
      if (mountedRef.current) setDiagError(t('settings.diagnostics.failed'))
    } finally {
      diagBusyRef.current = false
      if (mountedRef.current) setDiagBusy(null)
    }
  }

  const errorFor = (key: string) => {
    const e = errors.find((x) => x.key === key)
    return e ? <div className="form-error" role="alert">{fieldText(t, e)}</div> : null
  }
  const locked = (key: string) => settings?.sources[key] === 'env'
  const lockedNote = (name: string) => <p className="settings-locked">{t('settings.lockedBy', { name })}</p>

  const main = llms?.connections.find((c) => isDefaultConnection(c, llms.connections))
  const demo = main && !main.builtIn ? main.model === 'stub' : settings?.values.model === 'stub'
  const others = llms ? llms.connections.length - 1 : 0
  const running = about?.computers ?? setup?.computers.kind ?? null
  const live: BrowserStatus | null = browser ?? setup?.computers.browser ?? null
  const shownBrowser: BrowserStatus | null = downloading && (live?.state === 'missing' || live?.state === 'failed')
    ? { state: 'downloading', item: null, percent: null, totalMiB: null } : live
  const suggested = setup?.computers.browserMirror.suggested ?? null
  const whyKey = setup && setup.computers.choice === 'auto' && setup.computers.why && setup.computers.why !== 'chosen'
    ? (`setup.computer.why.${setup.computers.why}` as MessageKey) : null
  const why = (whyKey ? t(whyKey) : null) || (whyKey ? setup?.computers.reason ?? null : null)
  const savedQuietEnabled = Boolean(settings?.values.quietHoursEnabled)
  const savedQuietStart = settings?.values.quietHoursStart ?? '22:00'
  const savedQuietEnd = settings?.values.quietHoursEnd ?? '08:00'
  const quietDirty = quietStart !== savedQuietStart || quietEnd !== savedQuietEnd
  const localConcurrency = settings?.values.localLlmConcurrency ?? 1
  const llmQueueActive = llmQueue ? llmQueue.endpoints.reduce((sum, ep) => sum + ep.active, 0) : 0
  const llmQueueQueued = llmQueue ? llmQueue.endpoints.reduce((sum, ep) => sum + ep.queued, 0) : 0
  const scrimDown = useRef(false)

  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => { scrimDown.current = e.target === e.currentTarget }}
      onClick={(e) => { if (e.target === e.currentTarget && scrimDown.current) onClose(); scrimDown.current = false }}
    >
      <div className="modal modal-wide settings" role="dialog" aria-modal="true" aria-label={t('settings.title')} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">{t('settings.title')}</div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t('settings.close')} title={t('settings.close')}>
            <XIcon size={15} />
          </button>
        </div>
        {loadError ? <div className="form-error" role="alert">{t('settings.loadFailed')}</div> : null}
        {!settings && !loadError ? <p className="settings-dim">{t('settings.loading')}</p> : null}

        {settings ? (
          <>
            <Section title={t('settings.models')}>
              {demo ? (
                <p className="settings-line">{t('settings.demo')}</p>
              ) : main ? (
                <p className="settings-line">
                  {t('settings.defaultModel', { name: connectionLabel(main, providers, t), model: main.model })}
                  {others > 0 ? <span className="settings-dim"> · {t(others === 1 ? 'settings.moreOne' : 'settings.moreMany', { count: others })}</span> : null}
                </p>
              ) : null}
              <div className="settings-buttons">
                {demo ? <button type="button" className="primary" onClick={onWizard}>{t('settings.connectReal')}</button> : null}
                {llms ? <button type="button" onClick={onModels}>{t('settings.manageModels')}</button> : null}
                {demo ? null : <button type="button" onClick={onWizard}>{t('settings.rerunWizard')}</button>}
              </div>
              <div className="settings-local-llm">
                <div className="settings-local-llm-row">
                  <label className="conn-label" htmlFor="settings-local-llm-concurrency">
                    {t('settings.localLlm.label')}
                  </label>
                  <select
                    id="settings-local-llm-concurrency"
                    aria-label={t('settings.localLlm.label')}
                    value={String(localConcurrency)}
                    disabled={locked('localLlmConcurrency') || saving}
                    onChange={(e) => {
                      const nextConcurrency = Number(e.target.value)
                      void save({ localLlmConcurrency: nextConcurrency }).then((next) => {
                        if (next) return refreshLlmQueue()
                      })
                    }}
                  >
                    {localLlmOptions(localConcurrency).map((count) => (
                      <option key={count} value={String(count)}>
                        {count === 1
                          ? t('settings.localLlm.one')
                          : count === 0
                            ? t('settings.localLlm.unlimited')
                            : t('settings.localLlm.option', { count })}
                      </option>
                    ))}
                  </select>
                </div>
                {llmQueueActive > 0 || llmQueueQueued > 0 ? (
                  <div className="settings-local-llm-status" role="status">
                    {llmQueueQueued > 0
                      ? t('settings.localLlm.queueBusy', { active: llmQueueActive, queued: llmQueueQueued })
                      : t('settings.localLlm.queueActive', { active: llmQueueActive })}
                  </div>
                ) : null}
                {locked('localLlmConcurrency') ? lockedNote('OPENSUPERBOT_LOCAL_LLM_CONCURRENCY') : null}
                {errorFor('localLlmConcurrency')}
                <p className="setup-hint">{t('settings.localLlm.hint')}</p>
              </div>
            </Section>

            <Section title={t('setup.welcome.language')}>
              <div className="setup-langs">
                {(['', 'zh-CN', 'en'] as const).map((l) => (
                  <label key={l || 'system'} className="setup-radio">
                    <input
                      type="radio" name="settings-language" checked={language === l}
                      onChange={() => { void save({ language: l }); onLanguage(l) }}
                    />
                    {l === '' ? t('setup.welcome.languageSystem') : l === 'zh-CN' ? '简体中文' : 'English'}
                  </label>
                ))}
              </div>
              {errorFor('language')}
            </Section>

            <Section title={t('settings.theme')}>
              <div className="setup-langs">
                {THEMES.map((mode) => (
                  <label key={mode} className="setup-radio">
                    <input
                      type="radio" name="settings-theme" checked={(theme ?? settings.values.theme ?? 'dark') === mode}
                      onChange={() => { onTheme?.(mode); void save({ theme: mode }) }}
                    />
                    {t(`settings.theme.${mode}` as MessageKey)}
                  </label>
                ))}
              </div>
              {errorFor('theme')}
            </Section>

            <Section title={t('settings.quietHours.title')}>
              <div className="settings-quiet-hours">
                <label className="conn-check-row settings-quiet-toggle">
                  <input
                    type="checkbox"
                    checked={savedQuietEnabled}
                    disabled={saving}
                    onChange={(e) => {
                      const checked = e.target.checked
                      setDeliverMessage(null)
                      setDeliverError(null)
                      void save({ quietHoursEnabled: checked }).then((next) => {
                        if (next) return refreshQuietDigest()
                      })
                    }}
                  />
                  <span>{t('settings.quietHours.enable')}</span>
                </label>
                <p className="setup-hint">{t('settings.quietHours.hint')}</p>
                {errorFor('quietHoursEnabled')}

                <form
                  className="settings-quiet-form"
                  onSubmit={(e) => {
                    e.preventDefault()
                    setDeliverMessage(null)
                    setDeliverError(null)
                    void save({ quietHoursStart: quietStart, quietHoursEnd: quietEnd }).then((next) => {
                      if (next) {
                        setQuietStart(next.values.quietHoursStart ?? quietStart)
                        setQuietEnd(next.values.quietHoursEnd ?? quietEnd)
                        return refreshQuietDigest()
                      }
                    })
                  }}
                >
                  <div className="settings-quiet-times">
                    <label className="settings-quiet-time">
                      <span className="conn-label">{t('settings.quietHours.start')}</span>
                      <input
                        type="time"
                        value={quietStart}
                        disabled={saving}
                        onChange={(e) => {
                          setQuietStart(e.target.value)
                          clearQuietFeedback()
                        }}
                      />
                    </label>
                    <label className="settings-quiet-time">
                      <span className="conn-label">{t('settings.quietHours.end')}</span>
                      <input
                        type="time"
                        value={quietEnd}
                        disabled={saving}
                        onChange={(e) => {
                          setQuietEnd(e.target.value)
                          clearQuietFeedback()
                        }}
                      />
                    </label>
                    <div className="settings-buttons settings-quiet-save">
                      <button
                        type="submit"
                        aria-label={`${t('settings.save')} (${t('settings.quietHours.title')})`}
                        disabled={saving || !quietDirty}
                      >
                        {t('settings.save')}
                      </button>
                    </div>
                  </div>
                  {savedQuietEnabled && quietStart === quietEnd ? (
                    <p className="settings-quiet-warning" role="status">{t('settings.quietHours.sameTimeWarning')}</p>
                  ) : null}
                  {errorFor('quietHoursStart')}
                  {errorFor('quietHoursEnd')}
                </form>

                {quietDigest ? (
                  <div className="settings-quiet-status">
                    <div className="settings-quiet-meta">
                      <span className="settings-quiet-tz">{t('settings.quietHours.timezone', { tz: quietDigest.timeZone })}</span>
                      {quietDigest.active ? (
                        <span className="settings-quiet-active-badge">{t('settings.quietHours.activeNow')}</span>
                      ) : null}
                    </div>
                    <div className="settings-quiet-pending-row">
                      <span className="settings-quiet-pending">
                        {quietDigest.pendingCount === 0
                          ? t('settings.quietHours.pendingNone')
                          : quietDigest.pendingCount === 1
                            ? t('settings.quietHours.pendingOne')
                            : t('settings.quietHours.pendingMany', { count: quietDigest.pendingCount })}
                      </span>
                      {quietDigest.pendingCount > 0 ? (
                        <button
                          type="button"
                          className="settings-quiet-deliver"
                          disabled={delivering || saving}
                          onClick={() => void deliverNow()}
                        >
                          {delivering ? t('settings.quietHours.delivering') : t('settings.quietHours.deliverNow')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {deliverMessage ? <p className="settings-quiet-delivered" role="status">{deliverMessage}</p> : null}
                {deliverError ? <div className="form-error" role="alert">{deliverError}</div> : null}
              </div>
            </Section>

            <Section title={t('setup.computer.title')}>
              {running ? (
                <p className="settings-line">
                  {t('settings.computers.running', { kind: t(running === 'local' ? 'settings.computers.local' : 'settings.computers.docker') })}
                </p>
              ) : null}
              {why ? <p className="setup-hint">{why}</p> : null}
              <fieldset className="settings-choices" disabled={locked('computers') || saving}>
                <legend className="conn-label">{t('settings.computers.choice')}</legend>
                {COMPUTERS.map((k) => (
                  <label key={k} className="settings-choice">
                    <input type="radio" name="computers" checked={settings.values.computers === k} onChange={() => void save({ computers: k })} />
                    <span>
                      <span className="settings-choice-name">{t(`settings.computers.${k}` as MessageKey)}</span>
                      <span className="settings-dim">{t(`settings.computers.${k}Hint` as MessageKey)}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {locked('computers') ? lockedNote('OPENSUPERBOT_COMPUTERS') : null}
              {settings.needsRestart.includes('computers') ? <p className="settings-restart" role="status">{t('settings.restart')}</p> : null}
              {errorFor('computers')}

              {running === 'local' && shownBrowser ? (
                <div className="settings-browser">
                  <span className="conn-label">{t('setup.computer.browser')}</span>
                  <BrowserLine browser={shownBrowser} download={setup?.computers.download ?? { approxMB: 190, onDiskMB: 370 }} />
                  {shownBrowser.state === 'missing' || shownBrowser.state === 'failed' ? (
                    <div className="settings-buttons">
                      <button type="button" onClick={() => void download()}>
                        {shownBrowser.state === 'failed' ? t('setup.computer.retry') : t('setup.computer.download')}
                      </button>
                    </div>
                  ) : null}
                  {errors.find((e) => e.key === 'browser') ? (
                    <div className="form-error" role="alert">{errors.find((e) => e.key === 'browser')!.code}</div>
                  ) : null}
                </div>
              ) : null}

              <form className="conn-form" onSubmit={(e) => { e.preventDefault(); void save({ browserMirror: mirror.trim() }) }}>
                <label>
                  <span className="conn-label">{t('settings.mirror')}</span>
                  <input
                    value={mirror} spellCheck={false} disabled={locked('browserMirror')} placeholder={t('settings.mirrorNone')}
                    onChange={(e) => setMirror(e.target.value)}
                  />
                </label>
                <p className="setup-hint">{t('settings.mirrorHint')}</p>
                {locked('browserMirror') ? lockedNote('OPENSUPERBOT_BROWSER_MIRROR') : (
                  <div className="settings-buttons">
                    {suggested && mirror !== suggested.url ? (
                      <button type="button" onClick={() => setMirror(suggested.url)}>{t('settings.mirrorUse', { owner: suggested.owner })}</button>
                    ) : null}
                    <span className="spacer" />
                    <button type="submit" disabled={saving || mirror.trim() === settings.values.browserMirror}>{t('settings.save')}</button>
                  </div>
                )}
                {errorFor('browserMirror')}
              </form>
            </Section>

            {desktop ? (
              <Section title={t('settings.app')}>
                {desktop.update ? (
                  <div className="settings-update" role="status">
                    <span>{t('updates.available', { version: desktop.update.version })}</span>
                    <a className="setup-link" href={desktop.update.url} target="_blank" rel="noreferrer">
                      {t('updates.download')}
                    </a>
                  </div>
                ) : null}
                <StartAtLogin where="settings" />
                <div className="start-at-login">
                  <label className="conn-check-row">
                    <input
                      type="checkbox"
                      checked={settings.values.checkUpdates}
                      disabled={saving}
                      onChange={(e) => void save({ checkUpdates: e.target.checked })}
                    />
                    {t('updates.label')}
                  </label>
                  <p className="setup-hint">{t('updates.hint')}</p>
                </div>
                {errorFor('checkUpdates')}
              </Section>
            ) : null}

            {about ? (
              <Section title={t('settings.about')}>
                <dl className="settings-about">
                  <dt>{t('settings.about.version')}</dt>
                  <dd>{about.version ?? t('settings.about.source')}</dd>
                  {desktop ? (
                    <>
                      <dt>{t('settings.about.app')}</dt>
                      <dd>{t('settings.about.desktop', { version: desktop.version, electron: desktop.electron })}</dd>
                    </>
                  ) : null}
                  {about.port ? (
                    <>
                      <dt>{t('settings.about.port')}</dt>
                      <dd>{about.port}</dd>
                    </>
                  ) : null}
                  <dt>{t('settings.about.data')}</dt>
                  <dd><code>{about.dataDir}</code></dd>
                  <dt>{t('settings.about.logs')}</dt>
                  <dd>{about.logs === 'stdout' ? t('settings.about.logsStdout') : <code>{about.logs}</code>}</dd>
                  <dt>{t('settings.about.runtime')}</dt>
                  <dd>{`Node ${about.runtime.node} · ${about.runtime.platform}/${about.runtime.arch}`}</dd>
                </dl>
                <div className="settings-local-llm">
                  <div className="settings-buttons">
                    <button
                      type="button"
                      disabled={diagBusy !== null}
                      onClick={() => void copyDiagnostics()}
                    >
                      {diagBusy === 'copy' ? t('settings.diagnostics.copying') : t('settings.diagnostics.copy')}
                    </button>
                    <button
                      type="button"
                      disabled={diagBusy !== null}
                      onClick={() => void downloadDiagnostics()}
                    >
                      {diagBusy === 'download' ? t('settings.diagnostics.downloading') : t('settings.diagnostics.download')}
                    </button>
                  </div>
                  <p className="setup-hint">{t('settings.diagnostics.hint')}</p>
                  {diagMessage ? <p className="settings-quiet-delivered" role="status">{diagMessage}</p> : null}
                  {diagError ? <div className="form-error" role="alert">{diagError}</div> : null}
                </div>
                <div className="settings-about-credits">
                  <p>
                    {t('settings.about.creditsLead')}
                    <a className="setup-link" href="https://github.com/wolfqing" target="_blank" rel="noreferrer">
                      wolfqing
                    </a>
                    {t('settings.about.creditsMiddle')}
                    <a
                      className="setup-link"
                      href="https://github.com/wolfqing/OpenSuperBot/graphs/contributors"
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('settings.about.contributors')}
                    </a>
                    {t('settings.about.creditsTail')}
                  </p>
                  <p className="settings-about-meta">
                    <a className="setup-link" href="https://github.com/wolfqing/OpenSuperBot" target="_blank" rel="noreferrer">
                      {t('settings.about.repo')}
                    </a>
                    <span aria-hidden="true"> · </span>
                    <span>{t('settings.about.license')}</span>
                  </p>
                </div>
              </Section>
            ) : null}
            {errorFor('')}
          </>
        ) : null}
      </div>
    </div>
  )
}
