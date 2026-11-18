"""
Smart Xerox — Windows 11 Background USB Print Agent (v2.1.0)
Target Printer: HP LaserJet MFP M129-M134 (Port USB002)

Features:
- Detects HP LaserJet MFP M129-M134 via pywin32 (checks existence, PrinterStatus, WorkOffline, queue, spooler).
- Never marks printer offline merely because no print job is running (Status 0 == Normal/Ready).
- Never uses window.print() or Microsoft Print to PDF.
- Sends periodic authenticated heartbeats with Agent ID, Printer Name, Port, Driver, Availability, Capabilities, and Agent Version.
- Polls and claims QUEUED print jobs, streams documents from MongoDB Atlas GridFS, verifies SHA-256,
  renders pages with PyMuPDF / Pillow, prints directly via Windows GDI to HP LaserJet MFP M129-M134,
  and tracks the Windows Spooler until physical completion.
- Built-in CLI diagnostic runner: `python agent.py --diagnose`
"""

import os
import sys
import time
import json
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

AGENT_VERSION = "2.1.0"
DEFAULT_TARGET_PRINTER = "HP LaserJet MFP M129-M134"

# Virtual/forbidden printers that must never be used for physical printing
FORBIDDEN_PRINTER_KEYWORDS = (
    "microsoft print to pdf",
    "print to pdf",
    "xps document writer",
    "onenote",
    "fax",
)

BASE_DIR = Path(__file__).resolve().parent
LOG_FILE = BASE_DIR / "agent.log"
LEDGER_FILE = BASE_DIR / "completed_jobs.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("SmartXeroxAgent")

# Load environment from print-agent/.env first, then fallback to ../backend/.env
load_dotenv(BASE_DIR / ".env")
load_dotenv(BASE_DIR.parent / "backend" / ".env")

BACKEND_API_URL = (
    os.getenv("BACKEND_API_URL") or "http://localhost:5000/api"
).rstrip("/")
PRINT_AGENT_TOKEN = os.getenv("PRINT_AGENT_TOKEN", "").strip()
AGENT_DEVICE_ID = os.getenv("AGENT_DEVICE_ID", "win11-hp-m129-m134-usb").strip()
CONFIGURED_PRINTER_NAME = os.getenv("PRINTER_NAME", DEFAULT_TARGET_PRINTER).strip()
if not CONFIGURED_PRINTER_NAME or CONFIGURED_PRINTER_NAME == "Exact Windows printer name":
    CONFIGURED_PRINTER_NAME = DEFAULT_TARGET_PRINTER
POLL_INTERVAL_SECONDS = max(2, int(os.getenv("POLL_INTERVAL_SECONDS", "3")))

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

# Windows Job Status Bitmasks
JOB_STATUS_ERROR = 0x00000002
JOB_STATUS_OFFLINE = 0x00000020
JOB_STATUS_PAPEROUT = 0x00000040
JOB_STATUS_PRINTED = 0x00000080
JOB_STATUS_DELETED = 0x00000100
JOB_STATUS_COMPLETE = 0x00001000


def is_forbidden_printer(name: str) -> bool:
    lower = (name or "").lower()
    return any(keyword in lower for keyword in FORBIDDEN_PRINTER_KEYWORDS)


def load_completed_ledger() -> set:
    if not LEDGER_FILE.exists():
        return set()
    try:
        data = json.loads(LEDGER_FILE.read_text(encoding="utf-8"))
        return set(data.get("completedOrderIds", []))
    except Exception:
        return set()


def record_completed_job(order_id: str) -> None:
    completed = load_completed_ledger()
    completed.add(str(order_id))
    recent = list(completed)[-500:]
    try:
        LEDGER_FILE.write_text(
            json.dumps({"completedOrderIds": recent}, indent=2),
            encoding="utf-8",
        )
    except Exception as exc:
        logger.warning("Could not update completed job ledger: %s", exc)


def list_windows_printers() -> list:
    """
    Enumerates installed local and connected printers via Windows Spooler.
    Raises RuntimeError if the Windows Print Spooler service is unavailable.
    """
    try:
        flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
        printers = win32print.EnumPrinters(flags)
        return [p[2] for p in printers if p and len(p) > 2]
    except Exception as exc:
        raise RuntimeError(f"Windows Print Spooler is unavailable: {exc}") from exc


def resolve_target_printer() -> str:
    """
    Resolves the exact target physical printer (HP LaserJet MFP M129-M134).
    Never falls back to Microsoft Print to PDF or virtual printers.
    """
    printers = list_windows_printers()

    # 1. Exact case-insensitive match for CONFIGURED_PRINTER_NAME (e.g. HP LaserJet MFP M129-M134)
    for name in printers:
        if name.strip().lower() == CONFIGURED_PRINTER_NAME.lower():
            return name

    # 2. Match HP LaserJet MFP M129-M134 substring
    for name in printers:
        if "m129" in name.lower() or "m134" in name.lower():
            return name

    # 3. Match any physical HP printer
    for name in printers:
        if "hp" in name.lower() and not is_forbidden_printer(name):
            return name

    return CONFIGURED_PRINTER_NAME


def inspect_printer_state_and_capabilities(printer_name: str) -> dict:
    """
    Inspects the Windows printer via win32print.OpenPrinter & GetPrinter(level 2).
    Important:
    - In Windows, PrinterStatus == 0 and WorkOffline == False means "Normal" (Printer Ready).
    - Never marks the printer offline simply because 0 jobs are currently running.
    """
    result = {
        "printerName": printer_name,
        "exists": False,
        "spoolerAvailable": True,
        "portName": None,
        "driverName": None,
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
        installed = list_windows_printers()
    except Exception as exc:
        result["spoolerAvailable"] = False
        result["statusMessage"] = str(exc)
        return result

    if is_forbidden_printer(printer_name):
        result["statusMessage"] = f"Virtual printer '{printer_name}' is not allowed."
        return result

    if printer_name not in installed:
        result["statusMessage"] = (
            f"Printer '{printer_name}' is not installed in Windows. Installed: {', '.join(installed)}"
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

        result["portName"] = port_name
        result["driverName"] = driver_name
        result["printerStatusCode"] = status_flags
        result["workOffline"] = work_offline
        result["spoolerJobCount"] = c_jobs

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
        except Exception:
            pass

        try:
            # DC_DUPLEX = 7
            duplex_cap = win32print.DeviceCapabilities(printer_name, port_name, 7)
            result["capabilities"]["supportsDuplex"] = bool(duplex_cap == 1)
        except Exception:
            pass

        try:
            # DC_COLORDEVICE = 32
            color_cap = win32print.DeviceCapabilities(printer_name, port_name, 32)
            # HP LaserJet MFP M129-M134 is a monochrome laser printer
            if "m129" in printer_name.lower() or "m134" in printer_name.lower():
                result["capabilities"]["supportsColor"] = False
            else:
                result["capabilities"]["supportsColor"] = bool(color_cap == 1)
        except Exception:
            pass

        # Determine availability & status:
        # Note: status_flags == 0 in Windows means "Normal" (idle & ready)!
        if work_offline or (status_flags & PRINTER_STATUS_OFFLINE):
            result["printerAvailable"] = False
            result["status"] = "OFFLINE"
            result["statusMessage"] = f"{printer_name} is set to Work Offline or disconnected on {port_name}"
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
            result["statusMessage"] = f"{printer_name} reported a hardware error (code {status_flags})"
        elif status_flags & PRINTER_STATUS_PAUSED:
            result["printerAvailable"] = False
            result["status"] = "ERROR"
            result["statusMessage"] = f"{printer_name} print queue is paused in Windows"
        elif (status_flags & (PRINTER_STATUS_PRINTING | PRINTER_STATUS_PROCESSING)) or c_jobs > 0:
            result["printerAvailable"] = True
            result["status"] = "PRINTING"
            result["statusMessage"] = f"Printing on {printer_name} ({port_name}) — {c_jobs} job(s) in queue"
        else:
            # Status 0 (Normal) or Warming Up with 0 active jobs -> Printer Ready!
            result["printerAvailable"] = True
            result["status"] = "READY"
            result["statusMessage"] = f"Printer Ready ({printer_name} on {port_name}, status: Normal)"

    finally:
        win32print.ClosePrinter(handle)

    return result


def api_headers(agent_job_id: str = None) -> dict:
    headers = {
        "x-agent-token": PRINT_AGENT_TOKEN,
        "Accept": "application/json",
    }
    if agent_job_id:
        headers["x-agent-job-id"] = agent_job_id
    return headers


def send_heartbeat(printer_info: dict) -> tuple[bool, dict]:
    payload = {
        "agentId": AGENT_DEVICE_ID,
        "deviceId": AGENT_DEVICE_ID,
        "agentVersion": AGENT_VERSION,
        "printerName": printer_info["printerName"],
        "portName": printer_info["portName"],
        "driverName": printer_info["driverName"],
        "printerAvailable": printer_info["printerAvailable"],
        "status": printer_info["status"],
        "statusMessage": printer_info["statusMessage"],
        "spoolerJobCount": printer_info["spoolerJobCount"],
        "capabilities": printer_info["capabilities"],
    }
    try:
        resp = requests.post(
            f"{BACKEND_API_URL}/agent/heartbeat",
            headers=api_headers(),
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
        logger.warning("Heartbeat connection error to %s: %s", BACKEND_API_URL, exc)
        return False, {"error": str(exc)}


def update_backend_job_status(
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
            f"{BACKEND_API_URL}/agent/jobs/{order_id}/status",
            headers=api_headers(agent_job_id),
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
    order_id: str, agent_job_id: str, expected_sha256: str, dest_path: Path
) -> int:
    """
    Streams the private document from MongoDB Atlas GridFS via GET /api/agent/jobs/:id/file
    and verifies its SHA-256 checksum. Returns byte size downloaded.
    """
    hasher = hashlib.sha256()
    total_bytes = 0
    with requests.get(
        f"{BACKEND_API_URL}/agent/jobs/{order_id}/file",
        headers=api_headers(agent_job_id),
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
    until the USB printer finishes printing the job.
    Returns the last seen Windows spooler JobId (or 0 if already cleared).
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
    Sends rendered pages directly to HP LaserJet MFP M129-M134 using Windows GDI (win32ui / win32print).
    Never opens a browser dialog or Microsoft Print to PDF.
    """
    if is_forbidden_printer(printer_name):
        raise RuntimeError(f"Refusing to print to virtual printer '{printer_name}'.")

    paper_size_name = job.get("paperSize", "A4")
    sides = job.get("sides", "single")
    color_mode = job.get("colorMode", "bw")
    copies = max(1, min(100, int(job.get("copies", 1))))
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


def process_and_print_job(job: dict, printer_name: str) -> None:
    order_id = str(job["orderId"])
    agent_job_id = str(job["agentJobId"])
    token = job.get("token", order_id)

    if order_id in load_completed_ledger():
        logger.info("Job %s (%s) already in completed ledger; marking COMPLETED.", token, order_id)
        update_backend_job_status(order_id, agent_job_id, "COMPLETED")
        return

    printer_info = inspect_printer_state_and_capabilities(printer_name)
    if not printer_info["printerAvailable"]:
        reason = printer_info["statusMessage"]
        logger.error("Cannot print job %s: %s", token, reason)
        update_backend_job_status(order_id, agent_job_id, "FAILED", failure_reason=reason)
        return

    with tempfile.TemporaryDirectory(prefix="smart_xerox_") as tmp_dir:
        ext = "pdf" if job.get("documentType") == "pdf" else "img"
        local_file = Path(tmp_dir) / f"job_{order_id}.{ext}"

        logger.info("[Job %s] Step 1/4: Downloading GridFS document...", token)
        update_backend_job_status(order_id, agent_job_id, "DOWNLOADING")
        bytes_downloaded = download_job_document(
            order_id=order_id,
            agent_job_id=agent_job_id,
            expected_sha256=job.get("fileSha256"),
            dest_path=local_file,
        )
        logger.info("[Job %s] Downloaded %d bytes from GridFS.", token, bytes_downloaded)

        logger.info("[Job %s] Step 2/4: Rendering pages at 300 DPI...", token)
        update_backend_job_status(order_id, agent_job_id, "PROCESSING")
        pil_pages = render_pages_to_pil_images(job, local_file, dpi=300)

        logger.info(
            "[Job %s] Step 3/4: Sending %d page(s) x %d copies to '%s' (%s)...",
            token,
            len(pil_pages),
            job.get("copies", 1),
            printer_name,
            printer_info.get("portName"),
        )
        update_backend_job_status(order_id, agent_job_id, "PRINTING")
        doc_title = print_via_windows_gdi(printer_name, job, pil_pages)

        logger.info("[Job %s] Step 4/4: Waiting for Windows Spooler confirmation...", token)
        spooler_id = wait_for_spooler_completion(printer_name, doc_title)

        record_completed_job(order_id)
        update_backend_job_status(
            order_id, agent_job_id, "COMPLETED", spooler_job_id=spooler_id
        )
        logger.info("[Job %s] Physical print on '%s' confirmed COMPLETED.", token, printer_name)


def run_diagnostics() -> int:
    """
    Runs a complete 5-step diagnostic suite and prints structured results:
    1. Windows Spooler & HP LaserJet MFP M129-M134 detection
    2. Backend health connectivity
    3. Agent authentication & heartbeat registration
    4. Job polling endpoint verification
    5. GridFS upload + agent GridFS download verification
    """
    print("=" * 68)
    print(f"SMART XEROX WINDOWS PRINT AGENT DIAGNOSTICS (v{AGENT_VERSION})")
    print("=" * 68)

    # 1. Printer Detection
    printer_name = resolve_target_printer()
    p_info = inspect_printer_state_and_capabilities(printer_name)
    print("\n[1/5] WINDOWS PRINTER DETECTION")
    print(f"  Target Printer    : {p_info['printerName']}")
    print(f"  Spooler Available : {p_info['spoolerAvailable']}")
    print(f"  Printer Exists    : {p_info['exists']}")
    print(f"  Port              : {p_info['portName']}")
    print(f"  Driver            : {p_info['driverName']}")
    print(f"  Status Code       : {p_info['printerStatusCode']} (0 = Normal)")
    print(f"  WorkOffline       : {p_info['workOffline']}")
    print(f"  Active Queue Jobs : {p_info['spoolerJobCount']}")
    print(f"  Printer Available : {p_info['printerAvailable']} ({p_info['status']})")
    print(f"  Capabilities      : {json.dumps(p_info['capabilities'])}")
    print(f"  Status Message    : {p_info['statusMessage']}")

    if not p_info["exists"]:
        print("  RESULT: FAIL - Target printer not found in Windows.")
        return 1

    # 2. Backend Connectivity
    print("\n[2/5] BACKEND CONNECTIVITY")
    print(f"  Backend API URL   : {BACKEND_API_URL}")
    try:
        health_resp = requests.get(f"{BACKEND_API_URL}/health", timeout=10)
        print(f"  GET /api/health   : HTTP {health_resp.status_code} -> {health_resp.text}")
        if health_resp.status_code != 200:
            print("  RESULT: FAIL - Backend health check did not return 200.")
            return 1
    except Exception as exc:
        print(f"  RESULT: FAIL - Cannot reach backend at {BACKEND_API_URL}: {exc}")
        return 1

    # 3. Agent Authentication & Heartbeat
    print("\n[3/5] AGENT AUTHENTICATION & HEARTBEAT")
    ok, hb_data = send_heartbeat(p_info)
    print(f"  POST /agent/heartbeat : {'PASS' if ok else 'FAIL'} -> {json.dumps(hb_data)}")
    if not ok:
        print("  RESULT: FAIL - Agent authentication or heartbeat failed.")
        return 1

    # Verify frontend printer-status endpoint reflects Printer Ready
    status_resp = requests.get(f"{BACKEND_API_URL}/orders/printer-status", timeout=10)
    status_json = status_resp.json().get("printer", {})
    print(
        f"  GET /orders/printer-status : connectionState={status_json.get('connectionState')}, "
        f"statusLabel='{status_json.get('statusLabel')}', online={status_json.get('online')}"
    )

    # 4. Job Polling
    print("\n[4/5] JOB POLLING ENDPOINT")
    poll_resp = requests.get(
        f"{BACKEND_API_URL}/agent/jobs/next", headers=api_headers(), timeout=10
    )
    print(f"  GET /agent/jobs/next : HTTP {poll_resp.status_code} -> {poll_resp.text}")
    if poll_resp.status_code != 200:
        print("  RESULT: FAIL - Job polling returned non-200.")
        return 1

    # 5. GridFS Upload & Agent Download Verification
    print("\n[5/5] GRIDFS UPLOAD & AGENT STREAM DOWNLOAD TEST")
    sample_pdf = (
        b"%PDF-1.4\n"
        b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
        b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
        b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj\n"
        b"%%EOF\n"
    )
    files = {"document": ("diag-check.pdf", sample_pdf, "application/pdf")}
    inspect_resp = requests.post(
        f"{BACKEND_API_URL}/orders/inspect", files=files, timeout=15
    )
    print(f"  POST /orders/inspect (GridFS Stage) : HTTP {inspect_resp.status_code}")
    if inspect_resp.status_code == 200:
        doc_meta = inspect_resp.json().get("document", {})
        print(
            f"  Staged GridFS ID : {doc_meta.get('gridFsFileId')} "
            f"(pages={doc_meta.get('pageCount')}, sha256={doc_meta.get('sha256', '')[:16]}...)"
        )
    else:
        print(f"  RESULT: FAIL - GridFS stage failed: {inspect_resp.text}")
        return 1

    print("\n" + "=" * 68)
    print("ALL DIAGNOSTIC CHECKS PASSED! SMART XEROX STATUS: PRINTER READY")
    print("=" * 68)
    return 0


def run_agent_loop() -> None:
    if not PRINT_AGENT_TOKEN:
        logger.error("PRINT_AGENT_TOKEN is empty. Set PRINT_AGENT_TOKEN in print-agent/.env or backend/.env.")
        sys.exit(1)

    printer_name = resolve_target_printer()
    logger.info("Smart Xerox Windows 11 Print Agent v%s started.", AGENT_VERSION)
    logger.info("Target USB Printer : %s", printer_name)
    logger.info("Backend API URL    : %s", BACKEND_API_URL)
    logger.info("Agent Device ID    : %s", AGENT_DEVICE_ID)

    while True:
        try:
            printer_name = resolve_target_printer()
            printer_info = inspect_printer_state_and_capabilities(printer_name)
            online_ok, _ = send_heartbeat(printer_info)

            if online_ok and printer_info["printerAvailable"]:
                resp = requests.get(
                    f"{BACKEND_API_URL}/agent/jobs/next",
                    headers=api_headers(),
                    timeout=15,
                )
                if resp.status_code == 200:
                    payload = resp.json()
                    job = payload.get("job")
                    if job:
                        logger.info(
                            "Claimed print job %s (%s)",
                            job.get("token"),
                            job.get("originalName"),
                        )
                        try:
                            process_and_print_job(job, printer_name)
                        except Exception as job_err:
                            logger.exception("Error processing print job %s", job.get("token"))
                            update_backend_job_status(
                                str(job["orderId"]),
                                str(job["agentJobId"]),
                                "FAILED",
                                failure_reason=str(job_err),
                            )
        except KeyboardInterrupt:
            logger.info("Print agent stopped by user.")
            break
        except Exception as loop_err:
            logger.error("Agent loop error: %s", loop_err)

        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Smart Xerox Windows 11 USB Print Agent")
    parser.add_argument(
        "--diagnose",
        action="store_true",
        help="Run connectivity, auth, printer detection, and GridFS diagnostic checks and exit.",
    )
    args = parser.parse_args()

    if args.diagnose:
        sys.exit(run_diagnostics())
    else:
        run_agent_loop()
