"""
Generates high-resolution commercial NSIS installer graphics, icons, and license file
for the Smart Xerox Windows Desktop Application installer (SmartXerox-Setup.exe):
- build/installerSidebar.bmp   (164 x 314, 24-bit RGB BMP — Welcome & Complete screens)
- build/uninstallerSidebar.bmp (164 x 314, 24-bit RGB BMP — Uninstaller screens)
- build/installerHeader.bmp    (150 x 57,  24-bit RGB BMP — Wizard step header)
- build/icon.png               (512 x 512, 32-bit RGBA PNG — App & Tray icon)
- build/icon.ico               (Multi-size 256..16 Windows ICO)
- build/LICENSE.txt            (Screen 2 License & Product Information)
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

BUILD_DIR = Path(__file__).resolve().parent.parent / "build"
BUILD_DIR.mkdir(parents=True, exist_ok=True)


def load_font(size: int, bold: bool = False):
    candidates = (
        ["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/calibrib.ttf"]
        if bold
        else ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/calibri.ttf"]
    )
    for fp in candidates:
        if Path(fp).exists():
            try:
                return ImageFont.truetype(fp, size)
            except Exception:
                pass
    return ImageFont.load_default()


def draw_printer_emblem(draw: ImageDraw.ImageDraw, cx: int, cy: int, scale: float = 1.0, bg_fill=(141, 1, 0), fg_fill=(255, 255, 255)):
    """Draws the Smart Xerox geometric printer emblem centered at (cx, cy)."""
    r = int(28 * scale)
    draw.rounded_rectangle(
        [cx - r, cy - r, cx + r, cy + r],
        radius=int(10 * scale),
        fill=bg_fill,
    )
    # Top paper tray
    pw = int(12 * scale)
    ph = int(8 * scale)
    draw.rounded_rectangle(
        [cx - pw, cy - int(17 * scale), cx + pw, cy - int(5 * scale)],
        radius=max(1, int(2 * scale)),
        outline=fg_fill,
        width=max(2, int(2.5 * scale)),
    )
    # Printer body
    bw = int(18 * scale)
    draw.rounded_rectangle(
        [cx - bw, cy - int(6 * scale), cx + bw, cy + int(9 * scale)],
        radius=max(2, int(4 * scale)),
        fill=fg_fill,
    )
    # Status LED dot inside printer body
    led_r = max(1, int(2 * scale))
    draw.ellipse(
        [cx + int(10 * scale) - led_r, cy - int(1 * scale) - led_r, cx + int(10 * scale) + led_r, cy - int(1 * scale) + led_r],
        fill=bg_fill,
    )
    # Output sheet with text lines
    draw.rounded_rectangle(
        [cx - pw, cy + int(4 * scale), cx + pw, cy + int(18 * scale)],
        radius=max(1, int(2 * scale)),
        fill=fg_fill,
        outline=bg_fill,
        width=max(1, int(1.5 * scale)),
    )
    line_w = int(7 * scale)
    for ly in (9, 13):
        y_pos = cy + int(ly * scale)
        draw.line(
            [cx - line_w, y_pos, cx + line_w, y_pos],
            fill=bg_fill,
            width=max(1, int(1.8 * scale)),
        )


def generate_app_icons():
    size = 512
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Outer crimson badge with subtle dark border
    draw.rounded_rectangle([16, 16, 496, 496], radius=108, fill=(141, 1, 0, 255))
    draw.rounded_rectangle([24, 24, 488, 488], radius=100, outline=(185, 35, 30, 255), width=6)

    draw_printer_emblem(draw, 256, 256, scale=8.2, bg_fill=(141, 1, 0), fg_fill=(255, 255, 255))

    png_path = BUILD_DIR / "icon.png"
    ico_path = BUILD_DIR / "icon.ico"
    img.save(png_path, format="PNG")
    img.save(
        ico_path,
        format="ICO",
        sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)],
    )
    print(f"Generated {png_path} and {ico_path}")


def generate_sidebar_bmp(filename: str, subtitle_badge: str = "WINDOWS VENDOR EDITION"):
    w, h = 164, 314
    img = Image.new("RGB", (w, h), (22, 22, 26))
    draw = ImageDraw.Draw(img)

    # Smooth vertical dark-crimson gradient background
    for y in range(h):
        t = y / float(h - 1)
        r = int(115 * (1 - t) + 22 * t)
        g = int(6 * (1 - t) + 18 * t)
        b = int(8 * (1 - t) + 24 * t)
        draw.line([(0, y), (w, y)], fill=(r, g, b))

    # Top accent bar & subtle architectural grid lines
    draw.rectangle([0, 0, w, 5], fill=(210, 38, 36))
    draw.line([(16, 220), (w - 16, 220)], fill=(90, 35, 35), width=1)
    draw.line([(w - 1, 0), (w - 1, h)], fill=(60, 25, 25), width=1)

    # Brand Emblem
    draw_printer_emblem(draw, 44, 52, scale=1.05, bg_fill=(165, 12, 10), fg_fill=(255, 255, 255))

    font_title = load_font(16, bold=True)
    font_tag = load_font(10, bold=True)
    font_body = load_font(9, bold=False)
    font_small = load_font(8, bold=False)

    draw.text((16, 94), "SMART XEROX", fill=(255, 255, 255), font=font_title)
    draw.text((16, 115), "Smart Printing. Simplified.", fill=(248, 195, 190), font=font_tag)

    # Feature pills
    features = [
        "• Instant QR Shop Printing",
        "• Universal Printer Engine",
        "• Isolated Cloud Queue",
        "• Zero-Setup Python Agent",
        "• DPAPI Encrypted Session",
    ]
    y_cur = 142
    for feat in features:
        draw.text((16, y_cur), feat, fill=(228, 228, 234), font=font_body)
        y_cur += 14

    # Bottom badge
    draw.rounded_rectangle([16, 234, w - 16, 254], radius=5, fill=(141, 1, 0))
    draw.text((22, 239), subtitle_badge, fill=(255, 255, 255), font=font_small)

    draw.text((16, 268), "Version 3.1 • Windows x64", fill=(185, 185, 195), font=font_small)
    draw.text((16, 282), "Windows 10 & Windows 11", fill=(155, 155, 165), font=font_small)
    draw.text((16, 296), "© 2026 Smart Xerox Platform", fill=(130, 130, 140), font=font_small)

    out_path = BUILD_DIR / filename
    img.save(out_path, format="BMP")
    print(f"Generated {out_path} ({w}x{h} 24-bit BMP)")


def generate_header_bmp():
    w, h = 150, 57
    img = Image.new("RGB", (w, h), (255, 255, 255))
    draw = ImageDraw.Draw(img)

    # Clean bottom accent border
    draw.line([(0, h - 2), (w, h - 2)], fill=(141, 1, 0), width=2)

    # Emblem on the right side
    draw_printer_emblem(draw, w - 26, h // 2 - 1, scale=0.68, bg_fill=(141, 1, 0), fg_fill=(255, 255, 255))

    font_brand = load_font(10, bold=True)
    font_sub = load_font(8, bold=False)
    draw.text((10, 14), "SMART XEROX", fill=(24, 24, 27), font=font_brand)
    draw.text((10, 29), "Print Console v3.1", fill=(113, 113, 122), font=font_sub)

    out_path = BUILD_DIR / "installerHeader.bmp"
    img.save(out_path, format="BMP")
    print(f"Generated {out_path} ({w}x{h} 24-bit BMP)")


def generate_license_file():
    license_text = """SMART XEROX — VENDOR DESKTOP CONSOLE & PRINT AGENT (v3.1)
"Smart Printing. Simplified."
========================================================================

1. PRODUCT OVERVIEW
Smart Xerox is a commercial Multi-Vendor Instant QR Printing Platform for
Windows 10 and Windows 11. This installation package includes:
  • Smart Xerox Vendor Desktop Console (Electron Desktop Application)
  • Self-Contained Python 3.13 Print Agent Runtime (PyMuPDF, Pillow, pywin32)
  • Universal Windows Print Spooler & USB Hardware Detection Engine
  • Windows DPAPI Encrypted Vendor Credential Store

No separate Node.js or Python installation is required on this computer.

2. LICENSE & AUTHORIZED USE
Copyright (c) 2026 Smart Xerox Platform. All rights reserved.

Permission is hereby granted to authorized Xerox and print shop vendors to
install and operate this software on Windows computers connected to their
shop printers for receiving and processing customer print jobs through the
Smart Xerox Cloud Platform.

3. DATA PRIVACY & MULTI-VENDOR SECURITY
  • Every vendor account operates in an isolated tenant environment.
  • Vendor login tokens and print agent credentials are encrypted locally
    using Windows Data Protection API (DPAPI / Electron safeStorage).
  • Customer documents are streamed over HTTPS strictly to the authorized
    shop's paired print agent, verified by SHA-256 checksum, and cleaned up
    automatically after printing.

4. PRINTER DRIVER REQUIREMENT
Smart Xerox supports USB, Wi-Fi, Network, and Shared printers from HP, Canon,
Epson, Brother, Xerox, Ricoh, Kyocera, Samsung, Pantum, Lexmark, and other
Windows-compatible manufacturers, provided the official Windows printer
driver is installed and recognized by the Windows Print Spooler.
"""
    lic_path = BUILD_DIR / "LICENSE.txt"
    lic_path.write_text(license_text, encoding="utf-8")
    print(f"Generated {lic_path}")


if __name__ == "__main__":
    generate_app_icons()
    generate_sidebar_bmp("installerSidebar.bmp", "VENDOR DESKTOP SUITE")
    generate_sidebar_bmp("uninstallerSidebar.bmp", "UNINSTALL WIZARD")
    generate_header_bmp()
    generate_license_file()
