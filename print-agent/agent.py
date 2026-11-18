"""
Smart Xerox — Multi-Vendor Windows Background Print Agent (v3.0.0)

Features:
- Multi-printer Windows discovery via pywin32 (USB & Network printers, default printer, ports, drivers, status, capabilities).
- Never marks a printer offline merely because no print job is running (Status 0 == Normal/Ready).
- Never uses window.print() or virtual printers (Microsoft Print to PDF, XPS, OneNote, Fax).
- Authenticates with unique, revocable per-agent credentials (x-agent-id + x-agent-secret).
- Sends periodic heartbeats with full availablePrinters list and syncs vendor's selectedPrinterName.
- Claims tenant-isolated QUEUED print jobs, streams documents from MongoDB Atlas GridFS, verifies SHA-256,
  renders pages at 300 DPI with PyMuPDF / Pillow, prints via Windows GDI, and waits for Windows Spooler confirmation.
- Supports CLI modes for Electron Desktop App integration:
  - `python agent.py --list-printers-json`
  - `python agent.py --diagnose`
  - `python agent.py --config <config.json>`
"""

import os
import sys
import time
import json
import socket
import platform
import argparse
import hashlib
import logging
import tempfile
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

AGENT_VERSION = "3.0.0"
DEFAULT_TARGET_PRINTER = "HP LaserJet MFP M129-M134"

# Virtual/forbidden printers that must never be used for physical printing
FORBIDDEN_PRINTER_KEYWORDS = (
    "microsoft print to pdf",
    "print to pdf",
    "xps document writer",
    "onenote",
    "fax",
    "send to onenote",
)

BASE_DIR = Path(__file__).resolve().parent
APPDATA_DIR = Path(os.getenv("APPDATA") or str(BASE_DIR)) / "SmartXerox"
try:
    APPDATA_DIR.mkdir(parents=True, exist_ok=True)
except Exception:
    APPDATA_DIR = BASE_DIR

LOG_FILE = APPDATA_DIR / "agent.log"
LEDGER_FILE = APPDATA_DIR / "completed_jobs.json"

# Windows DMPAPER constants
PAPER_SIZE_MAP = {
    "A4": win32con.DMPAPER_A4,          # 9
    "A3": win32con.DMPAPER_A3,          # 8
    "Legal": win32con.DMPAPER_LEGAL,    # 5
    "Letter": win32con.DMPAPER_LETTER,  # 1
    "A5": win32con.DMPAPER_A5,          # 11
}

# Windows Printer Status Bitmasks (winspool.h)
PRINTER_STATUS_PAUSED = 0x00000001
PRINTER_STATUS_ERROR = 0x00000002
PRINTER_STATUS_PAPER_JAM = 0x00000008
PRINTER_STATUS_PAPER_OUT = 0x00000010
PRINTER_STATUS_OFFLINE = 0x00000080
PRINTER_STATUS_PRINTING = 0x00000400
PRINTER_STATUS_PROCESSING = 0x00004000
PRINTER_STATUS_WARMING_UP = 0x00010000
PRINTER_STATUS_DOOR_OPEN = 0x00400000
PRINTER_STATUS_USER_INTERVENTION = 0x00100000

PRINTER_ATTRIBUTE_WORK_OFFLINE = 0x00000400
PRINTER_ATTRIBUTE_NETWORK = 0x00000010
PRINTER_ATTRIBUTE_LOCAL = 0x00000040

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


def is_forbidden_printer(name: str) -> bool:
    lower = (name or "").lower()
    return any(keyword in lower for keyword in FORBIDDEN_PRINTER_KEYWORDS)


def classify_connection_type(port_name: str, attributes: int = 0) -> str:
    port_upper = (port_name or "").upper()
    if "USB" in port_upper or "DOT4" in port_upper:
        return "USB"
    if (
        (attributes & PRINTER_ATTRIBUTE_NETWORK)
        or port_upper.startswith("IP_")
        or port_upper.startswith("WSD")
        or port_upper.startswith("TCP")
        or port_upper.startswith("HTTP")
        or port_upper.startswith("\\\\")
    ):
        return "NETWORK"
    if port_upper:
        return "LOCAL"
    return "UNKNOWN"


def get_default_windows_printer() -> str:
    try:
        return str(win32print.GetDefaultPrinter() or "").strip()
    except Exception:
        return ""


def list_windows_printers(include_virtual: bool = False) -> list:
    """
    Enumerates installed local and network printers via Windows Print Spooler.
    Filters out virtual printers (Print to PDF, XPS, OneNote, Fax) unless include_virtual=True.
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


def inspect_printer_state_and_capabilities(printer_name: str, default_printer: str = None) -> dict:
    """
    Inspects a Windows printer via win32print.OpenPrinter & GetPrinter(level 2).
    Note: PrinterStatus == 0 and WorkOffline == False in Windows means Normal (Idle & Ready).
    """
    if default_printer is None:
        default_printer = get_default_windows_printer()

    result = {
        "name": printer_name,
        "printerName": printer_name,
        "exists": False,
        "spoolerAvailable": True,
        "portName": None,
        "driverName": None,
        "connectionType": "USB",
        "isDefault": bool(
            default_printer and printer_name.strip().lower() == default_printer.lower()
        ),
        "driverMissing": False,
        "capabilitiesDetected": False,
        "printerStatusCode": None,
        "workOffline": False,
        "printerAvailable": False,
        "status": "OFFLINE",
        "statusMessage": f"Printer '{printer_name}' not found in Windows",
        "spoolerJobCount": 0,
        "capabilities": {
            "supportedPaperSizes": ["A4", "Letter", "Legal", "A5"],
            "supportsColor": False,
            "supportsDuplex": False,
        },
    }

    try:
        installed = list_windows_printers(include_virtual=False)
    except Exception as exc:
        result["spoolerAvailable"] = False
        result["statusMessage"] = str(exc)
        return result

    if is_forbidden_printer(printer_name):
        result["statusMessage"] = f"Virtual printer '{printer_name}' is not allowed."
        return result

    if printer_name not in installed:
        result["statusMessage"] = (
            f"Printer '{printer_name}' is not connected or installed in Windows."
        )
        return result

    result["exists"] = True

    try:
        handle = win32print.OpenPrinter(printer_name)
    except Exception as exc:
        result["statusMessage"] = f"Cannot open printer '{printer_name}': {exc}"
        return result

    try:
        info2 = win32print.GetPrinter(handle, 2)
        status_flags = int(info2.get("Status", 0))
        attributes = int(info2.get("Attributes", 0))
        c_jobs = int(info2.get("cJobs", 0))
        port_name = str(info2.get("pPortName", "") or "")
        driver_name = str(info2.get("pDriverName", "") or "")

        work_offline = bool(attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE)
        driver_missing = not bool(driver_name.strip())

        result["portName"] = port_name
        result["driverName"] = driver_name
        result["driverMissing"] = driver_missing
        result["connectionType"] = classify_connection_type(port_name, attributes)
        result["printerStatusCode"] = status_flags
        result["workOffline"] = work_offline
        result["spoolerJobCount"] = c_jobs

        caps_detected = False
        # Query hardware capabilities from driver via DeviceCapabilities
        try:
            # DC_PAPERS = 2
            paper_codes = win32print.DeviceCapabilities(printer_name, port_name, 2)
            if paper_codes:
                supported_sizes = [
                    label for label, code in PAPER_SIZE_MAP.items() if code in paper_codes
                ]
                if supported_sizes:
                    result["capabilities"]["supportedPaperSizes"] = supported_sizes
                    caps_detected = True
        except Exception:
            pass

        try:
            # DC_DUPLEX = 7
            duplex_cap = win32print.DeviceCapabilities(printer_name, port_name, 7)
            result["capabilities"]["supportsDuplex"] = bool(duplex_cap == 1)
            caps_detected = True
        except Exception:
            pass

        try:
            # DC_COLORDEVICE = 32
            color_cap = win32print.DeviceCapabilities(printer_name, port_name, 32)
            if "m129" in printer_name.lower() or "m134" in printer_name.lower():
                result["capabilities"]["supportsColor"] = False
            else:
                result["capabilities"]["supportsColor"] = bool(color_cap == 1)
            caps_detected = True
        except Exception:
            pass

        result["capabilitiesDetected"] = caps_detected

        if driver_missing:
            result["printerAvailable"] = False
            result["status"] = "ERROR"
            result["statusMessage"] = (
                f"Windows printer driver is missing for {printer_name}. Please install the appropriate Windows driver."
            )
        elif work_offline or (status_flags & PRINTER_STATUS_OFFLINE):
            result["printerAvailable"] = False
            result["status"] = "OFFLINE"
            result["statusMessage"] = (
                f"{printer_name} is offline or disconnected ({port_name})"
            )
        elif status_flags & PRINTER_STATUS_PAPER_OUT:
            result["printerAvailable"] = False
            result["status"] = "ERROR"
            result["statusMessage"] = f"{printer_name} is out of paper"
        elif status_flags & PRINTER_STATUS_PAPER_JAM:
            result["printerAvailable"] = False
            result["status"] = "ERROR"
            result["statusMessage"] = f"Paper jam on {printer_name}"
        elif status_flags & PRINTER_STATUS_DOOR_OPEN:
            result["printerAvailable"] = False
            result["status"] = "ERROR"
            result["statusMessage"] = f"Cover/door open on {printer_name}"
        elif status_flags & (PRINTER_STATUS_ERROR | PRINTER_STATUS_USER_INTERVENTION):
            result["printerAvailable"] = False
            result["status"] = "ERROR"
            result["statusMessage"] = (
                f"{printer_name} reported a hardware error (code {status_flags})"
            )
        elif status_flags & PRINTER_STATUS_PAUSED:
            result["printerAvailable"] = False
            result["status"] = "ERROR"
            result["statusMessage"] = f"{printer_name} print queue is paused in Windows"
        elif (status_flags & (PRINTER_STATUS_PRINTING | PRINTER_STATUS_PROCESSING)) or c_jobs > 0:
            result["printerAvailable"] = True
            result["status"] = "PRINTING"
            result["statusMessage"] = (
                f"Printing on {printer_name} ({port_name}) — {c_jobs} job(s) in queue"
            )
        else:
            result["printerAvailable"] = True
            result["status"] = "READY"
            result["statusMessage"] = (
                f"Printer Ready ({printer_name} on {port_name})"
            )

    finally:
        win32print.ClosePrinter(handle)

    return result


def discover_all_windows_printers() -> dict:
    """
    Discovers all compatible Windows printers (USB, Network, Local) and their live status & capabilities.
    """
    default_printer = get_default_windows_printer()
    try:
        names = list_windows_printers(include_virtual=False)
    except Exception as exc:
        return {
            "success": False,
            "spoolerAvailable": False,
            "defaultPrinter": default_printer or None,
            "error": str(exc),
            "printers": [],
        }

    printers = []
    for name in names:
        info = inspect_printer_state_and_capabilities(name, default_printer=default_printer)
        printers.append(info)

    # Sort: available USB printers first, then default printer, then alphabetical
    printers.sort(
        key=lambda p: (
            not p.get("printerAvailable", False),
            p.get("connectionType") != "USB",
            not p.get("isDefault", False),
            p.get("name", "").lower(),
        )
    )

    return {
        "success": True,
        "spoolerAvailable": True,
        "defaultPrinter": default_printer if not is_forbidden_printer(default_printer) else None,
        "printers": printers,
    }


def resolve_target_printer(preferred_name: str = None, discovered_printers: list = None) -> str:
    """
    Resolves the best physical target printer:
    1. Exact match for vendor's preferred_name if installed.
    2. If only 1 physical printer is installed, select it automatically.
    3. Match HP LaserJet or default physical printer.
    """
    if discovered_printers is None:
        discovery = discover_all_windows_printers()
        discovered_printers = discovery.get("printers", [])

    names = [p["name"] for p in discovered_printers]

    if preferred_name and not is_forbidden_printer(preferred_name):
        for name in names:
            if name.strip().lower() == preferred_name.strip().lower():
                return name

    if len(names) == 1:
        return names[0]

    for p in discovered_printers:
        if p.get("isDefault") and p.get("printerAvailable"):
            return p["name"]

    for p in discovered_printers:
        if p.get("printerAvailable"):
            return p["name"]

    if names:
        return names[0]

    return preferred_name or DEFAULT_TARGET_PRINTER


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
        "portName": primary_printer["portName"],
        "driverName": primary_printer["driverName"],
        "driverMissing": primary_printer.get("driverMissing", False),
        "printerAvailable": primary_printer["printerAvailable"],
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


def render_pages_to_pil_images(job: dict, file_path: Path, dpi: int = 300) -> list:
    """
    Uses PyMuPDF (for PDFs) or Pillow (for JPG/PNG images) to prepare the exact selected pages,
    colour mode (B&W grayscale vs Colour), and orientation into 300 DPI PIL Images.
    """
    doc_type = job.get("documentType", "pdf")
    color_mode = job.get("colorMode", "bw")
    requested_orientation = job.get("orientation", "auto")
    selected_pages = job.get("selectedPages") or [1]

    pil_pages = []

    if doc_type == "image":
        img = Image.open(file_path)
        img = ImageOps.exif_transpose(img)
        if color_mode == "bw":
            img = img.convert("L").convert("RGB")
        else:
            img = img.convert("RGB")

        is_img_landscape = img.width > img.height
        if requested_orientation == "portrait" and is_img_landscape:
            img = img.rotate(90, expand=True)
        elif requested_orientation == "landscape" and not is_img_landscape:
            img = img.rotate(90, expand=True)

        pil_pages.append(img)
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

            is_page_landscape = img.width > img.height
            if requested_orientation == "portrait" and is_page_landscape:
                img = img.rotate(90, expand=True)
            elif requested_orientation == "landscape" and not is_page_landscape:
                img = img.rotate(90, expand=True)

            pil_pages.append(img)
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
    finally:
        win32print.ClosePrinter(handle)

    hdc = win32ui.CreateDC()
    hdc.CreatePrinterDC(printer_name)

    try:
        printable_width = hdc.GetDeviceCaps(win32con.HORZRES)
        printable_height = hdc.GetDeviceCaps(win32con.VERTRES)

        hdc.StartDoc(doc_title)
        try:
            for _copy_idx in range(copies):
                for page_img in pil_pages:
                    hdc.StartPage()

                    img_w, img_h = page_img.size
                    scale = min(
                        printable_width / float(img_w), printable_height / float(img_h)
                    )
                    draw_w = int(img_w * scale)
                    draw_h = int(img_h * scale)
                    offset_x = max(0, (printable_width - draw_w) // 2)
                    offset_y = max(0, (printable_height - draw_h) // 2)

                    dib = ImageWin.Dib(page_img)
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
        "backendApiUrl": (os.getenv("BACKEND_API_URL") or "http://localhost:5000/api").rstrip("/"),
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
    print(f"SMART XEROX WINDOWS PRINT AGENT DIAGNOSTICS (v{AGENT_VERSION})")
    print("=" * 68)

    discovery = discover_all_windows_printers()
    printers = discovery.get("printers", [])
    print("\n[1/3] WINDOWS MULTI-PRINTER DISCOVERY")
    print(f"  Spooler Available : {discovery.get('spoolerAvailable')}")
    print(f"  Default Printer   : {discovery.get('defaultPrinter')}")
    print(f"  Detected Printers : {len(printers)}")
    for idx, p in enumerate(printers, 1):
        print(
            f"    {idx}. {p['name']} [{p['connectionType']} on {p['portName']}] -> "
            f"{p['status']} (available={p['printerAvailable']}, color={p['capabilities']['supportsColor']}, "
            f"duplex={p['capabilities']['supportsDuplex']}, sizes={p['capabilities']['supportedPaperSizes']})"
        )

    target_printer = resolve_target_printer(cfg.get("selectedPrinterName"), printers)
    p_info = inspect_printer_state_and_capabilities(target_printer)
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

    logger.info("Smart Xerox Windows Print Agent v%s started.", AGENT_VERSION)
    logger.info("Backend API URL : %s", cfg["backendApiUrl"])

    preferred_printer = cfg.get("selectedPrinterName") or ""

    while True:
        try:
            # Reload runtime config on each tick if managed by Electron Desktop App
            if config_path and Path(config_path).exists():
                latest = load_runtime_config(config_path)
                cfg.update(latest)
                if latest.get("selectedPrinterName"):
                    preferred_printer = latest["selectedPrinterName"]

            agent_id = cfg.get("agentId", "").strip()
            agent_secret = cfg.get("agentSecret", "").strip()
            backend_url = cfg["backendApiUrl"]
            device_id = cfg.get("deviceId") or f"win-{socket.gethostname()}"

            discovery = discover_all_windows_printers()
            discovered_list = discovery.get("printers", [])
            target_printer_name = resolve_target_printer(preferred_printer, discovered_list)
            primary_info = inspect_printer_state_and_capabilities(target_printer_name)

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
                server_selected = hb_resp.get("tenant", {}).get("selectedPrinterName")
                if server_selected and server_selected != preferred_printer:
                    preferred_printer = server_selected
                    target_printer_name = resolve_target_printer(preferred_printer, discovered_list)
                    primary_info = inspect_printer_state_and_capabilities(target_printer_name)

            if online_ok and primary_info["printerAvailable"]:
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
                        resolved_job_printer = resolve_target_printer(job_printer, discovered_list)
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
            break
        except Exception as loop_err:
            logger.error("Agent loop error: %s", loop_err)

        time.sleep(max(2, int(cfg.get("pollIntervalSeconds", 3))))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Smart Xerox Windows Background Print Agent")
    parser.add_argument(
        "--list-printers-json",
        action="store_true",
        help="Enumerate all Windows printers, status, and capabilities as JSON and exit.",
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
        print(json.dumps(discover_all_windows_printers()))
        sys.exit(0)

    runtime_cfg = load_runtime_config(args.config)
    if args.diagnose:
        sys.exit(run_diagnostics(runtime_cfg))
    else:
        run_agent_loop(runtime_cfg, config_path=args.config)
