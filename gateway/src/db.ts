import { existsSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { extractSearchableText, syncMessageFts } from './history-search.js'

export type Db = Database.Database
export type MessageKind =
  | 'text'
  | 'report'
  | 'screenshot'
  | 'approval_request'
  | 'approval_resolved'
  | 'memory_updated'
  | 'goal_updated'
  | 'space_updated'
  | 'routine_created'
  | 'bot_ref'
  | 'login_request'
  | 'activity'
  | 'question'
  | 'webhook'
  | 'attachment'
  | 'quiet_digest'
  | 'rule_proposal'
  | 'background_task'
  | 'dispatch_plan'

export type BotRow = {
  id: string
  name: string
  role: string
  emoji: string
  soul_path: string
  /** 本机电脑上允许跑命令（1）；容器电脑不看这个字段 */
  shell_enabled?: number
  /** 这位同事用哪个模型连接；NULL = 默认连接 */
  llm_connection?: string | null
  /** 在那个连接上换用的模型；NULL = 连接自己的默认模型 */
  llm_model?: string | null
}

export type MessageRow = {
  id: number
  thread_id: string
  sender: string // 'user' | bot id | 'webhook'
  kind: MessageKind
  content: string
  payload: unknown | null
  created_at: number
}

export type ThreadCheckpointRow = {
  id: number
  thread_id: string
  bot_id: string
  through_message_id: number
  summary: string
  source_count: number
  had_webhook: number
  created_at: number
}

export type SidebarBot = BotRow & { thread_id: string; last_message: MessageRow | null }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '🤖',
  soul_path TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'dm',
  bot_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_members (
  thread_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, bot_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL DEFAULT '',
  payload TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  message_id INTEGER,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approvals_thread ON approvals(thread_id, status);
CREATE TABLE IF NOT EXISTS routines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  instructions TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_run_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_routines_bot ON routines(bot_id, enabled);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_bot ON usage(bot_id, created_at);
`

/**
 * 迁移一步一格：新库从 0 跑到底，老库从自己记着的版本接着跑。版本号存在 SQLite 文件头的
 * user_version 里，和数据同生共死。要加表、加列、补索引，就在末尾追加一步——已经发布过的步骤不再改。
 */
export type Migration = (db: Db) => void

const MIGRATIONS: Migration[] = [
  // v1：v0.2 的基线。v0.2.x 的老库表都在、版本号却是 0——这一步对它是空操作，只把版本号补上。
  (db) => db.exec(SCHEMA),
  // v2：审批带上类别和去向，好让操作者的「以后都放行」落成规则；规则表；routine 的 webhook 密钥；
  // 按 kind 找消息（还没回答的问题卡片要算进「等你」）
  (db) => db.exec(`
    ALTER TABLE approvals ADD COLUMN kind TEXT NOT NULL DEFAULT 'other';
    ALTER TABLE approvals ADD COLUMN target TEXT NOT NULL DEFAULT '';
    ALTER TABLE approvals ADD COLUMN rule_id INTEGER;
    CREATE TABLE IF NOT EXISTS approval_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      source_approval_id INTEGER,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_rules_bot ON approval_rules(bot_id, kind);
    ALTER TABLE routines ADD COLUMN webhook_key TEXT;
    CREATE INDEX IF NOT EXISTS idx_messages_kind ON messages(kind);
  `),
  // v3：只看不动的 watch routine；一次扣住一批对象的审批（及操作者勾留下的那几项）；每位同事的动作日志
  (db) => db.exec(`
    ALTER TABLE routines ADD COLUMN mode TEXT NOT NULL DEFAULT 'act';
    ALTER TABLE approvals ADD COLUMN items TEXT;
    ALTER TABLE approvals ADD COLUMN approved_items TEXT;
    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      trigger TEXT NOT NULL DEFAULT '',
      tool TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      ok INTEGER,
      ms INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_actions_bot ON actions(bot_id, id);
    CREATE INDEX IF NOT EXISTS idx_actions_time ON actions(created_at);
  `),
  // v4：本机电脑的命令行开关，按同事存（操作者在面板上做的决定，要看得见、能撤）
  (db) => db.exec(`ALTER TABLE bots ADD COLUMN shell_enabled INTEGER NOT NULL DEFAULT 0;`),
  // v5：recorded workflows belong beside routines and actions in the teammate database, not as loose files.
  (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      title TEXT NOT NULL,
      trace_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflows_bot ON workflows(bot_id, created_at DESC, id DESC);
  `),
  // v6：操作者在界面上改的设置（服务商、模型、语言……），值是 JSON；API key 不在这里，单独放 <data>/llm-key。
  // m7-desktop 合并 main 之前把设置表当 v5 建过：那样的库停在 v5、没有 workflows，这里顺手补上（都是 IF NOT EXISTS）
  (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      title TEXT NOT NULL,
      trace_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflows_bot ON workflows(bot_id, created_at DESC, id DESC);
  `),
  // v7：同时接好几家模型，每个同事各用各的。「默认」那个连接还是 settings 里的那套，这里只放另加的；
  // key 不进库，放 <data>/llm-keys/<连接 id>。同事没选（NULL）就用默认连接
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        api TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        vision INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    // 列已经在就不再加：被手动退回老版本号的库（升级测试、回滚过的库）重跑这一步不该炸
    const have = new Set((db.pragma('table_info(bots)') as { name: string }[]).map((c) => c.name))
    if (!have.has('llm_connection')) db.exec('ALTER TABLE bots ADD COLUMN llm_connection TEXT')
    if (!have.has('llm_model')) db.exec('ALTER TABLE bots ADD COLUMN llm_model TEXT')
  },
  // v8：操作者发给同事的文件。本体放 <data>/uploads/<id>，这里只记账；挂到哪条消息上、
  // 每位同事「文件放到它电脑上了没有 / 图给它的模型看过没有」各记一份
  (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      thread_id TEXT,
      message_id INTEGER,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_uploads_message ON uploads(message_id);
    CREATE TABLE IF NOT EXISTS upload_seen (
      upload_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      placed_at INTEGER,
      shown_at INTEGER,
      PRIMARY KEY (upload_id, bot_id)
    );
  `),
  // v9：PDF 的页数，和它的文字抽出来了没有（ok / truncated / none / failed）；别的文件这两列是空的
  (db) => {
    const have = new Set((db.pragma('table_info(uploads)') as { name: string }[]).map((c) => c.name))
    if (!have.has('pages')) db.exec('ALTER TABLE uploads ADD COLUMN pages INTEGER')
    if (!have.has('text_state')) db.exec('ALTER TABLE uploads ADD COLUMN text_state TEXT')
  },
  // v10：待拍板审批、未答问题和登录接管请求的局部索引——托盘轮询 /api/summary 和侧栏刷新不再扫全表历史
  (db) => db.exec(`
    CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(bot_id, thread_id) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_messages_open_wait ON messages(sender, thread_id)
      WHERE kind = 'question' AND json_extract(payload, '$.status') = 'open';
    CREATE INDEX IF NOT EXISTS idx_messages_login_req ON messages(sender, thread_id, id)
      WHERE kind = 'login_request';
  `),
  // v11: approval rows from deterministic workflow replays must not resume as ordinary LLM turns. Some
  // pre-merge v5 databases already have later columns despite their older user_version; keep this additive step safe.
  (db) => {
    const have = new Set((db.pragma('table_info(approvals)') as { name: string }[]).map((c) => c.name))
    if (!have.has('workflow_run_id')) db.exec('ALTER TABLE approvals ADD COLUMN workflow_run_id TEXT')
  },
  // v12：第三方应用连接器（账号表 + 按同事显式授权表），以及网关代执行连接器写操作的冻结载荷与结果列
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS connector_accounts (
        id TEXT PRIMARY KEY,
        app TEXT NOT NULL,
        driver TEXT NOT NULL DEFAULT 'composio',
        remote_id TEXT NOT NULL,
        auth_config_id TEXT NOT NULL DEFAULT '',
        account_label TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT NOT NULL DEFAULT '',
        notified_expired INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_connector_accounts_app ON connector_accounts(app, status);
      CREATE TABLE IF NOT EXISTS bot_connectors (
        bot_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, connector_id)
      );
      CREATE INDEX IF NOT EXISTS idx_bot_connectors_connector ON bot_connectors(connector_id);
    `)
    const have = new Set((db.pragma('table_info(approvals)') as { name: string }[]).map((c) => c.name))
    if (!have.has('execution_json')) db.exec('ALTER TABLE approvals ADD COLUMN execution_json TEXT')
    if (!have.has('execution_status')) db.exec('ALTER TABLE approvals ADD COLUMN execution_status TEXT')
    if (!have.has('execution_detail')) db.exec('ALTER TABLE approvals ADD COLUMN execution_detail TEXT')
    if (!have.has('operation_id')) db.exec('ALTER TABLE approvals ADD COLUMN operation_id TEXT')
  },
  // v13：标准 MCP 客户端服务表（stdio / Streamable HTTP）与按同事显式授权表（密钥单独存 <data>/mcp-secrets.json）
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        transport TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        command TEXT NOT NULL DEFAULT '',
        args_json TEXT NOT NULL DEFAULT '[]',
        cwd TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        env_keys_json TEXT NOT NULL DEFAULT '[]',
        header_keys_json TEXT NOT NULL DEFAULT '[]',
        trust_read_only_hint INTEGER NOT NULL DEFAULT 0,
        tools_json TEXT NOT NULL DEFAULT '[]',
        tool_policies_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'disconnected',
        last_error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);
      CREATE TABLE IF NOT EXISTS bot_mcp_servers (
        bot_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, server_id)
      );
      CREATE INDEX IF NOT EXISTS idx_bot_mcp_servers_server ON bot_mcp_servers(server_id);
    `)
  },
  // v14：共享团队实体知识库（contact / client / project / topic），含修订历史与 FTS5 全文索引
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS wiki_pages (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        body TEXT NOT NULL DEFAULT '',
        search_text TEXT NOT NULL DEFAULT '',
        source_tainted INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT NOT NULL DEFAULT 'operator',
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER,
        UNIQUE(kind, slug)
      );
      CREATE INDEX IF NOT EXISTS idx_wiki_pages_active ON wiki_pages(archived_at, kind, updated_at DESC);

      CREATE TABLE IF NOT EXISTS wiki_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        body TEXT NOT NULL DEFAULT '',
        edited_by TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        source_tainted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(page_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_wiki_revisions_page ON wiki_revisions(page_id, version DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
        page_id UNINDEXED,
        title,
        tags,
        summary,
        body,
        search_text,
        tokenize='unicode61 remove_diacritics 2'
      );
    `)
  },
  // v15：免打扰晨报缓冲表、受控学习规矩提议表，以及按驳回模式统计审批的索引
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quiet_digest_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        routine_id INTEGER,
        routine_name TEXT NOT NULL DEFAULT '',
        routine_mode TEXT NOT NULL DEFAULT 'watch',
        kind TEXT NOT NULL DEFAULT 'text',
        summary TEXT NOT NULL DEFAULT '',
        payload_json TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_quiet_digest_pending
        ON quiet_digest_items(delivered_at, bot_id, id);

      CREATE TABLE IF NOT EXISTS rule_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        rule TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'agent',
        dedupe_key TEXT NOT NULL DEFAULT '',
        source_tainted INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        message_id INTEGER,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_rule_proposals_bot_status
        ON rule_proposals(bot_id, status, id DESC);
      CREATE INDEX IF NOT EXISTS idx_rule_proposals_dedupe
        ON rule_proposals(bot_id, dedupe_key, status);

      CREATE INDEX IF NOT EXISTS idx_approvals_discard_lookup
        ON approvals(bot_id, status, kind, target, resolved_at DESC);
    `)
  },
  // v16：非阻塞后台任务表（Meta / AlterEgo 副车道执行记录与实时进度）
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS background_tasks (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        step_count INTEGER NOT NULL DEFAULT 0,
        last_step TEXT NOT NULL DEFAULT '',
        steps_json TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        uses_browser INTEGER NOT NULL DEFAULT 0,
        source_tainted INTEGER NOT NULL DEFAULT 0,
        message_id INTEGER,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_background_tasks_bot
        ON background_tasks(bot_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_background_tasks_status
        ON background_tasks(status, bot_id);
    `)
  },
  // v17：群组协同调度管线表（DAG 计划与步骤状态）
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_plans (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        source_tainted INTEGER NOT NULL DEFAULT 0,
        message_id INTEGER,
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_plans_thread
        ON dispatch_plans(thread_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dispatch_plans_status
        ON dispatch_plans(status);

      CREATE TABLE IF NOT EXISTS dispatch_plan_steps (
        plan_id TEXT NOT NULL REFERENCES dispatch_plans(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        bot_id TEXT NOT NULL,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        output TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        output_tainted INTEGER NOT NULL DEFAULT 0,
        waiting_approval_id INTEGER,
        waiting_question_id INTEGER,
        started_at INTEGER,
        finished_at INTEGER,
        PRIMARY KEY (plan_id, step_id)
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_plan_steps_plan
        ON dispatch_plan_steps(plan_id, seq ASC);
      CREATE INDEX IF NOT EXISTS idx_dispatch_plan_steps_wait
        ON dispatch_plan_steps(status, waiting_approval_id, waiting_question_id);
    `)
  },
  // v18：独立凭证库元数据表与按同事零默认授权表（明文单独存 <data>/vault-secrets.json，绝不入库）
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vault_items (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        allowed_domains_json TEXT NOT NULL DEFAULT '[]',
        fields_json TEXT NOT NULL DEFAULT '[]',
        approval_mode TEXT NOT NULL DEFAULT 'on_taint',
        notes TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vault_items_kind ON vault_items(kind);
      CREATE TABLE IF NOT EXISTS bot_vault_items (
        bot_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, item_id)
      );
      CREATE INDEX IF NOT EXISTS idx_bot_vault_items_item ON bot_vault_items(item_id);
    `)
  },
  // v19：Feed 指挥台动态流与轻量灵感孵化器，以及 routine 输出目标面（thread / feed / both）
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS feed_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        source_message_id INTEGER,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        body_json TEXT NOT NULL DEFAULT '{}',
        tags_json TEXT NOT NULL DEFAULT '[]',
        tainted INTEGER NOT NULL DEFAULT 0,
        source_label TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'unread',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feed_items_status_time ON feed_items(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_feed_items_bot ON feed_items(bot_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS ideas (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT 'operator',
        source_feed_id TEXT,
        tainted INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'inbox',
        assigned_bot_id TEXT,
        incubation_thread_id TEXT,
        incubation_summary TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ideas_status_time ON ideas(status, updated_at DESC);
    `)
    const have = new Set((db.pragma('table_info(routines)') as { name: string }[]).map((c) => c.name))
    if (!have.has('surface')) db.exec(`ALTER TABLE routines ADD COLUMN surface TEXT NOT NULL DEFAULT 'thread';`)
  },
  // v20：长期目标与里程碑状态机（goals / goal_milestones / goal_updates），并与 routines / actions / ideas 轻量关联
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        success_criteria TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        owner_bot_id TEXT NOT NULL,
        member_bots_json TEXT NOT NULL DEFAULT '[]',
        target_date TEXT,
        source_idea_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goals_status_updated ON goals(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_goals_owner ON goals(owner_bot_id, status);

      CREATE TABLE IF NOT EXISTS goal_milestones (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        owner_bot_id TEXT,
        due_date TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goal_milestones_goal ON goal_milestones(goal_id, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS goal_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id TEXT NOT NULL,
        author_kind TEXT NOT NULL,
        bot_id TEXT,
        kind TEXT NOT NULL DEFAULT 'note',
        summary TEXT NOT NULL,
        diff TEXT NOT NULL DEFAULT '',
        tainted INTEGER NOT NULL DEFAULT 0,
        thread_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goal_updates_goal ON goal_updates(goal_id, id DESC);
    `)
    const routineCols = new Set((db.pragma('table_info(routines)') as { name: string }[]).map((c) => c.name))
    if (!routineCols.has('goal_id')) db.exec('ALTER TABLE routines ADD COLUMN goal_id TEXT;')
    db.exec('CREATE INDEX IF NOT EXISTS idx_routines_goal ON routines(goal_id);')

    const actionCols = new Set((db.pragma('table_info(actions)') as { name: string }[]).map((c) => c.name))
    if (!actionCols.has('goal_id')) db.exec('ALTER TABLE actions ADD COLUMN goal_id TEXT;')
    db.exec('CREATE INDEX IF NOT EXISTS idx_actions_goal ON actions(goal_id, id DESC);')

    const ideaCols = new Set((db.pragma('table_info(ideas)') as { name: string }[]).map((c) => c.name))
    if (!ideaCols.has('promoted_goal_id')) db.exec('ALTER TABLE ideas ADD COLUMN promoted_goal_id TEXT;')
  },
  // v21：声明式活看板 Spaces（spaces / space_items / space_bots，零任意 JS，按同事零默认授权）
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS spaces (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        icon TEXT NOT NULL DEFAULT '📊',
        kind TEXT NOT NULL DEFAULT 'declarative',
        goal_id TEXT,
        schema_json TEXT NOT NULL DEFAULT '{"blocks":[]}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spaces_goal ON spaces(goal_id);
      CREATE INDEX IF NOT EXISTS idx_spaces_updated ON spaces(updated_at DESC);

      CREATE TABLE IF NOT EXISTS space_items (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        block_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '',
        data_json TEXT NOT NULL DEFAULT '{}',
        sort_order INTEGER NOT NULL DEFAULT 0,
        tainted INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT NOT NULL DEFAULT 'operator',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_space_items_space_block ON space_items(space_id, block_id, sort_order, updated_at DESC);

      CREATE TABLE IF NOT EXISTS space_bots (
        space_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'editor',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (space_id, bot_id)
      );
      CREATE INDEX IF NOT EXISTS idx_space_bots_bot ON space_bots(bot_id);
    `)
  },
  // v22：自定义联网 Feed 主题（feed_topics）与 feed_items.topic_id 关联列
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS feed_topics (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        cron TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        last_error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feed_topics_enabled ON feed_topics(enabled, updated_at DESC);
    `)
    const feedCols = new Set((db.pragma('table_info(feed_items)') as { name: string }[]).map((c) => c.name))
    if (!feedCols.has('topic_id')) db.exec('ALTER TABLE feed_items ADD COLUMN topic_id TEXT;')
    db.exec('CREATE INDEX IF NOT EXISTS idx_feed_items_topic ON feed_items(topic_id, created_at DESC);')
  },
  // v23：对话上下文自动整理的待办表（todos），以及 ideas / goals 的原对话来源与自动整理标记
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        owner_bot_id TEXT,
        source_thread_id TEXT,
        origin TEXT NOT NULL DEFAULT 'auto',
        tainted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_todos_status_updated ON todos(status, updated_at DESC);
    `)
    const ideaCols = new Set((db.pragma('table_info(ideas)') as { name: string }[]).map((c) => c.name))
    if (!ideaCols.has('source_thread_id')) db.exec('ALTER TABLE ideas ADD COLUMN source_thread_id TEXT;')

    const goalCols = new Set((db.pragma('table_info(goals)') as { name: string }[]).map((c) => c.name))
    if (!goalCols.has('source_thread_id')) db.exec('ALTER TABLE goals ADD COLUMN source_thread_id TEXT;')
    if (!goalCols.has('origin')) db.exec(`ALTER TABLE goals ADD COLUMN origin TEXT NOT NULL DEFAULT 'operator';`)
  },
  // v24：按 (thread_id, bot_id) 隔离的长对话压缩检查点，替代固定 40 条滑窗硬截断并保持前缀缓存稳定
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        through_message_id INTEGER NOT NULL,
        summary TEXT NOT NULL,
        source_count INTEGER NOT NULL DEFAULT 0,
        had_webhook INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_thread_checkpoints_lookup
        ON thread_checkpoints(thread_id, bot_id, id DESC);
    `)
  },
  // v25：SQLite FTS5 trigram 全文索引，支撑 search_history 跨历史消息检索（仅存脱敏文本，绝不索引审批 target/rule）
  (db) => {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        message_id UNINDEXED,
        thread_id UNINDEXED,
        searchable_text,
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS trg_messages_fts_delete
      AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE message_id = old.id;
      END;
    `)
    const rows = db.prepare(`SELECT id, thread_id, kind, content, payload FROM messages`).all() as {
      id: number; thread_id: string; kind: MessageKind; content: string; payload: string | null
    }[]
    const insert = db.prepare(`INSERT INTO messages_fts (message_id, thread_id, searchable_text) VALUES (?, ?, ?)`)
    for (const r of rows) {
      const parsed = r.payload ? JSON.parse(r.payload) : null
      const text = extractSearchableText(r.kind, r.content, parsed)
      if (text) insert.run(r.id, r.thread_id, text)
    }
  },
]

export const SCHEMA_VERSION = MIGRATIONS.length

export function schemaVersion(db: Db): number {
  return Number(db.pragma('user_version', { simple: true }))
}

/** 把库从它现在的版本升到 steps 的末尾；每一步连同版本号一起落在一个事务里，断电也不会留下半步。 */
export function runMigrations(db: Db, steps: Migration[]): { from: number; to: number } {
  const from = schemaVersion(db)
  if (from > steps.length) {
    throw new Error(
      `This database was written by a newer OpenSuperBot (schema v${from}; this build knows v${steps.length}). `
      + 'Upgrade the gateway, or point OPENSUPERBOT_DATA at a different directory.',
    )
  }
  for (let v = from; v < steps.length; v++) {
    db.transaction(() => {
      steps[v]!(db)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
  return { from, to: steps.length }
}

export function migrate(db: Db): { from: number; to: number } {
  return runMigrations(db, MIGRATIONS)
}

/** 每个库最多留这么多份迁移前备份，旧的删掉 */
export const KEEP_BACKUPS = 3

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`

/**
 * 迁移只能往前走：升级后的库，老版本的网关打不开。所以动手之前先用 VACUUM INTO 留一份完整、一致的
 * 备份（WAL 里的内容也在里面），放在库文件旁边：<库>.v<旧>-before-v<新>.<时间>.bak。只留最近 KEEP_BACKUPS 份。
 * 备份失败就不迁移：宁可网关起不来，也不在没有退路的情况下改用户的数据。
 */
export function backupBeforeMigration(db: Db, path: string, from: number, to: number, now: Date): string {
  const base = basename(path)
  const file = join(dirname(path), `${base}.v${from}-before-v${to}.${stamp(now)}.bak`)
  try {
    db.exec(`VACUUM INTO ${sqlString(file)}`)
  } catch (err) {
    throw new Error(
      `Could not back up ${path} before upgrading its schema v${from} → v${to} (${err instanceof Error ? err.message : String(err)}). `
      + 'Nothing was changed. Free some disk space or copy the file somewhere safe, then start the gateway again.',
    )
  }
  const mine = readdirSync(dirname(path))
    .filter((f) => f.startsWith(`${base}.v`) && /\.v\d+-before-v\d+\.\d{8}T\d{6}Z\.bak$/.test(f))
    .sort()
  for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) rmSync(join(dirname(path), old), { force: true })
  return file
}

export function openDb(
  path = ':memory:',
  opts: { onMigrate?: (from: number, to: number) => void; onBackup?: (file: string) => void; now?: () => Date } = {},
): Db {
  const existed = path !== ':memory:' && existsSync(path)
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  const before = schemaVersion(db)
  // 只有真有东西可丢时才备份：新建的空库、已经是最新的库、更新的网关写的库（下面会直接拒绝）都不用
  const hasData = existed && Number(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'`).pluck().get()) > 0
  if (hasData && before < SCHEMA_VERSION) {
    const file = backupBeforeMigration(db, path, before, SCHEMA_VERSION, (opts.now ?? (() => new Date()))())
    opts.onBackup?.(file)
  }
  const { from, to } = migrate(db)
  if (from !== to) opts.onMigrate?.(from, to)
  return db
}

/** 空的 role/emoji 表示「来源没写」，不能拿它覆盖库里已有的值——否则每次重启都会抹掉新同事的职位。 */
export function upsertBot(db: Db, bot: BotRow): void {
  db.prepare(
    `INSERT INTO bots (id, name, role, emoji, soul_path, created_at)
     VALUES (@id, @name, @role, COALESCE(NULLIF(@emoji, ''), '🤖'), @soul_path, @created_at)
     ON CONFLICT(id) DO UPDATE SET
       name = @name,
       role = CASE WHEN @role <> '' THEN @role ELSE bots.role END,
       emoji = CASE WHEN @emoji <> '' THEN @emoji ELSE bots.emoji END,
       soul_path = @soul_path`,
  ).run({ ...bot, created_at: Date.now() })
}

/** 本机电脑的命令行：开或关。不存在的同事返回 false。 */
export function setBotShell(db: Db, botId: string, enabled: boolean): boolean {
  return db.prepare('UPDATE bots SET shell_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, botId).changes > 0
}

export function botShellEnabled(db: Db, botId: string): boolean {
  const row = db.prepare('SELECT shell_enabled FROM bots WHERE id = ?').get(botId) as { shell_enabled: number } | undefined
  return row?.shell_enabled === 1
}

export function ensureDmThread(db: Db, botId: string): string {
  const id = `dm:${botId}`
  db.prepare(`INSERT OR IGNORE INTO threads (id, kind, bot_id, created_at) VALUES (?, 'dm', ?, ?)`)
    .run(id, botId, Date.now())
  return id
}

export function insertMessage(
  db: Db,
  m: { threadId: string; sender: string; kind: MessageKind; content?: string; payload?: unknown; createdAt?: number },
): MessageRow {
  const createdAt = m.createdAt ?? Date.now()
  const payloadJson = m.payload === undefined ? null : JSON.stringify(m.payload)
  const info = db.prepare(
    `INSERT INTO messages (thread_id, sender, kind, content, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(m.threadId, m.sender, m.kind, m.content ?? '', payloadJson, createdAt)
  const row: MessageRow = {
    id: Number(info.lastInsertRowid),
    thread_id: m.threadId,
    sender: m.sender,
    kind: m.kind,
    content: m.content ?? '',
    payload: m.payload ?? null,
    created_at: createdAt,
  }
  syncMessageFts(db, row)
  return row
}

function parseRow(r: Record<string, unknown>): MessageRow {
  return { ...r, payload: r.payload ? JSON.parse(r.payload as string) : null } as MessageRow
}

export function listMessages(db: Db, threadId: string, limit = 200): MessageRow[] {
  const rows = db.prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?`)
    .all(threadId, limit) as Record<string, unknown>[]
  return rows.reverse().map(parseRow)
}

/** 读取某个检查点之后（id > afterId）的消息，按时间正序返回；最多取最近 limit 条兜底。 */
export function listMessagesAfter(db: Db, threadId: string, afterId: number, limit = 120): MessageRow[] {
  const rows = db.prepare(`SELECT * FROM messages WHERE thread_id = ? AND id > ? ORDER BY id DESC LIMIT ?`)
    .all(threadId, afterId, limit) as Record<string, unknown>[]
  return rows.reverse().map(parseRow)
}

export function latestCheckpoint(db: Db, threadId: string, botId: string): ThreadCheckpointRow | null {
  const row = db.prepare(
    `SELECT * FROM thread_checkpoints WHERE thread_id = ? AND bot_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(threadId, botId) as ThreadCheckpointRow | undefined
  return row ?? null
}

export function insertCheckpoint(
  db: Db,
  input: {
    threadId: string
    botId: string
    throughMessageId: number
    summary: string
    sourceCount: number
    hadWebhook: boolean
    createdAt?: number
  },
): ThreadCheckpointRow {
  const createdAt = input.createdAt ?? Date.now()
  const hadWebhook = input.hadWebhook ? 1 : 0
  const info = db.prepare(
    `INSERT INTO thread_checkpoints (thread_id, bot_id, through_message_id, summary, source_count, had_webhook, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(input.threadId, input.botId, input.throughMessageId, input.summary, input.sourceCount, hadWebhook, createdAt)
  return {
    id: Number(info.lastInsertRowid),
    thread_id: input.threadId,
    bot_id: input.botId,
    through_message_id: input.throughMessageId,
    summary: input.summary,
    source_count: input.sourceCount,
    had_webhook: hadWebhook,
    created_at: createdAt,
  }
}

/** 一次取出给出一组线程各自的最后一条消息，避免侧栏刷新对每个同事和每个群单独查一遍 */
function lastMessagesByThread(db: Db, threadIds: string[]): Map<string, MessageRow> {
  const out = new Map<string, MessageRow>()
  if (!threadIds.length) return out
  const placeholders = threadIds.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT m.* FROM messages m
     JOIN (SELECT thread_id, MAX(id) AS max_id FROM messages WHERE thread_id IN (${placeholders}) GROUP BY thread_id) latest
       ON m.id = latest.max_id`,
  ).all(...threadIds) as Record<string, unknown>[]
  for (const r of rows) {
    const parsed = parseRow(r)
    out.set(parsed.thread_id, parsed)
  }
  return out
}

export function listBotsWithLastMessage(db: Db): SidebarBot[] {
  const bots = db.prepare(`SELECT * FROM bots ORDER BY name`).all() as BotRow[]
  const latest = lastMessagesByThread(db, bots.map((b) => `dm:${b.id}`))
  return bots.map((b) => {
    const threadId = `dm:${b.id}`
    return { ...b, thread_id: threadId, last_message: latest.get(threadId) ?? null }
  })
}

export function getMessage(db: Db, id: number): MessageRow | null {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? parseRow(row) : null
}

export type UsageTotals = { prompt: number; completion: number; cached: number; total: number }

export function recordUsage(
  db: Db,
  input: { botId: string; threadId: string; usage: { prompt: number; completion: number; cached: number }; at: number },
): void {
  db.prepare(
    `INSERT INTO usage (bot_id, thread_id, prompt_tokens, completion_tokens, cached_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.botId, input.threadId, input.usage.prompt, input.usage.completion, input.usage.cached, input.at)
}

export function usageSince(db: Db, botId: string, since: number): UsageTotals {
  const row = db.prepare(
    `SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt, COALESCE(SUM(completion_tokens), 0) AS completion,
            COALESCE(SUM(cached_tokens), 0) AS cached
     FROM usage WHERE bot_id = ? AND created_at >= ?`,
  ).get(botId, since) as { prompt: number; completion: number; cached: number }
  return { ...row, total: row.prompt + row.completion }
}

export function updateMessagePayload(db: Db, messageId: number, payload: unknown): void {
  db.prepare('UPDATE messages SET payload = ? WHERE id = ?').run(JSON.stringify(payload), messageId)
  const updated = getMessage(db, messageId)
  if (updated) syncMessageFts(db, updated)
}

export type Conversation = {
  id: string
  kind: 'dm' | 'group'
  title: string
  emoji: string
  subtitle: string
  members: string[]
  last_message: MessageRow | null
  /** 这个线程里还等着人的事：没拍板的审批 + 没回答的问题 */
  pending: number
}

export function ensureGroupThread(db: Db, id: string, title: string, memberIds: string[]): string {
  const now = Date.now()
  db.prepare(`INSERT INTO threads (id, kind, bot_id, title, created_at) VALUES (?, 'group', NULL, ?, ?)
              ON CONFLICT(id) DO UPDATE SET title = excluded.title`).run(id, title, now)
  const add = db.prepare('INSERT OR IGNORE INTO thread_members (thread_id, bot_id, joined_at) VALUES (?, ?, ?)')
  memberIds.forEach((botId, i) => add.run(id, botId, now + i))
  return id
}

export function threadMembers(db: Db, threadId: string): string[] {
  return (db.prepare('SELECT bot_id FROM thread_members WHERE thread_id = ? ORDER BY joined_at, bot_id')
    .all(threadId) as { bot_id: string }[]).map((r) => r.bot_id)
}

function lastMessageOf(db: Db, threadId: string): MessageRow | null {
  const row = db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT 1')
    .get(threadId) as Record<string, unknown> | undefined
  return row ? parseRow(row) : null
}

/** 每个线程里等着人的东西：没拍板的审批 + 没回答的问题卡片 */
function pendingByThread(db: Db): Map<string, number> {
  const rows = db.prepare(
    `SELECT thread_id, COUNT(*) AS n FROM (
       SELECT thread_id FROM approvals WHERE status = 'pending'
       UNION ALL
       SELECT thread_id FROM messages WHERE kind = 'question' AND json_extract(payload, '$.status') = 'open'
     ) GROUP BY thread_id`,
  ).all() as { thread_id: string; n: number }[]
  return new Map(rows.map((r) => [r.thread_id, r.n]))
}

/** 一共有多少件等着操作者：侧栏琥珀色徽章、桌面版 Dock 角标都是这个数 */
export function pendingCount(db: Db): number {
  let n = 0
  for (const v of pendingByThread(db).values()) n += v
  return n
}

/** 某位同事手上有没有等着操作者的事：待批的审批、没回答的问题，或者发了登录接管后操作者还没开口 */
export function waitsOnOperator(db: Db, botId: string): boolean {
  const held = db.prepare(`SELECT 1 FROM approvals WHERE bot_id = ? AND status = 'pending' LIMIT 1`).get(botId)
  if (held) return true
  const asked = db.prepare(
    `SELECT 1 FROM messages WHERE kind = 'question' AND sender = ? AND json_extract(payload, '$.status') = 'open' LIMIT 1`,
  ).get(botId)
  if (asked) return true
  const login = db.prepare(
    `SELECT 1 FROM messages lr WHERE lr.kind = 'login_request' AND lr.sender = ?
       AND NOT EXISTS (SELECT 1 FROM messages u WHERE u.thread_id = lr.thread_id AND u.sender = 'user' AND u.id > lr.id)
     LIMIT 1`,
  ).get(botId)
  return Boolean(login)
}

export function listConversations(db: Db): Conversation[] {
  const bots = db.prepare('SELECT * FROM bots ORDER BY name').all() as BotRow[]
  const byId = new Map(bots.map((b) => [b.id, b]))
  const pending = pendingByThread(db)
  const groupRows = db.prepare(`SELECT id, title FROM threads WHERE kind = 'group' ORDER BY title`)
    .all() as { id: string; title: string }[]
  const allThreadIds = [...bots.map((b) => `dm:${b.id}`), ...groupRows.map((g) => g.id)]
  const latest = lastMessagesByThread(db, allThreadIds)
  const membersByGroup = new Map<string, string[]>()
  if (groupRows.length) {
    const placeholders = groupRows.map(() => '?').join(',')
    const memberRows = db.prepare(
      `SELECT thread_id, bot_id FROM thread_members WHERE thread_id IN (${placeholders}) ORDER BY joined_at, bot_id`,
    ).all(...groupRows.map((g) => g.id)) as { thread_id: string; bot_id: string }[]
    for (const r of memberRows) {
      const list = membersByGroup.get(r.thread_id) ?? []
      list.push(r.bot_id)
      membersByGroup.set(r.thread_id, list)
    }
  }
  const dms: Conversation[] = bots.map((b) => ({
    id: `dm:${b.id}`,
    kind: 'dm',
    title: b.name,
    emoji: b.emoji,
    subtitle: b.role,
    members: [b.id],
    last_message: latest.get(`dm:${b.id}`) ?? null,
    pending: pending.get(`dm:${b.id}`) ?? 0,
  }))
  const groups: Conversation[] = groupRows.map((t) => {
    const members = membersByGroup.get(t.id) ?? []
    return {
      id: t.id,
      kind: 'group',
      title: t.title,
      emoji: '👥',
      subtitle: members.map((id) => byId.get(id)?.name ?? id).join(', '),
      members,
      last_message: latest.get(t.id) ?? null,
      pending: pending.get(t.id) ?? 0,
    }
  })
  return [...dms, ...groups]
}
