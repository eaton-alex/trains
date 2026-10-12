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


// ---- Realtime Trains (next generation API): trains that pass Brockley without stopping ----
const RTT_BASE = 'https://data.rtt.io';
const RTT_CODE = process.env.RTT_LOCATION || 'BCY';
const RTT_LONDON = 'LBG'; // London Bridge: every train on these lines runs to or from it
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
function rttMap(services, dir) {
  const out = [];
  (services || []).forEach((s) => {
    const td = s.temporalData || {};
    const shown = td.displayAs || 'PASS';
    if (shown !== 'PASS') return; // calling trains come from TfL and National Rail
    const t = rttTime(td.pass) || rttTime(td.departure) || rttTime(td.arrival);
    if (!t) return;
    const op = (s.scheduleMetadata && s.scheduleMetadata.operator) || {};
    if (op.code === 'LO') return;
    const dest = (s.destination && s.destination[0] && s.destination[0].location && s.destination[0].location.description) || '';
    out.push({
      dir, time: t, operator: op.code || '', operatorName: op.name || '', destination: dest,
      identity: (s.scheduleMetadata && s.scheduleMetadata.trainReportingIdentity) || ''
    });
  });
  return out;
}
async function getRtt(debug) {
  if (!process.env.RTT_TOKEN) return { ok: false, enabled: false, trains: [] };
  if (!debug && rttCache.data && Date.now() - rttCache.at < 25000) return rttCache.data;
  try {
    const token = await rttToken();
    const h = { Authorization: 'Bearer ' + token };
    const q = '/gb-nr/location?code=' + encodeURIComponent(RTT_CODE) + '&timeWindow=30&timeTolerance=true';
    const [north, south] = await Promise.all([
      getJson(RTT_BASE + q + '&filterTo=' + RTT_LONDON, h),
      getJson(RTT_BASE + q + '&filterFrom=' + RTT_LONDON, h)
    ]);
    const trains = rttMap(north.services, 'N').concat(rttMap(south.services, 'S'));
    const res = { ok: true, enabled: true, trains };
    if (debug) res.sample = { north: (north.services || []).slice(0, 2), south: (south.services || []).slice(0, 2), counts: { north: (north.services || []).length, south: (south.services || []).length } };
    rttCache = { at: Date.now(), data: res };
    return res;
  } catch (e) {
    return { ok: false, enabled: true, error: String((e && e.message) || e), trains: [] };
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
