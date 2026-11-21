/** 单步内只读工具的最大并发数（借鉴 DeepSeek Harness 有界滚动并发池 + 独占屏障） */
export const MAX_PARALLEL_READ_TOOLS = 6

export type ToolBatch<T> = {
  parallel: boolean
  items: T[]
}

/**
 * 将单步内的多个工具调用划分为连续批次：
 * - 连续 2 个以上的只读安全工具归入并行批次；
 * - 任意非只读安全工具（浏览器、shell、write_file、审批、写连接器/MCP 等）独立形成独占串行屏障；
 * - 整体严格保持模型原始输出顺序。
 */
export function partitionToolBatches<T>(
  calls: readonly T[],
  isParallelSafe: (call: T) => boolean,
): ToolBatch<T>[] {
  const batches: ToolBatch<T>[] = []
  let i = 0
  while (i < calls.length) {
    if (!isParallelSafe(calls[i]!)) {
      batches.push({ parallel: false, items: [calls[i]!] })
      i++
      continue
    }
    const group: T[] = []
    while (i < calls.length && isParallelSafe(calls[i]!)) {
      group.push(calls[i]!)
      i++
    }
    batches.push({ parallel: group.length > 1, items: group })
  }
  return batches
}

/**
 * 有界并发执行器：最多同时跑 limit 个任务，结果严格按输入下标顺序返回；
 * 若 signal 中止则不再派发尚未开始的任务。
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length)
  if (items.length === 0) return results
  const workers = Math.max(1, Math.min(Math.floor(limit), items.length))
  let next = 0

  const worker = async () => {
    while (true) {
      if (signal?.aborted) return
      const idx = next++
      if (idx >= items.length) return
      results[idx] = await fn(items[idx]!, idx)
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}
