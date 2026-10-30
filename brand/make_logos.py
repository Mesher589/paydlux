#!/usr/bin/env python3
"""Generate the Paydlux logo family as clean geometric SVG.

Concept: a coin (payment) whose ring is split into two arcs (the 2-of-2
multisig: agent + human). Inside sits the mark. Palette matches the site.
"""
import math, os

INK   = "#0d0f0e"
INK2  = "#141716"
GOLD  = "#e8b04b"
GREEN = "#5fbf8b"
TEXT  = "#eceae4"
C = 256  # canvas centre


def polar(r, deg):
    a = math.radians(deg)
    return (C + r * math.cos(a), C + r * math.sin(a))


def arc(r, a1, a2):
    """Clockwise arc from a1 to a2 (degrees, 0deg = 3 o'clock)."""
    p1, p2 = polar(r, a1), polar(r, a2)
    large = 1 if (a2 - a1) % 360 > 180 else 0
    return f"M{p1[0]:.2f} {p1[1]:.2f} A{r} {r} 0 {large} 1 {p2[0]:.2f} {p2[1]:.2f}"


def tile(inner=INK):
    return (f'<rect width="512" height="512" rx="112" fill="{INK}"/>'
            f'<rect x="14" y="14" width="484" height="484" rx="100" fill="{inner}"/>')


def split_ring(r=176, w=34):
    """Two arcs, two symmetric 28deg gaps: the two signatures the vault needs.
    28deg survives the round line-caps down to 24px."""
    return (f'<path d="{arc(r, 14, 166)}" fill="none" stroke="{GOLD}" '
            f'stroke-width="{w}" stroke-linecap="round"/>'
            f'<path d="{arc(r, 194, 346)}" fill="none" stroke="{GREEN}" '
            f'stroke-width="{w}" stroke-linecap="round"/>')


def check(pts, w, color):
    d = "M{:.2f} {:.2f} L{:.2f} {:.2f} L{:.2f} {:.2f}".format(*pts)
    return (f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{w}" '
            f'stroke-linecap="round" stroke-linejoin="round"/>')


def p_glyph(stem_x, bowl_cy, bowl_r, top, bottom, w, color):
    """Geometric P: vertical stem + semicircular bowl bulging right."""
    stem = (f'<path d="M{stem_x} {top} L{stem_x} {bottom}" fill="none" '
            f'stroke="{color}" stroke-width="{w}" stroke-linecap="round"/>')
    bowl = (f'<path d="{arc_at(stem_x, bowl_cy, bowl_r, -90, 90)}" fill="none" '
            f'stroke="{color}" stroke-width="{w}" stroke-linecap="round"/>')
    return stem + bowl


def arc_at(cx, cy, r, a1, a2):
    p1 = (cx + r * math.cos(math.radians(a1)), cy + r * math.sin(math.radians(a1)))
    p2 = (cx + r * math.cos(math.radians(a2)), cy + r * math.sin(math.radians(a2)))
    large = 1 if (a2 - a1) % 360 > 180 else 0
    return f"M{p1[0]:.2f} {p1[1]:.2f} A{r} {r} 0 {large} 1 {p2[0]:.2f} {p2[1]:.2f}"


def svg(body, label):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" '
            f'role="img" aria-label="{label}">{body}</svg>\n')


# ---------------------------------------------------------------- variants
# A - coin + approval check. Ring split in two = the two signatures.
A = svg(
    tile() + split_ring() + check((170, 262, 232, 324, 352, 204), 40, GOLD),
    "Paydlux - approved payment")

# B - monogram P whose leg is the approval check.
B = svg(
    tile()
    + p_glyph(172, 204, 88, 116, 344, 44, GOLD)
    + check((172, 344, 224, 396, 340, 280), 44, GREEN),
    "Paydlux - P monogram with approval check")

# E - coin with the P inside, ring split in two.
E = svg(
    tile() + split_ring() + p_glyph(215, 219, 64, 155, 357, 36, GOLD),
    "Paydlux - P inside a split coin")

# F - same as A but the check is green (approval reads as "go")
F = svg(
    tile() + split_ring() + check((170, 262, 232, 324, 352, 204), 40, TEXT),
    "Paydlux - approved payment, light check")

os.makedirs("out", exist_ok=True)
for name, body in [("a-coin-check", A), ("b-p-checkleg", B),
                   ("e-coin-p", E), ("f-coin-check-light", F)]:
    open(f"out/{name}.svg", "w").write(body)

# ------------------------------------------------------------ lockup (A + wordmark)
lockup = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 200" role="img" aria-label="Paydlux">
  <g transform="translate(20,20) scale(0.3125)">
    {tile()}{split_ring()}{check((170, 262, 232, 324, 352, 204), 40, GOLD)}
  </g>
  <text x="230" y="128" font-family="Instrument Serif, Georgia, serif" font-size="86" letter-spacing="1" fill="{TEXT}">Pay</text>
  <text x="392" y="128" font-family="Instrument Serif, Georgia, serif" font-size="86" letter-spacing="1" fill="{GOLD}">dlux</text>
  <text x="232" y="163" font-family="Archivo, system-ui, sans-serif" font-size="19" letter-spacing="5.5" fill="#9aa39d">AGENT PAYMENTS · STELLAR</text>
</svg>
'''
open("out/logo-lockup.svg", "w").write(lockup)

# ---------------------------------------------------------------- favicon (flat, no tile)
fav = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="{INK}"/>
  {split_ring(188, 40)}
  {check((168, 262, 232, 328, 356, 200), 46, GOLD)}
</svg>
'''
open("out/favicon.svg", "w").write(fav)

print("wrote:", sorted(os.listdir("out")))
