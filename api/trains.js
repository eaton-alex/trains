// Vercel serverless function: GET /api/trains
// Holds the TfL and National Rail keys so they never reach the browser.
//
// Environment variables (set in Vercel > Project > Settings > Environment Variables):
//   TFL_APP_KEY   your TfL app key (optional, raises the rate limit)
//   NR_API_KEY    your Rail Data Marketplace key for the Live Departure Board
//   RTT_TOKEN     your Realtime Trains (next generation) token, a refresh token or a long-life access token.
//   RTT_LOCATION  optional. Station code to query, default BCY (Brockley).
//   NR_LDB_URL    optional. The board URL exactly as shown on your Rail Data Marketplace
//                 subscription page, with {crs} where the station code goes.

const TFL_URL = 'https://api.tfl.gov.uk/StopPoint/910GBROCKLY/Arrivals';
const NR_DEFAULT_URL = 'https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120/GetDepBoardWithDetails/{crs}';
const STATION_CRS = 'BCY'; // Brockley

const londonFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false
});
function londonParts(ms) {
  const o = {};
  londonFmt.formatToParts(new Date(ms)).forEach((p) => { o[p.type] = p.value; });
  return o;
}
// Turns a London clock time such as "10:47" into an epoch time, today or just after midnight.
function londonEpoch(hhmm, now) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  const n = londonParts(now);
  const guess = Date.UTC(Number(n.year), Number(n.month) - 1, Number(n.day), h, min);
  const g = londonParts(guess);
  const asLondon = Date.UTC(Number(g.year), Number(g.month) - 1, Number(g.day), Number(g.hour) % 24, Number(g.minute));
  let t = guess - (asLondon - guess);
  if (t < now - 12 * 3600 * 1000) t += 24 * 3600 * 1000; // service just after midnight
  return t;
}


// RTT sends times like "2026-10-12T16:05:30" with no zone, meaning London time.
// Strings that do carry a zone ("Z" or an offset) are read as they are.
function parseRtt(str) {
  if (!str) return NaN;
  const v = String(str);
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(v)) return Date.parse(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(v);
  if (!m) return Date.parse(v);
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const g = londonParts(asUtc);
  const shown = Date.UTC(+g.year, +g.month - 1, +g.day, +g.hour % 24, +g.minute);
  const offset = shown - Math.floor(asUtc / 60000) * 60000; // London minus UTC at that moment
  return asUtc - offset;
}

async function getJson(url, headers) {
  const r = await fetch(url, { headers: headers || {}, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (r.status === 204) return {};
  return r.json();
}

async function getTfl() {
  try {
    const key = process.env.TFL_APP_KEY;
    const url = TFL_URL + (key ? '?app_key=' + encodeURIComponent(key) : '');
    const arr = await getJson(url);
    const trains = arr
      .filter((p) => p.lineId === 'windrush')
      .map((p) => ({
        vehicleId: p.vehicleId,
        direction: p.direction,
        platform: p.platformName,
        destinationName: String(p.destinationName || '').replace(/ Rail Station$/, ''),
        expectedArrival: p.expectedArrival
      }));
    return { ok: true, keyed: Boolean(key), trains };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), trains: [] };
  }
}

async function getNr(now) {
  const key = process.env.NR_API_KEY;
  if (!key) return { ok: false, enabled: false, trains: [] };
  try {
    const base = process.env.NR_LDB_URL || NR_DEFAULT_URL;
    const url = base.replace('{crs}', STATION_CRS) + (base.includes('?') ? '&' : '?') + 'numRows=15';
    const j = await getJson(url, { 'x-apikey': key });
    if (!j || !Array.isArray(j.trainServices || [])) throw new Error('Unexpected response shape');
    const trains = [];
    (j.trainServices || []).forEach((s) => {
      if (s.isCancelled || s.operatorCode === 'LO') return; // Overground comes from TfL
      const etd = String(s.etd || '');
      const when = /^\d{1,2}:\d{2}$/.test(etd) ? etd : (/on time/i.test(etd) ? s.std : null);
      const dep = londonEpoch(when, now);
      if (!dep) return;
      const dest = Array.isArray(s.destination) && s.destination[0] ? s.destination[0].locationName : '';
      trains.push({ platform: String(s.platform || ''), dep, destination: dest, operator: s.operator || '' });
    });
    return { ok: true, enabled: true, trains };
  } catch (e) {
    return { ok: false, enabled: true, error: String((e && e.message) || e), trains: [] };
  }
}


// ---- Realtime Trains (next generation API) ----
// Brockley itself only lists trains that stop here, so for the fast lines we ask for the
// passes at New Cross Gate and Sydenham either side (timing points) and work out where
// each train is when it goes by Brockley.
const RTT_BASE = 'https://data.rtt.io';
const RTT_CODE = process.env.RTT_LOCATION || 'BCY';
const RTT_A = process.env.RTT_PASS_A || 'NXG'; // towards London, timing point
const RTT_B = process.env.RTT_PASS_B || 'SYD'; // towards Brighton, timing point
const RTT_FRAC = Number(process.env.RTT_FRAC) || 0.2; // how far Brockley is from A towards B, as a share of the A to B time
let rttAccess = null; // { token, until }
let rttCache = { at: 0, data: null };

async function rttToken() {
  const key = process.env.RTT_TOKEN;
  if (!key) return null;
  if (rttAccess && rttAccess.until > Date.now() + 60000) return rttAccess.token;
  try {
    const j = await getJson(RTT_BASE + '/api/get_access_token', { Authorization: 'Bearer ' + key });
    if (j && j.token) {
      rttAccess = { token: j.token, until: parseRtt(j.validUntil) || Date.now() + 10 * 60000 };
      return rttAccess.token;
    }
  } catch (e) { /* a long-life access token is not exchanged, so use it as is */ }
  rttAccess = { token: key, until: Date.now() + 10 * 60000 };
  return key;
}
function rttTime(td) {
  if (!td) return null;
  const v = td.realtimeActual || td.realtimeForecast || td.realtimeEstimate || td.scheduleInternal || td.scheduleAdvertised;
  const t = v ? parseRtt(v) : NaN;
  return Number.isNaN(t) ? null : t;
}
function rttOp(s) { return (s.scheduleMetadata && s.scheduleMetadata.operator) || {}; }
function rttDest(s) { return (s.destination && s.destination[0] && s.destination[0].location && s.destination[0].location.description) || ''; }
function rttId(s) { return (s.scheduleMetadata && (s.scheduleMetadata.uniqueIdentity || s.scheduleMetadata.identity)) || ''; }
function rttIsPass(s) { const d = s.temporalData && s.temporalData.displayAs; return !d || d === 'PASS'; }

// Trains calling at Brockley (Southern; Overground comes from TfL)
function rttCalls(services) {
  const out = [];
  (services || []).forEach((s) => {
    if (rttIsPass(s)) return;
    const op = rttOp(s);
    if (op.code === 'LO') return;
    const td = s.temporalData || {};
    const platform = String((s.locationMetadata && s.locationMetadata.platform && (s.locationMetadata.platform.forecast || s.locationMetadata.platform.planned)) || '');
    const dep = rttTime(td.departure);
    if (!dep || (platform !== '1' && platform !== '2')) return;
    out.push({ platform, dep, operator: op.code || '', destination: rttDest(s), identity: (s.scheduleMetadata && s.scheduleMetadata.trainReportingIdentity) || '' });
  });
  return out;
}
// Trains that pass New Cross Gate and Sydenham without stopping, placed at Brockley
function rttPoint(s) {
  const p = (s.temporalData && s.temporalData.pass) || {};
  const sched = parseRtt(p.scheduleInternal || p.scheduleAdvertised || '');
  const real = parseRtt(p.realtimeActual || p.realtimeForecast || p.realtimeEstimate || '');
  return { sched: Number.isNaN(sched) ? null : sched, real: Number.isNaN(real) ? null : real };
}
function rttPasses(aServices, bServices) {
  const aMap = {};
  (aServices || []).forEach((s) => { if (rttIsPass(s)) aMap[rttId(s)] = s; });
  const out = [];
  (bServices || []).forEach((s) => {
    if (!rttIsPass(s)) return;
    const as = aMap[rttId(s)];
    if (!as) return;
    const op = rttOp(s);
    if (op.code === 'LO') return;
    const A = rttPoint(as), B = rttPoint(s);
    // Direction comes from the timetable, which is always there, not from reported times that may be missing at one end.
    const dirBasis = (A.sched && B.sched) ? [A.sched, B.sched] : [A.real || A.sched, B.real || B.sched];
    if (!dirBasis[0] || !dirBasis[1]) return;
    // If only one end has a report, carry its lateness over to the other end so the two times are comparable.
    let ta = A.real, tb = B.real;
    if (ta == null && tb != null && A.sched && B.sched) ta = A.sched + (tb - B.sched);
    if (tb == null && ta != null && A.sched && B.sched) tb = B.sched + (ta - A.sched);
    if (ta == null) ta = A.sched;
    if (tb == null) tb = B.sched;
    if (!ta || !tb) return;
    out.push({
      dir: dirBasis[1] > dirBasis[0] ? 'S' : 'N', // reaches Sydenham after New Cross Gate means heading away from London
      time: Math.round(ta + RTT_FRAC * (tb - ta)),
      operator: op.code || '', destination: rttDest(s), identity: (s.scheduleMetadata && s.scheduleMetadata.trainReportingIdentity) || ''
    });
  });
  return out;
}
// ---- Request budget: RTT limits how often we may ask, so each answer is reused for a while ----
const RTT_PASS_TTL = 60 * 1000;   // New Cross Gate and Sydenham passes
const RTT_CALL_TTL = 120 * 1000;  // Brockley calls change less often
const RTT_STALE_MAX = 15 * 60 * 1000; // keep using the last good answer this long if RTT refuses
const rttStore = {};  // code -> { at, data }
let rttBackoffUntil = 0;
let rttRate = null;   // last rate-limit headers RTT sent

async function rttFetch(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  const rate = {};
  r.headers.forEach((v, k) => { if (/^x-ratelimit/i.test(k)) rate[k] = v; });
  if (Object.keys(rate).length) rttRate = rate;
  if (r.status === 429) {
    const ra = Number(r.headers.get('retry-after'));
    rttBackoffUntil = Date.now() + (ra > 0 ? ra * 1000 : 90 * 1000);
    throw new Error('HTTP 429');
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (r.status === 204) return {};
  return r.json();
}
// One location, answered from the store when it is fresh enough, or when RTT has told us to wait.
async function rttLocation(code, ttl, detailed, h, force) {
  const hit = rttStore[code], now = Date.now();
  if (hit && !force && now - hit.at < ttl) return hit.data;
  if (now < rttBackoffUntil) {
    if (hit && now - hit.at < RTT_STALE_MAX) return Object.assign({}, hit.data, { _stale: true });
    throw new Error('HTTP 429');
  }
  const base = RTT_BASE + '/gb-nr/location?code=' + encodeURIComponent(code) + '&timeWindow=60&timeTolerance=true';
  let data, mode = 'plain';
  try {
    if (detailed) {
      try { data = await rttFetch(base + '&detailed=true', h); mode = 'detailed'; }
      catch (e) {
        if (String(e.message) === 'HTTP 429') throw e;
        mode = 'refused: ' + e.message; // not allowed detailed mode, so try the plain query
        data = await rttFetch(base, h);
      }
    } else {
      data = await rttFetch(base, h);
    }
  } catch (e) {
    if (hit && Date.now() - hit.at < RTT_STALE_MAX) return Object.assign({}, hit.data, { _stale: true });
    throw e;
  }
  data._mode = mode;
  rttStore[code] = { at: Date.now(), data };
  return data;
}
async function getRtt(debug) {
  if (!process.env.RTT_TOKEN) return { ok: false, enabled: false, trains: [], calls: [] };
  try {
    const token = await rttToken();
    const h = { Authorization: 'Bearer ' + token };
    const settle = (p) => p.then((v) => ({ v }), (e) => ({ e: String((e && e.message) || e) }));
    const [here, a, b] = await Promise.all([
      settle(rttLocation(RTT_CODE, RTT_CALL_TTL, false, h, false)),
      settle(rttLocation(RTT_A, RTT_PASS_TTL, true, h, false)),
      settle(rttLocation(RTT_B, RTT_PASS_TTL, true, h, false))
    ]);
    if (here.e && a.e && b.e) throw new Error(a.e);
    const A = a.v || {}, B = b.v || {}, H = here.v || {};
    const res = { ok: true, enabled: true, trains: rttPasses(A.services, B.services), calls: rttCalls(H.services) };
    const stale = !!(A._stale || B._stale || H._stale);
    if (stale) res.stale = true;
    if (here.e || a.e || b.e) res.partialErrors = { here: here.e, a: a.e, b: b.e };
    if (debug) {
      const tally = (r) => { const o = {}; (r.services || []).forEach((s) => { const k = (s.temporalData && s.temporalData.displayAs) || 'PASS'; o[k] = (o[k] || 0) + 1; }); return o; };
      let info = null;
      if (Date.now() >= rttBackoffUntil) info = await rttFetch(RTT_BASE + '/api/info', h).catch((e) => ({ _error: String((e && e.message) || e) }));
      res.sample = {
        codes: { here: RTT_CODE, a: RTT_A, b: RTT_B, frac: RTT_FRAC },
        detailedMode: { a: A._mode, b: B._mode },
        rateLimits: rttRate,
        backoffSeconds: Math.max(0, Math.round((rttBackoffUntil - Date.now()) / 1000)),
        info,
        displayAs: { here: tally(H), a: tally(A), b: tally(B) }
      };
    }
    return res;
  } catch (e) {
    return { ok: false, enabled: true, error: String((e && e.message) || e), trains: [], calls: [] };
  }
}

module.exports = async function handler(req, res) {
  const now = Date.now();
  const debug = req.query && req.query.debug === 'rtt';
  const [tfl, nr, rtt] = await Promise.all([getTfl(), getNr(now), getRtt(debug)]);
  res.setHeader('Cache-Control', debug ? 'no-store' : 'public, s-maxage=45, stale-while-revalidate=120');
  res.status(200).json({ fetchedAt: now, tfl, nr, rtt });
};
module.exports.londonEpoch = londonEpoch;
module.exports.parseRtt = parseRtt;
