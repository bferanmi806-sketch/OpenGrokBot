export const VAULT_ITEM_KINDS = ['login', 'api_secret', 'personal_info'] as const
export type VaultItemKind = (typeof VAULT_ITEM_KINDS)[number]

export const VAULT_FIELD_KINDS = ['text', 'secret', 'totp'] as const
export type VaultFieldKind = (typeof VAULT_FIELD_KINDS)[number]

export const VAULT_APPROVAL_MODES = ['always', 'on_taint'] as const
export type VaultApprovalMode = (typeof VAULT_APPROVAL_MODES)[number]

export type VaultFieldMeta = {
  key: string
  kind: VaultFieldKind
  label?: string
}

export type VaultItemRow = {
  id: string
  slug: string
  name: string
  kind: VaultItemKind
  allowedDomains: string[]
  fields: VaultFieldMeta[]
  approvalMode: VaultApprovalMode
  notes: string
  createdAt: number
  updatedAt: number
}

export type VaultMaskedField = {
  key: string
  kind: VaultFieldKind
  label?: string
  set: boolean
  preview: string
}

export type VaultItemView = Omit<VaultItemRow, 'fields'> & {
  fields: VaultMaskedField[]
}

export type BotVaultItemView = {
  id: string
  slug: string
  name: string
  kind: VaultItemKind
  allowedDomains: string[]
  fieldKeys: string[]
  approvalMode: VaultApprovalMode
  granted: boolean
}

/**
 * 落入 approvals.execution_json 的冻结凭证填充指令 —— 严禁写入任何明文或验证码。
 */
export type FrozenVaultFillExecution = {
  kind: 'vault_fill'
  operationId: string
  itemId: string
  itemName: string
  field: string
  fieldKind: VaultFieldKind
  target: string
  expectedOrigin: string
  submit: boolean
}

export type VaultFillExecutionResult =
  | { status: 'succeeded'; summary: string }
  | { status: 'failed'; error: string }

/**
 * 可插拔的底层秘密存储抽象：v1 采用与 mcp-secrets.json 一致的本地 0600 原子 JSON 文件，
 * 后续可无缝替换为 AES-256-GCM / OS Keychain / 外部密码管理器 CLI 而无需改调用方。
 */
export interface VaultSecretStore {
  get(itemId: string): Record<string, string>
  patch(itemId: string, update: Record<string, string | null>): Record<string, string>
  remove(itemId: string): void
  masked(itemId: string, fields: readonly VaultFieldMeta[]): VaultMaskedField[]
  redactText(itemIds: readonly string[], text: string): string
}
