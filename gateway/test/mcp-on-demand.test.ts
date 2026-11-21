import { describe, expect, it } from 'vitest'
import { runTurn } from '../src/agent.js'
import { ensureDmThread, openDb, upsertBot } from '../src/db.js'
import type { AssistantTurn, ChatMsg, LLM, ToolDef } from '../src/llm.js'
import { buildMcpToolSet } from '../src/mcp/tools.js'
import type { McpDiscoveredTool, McpServerRow } from '../src/mcp/types.js'
import { buildSystemPrompt } from '../src/prompts.js'

const bot = { id: 'engineer', name: 'Builder', role: 'engineering', emoji: '🛠️', soul_path: '' }
const events = { onMessage: () => {}, onStatus: () => {} }

function makeServer(slug: string, tools: McpDiscoveredTool[]): McpServerRow {
  return {
    id: `srv-${slug}`,
    name: slug[0]!.toUpperCase() + slug.slice(1),
    slug,
    transport: 'http',
    enabled: true,
    command: '',
    args: [],
    cwd: '',
    url: `https://${slug}.example/mcp`,
    envKeys: [],
    headerKeys: [],
    trustReadOnlyHint: true,
    tools,
    toolPolicies: {},
    status: 'connected',
    lastError: '',
    createdAt: 1,
    updatedAt: 1,
  }
}

function sampleTools(count: number, schemaPad = 0): McpDiscoveredTool[] {
  return Array.from({ length: count }, (_, i) => ({
    name: i % 2 === 0 ? `read_item_${i}` : `write_item_${i}`,
    description: `Tool ${i} description.\nSecond line omitted in compact catalog.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: schemaPad > 0 ? 'x'.repeat(schemaPad) : 'item id' },
      },
    },
    readOnlyHint: i % 2 === 0,
    destructiveHint: i % 2 !== 0,
  }))
}

describe('MCP on-demand tool loading', () => {
  it('keeps small MCP servers eager and switches large (>8 tools or >12k schema chars) servers to on-demand', () => {
    const small = makeServer('linear', sampleTools(3))
    const smallSet = buildMcpToolSet([small])
    expect(smallSet.loaders.size).toBe(0)
    expect(smallSet.deferredTools.size).toBe(0)
    expect(smallSet.tools).toHaveLength(3)

    const many = makeServer('notion', sampleTools(12))
    const manySet = buildMcpToolSet([many])
    expect(manySet.tools.map((t) => t.function.name)).toEqual(['mcp__notion__load_tools'])
    expect(manySet.loaders.has('mcp__notion__load_tools')).toBe(true)
    expect(manySet.deferredTools.size).toBe(12)
    expect(manySet.lookup.size).toBe(12)
    expect(manySet.promptCatalogs.get(many.id)?.tools).toHaveLength(12)

    // Even 2 tools with massive schemas (> 12,000 chars) auto-trigger on-demand
    const heavy = makeServer('heavy', sampleTools(2, 7_000))
    const heavySet = buildMcpToolSet([heavy])
    expect(heavySet.tools.map((t) => t.function.name)).toEqual(['mcp__heavy__load_tools'])
    expect(heavySet.deferredTools.size).toBe(2)
  })

  it('renders a compact one-line catalog in system prompt for on-demand servers', () => {
    const notion = makeServer('notion', sampleTools(10))
    const built = buildMcpToolSet([notion])
    const prompt = buildSystemPrompt(bot, 'soul', {
      mcpServers: [{
        id: notion.id,
        name: notion.name,
        slug: notion.slug,
        enabled: true,
        status: 'connected',
        toolCount: notion.tools.length,
        onDemandCatalog: built.promptCatalogs.get(notion.id),
      }],
    })
    expect(prompt).toContain('mcp__notion__load_tools')
    expect(prompt).toContain('mcp__notion__read_item_0 [read] — Tool 0 description.')
    expect(prompt).not.toContain('Second line omitted')
  })

  it('activates requested schemas on the next step, guides unloaded direct calls, and respects watch mode', async () => {
    const db = openDb(':memory:')
    upsertBot(db, bot)
    const threadId = ensureDmThread(db, bot.id)

    const notion = makeServer('notion', sampleTools(10))
    const built = buildMcpToolSet([notion])
    const calledMcp: string[] = []
    const seenToolNames: string[][] = []
    const seenMessages: ChatMsg[][] = []

    let step = 0
    const llm: LLM = {
      async chat(messages, tools: ToolDef[]): Promise<AssistantTurn> {
        seenMessages.push(messages.map((m) => ({ ...m })))
        seenToolNames.push(tools.map((t) => t.function.name))
        step++
        if (step === 1) {
          // Calling an unloaded tool directly is blocked with loader instructions
          return {
            content: null,
            toolCalls: [{ id: 'c1', name: 'mcp__notion__read_item_0', args: { id: '42' } }],
            raw: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'mcp__notion__read_item_0', arguments: '{"id":"42"}' } }] },
          }
        }
        if (step === 2) {
          // Load by raw name
          return {
            content: null,
            toolCalls: [{ id: 'c2', name: 'mcp__notion__load_tools', args: { tools: ['read_item_0'] } }],
            raw: { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'mcp__notion__load_tools', arguments: '{"tools":["read_item_0"]}' } }] },
          }
        }
        if (step === 3) {
          // Now call the activated tool
          return {
            content: null,
            toolCalls: [{ id: 'c3', name: 'mcp__notion__read_item_0', args: { id: '42' } }],
            raw: { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'mcp__notion__read_item_0', arguments: '{"id":"42"}' } }] },
          }
        }
        return { content: 'Read page 42.', toolCalls: [], raw: { role: 'assistant', content: 'Read page 42.' } }
      },
    }

    const outcome = await runTurn({
      db,
      llm,
      bot,
      soul: '',
      threadId,
      mcpTools: built.tools,
      mcpReadToolNames: built.readToolNames,
      mcpLoaders: built.loaders,
      mcpDeferredTools: built.deferredTools,
      onMcpTool: async ({ name }) => {
        calledMcp.push(name)
        return { text: 'Page 42 body', ok: true, tainted: true }
      },
    }, 'check notion', events)

    expect(outcome).toBe('replied')
    expect(seenToolNames[0]).toContain('mcp__notion__load_tools')
    expect(seenToolNames[0]).not.toContain('mcp__notion__read_item_0')
    expect(seenMessages[1]!.find((m) => m.tool_call_id === 'c1')!.content).toContain('mcp__notion__load_tools')
    expect(seenToolNames[2]).toContain('mcp__notion__read_item_0')
    expect(calledMcp).toEqual(['mcp__notion__read_item_0'])

    // Watch mode excludes write tools even from on-demand catalogs
    const watchBuilt = buildMcpToolSet([notion], { watch: true, onDemand: 'always' })
    const catalog = watchBuilt.promptCatalogs.get(notion.id)!.tools
    expect(catalog.every((t) => t.mode === 'read')).toBe(true)
    expect(catalog.some((t) => t.rawName === 'write_item_1')).toBe(false)
  })
})
