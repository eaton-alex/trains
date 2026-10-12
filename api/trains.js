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
      rttAccess = { token: j.token, until: Date.parse(j.validUntil) || Date.now() + 10 * 60000 };
      return rttAccess.token;
    }
  } catch (e) { /* a long-life access token is not exchanged, so use it as is */ }
  rttAccess = { token: key, until: Date.now() + 10 * 60000 };
  return key;
}
function rttTime(td) {
  if (!td) return null;
  const v = td.realtimeActual || td.realtimeForecast || td.realtimeEstimate || td.scheduleInternal || td.scheduleAdvertised;
  const t = v ? Date.parse(v) : NaN;
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
function rttPasses(aServices, bServices) {
  const aMap = {};
  (aServices || []).forEach((s) => { if (rttIsPass(s)) { const t = rttTime(s.temporalData.pass); if (t) aMap[rttId(s)] = { t, s }; } });
  const out = [];
  (bServices || []).forEach((s) => {
    if (!rttIsPass(s)) return;
    const tb = rttTime(s.temporalData.pass), a = aMap[rttId(s)];
    if (!tb || !a) return;
    const op = rttOp(s);
    if (op.code === 'LO') return;
    out.push({
      dir: tb > a.t ? 'S' : 'N', // reaches Sydenham after New Cross Gate means heading away from London
      time: Math.round(a.t + RTT_FRAC * (tb - a.t)),
      operator: op.code || '', destination: rttDest(s), identity: (s.scheduleMetadata && s.scheduleMetadata.trainReportingIdentity) || ''
    });
  });
  return out;
}
async function getRtt(debug) {
  if (!process.env.RTT_TOKEN) return { ok: false, enabled: false, trains: [], calls: [] };
  if (!debug && rttCache.data && Date.now() - rttCache.at < 25000) return rttCache.data;
  try {
    const token = await rttToken();
    const h = { Authorization: 'Bearer ' + token };
    const q = (code) => RTT_BASE + '/gb-nr/location?code=' + encodeURIComponent(code) + '&timeWindow=30&timeTolerance=true';
    const one = (code) => getJson(q(code), h).catch((e) => ({ _error: String((e && e.message) || e) }));
    const [here, a, b] = await Promise.all([one(RTT_CODE), one(RTT_A), one(RTT_B)]);
    if (here._error && a._error && b._error) throw new Error(here._error);
    const trains = rttPasses(a.services, b.services);
    const calls = rttCalls(here.services);
    const res = { ok: true, enabled: true, trains, calls };
    if (here._error || a._error || b._error) res.partialErrors = { here: here._error, a: a._error, b: b._error };
    if (debug) {
      const tally = (r) => { const o = {}; (r.services || []).forEach((s) => { const k = (s.temporalData && s.temporalData.displayAs) || 'PASS'; o[k] = (o[k] || 0) + 1; }); return o; };
      res.sample = {
        codes: { here: RTT_CODE, a: RTT_A, b: RTT_B, frac: RTT_FRAC },
        displayAs: { here: tally(here), a: tally(a), b: tally(b) },
        firstPassAtA: (a.services || []).filter(rttIsPass).slice(0, 1),
        firstPassAtB: (b.services || []).filter(rttIsPass).slice(0, 1)
      };
    }
    rttCache = { at: Date.now(), data: res };
    return res;
  } catch (e) {
    return { ok: false, enabled: true, error: String((e && e.message) || e), trains: [], calls: [] };
  }
}

module.exports = async function handler(req, res) {
  const now = Date.now();
  const debug = req.query && req.query.debug === 'rtt';
  const [tfl, nr, rtt] = await Promise.all([getTfl(), getNr(now), getRtt(debug)]);
  res.setHeader('Cache-Control', debug ? 'no-store' : 'public, s-maxage=20, stale-while-revalidate=40');
  res.status(200).json({ fetchedAt: now, tfl, nr, rtt });
};
module.exports.londonEpoch = londonEpoch;
