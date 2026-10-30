# Paydlux brand kit

The mark is a **coin split into two arcs** — one gold, one green. The two arcs are
the two signatures the vault needs: the agent asks, the human signs. Nothing is
released with one. The check inside is the approval.

That is the whole idea: a payment that cannot complete alone.

## Files

| File | Use it for |
|---|---|
| `deliverables/profile-400.png` | **X / GitHub / Zoho profile picture** (400×400, what X asks for) |
| `deliverables/profile-1024.png` | Master square, upload anywhere that wants bigger |
| `deliverables/profile-128.png` | Fallback tiny |
| `deliverables/x-banner-1500x500.png` | X header image (exact X size) |
| `deliverables/og-image-1200x630.png` | Link previews — also live at `https://paydlux.com/og-image.png` |
| `deliverables/mark-color.svg` | The mark, scalable, for docs and slides |
| `deliverables/mark-ink.svg` | One-colour dark, for print / invoices / white paper |
| `deliverables/mark-reversed.svg` | One-colour light, for dark backgrounds |
| `deliverables/mark-transparent.svg` | No tile, for overlays |
| `deliverables/logo-lockup.svg` | Mark + wordmark + tagline, horizontal |
| `out/a-coin-check.png` | 512px raster of the master mark |

## Rules (keep it consistent)

- Dark tile background: `#0d0f0e`. Never put the colour mark on a light photo.
- Gold `#e8b04b` = the money. Green `#5fbf8b` = the human approval. Keep that meaning.
- Wordmark: `Pay` in ink/paper, `dlux` in gold. Serif face (Instrument Serif on the site).
- Minimum size for the mark: 24px on screen, 6mm in print. Below that use the
  transparent version without the tile.
- Never recolour the arcs to the same hue except in the one-colour versions.
- Clear space: keep at least the height of the check mark empty around the tile.

## Regenerate everything

```
python3 make_logos.py     # writes out/*.svg
python3 compose.py        # writes deliverables/*.png  (needs Pillow)
```

`compose.py` runs on the Hermes venv python (has Pillow):
`$(ls /Users/z-b/.hermes/installs/*/environments/*/venv/bin/python3 | head -1) compose.py`
