import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Yahoo's draft room has a hard minimum width and will not reflow, so sharing a
 * laptop screen side by side means starving one of them. Document
 * Picture-in-Picture sidesteps the argument entirely: the companion becomes a
 * small always-on-top window floating over the draft room, which keeps the
 * whole screen.
 *
 * Only the decision goes in it — the three candidates, the clock, the alerts.
 * Everything else stays in the main window, one click away.
 */

declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow(opts?: { width?: number; height?: number }): Promise<Window>
      window: Window | null
    }
  }
}

export const hudSupported = () =>
  typeof window !== 'undefined' && 'documentPictureInPicture' in window

/** The floating window starts blank, so the page's styles have to be carried in. */
function copyStyles(target: Window) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join('\n')
      const style = target.document.createElement('style')
      style.textContent = rules
      target.document.head.appendChild(style)
    } catch {
      // Cross-origin sheet (the web font); re-link it instead of reading it.
      const owner = sheet.ownerNode as HTMLLinkElement | null
      if (owner?.href) {
        const link = target.document.createElement('link')
        link.rel = 'stylesheet'
        link.href = owner.href
        target.document.head.appendChild(link)
      }
    }
  }
}

export function useHud() {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)

  const close = useCallback(() => {
    window.documentPictureInPicture?.window?.close()
    setContainer(null)
    setOpen(false)
  }, [])

  const toggle = useCallback(async () => {
    if (open) return close()
    if (!hudSupported()) return
    try {
      const pip = await window.documentPictureInPicture!.requestWindow({
        width: 460,
        height: 380,
      })
      copyStyles(pip)
      pip.document.body.classList.add('hudbody')
      // Carry the reader's own size and theme choices across.
      pip.document.documentElement.setAttribute(
        'data-theme',
        document.documentElement.getAttribute('data-theme') ?? 'dark',
      )
      pip.document.documentElement.style.setProperty(
        '--ui-scale',
        document.documentElement.style.getPropertyValue('--ui-scale') || '1',
      )
      const root = pip.document.createElement('div')
      root.className = 'hudroot'
      pip.document.body.appendChild(root)
      pip.addEventListener('pagehide', () => {
        setContainer(null)
        setOpen(false)
      })
      setContainer(root)
      setOpen(true)
    } catch {
      // Denied or unsupported; the main window is unaffected.
      setOpen(false)
    }
  }, [open, close])

  return { open, toggle, close, container }
}

export function Hud({ container, children }: { container: HTMLElement | null; children: ReactNode }) {
  useEffect(() => () => undefined, [])
  if (!container) return null
  return createPortal(children, container)
}
