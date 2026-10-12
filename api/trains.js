// Vercel serverless function: GET /api/trains
// Holds the TfL and National Rail keys so they never reach the browser.
//
// Environment variables (set in Vercel > Project > Settings > Environment Variables):
//   TFL_APP_KEY   your TfL app key (optional, raises the rate limit)
//   NR_API_KEY    your Rail Data Marketplace key for the Live Departure Board
//   RTT_TOKEN     your Realtime Trains (next generation) token, a refresh token or a long-life access token.
//   RTT_TOKEN_2   optional second token, used only if the first has an outage or an authorisation problem.
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

async function getNr(now, debug) {
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
    const res = { ok: true, enabled: true, trains };
    if (debug) res.sample = { url: url.replace(key, '***'), keys: Object.keys(j || {}), first: (j.trainServices || [])[0] || null, count: (j.trainServices || []).length };
    return res;
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
const rttAccess = {}; // token index -> { token, until }
const rttBadUntil = {}; // token index -> time before which we avoid it after a failure

function rttKeys() { return [process.env.RTT_TOKEN, process.env.RTT_TOKEN_2].filter(Boolean); }
async function rttToken(i) {
  const key = rttKeys()[i];
  if (!key) return null;
  const hit = rttAccess[i];
  if (hit && hit.until > Date.now() + 60000) return hit.token;
  try {
    const j = await getJson(RTT_BASE + '/api/get_access_token', { Authorization: 'Bearer ' + key });
    if (j && j.token) {
      rttAccess[i] = { token: j.token, until: parseRtt(j.validUntil) || Date.now() + 10 * 60000 };
      return rttAccess[i].token;
    }
  } catch (e) { /* a long-life access token is not exchanged, so use it as is */ }
  rttAccess[i] = { token: key, until: Date.now() + 10 * 60000 };
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
    // A cancelled or diverted train will not come by, so it is left out.
    if (!/^(CALL|STARTS|TERMINATES)$/.test(td.displayAs || '') || (td.departure && td.departure.isCancelled)) return;
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
    const cancelled = (x) => { const p = x.temporalData && x.temporalData.pass; return p && p.isCancelled; };
    if (cancelled(as) || cancelled(s)) return;
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
// The Hobbyist plan allows 10 requests a minute, 100 an hour and 1,000 a day. Two passes queries every
// four minutes is 30 an hour, 720 a day, which leaves room for Brockley's own calls, restarts and debug visits.
const RTT_PASS_TTL = (Number(process.env.RTT_PASS_TTL_S) || 240) * 1000; // New Cross Gate and Sydenham passes
const RTT_CALL_TTL = (Number(process.env.RTT_CALL_TTL_S) || 1200) * 1000; // Brockley calls (only used when National Rail is not answering)
let rttRemainHour = null, rttRemainDay = null;
const RTT_STALE_MAX = 15 * 60 * 1000; // keep using the last good answer this long if RTT refuses
const rttStore = {};  // code -> { at, data }
let rttBackoffUntil = 0;
let rttInfo = null;
let rttRate = null;   // last rate-limit headers RTT sent

async function rttFetchWith(i, url) {
  const token = await rttToken(i);
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(8000) });
  const rate = {};
  r.headers.forEach((v, k) => { if (/^x-ratelimit/i.test(k)) rate['token' + (i + 1) + ' ' + k] = v; });
  if (Object.keys(rate).length) rttRate = Object.assign(rttRate || {}, rate);
  const rh = Number(r.headers.get('x-ratelimit-remaining-hour')), rd = Number(r.headers.get('x-ratelimit-remaining-day'));
  if (Number.isFinite(rh) && r.headers.get('x-ratelimit-remaining-hour') != null) rttRemainHour = rh;
  if (Number.isFinite(rd) && r.headers.get('x-ratelimit-remaining-day') != null) rttRemainDay = rd;
  if (r.status === 429) {
    const ra = Number(r.headers.get('retry-after'));
    rttRate = Object.assign(rttRate || {}, { 'last429 retry-after': r.headers.get('retry-after') });
    rttBackoffUntil = Date.now() + (ra > 0 ? ra * 1000 : 90 * 1000);
    throw new Error('HTTP 429');
  }
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (r.status === 204) return {};
  return r.json();
}
// Uses the first token. If it fails with an outage or an authorisation problem (not a rate limit),
// the same request goes to the second token, and the first is left alone for ten minutes.
let rttUsed = 0;
async function rttFetch(url) {
  const n = rttKeys().length, order = [];
  for (let k = 0; k < n; k++) { const i = (rttUsed + k) % n; if (!(rttBadUntil[i] > Date.now()) || k === n - 1) order.push(i); }
  let lastErr;
  for (const i of order) {
    try {
      const j = await rttFetchWith(i, url);
      rttUsed = i;
      return j;
    } catch (e) {
      lastErr = e;
      if (String(e.message) === 'HTTP 429') throw e; // respect the limit rather than hop around it
      if (/HTTP (4\d\d)/.test(String(e.message)) && !/HTTP (401|403)/.test(String(e.message))) throw e; // our own bad request
      rttBadUntil[i] = Date.now() + 10 * 60 * 1000;
      rttAccess[i] = null;
    }
  }
  throw lastErr;
}
// One location, answered from the store when it is fresh enough, or when RTT has told us to wait.
async function rttLocation(code, ttl, detailed, h, force) {
  const hit = rttStore[code], now = Date.now();
  // Running low on the hour's or day's allowance: ask less often, and stop altogether near the end.
  let stretch = 1;
  if ((rttRemainHour != null && rttRemainHour < 25) || (rttRemainDay != null && rttRemainDay < 150)) stretch = 3;
  const nearlyOut = (rttRemainHour != null && rttRemainHour <= 5) || (rttRemainDay != null && rttRemainDay <= 20);
  if (hit && !force && now - hit.at < ttl * stretch) return hit.data;
  if (nearlyOut && hit && now - hit.at < RTT_STALE_MAX) return Object.assign({}, hit.data, { _stale: true });
  if (now < rttBackoffUntil) {
    if (hit && now - hit.at < RTT_STALE_MAX) return Object.assign({}, hit.data, { _stale: true });
    throw new Error('HTTP 429');
  }
  const base = RTT_BASE + '/gb-nr/location?code=' + encodeURIComponent(code) + '&timeWindow=60&timeTolerance=true';
  let data, mode = 'plain';
  try {
    if (detailed) {
      try { data = await rttFetch(base + '&detailed=true'); mode = 'detailed'; }
      catch (e) {
        if (String(e.message) === 'HTTP 429') throw e;
        mode = 'refused: ' + e.message; // not allowed detailed mode, so try the plain query
        data = await rttFetch(base);
      }
    } else {
      data = await rttFetch(base);
    }
  } catch (e) {
    if (hit && Date.now() - hit.at < RTT_STALE_MAX) return Object.assign({}, hit.data, { _stale: true });
    throw e;
  }
  data._mode = mode;
  rttStore[code] = { at: Date.now(), data };
  return data;
}
async function getRtt(debug, skipHere) {
  if (!rttKeys().length) return { ok: false, enabled: false, trains: [], calls: [] };
  try {
    const h = null;
    const settle = (p) => p.then((v) => ({ v }), (e) => ({ e: String((e && e.message) || e) }));
    const [here, a, b] = await Promise.all([
      skipHere ? Promise.resolve({ v: {} }) : settle(rttLocation(RTT_CODE, RTT_CALL_TTL, false, h, false)),
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
      if (rttInfo && Date.now() - rttInfo.at < 3600 * 1000) info = rttInfo.data;
      else if (Date.now() >= rttBackoffUntil && (rttRemainHour == null || rttRemainHour > 10)) {
        info = await rttFetch(RTT_BASE + '/api/info').catch((e) => ({ _error: String((e && e.message) || e) }));
        if (!info._error) rttInfo = { at: Date.now(), data: info };
      }
      res.sample = {
        codes: { here: RTT_CODE, a: RTT_A, b: RTT_B, frac: RTT_FRAC },
        detailedMode: { a: A._mode, b: B._mode },
        rateLimits: rttRate,
        tokens: { configured: rttKeys().length, lastUsed: rttUsed + 1, avoidedForSeconds: Object.keys(rttBadUntil).map((i) => Math.max(0, Math.round((rttBadUntil[i] - Date.now()) / 1000))) },
        remaining: { hour: rttRemainHour, day: rttRemainDay },
        refreshSeconds: { passes: RTT_PASS_TTL / 1000, calls: RTT_CALL_TTL / 1000 },
        backoffSeconds: Math.max(0, Math.round((rttBackoffUntil - Date.now()) / 1000)),
        info,
        displayAs: { here: tally(H), a: tally(A), b: tally(B) }
      };
    }
    return res;
  } catch (e) {
    return {
      ok: false, enabled: true, error: String((e && e.message) || e), trains: [], calls: [],
      retryAfterSeconds: Math.max(0, Math.round((rttBackoffUntil - Date.now()) / 1000)),
      rateLimits: rttRate, tokensConfigured: rttKeys().length
    };
  }
}

module.exports = async function handler(req, res) {
  const now = Date.now();
  const dbg = req.query && req.query.debug;
  const debug = dbg === 'rtt';
  // National Rail is not rate limited like Realtime Trains, so when it answers it covers Brockley's own
  // Southern stopping trains and Realtime Trains is only asked about the fast lines.
  const [tfl, nr] = await Promise.all([getTfl(), getNr(now, dbg === 'nr')]);
  const rtt = await getRtt(debug, nr.ok);
  res.setHeader('Cache-Control', dbg ? 'no-store' : 'public, s-maxage=45, stale-while-revalidate=120');
  res.status(200).json({ fetchedAt: now, tfl, nr, rtt, ...(rtt.ok && nr.ok ? { stoppingFrom: 'nationalrail' } : {}) });
};
module.exports.londonEpoch = londonEpoch;
module.exports.parseRtt = parseRtt;
