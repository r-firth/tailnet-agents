"""Compile the existing orthogonal pixel SVG into crisp PWA launcher icons."""

import re
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def polygons(path):
    tokens = re.findall(r"[A-Za-z]|-?\d+(?:\.\d+)?", path)
    points = []
    x = y = 0
    while tokens:
        command = tokens.pop(0)
        if command == "M":
            x, y = float(tokens.pop(0)), float(tokens.pop(0))
            points = [(x, y)]
        elif command in "Hh":
            value = float(tokens.pop(0))
            x = value if command == "H" else x + value
            points.append((x, y))
        elif command in "Vv":
            value = float(tokens.pop(0))
            y = value if command == "V" else y + value
            points.append((x, y))
        elif command in "Zz":
            yield points
        else:
            raise ValueError(f"The pixel logo uses an unsupported command: {command}")


def inside(x, y, points):
    crosses = 0
    for (ax, ay), (bx, by) in zip(points, points[1:] + points[:1]):
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            crosses += 1
    return crosses % 2


logo = Image.new("RGBA", (32, 32))
for path in ET.parse(ROOT / "web/src/assets/mark.svg").getroot():
    color = path.attrib["fill"]
    for points in polygons(path.attrib["d"]):
        for y in range(32):
            for x in range(32):
                if inside(x + 0.5, y + 0.5, points):
                    logo.putpixel((x, y), (*bytes.fromhex(color[1:]), 255))

output = ROOT / "web/public/icons"
output.mkdir(exist_ok=True)
for name, size, scale in [
    ("hub-192.png", 192, 5),
    ("hub-512.png", 512, 14),
    ("hub-maskable-512.png", 512, 10),
    ("apple-touch-icon.png", 180, 4),
]:
    image = Image.new("RGB", (size, size), "#101011")
    glyph = logo.resize((32 * scale, 32 * scale), Image.Resampling.NEAREST)
    inset = (size - glyph.width) // 2
    image.paste(glyph, (inset, inset), glyph)
    image.save(output / name, optimize=True)
    print(name)
