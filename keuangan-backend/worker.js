// ============================================================
//  KEUANGAN KELUARGA — Cloudflare Workers Backend
//  Database: Supabase PostgreSQL
//  Storage: Cloudinary
//  Deploy: Cloudflare Workers (gratis, tidak tidur)
// ============================================================

// Environment variables (set di Cloudflare Dashboard):
// SUPABASE_URL      = https://xxxx.supabase.co
// SUPABASE_KEY      = your-supabase-anon-key
// CLOUDINARY_CLOUD  = your-cloud-name
// CLOUDINARY_KEY    = your-api-key
// CLOUDINARY_SECRET = your-api-secret
// JWT_SECRET        = random-string-panjang
// PIN_HASH          = SHA-256 hash of your PIN

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

// ── Main Handler ───────────────────────────────────────────
export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ── Routes ──────────────────────────────────────────
      if (path === '/auth/login' && request.method === 'POST') {
        return await handleLogin(request, env);
      }
      if (path === '/auth/verify' && request.method === 'POST') {
        return await handleVerify(request, env);
      }

      // Protected routes — require JWT
      const authResult = await verifyJWT(request, env);
      if (!authResult.ok) {
        return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      if (path === '/transactions' && request.method === 'GET') {
        return await getTransactions(request, env, url);
      }
      if (path === '/transactions' && request.method === 'POST') {
        return await addTransaction(request, env, authResult.user);
      }
      if (path.startsWith('/transactions/') && request.method === 'DELETE') {
        const id = path.split('/')[2];
        return await deleteTransaction(id, env);
      }
      if (path === '/upload' && request.method === 'POST') {
        return await uploadPhoto(request, env);
      }
      if (path === '/stats' && request.method === 'GET') {
        return await getStats(env, url);
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('Worker error:', err);
      return jsonResponse({ error: err.message }, 500);
    }
  }
};

// ── Auth ───────────────────────────────────────────────────
async function handleLogin(request, env) {
  const { pin, name } = await request.json();
  if (!pin || !name) return jsonResponse({ error: 'PIN dan nama wajib diisi' }, 400);

  // Verify PIN with SHA-256
  const pinHash = await sha256(env.JWT_SECRET + pin);
  if (pinHash !== env.PIN_HASH) {
    return jsonResponse({ error: 'PIN salah' }, 401);
  }

  // Generate JWT token (valid 24 jam)
  const token = await generateJWT({ name, loginAt: Date.now() }, env.JWT_SECRET);
  return jsonResponse({ success: true, token, name });
}

async function handleVerify(request, env) {
  const result = await verifyJWT(request, env);
  if (!result.ok) return jsonResponse({ error: 'Token tidak valid' }, 401);
  return jsonResponse({ valid: true, user: result.user });
}

async function verifyJWT(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return { ok: false };
  const token = auth.slice(7);
  try {
    const payload = await verifyJWTToken(token, env.JWT_SECRET);
    return { ok: true, user: payload };
  } catch {
    return { ok: false };
  }
}

// ── Transactions ───────────────────────────────────────────
async function getTransactions(request, env, url) {
  const user = url.searchParams.get('user'); // filter by user (optional)

  let query = `${env.SUPABASE_URL}/rest/v1/transactions?select=*&order=date.desc`;
  if (user && user !== 'semua') {
    query += `&user=eq.${encodeURIComponent(user)}`;
  }

  const res = await supabaseFetch(query, 'GET', null, env);
  const data = await res.json();
  return jsonResponse({ transactions: data });
}

async function addTransaction(request, env, user) {
  const body = await request.json();
  const txn = {
    id:       body.id || Date.now().toString(),
    name:     body.name,
    amount:   parseFloat(body.amount),
    type:     body.type,
    category: body.category || '',
    user:     body.user || user.name,
    date:     body.date || new Date().toISOString(),
    memo:     body.memo || '',
    photo:    body.photo || ''
  };

  const res = await supabaseFetch(
    `${env.SUPABASE_URL}/rest/v1/transactions`,
    'POST',
    txn,
    env
  );

  if (res.status === 201 || res.status === 200) {
    return jsonResponse({ success: true, id: txn.id }, 201);
  }
  const err = await res.json();
  return jsonResponse({ error: err.message || 'Gagal menyimpan' }, 400);
}

async function deleteTransaction(id, env) {
  const res = await supabaseFetch(
    `${env.SUPABASE_URL}/rest/v1/transactions?id=eq.${id}`,
    'DELETE',
    null,
    env
  );
  if (res.status === 204 || res.status === 200) {
    return jsonResponse({ success: true });
  }
  return jsonResponse({ error: 'Gagal menghapus' }, 400);
}

// ── Upload Photo to Cloudinary ─────────────────────────────
async function uploadPhoto(request, env) {
  const { imageBase64, filename } = await request.json();
  if (!imageBase64) return jsonResponse({ error: 'No image data' }, 400);

  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'keuangan-keluarga';
  const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
  const signature = await sha256(paramsToSign + env.CLOUDINARY_SECRET);

  const formData = new FormData();
  formData.append('file', `data:image/jpeg;base64,${imageBase64}`);
  formData.append('api_key', env.CLOUDINARY_KEY);
  formData.append('timestamp', timestamp.toString());
  formData.append('folder', folder);
  formData.append('signature', signature);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/image/upload`,
    { method: 'POST', body: formData }
  );
  const data = await res.json();

  if (data.secure_url) {
    return jsonResponse({ success: true, url: data.secure_url });
  }
  return jsonResponse({ error: 'Upload gagal', detail: data.error }, 400);
}

// ── Stats ──────────────────────────────────────────────────
async function getStats(env, url) {
  const month = url.searchParams.get('month'); // format: 2026-05
  let query = `${env.SUPABASE_URL}/rest/v1/transactions?select=type,amount,user,date`;
  if (month) {
    query += `&date=gte.${month}-01&date=lt.${month}-32`;
  }

  const res = await supabaseFetch(query, 'GET', null, env);
  const txns = await res.json();

  const income  = txns.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expense = txns.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const saving  = txns.filter(t => t.type === 'saving').reduce((s, t) => s + t.amount, 0);

  return jsonResponse({
    income, expense, saving,
    remaining: income - expense - saving,
    total_transactions: txns.length
  });
}

// ── Supabase Helper ────────────────────────────────────────
async function supabaseFetch(url, method, body, env) {
  return fetch(url, {
    method,
    headers: {
      'apikey': env.SUPABASE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=minimal' : ''
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

// ── JWT Helpers ────────────────────────────────────────────
async function generateJWT(payload, secret) {
  const header  = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const exp     = Math.floor(Date.now() / 1000) + (24 * 60 * 60); // 24 jam
  const data    = btoa(JSON.stringify({ ...payload, exp }));
  const sig     = await hmacSign(`${header}.${data}`, secret);
  return `${header}.${data}.${sig}`;
}

async function verifyJWTToken(token, secret) {
  const [header, payload, sig] = token.split('.');
  const expected = await hmacSign(`${header}.${payload}`, secret);
  if (sig !== expected) throw new Error('Invalid signature');
  const data = JSON.parse(atob(payload));
  if (data.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return data;
}

async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Response Helper ────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS
  });
}
