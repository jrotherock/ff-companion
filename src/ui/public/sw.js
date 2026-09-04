/*
 * The service worker exists for one reason: iOS will not deliver a web push to
 * a page, only to an installed app. Adding the cockpit to the Home Screen makes
 * this the thing that wakes up.
 */
self.addEventListener('push', (event) => {
  let d = {}
  try { d = event.data ? event.data.json() : {} } catch { d = {} }
  event.waitUntil(
    self.registration.showNotification(d.title || 'Fantasy companion', {
      body: d.body || '',
      // The alert id, so a fact restated replaces its own notification rather
      // than stacking a second copy of itself.
      tag: d.tag || 'ff',
      data: { url: d.url || '/cockpit' },
      icon: '/icon.svg',
      badge: '/icon.svg',
      requireInteraction: false,
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/cockpit'
  // Focus the app if it is already open rather than opening a second copy.
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.includes('/cockpit') && 'focus' in w) return w.focus()
      }
      return clients.openWindow(url)
    }),
  )
})
