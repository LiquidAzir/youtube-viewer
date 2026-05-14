"""
Generate a Meta AI deep-link QR code that includes your YouTube API key.

Run from the youtube-viewer/ directory:
    python scripts/make-pair-qr.py YOUR_API_KEY
    python scripts/make-pair-qr.py YOUR_API_KEY --url https://other.onrender.com

Scan the resulting qr-paired.png with your phone camera. The Meta AI app
opens with the web app pre-filled; on first launch on the glasses the key
is read from ?key=..., saved to localStorage, then stripped from the URL.
"""

import argparse
import os
import subprocess
import sys
import urllib.parse

DEFAULT_RENDER_URL = "https://youtube-viewer-jezb.onrender.com"
APP_NAME = "youtube-viewer"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("api_key", help="YouTube Data API v3 key (AIza...)")
    parser.add_argument("--url", default=DEFAULT_RENDER_URL,
                        help=f"Render URL (default: {DEFAULT_RENDER_URL})")
    parser.add_argument("--out", default="qr-paired.png",
                        help="Output PNG path (default: qr-paired.png)")
    args = parser.parse_args()

    if not args.api_key.startswith("AIza"):
        print("warning: key doesn't look like a Google API key (should start with AIza)",
              file=sys.stderr)

    paired_url = f"{args.url}?key={urllib.parse.quote(args.api_key, safe='')}"
    encoded_url = urllib.parse.quote(paired_url, safe="")
    deep_link = f"fb-viewapp://web_app_deep_link?appName={APP_NAME}&appUrl={encoded_url}"

    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(here)
    # Walk up to find .claude/skills/qr-code/scripts/qr_generator.py
    search = repo_root
    qr_script = None
    for _ in range(4):
        candidate = os.path.join(search, ".claude", "skills", "qr-code",
                                 "scripts", "qr_generator.py")
        if os.path.isfile(candidate):
            qr_script = candidate
            break
        search = os.path.dirname(search)

    if qr_script is None:
        print("error: could not find qr_generator.py in .claude/skills/qr-code/scripts/",
              file=sys.stderr)
        return 1

    out_path = os.path.abspath(args.out)
    result = subprocess.run(
        [sys.executable, qr_script, "--png", out_path,
         "--ec", "M", "--scale", "12", deep_link],
        check=False,
    )
    if result.returncode != 0:
        return result.returncode

    print(f"\nPaired QR saved to: {out_path}")
    print("Scan it with your phone camera; it deep-links into the Meta AI app.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
