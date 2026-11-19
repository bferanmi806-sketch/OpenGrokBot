import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  ApiError,
  SignedOut,
  deleteConnector,
  reconnectConnector,
  refreshConnector,
  saveConnectorsKey,
  setBotConnectors,
  startConnectorOAuth,
  testConnectorsKey,
} from '../api'
import { useT, type MessageKey, type T } from '../i18n'
import { en } from '../i18n/en'
import { errorText } from '../i18n/describe'
import type { AppGroupId, AppKey, ConnectorAccountView, ConnectorsSnapshot } from '../types'
import { ConfirmDialog, useEscape } from './ConfirmDialog'
import { PlusIcon, XIcon } from './Icons'

type Roster = Record<string, { name: string; emoji: string }>

const GROUPS: AppGroupId[] = ['mail_calendar', 'productivity', 'messaging']

const knownConnectorError = (code: string | undefined): MessageKey | null => {
  if (!code) return null
  const key = `connectors.error.${code}`
  return Object.hasOwn(en, key) ? (key as MessageKey) : null
}

function connectorErrorMessage(t: T, err: unknown): { text: string; detail?: string } {
  if (err instanceof ApiError) {
    const key = knownConnectorError(err.code) ?? knownConnectorError(err.message)
    const text = key ? t(key) : errorText(t, err)
    return err.detail ? { text, detail: err.detail } : { text }
  }
  return { text: err instanceof Error ? err.message : String(err) }
}

function TeammateCheckList({ roster, selected, disabled, onToggle }: {
  roster: Roster
  selected: Set<string>
  disabled?: boolean
  onToggle: (botId: string) => void
}) {
  const t = useT()
  const entries = Object.entries(roster)
  if (!entries.length) {
    return <div className="connector-no-bots">{t('connectors.noTeammates')}</div>
  }
  return (
    <div className="connector-bots">
      {entries.map(([botId, bot]) => (
        <label key={botId} className="connector-bot-check">
          <input
            type="checkbox"
            checked={selected.has(botId)}
            disabled={disabled}
            onChange={() => onToggle(botId)}
          />
          {bot.emoji ? <span className="connector-bot-emoji" aria-hidden="true">{bot.emoji}</span> : null}
          <span>{bot.name}</span>
        </label>
      ))}
    </div>
  )
}

export function ConnectorsDialog({ state, roster, onChange, onSignedOut, onClose }: {
  state: ConnectorsSnapshot
  roster: Roster
  onChange: (next: ConnectorsSnapshot) => void
  onSignedOut?: () => void
  onClose: () => void
}) {
  const t = useT()
  const [changingKey, setChangingKey] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyBusy, setKeyBusy] = useState<'saving' | 'testing' | null>(null)
  const [keyStatus, setKeyStatus] = useState<{ ok: boolean; text: string; detail?: string } | null>(null)
  const [confirmClearKey, setConfirmClearKey] = useState(false)

  const [connectingApp, setConnectingApp] = useState<AppKey | null>(null)
  const [connectBots, setConnectBots] = useState<Set<string>>(() => new Set())
  const [managingId, setManagingId] = useState<string | null>(null)
  const [accessBots, setAccessBots] = useState<Set<string>>(() => new Set())
  const [reconnectingIds, setReconnectingIds] = useState<Set<string>>(() => new Set())

  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState<{ account: ConnectorAccountView; appName: string } | null>(null)

  const cancelInline = changingKey
    ? () => { setChangingKey(false); setKeyDraft(''); setKeyStatus(null) }
    : connectingApp
      ? () => { setConnectingApp(null); setConnectBots(new Set()) }
      : managingId
        ? () => { setManagingId(null); setAccessBots(new Set()) }
        : null
  useEscape(cancelInline ?? onClose)

  const botOrder = useMemo(() => {
    const ids = Object.keys(roster)
    for (const id of Object.keys(state.botGrants)) {
      if (!ids.includes(id)) ids.push(id)
    }
    return ids
  }, [roster, state.botGrants])

  const toggleSet = (setter: Dispatch<SetStateAction<Set<string>>>, id: string) => {
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const saveKey = async () => {
    const trimmed = keyDraft.trim()
    if (!trimmed) return
    setKeyBusy('saving')
    setKeyStatus(null)
    setError(null)
    try {
      const next = await saveConnectorsKey(trimmed)
      onChange(next)
      setKeyDraft('')
      setChangingKey(false)
      setKeyStatus({ ok: true, text: t('connectors.testOk') })
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut?.(); return }
      setKeyStatus({ ok: false, ...connectorErrorMessage(t, err) })
    } finally {
      setKeyBusy(null)
    }
  }

  const clearKey = async () => {
    setKeyBusy('saving')
    setKeyStatus(null)
    setError(null)
    try {
      const next = await saveConnectorsKey(null)
      onChange(next)
      setChangingKey(false)
      setKeyDraft('')
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut?.(); return }
      setKeyStatus({ ok: false, ...connectorErrorMessage(t, err) })
    } finally {
      setKeyBusy(null)
    }
  }

  const runTestKey = async () => {
    setKeyBusy('testing')
    setKeyStatus(null)
    setError(null)
    try {
      const res = await testConnectorsKey()
      if (res.ok) {
        setKeyStatus({ ok: true, text: t('connectors.testOk') })
      } else {
        const key = knownConnectorError(res.code)
        setKeyStatus({
          ok: false,
          text: key ? t(key) : t('connectors.testBad'),
          ...(res.detail ? { detail: res.detail } : {}),
        })
      }
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut?.(); return }
      setKeyStatus({ ok: false, ...connectorErrorMessage(t, err) })
    } finally {
      setKeyBusy(null)
    }
  }

  const openConnect = (app: AppKey) => {
    setError(null)
    setManagingId(null)
    setConnectingApp(app)
    setConnectBots(new Set())
  }

  const doConnect = async (app: AppKey) => {
    setBusyId(`connect:${app}`)
    setError(null)
    try {
      const res = await startConnectorOAuth(app, [...connectBots])
      if (/^https?:\/\//i.test(res.redirectUrl)) {
        window.open(res.redirectUrl, '_blank', 'noopener')
      }
      onChange(res.state)
      setConnectingApp(null)
      setConnectBots(new Set())
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut?.(); return }
      setError(connectorErrorMessage(t, err).text)
    } finally {
      setBusyId(null)
    }
  }

  const openManage = (accountId: string, grantedBotIds: string[]) => {
    setError(null)
    setConnectingApp(null)
    setManagingId(accountId)
    setAccessBots(new Set(grantedBotIds))
  }

  const doSaveAccess = async (accountId: string) => {
    setBusyId(`access:${accountId}`)
    setError(null)
    try {
      const nextBotGrants: Record<string, string[]> = { ...state.botGrants }
      for (const botId of botOrder) {
        const prev = state.botGrants[botId] ?? []
        const had = prev.includes(accountId)
        const wants = accessBots.has(botId)
        if (had === wants) continue
        const updatedIds = wants ? [...prev, accountId] : prev.filter((id) => id !== accountId)
        const res = await setBotConnectors(botId, updatedIds)
        nextBotGrants[botId] = res.connectorIds
      }
      onChange({ ...state, botGrants: nextBotGrants })
      setManagingId(null)
      setAccessBots(new Set())
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut?.(); return }
      setError(connectorErrorMessage(t, err).text)
    } finally {
      setBusyId(null)
    }
  }

  const doReconnect = async (account: ConnectorAccountView) => {
    setBusyId(`reconnect:${account.id}`)
    setError(null)
    try {
      const res = await reconnectConnector(account.id)
      if (/^https?:\/\//i.test(res.redirectUrl)) {
        window.open(res.redirectUrl, '_blank', 'noopener')
      }
      setReconnectingIds((prev) => new Set(prev).add(account.id))
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut?.(); return }
      setError(connectorErrorMessage(t, err).text)
    } finally {
      setBusyId(null)
    }
  }

  const doRefresh = async (accountId: string) => {
    setBusyId(`refresh:${accountId}`)
    setError(null)
    try {
      const next = await refreshConnector(accountId)
      onChange(next)
      const updated = next.accounts.find((a) => a.id === accountId)
      if (updated?.status === 'active') {
        setReconnectingIds((prev) => {
          if (!prev.has(accountId)) return prev
          const copy = new Set(prev)
          copy.delete(accountId)
          return copy
        })
      }
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut?.(); return }
      setError(connectorErrorMessage(t, err).text)
    } finally {
      setBusyId(null)
    }
  }

  const doDisconnect = async (accountId: string) => {
    setBusyId(`disconnect:${accountId}`)
    setError(null)
    try {
      const next = await deleteConnector(accountId)
      onChange(next)
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut?.(); return }
      setError(connectorErrorMessage(t, err).text)
    } finally {
      setBusyId(null)
    }
  }

  const scrimDown = useRef(false)

  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => { scrimDown.current = e.target === e.currentTarget }}
      onClick={(e) => { if (e.target === e.currentTarget && scrimDown.current) onClose(); scrimDown.current = false }}
    >
      <div
        className="modal modal-wide connectors-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('connectors.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="modal-title">{t('connectors.title')}</div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t('connectors.close')} title={t('connectors.close')}>
            <XIcon size={15} />
          </button>
        </div>

        <p className="conn-intro">{t('connectors.custodyNote')}</p>

        <div className="connectors-key-bar">
          <div className="connectors-key-head">
            <span className="conn-label">{t('connectors.keyLabel')}</span>
            {state.key.locked ? (
              <div className="connectors-key-controls">
                <span className="connectors-key-badge">
                  {state.key.masked ? t('connectors.keySet', { masked: state.key.masked }) : t('connectors.keyFromEnv')}
                </span>
                <button type="button" disabled={keyBusy !== null} onClick={() => void runTestKey()}>
                  {keyBusy === 'testing' ? t('connectors.testing') : t('connectors.keyTest')}
                </button>
              </div>
            ) : state.key.set && !changingKey ? (
              <div className="connectors-key-controls">
                <span className="connectors-key-badge">{t('connectors.keySet', { masked: state.key.masked })}</span>
                <button type="button" disabled={keyBusy !== null} onClick={() => { setChangingKey(true); setKeyDraft(''); setKeyStatus(null) }}>
                  {t('connectors.keyChange')}
                </button>
                <button type="button" disabled={keyBusy !== null} onClick={() => void runTestKey()}>
                  {keyBusy === 'testing' ? t('connectors.testing') : t('connectors.keyTest')}
                </button>
                <button type="button" className="danger" disabled={keyBusy !== null} onClick={() => setConfirmClearKey(true)}>
                  {t('connectors.keyClear')}
                </button>
              </div>
            ) : null}
          </div>

          {state.key.locked ? (
            <p className="connectors-key-locked">{t('connectors.keyLocked')}</p>
          ) : !state.key.set || changingKey ? (
            <form className="connectors-key-form" onSubmit={(e) => { e.preventDefault(); void saveKey() }}>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={keyDraft}
                aria-label={t('connectors.keyLabel')}
                placeholder={t('connectors.keyPlaceholder')}
                disabled={keyBusy !== null}
                onChange={(e) => setKeyDraft(e.target.value)}
              />
              <button type="submit" className="primary" disabled={!keyDraft.trim() || keyBusy !== null}>
                {keyBusy === 'saving' ? t('connectors.keySaving') : t('connectors.keySave')}
              </button>
              {state.key.set && changingKey ? (
                <button
                  type="button"
                  disabled={keyBusy !== null}
                  onClick={() => { setChangingKey(false); setKeyDraft(''); setKeyStatus(null) }}
                >
                  {t('connectors.cancel')}
                </button>
              ) : null}
            </form>
          ) : null}

          {keyStatus ? (
            <div className={`conn-check ${keyStatus.ok ? 'ok' : 'bad'}`} role={keyStatus.ok ? 'status' : 'alert'}>
              {keyStatus.ok ? '✓ ' : '✕ '}{keyStatus.text}
              {!keyStatus.ok && keyStatus.detail ? <div className="conn-check-detail">{keyStatus.detail}</div> : null}
            </div>
          ) : null}
        </div>

        {!state.key.set ? <p className="connectors-need-key">{t('connectors.needKeyHint')}</p> : null}
        {error ? <div className="form-error connectors-error" role="alert">{error}</div> : null}

        <div className="connectors-groups">
          {GROUPS.map((group) => {
            const apps = state.catalog.filter((item) => item.group === group)
            if (!apps.length) return null
            return (
              <section className="connectors-group" key={group}>
                <h3 className="connectors-group-title">{t(`connectors.group.${group}` as MessageKey)}</h3>
                <div className="connectors-cards">
                  {apps.map((appItem) => {
                    const accounts = state.accounts.filter((a) => a.app === appItem.app)
                    const isConnecting = connectingApp === appItem.app
                    return (
                      <div className="connector-card" key={appItem.app}>
                        <div className="connector-card-head">
                          <span className="connector-app-name">{appItem.name}</span>
                          {!isConnecting ? (
                            <button
                              type="button"
                              className="connector-connect-btn"
                              disabled={!state.key.set || busyId !== null}
                              title={!state.key.set ? t('connectors.needKeyHint') : undefined}
                              onClick={() => openConnect(appItem.app)}
                            >
                              <PlusIcon size={12} />
                              <span>{t(accounts.length > 0 ? 'connectors.connectAnother' : 'connectors.connect')}</span>
                            </button>
                          ) : null}
                        </div>

                        {accounts.length === 0 && !isConnecting ? (
                          <div className="connector-empty">{t('connectors.emptyAccounts')}</div>
                        ) : null}

                        {accounts.length > 0 ? (
                          <div className="connector-accounts">
                            {accounts.map((acc) => {
                              const label = acc.accountLabel || appItem.name
                              const grantedBotIds = botOrder.filter((botId) => (state.botGrants[botId] ?? []).includes(acc.id))
                              const grantedNames = grantedBotIds.map((botId) => roster[botId]?.name ?? botId)
                              const isManaging = managingId === acc.id
                              const showHint = acc.status === 'pending' || reconnectingIds.has(acc.id)
                              return (
                                <div className="connector-account" key={acc.id}>
                                  <div className="connector-account-head">
                                    <span className="connector-account-label">{label}</span>
                                    <span className={`connector-status ${acc.status}`}>
                                      {t(`connectors.status.${acc.status}` as MessageKey)}
                                    </span>
                                  </div>
                                  <div className="connector-account-grants">
                                    {grantedNames.length
                                      ? t('connectors.grantedTo', { names: grantedNames.join(t.lang === 'zh-CN' ? '、' : ', ') })
                                      : t('connectors.noGrants')}
                                  </div>
                                  {showHint ? (
                                    <div className="connector-account-hint">{t('connectors.authorizingHint')}</div>
                                  ) : null}
                                  {isManaging ? (
                                    <div className="connector-picker">
                                      <div className="connector-picker-label">{t('connectors.grantTo')}</div>
                                      <TeammateCheckList
                                        roster={roster}
                                        selected={accessBots}
                                        disabled={busyId !== null}
                                        onToggle={(botId) => toggleSet(setAccessBots, botId)}
                                      />
                                      <div className="conn-form-buttons">
                                        <span className="spacer" />
                                        <button
                                          type="button"
                                          disabled={busyId !== null}
                                          onClick={() => { setManagingId(null); setAccessBots(new Set()) }}
                                        >
                                          {t('connectors.cancel')}
                                        </button>
                                        <button
                                          type="button"
                                          className="primary"
                                          disabled={busyId !== null}
                                          onClick={() => void doSaveAccess(acc.id)}
                                        >
                                          {t('connectors.saveAccess')}
                                        </button>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="conn-actions connector-account-actions">
                                      {acc.status !== 'active' ? (
                                        <button
                                          type="button"
                                          className="primary"
                                          disabled={!state.key.set || busyId !== null}
                                          onClick={() => void doReconnect(acc)}
                                        >
                                          {t('connectors.reconnect')}
                                        </button>
                                      ) : null}
                                      <button
                                        type="button"
                                        disabled={busyId !== null}
                                        onClick={() => openManage(acc.id, grantedBotIds)}
                                      >
                                        {t('connectors.manageAccess')}
                                      </button>
                                      <button
                                        type="button"
                                        disabled={!state.key.set || busyId !== null}
                                        onClick={() => void doRefresh(acc.id)}
                                      >
                                        {t('connectors.refresh')}
                                      </button>
                                      <button
                                        type="button"
                                        className="danger"
                                        disabled={busyId !== null}
                                        onClick={() => setConfirmDisconnect({ account: acc, appName: appItem.name })}
                                      >
                                        {t('connectors.disconnect')}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        ) : null}

                        {isConnecting ? (
                          <div className="connector-picker">
                            <div className="connector-picker-label">{t('connectors.grantTo')}</div>
                            <TeammateCheckList
                              roster={roster}
                              selected={connectBots}
                              disabled={busyId !== null}
                              onToggle={(botId) => toggleSet(setConnectBots, botId)}
                            />
                            <div className="conn-form-buttons">
                              <span className="spacer" />
                              <button
                                type="button"
                                disabled={busyId !== null}
                                onClick={() => { setConnectingApp(null); setConnectBots(new Set()) }}
                              >
                                {t('connectors.cancel')}
                              </button>
                              <button
                                type="button"
                                className="primary"
                                disabled={!state.key.set || busyId !== null}
                                onClick={() => void doConnect(appItem.app)}
                              >
                                {t('connectors.authorizeBrowser')}
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>
      </div>

      {confirmClearKey ? (
        <ConfirmDialog
          message={t('connectors.confirmClearKey')}
          confirmLabel={t('connectors.keyClear')}
          cancelLabel={t('confirm.cancel')}
          onConfirm={() => {
            setConfirmClearKey(false)
            void clearKey()
          }}
          onCancel={() => setConfirmClearKey(false)}
        />
      ) : null}

      {confirmDisconnect ? (
        <ConfirmDialog
          message={t('connectors.confirmDisconnect', {
            name: confirmDisconnect.account.accountLabel || confirmDisconnect.appName,
          })}
          confirmLabel={t('confirm.disconnect')}
          cancelLabel={t('confirm.cancel')}
          onConfirm={() => {
            const targetId = confirmDisconnect.account.id
            setConfirmDisconnect(null)
            void doDisconnect(targetId)
          }}
          onCancel={() => setConfirmDisconnect(null)}
        />
      ) : null}
    </div>
  )
}
