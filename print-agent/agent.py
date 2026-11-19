"""
Smart Xerox — Universal Multi-Vendor Windows Background Print Agent (v3.1.0)

Features:
- Universal multi-brand Windows printer discovery via pywin32 (HP, Canon, Epson, Brother, Samsung, Xerox,
  Ricoh, Kyocera, Pantum, Lexmark, Konica Minolta, Sharp, Toshiba, OKI, Dell, Zebra, and any Windows driver).
- Distinguishes PHYSICAL, VIRTUAL, and UNKNOWN printers using Windows driver, port, and attribute metadata.
- Excludes virtual printers (Microsoft Print to PDF, XPS, OneNote, Fax, PDF writers) by default while supporting
  an advanced option (`--include-virtual` / `virtualPrinters`) for diagnostics.
- Dynamically reads capabilities (Paper sizes, Colour/B&W, Duplex/Single-sided, Orientations, Max Copies, DPI)
  from the Windows printer driver via DeviceCapabilities and DEVMODE, with safe fallbacks and `*Known` flags.
- Preserves vendor's selected printer across restarts and when new printers are connected; auto-selects only when
  no printer is selected and exactly 1 usable physical printer is detected.
- Authenticates with unique, revocable per-agent credentials (x-agent-id + x-agent-secret).
- Claims tenant-isolated QUEUED print jobs, streams documents from MongoDB Atlas GridFS, verifies SHA-256,
  validates job settings against printer capabilities, renders pages at 300 DPI with PyMuPDF / Pillow,
  prints via Windows GDI, and waits for Windows Spooler confirmation.
"""

import os
import re
import sys
import time
import json
import ctypes
import winreg
import socket
import platform
import argparse
import hashlib
import logging
import tempfile
from ctypes import wintypes
from pathlib import Path
from dotenv import load_dotenv
import requests

try:
    import pymupdf as fitz
except ImportError:
    import fitz
from PIL import Image, ImageOps, ImageWin

import win32print
import win32ui
import win32con

AGENT_VERSION = "3.1.0"

# Virtual printer driver/name keywords
VIRTUAL_PRINTER_KEYWORDS = (
    "microsoft print to pdf",
    "print to pdf",
    "xps document writer",
    "microsoft xps",
    "onenote",
    "send to onenote",
    "send to microsoft onenote",
    "microsoft shared fax",
    "adobe pdf",
    "foxit reader pdf",
    "foxit pdf",
    "pdfcreator",
    "cutepdf",
    "bullzip",
    "dopdf",
    "primopdf",
    "nitro pdf",
    "pdf24",
    "clawpdf",
    "universal document converter",
    "fineprint",
    "snagit",
    "evernote",
    "paperport",
    "actmask",
    "nova pdf",
    "novapdf",
    "biopdf",
    "win2pdf",
    "virtual printer",
)

# Virtual port prefixes / names in Windows Print Spooler
VIRTUAL_PORT_PATTERNS = (
    "PORTPROMPT:",
    "FILE:",
    "NUL:",
    "XPSPORT:",
    "SHRFAX:",
    "PROMPT:",
    "PDF",
    "ONENOTE",
    "FOXIT",
    "CUTEPDF",
    "BULLZIP",
    "PDFCREATOR",
    "NITRO",
    "DOPDF",
    "PRIMO",
)

# Known printer manufacturers and model prefixes (used for brand/model extraction; any unlisted brand is also supported dynamically)
KNOWN_PRINTER_BRANDS = [
    ("HP", ("hp ", "hewlett-packard", "hewlett packard", "laserjet", "deskjet", "officejet", "smart tank", "neverstop", "envy ", "pagewide", "designjet")),
    ("Canon", ("canon", "pixma", "imagerunner", "i-sensys", "maxify", "lbp", "imageclass", "ir-adv", "selphy")),
    ("Epson", ("epson", "ecotank", "workforce", "expression", "stylus", "aculaser", "surecolor", "l3110", "l3150", "l3210", "l3250", "l805", "m1100", "m2140")),
    ("Brother", ("brother", "hl-", "dcp-", "mfc-")),
    ("Samsung", ("samsung", "xpress", "proxpress", "scx-", "ml-", "clp-", "clx-")),
    ("Xerox", ("xerox", "phaser", "workcentre", "versalink", "altalink", "docuprint", "docucentre")),
    ("Ricoh", ("ricoh", "aficio", "sp ", "mp ", "im ")),
    ("Kyocera", ("kyocera", "ecosys", "taskalfa", "fs-")),
    ("Pantum", ("pantum",)),
    ("Lexmark", ("lexmark",)),
    ("Konica Minolta", ("konica", "minolta", "bizhub", "magicolor", "pagepro")),
    ("Sharp", ("sharp", "mx-", "ar-")),
    ("Toshiba", ("toshiba", "e-studio")),
    ("OKI", ("oki ", "okidata")),
    ("Dell", ("dell ",)),
    ("Zebra", ("zebra", "zd", "zt", "gk420", "gx420")),
    ("FujiFilm", ("fujifilm", "fuji xerox", "apeosport")),
    ("Panasonic", ("panasonic", "kx-")),
    ("Kodak", ("kodak",)),
    ("Microsoft", ("microsoft", "onenote")),
]

BASE_DIR = Path(__file__).resolve().parent
APPDATA_DIR = Path(os.getenv("APPDATA") or str(BASE_DIR)) / "SmartXerox"
try:
    APPDATA_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    APPDATA_DIR = BASE_DIR

LOG_FILE = APPDATA_DIR / "agent.log"
LEDGER_FILE = APPDATA_DIR / "completed_jobs.json"

# Canonical Windows DMPAPER constants
PAPER_SIZE_MAP = {
    "A4": getattr(win32con, "DMPAPER_A4", 9),
    "A3": getattr(win32con, "DMPAPER_A3", 8),
    "A5": getattr(win32con, "DMPAPER_A5", 11),
    "Letter": getattr(win32con, "DMPAPER_LETTER", 1),
    "Legal": getattr(win32con, "DMPAPER_LEGAL", 5),
    "B5": getattr(win32con, "DMPAPER_B5", 13),
    "Executive": getattr(win32con, "DMPAPER_EXECUTIVE", 7),
}

# Physical paper dimensions in millimeters (Portrait width x height)
PAPER_DIMENSIONS_MM = {
    "A4": (210.0, 297.0),
    "A3": (297.0, 420.0),
    "A5": (148.0, 210.0),
    "Letter": (215.9, 279.4),
    "Legal": (215.9, 355.6),
    "B5": (176.0, 250.0),
    "Executive": (184.15, 266.7),
}

# Standard paper sizes exposed to the customer & vendor configuration schemas
STANDARD_CUSTOMER_PAPER_SIZES = ("A4", "A3", "A5", "Letter", "Legal", "B5", "Executive")

# Windows Printer Status Bitmasks (winspool.h)
PRINTER_STATUS_PAUSED = 0x00000001
PRINTER_STATUS_ERROR = 0x00000002
PRINTER_STATUS_PENDING_DELETION = 0x00000004
PRINTER_STATUS_PAPER_JAM = 0x00000008
PRINTER_STATUS_PAPER_OUT = 0x00000010
PRINTER_STATUS_MANUAL_FEED = 0x00000020
PRINTER_STATUS_PAPER_PROBLEM = 0x00000040
PRINTER_STATUS_OFFLINE = 0x00000080
PRINTER_STATUS_IO_ACTIVE = 0x00000100
PRINTER_STATUS_BUSY = 0x00000200
PRINTER_STATUS_PRINTING = 0x00000400
PRINTER_STATUS_OUTPUT_BIN_FULL = 0x00000800
PRINTER_STATUS_NOT_AVAILABLE = 0x00001000
PRINTER_STATUS_WAITING = 0x00002000
PRINTER_STATUS_PROCESSING = 0x00004000
PRINTER_STATUS_INITIALIZING = 0x00008000
PRINTER_STATUS_WARMING_UP = 0x00010000
PRINTER_STATUS_TONER_LOW = 0x00020000
PRINTER_STATUS_NO_TONER = 0x00040000
PRINTER_STATUS_PAGE_PUNT = 0x00080000
PRINTER_STATUS_USER_INTERVENTION = 0x00100000
PRINTER_STATUS_OUT_OF_MEMORY = 0x00200000
PRINTER_STATUS_DOOR_OPEN = 0x00400000
PRINTER_STATUS_SERVER_UNKNOWN = 0x00800000

PRINTER_ATTRIBUTE_SHARED = 0x00000008
PRINTER_ATTRIBUTE_NETWORK = 0x00000010
PRINTER_ATTRIBUTE_LOCAL = 0x00000040
PRINTER_ATTRIBUTE_WORK_OFFLINE = 0x00000400
PRINTER_ATTRIBUTE_FAX = 0x00004000

# Windows DEVMODE Field Bitmasks
DM_ORIENTATION = 0x00000001
DM_PAPERSIZE = 0x00000002
DM_COPIES = 0x00000100
DM_COLOR = 0x00000800
DM_DUPLEX = 0x00001000

# Windows DeviceCapabilities indices
DC_PAPERS = 2
DC_DUPLEX = 7
DC_ENUMRESOLUTIONS = 13
DC_PAPERNAMES = 16
DC_ORIENTATION = 17
DC_COPIES = 18
DC_COLORDEVICE = 32

# Windows Job Status Bitmasks
JOB_STATUS_ERROR = 0x00000002
JOB_STATUS_OFFLINE = 0x00000020
JOB_STATUS_PAPEROUT = 0x00000040
JOB_STATUS_PRINTED = 0x00000080
JOB_STATUS_DELETED = 0x00000100
JOB_STATUS_COMPLETE = 0x00001000


def setup_logger(log_path: Path, quiet_stdout: bool = False) -> logging.Logger:
    handlers = [logging.FileHandler(log_path, encoding="utf-8")]
    if not quiet_stdout:
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=handlers,
        force=True,
    )
    return logging.getLogger("SmartXeroxAgent")


logger = logging.getLogger("SmartXeroxAgent")


def extract_brand_and_model(printer_name: str, driver_name: str = "") -> tuple[str, str]:
    """
    Extracts manufacturer (brand) and model name from a Windows printer name and driver name.
    Works for all major brands (HP, Canon, Epson, Brother, Samsung, Xerox, Ricoh, Kyocera, Pantum, Lexmark, etc.)
    and dynamically falls back to the first word of the printer/driver name for any other brand.
    """
    raw_name = (printer_name or "").strip()
    # Strip network share prefix like \\SERVER\Printer Name
    clean_name = re.sub(r"^\\\\[^\\]+\\", "", raw_name).strip()
    raw_driver = (driver_name or "").strip()
    combined_lower = f"{clean_name} {raw_driver}".lower()

    detected_brand = None
    for brand_label, patterns in KNOWN_PRINTER_BRANDS:
        for pat in patterns:
            if pat in combined_lower:
                detected_brand = brand_label
                break
        if detected_brand:
            break

    if not detected_brand:
        # Dynamically infer brand from first word if alphabetic and not generic
        tokens = re.split(r"[\s_\-]+", clean_name or raw_driver)
        first_token = tokens[0] if tokens else ""
        if (
            first_token
            and len(first_token) >= 2
            and first_token.lower() not in ("generic", "universal", "local", "network", "usb", "printer", "series", "class")
        ):
            detected_brand = first_token
        else:
            detected_brand = "Generic"

    model = clean_name
    if detected_brand and detected_brand != "Generic":
        # Remove leading brand prefix from model if redundant, e.g., "HP LaserJet M1005" -> "LaserJet M1005"
        brand_prefix_re = re.compile(rf"^{re.escape(detected_brand)}\s+", re.IGNORECASE)
        stripped = brand_prefix_re.sub("", clean_name).strip()
        if stripped:
            model = stripped

    return detected_brand, (model or clean_name or "Windows Printer")


def classify_printer_category(
    printer_name: str,
    driver_name: str = "",
    port_name: str = "",
    attributes: int = 0,
) -> tuple[str, bool]:
    """
    Classifies a Windows printer into ('PHYSICAL' | 'VIRTUAL' | 'UNKNOWN', is_virtual: bool).
    Uses driver name, printer name, port name, and Windows printer attributes.
    Never assumes a printer is physical merely because it contains a brand name.
    """
    name_lower = (printer_name or "").strip().lower()
    driver_lower = (driver_name or "").strip().lower()
    port_upper = (port_name or "").strip().upper()

    # 1. Explicit fax attribute
    if attributes & PRINTER_ATTRIBUTE_FAX:
        return "VIRTUAL", True

    # 2. Check exact fax name or virtual printer keywords in printer name or driver name
    if name_lower == "fax" or driver_lower == "fax" or "fax" in port_upper:
        return "VIRTUAL", True

    for kw in VIRTUAL_PRINTER_KEYWORDS:
        if kw in name_lower or kw in driver_lower:
            return "VIRTUAL", True

    # 3. Check virtual port patterns (PORTPROMPT:, FILE:, NUL:, XPSPort:, SHRFAX:, PDF ports)
    if port_upper:
        for vp in VIRTUAL_PORT_PATTERNS:
            if port_upper == vp or port_upper.startswith(vp):
                return "VIRTUAL", True

    # 4. Verify physical hardware / network / shared port evidence
    is_usb_port = "USB" in port_upper or "DOT4" in port_upper
    is_wifi_or_wsd = port_upper.startswith("WSD") or "WIFI" in port_upper or "WIRELESS" in port_upper
    is_network_port = (
        bool(attributes & PRINTER_ATTRIBUTE_NETWORK)
        or port_upper.startswith("IP_")
        or port_upper.startswith("TCP")
        or port_upper.startswith("STANDARD TCP/IP")
        or port_upper.startswith("HTTP://")
        or port_upper.startswith("HTTPS://")
        or port_upper.startswith("IPP")
        or port_upper.startswith("LPR")
        or bool(re.match(r"^\d{1,3}(\.\d{1,3}){3}(:\d+)?$", port_upper))
    )
    is_shared_port = (
        bool(attributes & PRINTER_ATTRIBUTE_SHARED)
        or port_upper.startswith("\\\\")
        or (printer_name or "").strip().startswith("\\\\")
    )
    is_hardware_serial_parallel = port_upper.startswith("LPT") or port_upper.startswith("COM")

    if is_usb_port or is_wifi_or_wsd or is_network_port or is_shared_port:
        return "PHYSICAL", False

    if is_hardware_serial_parallel and driver_lower and "generic / text only" not in driver_lower:
        return "PHYSICAL", False

    # 5. If port/driver is ambiguous or unrecognized, classify as UNKNOWN rather than falsely claiming PHYSICAL
    return "UNKNOWN", False


def is_forbidden_printer(
    name: str,
    driver_name: str = "",
    port_name: str = "",
    attributes: int = 0,
) -> bool:
    """
    Returns True if the printer is classified as a virtual/software printer.
    """
    category, is_virt = classify_printer_category(name, driver_name, port_name, attributes)
    return is_virt or category == "VIRTUAL"


def classify_connection_type(
    port_name: str,
    attributes: int = 0,
    printer_name: str = "",
    is_virtual: bool = False,
) -> str:
    """
    Determines the printer connection type: USB, WIFI, NETWORK, SHARED, LOCAL, VIRTUAL, or UNKNOWN.
    """
    if is_virtual:
        return "VIRTUAL"

    port_upper = (port_name or "").strip().upper()
    raw_name = (printer_name or "").strip()

    if "USB" in port_upper or "DOT4" in port_upper:
        return "USB"

    if port_upper.startswith("WSD") or "WIFI" in port_upper or "WIRELESS" in port_upper:
        return "WIFI"

    if (
        (attributes & PRINTER_ATTRIBUTE_SHARED)
        or port_upper.startswith("\\\\")
        or raw_name.startswith("\\\\")
    ) and not (attributes & PRINTER_ATTRIBUTE_NETWORK):
        return "SHARED"

    if (
        (attributes & PRINTER_ATTRIBUTE_NETWORK)
        or port_upper.startswith("IP_")
        or port_upper.startswith("TCP")
        or port_upper.startswith("STANDARD TCP/IP")
        or port_upper.startswith("HTTP")
        or port_upper.startswith("IPP")
        or port_upper.startswith("LPR")
        or port_upper.startswith("\\\\")
        or raw_name.startswith("\\\\")
        or bool(re.match(r"^\d{1,3}(\.\d{1,3}){3}(:\d+)?$", port_upper))
    ):
        return "NETWORK"

    if port_upper.startswith("LPT") or port_upper.startswith("COM"):
        return "LOCAL"

    if port_upper:
        return "LOCAL"

    return "UNKNOWN"


def get_usb_port_hardware_presence() -> tuple[set, set]:
    """
    Uses Windows SetupAPI (GUID_DEVINTERFACE_USBPRINT) and the Windows USBPRINT DeviceClasses
    registry to determine which USB printer ports (e.g. USB001, USB002) are registered in
    Windows (`known_ports`) and which ones have a USB printer physically connected and powered
    on right now (`connected_ports`).
    """
    known_ports = set()
    connected_ports = set()
    if os.name != "nt":
        return known_ports, connected_ports

    try:
        class _GUID(ctypes.Structure):
            _fields_ = [
                ("Data1", wintypes.DWORD),
                ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD),
                ("Data4", ctypes.c_ubyte * 8),
            ]

        class _SP_DEVINFO_DATA(ctypes.Structure):
            _fields_ = [
                ("cbSize", wintypes.DWORD),
                ("ClassGuid", _GUID),
                ("DevInst", wintypes.DWORD),
                ("Reserved", ctypes.c_void_p),
            ]

        usbprint_guid = _GUID(
            0x28D78FAD,
            0x5A12,
            0x11D1,
            (ctypes.c_ubyte * 8)(0xAE, 0x5B, 0x00, 0x00, 0xF8, 0x03, 0xA8, 0xC2),
        )
        setupapi = ctypes.windll.setupapi
        setupapi.SetupDiGetClassDevsW.argtypes = [
            ctypes.POINTER(_GUID),
            wintypes.LPCWSTR,
            wintypes.HWND,
            wintypes.DWORD,
        ]
        setupapi.SetupDiGetClassDevsW.restype = ctypes.c_void_p
        setupapi.SetupDiEnumDeviceInfo.argtypes = [
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(_SP_DEVINFO_DATA),
        ]
        setupapi.SetupDiEnumDeviceInfo.restype = wintypes.BOOL
        setupapi.SetupDiGetDeviceInstanceIdW.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(_SP_DEVINFO_DATA),
            wintypes.LPWSTR,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ]
        setupapi.SetupDiGetDeviceInstanceIdW.restype = wintypes.BOOL
        setupapi.SetupDiDestroyDeviceInfoList.argtypes = [ctypes.c_void_p]

        present_instances = set()
        # DIGCF_PRESENT (0x02) | DIGCF_DEVICEINTERFACE (0x10)
        hdev = setupapi.SetupDiGetClassDevsW(
            ctypes.byref(usbprint_guid), None, None, 0x02 | 0x10
        )
        invalid_handle = ctypes.c_void_p(-1).value
        if hdev and hdev != invalid_handle:
            try:
                devinfo = _SP_DEVINFO_DATA()
                devinfo.cbSize = ctypes.sizeof(_SP_DEVINFO_DATA)
                idx = 0
                while setupapi.SetupDiEnumDeviceInfo(hdev, idx, ctypes.byref(devinfo)):
                    buf = ctypes.create_unicode_buffer(512)
                    if setupapi.SetupDiGetDeviceInstanceIdW(
                        hdev, ctypes.byref(devinfo), buf, 512, None
                    ):
                        norm_inst = buf.value.strip().upper().replace("\\", "#")
                        if norm_inst:
                            present_instances.add(norm_inst)
                    idx += 1
            finally:
                setupapi.SetupDiDestroyDeviceInfoList(hdev)

        key_path = r"SYSTEM\CurrentControlSet\Control\DeviceClasses\{28d78fad-5a12-11d1-ae5b-0000f803a8c2}"
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path) as k:
            i = 0
            while True:
                try:
                    sub = winreg.EnumKey(k, i)
                    i += 1
                    try:
                        with winreg.OpenKey(k, sub + r"\#\Device Parameters") as dp:
                            port_num, _ = winreg.QueryValueEx(dp, "Port Number")
                            port_label = f"USB{int(port_num):03d}"
                            known_ports.add(port_label)
                            sub_upper = sub.upper()
                            for inst in present_instances:
                                if inst in sub_upper:
                                    connected_ports.add(port_label)
                                    break
                    except FileNotFoundError:
                        continue
                except OSError:
                    break
    except Exception:
        pass

    return known_ports, connected_ports


def get_default_windows_printer() -> str:
    try:
        return str(win32print.GetDefaultPrinter() or "").strip()
    except Exception:
        return ""


def list_windows_printers(include_virtual: bool = False) -> list:
    """
    Enumerates installed local and network/shared printers via Windows Print Spooler.
    Filters out virtual printers unless include_virtual=True.
    """
    try:
        flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
        printers = win32print.EnumPrinters(flags)
        names = [p[2] for p in printers if p and len(p) > 2 and p[2]]
        if include_virtual:
            return names
        return [n for n in names if not is_forbidden_printer(n)]
    except Exception as exc:
        raise RuntimeError(f"Windows Print Spooler is unavailable: {exc}") from exc


def query_printer_capabilities(
    printer_name: str,
    port_name: str,
    devmode=None,
) -> tuple[dict, bool]:
    """
    Dynamically queries a Windows printer's driver capabilities via win32print.DeviceCapabilities
    and DEVMODE structure without brand-specific hardcoding.
    Returns (capabilities_dict, any_capability_detected_bool).
    """
    caps = {
        "supportedPaperSizes": ["A4"],
        "paperSizesKnown": False,
        "supportsBW": True,
        "supportsColor": False,
        "colorSupportKnown": False,
        "supportsSingleSided": True,
        "supportsDuplex": False,
        "duplexSupportKnown": False,
        "supportsCopies": True,
        "maxCopies": 99,
        "copiesSupportKnown": False,
        "supportedOrientations": ["portrait", "landscape"],
        "orientationSupportKnown": False,
        "resolutionsDpi": [],
    }
    any_detected = False

    # 1. Paper Sizes (DC_PAPERS = 2)
    try:
        paper_codes = win32print.DeviceCapabilities(printer_name, port_name, DC_PAPERS)
        if paper_codes and isinstance(paper_codes, (list, tuple)):
            code_set = set(int(c) for c in paper_codes if isinstance(c, (int, float)))
            matched_sizes = [
                label
                for label in STANDARD_CUSTOMER_PAPER_SIZES
                if PAPER_SIZE_MAP.get(label) in code_set
            ]
            if matched_sizes:
                caps["supportedPaperSizes"] = matched_sizes
                caps["paperSizesKnown"] = True
                any_detected = True
    except Exception:
        pass

    # Fallback check on DEVMODE.PaperSize if DC_PAPERS was not exposed
    if not caps["paperSizesKnown"] and devmode is not None:
        try:
            dm_paper = int(getattr(devmode, "PaperSize", 0) or 0)
            for label, code in PAPER_SIZE_MAP.items():
                if dm_paper == code:
                    caps["supportedPaperSizes"] = [label] if label == "A4" else ["A4", label]
                    break
        except Exception:
            pass

    # 2. Duplex / Double-Sided Support (DC_DUPLEX = 7)
    try:
        duplex_cap = win32print.DeviceCapabilities(printer_name, port_name, DC_DUPLEX)
        if duplex_cap in (0, 1):
            caps["supportsDuplex"] = bool(int(duplex_cap) == 1)
            caps["duplexSupportKnown"] = True
            any_detected = True
    except Exception:
        pass

    if not caps["duplexSupportKnown"] and devmode is not None:
        try:
            dm_fields = int(getattr(devmode, "Fields", 0) or 0)
            if dm_fields & DM_DUPLEX:
                caps["supportsDuplex"] = True
                caps["duplexSupportKnown"] = True
                any_detected = True
        except Exception:
            pass

    # 3. Colour vs Monochrome Support (DC_COLORDEVICE = 32 + DEVMODE fallback)
    try:
        color_cap = win32print.DeviceCapabilities(printer_name, port_name, DC_COLORDEVICE)
        if color_cap in (0, 1):
            caps["supportsColor"] = bool(int(color_cap) == 1)
            caps["colorSupportKnown"] = True
            any_detected = True
    except Exception:
        pass

    if not caps["colorSupportKnown"] and devmode is not None:
        try:
            dm_fields = int(getattr(devmode, "Fields", 0) or 0)
            dm_color = int(getattr(devmode, "Color", 0) or 0)
            if (dm_fields & DM_COLOR) and dm_color == getattr(win32con, "DMCOLOR_COLOR", 2):
                caps["supportsColor"] = True
                caps["colorSupportKnown"] = True
                any_detected = True
            elif dm_color == getattr(win32con, "DMCOLOR_MONOCHROME", 1):
                caps["supportsColor"] = False
                caps["colorSupportKnown"] = True
                any_detected = True
        except Exception:
            pass

    # 4. Maximum Hardware Copies (DC_COPIES = 18)
    try:
        copies_cap = win32print.DeviceCapabilities(printer_name, port_name, DC_COPIES)
        if copies_cap is not None and int(copies_cap) >= 1:
            caps["maxCopies"] = int(copies_cap)
            caps["supportsCopies"] = True
            caps["copiesSupportKnown"] = True
            any_detected = True
    except Exception:
        pass

    # 5. Orientation Support (DC_ORIENTATION = 17)
    try:
        orient_cap = win32print.DeviceCapabilities(printer_name, port_name, DC_ORIENTATION)
        if orient_cap in (90, 270):
            caps["supportedOrientations"] = ["portrait", "landscape"]
            caps["orientationSupportKnown"] = True
            any_detected = True
        elif orient_cap == 0:
            caps["supportedOrientations"] = ["portrait"]
            caps["orientationSupportKnown"] = True
            any_detected = True
    except Exception:
        pass

    # 6. Print Resolutions in DPI (DC_ENUMRESOLUTIONS = 13)
    try:
        res_raw = win32print.DeviceCapabilities(printer_name, port_name, DC_ENUMRESOLUTIONS)
        if res_raw and isinstance(res_raw, (list, tuple)):
            dpis = sorted(
                {
                    int(item[0]) if isinstance(item, (list, tuple)) and len(item) >= 1 else int(item)
                    for item in res_raw
                    if (isinstance(item, (list, tuple)) and len(item) >= 1 and isinstance(item[0], (int, float)) and item[0] > 0)
                    or (isinstance(item, int) and item > 0)
                }
            )
            if dpis:
                caps["resolutionsDpi"] = dpis[:10]
    except Exception:
        pass

    return caps, any_detected


def inspect_printer_state_and_capabilities(
    printer_name: str,
    default_printer: str = None,
    allow_virtual: bool = False,
) -> dict:
    """
    Inspects any Windows printer via win32print.OpenPrinter & GetPrinter(level 2).
    Note: PrinterStatus == 0 and WorkOffline == False in Windows means Normal (Idle & Ready).
    """
    if default_printer is None:
        default_printer = get_default_windows_printer()

    clean_name = (printer_name or "").strip()
    brand, model = extract_brand_and_model(clean_name, "")

    result = {
        "name": clean_name or "No Printer Selected",
        "printerName": clean_name or "No Printer Selected",
        "manufacturer": brand,
        "model": model,
        "exists": False,
        "spoolerAvailable": True,
        "portName": None,
        "driverName": None,
        "connectionType": "UNKNOWN",
        "printerCategory": "UNKNOWN",
        "isVirtual": False,
        "isShared": False,
        "isDefault": bool(
            default_printer and clean_name and clean_name.lower() == default_printer.lower()
        ),
        "driverMissing": False,
        "capabilitiesDetected": False,
        "printerStatusCode": None,
        "workOffline": False,
        "printerAvailable": False,
        "status": "OFFLINE",
        "statusMessage": (
            f"Printer '{clean_name}' not found in Windows"
            if clean_name
            else "No Windows printer selected"
        ),
        "spoolerJobCount": 0,
        "capabilities": {
            "supportedPaperSizes": ["A4"],
            "paperSizesKnown": False,
            "supportsBW": True,
            "supportsColor": False,
            "colorSupportKnown": False,
            "supportsSingleSided": True,
            "supportsDuplex": False,
            "duplexSupportKnown": False,
            "supportsCopies": True,
            "maxCopies": 99,
            "copiesSupportKnown": False,
            "supportedOrientations": ["portrait", "landscape"],
            "orientationSupportKnown": False,
            "resolutionsDpi": [],
        },
    }

    if not clean_name or clean_name in (
        "No Printer Selected",
        "No Printer Detected",
        "Multiple Printers Detected — Select One",
    ):
        return result

    try:
        all_enumerated = list_windows_printers(include_virtual=True)
    except Exception as exc:
        result["spoolerAvailable"] = False
        result["statusMessage"] = str(exc)
        return result

    matched_installed_name = None
    for candidate in all_enumerated:
        if candidate.strip().lower() == clean_name.lower():
            matched_installed_name = candidate
            break

    if not matched_installed_name:
        result["statusMessage"] = (
            f"Printer '{clean_name}' is disconnected or not installed in Windows."
        )
        return result

    result["name"] = matched_installed_name
    result["printerName"] = matched_installed_name
    result["exists"] = True

    try:
        handle = win32print.OpenPrinter(matched_installed_name)
    except Exception as exc:
        result["statusMessage"] = f"Cannot open printer '{matched_installed_name}': {exc}"
        return result

    try:
        info2 = win32print.GetPrinter(handle, 2)
        status_flags = int(info2.get("Status", 0) or 0)
        attributes = int(info2.get("Attributes", 0) or 0)
        c_jobs = int(info2.get("cJobs", 0) or 0)
        port_name = str(info2.get("pPortName", "") or "").strip()
        driver_name = str(info2.get("pDriverName", "") or "").strip()
        devmode = info2.get("pDevMode")

        brand, model = extract_brand_and_model(matched_installed_name, driver_name)
        category, is_virtual = classify_printer_category(
            matched_installed_name, driver_name, port_name, attributes
        )
        conn_type = classify_connection_type(
            port_name, attributes, matched_installed_name, is_virtual=is_virtual
        )

        work_offline = bool(attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE)
        driver_missing = not bool(driver_name)

        # Verify physical USB hardware presence when running against the real Windows spooler
        usb_hardware_disconnected = False
        is_mocked_handle = str(handle).startswith("HANDLE::")
        if conn_type == "USB" and port_name and not is_mocked_handle:
            known_usb_ports, connected_usb_ports = get_usb_port_hardware_presence()
            port_upper = port_name.upper()
            if port_upper in known_usb_ports and port_upper not in connected_usb_ports:
                usb_hardware_disconnected = True
                work_offline = True

        result["manufacturer"] = brand
        result["model"] = model
        result["portName"] = port_name or None
        result["driverName"] = driver_name or None
        result["driverMissing"] = driver_missing
        result["printerCategory"] = category
        result["isVirtual"] = is_virtual
        result["isShared"] = bool(
            (attributes & PRINTER_ATTRIBUTE_SHARED)
            or port_name.startswith("\\\\")
            or matched_installed_name.startswith("\\\\")
        )
        result["connectionType"] = conn_type
        result["printerStatusCode"] = status_flags
        result["workOffline"] = work_offline
        result["usbHardwareDisconnected"] = usb_hardware_disconnected
        result["spoolerJobCount"] = c_jobs

        if is_virtual and not allow_virtual:
            result["printerAvailable"] = False
            result["status"] = "OFFLINE"
            result["statusMessage"] = (
                f"Virtual software printer '{matched_installed_name}' is excluded from physical shop printing."
            )
            return result

        caps, caps_detected = query_printer_capabilities(
            matched_installed_name, port_name, devmode=devmode
        )
        result["capabilities"] = caps
        result["capabilitiesDetected"] = caps_detected

        if driver_missing:
            result["printerAvailable"] = False
            result["status"] = "ERROR"
            result["statusMessage"] = (
                f"Windows printer driver is missing for {matched_installed_name}. "
                f"Please install the official {brand} Windows driver."
            )
        elif usb_hardware_disconnected or work_offline or (status_flags & (PRINTER_STATUS_OFFLINE | PRINTER_STATUS_NOT_AVAILABLE | PRINTER_STATUS_SERVER_UNKNOWN)):
            result["printerAvailable"] = False
            result["status"] = "OFFLINE"
            if usb_hardware_disconnected:
                result["statusMessage"] = (
                    f"{matched_installed_name} is installed in Windows ({port_name}), but the printer is powered off or the USB cable is disconnected."
                )
            else:
                result["statusMessage"] = (
                    f"{matched_installed_name} is offline or disconnected ({port_name or conn_type})"
                )
        elif status_flags & PRINTER_STATUS_PAPER_OUT:
            result["printerAvailable"] = False
            result["status"] = "ERROR"
            result["statusMessage"] = f"{matched_installed_name} is out of paper"
        elif status_flags & (PRINTER_STATUS_PAPER_JAM | PRINTER_STATUS_PAPER_PROBLEM):
            result["printerAvailable"] = False
            result["status"] = "ERROR"
            result["statusMessage"] = f"Paper jam or paper feed problem on {matched_installed_name}"
        elif status_flags & PRINTER_STATUS_DOOR_OPEN:
            result["printerAvailable"] = False
            result["status"] = "ERROR"
            result["statusMessage"] = f"Cover or door open on {matched_installed_name}"
        elif status_flags & PRINTER_STATUS_NO_TONER:
            result["printerAvailable"] = False
            result["status"] = "ERROR"
            result["statusMessage"] = f"{matched_installed_name} is out of toner/ink"
        elif status_flags & (PRINTER_STATUS_ERROR | PRINTER_STATUS_USER_INTERVENTION | PRINTER_STATUS_OUT_OF_MEMORY):
            result["printerAvailable"] = False
            result["status"] = "ERROR"
            result["statusMessage"] = (
                f"{matched_installed_name} reported a hardware error (status code {status_flags})"
            )
        elif status_flags & PRINTER_STATUS_PAUSED:
            result["printerAvailable"] = False
            result["status"] = "ERROR"
            result["statusMessage"] = f"{matched_installed_name} print queue is paused in Windows"
        elif (status_flags & (PRINTER_STATUS_PRINTING | PRINTER_STATUS_PROCESSING | PRINTER_STATUS_BUSY)) or c_jobs > 0:
            result["printerAvailable"] = True
            result["status"] = "PRINTING"
            result["statusMessage"] = (
                f"Printing on {matched_installed_name} ({port_name or conn_type}) — {c_jobs} job(s) in queue"
            )
        else:
            result["printerAvailable"] = True
            result["status"] = "READY"
            result["statusMessage"] = (
                f"Printer Ready ({matched_installed_name} on {port_name or conn_type})"
            )

    finally:
        win32print.ClosePrinter(handle)

    return result


def discover_all_windows_printers(include_virtual: bool = False) -> dict:
    """
    Discovers all Windows printers (USB, Wi-Fi, Network, Shared, Local) and their live status & capabilities.
    Separates physical/usable printers from virtual software printers.
    """
    default_printer = get_default_windows_printer()
    try:
        all_names = list_windows_printers(include_virtual=True)
    except Exception as exc:
        return {
            "success": False,
            "spoolerAvailable": False,
            "defaultPrinter": default_printer or None,
            "error": str(exc),
            "printers": [],
            "physicalPrinters": [],
            "virtualPrinters": [],
        }

    physical_printers = []
    virtual_printers = []

    for name in all_names:
        info = inspect_printer_state_and_capabilities(
            name, default_printer=default_printer, allow_virtual=True
        )
        if info.get("isVirtual") or info.get("printerCategory") == "VIRTUAL":
            virtual_printers.append(info)
        else:
            physical_printers.append(info)

    # Sort physical printers: Online/Ready first, then USB/Network/Wi-Fi physical before UNKNOWN, then Windows Default, then alphabetical
    def _sort_key(p: dict):
        return (
            not p.get("printerAvailable", False),
            p.get("printerCategory") != "PHYSICAL",
            p.get("connectionType") not in ("USB", "WIFI", "NETWORK", "SHARED"),
            not p.get("isDefault", False),
            p.get("name", "").lower(),
        )

    physical_printers.sort(key=_sort_key)
    virtual_printers.sort(key=lambda p: p.get("name", "").lower())

    active_list = (physical_printers + virtual_printers) if include_virtual else physical_printers

    default_is_virtual = any(
        vp["name"].lower() == default_printer.lower() for vp in virtual_printers
    ) if default_printer else False

    return {
        "success": True,
        "spoolerAvailable": True,
        "defaultPrinter": default_printer if (default_printer and not default_is_virtual) else None,
        "printers": active_list,
        "physicalPrinters": physical_printers,
        "virtualPrinters": virtual_printers,
    }


def resolve_target_printer(
    preferred_name: str = None,
    discovered_printers: list = None,
    auto_select_single: bool = True,
) -> str:
    """
    Resolves the vendor's active printer according to universal selection rules:
    1. If the vendor has already selected a preferred printer (`preferred_name`), ALWAYS keep it
       (even if currently offline/disconnected, so it shows Offline and auto-recovers when reconnected,
       and never changes when another printer is plugged in).
    2. If no preferred printer is selected and `auto_select_single=True`:
       - If exactly ONE usable physical printer is detected, automatically select it.
       - If MULTIPLE usable physical printers are detected, return "" so the vendor is prompted
         to select their printer.
       - If NO physical printer is detected, return "".
    """
    if discovered_printers is None:
        discovery = discover_all_windows_printers(include_virtual=False)
        discovered_printers = discovery.get("physicalPrinters", discovery.get("printers", []))

    usable_printers = [
        p for p in discovered_printers
        if not p.get("isVirtual") and p.get("printerCategory") != "VIRTUAL"
    ]

    clean_pref = (preferred_name or "").strip()
    if clean_pref in (
        "No Printer Selected",
        "No Printer Detected",
        "Multiple Printers Detected — Select One",
        "Detecting Windows Printers...",
        "Exact Windows printer name",
    ):
        clean_pref = ""

    if clean_pref and not is_forbidden_printer(clean_pref):
        for p in usable_printers:
            if p["name"].strip().lower() == clean_pref.lower():
                return p["name"]
        # Vendor's selected printer is not currently enumerated (e.g. USB unplugged);
        # keep it as the target so status reports OFFLINE until reconnected.
        return clean_pref

    if auto_select_single:
        online_usable = [p for p in usable_printers if p.get("printerAvailable")]
        if len(online_usable) == 1 and len(usable_printers) == 1:
            return online_usable[0]["name"]
        if len(online_usable) == 1 and all(
            not p.get("printerAvailable") for p in usable_printers if p["name"] != online_usable[0]["name"]
        ):
            return online_usable[0]["name"]

    return ""


def build_unselected_printer_state(usable_printers: list) -> dict:
    """
    Builds a clear status summary when no printer is selected yet (either 0 physical printers
    detected, or multiple physical printers detected awaiting vendor choice).
    """
    count = len(usable_printers)
    if count > 1:
        label = "Multiple Printers Detected — Select One"
        msg = (
            f"{count} physical Windows printers detected ({', '.join(p['name'] for p in usable_printers[:4])}). "
            "Please select which printer Smart Xerox should use."
        )
    else:
        label = "No Printer Detected"
        msg = (
            "No physical Windows printer detected. Connect your printer via USB or network "
            "and ensure the manufacturer's Windows printer driver is installed."
        )

    return {
        "name": label,
        "printerName": label,
        "manufacturer": None,
        "model": None,
        "exists": False,
        "spoolerAvailable": True,
        "portName": None,
        "driverName": None,
        "connectionType": "UNKNOWN",
        "printerCategory": "UNKNOWN",
        "isVirtual": False,
        "isShared": False,
        "isDefault": False,
        "driverMissing": False,
        "capabilitiesDetected": False,
        "printerStatusCode": None,
        "workOffline": False,
        "printerAvailable": False,
        "requiresManualSelection": count > 1,
        "status": "OFFLINE",
        "statusMessage": msg,
        "spoolerJobCount": 0,
        "capabilities": {
            "supportedPaperSizes": ["A4"],
            "paperSizesKnown": False,
            "supportsBW": True,
            "supportsColor": False,
            "colorSupportKnown": False,
            "supportsSingleSided": True,
            "supportsDuplex": False,
            "duplexSupportKnown": False,
            "supportsCopies": True,
            "maxCopies": 99,
            "copiesSupportKnown": False,
            "supportedOrientations": ["portrait", "landscape"],
            "orientationSupportKnown": False,
            "resolutionsDpi": [],
        },
    }


def validate_job_against_printer_capabilities(job: dict, printer_info: dict) -> None:
    """
    Verifies that the target Windows printer supports the job's requested options.
    Raises ValueError with a clear message if an unsupported option is requested.
    """
    p_name = printer_info.get("printerName") or printer_info.get("name") or "Selected Printer"
    if printer_info.get("isVirtual") or printer_info.get("printerCategory") == "VIRTUAL":
        raise ValueError(f"Refusing to print to virtual printer '{p_name}'.")

    caps = printer_info.get("capabilities") or {}

    color_mode = str(job.get("colorMode") or "bw").lower()
    if (
        color_mode == "color"
        and caps.get("colorSupportKnown") is True
        and not caps.get("supportsColor")
    ):
        raise ValueError(
            f"Printer '{p_name}' does not support Colour printing (Monochrome / Black & White only)."
        )

    sides = str(job.get("sides") or "single").lower()
    if (
        sides == "duplex"
        and caps.get("duplexSupportKnown") is True
        and not caps.get("supportsDuplex")
    ):
        raise ValueError(
            f"Printer '{p_name}' does not support automatic Duplex (double-sided) printing."
        )

    paper_size = str(job.get("paperSize") or "A4")
    supported_sizes = caps.get("supportedPaperSizes") or []
    if (
        caps.get("paperSizesKnown") is True
        and supported_sizes
        and paper_size not in supported_sizes
    ):
        raise ValueError(
            f"Printer '{p_name}' does not support paper size '{paper_size}'. "
            f"Supported paper sizes: {', '.join(supported_sizes)}."
        )


def load_completed_ledger(ledger_path: Path = LEDGER_FILE) -> set:
    if not ledger_path.exists():
        return set()
    try:
        data = json.loads(ledger_path.read_text(encoding="utf-8"))
        return set(data.get("completedOrderIds", []))
    except Exception:
        return set()


def record_completed_job(order_id: str, ledger_path: Path = LEDGER_FILE) -> None:
    completed = load_completed_ledger(ledger_path)
    completed.add(str(order_id))
    recent = list(completed)[-500:]
    try:
        ledger_path.write_text(
            json.dumps({"completedOrderIds": recent}, indent=2),
            encoding="utf-8",
        )
    except Exception as exc:
        logger.warning("Could not update completed job ledger: %s", exc)


def build_agent_headers(agent_id: str, agent_secret: str, agent_job_id: str = None) -> dict:
    headers = {
        "x-agent-id": agent_id,
        "x-agent-secret": agent_secret,
        "Accept": "application/json",
    }
    if agent_job_id:
        headers["x-agent-job-id"] = agent_job_id
    return headers


def send_heartbeat(
    backend_url: str,
    agent_id: str,
    agent_secret: str,
    device_id: str,
    primary_printer: dict,
    all_printers: list,
) -> tuple[bool, dict]:
    payload = {
        "agentId": agent_id,
        "deviceId": device_id,
        "agentVersion": AGENT_VERSION,
        "hostname": socket.gethostname(),
        "osVersion": f"{platform.system()} {platform.release()}",
        "printerName": primary_printer["printerName"],
        "manufacturer": primary_printer.get("manufacturer"),
        "model": primary_printer.get("model"),
        "portName": primary_printer["portName"],
        "driverName": primary_printer["driverName"],
        "connectionType": primary_printer.get("connectionType", "UNKNOWN"),
        "printerCategory": primary_printer.get("printerCategory", "UNKNOWN"),
        "driverMissing": primary_printer.get("driverMissing", False),
        "printerAvailable": primary_printer["printerAvailable"],
        "requiresManualSelection": primary_printer.get("requiresManualSelection", False),
        "status": primary_printer["status"],
        "statusMessage": primary_printer["statusMessage"],
        "spoolerJobCount": primary_printer["spoolerJobCount"],
        "capabilities": primary_printer["capabilities"],
        "availablePrinters": all_printers,
    }
    try:
        resp = requests.post(
            f"{backend_url}/agent/heartbeat",
            headers=build_agent_headers(agent_id, agent_secret),
            json=payload,
            timeout=10,
        )
        if resp.status_code == 200:
            return True, resp.json()
        logger.error(
            "Heartbeat rejected by backend (HTTP %d): %s",
            resp.status_code,
            resp.text[:200],
        )
        return False, {"statusCode": resp.status_code, "body": resp.text}
    except Exception as exc:
        logger.warning("Heartbeat connection error to %s: %s", backend_url, exc)
        return False, {"error": str(exc)}


def send_offline_notification(
    backend_url: str,
    agent_id: str,
    agent_secret: str,
    reason: str = "Vendor desktop application closed.",
) -> bool:
    """
    Notifies the cloud backend that this print agent is going offline so the shop
    is immediately marked UNAVAILABLE for new customer print orders.
    """
    if not backend_url or not agent_id or not agent_secret:
        return False
    try:
        resp = requests.post(
            f"{backend_url}/agent/offline",
            headers=build_agent_headers(agent_id, agent_secret),
            json={"reason": reason},
            timeout=4,
        )
        return resp.status_code == 200
    except Exception:
        return False


def update_backend_job_status(
    backend_url: str,
    agent_id: str,
    agent_secret: str,
    order_id: str,
    agent_job_id: str,
    status: str,
    failure_reason: str = None,
    spooler_job_id: int = None,
) -> None:
    try:
        payload = {
            "status": status,
            "agentJobId": agent_job_id,
            "failureReason": failure_reason,
        }
        if spooler_job_id is not None:
            payload["spoolerJobId"] = spooler_job_id

        resp = requests.patch(
            f"{backend_url}/agent/jobs/{order_id}/status",
            headers=build_agent_headers(agent_id, agent_secret, agent_job_id),
            json=payload,
            timeout=15,
        )
        logger.info(
            "Updated job %s status -> %s (HTTP %d)",
            order_id,
            status,
            resp.status_code,
        )
    except Exception as exc:
        logger.error("Failed to update status (%s) for job %s: %s", status, order_id, exc)


def download_job_document(
    backend_url: str,
    agent_id: str,
    agent_secret: str,
    order_id: str,
    agent_job_id: str,
    expected_sha256: str,
    dest_path: Path,
) -> int:
    """
    Streams the private document from MongoDB Atlas GridFS via GET /api/agent/jobs/:id/file
    and verifies its SHA-256 checksum. Returns byte size downloaded.
    """
    hasher = hashlib.sha256()
    total_bytes = 0
    with requests.get(
        f"{backend_url}/agent/jobs/{order_id}/file",
        headers=build_agent_headers(agent_id, agent_secret, agent_job_id),
        stream=True,
        timeout=60,
    ) as resp:
        resp.raise_for_status()
        with open(dest_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=64 * 1024):
                if chunk:
                    f.write(chunk)
                    hasher.update(chunk)
                    total_bytes += len(chunk)

    actual_sha256 = hasher.hexdigest()
    if expected_sha256 and len(expected_sha256) == 64 and actual_sha256 != expected_sha256:
        raise ValueError(
            f"Downloaded file SHA-256 mismatch (expected {expected_sha256[:12]}..., got {actual_sha256[:12]}...)"
        )
    return total_bytes


def compose_image_onto_sheet(
    content_img: Image.Image,
    paper_size: str = "A4",
    requested_orientation: str = "auto",
    dpi: int = 300,
) -> Image.Image:
    """
    Fits a rendered page or image onto a white sheet canvas matching the exact
    requested paper size (A4, A3, A5, Letter, Legal, B5, Executive) and orientation
    (Portrait vs Landscape) without cropping any content.
    """
    w_mm, h_mm = PAPER_DIMENSIONS_MM.get(paper_size, PAPER_DIMENSIONS_MM["A4"])
    is_content_landscape = content_img.width > content_img.height

    if requested_orientation == "landscape":
        use_landscape = True
    elif requested_orientation == "portrait":
        use_landscape = False
    else:
        use_landscape = is_content_landscape

    sheet_w_mm, sheet_h_mm = (h_mm, w_mm) if use_landscape else (w_mm, h_mm)
    sheet_w_px = max(100, int(round((sheet_w_mm / 25.4) * dpi)))
    sheet_h_px = max(100, int(round((sheet_h_mm / 25.4) * dpi)))

    scale = min(
        sheet_w_px / float(max(1, content_img.width)),
        sheet_h_px / float(max(1, content_img.height)),
    )
    target_w = max(1, int(round(content_img.width * scale)))
    target_h = max(1, int(round(content_img.height * scale)))

    resized = (
        content_img.resize((target_w, target_h), Image.Resampling.LANCZOS)
        if (target_w, target_h) != content_img.size
        else content_img
    )

    sheet = Image.new("RGB", (sheet_w_px, sheet_h_px), (255, 255, 255))
    offset_x = max(0, (sheet_w_px - target_w) // 2)
    offset_y = max(0, (sheet_h_px - target_h) // 2)
    sheet.paste(resized, (offset_x, offset_y))
    return sheet


def render_pages_to_pil_images(job: dict, file_path: Path, dpi: int = 300) -> list:
    """
    Uses PyMuPDF (for PDFs) or Pillow (for JPG/PNG images) to prepare the exact selected pages,
    colour mode (B&W grayscale vs Colour), paper size, and orientation into 300 DPI PIL Images.
    """
    doc_type = job.get("documentType", "pdf")
    color_mode = job.get("colorMode", "bw")
    requested_orientation = job.get("orientation", "auto")
    paper_size = job.get("paperSize", "A4")
    selected_pages = job.get("selectedPages") or [1]

    pil_pages = []

    if doc_type == "image":
        img = Image.open(file_path)
        img = ImageOps.exif_transpose(img)
        if color_mode == "bw":
            img = img.convert("L").convert("RGB")
        else:
            img = img.convert("RGB")

        composed = compose_image_onto_sheet(
            img,
            paper_size=paper_size,
            requested_orientation=requested_orientation,
            dpi=dpi,
        )
        pil_pages.append(composed)
        return pil_pages

    pdf_doc = fitz.open(file_path)
    try:
        total_pages = len(pdf_doc)
        colorspace = fitz.csGRAY if color_mode == "bw" else fitz.csRGB
        zoom = dpi / 72.0
        matrix = fitz.Matrix(zoom, zoom)

        for p_num in selected_pages:
            idx = int(p_num) - 1
            if idx < 0 or idx >= total_pages:
                continue
            page = pdf_doc[idx]
            pix = page.get_pixmap(matrix=matrix, colorspace=colorspace, alpha=False)
            mode = "L" if color_mode == "bw" else "RGB"
            img = Image.frombytes(mode, [pix.width, pix.height], pix.samples)
            if mode == "L":
                img = img.convert("RGB")

            composed = compose_image_onto_sheet(
                img,
                paper_size=paper_size,
                requested_orientation=requested_orientation,
                dpi=dpi,
            )
            pil_pages.append(composed)
    finally:
        pdf_doc.close()

    if not pil_pages:
        raise ValueError("No valid pages could be rendered from the document.")

    return pil_pages


def wait_for_spooler_completion(
    printer_name: str, doc_title: str, timeout_seconds: int = 180
) -> int:
    """
    Monitors the Windows Print Spooler queue for `doc_title` on `printer_name`
    until the printer finishes spooling/printing the job.
    """
    deadline = time.time() + timeout_seconds
    seen_job_id = 0

    while time.time() < deadline:
        handle = win32print.OpenPrinter(printer_name)
        try:
            jobs = win32print.EnumJobs(handle, 0, 99, 1)
            matching_job = None
            for j in jobs:
                if j.get("pDocument") == doc_title:
                    matching_job = j
                    seen_job_id = int(j.get("JobId", 0))
                    break

            if matching_job is None:
                return seen_job_id

            status_bits = int(matching_job.get("Status", 0))
            if status_bits & JOB_STATUS_PAPEROUT:
                raise RuntimeError(f"{printer_name} ran out of paper while printing.")
            if status_bits & JOB_STATUS_OFFLINE:
                raise RuntimeError(f"{printer_name} went offline during printing.")
            if status_bits & JOB_STATUS_ERROR:
                raise RuntimeError(f"Windows Print Spooler reported a print error on {printer_name}.")
            if status_bits & (JOB_STATUS_PRINTED | JOB_STATUS_COMPLETE | JOB_STATUS_DELETED):
                return seen_job_id
        finally:
            win32print.ClosePrinter(handle)

        time.sleep(1.2)

    raise TimeoutError(f"Timed out waiting for {printer_name} to finish printing {doc_title}.")


def print_via_windows_gdi(printer_name: str, job: dict, pil_pages: list) -> str:
    """
    Sends rendered pages directly to the selected Windows printer using Windows GDI (win32ui / win32print).
    Works universally across HP, Canon, Epson, Brother, Samsung, Xerox, Ricoh, Kyocera, Pantum, Lexmark, etc.
    """
    if is_forbidden_printer(printer_name):
        raise RuntimeError(f"Refusing to print to virtual printer '{printer_name}'.")

    paper_size_name = job.get("paperSize", "A4")
    sides = job.get("sides", "single")
    color_mode = job.get("colorMode", "bw")
    copies = max(1, min(1000, int(job.get("copies", 1))))
    orientation = job.get("orientation", "auto")
    doc_title = f"SmartXerox-{job.get('token', job.get('orderId'))}"

    handle = win32print.OpenPrinter(printer_name)
    try:
        info2 = win32print.GetPrinter(handle, 2)
        devmode = info2.get("pDevMode")
        if devmode:
            devmode.PaperSize = PAPER_SIZE_MAP.get(paper_size_name, win32con.DMPAPER_A4)
            devmode.Color = (
                win32con.DMCOLOR_COLOR
                if color_mode == "color"
                else win32con.DMCOLOR_MONOCHROME
            )
            devmode.Duplex = (
                win32con.DMDUP_VERTICAL
                if sides == "duplex" and len(pil_pages) > 1
                else win32con.DMDUP_SIMPLEX
            )
            first_img = pil_pages[0]
            use_landscape = orientation == "landscape" or (
                orientation == "auto" and first_img.width > first_img.height
            )
            devmode.Orientation = (
                win32con.DMORIENT_LANDSCAPE
                if use_landscape
                else win32con.DMORIENT_PORTRAIT
            )
            try:
                devmode.Fields |= (
                    DM_PAPERSIZE | DM_COLOR | DM_DUPLEX | DM_ORIENTATION
                )
            except Exception:
                pass
    finally:
        win32print.ClosePrinter(handle)

    hdc = win32ui.CreateDC()
    hdc.CreatePrinterDC(printer_name)

    try:
        printable_width = hdc.GetDeviceCaps(win32con.HORZRES)
        printable_height = hdc.GetDeviceCaps(win32con.VERTRES)

        hdc.StartDoc(doc_title)
        try:
            dc_is_landscape = printable_width > printable_height
            for _copy_idx in range(copies):
                for page_img in pil_pages:
                    hdc.StartPage()

                    draw_img = page_img
                    img_is_landscape = draw_img.width > draw_img.height
                    # If the composed sheet is Landscape (width > height) and the physical
                    # GDI paper feed is Portrait (printable_width < printable_height),
                    # rotate the composed Landscape sheet 90 degrees so its long axis aligns
                    # with the physical paper sheet without shrinking or cropping!
                    if img_is_landscape != dc_is_landscape:
                        draw_img = draw_img.rotate(90, expand=True)

                    img_w, img_h = draw_img.size
                    scale = min(
                        printable_width / float(img_w), printable_height / float(img_h)
                    )
                    draw_w = int(img_w * scale)
                    draw_h = int(img_h * scale)
                    offset_x = max(0, (printable_width - draw_w) // 2)
                    offset_y = max(0, (printable_height - draw_h) // 2)

                    dib = ImageWin.Dib(draw_img)
                    dib.draw(
                        hdc.GetHandleOutput(),
                        (offset_x, offset_y, offset_x + draw_w, offset_y + draw_h),
                    )
                    hdc.EndPage()
        finally:
            hdc.EndDoc()
    finally:
        hdc.DeleteDC()

    return doc_title


def process_and_print_job(
    backend_url: str,
    agent_id: str,
    agent_secret: str,
    job: dict,
    printer_name: str,
    ledger_path: Path = LEDGER_FILE,
) -> None:
    order_id = str(job["orderId"])
    agent_job_id = str(job["agentJobId"])
    token = job.get("token", order_id)

    if order_id in load_completed_ledger(ledger_path):
        logger.info("Job %s (%s) already in completed ledger; marking COMPLETED.", token, order_id)
        update_backend_job_status(
            backend_url, agent_id, agent_secret, order_id, agent_job_id, "COMPLETED"
        )
        return

    printer_info = inspect_printer_state_and_capabilities(printer_name)
    if not printer_info["printerAvailable"]:
        reason = printer_info["statusMessage"]
        logger.error("Cannot print job %s: %s", token, reason)
        update_backend_job_status(
            backend_url,
            agent_id,
            agent_secret,
            order_id,
            agent_job_id,
            "FAILED",
            failure_reason=reason,
        )
        return

    # Validate requested job options against the selected printer's hardware capabilities
    try:
        validate_job_against_printer_capabilities(job, printer_info)
    except ValueError as cap_err:
        reason = str(cap_err)
        logger.error("Job %s rejected by printer capability check: %s", token, reason)
        update_backend_job_status(
            backend_url,
            agent_id,
            agent_secret,
            order_id,
            agent_job_id,
            "FAILED",
            failure_reason=reason,
        )
        return

    with tempfile.TemporaryDirectory(prefix="smart_xerox_") as tmp_dir:
        ext = "pdf" if job.get("documentType") == "pdf" else "img"
        local_file = Path(tmp_dir) / f"job_{order_id}.{ext}"

        logger.info("[Job %s] Step 1/4: Downloading GridFS document...", token)
        update_backend_job_status(
            backend_url, agent_id, agent_secret, order_id, agent_job_id, "DOWNLOADING"
        )
        bytes_downloaded = download_job_document(
            backend_url=backend_url,
            agent_id=agent_id,
            agent_secret=agent_secret,
            order_id=order_id,
            agent_job_id=agent_job_id,
            expected_sha256=job.get("fileSha256"),
            dest_path=local_file,
        )
        logger.info("[Job %s] Downloaded %d bytes from GridFS.", token, bytes_downloaded)

        logger.info("[Job %s] Step 2/4: Rendering pages at 300 DPI...", token)
        update_backend_job_status(
            backend_url, agent_id, agent_secret, order_id, agent_job_id, "PROCESSING"
        )
        pil_pages = render_pages_to_pil_images(job, local_file, dpi=300)

        logger.info(
            "[Job %s] Step 3/4: Sending %d page(s) x %d copies to '%s' (%s)...",
            token,
            len(pil_pages),
            job.get("copies", 1),
            printer_name,
            printer_info.get("portName"),
        )
        update_backend_job_status(
            backend_url, agent_id, agent_secret, order_id, agent_job_id, "PRINTING"
        )
        doc_title = print_via_windows_gdi(printer_name, job, pil_pages)

        logger.info("[Job %s] Step 4/4: Waiting for Windows Spooler confirmation...", token)
        spooler_id = wait_for_spooler_completion(printer_name, doc_title)

        record_completed_job(order_id, ledger_path)
        update_backend_job_status(
            backend_url,
            agent_id,
            agent_secret,
            order_id,
            agent_job_id,
            "COMPLETED",
            spooler_job_id=spooler_id,
        )
        logger.info("[Job %s] Physical print on '%s' confirmed COMPLETED.", token, printer_name)


def load_runtime_config(config_path: str = None) -> dict:
    load_dotenv(BASE_DIR / ".env")
    load_dotenv(BASE_DIR.parent / "backend" / ".env")

    cfg = {
        "backendApiUrl": (
            os.getenv("BACKEND_API_URL") or "https://smart-xerox-api.onrender.com/api"
        ).rstrip("/"),
        "agentId": os.getenv("AGENT_ID", "").strip(),
        "agentSecret": os.getenv("AGENT_SECRET", "").strip(),
        "deviceId": os.getenv("AGENT_DEVICE_ID", f"win-{socket.gethostname()}").strip(),
        "selectedPrinterName": os.getenv("PRINTER_NAME", "").strip(),
        "pollIntervalSeconds": max(2, int(os.getenv("POLL_INTERVAL_SECONDS", "3"))),
        "logFile": str(LOG_FILE),
        "ledgerFile": str(LEDGER_FILE),
    }

    if cfg["selectedPrinterName"] == "Exact Windows printer name":
        cfg["selectedPrinterName"] = ""

    if config_path and Path(config_path).exists():
        try:
            file_cfg = json.loads(Path(config_path).read_text(encoding="utf-8"))
            for k, v in file_cfg.items():
                if v is not None and v != "":
                    cfg[k] = v
            cfg["backendApiUrl"] = str(cfg["backendApiUrl"]).rstrip("/")
        except Exception as exc:
            sys.stderr.write(f"Failed to read config file {config_path}: {exc}\n")

    return cfg


def run_diagnostics(cfg: dict) -> int:
    print("=" * 68)
    print(f"SMART XEROX UNIVERSAL WINDOWS PRINT AGENT DIAGNOSTICS (v{AGENT_VERSION})")
    print("=" * 68)

    discovery = discover_all_windows_printers(include_virtual=False)
    printers = discovery.get("physicalPrinters", discovery.get("printers", []))
    virtual_printers = discovery.get("virtualPrinters", [])
    print("\n[1/3] UNIVERSAL WINDOWS MULTI-PRINTER DISCOVERY")
    print(f"  Spooler Available : {discovery.get('spoolerAvailable')}")
    print(f"  Default Printer   : {discovery.get('defaultPrinter')}")
    print(f"  Physical Printers : {len(printers)}")
    print(f"  Virtual Filtered  : {len(virtual_printers)}")
    for idx, p in enumerate(printers, 1):
        print(
            f"    {idx}. [{p.get('manufacturer')} {p.get('model')}] {p['name']} "
            f"[{p['connectionType']} / {p.get('printerCategory')} on {p['portName']}] -> "
            f"{p['status']} (available={p['printerAvailable']}, color={p['capabilities']['supportsColor']}, "
            f"duplex={p['capabilities']['supportsDuplex']}, sizes={p['capabilities']['supportedPaperSizes']})"
        )

    target_printer = resolve_target_printer(cfg.get("selectedPrinterName"), printers)
    p_info = (
        inspect_printer_state_and_capabilities(target_printer)
        if target_printer
        else build_unselected_printer_state(printers)
    )
    print(f"  Selected Target   : {p_info['printerName']} ({p_info['statusMessage']})")

    print("\n[2/3] BACKEND CONNECTIVITY")
    backend_url = cfg["backendApiUrl"]
    print(f"  Backend API URL   : {backend_url}")
    try:
        health_resp = requests.get(f"{backend_url}/health", timeout=10)
        print(f"  GET /api/health   : HTTP {health_resp.status_code} -> {health_resp.text}")
    except Exception as exc:
        print(f"  WARNING: Backend not currently reachable at {backend_url}: {exc}")

    print("\n[3/3] AGENT CREDENTIAL STATUS")
    if cfg.get("agentId") and cfg.get("agentSecret"):
        ok, hb_data = send_heartbeat(
            backend_url=backend_url,
            agent_id=cfg["agentId"],
            agent_secret=cfg["agentSecret"],
            device_id=cfg["deviceId"],
            primary_printer=p_info,
            all_printers=printers,
        )
        print(f"  POST /agent/heartbeat : {'PASS' if ok else 'FAIL'} -> {json.dumps(hb_data)}")
    else:
        print("  Agent is ready to be paired via the Smart Xerox Windows Desktop Application.")

    print("\n" + "=" * 68)
    return 0


def run_agent_loop(cfg: dict, config_path: str = None) -> None:
    log_path = Path(cfg.get("logFile") or LOG_FILE)
    ledger_path = Path(cfg.get("ledgerFile") or LEDGER_FILE)
    setup_logger(log_path)

    logger.info("Smart Xerox Universal Windows Print Agent v%s started.", AGENT_VERSION)
    logger.info("Backend API URL : %s", cfg["backendApiUrl"])

    preferred_printer = cfg.get("selectedPrinterName") or ""

    while True:
        try:
            # Reload runtime config on each tick if managed by Electron Desktop App
            if config_path and Path(config_path).exists():
                latest = load_runtime_config(config_path)
                cfg.update(latest)
                if latest.get("selectedPrinterName") is not None:
                    preferred_printer = latest.get("selectedPrinterName") or preferred_printer

            agent_id = cfg.get("agentId", "").strip()
            agent_secret = cfg.get("agentSecret", "").strip()
            backend_url = cfg["backendApiUrl"]
            device_id = cfg.get("deviceId") or f"win-{socket.gethostname()}"

            discovery = discover_all_windows_printers(include_virtual=False)
            discovered_list = discovery.get("physicalPrinters", discovery.get("printers", []))
            target_printer_name = resolve_target_printer(preferred_printer, discovered_list)
            primary_info = (
                inspect_printer_state_and_capabilities(target_printer_name)
                if target_printer_name
                else build_unselected_printer_state(discovered_list)
            )

            if not agent_id or not agent_secret:
                logger.info("Waiting for vendor sign-in & desktop pairing...")
                time.sleep(3)
                continue

            online_ok, hb_resp = send_heartbeat(
                backend_url=backend_url,
                agent_id=agent_id,
                agent_secret=agent_secret,
                device_id=device_id,
                primary_printer=primary_info,
                all_printers=discovered_list,
            )

            if online_ok:
                server_selected = (
                    hb_resp.get("tenant", {}).get("selectedPrinterName") or ""
                ).strip()
                if (
                    server_selected
                    and server_selected not in (
                        "No Printer Selected",
                        "No Printer Detected",
                        "Multiple Printers Detected — Select One",
                        "Detecting Windows Printers...",
                    )
                    and server_selected != preferred_printer
                ):
                    preferred_printer = server_selected
                    target_printer_name = resolve_target_printer(preferred_printer, discovered_list)
                    primary_info = (
                        inspect_printer_state_and_capabilities(target_printer_name)
                        if target_printer_name
                        else build_unselected_printer_state(discovered_list)
                    )

            if online_ok and primary_info["printerAvailable"] and target_printer_name:
                resp = requests.get(
                    f"{backend_url}/agent/jobs/next",
                    headers=build_agent_headers(agent_id, agent_secret),
                    timeout=15,
                )
                if resp.status_code == 200:
                    payload = resp.json()
                    job = payload.get("job")
                    if job:
                        job_printer = job.get("printerName") or target_printer_name
                        resolved_job_printer = (
                            resolve_target_printer(job_printer, discovered_list)
                            or target_printer_name
                        )
                        logger.info(
                            "Claimed print job %s (%s) -> target printer '%s'",
                            job.get("token"),
                            job.get("originalName"),
                            resolved_job_printer,
                        )
                        try:
                            process_and_print_job(
                                backend_url=backend_url,
                                agent_id=agent_id,
                                agent_secret=agent_secret,
                                job=job,
                                printer_name=resolved_job_printer,
                                ledger_path=ledger_path,
                            )
                        except Exception as job_err:
                            logger.exception("Error processing print job %s", job.get("token"))
                            update_backend_job_status(
                                backend_url=backend_url,
                                agent_id=agent_id,
                                agent_secret=agent_secret,
                                order_id=str(job["orderId"]),
                                agent_job_id=str(job["agentJobId"]),
                                status="FAILED",
                                failure_reason=str(job_err),
                            )
        except KeyboardInterrupt:
            logger.info("Print agent stopped by user.")
            send_offline_notification(
                cfg.get("backendApiUrl", ""),
                cfg.get("agentId", ""),
                cfg.get("agentSecret", ""),
                reason="Print agent stopped by user.",
            )
            break
        except Exception as loop_err:
            logger.error("Agent loop error: %s", loop_err)

        time.sleep(max(2, int(cfg.get("pollIntervalSeconds", 3))))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Smart Xerox Universal Windows Background Print Agent")
    parser.add_argument(
        "--list-printers-json",
        action="store_true",
        help="Enumerate all Windows printers, status, and capabilities as JSON and exit.",
    )
    parser.add_argument(
        "--include-virtual",
        action="store_true",
        help="Include virtual printers (PDF/XPS/OneNote/Fax) in main printers list.",
    )
    parser.add_argument(
        "--diagnose",
        action="store_true",
        help="Run printer discovery, backend connectivity, and agent diagnostics and exit.",
    )
    parser.add_argument(
        "--config",
        type=str,
        default=None,
        help="Path to JSON runtime config managed by the Smart Xerox Electron Desktop App.",
    )
    args = parser.parse_args()

    if args.list_printers_json:
        print(json.dumps(discover_all_windows_printers(include_virtual=args.include_virtual)))
        sys.exit(0)

    runtime_cfg = load_runtime_config(args.config)
    if args.diagnose:
        sys.exit(run_diagnostics(runtime_cfg))
    else:
        run_agent_loop(runtime_cfg, config_path=args.config)
