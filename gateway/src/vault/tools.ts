import { randomUUID } from 'node:crypto'
import type { AgentEvents, RuleBlock } from '../agent.js'
import { blockText, createApproval, rememberReason } from '../approvals.js'
import type { BotComputer } from '../computer.js'
import { insertMessage, type Db } from '../db.js'
import type { ToolDef } from '../llm.js'
import { matchAllowedDomain } from './domains.js'
import { getVaultItem, getVaultItemBySlug, isVaultItemGrantedToBot, listBotVaultItems } from './store.js'
import { generateTotp } from './totp.js'
import type {
  FrozenVaultFillExecution,
  VaultFieldMeta,
  VaultFillExecutionResult,
  VaultItemRow,
  VaultSecretStore,
} from './types.js'

export const VAULT_FILL_TOOL_NAME = 'browser_fill_secret'

export const VAULT_FILL_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: VAULT_FILL_TOOL_NAME,
    description:
      'Fill a browser form field with a value from your authorized Vault without ever seeing the raw secret. '
      + 'The gateway verifies your authorization and checks that the current HTTPS page matches the item\'s allowed domains. '
      + 'Password fields only fill into password inputs. TOTP fields generate a live 6-digit code at fill time.',
    parameters: {
      type: 'object',
      properties: {
        item_id: {
          type: 'string',
          description: 'The vault item id (e.g. "vault-1a2b3c4d") or slug listed in your Vault section.',
        },
        field: {
          type: 'string',
          description: 'The field key to fill (e.g. "username", "password", "totp").',
        },
        target: {
          type: 'string',
          description: 'CSS selector, label, or placeholder of the field on the current page.',
        },
        submit: {
          type: 'boolean',
          description: 'Press Enter after filling (default false).',
        },
      },
      required: ['item_id', 'field', 'target'],
    },
  },
}

function resolveFieldValue(
  secrets: VaultSecretStore,
  item: VaultItemRow,
  fieldMeta: VaultFieldMeta,
  nowMs: number,
): { ok: true; value: string } | { ok: false; error: string } {
  const stored = secrets.get(item.id)
  const raw = Object.hasOwn(stored, fieldMeta.key) ? stored[fieldMeta.key]! : ''
  if (!raw) {
    return { ok: false, error: `Vault field "${fieldMeta.key}" on "${item.name}" is empty.` }
  }
  if (fieldMeta.kind === 'totp') {
    try {
      return { ok: true, value: generateTotp(raw, nowMs).code }
    } catch (err) {
      return {
        ok: false,
        error: `Could not generate TOTP code for "${item.name}.${fieldMeta.key}": ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
  return { ok: true, value: raw }
}

export type VaultFillCallResult = {
  ok: boolean
  text: string
  held?: boolean
  usedItemId?: string
}

export async function runVaultFillCall(input: {
  db: Db
  secrets: VaultSecretStore
  computer: BotComputer
  botId: string
  threadId: string
  args: Record<string, unknown>
  ruleBlock: RuleBlock | null
  watch?: boolean
  events: AgentEvents
  now: number
}): Promise<VaultFillCallResult> {
  const { db, secrets, computer, botId, threadId, args, ruleBlock, watch, events, now } = input

  if (watch) {
    return {
      ok: false,
      text: `${VAULT_FILL_TOOL_NAME} is not available in a watch routine: this run only looks.`,
    }
  }

  const ref = String(args.item_id ?? '').trim()
  const fieldKey = String(args.field ?? '').trim()
  const target = String(args.target ?? '').trim()
  const submit = args.submit === true

  if (!ref || !fieldKey || !target) {
    return { ok: false, text: `${VAULT_FILL_TOOL_NAME} requires "item_id", "field", and "target".` }
  }

  const granted = listBotVaultItems(db, botId)
  const item = granted.find((i) => i.id === ref || i.slug === ref.toLowerCase())
  if (!item) {
    return { ok: false, text: `Vault item "${ref}" is not available or not authorized for this teammate.` }
  }

  const fieldMeta = item.fields.find((f) => f.key === fieldKey)
  if (!fieldMeta) {
    const keys = item.fields.map((f) => f.key).join(', ')
    return { ok: false, text: `Vault item "${item.name}" has no field "${fieldKey}". Available fields: ${keys}.` }
  }

  // 先检查底层是否有值，避免给空字段白白弹窗审批
  const probe = resolveFieldValue(secrets, item, fieldMeta, now)
  if (!probe.ok) {
    return { ok: false, text: probe.error }
  }

  let currentUrl: string
  try {
    currentUrl = await computer.currentUrl()
  } catch (err) {
    return { ok: false, text: `Could not read current browser URL: ${err instanceof Error ? err.message : String(err)}` }
  }

  const domainCheck = matchAllowedDomain(currentUrl, item.allowedDomains)
  if (!domainCheck.ok) {
    return { ok: false, text: domainCheck.reason }
  }

  const needsApproval = item.approvalMode === 'always' || ruleBlock !== null
  if (needsApproval) {
    const operationId = randomUUID()
    const frozen: FrozenVaultFillExecution = {
      kind: 'vault_fill',
      operationId,
      itemId: item.id,
      itemName: item.name,
      field: fieldMeta.key,
      fieldKind: fieldMeta.kind,
      target,
      expectedOrigin: domainCheck.origin,
      submit,
    }
    const action = `Fill ${item.name} · ${fieldMeta.key} on ${domainCheck.host}`
    const detailLines = [
      `Vault item: ${item.name} (${item.slug})`,
      `Field: ${fieldMeta.key}${fieldMeta.kind === 'totp' ? ' (live 2FA code)' : fieldMeta.kind === 'secret' ? ' (hidden secret)' : ''}`,
      `Target input: ${target}`,
      `Page origin: ${domainCheck.origin}`,
      ...(submit ? ['Will press Enter after filling.'] : []),
      ...(ruleBlock ? [`Approval required (${ruleBlock}).`] : ['Approval required by vault item policy.']),
    ]
    const detail = detailLines.join('\n')
    const kind = 'other' as const
    const approvalTarget = `vault:${item.slug}/${fieldMeta.key}@${domainCheck.host}`

    const approval = createApproval(db, {
      threadId,
      botId,
      action,
      detail,
      kind,
      target: approvalTarget,
      executionJson: JSON.stringify(frozen),
      operationId,
      now,
    })
    const reason = rememberReason({ kind, target: approvalTarget })
    events.onMessage(
      insertMessage(db, {
        threadId,
        sender: botId,
        kind: 'approval_request',
        payload: {
          approvalId: approval.id,
          action,
          detail,
          kind,
          target: approvalTarget,
          status: 'pending',
          canRemember: false,
          ...(reason ? { rememberBlocked: blockText(reason), rememberReason: reason } : {}),
          ...(ruleBlock ? { ruleHeld: ruleBlock } : {}),
        },
      }),
    )

    return {
      ok: true,
      held: true,
      text: `Held vault fill "${item.name}.${fieldMeta.key}" on ${domainCheck.origin} for your operator's approval (#${approval.id}). Stop here and wait — the gateway will fill it once approved.`,
    }
  }

  try {
    const filled = await computer.fillSecret(target, probe.value, {
      expectedOrigin: domainCheck.origin,
      requirePasswordInput: fieldMeta.kind === 'secret',
      submit,
    })
    return {
      ok: true,
      usedItemId: item.id,
      text: `Filled "${fieldMeta.key}" from Vault item "${item.name}" into "${target}" on ${filled.origin}${submit ? ' and pressed Enter' : ''}.`,
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    return { ok: false, text: secrets.redactText([item.id], raw) }
  }
}

export async function safeExecuteVaultFill(input: {
  db: Db
  secrets: VaultSecretStore
  computer: BotComputer
  botId: string
  frozen: FrozenVaultFillExecution
  now: number
}): Promise<VaultFillExecutionResult> {
  const { db, secrets, computer, botId, frozen, now } = input
  const item = getVaultItem(db, frozen.itemId)
  if (!item) {
    return { status: 'failed', error: 'Vault item was deleted before approval.' }
  }
  if (!isVaultItemGrantedToBot(db, botId, item.id)) {
    return { status: 'failed', error: `Vault item "${item.name}" is no longer authorized for this teammate.` }
  }
  const fieldMeta = item.fields.find((f) => f.key === frozen.field)
  if (!fieldMeta) {
    return { status: 'failed', error: `Vault field "${frozen.field}" was removed from "${item.name}".` }
  }

  let currentUrl: string
  try {
    currentUrl = await computer.currentUrl()
  } catch (err) {
    return { status: 'failed', error: `Could not verify browser URL: ${err instanceof Error ? err.message : String(err)}` }
  }

  const domainCheck = matchAllowedDomain(currentUrl, item.allowedDomains)
  if (!domainCheck.ok) {
    return { status: 'failed', error: domainCheck.reason }
  }
  if (domainCheck.origin !== frozen.expectedOrigin) {
    return {
      status: 'failed',
      error: `Browser navigated away from "${frozen.expectedOrigin}" to "${domainCheck.origin}"; nothing was filled.`,
    }
  }

  // 批准时现场重新读取/计算（TOTP 在此刻算最新验证码）
  const resolved = resolveFieldValue(secrets, item, fieldMeta, now)
  if (!resolved.ok) {
    return { status: 'failed', error: resolved.error }
  }

  try {
    const filled = await computer.fillSecret(frozen.target, resolved.value, {
      expectedOrigin: frozen.expectedOrigin,
      requirePasswordInput: fieldMeta.kind === 'secret',
      submit: frozen.submit,
    })
    return {
      status: 'succeeded',
      summary: `Filled "${fieldMeta.key}" from "${item.name}" into "${frozen.target}" on ${filled.origin}${frozen.submit ? ' and pressed Enter' : ''}.`,
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    return { status: 'failed', error: secrets.redactText([item.id], raw) }
  }
}

const MCP_VAULT_REF_RE = /\$\{vault:([a-z0-9_]+)\.([a-zA-Z][a-zA-Z0-9_.-]{0,63})\}/g

/**
 * 解析 MCP 配置值中的 `${vault:<slug>.<field>}` 引用（仅在网关进程内展开，不入库、不进模型上下文）。
 */
export function resolveVaultRefsInRecord(
  db: Db,
  secrets: VaultSecretStore,
  record: Record<string, string>,
): { resolved: Record<string, string>; referencedItemIds: string[] } {
  const resolved: Record<string, string> = {}
  const itemIds = new Set<string>()
  for (const [k, raw] of Object.entries(record)) {
    if (!raw.includes('${vault:')) {
      resolved[k] = raw
      continue
    }
    resolved[k] = raw.replace(MCP_VAULT_REF_RE, (_match, slug: string, field: string) => {
      const item = getVaultItemBySlug(db, slug)
      if (!item) {
        throw new Error(`Referenced vault item "${slug}" does not exist.`)
      }
      const fieldMeta = item.fields.find((f) => f.key === field)
      if (!fieldMeta) {
        throw new Error(`Vault item "${slug}" has no field "${field}".`)
      }
      if (fieldMeta.kind === 'totp') {
        throw new Error(`TOTP field "${slug}.${field}" cannot be used as a static MCP credential reference.`)
      }
      const vals = secrets.get(item.id)
      const val = Object.hasOwn(vals, field) ? vals[field]! : ''
      if (!val) {
        throw new Error(`Vault field "${slug}.${field}" is empty.`)
      }
      itemIds.add(item.id)
      return val
    })
  }
  return { resolved, referencedItemIds: [...itemIds] }
}
