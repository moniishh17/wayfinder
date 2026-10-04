const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const cache = new Map();
let lastGeocodeAt = 0;
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

async function proxy(url, key, res) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return send(res, 200, hit.body);
  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'WayfinderChennai/0.1 (open-source software-only accessibility project)',
        'Referer': `http://localhost:${port}/`,
        'Accept': 'application/json'
      }, signal: AbortSignal.timeout(20000)
    });
    if (!upstream.ok) return send(res, upstream.status, JSON.stringify({ error: `Map service returned ${upstream.status}` }));
    const body = await upstream.text();
    cache.set(key, { body, expires: Date.now() + 5 * 60 * 1000 });
    send(res, 200, body);
  } catch (error) {
    send(res, 502, JSON.stringify({ error: 'Map service unavailable', detail: error.message }));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === '/api/geocode') {
    const query = (url.searchParams.get('q') || '').trim();
    if (query.length < 3 || query.length > 120) return send(res, 400, JSON.stringify({ error: 'Enter a place name between 3 and 120 characters.' }));
    const wait = Math.max(0, 1100 - (Date.now() - lastGeocodeAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    lastGeocodeAt = Date.now();
    const bounded = new URL('https://nominatim.openstreetmap.org/search');
    bounded.search = new URLSearchParams({ q: `${query}, Chennai, Tamil Nadu, India`, format: 'jsonv2', limit: '1', viewbox: '79.85,13.45,80.55,12.45', bounded: '1' }).toString();
    return proxy(bounded, `geocode:${query.toLowerCase()}`, res);
  }
  if (url.pathname === '/api/pedestrian-route') {
    const values = ['fromLat', 'fromLon', 'toLat', 'toLon'].map(key => Number(url.searchParams.get(key)));
    if (values.some(value => !Number.isFinite(value)) || values[0] < 12.3 || values[0] > 13.6 || values[2] < 12.3 || values[2] > 13.6 || values[1] < 79.7 || values[1] > 80.8 || values[3] < 79.7 || values[3] > 80.8) {
      return send(res, 400, JSON.stringify({ error: 'Choose two locations in the Chennai region.' }));
    }
    const [fromLat, fromLon, toLat, toLon] = values;
    const upstream = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson&steps=true`;
    return proxy(upstream, `foot:${values.join(',')}`, res);
  }

  let requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.resolve(root, `.${requested}`);
  if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (error, data) => {
    if (error) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
});

server.listen(port, '127.0.0.1', () => console.log(`Wayfinder Chennai ready at http://localhost:${port}`));
