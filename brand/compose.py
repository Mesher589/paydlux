#!/usr/bin/env python3
"""Compose the deliverables: X profile pic, X banner, site og:image.

Rasterises the chosen SVG mark with macOS sips, then composes PNGs with PIL.
"""
import os, subprocess, glob
from PIL import Image, ImageDraw, ImageFont

INK, GOLD, GREEN, TEXT, MUTED = (13,15,14), (232,176,75), (95,191,139), (236,234,228), (154,163,157)
MARK = "a-coin-check"
os.makedirs("deliverables", exist_ok=True)


def raster(svg, px):
    out = f"out/_r{px}.png"
    subprocess.run(["sips", "-s", "format", "png", "-Z", str(px), svg, "--out", out],
                   check=True, capture_output=True)
    return Image.open(out).convert("RGBA")


def font(size, bold=False):
    cands = ["/System/Library/Fonts/Avenir Next.ttc",
             "/System/Library/Fonts/Supplemental/Avenir Next.ttc",
             "/System/Library/Fonts/Helvetica.ttc",
             "/System/Library/Fonts/Supplemental/Georgia.ttf"]
    for c in cands:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size, index=1 if bold else 0)
            except Exception:
                try:
                    return ImageFont.truetype(c, size)
                except Exception:
                    continue
    return ImageFont.load_default()


def split_ring_draw(d, cx, cy, r, w, a1=10, a2=170):
    """Draw the two-arc ring directly (used for large formats)."""
    bbox = [cx-r, cy-r, cx+r, cy+r]
    d.arc(bbox, start=a1, end=a2, fill=GOLD, width=w)
    d.arc(bbox, start=a2+20, end=a1+360, fill=GREEN, width=w)


def check_draw(d, cx, cy, scale, w, color):
    pts = [(170,262),(232,324),(352,204)]
    pts = [(cx + (x-256)*scale, cy + (y-256)*scale) for x,y in pts]
    d.line(pts, fill=color, width=w, joint="curve")
    for (x,y) in pts:
        d.ellipse([x-w/2, y-w/2, x+w/2, y+w/2], fill=color)


def mark_on(size, scale=0.62, bg=INK, radius=None):
    """Square mark canvas drawn from scratch so it stays crisp at any size."""
    im = Image.new("RGBA", (size, size), (0,0,0,0))
    d = ImageDraw.Draw(im)
    r = radius if radius is not None else int(size*0.18)
    d.rounded_rectangle([0,0,size-1,size-1], radius=r, fill=bg)
    cx = cy = size/2
    ring = size*scale/2
    w = max(2, int(ring*0.19))
    split_ring_draw(d, cx, cy, ring, w)
    check_draw(d, cx, cy, scale/0.72, max(2, int(size*0.09)), GOLD)
    return im


# ------------------------------------------------------------- profile pictures
for px in (1024, 400, 128):
    mark_on(px).save(f"deliverables/profile-{px}.png")

# ------------------------------------------------------------- X banner 1500x500
W, H = 1500, 500
b = Image.new("RGB", (W, H), INK)
d = ImageDraw.Draw(b)
# right side: the mark
mk = mark_on(360)
b.paste(mk, (W-430, 70), mk)
# left side: wordmark
d.text((96, 150), "Pay", font=font(122), fill=TEXT)
pay_w = d.textlength("Pay", font=font(122))
d.text((96+pay_w, 150), "dlux", font=font(122), fill=GOLD)
d.text((100, 300), "AGENT PAYMENTS  ·  HUMAN APPROVAL  ·  STELLAR",
       font=font(30), fill=MUTED)
b.save("deliverables/x-banner-1500x500.png")

# ------------------------------------------------------------- og:image 1200x630
W, H = 1200, 630
o = Image.new("RGB", (W, H), INK)
d = ImageDraw.Draw(o)
mk = mark_on(240)
o.paste(mk, (72, 74), mk)
d.text((340, 118), "Pay", font=font(96), fill=TEXT)
pw = d.textlength("Pay", font=font(96))
d.text((340+pw, 118), "dlux", font=font(96), fill=GOLD)
d.text((74, 360), "Your agent can spend money.", font=font(52), fill=TEXT)
d.text((74, 424), "It can't spend it without you.", font=font(52), fill=GOLD)
d.text((74, 520), "Spending mandates enforced on the Stellar ledger  ·  paydlux.com",
       font=font(28), fill=MUTED)
o.save("deliverables/og-image-1200x630.png")

print("deliverables:")
for f in sorted(glob.glob("deliverables/*")):
    im = Image.open(f)
    print(f"  {f:38s} {im.size[0]}x{im.size[1]}  {os.path.getsize(f)//1024} KB")
