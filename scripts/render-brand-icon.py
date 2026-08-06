"""Render the code-native LeagueVid mark into Windows-ready image assets."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
RESOURCES = ROOT / "resources"
SCALE = 16


def scaled_points(points: list[tuple[float, float]]) -> list[tuple[int, int]]:
    return [(round(x * SCALE), round(y * SCALE)) for x, y in points]


canvas = Image.new("RGBA", (64 * SCALE, 64 * SCALE), (0, 0, 0, 0))
draw = ImageDraw.Draw(canvas)

draw.rounded_rectangle(
    (2 * SCALE, 2 * SCALE, 62 * SCALE, 62 * SCALE),
    radius=13 * SCALE,
    fill="#170f28",
)

draw.polygon(
    scaled_points([(6, 10), (17.3, 10), (17.3, 44.3), (25.5, 39.8), (33.3, 54), (6, 54)]),
    fill="#9b4dff",
)
draw.polygon(
    scaled_points(
        [
            (20.3, 22.4),
            (32.9, 22.4),
            (39.9, 36.4),
            (46.8, 22.4),
            (58, 22.4),
            (41.5, 54),
            (38.2, 54),
            (29.2, 37.7),
            (34.5, 34.4),
            (22.9, 27.5),
        ]
    ),
    fill="#ff3ec8",
)
draw.polygon(scaled_points([(17.25, 21.5), (34.55, 34.45), (17.25, 45)]), fill="#170f28")

png_path = RESOURCES / "icon.png"
ico_path = RESOURCES / "icon.ico"
canvas.save(png_path, optimize=True)
canvas.save(
    ico_path,
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)

print(png_path)
print(ico_path)
