"""Renders the setup / instruction poster for Pocket Server 1.9.1.

One photo, six numbered steps: install, open the panel, unlock, publish a site,
create the PocketBase account, and (optionally) go public. Same brand language as
the promo poster, no author credit and no device model.

Run: python3 scripts/make-guide-poster.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "assets/brand/logo-source.png"
FONTS = ROOT / "assets/fonts"
OUT = ROOT / "artifacts"

VERSION = "1.9.1"

INK = (11, 27, 42)
INK_DEEP = (16, 38, 58)
CARD = (18, 43, 65, 205)
HAIRLINE = (150, 182, 208, 26)
WHITE = (248, 250, 252, 255)
MUTED = (156, 178, 198, 255)
DIM = (124, 147, 168, 255)
EMERALD = (16, 185, 129, 255)
MINT = (52, 211, 153, 255)

STEPS = [
    ("Install the full APK", "Allow notifications and battery exemption"),
    ("Open the control panel", "127.0.0.1:8080 \u00b7 LAN address on a PC"),
    ("Unlock with the PIN", "Default 1234 \u2014 change it in Security"),
    ("Upload your website", "Files tab \u00b7 live on http://<phone>:8090"),
    ("Create the superuser", "PocketBase admin at :8090/_/"),
    ("Go public, optional", "Tunnel \u00b7 Quick gives an HTTPS link"),
]

NOTE = "Keep the phone charging on Wi-Fi \u2014 the service restarts after a reboot."


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
    x = cx - (sum(widths) + tracking * (len(text) - 1)) / 2
    for ch, w in zip(text, widths):
        draw.text((x, cy), ch, font=face, fill=fill, anchor="lm")
        x += w + tracking


def number_badge(draw, cx, cy, radius, number, face):
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=(16, 185, 129, 30))
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], outline=(16, 185, 129, 210), width=2)
    draw.text((cx, cy), str(number), font=face, fill=MINT, anchor="mm")


def wrap(draw, text, face, max_width):
    lines, current = [], ""
    for word in text.split():
        trial = f"{current} {word}".strip()
        if not current or draw.textlength(trial, font=face) <= max_width:
            current = trial
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def render(width, height, layout):
    canvas = background(width, height, (width // 2, int(height * layout["glow_y"])))
    draw = ImageDraw.Draw(canvas)

    art = Image.open(ART).convert("RGBA")
    art = art.crop(art.getchannel("A").getbbox())
    logo_h = layout["logo_h"]
    logo_w = round(art.width * logo_h / art.height)
    logo = art.resize((logo_w, logo_h), Image.LANCZOS)
    canvas.alpha_composite(logo, ((width - logo_w) // 2, layout["logo_y"]))

    # Eyebrow with a live dot.
    eyebrow = display(layout["eyebrow"], "Medium")
    dot_r = max(3, layout["eyebrow"] // 5)
    label = "QUICK START \u00b7 6 STEPS"
    tracking = layout["tracking"]
    label_w = sum(draw.textlength(ch, font=eyebrow) for ch in label) + tracking * (len(label) - 1)
    dot_cy = layout["eyebrow_y"]
    start = width / 2 - (label_w + dot_r * 2 + 14) / 2
    draw.ellipse([start, dot_cy - dot_r, start + dot_r * 2, dot_cy + dot_r], fill=MINT)
    tracked(draw, width / 2 + (dot_r * 2 + 14) / 2, dot_cy, label, eyebrow, (125, 211, 190, 255), tracking)

    # Headline.
    head = display(layout["headline"], "Bold")
    for index, line in enumerate(layout["headline_lines"]):
        draw.text((width / 2, layout["headline_y"] + index * layout["headline_lh"]), line, font=head, fill=WHITE, anchor="mm")

    # Steps card.
    card_x, card_y = layout["card_x"], layout["card_y"]
    card_w = width - card_x * 2
    row_h, card_pad = layout["row_h"], layout["card_pad"]
    card_h = row_h * len(STEPS) + card_pad * 2
    card = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    pen = ImageDraw.Draw(card)
    pen.rounded_rectangle([card_x, card_y, card_x + card_w, card_y + card_h], radius=34, fill=CARD)
    pen.rounded_rectangle(
        [card_x + 0.5, card_y + 0.5, card_x + card_w - 0.5, card_y + card_h - 0.5], radius=34, outline=HAIRLINE, width=2
    )
    canvas.alpha_composite(card)
    draw = ImageDraw.Draw(canvas)

    pad_x = layout["row_pad"]
    title_face = body(layout["row_text"], "SemiBold")
    hint_face = body(layout["row_hint"], "Regular")
    badge_r = round(layout["row_text"] * 0.72)
    number_face = display(layout["number"], "Bold")
    for index, (title, hint) in enumerate(STEPS):
        cy = card_y + card_pad + row_h * index + row_h / 2
        number_badge(draw, card_x + pad_x + badge_r, cy, badge_r, index + 1, number_face)
        text_x = card_x + pad_x + badge_r * 2 + 26
        draw.text((text_x, cy - layout["title_offset"]), title, font=title_face, fill=(234, 242, 249, 255), anchor="lm")
        draw.text((text_x, cy + layout["hint_offset"]), hint, font=hint_face, fill=MUTED, anchor="lm")
        if index:
            y = card_y + card_pad + row_h * index
            draw.line([(card_x + pad_x, y), (card_x + card_w - pad_x, y)], fill=HAIRLINE, width=2)

    # Closing note.
    note_face = body(layout["note"], "Regular")
    note_y = card_y + card_h + layout["note_gap"]
    for index, line in enumerate(wrap(draw, NOTE, note_face, width - 220)):
        draw.text((width / 2, note_y + index * layout["note_lh"]), line, font=note_face, fill=DIM, anchor="mm")

    name_face = mono(layout["name"], "Regular")
    draw.text(
        (width / 2, note_y + layout["note_lh"] * (len(wrap(draw, NOTE, note_face, width - 220)) - 1) + layout["name_gap"]),
        f"Pocket Server {VERSION}",
        font=name_face,
        fill=(120, 150, 172, 255),
        anchor="mm",
    )

    return canvas.convert("RGB")


PORTRAIT = dict(
    glow_y=0.22,
    logo_h=118,
    logo_y=96,
    eyebrow=23,
    eyebrow_y=258,
    tracking=5,
    headline=56,
    headline_lines=["Your own server", "in six steps"],
    headline_y=338,
    headline_lh=64,
    card_x=92,
    card_y=472,
    card_pad=26,
    row_h=100,
    row_pad=42,
    row_text=30,
    row_hint=21,
    number=22,
    title_offset=13,
    hint_offset=18,
    note=22,
    note_gap=48,
    note_lh=32,
    name=21,
    name_gap=58,
)

SQUARE = dict(
    glow_y=0.18,
    logo_h=104,
    logo_y=58,
    eyebrow=20,
    eyebrow_y=196,
    tracking=4,
    headline=46,
    headline_lines=["Your own server", "in six steps"],
    headline_y=252,
    headline_lh=50,
    card_x=84,
    card_y=342,
    card_pad=22,
    row_h=84,
    row_pad=38,
    row_text=26,
    row_hint=18,
    number=19,
    title_offset=11,
    hint_offset=16,
    note=19,
    note_gap=40,
    note_lh=27,
    name=18,
    name_gap=48,
)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, size, layout in (
        ("guide-1.9.1-portrait-1080x1350.png", (1080, 1350), PORTRAIT),
        ("guide-1.9.1-square-1080x1080.png", (1080, 1080), SQUARE),
    ):
        poster = render(*size, layout)
        path = OUT / name
        poster.save(path)
        print(f"{path.relative_to(ROOT)} {poster.width}x{poster.height}")


if __name__ == "__main__":
    main()
