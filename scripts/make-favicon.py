"""
Render a high-quality YouTube-Viewer favicon with Pillow.

Design: a rounded-square (squircle) badge in an on-brand red vertical
gradient, a subtle top sheen, and a crisp white play triangle with
rounded corners — optically centered. Rendered at 4x then downscaled
with LANCZOS for smooth anti-aliased edges. Transparent background so
that on the additive glasses display only the badge + triangle emit light.

Run:
    python scripts/make-favicon.py                # writes favicon.png (256x256)
    python scripts/make-favicon.py --size 512     # larger
"""

import argparse
from PIL import Image, ImageDraw, ImageChops, ImageFilter


def lerp(a, b, t):
    return int(round(a + (b - a) * t))


def make_icon(out_size: int) -> Image.Image:
    ss = 4
    S = out_size * ss

    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # --- Rounded-square badge mask ---
    margin = int(S * 0.055)
    radius = int(S * 0.265)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [margin, margin, S - margin, S - margin], radius=radius, fill=255)

    # --- Vertical red gradient (on-brand around #ff0033) ---
    top = (0xFF, 0x42, 0x60)   # lighter top
    bot = (0xDB, 0x00, 0x2E)   # deeper bottom
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        t = y / (S - 1)
        gd.line([(0, y), (S, y)],
                fill=(lerp(top[0], bot[0], t),
                      lerp(top[1], bot[1], t),
                      lerp(top[2], bot[2], t), 255))
    img.paste(grad, (0, 0), mask)

    # --- Subtle top sheen (soft glossy highlight), clipped to the badge ---
    sheen = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(sheen).ellipse(
        [S * 0.06, -S * 0.20, S * 0.94, S * 0.42], fill=(255, 255, 255, 30))
    sheen = sheen.filter(ImageFilter.GaussianBlur(S * 0.06))
    sheen.putalpha(ImageChops.multiply(sheen.getchannel("A"), mask))
    img = Image.alpha_composite(img, sheen)

    # --- White play triangle, optically centered, rounded corners ---
    draw = ImageDraw.Draw(img)
    left_x = S * 0.415
    tip_x = S * 0.660
    top_y = S * 0.330
    bot_y = S * 0.670
    mid_y = (top_y + bot_y) / 2
    tri = [(left_x, top_y), (left_x, bot_y), (tip_x, mid_y)]
    draw.polygon(tri, fill=(255, 255, 255, 255))
    # Stroke the perimeter with curved joints to round the three corners.
    draw.line(tri + [tri[0]], fill=(255, 255, 255, 255),
              width=int(S * 0.028), joint="curve")

    return img.resize((out_size, out_size), Image.LANCZOS)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--size", type=int, default=256, help="output px (default 256)")
    ap.add_argument("--out", default="favicon.png", help="output path")
    args = ap.parse_args()
    icon = make_icon(args.size)
    icon.save(args.out)
    print(f"wrote {args.out} ({args.size}x{args.size})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
