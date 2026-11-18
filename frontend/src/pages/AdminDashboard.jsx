import React, { useState, useEffect, useCallback } from "react";
import toast from "react-hot-toast";
import {
  Search,
  RefreshCw,
  Printer,
  XCircle,
  LogOut,
  Lock,
  RotateCcw,
  Trash2,
  ExternalLink
} from "lucide-react";
import {
  API_BASE_URL,
  adminLoginRequest,
  fetchAdminOrders,
  adminCancelOrderRequest,
  adminReprintOrderRequest,
  adminClearFailedRequest,
  getApiErrorMessage
} from "../services/api";
import { formatFileSize, summarizeSelectedPages } from "../utils/formatters";
import { getOrderStatusMeta } from "../components/OrderStatus";

const OWNER_TOKEN_KEY = "smart_xerox_owner_jwt";

const STATUS_FILTERS = [
  { id: "ALL", label: "All Jobs" },
  { id: "QUEUED", label: "Queued" },
  { id: "PRINTING", label: "Printing" },
  { id: "COMPLETED", label: "Completed" },
  { id: "FAILED", label: "Failed" },
  { id: "CANCELLED", label: "Cancelled" }
];

export default function AdminDashboard() {
  const [ownerToken, setOwnerToken] = useState(
    () => localStorage.getItem(OWNER_TOKEN_KEY) || ""
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  const [orders, setOrders] = useState([]);
  const [printer, setPrinter] = useState(null);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [actionId, setActionId] = useState(null);
  const [confirmReprintJob, setConfirmReprintJob] = useState(null);

  const loadOrders = useCallback(
    async (silent = false) => {
      if (!ownerToken) return;
      if (!silent) setLoadingOrders(true);
      try {
        const res = await fetchAdminOrders(ownerToken, {
          status: statusFilter,
          search: searchQuery
        });
        if (res?.success) {
          setOrders(res.orders || []);
          if (res.printer) setPrinter(res.printer);
        }
      } catch (err) {
        if (err?.response?.status === 401) {
          localStorage.removeItem(OWNER_TOKEN_KEY);
          setOwnerToken("");
          toast.error("Owner session expired. Please sign in again.");
        } else if (!silent) {
          toast.error(getApiErrorMessage(err, "Failed to load print jobs."));
        }
      } finally {
        if (!silent) setLoadingOrders(false);
      }
    },
    [ownerToken, statusFilter, searchQuery]
  );

  useEffect(() => {
    if (!ownerToken) return;
    loadOrders(false);
    const interval = setInterval(() => loadOrders(true), 5000);
    return () => clearInterval(interval);
  }, [ownerToken, loadOrders]);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    try {
      setLoggingIn(true);
      const res = await adminLoginRequest(email.trim(), password);
      if (res?.success && res.token) {
        localStorage.setItem(OWNER_TOKEN_KEY, res.token);
        setOwnerToken(res.token);
        setPassword("");
        toast.success("Signed in as Owner");
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Invalid owner credentials"));
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem(OWNER_TOKEN_KEY);
    setOwnerToken("");
    setOrders([]);
  };

  const handleCancelOrder = async (order) => {
    try {
      setActionId(order._id);
      const res = await adminCancelOrderRequest(ownerToken, order.token);
      if (res?.success) {
        toast.success(`Cancelled ${order.originalName}`);
        loadOrders(true);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not cancel job"));
    } finally {
      setActionId(null);
    }
  };

  const handleConfirmReprint = async () => {
    if (!confirmReprintJob) return;
    const job = confirmReprintJob;
    setConfirmReprintJob(null);
    try {
      setActionId(job._id);
      const res = await adminReprintOrderRequest(ownerToken, job.token);
      if (res?.success) {
        toast.success("Reprint queued for USB printer");
        loadOrders(true);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not reprint job"));
    } finally {
      setActionId(null);
    }
  };

  const handleClearFailed = async () => {
    try {
      const res = await adminClearFailedRequest(ownerToken);
      if (res?.success) {
        toast.success(res.message || "Cleared failed jobs");
        loadOrders(true);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not clear failed jobs"));
    }
  };

  const handleViewDocument = async (order) => {
    try {
      const response = await fetch(`${API_BASE_URL}/admin/orders/${order._id}/file`, {
        headers: {
          Authorization: `Bearer ${ownerToken}`
        }
      });
      if (!response.ok) {
        throw new Error("Document file was already cleaned up from GridFS.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast.error(err.message || "Could not open GridFS document.");
    }
  };

  if (!ownerToken) {
    return (
      <div className="max-w-sm mx-auto pt-4 pb-12">
        <div className="bg-white rounded-2xl border border-zinc-200 p-5 sm:p-6">
          <div className="w-10 h-10 rounded-xl bg-[#8D0100]/10 text-[#8D0100] flex items-center justify-center mb-3">
            <Lock className="w-5 h-5" />
          </div>
          <h1 className="text-lg font-bold text-zinc-900">Owner Login</h1>
          <p className="text-xs text-zinc-500 mt-1">
            Sign in to view printer diagnostics, inspect GridFS files, and manage print jobs.
          </p>

          <form onSubmit={handleLogin} className="mt-4 space-y-3.5">
            <div>
              <label
                htmlFor="owner-email"
                className="block text-xs font-semibold text-zinc-700 mb-1"
              >
                Owner Email
              </label>
              <input
                id="owner-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@example.com"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-zinc-300 text-sm focus:border-[#8D0100] focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="owner-password"
                className="block text-xs font-semibold text-zinc-700 mb-1"
              >
                Password
              </label>
              <input
                id="owner-password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-zinc-300 text-sm focus:border-[#8D0100] focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={loggingIn}
              className="w-full min-h-[46px] rounded-xl bg-[#8D0100] hover:bg-[#730100] text-white text-sm font-semibold transition disabled:opacity-50"
            >
              {loggingIn ? "Signing in..." : "Sign In"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-12">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-lg sm:text-xl font-bold text-zinc-900">
            Owner Print Console
          </h1>
          <p className="text-xs text-zinc-500">
            Manage your USB HP printer and MongoDB GridFS print queue.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => loadOrders(false)}
            disabled={loadingOrders}
            className="min-h-[36px] px-3 py-1.5 rounded-lg border border-zinc-200 bg-white text-xs font-semibold text-zinc-700 inline-flex items-center gap-1.5 hover:bg-zinc-50"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 text-[#8D0100] ${
                loadingOrders ? "animate-spin" : ""
              }`}
            />
            <span>Refresh</span>
          </button>

          <button
            type="button"
            onClick={handleLogout}
            className="min-h-[36px] px-3 py-1.5 rounded-lg border border-zinc-200 bg-white text-xs font-semibold text-zinc-600 inline-flex items-center gap-1.5 hover:bg-zinc-50"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign out</span>
          </button>
        </div>
      </div>

      {/* Connected Printer Card */}
      {printer && (
        <div className="bg-white rounded-2xl border border-zinc-200 p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                printer.online
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                  : "bg-zinc-100 text-zinc-500 border border-zinc-200"
              }`}
            >
              <Printer className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-zinc-900">
                  {printer.printerName}
                </span>
                <span
                  className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${
                    printer.online
                      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                      : "bg-zinc-100 text-zinc-600 border-zinc-200"
                  }`}
                >
                  {printer.online ? "Online" : "Offline"}
                </span>
              </div>
              <p className="text-xs text-zinc-500 mt-0.5">
                Supported trays:{" "}
                {(printer.capabilities?.supportedPaperSizes || ["A4"]).join(", ")} •{" "}
                {printer.capabilities?.supportsColor ? "Colour & B&W" : "B&W only"} •{" "}
                {printer.capabilities?.supportsDuplex ? "Duplex ready" : "Single-sided"}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleClearFailed}
            className="min-h-[36px] px-3 py-1.5 rounded-lg border border-zinc-200 bg-zinc-50 hover:bg-zinc-100 text-xs font-semibold text-zinc-700 inline-flex items-center gap-1.5"
          >
            <Trash2 className="w-3.5 h-3.5 text-red-600" />
            <span>Clear Failed Jobs</span>
          </button>
        </div>
      )}

      {/* Search & Filter */}
      <div className="bg-white rounded-2xl border border-zinc-200 p-3.5 space-y-3">
        <div className="relative">
          <Search className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by file name or job ID"
            className="w-full min-h-[42px] pl-9 pr-3.5 py-2 rounded-lg border border-zinc-200 text-xs sm:text-sm focus:border-[#8D0100] focus:outline-none"
          />
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {STATUS_FILTERS.map((tab) => {
            const active = statusFilter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap border transition ${
                  active
                    ? "bg-[#8D0100] text-white border-[#8D0100]"
                    : "bg-zinc-50 text-zinc-700 border-zinc-200 hover:bg-zinc-100"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Jobs List */}
      {orders.length === 0 ? (
        <div className="bg-white rounded-2xl border border-zinc-200 p-8 text-center text-xs sm:text-sm text-zinc-500">
          {loadingOrders ? "Loading print jobs..." : "No print jobs found."}
        </div>
      ) : (
        <div className="space-y-3">
          {orders.map((order) => {
            const meta = getOrderStatusMeta(order.status);
            const canCancel = ["UPLOADING", "QUEUED", "DOWNLOADING", "PROCESSING"].includes(
              order.status
            );
            const canReprint =
              !order.fileDeleted &&
              ["COMPLETED", "FAILED", "CANCELLED"].includes(order.status);
            const busy = actionId === order._id;

            return (
              <div
                key={order._id}
                className="bg-white rounded-2xl border border-zinc-200 p-4 space-y-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-zinc-900 truncate">
                        {order.originalName}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border shrink-0 ${meta.badgeClass}`}
                      >
                        {meta.label}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-500 font-mono-code mt-0.5">
                      {order.token} • {formatFileSize(order.fileSize)} •{" "}
                      {new Date(order.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 p-2.5 rounded-xl bg-zinc-50 border border-zinc-100 text-xs">
                  <div>
                    <span className="text-zinc-400 block text-[10px] uppercase">
                      Paper / Orient.
                    </span>
                    <span className="font-semibold text-zinc-800 capitalize">
                      {order.paperSize || "A4"} • {order.orientation || "auto"}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-400 block text-[10px] uppercase">
                      Mode
                    </span>
                    <span className="font-semibold text-zinc-800">
                      {order.colorMode === "color" ? "Colour" : "B&W"} •{" "}
                      {order.sides === "duplex" ? "Duplex" : "Single"}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-400 block text-[10px] uppercase">
                      Pages
                    </span>
                    <span className="font-semibold text-zinc-800 font-mono-code">
                      {order.documentType === "image"
                        ? "Image (1p)"
                        : summarizeSelectedPages(order.selectedPages, order.pageCount)}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-400 block text-[10px] uppercase">
                      Copies
                    </span>
                    <span className="font-semibold text-zinc-800 font-mono-code">
                      {order.copies}x ({order.printablePageCount}p)
                    </span>
                  </div>
                </div>

                {order.failureReason && (
                  <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg border border-red-200">
                    {order.failureReason}
                  </p>
                )}

                <div className="pt-1 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {!order.fileDeleted && (
                      <button
                        type="button"
                        onClick={() => handleViewDocument(order)}
                        className="min-h-[34px] px-3 py-1 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-50 text-xs font-semibold text-zinc-700 inline-flex items-center gap-1.5"
                      >
                        <ExternalLink className="w-3.5 h-3.5 text-[#8D0100]" />
                        <span>View GridFS File</span>
                      </button>
                    )}

                    {canReprint && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmReprintJob(order)}
                        className="min-h-[34px] px-3 py-1 rounded-lg bg-[#8D0100] hover:bg-[#730100] text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Reprint</span>
                      </button>
                    )}
                  </div>

                  {canCancel && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleCancelOrder(order)}
                      className="min-h-[34px] px-2.5 py-1 rounded-lg text-xs font-semibold text-red-700 hover:bg-red-50 inline-flex items-center gap-1 disabled:opacity-50"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      <span>Cancel</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Explicit Reprint Confirmation Modal */}
      {confirmReprintJob && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-zinc-200 p-5 max-w-sm w-full space-y-4 shadow-lg">
            <h3 className="text-base font-bold text-zinc-900">
              Confirm Reprint
            </h3>
            <p className="text-xs sm:text-sm text-zinc-600 leading-relaxed">
              Reprint{" "}
              <strong className="text-zinc-900">
                {confirmReprintJob.originalName}
              </strong>{" "}
              ({confirmReprintJob.copies}{" "}
              {confirmReprintJob.copies === 1 ? "copy" : "copies"}) on your USB HP printer?
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmReprintJob(null)}
                className="px-4 py-2 rounded-xl border border-zinc-200 text-xs font-semibold text-zinc-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmReprint}
                className="px-4 py-2 rounded-xl bg-[#8D0100] text-white text-xs font-semibold"
              >
                Confirm Reprint
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
