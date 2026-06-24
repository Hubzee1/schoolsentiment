// Service Worker for School Sentiment
const CACHE_NAME = 'schoolsentiment-v1';
const urlsToCache = [
  '/',
  '/review',
  '/noticeboard',
  '/blog',
  '/signin',
  '/dashboard',
  '/terms',
  '/privacy',
  '/contact',
  '/logo/SchoolSentiment_white_transparency.png',
  '/images/Elated.png',
  '/images/happy.png',
  '/images/Average.png',
  '/images/Sad.png',
  '/images/Angry.png',
  '/images/No_face.png'
];

// Install event - cache assets
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});

// Activate event - clean old caches
self.addEventListener('activate', function(event) {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.map(function(cacheName) {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', function(event) {
  event.respondWith(
    caches.match(event.request)
      .then(function(response) {
        // Cache hit - return response
        if (response) {
          return response;
        }
        return fetch(event.request);
      })
  );
});
