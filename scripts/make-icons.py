"""Generates every Pocket Server brand asset from the original artwork.

Source of truth: assets/brand/logo-source.png (the designer's export, RGBA with a
transparent background). One resample routine feeds the launcher icons, the
adaptive foreground, the splash screens and the web logo, so nothing drifts.

Run: python3 scripts/make-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "android/app/src/main/res"
SOURCE = ROOT / "assets/brand/logo-source.png"

ART = Image.open(SOURCE).convert("RGBA")
ART = ART.crop(ART.getchannel("A").getbbox())  # drop the empty margin
ART_RATIO = ART.width / ART.height

LAUNCHER_BG = (255, 255, 255, 255)
SPLASH_BG = (245, 248, 251, 255)


def art_at_height(height):
    """The artwork scaled to a pixel height, keeping its aspect ratio."""
    height = max(1, int(round(height)))
    width = max(1, int(round(height * ART_RATIO)))
    return ART.resize((width, height), Image.LANCZOS)


def centred(canvas_size, height_ratio, background=None):
    """Square canvas with the artwork centred at height_ratio of its height."""
    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    if background is not None:
        canvas.paste(Image.new("RGBA", canvas.size, background), (0, 0))
    art = art_at_height(canvas_size * height_ratio)
    canvas.alpha_composite(art, ((canvas_size - art.width) // 2, (canvas_size - art.height) // 2))
    return canvas


def save(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)
    print(f"{path.relative_to(ROOT)} {image.width}x{image.height}")


def main():
    if not SOURCE.exists():
        raise SystemExit(f"Missing brand artwork: {SOURCE}")

    # Web: header badge, lock screen logo and browser icons.
    save(centred(512, 0.98), ROOT / "public/logo.png")
    save(centred(192, 0.84, LAUNCHER_BG), ROOT / "public/icon-192.png")
    save(centred(64, 0.84, LAUNCHER_BG), ROOT / "public/favicon.png")

    # Launcher icons. The art is a tall phone, so it is sized by height and the
    # white square around it becomes the icon background.
    for density, size in (
        ("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192),
    ):
        folder = RES / f"mipmap-{density}"
        square = centred(size, 0.86, LAUNCHER_BG)
        save(square, folder / "ic_launcher.png")

        big = 4  # crop the circle at 4x so the edge stays smooth
        round_icon = square.resize((size * big, size * big), Image.LANCZOS)
        mask = Image.new("L", round_icon.size, 0)
        ImageDraw.Draw(mask).ellipse([0, 0, round_icon.size[0] - 1, round_icon.size[1] - 1], fill=255)
        round_icon.putalpha(mask)
        save(round_icon.resize((size, size), Image.LANCZOS), folder / "ic_launcher_round.png")

        # Adaptive foreground: transparent, art kept inside the 66/108 safe zone.
        save(centred(int(size * 2.25), 0.50), folder / "ic_launcher_foreground.png")

    # Splash screens keep their existing pixel sizes so the launcher theme still fits.
    for splash in sorted(RES.glob("drawable*/splash.png")):
        width, height = Image.open(splash).size
        canvas = Image.new("RGBA", (width, height), SPLASH_BG)
        art = art_at_height(min(width, height) * 0.42)
        canvas.alpha_composite(art, ((width - art.width) // 2, (height - art.height) // 2))
        canvas.convert("RGB").save(splash)
        print(f"{splash.relative_to(ROOT)} {width}x{height}")


if __name__ == "__main__":
    main()
