import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import { errorText } from '../i18n/describe'

/**
 * 本机电脑的屏幕：网关把浏览器的截屏流一帧一条 JSON 推过来，这里直接换 <img> 的 src（不让 10fps 的图走 React 重渲染）。
 * 只看不操作——要接管（登录）时浏览器会以真窗口开到桌面上，那里才是输入的地方。
 * 断线就按退避重连（浏览器重开时网关会主动断一次）；网关说「没有屏幕」就停下，别一遍遍把它的电脑拉起来；
 * 标签页藏到后面时也断开，省得后台还在收 10 帧/秒的图。
 */
export function CdpScreen({ url, title }: { url: string; title: string }) {
  const t = useT()
  const imgRef = useRef<HTMLImageElement>(null)
  const latestSrcRef = useRef<string | null>(null)
  const [hasFrame, setHasFrame] = useState(false)
  // 状态存成键：换语言时跟着换，不留一句旧语言的「正在连接」
  const [status, setStatus] = useState<'screen.connecting' | 'screen.reconnecting' | 'screen.none' | { error: string; code?: string } | null>('screen.connecting')

  useEffect(() => {
    let closed = false
    let fatal = false
    let retry = 0
    let ws: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const open = () => {
      if (closed || fatal || document.hidden) return
      const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${url}`)
      ws = sock
      sock.onopen = () => { retry = 0 }
      sock.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data)) as { type: string; data?: string; error?: string; code?: string }
          if (m.type === 'frame' && m.data) {
            const src = `data:image/jpeg;base64,${m.data}`
            latestSrcRef.current = src
            if (imgRef.current) imgRef.current.src = src
            setHasFrame((prev) => prev || true)
            setStatus((prev) => (prev === null ? prev : null))
          } else if (m.type === 'error') {
            fatal = true
            setStatus(m.error ? { error: m.error, ...(m.code ? { code: m.code } : {}) } : 'screen.none')
          }
        } catch { /* 忽略脏帧 */ }
      }
      sock.onclose = () => {
        if (ws === sock) ws = null
        if (closed || fatal || document.hidden) return
        setStatus('screen.reconnecting')
        timer = setTimeout(open, Math.min(1000 * 2 ** retry++, 15000))
      }
    }
    const onVisibility = () => {
      if (document.hidden) {
        clearTimeout(timer)
        if (ws) {
          const current = ws
          ws = null
          current.onclose = null
          current.close()
        }
      } else if (!ws && !fatal) {
        clearTimeout(timer)
        retry = 0
        open()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    open()
    return () => {
      closed = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      if (ws) {
        ws.onclose = null
        ws.close()
        ws = null
      }
    }
  }, [url])

  return (
    <>
      <div className="panel-screen panel-screen-cdp">
        {hasFrame ? <img ref={imgRef} src={latestSrcRef.current ?? undefined} alt={title} /> : null}
      </div>
      {status ? <div className="panel-screen-status" role="status">{typeof status === 'string' ? t(status) : errorText(t, { message: status.error, code: status.code })}</div> : null}
    </>
  )
}
