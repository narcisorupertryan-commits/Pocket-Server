"""Renders the single-photo social poster for Pocket Server 1.9.1.

Two sizes, same layout language: 1080x1350 (feed portrait) and 1080x1080 (square).
Everything is drawn from the real brand artwork and the real shipped feature set.

Run: python3 scripts/make-poster.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "assets/brand/logo-source.png"
FONTS = ROOT / "assets/fonts"
OUT = ROOT / "artifacts"

VERSION = "1.9.1"

INK = (11, 27, 42)          # gradient top
INK_DEEP = (16, 38, 58)     # gradient bottom
CARD = (18, 43, 65, 205)
HAIRLINE = (150, 182, 208, 26)
WHITE = (248, 250, 252, 255)
MUTED = (156, 178, 198, 255)
DIM = (124, 147, 168, 255)
EMERALD = (16, 185, 129, 255)
MINT = (52, 211, 153, 255)

ROWS = [
    ("Host a website", ":8090"),
    ("Real database", "SQLite"),
    ("Public HTTPS link", "cloudflared"),
    ("Nightly backups", "\u00d77 kept"),
    ("File integrity", "SHA-256"),
]


def font(path, size, instance):
    face = ImageFont.truetype(str(path), size)
    try:
        face.set_variation_by_name(instance)
    except Exception:
        pass
    return face


def display(size, weight="Bold"):
    return font(FONTS / "SpaceGrotesk.ttf", size, weight)


def body(size, weight="Regular"):
    return font(FONTS / "Inter.ttf", size, weight)


def mono(size, weight="Regular"):
    return font(FONTS / "JetBrainsMono.ttf", size, weight)


def background(width, height, glow_centre):
    """Vertical gradient plus a soft emerald bloom behind the artwork."""
    base = Image.new("RGBA", (width, height))
    draw = ImageDraw.Draw(base)
    for y in range(height):
        t = y / max(1, height - 1)
        draw.line(
            [(0, y), (width, y)],
            fill=(
                round(INK[0] + (INK_DEEP[0] - INK[0]) * t),
                round(INK[1] + (INK_DEEP[1] - INK[1]) * t),
                round(INK[2] + (INK_DEEP[2] - INK[2]) * t),
                255,
            ),
        )

    cx, cy = glow_centre
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    pen = ImageDraw.Draw(glow)
    for radius in range(620, 0, -8):
        alpha = int(26 * (1 - radius / 620) ** 2)
        pen.ellipse([cx - radius, cy - radius * 0.9, cx + radius, cy + radius * 0.9], fill=(16, 185, 129, alpha))
    base.alpha_composite(glow.filter(ImageFilter.GaussianBlur(70)))
    return base


def tracked(draw, cx, cy, text, face, fill, tracking):
    widths = [draw.textlength(ch, font=face) for ch in text]
    total = sum(widths) + tracking * (len(text) - 1)
    x = cx - total / 2
    for ch, w in zip(text, widths):
        draw.text((x, cy), ch, font=face, fill=fill, anchor="lm")
        x += w + tracking
    return total


def check_badge(draw, cx, cy, radius):
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=EMERALD)
    draw.line(
        [(cx - radius * 0.42, cy + radius * 0.04), (cx - radius * 0.10, cy + radius * 0.36), (cx + radius * 0.48, cy - radius * 0.36)],
        fill=(6, 32, 46, 255),
        width=max(3, round(radius * 0.28)),
        joint="curve",
    )


def render(width, height, layout):
    canvas = background(width, height, (width // 2, int(height * layout["glow_y"])))
    draw = ImageDraw.Draw(canvas)

    # Artwork.
    art = Image.open(ART).convert("RGBA")
    art = art.crop(art.getchannel("A").getbbox())
    logo_h = layout["logo_h"]
    logo_w = round(art.width * logo_h / art.height)
    logo = art.resize((logo_w, logo_h), Image.LANCZOS)
    canvas.alpha_composite(logo, ((width - logo_w) // 2, layout["logo_y"]))

    # Eyebrow.
    eyebrow = display(layout["eyebrow"], "Medium")
    dot_r = max(4, layout["eyebrow"] // 5)
    label = "ANDROID \u00b7 SELF-HOSTED"
    tracking = layout["tracking"]
    label_w = sum(draw.textlength(ch, font=eyebrow) for ch in label) + tracking * (len(label) - 1)
    start = width / 2 - (label_w + dot_r * 2 + 14) / 2
    dot_cy = layout["eyebrow_y"]
    draw.ellipse([start, dot_cy - dot_r, start + dot_r * 2, dot_cy + dot_r], fill=MINT)
    tracked(draw, width / 2 + (dot_r * 2 + 14) / 2, dot_cy, label, eyebrow, (125, 211, 190, 255), tracking)

    # Headline.
    head = display(layout["headline"], "Bold")
    for index, line in enumerate(layout["headline_lines"]):
        draw.text(
            (width / 2, layout["headline_y"] + index * layout["headline_lh"]),
            line,
            font=head,
            fill=WHITE,
            anchor="mm",
        )

    # Subhead.
    sub = body(layout["sub"], "Regular")
    for index, line in enumerate(layout["sub_lines"]):
        draw.text((width / 2, layout["sub_y"] + index * layout["sub_lh"]), line, font=sub, fill=MUTED, anchor="mm")

    # Feature card. The height comes from the rows so the padding stays symmetric.
    card_x, card_y = layout["card_x"], layout["card_y"]
    card_w = width - card_x * 2
    card_pad = layout["card_pad"]
    row_h = layout["row_h"]
    card_h = row_h * len(ROWS) + card_pad * 2
    card = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    card_pen = ImageDraw.Draw(card)
    card_pen.rounded_rectangle([card_x, card_y, card_x + card_w, card_y + card_h], radius=34, fill=CARD)
    card_pen.rounded_rectangle(
        [card_x + 0.5, card_y + 0.5, card_x + card_w - 0.5, card_y + card_h - 0.5],
        radius=34,
        outline=HAIRLINE,
        width=2,
    )
    canvas.alpha_composite(card)
    draw = ImageDraw.Draw(canvas)

    pad_x = layout["row_pad"]
    label_face = body(layout["row_text"], "Medium")
    hint_face = mono(layout["row_hint"], "Regular")
    badge_r = round(layout["row_text"] * 0.52)
    for index, (name, hint) in enumerate(ROWS):
        cy = card_y + card_pad + row_h * index + row_h / 2
        check_badge(draw, card_x + pad_x + badge_r, cy, badge_r)
        draw.text((card_x + pad_x + badge_r * 2 + 26, cy), name, font=label_face, fill=(232, 240, 247, 255), anchor="lm")
        draw.text((card_x + card_w - pad_x, cy), hint, font=hint_face, fill=DIM, anchor="rm")
        if index:
            y = card_y + card_pad + row_h * index
            draw.line([(card_x + pad_x, y), (card_x + card_w - pad_x, y)], fill=HAIRLINE, width=2)

    # Footer, hung off the card so every size keeps the same rhythm.
    footer_y = card_y + card_h + layout["footer_gap"]
    name_y = footer_y + layout["name_gap"]
    foot = mono(layout["footer"], "Regular")
    draw.text(
        (width / 2, footer_y),
        "ports 8090 / 8080   \u00b7   PIN locked   \u00b7   works offline",
        font=foot,
        fill=DIM,
        anchor="mm",
    )
    name_face = body(layout["credit"], "SemiBold")
    draw.text((width / 2, name_y), f"Pocket Server {VERSION}", font=name_face, fill=(214, 230, 242, 255), anchor="mm")

    return canvas.convert("RGB")


PORTRAIT = dict(
    glow_y=0.24,
    logo_h=202,
    logo_y=128,
    eyebrow=25,
    eyebrow_y=372,
    tracking=5,
    headline=88,
    headline_lines=["Your phone", "is the server."],
    headline_y=452,
    headline_lh=95,
    sub=31,
    sub_lines=["PocketBase + Node.js on Android \u2014", "no VPS, no monthly bill."],
    sub_y=648,
    sub_lh=44,
    card_x=92,
    card_y=748,
    card_pad=26,
    row_h=68,
    row_pad=46,
    row_text=33,
    row_hint=23,
    footer=24,
    footer_gap=58,
    credit=26,
    name_gap=48,
)

SQUARE = dict(
    glow_y=0.20,
    logo_h=150,
    logo_y=74,
    eyebrow=21,
    eyebrow_y=264,
    tracking=4,
    headline=72,
    headline_lines=["Your phone", "is the server."],
    headline_y=322,
    headline_lh=78,
    sub=27,
    sub_lines=["PocketBase + Node.js on Android \u2014", "no VPS, no monthly bill."],
    sub_y=478,
    sub_lh=38,
    card_x=84,
    card_y=548,
    card_pad=24,
    row_h=58,
    row_pad=42,
    row_text=28,
    row_hint=20,
    footer=21,
    footer_gap=52,
    credit=23,
    name_gap=44,
)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size, layout in (
        ("poster-1.9.1-portrait-1080x1350.png", (1080, 1350), PORTRAIT),
        ("poster-1.9.1-square-1080x1080.png", (1080, 1080), SQUARE),
    ):
        poster = render(*size, layout)
        path = OUT / name
        poster.save(path, quality=95)
        print(f"{path.relative_to(ROOT)} {poster.width}x{poster.height}")


if __name__ == "__main__":
    main()
