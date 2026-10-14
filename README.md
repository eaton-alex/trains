# Brockley Four Tracks

A single page (`index.html`) plus one server function (`api/trains.js`) that holds your TfL and National Rail keys.

## Put it online

1. Create a new GitHub repo (for example `eaton-alex/trains`) and add these files: `index.html`, `api/trains.js`, `vercel.json`.
2. In Vercel, choose Add New > Project and import that repo. No build settings are needed.
3. In the project, open Settings > Environment Variables and add:
   - `TFL_APP_KEY`: your TfL key.
   - `NR_API_KEY`: your Rail Data Marketplace key (add it once you have it).
   - `RTT_TOKEN`: your Realtime Trains (next generation) token from api-portal.rtt.io. This gives the Southern stopping trains and the Thameslink and Southern fast-line trains. Fast trains are timed at New Cross Gate and Sydenham, then placed at Brockley between them.
   - `RTT_TOKEN_2`: optional second Realtime Trains token. It is used only if the first one has an outage or an authorisation problem, never to get round a rate limit.
   - `RTT_PASS_TTL_S` and `RTT_CALL_TTL_S`: optional. How many seconds a Realtime Trains answer is reused. Defaults are 240 and 1200, sized for the Hobbyist limits (10 a minute, 100 an hour, 1,000 a day).
   - `RTT_LOCATION`, `RTT_PASS_A`, `RTT_PASS_B`, `RTT_FRAC`: optional. Defaults are `BCY`, `NXG`, `SYD` and `0.2` (Brockley sits about a fifth of the way from New Cross Gate to Sydenham).
   - `NR_LDB_URL`: only if the default does not work. Copy the board URL from your Rail Data Marketplace subscription page and put `{crs}` where the station code goes.
4. Redeploy so the variables take effect.
5. In the project, open Settings > Domains and add `trains.smallgoblin.com`. Vercel will show the DNS record to add in GoDaddy, the same as for your other subdomains.

## Check it works

Open `https://trains.smallgoblin.com/api/trains`. You should see JSON.

- `tfl.ok` is `true` when the TfL feed answered.
- `nr.ok` is `true` when National Rail answered. If it is `false`, `nr.error` says why.
- `nr.enabled` is `false` until `NR_API_KEY` is set.
- `rtt.ok` is `true` when Realtime Trains answered. `rtt.enabled` is `false` until `RTT_TOKEN` is set.
- Open `/api/trains?debug=nr` to see National Rail's raw first service and the URL used (the key is hidden).
- When National Rail answers, Brockley's Southern stopping trains come from it and Realtime Trains is only asked about the fast lines, which saves requests.
- Open `/api/trains?debug=rtt` to see the first raw services from Realtime Trains and how many came back each way.

The page shows green "live" pills at the top for whichever feeds are working, and falls back to simulated times for the rest.

## Your sightings

Without the Claude artifact store, the "A train just passed" button keeps taps in the browser on that device only.

## Auto-spot

Open the page on a spare phone, expand "Listen for trains (auto-spot)" and press Start listening. The page measures how loud it is (nothing is recorded), turns each rise of several dB into a train event, matches it to the nearest predicted train and logs a sighting. Sightings stay on that device. It rests from 01:00 to 05:00.

The same section can also watch through the camera: two thin strips either side of the middle of the picture give the direction of travel and the moment the front of a train crosses. Video is analysed on the device and never stored or sent.
