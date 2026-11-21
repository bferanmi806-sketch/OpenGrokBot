import { useMemo, useRef, useState } from 'react'
import {
  ApiError,
  SignedOut,
  createVaultItem,
  deleteVaultItem,
  updateVaultItem,
} from '../api'
import { useT, type MessageKey } from '../i18n'
import { errorText } from '../i18n/describe'
import type {
  VaultApprovalMode,
  VaultFieldKind,
  VaultItemKind,
  VaultItemView,
  VaultSnapshot,
} from '../types'
import { ConfirmDialog, useEscape } from './ConfirmDialog'
import { TeammateCheckList, type Roster } from './ConnectorsDialog'
import { KeyIcon, PlusIcon, XIcon } from './Icons'

type FieldDraft = {
  id: string
  key: string
  kind: VaultFieldKind
  label: string
  value: string
  /** 编辑旧项时，留空不改动；点「清空」标记为 true，保存时传 null 删除该字段密文 */
  cleared: boolean
  existingSet: boolean
  existingPreview: string
}

let draftSeq = 0
const nextId = () => `vf-${++draftSeq}`

function defaultFieldsForKind(kind: VaultItemKind): FieldDraft[] {
  if (kind === 'login') {
    return [
      { id: nextId(), key: 'username', kind: 'text', label: 'Username', value: '', cleared: false, existingSet: false, existingPreview: '' },
      { id: nextId(), key: 'password', kind: 'secret', label: 'Password', value: '', cleared: false, existingSet: false, existingPreview: '' },
      { id: nextId(), key: 'totp', kind: 'totp', label: '2FA (TOTP)', value: '', cleared: false, existingSet: false, existingPreview: '' },
    ]
  }
  if (kind === 'api_secret') {
    return [
      { id: nextId(), key: 'api_key', kind: 'secret', label: 'API key', value: '', cleared: false, existingSet: false, existingPreview: '' },
    ]
  }
  return [
    { id: nextId(), key: 'email', kind: 'text', label: 'Email', value: '', cleared: false, existingSet: false, existingPreview: '' },
    { id: nextId(), key: 'phone', kind: 'text', label: 'Phone', value: '', cleared: false, existingSet: false, existingPreview: '' },
  ]
}

function parseDomainsText(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function VaultDialog({
  state,
  roster,
  onChange,
  onSignedOut,
  onClose,
}: {
  state: VaultSnapshot
  roster: Roster
  onChange: (next: VaultSnapshot) => void
  onSignedOut?: () => void
  onClose: () => void
}) {
  const t = useT()
  const scrimDown = useRef(false)
  const [editing, setEditing] = useState<'new' | VaultItemView | null>(null)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<VaultItemKind>('login')
  const [domainsText, setDomainsText] = useState('')
  const [approvalMode, setApprovalMode] = useState<VaultApprovalMode>('on_taint')
  const [notes, setNotes] = useState('')
  const [fields, setFields] = useState<FieldDraft[]>(() => defaultFieldsForKind('login'))
  const [botIds, setBotIds] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<VaultItemView | null>(null)

  const botOrder = useMemo(() => Object.keys(roster), [roster])

  useEscape(confirmDelete ? undefined : editing ? () => setEditing(null) : onClose)

  const openNew = () => {
    setEditing('new')
    setName('')
    setKind('login')
    setDomainsText('')
    setApprovalMode('on_taint')
    setNotes('')
    setFields(defaultFieldsForKind('login'))
    setBotIds(new Set())
    setError(null)
  }

  const openEdit = (item: VaultItemView) => {
    setEditing(item)
    setName(item.name)
    setKind(item.kind)
    setDomainsText(item.allowedDomains.join(', '))
    setApprovalMode(item.approvalMode)
    setNotes(item.notes)
    setFields(
      item.fields.map((f) => ({
        id: nextId(),
        key: f.key,
        kind: f.kind,
        label: f.label ?? '',
        value: '',
        cleared: false,
        existingSet: f.set,
        existingPreview: f.preview,
      })),
    )
    const granted = new Set<string>()
    for (const [botId, ids] of Object.entries(state.botGrants)) {
      if (ids.includes(item.id)) granted.add(botId)
    }
    setBotIds(granted)
    setError(null)
  }

  const handleKindChange = (nextKind: VaultItemKind) => {
    setKind(nextKind)
    if (editing === 'new') {
      const hasTyped = fields.some((f) => f.value.trim().length > 0)
      if (!hasTyped) setFields(defaultFieldsForKind(nextKind))
    }
  }

  const updateField = (id: string, patch: Partial<FieldDraft>) => {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)))
  }

  const addField = () => {
    setFields((prev) => [
      ...prev,
      { id: nextId(), key: '', kind: kind === 'personal_info' ? 'text' : 'secret', label: '', value: '', cleared: false, existingSet: false, existingPreview: '' },
    ])
  }

  const removeField = (id: string) => {
    setFields((prev) => prev.filter((f) => f.id !== id))
  }

  const toggleBot = (botId: string) => {
    setBotIds((prev) => {
      const next = new Set(prev)
      if (next.has(botId)) next.delete(botId)
      else next.add(botId)
      return next
    })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const cleanFields = fields
        .map((f) => ({ ...f, key: f.key.trim(), label: f.label.trim() }))
        .filter((f) => f.key.length > 0)
      const fieldMetas = cleanFields.map((f) => ({
        key: f.key,
        kind: f.kind,
        ...(f.label ? { label: f.label } : {}),
      }))
      const allowedDomains = parseDomainsText(domainsText)
      const selectedBots = [...botIds]

      if (editing === 'new') {
        const values: Record<string, string> = {}
        for (const f of cleanFields) {
          if (f.value) values[f.key] = f.value
        }
        const res = await createVaultItem({
          name: name.trim(),
          kind,
          allowedDomains,
          fields: fieldMetas,
          values,
          approvalMode,
          notes: notes.trim(),
          botIds: selectedBots,
        })
        onChange(res.snapshot)
        setEditing(null)
      } else if (editing) {
        const values: Record<string, string | null> = {}
        for (const f of cleanFields) {
          if (f.cleared) values[f.key] = null
          else if (f.value) values[f.key] = f.value
        }
        const res = await updateVaultItem(editing.id, {
          name: name.trim(),
          kind,
          allowedDomains,
          fields: fieldMetas,
          values,
          approvalMode,
          notes: notes.trim(),
          botIds: selectedBots,
        })
        onChange(res.snapshot)
        setEditing(null)
      }
    } catch (err) {
      if (err instanceof SignedOut) {
        onSignedOut?.()
        return
      }
      setError(err instanceof ApiError ? errorText(t, err) : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async (item: VaultItemView) => {
    setBusy(true)
    setError(null)
    try {
      const res = await deleteVaultItem(item.id)
      onChange(res.snapshot)
      setConfirmDelete(null)
      if (editing && editing !== 'new' && editing.id === item.id) setEditing(null)
    } catch (err) {
      if (err instanceof SignedOut) {
        onSignedOut?.()
        return
      }
      setError(err instanceof ApiError ? errorText(t, err) : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => { scrimDown.current = e.target === e.currentTarget }}
      onClick={(e) => { if (e.target === e.currentTarget && scrimDown.current) onClose(); scrimDown.current = false }}
    >
      <div className="modal modal-wide vault-modal" role="dialog" aria-modal="true" aria-label={t('vault.title')} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title vault-modal-title">
            <KeyIcon size={15} />
            <span>{editing === 'new' ? t('vault.form.newTitle') : editing ? t('vault.form.editTitle') : t('vault.title')}</span>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t('vault.form.cancel')} title={t('vault.form.cancel')}>
            <XIcon size={15} />
          </button>
        </div>

        <p className="vault-subtitle">{t('vault.subtitle')}</p>
        {error ? <div className="form-error" role="alert">{error}</div> : null}

        {editing ? (
          <form className="vault-form" onSubmit={(e) => void handleSubmit(e)}>
            <div className="vault-form-row">
              <label className="vault-field">
                <span>{t('vault.form.name')}</span>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('vault.form.namePlaceholder')}
                  disabled={busy}
                />
              </label>
              <label className="vault-field">
                <span>{t('vault.form.kind')}</span>
                <select value={kind} onChange={(e) => handleKindChange(e.target.value as VaultItemKind)} disabled={busy}>
                  <option value="login">{t('vault.kind.login')}</option>
                  <option value="api_secret">{t('vault.kind.api_secret')}</option>
                  <option value="personal_info">{t('vault.kind.personal_info')}</option>
                </select>
              </label>
            </div>

            <label className="vault-field">
              <span>{t('vault.form.domains')}</span>
              <input
                type="text"
                value={domainsText}
                onChange={(e) => setDomainsText(e.target.value)}
                placeholder={t('vault.form.domainsPlaceholder')}
                required={kind === 'login'}
                disabled={busy}
              />
              <span className="vault-hint">{t('vault.form.domainsHint')}</span>
            </label>

            <label className="vault-field">
              <span>{t('vault.form.approvalMode')}</span>
              <select
                value={approvalMode}
                onChange={(e) => setApprovalMode(e.target.value as VaultApprovalMode)}
                disabled={busy}
              >
                <option value="on_taint">{t('vault.approval.on_taint')}</option>
                <option value="always">{t('vault.approval.always')}</option>
              </select>
            </label>

            <div className="vault-fields-section">
              <div className="vault-fields-head">
                <span>{t('vault.form.fields')}</span>
                <button type="button" className="vault-small-btn" onClick={addField} disabled={busy}>
                  <PlusIcon size={12} />
                  <span>{t('vault.form.addField')}</span>
                </button>
              </div>
              <div className="vault-fields-list">
                {fields.map((f) => (
                  <div className="vault-field-item" key={f.id}>
                    <input
                      type="text"
                      className="vault-key-input"
                      aria-label={t('vault.form.fieldKey')}
                      placeholder={t('vault.form.fieldKey')}
                      value={f.key}
                      onChange={(e) => updateField(f.id, { key: e.target.value })}
                      disabled={busy}
                    />
                    <select
                      className="vault-kind-select"
                      aria-label={t('vault.form.kind')}
                      value={f.kind}
                      onChange={(e) => updateField(f.id, { kind: e.target.value as VaultFieldKind })}
                      disabled={busy}
                    >
                      <option value="text">{t('vault.fieldKind.text')}</option>
                      <option value="secret">{t('vault.fieldKind.secret')}</option>
                      <option value="totp">{t('vault.fieldKind.totp')}</option>
                    </select>
                    <input
                      type={f.kind === 'secret' ? 'password' : 'text'}
                      className="vault-val-input"
                      aria-label={`${f.key || t('vault.form.fieldValue')} ${t('vault.form.fieldValue')}`}
                      placeholder={
                        f.cleared
                          ? t('vault.valueUnset')
                          : f.existingSet
                            ? `${t('vault.form.keepValuePlaceholder')} (${f.existingPreview})`
                            : f.kind === 'totp'
                              ? t('vault.form.totpPlaceholder')
                              : t('vault.form.fieldValue')
                      }
                      value={f.value}
                      onChange={(e) => updateField(f.id, { value: e.target.value, cleared: false })}
                      disabled={busy}
                      autoComplete="off"
                    />
                    {f.existingSet && !f.cleared ? (
                      <button
                        type="button"
                        className="vault-small-btn"
                        disabled={busy}
                        onClick={() => updateField(f.id, { value: '', cleared: true })}
                      >
                        {t('vault.form.clearField')}
                      </button>
                    ) : null}
                    {fields.length > 1 ? (
                      <button
                        type="button"
                        className="vault-icon-btn"
                        disabled={busy}
                        aria-label={t('vault.form.removeField')}
                        title={t('vault.form.removeField')}
                        onClick={() => removeField(f.id)}
                      >
                        <XIcon size={12} />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>

            <label className="vault-field">
              <span>{t('vault.form.notes')}</span>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t('vault.form.notesPlaceholder')}
                disabled={busy}
              />
            </label>

            <div className="vault-grants-section">
              <div className="connector-picker-label">{t('vault.form.grantTo')}</div>
              <TeammateCheckList roster={roster} selected={botIds} disabled={busy} onToggle={toggleBot} />
            </div>

            <div className="conn-form-buttons">
              <span className="spacer" />
              <button type="button" disabled={busy} onClick={() => setEditing(null)}>
                {t('vault.form.cancel')}
              </button>
              <button type="submit" className="primary" disabled={busy || !name.trim()}>
                {busy ? t('vault.form.saving') : t('vault.form.save')}
              </button>
            </div>
          </form>
        ) : (
          <div className="vault-list-wrap">
            <div className="vault-toolbar">
              <button type="button" className="connector-connect-btn" onClick={openNew}>
                <PlusIcon size={12} />
                <span>{t('vault.add')}</span>
              </button>
            </div>

            {state.items.length === 0 ? (
              <div className="connector-empty">{t('vault.empty')}</div>
            ) : (
              <div className="vault-items">
                {state.items.map((item) => {
                  const grantedNames = botOrder
                    .filter((botId) => (state.botGrants[botId] ?? []).includes(item.id))
                    .map((botId) => roster[botId]?.name ?? botId)
                  return (
                    <div className="connector-card vault-card" key={item.id}>
                      <div className="connector-card-head">
                        <div className="vault-card-title">
                          <span className="connector-app-name">{item.name}</span>
                          <span className="vault-badge">{t(`vault.kind.${item.kind}` as MessageKey)}</span>
                          <span className="vault-badge subtle">{t(`vault.approval.${item.approvalMode}` as MessageKey)}</span>
                        </div>
                        <div className="vault-card-actions">
                          <button type="button" className="vault-small-btn" onClick={() => openEdit(item)} disabled={busy}>
                            {t('vault.edit')}
                          </button>
                          <button type="button" className="vault-small-btn danger" onClick={() => setConfirmDelete(item)} disabled={busy}>
                            {t('vault.delete')}
                          </button>
                        </div>
                      </div>
                      <div className="vault-meta">
                        <span>{item.allowedDomains.length ? item.allowedDomains.join(', ') : t('vault.noDomains')}</span>
                        <span aria-hidden="true"> · </span>
                        <code>{t('vault.slugHint', { slug: item.slug })}</code>
                      </div>
                      <div className="vault-field-pills">
                        {item.fields.map((f) => (
                          <span className={`vault-pill${f.set ? '' : ' unset'}`} key={f.key}>
                            {f.key}: {f.set ? f.preview : t('vault.valueUnset')}
                          </span>
                        ))}
                      </div>
                      <div className="connector-account-grants">
                        {grantedNames.length
                          ? t('vault.grantedTo', { names: grantedNames.join(t.lang === 'zh-CN' ? '、' : ', ') })
                          : t('vault.noGrants')}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {confirmDelete ? (
        <ConfirmDialog
          message={t('vault.deleteConfirm', { name: confirmDelete.name })}
          confirmLabel={t('confirm.delete')}
          cancelLabel={t('confirm.cancel')}
          onConfirm={() => void doDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      ) : null}
    </div>
  )
}
