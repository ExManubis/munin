// munin's push notifications, in a service worker per service (push/tracker/sw.js and
// push/runtime/sw.js load this): each service pushes with keys of its own, and a device is
// subscribed to both. A push shows as a notification; tapping it opens munin at what it's
// about. Neither worker controls munin's pages, so an open munin window is asked to go there.

const home = new URL('../../', self.location).href; // munin's own address

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() || '' };
  }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const looking = windows.some((w) => w.focused && w.visibilityState === 'visible');
    await self.registration.showNotification(data.title || 'munin', {
      body: data.body || '',
      tag: data.tag,
      icon: new URL('android-chrome-192.png', home).href,
      badge: new URL('android-chrome-192.png', home).href,
      silent: looking, // munin is in front of you already
      data: { url: data.url || '' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const hash = event.notification.data?.url || '';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((w) => w.url.startsWith(home));
    if (open) {
      open.postMessage({ munin: 'open', hash });
      return open.focus();
    }
    return self.clients.openWindow(`${home}${hash}`);
  })());
});
