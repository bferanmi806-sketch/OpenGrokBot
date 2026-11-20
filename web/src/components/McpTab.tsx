import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  ApiError,
  SignedOut,
  createMcpServer,
  deleteMcpServer,
  importMcpServers,
  setMcpServerBots,
  testMcpServer,
  updateMcpServer,
  type CreateMcpServerInput,
  type UpdateMcpServerPatch,
} from '../api'
import { useT, type MessageKey, type T } from '../i18n'
import { errorText } from '../i18n/describe'
import { en } from '../i18n/en'
import type {
  McpServersSnapshot,
  McpServerView,
  McpToolMode,
  McpToolPolicyChoice,
  McpTransportKind,
} from '../types'
import { ConfirmDialog, useEscape } from './ConfirmDialog'
import { TeammateCheckList, type Roster } from './ConnectorsDialog'
import { ChevronRightIcon, PlusIcon } from './Icons'

type SecretRow = {
  id: number
  key: string
  value: string
  savedMasked?: string
  originalKey?: string
}

const knownMcpError = (code: string | undefined): MessageKey | null => {
  if (!code) return null
  const key = `mcp.error.${code}`
  return Object.hasOwn(en, key) ? (key as MessageKey) : null
}

function mcpErrorMessage(t: T, err: unknown): string {
  if (err instanceof ApiError) {
    const key = knownMcpError(err.code) ?? knownMcpError(err.message)
    return key ? t(key) : errorText(t, err)
  }
  return err instanceof Error ? err.message : String(err)
}

export function formatArgsInput(args: string[]): string {
  if (args.length === 0) return ''
  if (args.length === 1 && /\s/.test(args[0]!)) return JSON.stringify(args)
  return args.join('\n')
}

export function parseArgsInput(raw: string): string[] {
  const trimmed = raw.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        return parsed
      }
    } catch {
      // Fall through to line / token parsing
    }
  }
  if (raw.includes('\n')) {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!
    if (quote) {
      if (ch === quote) {
        quote = null
      } else if (ch === '\\' && quote === '"' && i + 1 < trimmed.length) {
        i += 1
        current += trimmed[i]!
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((val, idx) => val === b[idx])
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) {
    if (!b.has(item)) return false
  }
  return true
}

function upsertServerInSnapshot(
  state: McpServersSnapshot,
  server: McpServerView,
  knownBotIds: string[],
): McpServersSnapshot {
  const exists = state.servers.some((s) => s.id === server.id)
  const servers = exists
    ? state.servers.map((s) => (s.id === server.id ? server : s))
    : [...state.servers, server]
  const allBotIds = new Set([...Object.keys(state.botGrants), ...knownBotIds, ...server.grantedBotIds])
  const botGrants: Record<string, string[]> = {}
  for (const botId of allBotIds) {
    const prev = state.botGrants[botId] ?? []
    const has = prev.includes(server.id)
    const wants = server.grantedBotIds.includes(botId)
    if (has === wants) {
      if (botId in state.botGrants || wants) botGrants[botId] = prev
    } else {
      botGrants[botId] = wants ? [...prev, server.id] : prev.filter((id) => id !== server.id)
    }
  }
  return { servers, botGrants }
}

function removeServerFromSnapshot(state: McpServersSnapshot, serverId: string): McpServersSnapshot {
  const servers = state.servers.filter((s) => s.id !== serverId)
  const botGrants: Record<string, string[]> = {}
  for (const [botId, ids] of Object.entries(state.botGrants)) {
    botGrants[botId] = ids.filter((id) => id !== serverId)
  }
  return { servers, botGrants }
}

function defaultToolMode(server: McpServerView, tool: { readOnlyHint: boolean; destructiveHint: boolean }): McpToolMode {
  return server.trustReadOnlyHint && tool.readOnlyHint && !tool.destructiveHint ? 'read' : 'write'
}

export function McpTab({
  state,
  roster,
  onChange,
  onSignedOut,
}: {
  state: McpServersSnapshot
  roster: Roster
  onChange: (next: McpServersSnapshot) => void
  onSignedOut?: () => void
}) {
  const t = useT()
  const stateRef = useRef(state)
  stateRef.current = state
  const rowSeq = useRef(1)
  const nextRowId = () => rowSeq.current++

  const [formMode, setFormMode] = useState<{ kind: 'add' } | { kind: 'edit'; serverId: string } | { kind: 'import' } | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [transportDraft, setTransportDraft] = useState<McpTransportKind>('stdio')
  const [commandDraft, setCommandDraft] = useState('')
  const [argsDraft, setArgsDraft] = useState('')
  const [cwdDraft, setCwdDraft] = useState('')
  const [urlDraft, setUrlDraft] = useState('')
  const [envRows, setEnvRows] = useState<SecretRow[]>([])
  const [headerRows, setHeaderRows] = useState<SecretRow[]>([])
  const [trustHintDraft, setTrustHintDraft] = useState(false)
  const [formBots, setFormBots] = useState<Set<string>>(() => new Set())

  const [importJsonDraft, setImportJsonDraft] = useState('')
  const [importTrustHint, setImportTrustHint] = useState(false)
  const [importBots, setImportBots] = useState<Set<string>>(() => new Set())
  const [importResult, setImportResult] = useState<{
    importedCount: number
    errors: { name: string; error: string }[]
  } | null>(null)

  const [managingAccessId, setManagingAccessId] = useState<string | null>(null)
  const [accessBots, setAccessBots] = useState<Set<string>>(() => new Set())
  const [expandedTools, setExpandedTools] = useState<Set<string>>(() => new Set())

  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<McpServerView | null>(null)

  const botOrder = useMemo(() => {
    const ids = Object.keys(roster)
    for (const id of Object.keys(state.botGrants)) {
      if (!ids.includes(id)) ids.push(id)
    }
    for (const s of state.servers) {
      for (const id of s.grantedBotIds) {
        if (!ids.includes(id)) ids.push(id)
      }
    }
    return ids
  }, [roster, state.botGrants, state.servers])

  const orderedBotsFromSet = (selected: Set<string>): string[] => {
    const out = botOrder.filter((id) => selected.has(id))
    for (const id of selected) {
      if (!out.includes(id)) out.push(id)
    }
    return out
  }

  const toggleSet = (setter: Dispatch<SetStateAction<Set<string>>>, id: string) => {
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const closeInline = formMode
    ? () => {
        setFormMode(null)
        setError(null)
      }
    : managingAccessId
      ? () => {
          setManagingAccessId(null)
          setAccessBots(new Set())
        }
      : undefined
  useEscape(closeInline)

  const openAddForm = () => {
    setError(null)
    setImportResult(null)
    setManagingAccessId(null)
    setNameDraft('')
    setTransportDraft('stdio')
    setCommandDraft('')
    setArgsDraft('')
    setCwdDraft('')
    setUrlDraft('')
    setEnvRows([])
    setHeaderRows([])
    setTrustHintDraft(false)
    setFormBots(new Set())
    setFormMode({ kind: 'add' })
  }

  const openEditForm = (server: McpServerView) => {
    setError(null)
    setImportResult(null)
    setManagingAccessId(null)
    setNameDraft(server.name)
    setTransportDraft(server.transport)
    setCommandDraft(server.command)
    setArgsDraft(formatArgsInput(server.args))
    setCwdDraft(server.cwd)
    setUrlDraft(server.url)
    setEnvRows(
      server.envKeys.map((k) => ({
        id: nextRowId(),
        key: k,
        value: '',
        savedMasked: server.envMasked[k] ?? '••••',
        originalKey: k,
      })),
    )
    setHeaderRows(
      server.headerKeys.map((k) => ({
        id: nextRowId(),
        key: k,
        value: '',
        savedMasked: server.headersMasked[k] ?? '••••',
        originalKey: k,
      })),
    )
    setTrustHintDraft(server.trustReadOnlyHint)
    setFormBots(new Set(server.grantedBotIds))
    setFormMode({ kind: 'edit', serverId: server.id })
  }

  const openImportForm = () => {
    setError(null)
    setImportResult(null)
    setManagingAccessId(null)
    setImportJsonDraft('')
    setImportTrustHint(false)
    setImportBots(new Set())
    setFormMode({ kind: 'import' })
  }

  const addSecretRow = (kind: 'env' | 'headers', presetKey = '', presetValue = '') => {
    const setter = kind === 'env' ? setEnvRows : setHeaderRows
    setter((prev) => [...prev, { id: nextRowId(), key: presetKey, value: presetValue }])
  }

  const prefillBearerHeader = () => {
    setHeaderRows((prev) => {
      const idx = prev.findIndex((r) => r.key.trim().toLowerCase() === 'authorization')
      if (idx !== -1) {
        return prev.map((r, i) => (i === idx && !r.value ? { ...r, key: 'Authorization', value: 'Bearer ' } : r))
      }
      return [...prev, { id: nextRowId(), key: 'Authorization', value: 'Bearer ' }]
    })
  }

  const updateSecretRow = (kind: 'env' | 'headers', id: number, patch: Partial<Pick<SecretRow, 'key' | 'value'>>) => {
    const setter = kind === 'env' ? setEnvRows : setHeaderRows
    setter((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  const removeSecretRow = (kind: 'env' | 'headers', id: number) => {
    const setter = kind === 'env' ? setEnvRows : setHeaderRows
    setter((prev) => prev.filter((r) => r.id !== id))
  }

  const buildCreateSecrets = (rows: SecretRow[]): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const r of rows) {
      const k = r.key.trim()
      if (!k && !r.value) continue
      if (r.value !== '' || !k) {
        out[k] = r.value
      }
    }
    return out
  }

  const buildEditSecretsPatch = (rows: SecretRow[], origKeys: string[]): Record<string, string | null> => {
    const patch: Record<string, string | null> = {}
    const keptOrig = new Set<string>()
    for (const r of rows) {
      const k = r.key.trim()
      if (!k && !r.value) continue
      if (r.originalKey && k === r.originalKey) {
        keptOrig.add(r.originalKey)
        if (r.value !== '') {
          patch[k] = r.value
        }
      } else if (r.value !== '' || !k) {
        patch[k] = r.value
      }
    }
    for (const orig of origKeys) {
      if (!keptOrig.has(orig) && !(orig in patch)) {
        patch[orig] = null
      }
    }
    return patch
  }

  const submitAddOrEdit = async () => {
    if (!formMode || formMode.kind === 'import') return
    setBusyId('form')
    setError(null)
    try {
      const selectedBotIds = orderedBotsFromSet(formBots)
      if (formMode.kind === 'add') {
        const input: CreateMcpServerInput = {
          name: nameDraft.trim(),
          transport: transportDraft,
          trustReadOnlyHint: trustHintDraft,
          ...(selectedBotIds.length > 0 ? { botIds: selectedBotIds } : {}),
        }
        if (transportDraft === 'stdio') {
          input.command = commandDraft.trim()
          const parsedArgs = parseArgsInput(argsDraft)
          if (parsedArgs.length > 0) input.args = parsedArgs
          if (cwdDraft.trim()) input.cwd = cwdDraft.trim()
          const envMap = buildCreateSecrets(envRows)
          if (Object.keys(envMap).length > 0) input.env = envMap
        } else {
          input.url = urlDraft.trim()
          const headersMap = buildCreateSecrets(headerRows)
          if (Object.keys(headersMap).length > 0) input.headers = headersMap
        }
        const res = await createMcpServer(input)
        onChange(upsertServerInSnapshot(stateRef.current, res.server, botOrder))
        setFormMode(null)
      } else {
        const existing = stateRef.current.servers.find((s) => s.id === formMode.serverId)
        if (!existing) {
          setFormMode(null)
          return
        }
        const patch: UpdateMcpServerPatch = {}
        if (nameDraft.trim() !== existing.name) patch.name = nameDraft.trim()
        if (transportDraft !== existing.transport) patch.transport = transportDraft
        if (transportDraft === 'stdio') {
          const parsedArgs = parseArgsInput(argsDraft)
          if (transportDraft !== existing.transport || commandDraft.trim() !== existing.command) {
            patch.command = commandDraft.trim()
          }
          if (transportDraft !== existing.transport || !arraysEqual(parsedArgs, existing.args)) {
            patch.args = parsedArgs
          }
          if (transportDraft !== existing.transport || cwdDraft.trim() !== existing.cwd) {
            patch.cwd = cwdDraft.trim()
          }
          const envPatch = buildEditSecretsPatch(envRows, existing.envKeys)
          if (Object.keys(envPatch).length > 0) patch.env = envPatch
        } else {
          if (transportDraft !== existing.transport || urlDraft.trim() !== existing.url) {
            patch.url = urlDraft.trim()
          }
          const headersPatch = buildEditSecretsPatch(headerRows, existing.headerKeys)
          if (Object.keys(headersPatch).length > 0) patch.headers = headersPatch
        }
        if (trustHintDraft !== existing.trustReadOnlyHint) {
          patch.trustReadOnlyHint = trustHintDraft
        }
        if (!setsEqual(formBots, new Set(existing.grantedBotIds))) {
          patch.botIds = selectedBotIds
        }
        const res = await updateMcpServer(existing.id, patch)
        onChange(upsertServerInSnapshot(stateRef.current, res.server, botOrder))
        setFormMode(null)
      }
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut?.(); return }
      setError(mcpErrorMessage(t, err))
    } finally {
      setBusyId(null)
    }
  }

  const submitImport = async () => {
    if (!importJsonDraft.trim()) return
    setBusyId('import')
    setError(null)
    setImportResult(null)
    try {
      const selectedBotIds = orderedBotsFromSet(importBots)
      const res = await importMcpServers({
        json: importJsonDraft,
        ...(selectedBotIds.length > 0 ? { botIds: selectedBotIds } : {}),
        trustReadOnlyHint: importTrustHint,
      })
      let next = stateRef.current
      for (const srv of res.imported) {
        next = upsertServerInSnapshot(next, srv, botOrder)
      }
      if (res.imported.length > 0) {
        onChange(next)
      }
      setImportResult({ importedCount: res.imported.length, errors: res.errors })
      if (res.imported.length > 0 || res.errors.length === 0) {
        setFormMode(null)
        setImportJsonDraft('')
      }
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut?.(); return }
      setError(mcpErrorMessage(t, err))
    } finally {
      setBusyId(null)
    }
  }

  const doTest = async (serverId: string) => {
    setBusyId(`test:${serverId}`)
    setError(null)
    try {
      const res = await testMcpServer(serverId)
      onChange(upsertServerInSnapshot(stateRef.current, res.server, botOrder))
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut?.(); return }
      setError(mcpErrorMessage(t, err))
    } finally {
      setBusyId(null)
    }
  }

  const doToggleEnabled = async (server: McpServerView) => {
    setBusyId(`enable:${server.id}`)
    setError(null)
    try {
      const res = await updateMcpServer(server.id, { enabled: !server.enabled })
      onChange(upsertServerInSnapshot(stateRef.current, res.server, botOrder))
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut?.(); return }
      setError(mcpErrorMessage(t, err))
    } finally {
      setBusyId(null)
    }
  }

  const doToggleTrustHint = async (server: McpServerView, nextTrust: boolean) => {
    setBusyId(`trust:${server.id}`)
    setError(null)
    try {
      const res = await updateMcpServer(server.id, { trustReadOnlyHint: nextTrust })
      onChange(upsertServerInSnapshot(stateRef.current, res.server, botOrder))
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut?.(); return }
      setError(mcpErrorMessage(t, err))
    } finally {
      setBusyId(null)
    }
  }

  const doChangeToolPolicy = async (serverId: string, toolName: string, choice: McpToolPolicyChoice) => {
    setBusyId(`policy:${serverId}:${toolName}`)
    setError(null)
    try {
      const res = await updateMcpServer(serverId, { toolPolicies: { [toolName]: choice } })
      onChange(upsertServerInSnapshot(stateRef.current, res.server, botOrder))
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut?.(); return }
      setError(mcpErrorMessage(t, err))
    } finally {
      setBusyId(null)
    }
  }

  const openManageAccess = (server: McpServerView) => {
    setError(null)
    setFormMode(null)
    setManagingAccessId(server.id)
    setAccessBots(new Set(server.grantedBotIds))
  }

  const doSaveAccess = async (server: McpServerView) => {
    setBusyId(`access:${server.id}`)
    setError(null)
    try {
      const nextBotIds = orderedBotsFromSet(accessBots)
      await setMcpServerBots(server.id, nextBotIds)
      const latest = stateRef.current.servers.find((s) => s.id === server.id) ?? server
      onChange(upsertServerInSnapshot(stateRef.current, { ...latest, grantedBotIds: nextBotIds }, botOrder))
      setManagingAccessId(null)
      setAccessBots(new Set())
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut?.(); return }
      setError(mcpErrorMessage(t, err))
    } finally {
      setBusyId(null)
    }
  }

  const doDelete = async (serverId: string) => {
    setBusyId(`delete:${serverId}`)
    setError(null)
    try {
      await deleteMcpServer(serverId)
      onChange(removeServerFromSnapshot(stateRef.current, serverId))
    } catch (err) {
      if (err instanceof SignedOut) { onSignedOut?.(); return }
      setError(mcpErrorMessage(t, err))
    } finally {
      setBusyId(null)
    }
  }

  const editingServer = formMode?.kind === 'edit'
    ? state.servers.find((s) => s.id === formMode.serverId)
    : undefined

  const renderSecretRows = (kind: 'env' | 'headers', rows: SecretRow[]) => (
    <div className="mcp-secrets">
      <div className="mcp-secrets-head">
        <span className="conn-label">{t(kind === 'env' ? 'mcp.field.env' : 'mcp.field.headers')}</span>
        <div className="mcp-secrets-actions">
          {kind === 'headers' ? (
            <button
              type="button"
              className="mcp-hint-btn"
              disabled={busyId !== null}
              onClick={prefillBearerHeader}
            >
              + Authorization: Bearer …
            </button>
          ) : null}
          <button
            type="button"
            className="mcp-add-row-btn"
            disabled={busyId !== null}
            onClick={() => addSecretRow(kind)}
          >
            <PlusIcon size={11} />
            <span>{t(kind === 'env' ? 'mcp.field.addVar' : 'mcp.field.addHeader')}</span>
          </button>
        </div>
      </div>
      {rows.length > 0 ? (
        <div className="mcp-secret-rows">
          {rows.map((row) => (
            <div className="mcp-secret-row" key={row.id}>
              <input
                type="text"
                spellCheck={false}
                value={row.key}
                placeholder={t('mcp.field.keyPlaceholder')}
                disabled={busyId !== null}
                onChange={(e) => updateSecretRow(kind, row.id, { key: e.target.value })}
              />
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={row.value}
                placeholder={
                  row.savedMasked && (!row.originalKey || row.key.trim() === row.originalKey)
                    ? t('mcp.field.secretSavedPlaceholder', { masked: row.savedMasked })
                    : t('mcp.field.valuePlaceholder')
                }
                disabled={busyId !== null}
                onChange={(e) => updateSecretRow(kind, row.id, { value: e.target.value })}
              />
              <button
                type="button"
                className="danger"
                disabled={busyId !== null}
                onClick={() => removeSecretRow(kind, row.id)}
              >
                {t('mcp.field.removeRow')}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )

  return (
    <div className="mcp-tab">
      <p className="conn-intro">{t('mcp.custody')}</p>

      <div className="mcp-toolbar">
        <button
          type="button"
          className="connector-connect-btn"
          disabled={busyId !== null}
          onClick={openAddForm}
        >
          <PlusIcon size={12} />
          <span>{t('mcp.addServer')}</span>
        </button>
        <button
          type="button"
          className="connector-connect-btn"
          disabled={busyId !== null}
          onClick={openImportForm}
        >
          <span>{t('mcp.importJson')}</span>
        </button>
      </div>

      {error ? <div className="form-error connectors-error" role="alert">{error}</div> : null}

      {importResult ? (
        <div className="mcp-import-summary" role="status">
          {importResult.importedCount > 0 ? (
            <div className="conn-check ok">
              <span aria-hidden="true">✓ </span>
              <span>{t('mcp.importSuccess', { count: importResult.importedCount })}</span>
            </div>
          ) : null}
          {importResult.errors.length > 0 ? (
            <div className="mcp-import-errors">
              <div className="conn-check bad">{t('mcp.importPartialErrors', { count: importResult.errors.length })}</div>
              <ul>
                {importResult.errors.map((item, idx) => (
                  <li key={`${item.name}-${idx}`}>{t('mcp.importErrorRow', { name: item.name, error: item.error })}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {formMode && formMode.kind !== 'import' ? (
        <form
          className="conn-form mcp-inline-card"
          onSubmit={(e) => {
            e.preventDefault()
            void submitAddOrEdit()
          }}
        >
          <div className="mcp-inline-title">
            {editingServer ? t('mcp.editTitle', { name: editingServer.name }) : t('mcp.addTitle')}
          </div>

          <div className="mcp-form-grid">
            <label>
              <span className="conn-label">{t('mcp.field.name')}</span>
              <input
                type="text"
                value={nameDraft}
                placeholder={t('mcp.field.namePlaceholder')}
                disabled={busyId !== null}
                onChange={(e) => setNameDraft(e.target.value)}
              />
            </label>
            <label>
              <span className="conn-label">{t('mcp.field.transport')}</span>
              <select
                value={transportDraft}
                disabled={busyId !== null}
                onChange={(e) => setTransportDraft(e.target.value as McpTransportKind)}
              >
                <option value="stdio">{t('mcp.transport.stdio')}</option>
                <option value="http">{t('mcp.transport.http')}</option>
              </select>
            </label>
          </div>

          {transportDraft === 'stdio' ? (
            <>
              <div className="mcp-form-grid">
                <label>
                  <span className="conn-label">{t('mcp.field.command')}</span>
                  <input
                    type="text"
                    spellCheck={false}
                    value={commandDraft}
                    placeholder={t('mcp.field.commandPlaceholder')}
                    disabled={busyId !== null}
                    onChange={(e) => setCommandDraft(e.target.value)}
                  />
                </label>
                <label>
                  <span className="conn-label">{t('mcp.field.cwd')}</span>
                  <input
                    type="text"
                    spellCheck={false}
                    value={cwdDraft}
                    placeholder={t('mcp.field.cwdPlaceholder')}
                    disabled={busyId !== null}
                    onChange={(e) => setCwdDraft(e.target.value)}
                  />
                </label>
              </div>
              <label>
                <span className="conn-label">{t('mcp.field.args')}</span>
                <textarea
                  rows={2}
                  spellCheck={false}
                  value={argsDraft}
                  placeholder={t('mcp.field.argsPlaceholder')}
                  disabled={busyId !== null}
                  onChange={(e) => setArgsDraft(e.target.value)}
                />
              </label>
              {renderSecretRows('env', envRows)}
            </>
          ) : (
            <>
              <label>
                <span className="conn-label">{t('mcp.field.url')}</span>
                <input
                  type="text"
                  spellCheck={false}
                  value={urlDraft}
                  placeholder={t('mcp.field.urlPlaceholder')}
                  disabled={busyId !== null}
                  onChange={(e) => setUrlDraft(e.target.value)}
                />
              </label>
              {renderSecretRows('headers', headerRows)}
            </>
          )}

          <div className="mcp-trust-block">
            <label className="conn-check-row">
              <input
                type="checkbox"
                checked={trustHintDraft}
                disabled={busyId !== null}
                onChange={(e) => setTrustHintDraft(e.target.checked)}
              />
              <span>{t('mcp.field.trustReadOnlyHint')}</span>
            </label>
            <p className="conn-note">{t('mcp.field.trustReadOnlyHintHelp')}</p>
          </div>

          <div className="connector-picker">
            <div className="connector-picker-label">{t('mcp.grantTo')}</div>
            <TeammateCheckList
              roster={roster}
              selected={formBots}
              disabled={busyId !== null}
              onToggle={(botId) => toggleSet(setFormBots, botId)}
            />
          </div>

          <div className="conn-form-buttons">
            <span className="spacer" />
            <button
              type="button"
              disabled={busyId !== null}
              onClick={() => {
                setFormMode(null)
                setError(null)
              }}
            >
              {t('mcp.cancel')}
            </button>
            <button
              type="submit"
              className="primary"
              disabled={
                busyId !== null
                || !nameDraft.trim()
                || (transportDraft === 'stdio' ? !commandDraft.trim() : !urlDraft.trim())
              }
            >
              {busyId === 'form' ? t('mcp.saving') : t('mcp.save')}
            </button>
          </div>
        </form>
      ) : null}

      {formMode?.kind === 'import' ? (
        <form
          className="conn-form mcp-inline-card"
          onSubmit={(e) => {
            e.preventDefault()
            void submitImport()
          }}
        >
          <div className="mcp-inline-title">{t('mcp.importTitle')}</div>
          <p className="conn-note">{t('mcp.importHint')}</p>
          <textarea
            className="mcp-json-textarea"
            rows={6}
            spellCheck={false}
            value={importJsonDraft}
            aria-label={t('mcp.importTitle')}
            placeholder={t('mcp.importPlaceholder')}
            disabled={busyId !== null}
            onChange={(e) => setImportJsonDraft(e.target.value)}
          />

          <div className="mcp-trust-block">
            <label className="conn-check-row">
              <input
                type="checkbox"
                checked={importTrustHint}
                disabled={busyId !== null}
                onChange={(e) => setImportTrustHint(e.target.checked)}
              />
              <span>{t('mcp.field.trustReadOnlyHint')}</span>
            </label>
            <p className="conn-note">{t('mcp.field.trustReadOnlyHintHelp')}</p>
          </div>

          <div className="connector-picker">
            <div className="connector-picker-label">{t('mcp.grantTo')}</div>
            <TeammateCheckList
              roster={roster}
              selected={importBots}
              disabled={busyId !== null}
              onToggle={(botId) => toggleSet(setImportBots, botId)}
            />
          </div>

          <div className="conn-form-buttons">
            <span className="spacer" />
            <button
              type="button"
              disabled={busyId !== null}
              onClick={() => {
                setFormMode(null)
                setError(null)
              }}
            >
              {t('mcp.cancel')}
            </button>
            <button
              type="submit"
              className="primary"
              disabled={busyId !== null || !importJsonDraft.trim()}
            >
              {busyId === 'import' ? t('mcp.importing') : t('mcp.importSubmit')}
            </button>
          </div>
        </form>
      ) : null}

      {state.servers.length === 0 && !formMode ? (
        <div className="mcp-empty">{t('mcp.empty')}</div>
      ) : null}

      {state.servers.length > 0 ? (
        <div className="mcp-cards">
          {state.servers.map((server) => {
            const statusKey = !server.enabled ? 'paused' : server.status
            const grantedIds = botOrder.filter((botId) => server.grantedBotIds.includes(botId))
            const grantedNames = grantedIds.map((botId) => roster[botId]?.name ?? botId)
            const endpoint = server.transport === 'stdio'
              ? [server.command, ...server.args].join(' ')
              : server.url
            const isManaging = managingAccessId === server.id
            const isToolsOpen = expandedTools.has(server.id)

            return (
              <div className="connector-card mcp-card" key={server.id}>
                <div className="mcp-card-head">
                  <div className="mcp-card-title-group">
                    <span className="connector-app-name">{server.name}</span>
                    <span className="mcp-transport-pill">{server.transport === 'stdio' ? 'stdio' : 'HTTP'}</span>
                  </div>
                  <span className={`connector-status mcp-status ${statusKey}`}>
                    {t(`mcp.status.${statusKey}` as MessageKey)}
                  </span>
                </div>

                {endpoint ? <div className="mcp-endpoint">{endpoint}</div> : null}

                <div className="mcp-card-meta">
                  <span>{t('panel.mcpToolsCount', { count: server.tools.length })}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {grantedNames.length > 0
                      ? t('mcp.grantedTo', { names: grantedNames.join(t.lang === 'zh-CN' ? '、' : ', ') })
                      : t('mcp.noGrants')}
                  </span>
                </div>

                {server.lastError ? <div className="mcp-server-error">{server.lastError}</div> : null}

                {isManaging ? (
                  <div className="connector-picker">
                    <div className="connector-picker-label">{t('mcp.grantTo')}</div>
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
                        onClick={() => {
                          setManagingAccessId(null)
                          setAccessBots(new Set())
                        }}
                      >
                        {t('mcp.cancel')}
                      </button>
                      <button
                        type="button"
                        className="primary"
                        disabled={busyId !== null}
                        onClick={() => void doSaveAccess(server)}
                      >
                        {t('mcp.saveAccess')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="conn-actions connector-account-actions">
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void doTest(server.id)}
                    >
                      {busyId === `test:${server.id}` ? t('mcp.testing') : t('mcp.test')}
                    </button>
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void doToggleEnabled(server)}
                    >
                      {server.enabled ? t('mcp.pause') : t('mcp.enable')}
                    </button>
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => openManageAccess(server)}
                    >
                      {t('mcp.access')}
                    </button>
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => openEditForm(server)}
                    >
                      {t('mcp.edit')}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busyId !== null}
                      onClick={() => setConfirmDelete(server)}
                    >
                      {t('mcp.delete')}
                    </button>
                  </div>
                )}

                <div className="mcp-tools-section">
                  <button
                    type="button"
                    className="mcp-tools-toggle"
                    aria-expanded={isToolsOpen}
                    onClick={() => toggleSet(setExpandedTools, server.id)}
                  >
                    <ChevronRightIcon size={12} className={`mcp-chevron${isToolsOpen ? ' open' : ''}`} />
                    <span>{t('mcp.toolsCount', { count: server.tools.length })}</span>
                  </button>

                  {isToolsOpen ? (
                    <div className="mcp-tools-panel">
                      <label className="mcp-trust-inline">
                        <input
                          type="checkbox"
                          checked={server.trustReadOnlyHint}
                          disabled={busyId !== null}
                          onChange={(e) => void doToggleTrustHint(server, e.target.checked)}
                        />
                        <span>{t('mcp.field.trustReadOnlyHint')}</span>
                      </label>

                      {server.tools.length === 0 ? (
                        <div className="mcp-tools-empty">{t('mcp.toolsEmpty')}</div>
                      ) : (
                        <div className="mcp-tools-list">
                          {server.tools.map((tool) => {
                            const fallbackMode = defaultToolMode(server, tool)
                            const fallbackLabel = t(fallbackMode === 'read' ? 'mcp.policyRead' : 'mcp.policyWrite')
                            return (
                              <div className="mcp-tool-row" key={tool.name}>
                                <div className="mcp-tool-info">
                                  <div className="mcp-tool-head">
                                    <span className="mcp-tool-name">{tool.name}</span>
                                    {tool.readOnlyHint ? (
                                      <span className="mcp-hint-badge readonly">{t('mcp.hintReadOnly')}</span>
                                    ) : null}
                                    {tool.destructiveHint ? (
                                      <span className="mcp-hint-badge destructive">{t('mcp.hintDestructive')}</span>
                                    ) : null}
                                  </div>
                                  {tool.description ? (
                                    <div className="mcp-tool-desc">{tool.description}</div>
                                  ) : null}
                                </div>
                                <select
                                  className="mcp-policy-select"
                                  aria-label={tool.name}
                                  value={tool.overrideMode ?? 'default'}
                                  disabled={busyId !== null}
                                  onChange={(e) =>
                                    void doChangeToolPolicy(
                                      server.id,
                                      tool.name,
                                      e.target.value as McpToolPolicyChoice,
                                    )
                                  }
                                >
                                  <option value="default">{t('mcp.policyDefault', { mode: fallbackLabel })}</option>
                                  <option value="read">{t('mcp.policyRead')}</option>
                                  <option value="write">{t('mcp.policyWrite')}</option>
                                </select>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}

      {confirmDelete ? (
        <ConfirmDialog
          message={t('mcp.confirmDelete', { name: confirmDelete.name })}
          confirmLabel={t('confirm.delete')}
          cancelLabel={t('confirm.cancel')}
          onConfirm={() => {
            const targetId = confirmDelete.id
            setConfirmDelete(null)
            void doDelete(targetId)
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      ) : null}
    </div>
  )
}
