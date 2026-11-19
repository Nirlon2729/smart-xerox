"""
Automated Universal Windows Printer Detection & Printing Test Suite
Covers all 14 required test scenarios using mocked Win32 Print Spooler APIs
plus real PyMuPDF / Pillow 300 DPI document rendering verification.
"""

import io
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock
from PIL import Image

import agent


class FakeDevMode:
    def __init__(self, paper_size=9, color=1, fields=0):
        self.PaperSize = paper_size
        self.Color = color
        self.Duplex = 1
        self.Orientation = 1
        self.Fields = fields


def build_mock_spooler(printers_db: dict, default_printer: str = ""):
    """
    Creates mock functions for win32print.EnumPrinters, GetDefaultPrinter, OpenPrinter,
    ClosePrinter, GetPrinter, and DeviceCapabilities based on `printers_db`.
    """

    def mock_enum_printers(_flags):
        return [(0, "", name, "") for name in printers_db.keys()]

    def mock_get_default_printer():
        return default_printer

    def mock_open_printer(name):
        if name not in printers_db:
            raise RuntimeError(f"Printer {name} not found")
        return f"HANDLE::{name}"

    def mock_close_printer(_handle):
        return None

    def mock_get_printer(handle, level):
        assert level == 2
        name = handle.split("HANDLE::", 1)[1]
        spec = printers_db[name]
        return {
            "Status": spec.get("status", 0),
            "Attributes": spec.get("attributes", agent.PRINTER_ATTRIBUTE_LOCAL),
            "cJobs": spec.get("jobs", 0),
            "pPortName": spec.get("port", "USB001"),
            "pDriverName": spec.get("driver", f"{name} Driver"),
            "pDevMode": spec.get("devmode", FakeDevMode()),
        }

    def mock_device_capabilities(name, _port, index):
        spec = printers_db[name]
        if spec.get("caps_error"):
            raise RuntimeError("Driver does not expose DeviceCapabilities")
        caps = spec.get("caps", {})
        if index == agent.DC_PAPERS:
            return caps.get("papers", (9, 1, 5, 11))  # A4, Letter, Legal, A5
        if index == agent.DC_DUPLEX:
            return caps.get("duplex", 0)
        if index == agent.DC_COLORDEVICE:
            return caps.get("color", 0)
        if index == agent.DC_COPIES:
            return caps.get("copies", 99)
        if index == agent.DC_ORIENTATION:
            return caps.get("orientation", 90)
        if index == agent.DC_ENUMRESOLUTIONS:
            return caps.get("resolutions", ((300, 300), (600, 600)))
        return 0

    return (
        mock_enum_printers,
        mock_get_default_printer,
        mock_open_printer,
        mock_close_printer,
        mock_get_printer,
        mock_device_capabilities,
    )


class UniversalPrinterTests(unittest.TestCase):
    def _patch_win32print(self, printers_db: dict, default_printer: str = ""):
        enum_p, def_p, open_p, close_p, get_p, dev_caps = build_mock_spooler(
            printers_db, default_printer
        )
        return patch.multiple(
            agent.win32print,
            EnumPrinters=enum_p,
            GetDefaultPrinter=def_p,
            OpenPrinter=open_p,
            ClosePrinter=close_p,
            GetPrinter=get_p,
            DeviceCapabilities=dev_caps,
        )

    def test_01_single_hp_usb_printer_auto_selected(self):
        db = {
            "HP LaserJet MFP M129-M134": {
                "port": "USB002",
                "driver": "HP LaserJet MFP M129-M134 PCLm-S",
                "caps": {"papers": (9, 11, 1, 5), "color": 0, "duplex": 1, "copies": 9999},
            }
        }
        with self._patch_win32print(db, "HP LaserJet MFP M129-M134"):
            disc = agent.discover_all_windows_printers()
            self.assertEqual(len(disc["physicalPrinters"]), 1)
            p = disc["physicalPrinters"][0]
            self.assertEqual(p["manufacturer"], "HP")
            self.assertEqual(p["model"], "LaserJet MFP M129-M134")
            self.assertEqual(p["connectionType"], "USB")
            self.assertEqual(p["printerCategory"], "PHYSICAL")
            self.assertTrue(p["printerAvailable"])
            self.assertFalse(p["capabilities"]["supportsColor"])
            self.assertTrue(p["capabilities"]["supportsDuplex"])
            selected = agent.resolve_target_printer(None, disc["physicalPrinters"])
            self.assertEqual(selected, "HP LaserJet MFP M129-M134")

    def test_02_single_canon_printer(self):
        db = {
            "Canon PIXMA G3010 series": {
                "port": "USB001",
                "driver": "Canon G3010 series Printer",
                "caps": {"papers": (9, 11, 1, 5), "color": 1, "duplex": 0, "copies": 99},
            }
        }
        with self._patch_win32print(db, "Canon PIXMA G3010 series"):
            disc = agent.discover_all_windows_printers()
            p = disc["physicalPrinters"][0]
            self.assertEqual(p["manufacturer"], "Canon")
            self.assertEqual(p["model"], "PIXMA G3010 series")
            self.assertTrue(p["capabilities"]["supportsColor"])
            self.assertFalse(p["capabilities"]["supportsDuplex"])
            self.assertEqual(
                agent.resolve_target_printer("", disc["physicalPrinters"]),
                "Canon PIXMA G3010 series",
            )

    def test_03_single_epson_wifi_printer(self):
        db = {
            "EPSON EcoTank L3250 Series": {
                "port": "WSD-88412f9a.0032",
                "driver": "EPSON L3250 Series",
                "caps": {"papers": (9, 8, 11, 1, 5), "color": 1, "duplex": 0, "copies": 99},
            }
        }
        with self._patch_win32print(db):
            disc = agent.discover_all_windows_printers()
            p = disc["physicalPrinters"][0]
            self.assertEqual(p["manufacturer"], "Epson")
            self.assertEqual(p["connectionType"], "WIFI")
            self.assertEqual(p["printerCategory"], "PHYSICAL")
            self.assertIn("A3", p["capabilities"]["supportedPaperSizes"])
            self.assertTrue(p["capabilities"]["supportsColor"])

    def test_04_single_brother_duplex_laser_printer(self):
        db = {
            "Brother HL-L2321D series": {
                "port": "USB003",
                "driver": "Brother HL-L2321D series",
                "caps": {"papers": (9, 1, 5, 11, 13, 7), "color": 0, "duplex": 1, "copies": 999},
            }
        }
        with self._patch_win32print(db):
            disc = agent.discover_all_windows_printers()
            p = disc["physicalPrinters"][0]
            self.assertEqual(p["manufacturer"], "Brother")
            self.assertEqual(p["model"], "HL-L2321D series")
            self.assertFalse(p["capabilities"]["supportsColor"])
            self.assertTrue(p["capabilities"]["supportsDuplex"])
            self.assertIn("B5", p["capabilities"]["supportedPaperSizes"])
            self.assertIn("Executive", p["capabilities"]["supportedPaperSizes"])

    def test_05_multiple_printers_connected_and_selection_preservation(self):
        db = {
            "HP LaserJet Pro M404dn": {
                "port": "USB001",
                "driver": "HP PCL 6",
                "caps": {"papers": (9, 1, 5), "color": 0, "duplex": 1},
            },
            "Canon imageRUNNER 2625i": {
                "port": "IP_192.168.1.20",
                "driver": "Canon Generic Plus UFR II",
                "caps": {"papers": (9, 8, 5), "color": 0, "duplex": 1},
            },
            "Kyocera ECOSYS M2040dn": {
                "port": "USB002",
                "driver": "Kyocera ECOSYS M2040dn KX",
                "caps": {"papers": (9, 5, 11), "color": 0, "duplex": 1},
            },
            "Pantum P2500W Series": {
                "port": "USB003",
                "driver": "Pantum P2500W",
                "caps": {"papers": (9, 1), "color": 0, "duplex": 0},
            },
        }
        with self._patch_win32print(db):
            disc = agent.discover_all_windows_printers()
            self.assertEqual(len(disc["physicalPrinters"]), 4)
            brands = {p["manufacturer"] for p in disc["physicalPrinters"]}
            self.assertEqual(brands, {"HP", "Canon", "Kyocera", "Pantum"})

            # When no printer is selected yet and >1 physical printers exist, require manual selection
            unselected = agent.resolve_target_printer("", disc["physicalPrinters"])
            self.assertEqual(unselected, "")
            unselected_state = agent.build_unselected_printer_state(disc["physicalPrinters"])
            self.assertTrue(unselected_state["requiresManualSelection"])

            # Once vendor selects Kyocera, connecting other printers must NOT change selection
            selected = agent.resolve_target_printer(
                "Kyocera ECOSYS M2040dn", disc["physicalPrinters"]
            )
            self.assertEqual(selected, "Kyocera ECOSYS M2040dn")

    def test_06_network_and_shared_printers(self):
        db = {
            "Xerox VersaLink C405": {
                "port": "IP_192.168.10.45",
                "driver": "Xerox Global Print Driver PCL6",
                "attributes": agent.PRINTER_ATTRIBUTE_NETWORK,
                "caps": {"papers": (9, 8, 1, 5), "color": 1, "duplex": 1},
            },
            "\\\\PRINT-SRV\\Ricoh IM C2000": {
                "port": "\\\\PRINT-SRV\\Ricoh",
                "driver": "RICOH IM C2000 PCL 6",
                "attributes": agent.PRINTER_ATTRIBUTE_SHARED,
                "caps": {"papers": (9, 8, 1, 5), "color": 1, "duplex": 1},
            },
            "Lexmark MS431dn": {
                "port": "TCP_10.0.0.88",
                "driver": "Lexmark Universal v2 XL",
                "caps": {"papers": (9, 1, 5), "color": 0, "duplex": 1},
            },
            "Samsung Xpress M2876FD": {
                "port": "IP_192.168.1.99",
                "driver": "Samsung Universal Print Driver 3",
                "caps": {"papers": (9, 1, 5), "color": 0, "duplex": 1},
            },
        }
        with self._patch_win32print(db):
            disc = agent.discover_all_windows_printers()
            by_name = {p["name"]: p for p in disc["physicalPrinters"]}
            self.assertEqual(by_name["Xerox VersaLink C405"]["connectionType"], "NETWORK")
            self.assertEqual(by_name["Xerox VersaLink C405"]["manufacturer"], "Xerox")
            self.assertEqual(by_name["\\\\PRINT-SRV\\Ricoh IM C2000"]["connectionType"], "SHARED")
            self.assertEqual(by_name["\\\\PRINT-SRV\\Ricoh IM C2000"]["manufacturer"], "Ricoh")
            self.assertEqual(by_name["Lexmark MS431dn"]["manufacturer"], "Lexmark")
            self.assertEqual(by_name["Samsung Xpress M2876FD"]["manufacturer"], "Samsung")

    def test_07_and_08_printer_disconnected_and_reconnected_during_runtime(self):
        # Step 1: Canon printer connected & ready
        db_online = {
            "Canon LBP2900": {
                "port": "USB001",
                "driver": "Canon CAPT USB",
                "status": 0,
                "attributes": agent.PRINTER_ATTRIBUTE_LOCAL,
                "caps": {"papers": (9,), "color": 0, "duplex": 0},
            }
        }
        with self._patch_win32print(db_online):
            disc1 = agent.discover_all_windows_printers()
            target1 = agent.resolve_target_printer("Canon LBP2900", disc1["physicalPrinters"])
            info1 = agent.inspect_printer_state_and_capabilities(target1)
            self.assertTrue(info1["printerAvailable"])
            self.assertEqual(info1["status"], "READY")

        # Step 2: Canon printer unplugged / work offline during runtime
        db_offline = {
            "Canon LBP2900": {
                "port": "USB001",
                "driver": "Canon CAPT USB",
                "status": agent.PRINTER_STATUS_OFFLINE,
                "attributes": agent.PRINTER_ATTRIBUTE_LOCAL | agent.PRINTER_ATTRIBUTE_WORK_OFFLINE,
                "caps": {"papers": (9,), "color": 0, "duplex": 0},
            }
        }
        with self._patch_win32print(db_offline):
            disc2 = agent.discover_all_windows_printers()
            target2 = agent.resolve_target_printer("Canon LBP2900", disc2["physicalPrinters"])
            self.assertEqual(target2, "Canon LBP2900")
            info2 = agent.inspect_printer_state_and_capabilities(target2)
            self.assertFalse(info2["printerAvailable"])
            self.assertEqual(info2["status"], "OFFLINE")

        # Step 3: Completely removed from enumerated list while selected -> keeps selection & reports OFFLINE
        with self._patch_win32print({}):
            disc3 = agent.discover_all_windows_printers()
            target3 = agent.resolve_target_printer("Canon LBP2900", disc3["physicalPrinters"])
            self.assertEqual(target3, "Canon LBP2900")
            info3 = agent.inspect_printer_state_and_capabilities(target3)
            self.assertFalse(info3["printerAvailable"])
            self.assertEqual(info3["status"], "OFFLINE")

        # Step 4: Reconnected -> automatically READY again
        with self._patch_win32print(db_online):
            info4 = agent.inspect_printer_state_and_capabilities("Canon LBP2900")
            self.assertTrue(info4["printerAvailable"])
            self.assertEqual(info4["status"], "READY")

    def test_09_and_10_capability_enforcement_no_color_and_no_duplex(self):
        mono_simplex_printer = {
            "name": "HP LaserJet 1020",
            "printerName": "HP LaserJet 1020",
            "printerCategory": "PHYSICAL",
            "isVirtual": False,
            "capabilities": {
                "supportedPaperSizes": ["A4", "Letter"],
                "paperSizesKnown": True,
                "supportsColor": False,
                "colorSupportKnown": True,
                "supportsDuplex": False,
                "duplexSupportKnown": True,
            },
        }
        # Reject colour job on B&W printer
        with self.assertRaisesRegex(ValueError, "does not support Colour"):
            agent.validate_job_against_printer_capabilities(
                {"colorMode": "color", "sides": "single", "paperSize": "A4"},
                mono_simplex_printer,
            )
        # Reject duplex job on single-sided printer
        with self.assertRaisesRegex(ValueError, "does not support automatic Duplex"):
            agent.validate_job_against_printer_capabilities(
                {"colorMode": "bw", "sides": "duplex", "paperSize": "A4"},
                mono_simplex_printer,
            )
        # Reject unsupported A3 paper size
        with self.assertRaisesRegex(ValueError, "does not support paper size 'A3'"):
            agent.validate_job_against_printer_capabilities(
                {"colorMode": "bw", "sides": "single", "paperSize": "A3"},
                mono_simplex_printer,
            )

    def test_11_virtual_and_unknown_printer_classification(self):
        db = {
            "Microsoft Print to PDF": {
                "port": "PORTPROMPT:",
                "driver": "Microsoft Print To PDF",
            },
            "Microsoft XPS Document Writer": {
                "port": "PORTPROMPT:",
                "driver": "Microsoft XPS Document Writer v4",
            },
            "OneNote (Desktop)": {
                "port": "nul:",
                "driver": "Send to Microsoft OneNote 16 Driver",
            },
            "Fax": {
                "port": "SHRFAX:",
                "driver": "Microsoft Shared Fax Driver",
            },
            # Brand name in a virtual PDF port must still be classified as VIRTUAL, never PHYSICAL
            "HP Document Print to PDF": {
                "port": "PORTPROMPT:",
                "driver": "HP PDF Writer",
            },
            # Ambiguous custom port without USB/Network/Virtual indicators -> classified as UNKNOWN
            "Custom Industrial Labeler": {
                "port": "CUSTOM_MON01:",
                "driver": "Generic Label Driver",
            },
            "Epson L3110 Series": {
                "port": "USB001",
                "driver": "EPSON L3110 Series",
            },
        }
        with self._patch_win32print(db):
            disc = agent.discover_all_windows_printers(include_virtual=False)
            phys_names = [p["name"] for p in disc["physicalPrinters"]]
            virt_names = [p["name"] for p in disc["virtualPrinters"]]

            self.assertIn("Epson L3110 Series", phys_names)
            self.assertIn("Custom Industrial Labeler", phys_names)
            self.assertNotIn("Microsoft Print to PDF", phys_names)
            self.assertNotIn("Microsoft XPS Document Writer", phys_names)
            self.assertNotIn("OneNote (Desktop)", phys_names)
            self.assertNotIn("Fax", phys_names)
            self.assertNotIn("HP Document Print to PDF", phys_names)

            self.assertEqual(len(virt_names), 5)

            by_name = {p["name"]: p for p in disc["physicalPrinters"]}
            self.assertEqual(by_name["Epson L3110 Series"]["printerCategory"], "PHYSICAL")
            self.assertEqual(by_name["Custom Industrial Labeler"]["printerCategory"], "UNKNOWN")

    def test_12_missing_or_incomplete_capability_information_safe_fallback(self):
        db = {
            "Legacy USB Printer": {
                "port": "USB004",
                "driver": "Legacy Driver",
                "caps_error": True,
                "devmode": None,
            }
        }
        with self._patch_win32print(db):
            info = agent.inspect_printer_state_and_capabilities("Legacy USB Printer")
            self.assertFalse(info["capabilitiesDetected"])
            caps = info["capabilities"]
            self.assertEqual(caps["supportedPaperSizes"], ["A4"])
            self.assertFalse(caps["paperSizesKnown"])
            self.assertFalse(caps["supportsColor"])
            self.assertFalse(caps["colorSupportKnown"])
            self.assertFalse(caps["supportsDuplex"])
            self.assertFalse(caps["duplexSupportKnown"])

    def test_13_switching_between_printers_updates_capabilities(self):
        db = {
            "HP LaserJet P1108": {
                "port": "USB001",
                "driver": "HP LaserJet Professional P1108",
                "caps": {"papers": (9, 1, 5), "color": 0, "duplex": 0},
            },
            "Canon imageRUNNER ADVANCE C3520i": {
                "port": "IP_192.168.1.200",
                "driver": "Canon Generic Plus PCL6",
                "caps": {"papers": (9, 8, 11, 1, 5), "color": 1, "duplex": 1},
            },
        }
        with self._patch_win32print(db):
            disc = agent.discover_all_windows_printers()
            p1 = agent.resolve_target_printer("HP LaserJet P1108", disc["physicalPrinters"])
            info1 = agent.inspect_printer_state_and_capabilities(p1)
            self.assertFalse(info1["capabilities"]["supportsColor"])
            self.assertFalse(info1["capabilities"]["supportsDuplex"])

            p2 = agent.resolve_target_printer(
                "Canon imageRUNNER ADVANCE C3520i", disc["physicalPrinters"]
            )
            info2 = agent.inspect_printer_state_and_capabilities(p2)
            self.assertTrue(info2["capabilities"]["supportsColor"])
            self.assertTrue(info2["capabilities"]["supportsDuplex"])
            self.assertIn("A3", info2["capabilities"]["supportedPaperSizes"])

    def test_14_printing_pdf_and_image_documents_universal_engine(self):
        sample_pdf_bytes = (
            b"%PDF-1.4\n"
            b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
            b"2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj\n"
            b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj\n"
            b"4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj\n"
            b"%%EOF\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / "sample.pdf"
            pdf_path.write_bytes(sample_pdf_bytes)

            img_path = Path(tmp) / "sample.png"
            Image.new("RGB", (600, 800), color=(200, 50, 50)).save(img_path)

            pdf_job = {
                "orderId": "ord_pdf_1",
                "token": "XR-TEST-PDF",
                "documentType": "pdf",
                "colorMode": "bw",
                "sides": "duplex",
                "paperSize": "A4",
                "orientation": "portrait",
                "selectedPages": [1, 2],
                "copies": 2,
            }
            rendered_pdf = agent.render_pages_to_pil_images(pdf_job, pdf_path, dpi=150)
            self.assertEqual(len(rendered_pdf), 2)

            img_job = {
                "orderId": "ord_img_1",
                "token": "XR-TEST-IMG",
                "documentType": "image",
                "colorMode": "color",
                "sides": "single",
                "paperSize": "A4",
                "orientation": "landscape",
                "selectedPages": [1],
                "copies": 1,
            }
            rendered_img = agent.render_pages_to_pil_images(img_job, img_path, dpi=150)
            self.assertEqual(len(rendered_img), 1)
            self.assertGreater(rendered_img[0].width, rendered_img[0].height)

            # Test GDI print dispatch with mocked win32ui & win32print
            db = {
                "Brother HL-L2321D series": {
                    "port": "USB003",
                    "driver": "Brother HL-L2321D series",
                    "caps": {"papers": (9, 1, 5), "color": 0, "duplex": 1},
                }
            }
            mock_dc = MagicMock()
            mock_dc.GetDeviceCaps.side_effect = lambda idx: 2480 if idx == agent.win32con.HORZRES else 3508
            mock_dc.GetHandleOutput.return_value = 12345

            with self._patch_win32print(db), patch.object(
                agent.win32ui, "CreateDC", return_value=mock_dc
            ), patch.object(agent.ImageWin, "Dib") as mock_dib:
                doc_title = agent.print_via_windows_gdi(
                    "Brother HL-L2321D series", pdf_job, rendered_pdf
                )
                self.assertEqual(doc_title, "SmartXerox-XR-TEST-PDF")
                mock_dc.CreatePrinterDC.assert_called_once_with("Brother HL-L2321D series")
                mock_dc.StartDoc.assert_called_once_with("SmartXerox-XR-TEST-PDF")
                # 2 pages * 2 copies = 4 StartPage/EndPage calls
                self.assertEqual(mock_dc.StartPage.call_count, 4)
                self.assertEqual(mock_dc.EndPage.call_count, 4)
                self.assertEqual(mock_dib.return_value.draw.call_count, 4)
                mock_dc.EndDoc.assert_called_once()

    def test_15_portrait_vs_landscape_and_paper_size_sheet_composition(self):
        # Create a 600x900 portrait image
        src_img = Image.new("RGB", (600, 900), color=(40, 120, 200))

        # 1. A4 Portrait at 150 DPI -> 210x297 mm -> width < height
        a4_portrait = agent.compose_image_onto_sheet(
            src_img, paper_size="A4", requested_orientation="portrait", dpi=150
        )
        self.assertLess(a4_portrait.width, a4_portrait.height)
        self.assertEqual(a4_portrait.width, int(round((210.0 / 25.4) * 150)))
        self.assertEqual(a4_portrait.height, int(round((297.0 / 25.4) * 150)))

        # 2. A4 Landscape at 150 DPI -> 297x210 mm -> width > height
        a4_landscape = agent.compose_image_onto_sheet(
            src_img, paper_size="A4", requested_orientation="landscape", dpi=150
        )
        self.assertGreater(a4_landscape.width, a4_landscape.height)
        self.assertEqual(a4_landscape.width, int(round((297.0 / 25.4) * 150)))
        self.assertEqual(a4_landscape.height, int(round((210.0 / 25.4) * 150)))

        # 3. Legal Portrait at 150 DPI -> 216x356 mm -> taller than A4
        legal_portrait = agent.compose_image_onto_sheet(
            src_img, paper_size="Legal", requested_orientation="portrait", dpi=150
        )
        self.assertGreater(legal_portrait.height, a4_portrait.height)


if __name__ == "__main__":
    unittest.main(verbosity=2)
