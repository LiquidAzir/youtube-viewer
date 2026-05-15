// =============================================================================
// YouTube Viewer config
// =============================================================================
// Set EMBEDDED_API_KEY to your YouTube Data API v3 key to enable zero-setup
// access for everyone who visits the deployed app. Friends scan the QR and
// the app just works — no Google Cloud Console dance for them.
//
// Get a key:
//   1. https://console.cloud.google.com/ -> create project (or pick existing)
//   2. APIs & Services -> Enable APIs -> "YouTube Data API v3"
//   3. Credentials -> Create credentials -> API key
//   4. Edit API key:
//        - API restrictions: Restrict key -> only "YouTube Data API v3"
//        - Application restrictions: Websites
//            https://youtube-viewer-jezb.onrender.com/*
//        Origin restriction is the ONLY thing protecting the key once it's
//        in this file (the file is public on GitHub).
//
// Quota:
//   Free tier = 10,000 units/day. Each search costs ~100 units, so ~100
//   searches/day shared across all users of the deployed URL. When the
//   daily quota is hit, the app shows users a friendly screen prompting
//   them to add their own personal key.
//
// To require every user to bring their own key (no shared), leave the
// value as 'YOUR_API_KEY_HERE' below.
// =============================================================================

window.YOUTUBE_VIEWER_CONFIG = {
  EMBEDDED_API_KEY: 'YOUR_API_KEY_HERE',
};
