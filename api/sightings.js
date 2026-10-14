// Vercel serverless function: /api/sightings
// Shared store for train sightings (taps, microphone and camera), kept in Supabase so every
// device uses the same sightings to correct the predictions.
//
// GET     -> { enabled, sightings: [...] }  the latest 500
// POST    -> body: one sighting or an array of up to 200; returns { ok, ids }
// DELETE  -> ?id=<uuid>
//
// Environment variables:
//   SUPABASE_URL          e.g. https://abcdefgh.supabase.co
//   SUPABASE_SERVICE_KEY  the service_role (secret) key. It never reaches the browser.
// The table is public.bft_sightings (row level security on, no public policies).

const ROWS = ['NS', 'NF', 'SF', 'SS'];
const VIAS = ['tap', 'mic', 'cam'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clean(x, now) {
  if (!x || typeof x !== 'object') return null;
  const t = Number(x.t);
  if (!Number.isFinite(t) || Math.abs(t - now) > 3 * 86400000) return null;
  if (ROWS.indexOf(x.row) < 0) return null;
  const via = VIAS.indexOf(x.via) >= 0 ? x.via : 'tap';
  const off = x.off == null ? null : Math.round(Number(x.off));
  if (off !== null && (!Number.isFinite(off) || Math.abs(off) > 900)) return null;
  const str = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
  return { t: Math.round(t), row: x.row, via, svc: str(x.svc, 8), src: str(x.src, 8), label: str(x.label, 120), off };
}

function sameSite(req) {
  const o = req.headers.origin || req.headers.referer;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}

async function sb(path, opts) {
  const url = process.env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + path;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(url, Object.assign({}, opts, {
    headers: Object.assign({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, (opts && opts.headers) || {})
  }));
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  if (!r.ok) {
    const err = new Error('Supabase ' + r.status + ': ' + (body && body.message ? body.message : String(text).slice(0, 200)));
    err.status = r.status;
    throw err;
  }
  return body;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return null; } }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    res.status(200).json({ enabled: false, sightings: [], reason: 'SUPABASE_URL and SUPABASE_SERVICE_KEY are not set' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const rows = await sb('bft_sightings?select=id,t,row,via,svc,src,label,off&order=t.desc&limit=500');
      res.status(200).json({ enabled: true, sightings: rows || [] });
      return;
    }
    if (!sameSite(req)) { res.status(403).json({ error: 'wrong origin' }); return; }
    if (req.method === 'POST') {
      const body = await readBody(req), now = Date.now();
      const list = (Array.isArray(body) ? body : [body]).slice(0, 200).map((x) => clean(x, now)).filter(Boolean);
      if (!list.length) { res.status(400).json({ error: 'nothing valid to save' }); return; }
      const out = await sb('bft_sightings?select=id', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(list) });
      res.status(200).json({ ok: true, ids: (out || []).map((r) => r.id) });
      return;
    }
    if (req.method === 'DELETE') {
      const id = String((req.query && req.query.id) || '');
      if (!UUID.test(id)) { res.status(400).json({ error: 'bad id' }); return; }
      await sb('bft_sightings?id=eq.' + id, { method: 'DELETE' });
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    res.status(502).json({ enabled: true, error: String(e && e.message ? e.message : e).slice(0, 300) });
  }
};
module.exports.clean = clean;
