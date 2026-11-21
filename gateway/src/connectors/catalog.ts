import { APP_KEYS, type AppKey, type CatalogApp } from './types.js'

export const CATALOG: readonly CatalogApp[] = [
  { app: 'gmail', name: 'Gmail', group: 'mail_calendar', domain: 'mail', toolkitSlug: 'gmail', authScheme: 'OAUTH2' },
  { app: 'outlook', name: 'Outlook', group: 'mail_calendar', domain: 'mail', toolkitSlug: 'outlook', authScheme: 'OAUTH2' },
  { app: 'google_calendar', name: 'Google Calendar', group: 'mail_calendar', domain: 'calendar', toolkitSlug: 'googlecalendar', authScheme: 'OAUTH2' },
  { app: 'outlook_calendar', name: 'Outlook Calendar', group: 'mail_calendar', domain: 'calendar', toolkitSlug: 'outlook', authScheme: 'OAUTH2' },
  { app: 'polery', name: 'Polery Docs', group: 'productivity', domain: 'polery', toolkitSlug: 'polery', authScheme: 'OAUTH2', native: true },
  { app: 'notion', name: 'Notion', group: 'productivity', domain: 'notion', toolkitSlug: 'notion', authScheme: 'OAUTH2' },
  { app: 'slack', name: 'Slack', group: 'messaging', domain: 'slack', toolkitSlug: 'slack', authScheme: 'OAUTH2' },
]

export function isAppKey(value: unknown): value is AppKey {
  return typeof value === 'string' && (APP_KEYS as readonly string[]).includes(value)
}

export function catalogByApp(app: string): CatalogApp | undefined {
  return CATALOG.find((c) => c.app === app)
}
