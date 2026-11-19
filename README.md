# Smart Xerox — Multi-Vendor SaaS Printing Platform

Smart Xerox is a multi-vendor cloud printing platform composed of **two strictly separated client applications** sharing a **multi-tenant cloud backend**:

1. **Vendor Windows Desktop Application (`desktop-app/` + `print-agent/`)**
   - Packaged as an installable Windows executable (`SmartXerox-Setup.exe`).
   - Bundles the Electron + React vendor console and a self-contained Python 3.13 background print agent (`pywin32`, `PyMuPDF`, `Pillow`) — shopkeepers never need to install Node.js, Python, or run terminal commands.
   - Automatically detects connected Windows USB & network printers, pairs with the cloud using unique revocable per-agent credentials (stored via Windows DPAPI `safeStorage`), displays the shop's permanent QR code, and prints incoming jobs directly via Windows GDI.

2. **Customer Mobile Website (`frontend/`)**
   - Mobile-first React + Vite web application requiring zero app installation for customers.
   - Customers scan a shop's unique QR code (`https://<customer-domain>/shop/<shopSlug>`), upload a PDF/JPG/JPEG/PNG document, select verified printer capabilities (Black & White / Colour, Paper Size, Single / Double-Sided, Page Range, Copies, Orientation), press **Print**, and track live job progress.
   - Also provides `/super-admin` for platform-level vendor creation, activation/suspension, password resets, and platform statistics.

3. **Shared Multi-Tenant Cloud Backend (`backend/`)**
   - Node.js + Express + MongoDB Atlas + GridFS (`printDocuments` bucket).
   - Enforces strict `tenantId` isolation across `Tenant`, `Admin`, `Agent`, `Order`, `AuditLog`, and GridFS file metadata.

---

## Project Structure

```text
smart xerox/
├── backend/                  # Multi-vendor Express API + MongoDB Atlas + GridFS
│   ├── src/
│   │   ├── models/           # Tenant, Admin, Agent, Order, AuditLog
│   │   ├── controllers/      # orderController, agentController, adminController
│   │   ├── middleware/       # authMiddleware (per-agent & tenant isolation)
│   │   ├── routes/           # shopRoutes, adminRoutes, superAdminRoutes, agentRoutes
│   │   └── services/         # gridfsService (strict tenantId ownership)
│   └── tests/                # Automated multi-vendor isolation & security test suite
├── frontend/                 # Customer Mobile Website (/shop/:shopSlug) + /super-admin
├── desktop-app/              # Electron + React Windows Vendor Desktop Application
│   ├── electron/             # Main process, DPAPI store, background agent supervisor
│   ├── src/                  # Vendor UI (Login, Dashboard, Printers, QR, Jobs, Agent, Settings)
│   ├── scripts/              # Portable Python runtime bundler & icon generator
│   └── build/                # Application icons & NSIS uninstaller cleanup script
├── print-agent/              # Windows GDI & pywin32 Python print agent (agent.py)
└── render.yaml               # Render cloud deployment blueprint
```

---

## Windows Spooler Confirmation & Limitations

- The Python print agent renders pages at 300 DPI via `PyMuPDF` / `Pillow`, submits the document to the selected Windows printer via GDI (`win32ui.CreateDC` / `CreatePrinterDC`), and polls `win32print.EnumJobs` (`wait_for_spooler_completion`) until the job clears the Windows Print Spooler without `JOB_STATUS_ERROR`, `JOB_STATUS_PAPEROUT`, or `JOB_STATUS_OFFLINE` before reporting `COMPLETED`.
- Note: Some bidirectional USB printer drivers clear the Windows spooler job as soon as the job buffer is transferred to the printer's internal memory. Hardware errors occurring prior to or during spooling (offline, paper out, door open, paper jam, paused queue) are detected via `GetPrinter` and `EnumJobs` bitmasks and reported as `FAILED`.

---

## Deployment Guide

### 1. Cloud Backend (Render + MongoDB Atlas)
1. Deploy `backend/` on Render using `render.yaml` (or as a Node Web Service).
2. Configure environment variables in Render (never in frontend):
   - `MONGODB_URI`: MongoDB Atlas connection string
   - `JWT_SECRET`: Strong random secret
   - `ADMIN_EMAIL` & `ADMIN_PASSWORD`: Initial Super Admin credentials
   - `CUSTOMER_ORIGIN`: Deployed customer web domain (e.g. `https://smartxerox.vercel.app`)
   - `PUBLIC_SHOP_BASE_URL`: Public customer domain used to generate permanent shop QR URLs (e.g. `https://smartxerox.vercel.app`)

### 2. Customer Mobile Website (Vercel or Render Static Site)
1. Deploy `frontend/` with build command `npm install && npm run build` and output directory `dist`.
2. Set `VITE_API_BASE_URL=https://<your-render-backend>.onrender.com/api`.

### 3. Building the Windows Vendor Installer (`SmartXerox-Setup.exe`)
```powershell
cd desktop-app
npm install
npm run dist:win
```
The installer is output to `desktop-app/release/SmartXerox-Setup.exe`.
for new venders use this "https://smart-xerox-web-2mwa.onrender.com/super-admin"