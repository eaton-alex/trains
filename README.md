# Brockley Four Tracks

A single page (`index.html`) plus one server function (`api/trains.js`) that holds your TfL and National Rail keys.

## Put it online

1. Create a new GitHub repo (for example `eaton-alex/trains`) and add these files: `index.html`, `api/trains.js`, `vercel.json`.
2. In Vercel, choose Add New > Project and import that repo. No build settings are needed.
3. In the project, open Settings > Environment Variables and add:
   - `TFL_APP_KEY`: your TfL key.
   - `NR_API_KEY`: your Rail Data Marketplace key (add it once you have it).
   - `RTT_TOKEN`: your Realtime Trains (next generation) token from api-portal.rtt.io. This gives the Thameslink and Southern fast-line trains.
   - `RTT_LOCATION`: only if you want a station code other than `BCY`.
   - `NR_LDB_URL`: only if the default does not work. Copy the board URL from your Rail Data Marketplace subscription page and put `{crs}` where the station code goes.
4. Redeploy so the variables take effect.
5. In the project, open Settings > Domains and add `trains.smallgoblin.com`. Vercel will show the DNS record to add in GoDaddy, the same as for your other subdomains.

## Check it works

Open `https://trains.smallgoblin.com/api/trains`. You should see JSON.

- `tfl.ok` is `true` when the TfL feed answered.
- `nr.ok` is `true` when National Rail answered. If it is `false`, `nr.error` says why.
- `nr.enabled` is `false` until `NR_API_KEY` is set.
- `rtt.ok` is `true` when Realtime Trains answered. `rtt.enabled` is `false` until `RTT_TOKEN` is set.
- Open `/api/trains?debug=rtt` to see the first raw services from Realtime Trains and how many came back each way.

The page shows green "live" pills at the top for whichever feeds are working, and falls back to simulated times for the rest.

## Your sightings

Without the Claude artifact store, the "A train just passed" button keeps taps in the browser on that device only.
