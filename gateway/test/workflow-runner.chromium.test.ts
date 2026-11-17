import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import type { PageLike } from '../src/browser-page.js'
import { findBrowser } from '../src/browsers.js'
import { parseWorkflowBindings, runWorkflow } from '../src/workflow-runner.js'
import { parseWorkflowTrace } from '../src/workflows.js'

describe('workflow runner in Chromium', () => {
  it('replays a form through the existing page and checks the resulting URL', async (context) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'osb-workflow-runner-chromium-'))
    const server = createServer((_request, response) => {
      const url = new URL(_request.url ?? '/', 'http://127.0.0.1')
      response.setHeader('content-type', 'text/html; charset=utf-8')
      if (url.pathname === '/form') {
        response.end(`<!doctype html><html><body>
          <label for="email">Email</label><input id="email" type="email">
          <label for="subscribe">Subscribe</label><input id="subscribe" type="checkbox">
          <label for="country">Country</label><select id="country"><option value="us">United States</option><option value="gb">United Kingdom</option></select>
          <button id="save" type="button">Save</button><output id="status"></output>
        </body></html>`)
      } else {
        response.end('<!doctype html><html><body>Done</body></html>')
      }
    })
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      const found = findBrowser({ dataDir, env: process.env })
      const executablePath = found?.executablePath ?? chromium.executablePath()
      if (!existsSync(executablePath)) return context.skip()
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('local test server has no TCP address')
      const baseUrl = `http://127.0.0.1:${address.port}`
      browser = await chromium.launch({ executablePath, headless: true })
      const page = await browser.newPage()
      await page.addInitScript(() => {
        document.addEventListener('click', (event) => {
          if ((event.target as HTMLElement | null)?.id === 'save') {
            document.querySelector('#status')!.textContent = 'saved'
            history.pushState({}, '', '/saved')
          }
        })
      })

      const trace = parseWorkflowTrace({
        format: 'opensuperbot.workflow', version: 1, title: 'Submit the form', steps: [
          { type: 'navigate', url: `${baseUrl}/form` },
          {
            type: 'fill', target: { candidates: [{ label: 'Email' }] }, value: { kind: 'placeholder', key: 'email' },
            approval: { kind: 'email', target: 'person@example.test', action: 'Fill the reviewed email address' },
          },
          { type: 'check', target: { candidates: [{ label: 'Subscribe' }] } },
          { type: 'select', target: { candidates: [{ label: 'Country' }] }, value: { kind: 'placeholder', key: 'country' } },
          { type: 'click', target: { candidates: [{ role: { role: 'button', name: 'Save' } }] }, expect: { url: `${baseUrl}/saved` } },
        ],
      })
      const { bindings } = parseWorkflowBindings(trace, { email: 'person@example.test', country: 'gb' })
      const approvals: { step: number; kind: string; rulesAllowed: boolean }[] = []
      const result = await runWorkflow(trace, {
        getPage: async () => page as unknown as PageLike,
        bindings,
        rulesAllowed: false,
        authorize: async ({ step, kind, rulesAllowed }) => {
          approvals.push({ step, kind, rulesAllowed })
          return { status: 'approved' }
        },
      })

      expect(result).toEqual({ status: 'completed', stepsCompleted: 5 })
      expect(approvals.map(({ step }) => step)).toEqual([2, 3, 4, 5])
      expect(approvals.every(({ rulesAllowed }) => !rulesAllowed)).toBe(true)
      expect(await page.locator('#email').inputValue()).toBe('person@example.test')
      expect(await page.locator('#subscribe').isChecked()).toBe(true)
      expect(await page.locator('#country').inputValue()).toBe('gb')
      expect(await page.locator('#status').innerText()).toBe('saved')
      expect(page.url()).toBe(`${baseUrl}/saved`)
    } finally {
      await browser?.close()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
