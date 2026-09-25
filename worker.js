const GIPHY_DAILY_LIMIT = 80;
let memoryQuota = { day: '', count: 0 };

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Filename',
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function consumeGiphyQuota(env) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `giphy:global:${day}`;
  if (env.RATE_LIMIT_KV) {
    const current = Number(await env.RATE_LIMIT_KV.get(key) || 0);
    if (current >= GIPHY_DAILY_LIMIT) return false;
    await env.RATE_LIMIT_KV.put(key, String(current + 1), { expirationTtl: 172800 });
    return true;
  }
  if (memoryQuota.day !== day) memoryQuota = { day, count: 0 };
  if (memoryQuota.count >= GIPHY_DAILY_LIMIT) return false;
  memoryQuota.count += 1;
  return true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders();

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // Proxy GIPHY search so the API key stays in Worker secrets.
    if (request.method === 'GET' && url.pathname === '/giphy-search') {
      const query = (url.searchParams.get('q') || '').trim().slice(0, 80);
      if (!query) return jsonResponse({ data: [] });
      if (!env.GIPHY_API_KEY) return jsonResponse({ error: 'GIPHY is not configured' }, 503);
      if (!(await consumeGiphyQuota(env))) {
        return jsonResponse({ error: 'Daily GIF search limit reached' }, 429);
      }
      const params = new URLSearchParams({
        api_key: env.GIPHY_API_KEY,
        q: query,
        limit: '24',
        rating: 'pg-13',
        lang: 'en',
      });
      const response = await fetch('https://api.giphy.com/v1/gifs/search?' + params);
      const body = await response.text();
      return new Response(body, {
        status: response.status,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }

    // Upload a file: POST /upload (raw file body, X-Filename header)
    if (request.method === 'POST' && url.pathname === '/upload') {
      const filename = request.headers.get('X-Filename') || 'file';
      const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
      const ext = filename.includes('.') ? '.' + filename.split('.').pop() : '';
      const key = crypto.randomUUID() + ext;

      await env.BUCKET.put(key, request.body, {
        httpMetadata: { contentType },
      });

      const fileUrl = `${url.origin}/file/${key}`;
      return jsonResponse({ url: fileUrl, name: filename, type: contentType });
    }

    // Serve a file back: GET /file/{key} (supports Range for video seeking)
    if (request.method === 'GET' && url.pathname.startsWith('/file/')) {
      const key = url.pathname.replace('/file/', '');
      const headers = new Headers(cors);
      const range = request.headers.get('Range');
      let options = {};
      let status = 200;

      if (range) {
        const match = range.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const head = await env.BUCKET.head(key);
          if (!head) return new Response('Not found', { status: 404, headers });
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : head.size - 1;
          options.range = { offset: start, length: end - start + 1 };
          status = 206;
          headers.set('Content-Range', `bytes ${start}-${end}/${head.size}`);
        }
      }

      const object = await env.BUCKET.get(key, options);
      if (!object) return new Response('Not found', { status: 404, headers });
      headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
      headers.set('Accept-Ranges', 'bytes');
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return new Response(object.body, { status, headers });
    }

    return new Response('Not found', { status: 404, headers: cors });
  },
};
