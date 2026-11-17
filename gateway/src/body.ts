/**
 * 最多读 limit 字节；多一个字节就停下并返回 null，不把超大的请求体整个搬进内存。
 * 流半途断掉时原样抛错（不吞成空 Buffer，免得断掉的 webhook 请求用空内容误触发例行任务）。
 */
export async function readBodyUpTo(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Buffer | null> {
  if (!body) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}
