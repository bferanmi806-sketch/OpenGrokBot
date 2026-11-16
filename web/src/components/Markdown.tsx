import { memo } from 'react'
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { useT } from '../i18n'

/**
 * 同事的话按 markdown 显示，但有三条规矩：
 * - 只允许完整的 http / https / mailto 链接，新开标签页，并且不把本页交给对方（noopener）；被挡掉的地址只留文字。
 * - 不加载图片：模型复述网页时可能夹带追踪像素。只显示一行占位和它的说明文字。
 * - 模型夹带的原始 HTML 直接丢掉。
 * 另外单个换行就是换行（remark-breaks）：Chief 的分派表一行一条，模型也常用单换行分行，不能被折成空格。
 */
const safeUrl: UrlTransform = (url) => {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:' ? url : ''
  } catch {
    return ''
  }
}

const link: Components['a'] = ({ node: _node, children, href, ...props }) =>
  href ? <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>

/** 图片占位按界面语言写 */
function ImagePlaceholder({ alt }: { alt?: string | undefined }) {
  const t = useT()
  return <span className="md-image">{alt ? t('markdown.imageAlt', { alt }) : t('markdown.image')}</span>
}

const REMARK_PLUGINS = [remarkGfm, remarkBreaks]

const components: Components = {
  a: link,
  img: ({ node: _node, alt }) => <ImagePlaceholder alt={alt} />,
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      urlTransform={safeUrl}
      components={components}
      skipHtml
    >
      {text}
    </ReactMarkdown>
  )
})
