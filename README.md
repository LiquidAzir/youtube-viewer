# YouTube Viewer for Meta Ray-Ban Display

Public visitors provide their own YouTube Data API v3 key. The app does not
include an owner key, channel, watch history or Google account session. Legacy
shared-key configuration is ignored, even if an old `config.js` is served.

## Set up your own access

1. Sign in to your own Google account at https://console.cloud.google.com/.
2. Create or select your own project and enable **YouTube Data API v3**.
3. Open **APIs & Services → Credentials → Create credentials → API key**.
4. Restrict that key to the YouTube Data API v3 and to the website
   `https://youtube-viewer-jezb.onrender.com/*` (or your own deployed app URL).
5. Open the glasses app's **Settings**, paste your key and choose **Save**.
6. Optionally add your own channel ID from https://www.youtube.com/account_advanced
   using **Save channel**. This enables public uploads and playlists, and public
   subscriptions when available. It is not a Google sign-in and cannot access
   private channel content.

Setup references verified September 19, 2026:
- https://developers.google.com/youtube/v3/getting-started
- https://docs.cloud.google.com/docs/authentication/api-keys

Keys, optional channel IDs, searches and watch history are saved in this app on
the visitor's device. Google receives YouTube API and player requests; the key's
quota belongs to that visitor's project. **Clear all app data on this device** in
Settings removes the local key, channel, searches, history and resume position.
Use it before sharing the device. It does not delete the visitor's Google account
or change Google/YouTube's separate cookies or history.

For a private glasses pairing link, prefer `/#key=YOUR_KEY&channel=YOUR_CHANNEL`
over query parameters. Fragments are not sent in the static host request and are
removed by the app after saving. Anyone with a personal pairing link or QR can
read the values, so never publish it. The public catalog QR includes only the
plain app URL, with no credentials or channel. Browser storage on the phone does
not automatically copy to the glasses; setup must be supplied on that device.

## Build and check

Run `node scripts/build.mjs` and publish **dist/** only. The build copies six
frontend files and excludes source tools, tests, personal QR files and other
repository content. In Render use build command `node scripts/build.mjs` and
static publish directory `dist`; changing the local YAML alone does not change
an existing dashboard service until the release is applied.

Run `node tests/public-copy.cjs` for isolated browser checks (Playwright required).
Every external request is blocked and the tests use fictional, nonfunctional
keys. No live Google API key or account is needed.
