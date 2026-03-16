// StormTrack Service Worker
// Checks for new/scheduled alerts every 30s even when app is closed

var WORKER_URL = 'https://stormtrack-api.spuddyboy5.workers.dev';
var CACHE_NAME = 'stormtrack-v1';

// Install — cache the app shell
self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(self.clients.claim());
});

// Listen for messages from the main app
self.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'SCHEDULE_CHECK') {
    // Main app is telling SW about a scheduled alert
    var alerts = e.data.alerts || [];
    storeAlerts(alerts);
  }
  if (e.data && e.data.type === 'STORE_LOCATION') {
    // Store user's lat/lon for zone checks
    self.userLat = e.data.lat;
    self.userLon = e.data.lon;
  }
});

// Push notification from server (if using Web Push later)
self.addEventListener('push', function(e) {
  var data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification('⛈ StormTrack Alert', {
      body: data.msg || 'New weather alert in your area',
      icon: 'https://cdn-icons-png.flaticon.com/512/1163/1163624.png',
      badge: 'https://cdn-icons-png.flaticon.com/512/1163/1163624.png',
      tag: data.id ? 'alert-' + data.id : 'stormtrack',
      requireInteraction: data.danger || false,
      data: { url: self.location.origin }
    })
  );
});

// Notification click — open the app
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(function(clients) {
      if (clients.length) { clients[0].focus(); return; }
      self.clients.openWindow(e.notification.data.url || '/');
    })
  );
});

// Background sync — check gist for new alerts periodically
self.addEventListener('sync', function(e) {
  if (e.tag === 'check-alerts') {
    e.waitUntil(checkAlerts());
  }
});

// Periodic background sync (where supported)
self.addEventListener('periodicsync', function(e) {
  if (e.tag === 'check-alerts') {
    e.waitUntil(checkAlerts());
  }
});

function checkAlerts() {
  return fetch(WORKER_URL + '?t=' + Date.now(), { cache: 'no-store' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var alerts = data.alerts || [];
      var now    = new Date();

      // Load what we've already notified about
      return caches.open(CACHE_NAME).then(function(cache) {
        return cache.match('notified').then(function(res) {
          return res ? res.text() : '[]';
        }).then(function(storedText) {
          var notified = JSON.parse(storedText);
          var userLat  = self.userLat || null;
          var userLon  = self.userLon || null;
          var toNotify = [];

          alerts.forEach(function(a) {
            if (!a.active || a.expired) return;
            if (notified.indexOf(String(a.id)) >= 0) return;

            // Zone check
            var inZone = true;
            if (a.zoneLatLngs && a.zoneLatLngs.length > 2 && userLat && userLon) {
              inZone = pointInPolygon(userLat, userLon, a.zoneLatLngs) ||
                       nearZone(userLat, userLon, a.zoneLatLngs, 10);
            }
            if (!inZone) return;

            // Scheduled — fire if it's time
            if (a.scheduled && a.sendAt) {
              var sendTime = new Date(a.sendAt);
              if (sendTime > now) return; // not yet
            }

            toNotify.push(a);
            notified.push(String(a.id));
          });

          // Check for expired alerts — fire "all clear"
          // (optional future feature)

          // Fire notifications
          var notePromises = toNotify.map(function(a) {
            var icons = {warning:'⚠️',danger:'🚨',info:'ℹ️',tornado:'🌪️',
              flood:'🌊',heat:'🌡️',snow:'❄️',fog:'🌫️',freeze:'🧊'};
            return self.registration.showNotification('⛈ StormTrack: ' + a.title, {
              body: (icons[a.type]||'') + ' ' + a.msg,
              icon: 'https://cdn-icons-png.flaticon.com/512/1163/1163624.png',
              badge: 'https://cdn-icons-png.flaticon.com/512/1163/1163624.png',
              tag: 'stormtrack-' + a.id,
              requireInteraction: ['danger','tornado'].indexOf(a.type) >= 0,
              vibrate: [200, 100, 200],
              data: { url: self.location.origin }
            });
          });

          // Save updated notified list
          var blob = new Response(JSON.stringify(notified.slice(-200)));
          cache.put('notified', blob);

          return Promise.all(notePromises);
        });
      });
    })
    .catch(function(e) { console.log('SW check failed:', e); });
}

// Scheduled alert check — run every minute via setInterval in SW
// (SW can be killed, but this covers the common case)
setInterval(function() {
  checkAlerts();
}, 60000);

// Point-in-polygon for zone check in SW
function pointInPolygon(lat, lon, polygon) {
  var inside = false;
  for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    var xi = polygon[i][0], yi = polygon[i][1];
    var xj = polygon[j][0], yj = polygon[j][1];
    if (((yi > lon) !== (yj > lon)) &&
        (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function nearZone(lat, lon, polygon, miles) {
  var R = 3958.8;
  for (var i = 0; i < polygon.length; i++) {
    var dLat = (polygon[i][0] - lat) * Math.PI / 180;
    var dLon = (polygon[i][1] - lon) * Math.PI / 180;
    var a = Math.sin(dLat/2)*Math.sin(dLat/2) +
      Math.cos(lat*Math.PI/180)*Math.cos(polygon[i][0]*Math.PI/180)*
      Math.sin(dLon/2)*Math.sin(dLon/2);
    if (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) <= miles) return true;
  }
  return false;
}
