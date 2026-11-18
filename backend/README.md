# Smart Xerox Backend (starter)

Single-shop QR-based print ordering backend for React + Node + MongoDB.

## Important production note

This scaffold is not payment-ready and must not be used to accept real payments or trigger production printing yet. Payment creation and verification intentionally return HTTP 501. Implement the selected provider's server-side signature verification and verified webhook before changing an order to `QUEUED`.

The agent authentication shown here uses a shared token for local development. For production, use a per-device credential stored as a hash, rotate/revoke support, TLS, and short-lived signed file download URLs.

## Setup

1. Install Node.js LTS.
2. Copy `.env.example` to `.env` and fill in secrets and MongoDB URI.
3. Run `npm install`.
4. Run `npm run dev`.
5. Check `GET http://localhost:5000/api/health`.

## Initial setup still required

- Set `PRINT_AGENT_TOKEN` and `PRINTER_NAME` in `.env`. The first run creates the owner account from `ADMIN_EMAIL` / `ADMIN_PASSWORD` and inserts default A4 rates; review those rates before taking orders.
- Add an initial A4/A3 pricing document to MongoDB or implement a seed script.
- Implement Razorpay order creation, payment signature verification and webhook.
- Add a protected private file-download route for the print agent.
- Add agent job leases, retries and spooler monitoring.
- Validate PDF page count server-side; never trust the browser-provided pageCount.
- Add malware scanning / file validation, upload cleanup, retention policy and admin bootstrap invocation.
- Implement idempotency and refund/reprint workflows.

## API routes

- `GET /api/health`
- `POST /api/orders` multipart field `document`, plus JSON-string `selectedPages`
- `GET /api/orders/:token`
- `POST /api/payments/create`
- `POST /api/payments/verify`
- `POST /api/agent/heartbeat`
- `GET /api/agent/jobs/next`
- `PATCH /api/agent/jobs/:id/status`
- `POST /api/admin/login`
- `GET /api/admin/orders`
- `PUT /api/admin/pricing`

## Currency

All monetary amounts are stored as integer paise. ₹1 = 100 paise.
