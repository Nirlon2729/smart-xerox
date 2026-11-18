from pathlib import Path
from PIL import Image, ImageDraw

build_dir = Path(__file__).resolve().parent.parent / "build"
build_dir.mkdir(parents=True, exist_ok=True)

size = 256
img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Crimson rounded background (#8D0100)
draw.rounded_rectangle([(12, 12), (244, 244)], radius=52, fill=(141, 1, 0, 255))

# Top paper sheet feeding into printer
draw.rounded_rectangle([(76, 44), (180, 110)], radius=8, fill=(255, 255, 255, 255))

# Printer main body
draw.rounded_rectangle([(46, 96), (210, 178)], radius=20, fill=(255, 255, 255, 255))
draw.rounded_rectangle([(56, 106), (200, 168)], radius=14, fill=(141, 1, 0, 255))

# Status LED indicator dot
draw.ellipse([(172, 118), (186, 132)], fill=(52, 211, 153, 255))

# Printed document emerging at bottom
draw.rounded_rectangle([(72, 146), (184, 214)], radius=8, fill=(255, 255, 255, 255))

# Printed lines on document
draw.rounded_rectangle([(90, 164), (166, 172)], radius=3, fill=(141, 1, 0, 255))
draw.rounded_rectangle([(90, 180), (150, 188)], radius=3, fill=(141, 1, 0, 180))
draw.rounded_rectangle([(90, 196), (138, 202)], radius=3, fill=(141, 1, 0, 140))

png_path = build_dir / "icon.png"
ico_path = build_dir / "icon.ico"

img.save(png_path, format="PNG")
img.save(
    ico_path,
    format="ICO",
    sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
)
print(f"Generated {png_path} and {ico_path}")
