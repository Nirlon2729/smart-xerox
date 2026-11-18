import React, { useState, useEffect, useCallback } from "react";
import toast from "react-hot-toast";
import {
  Shield,
  Plus,
  RefreshCw,
  LogOut,
  Printer,
  Cpu,
  KeyRound,
  CheckCircle2,
  Ban,
  ExternalLink,
  Copy
} from "lucide-react";
import {
  superAdminLoginRequest,
  fetchSuperAdminOverview,
  createVendorRequest,
  updateVendorStatusRequest,
  resetVendorPasswordRequest,
  getApiErrorMessage
} from "../services/api";

const SUPER_ADMIN_TOKEN_KEY = "smart_xerox_super_admin_jwt";

export default function SuperAdminDashboard() {
  const [token, setToken] = useState(
    () => sessionStorage.getItem(SUPER_ADMIN_TOKEN_KEY) || ""
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  const [platformStats, setPlatformStats] = useState(null);
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(false);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newVendor, setNewVendor] = useState({
    shopName: "",
    shopSlug: "",
    ownerName: "",
    email: "",
    password: "",
    phone: "",
    address: "",
    maxCopies: 100
  });

  const [resetModalVendor, setResetModalVendor] = useState(null);
  const [resetPasswordInput, setResetPasswordInput] = useState("");
  const [resetting, setResetting] = useState(false);

  const loadOverview = useCallback(
    async (silent = false) => {
      if (!token) return;
      if (!silent) setLoading(true);
      try {
        const res = await fetchSuperAdminOverview(token);
        if (res?.success) {
          setPlatformStats(res.platformStats);
          setVendors(res.vendors || []);
        }
      } catch (err) {
        if (err?.response?.status === 401 || err?.response?.status === 403) {
          sessionStorage.removeItem(SUPER_ADMIN_TOKEN_KEY);
          setToken("");
          toast.error("Super Admin session expired or unauthorized.");
        } else if (!silent) {
          toast.error(getApiErrorMessage(err, "Failed to load platform overview."));
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [token]
  );

  useEffect(() => {
    if (!token) return;
    loadOverview(false);
    const interval = setInterval(() => loadOverview(true), 8000);
    return () => clearInterval(interval);
  }, [token, loadOverview]);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    try {
      setLoggingIn(true);
      const res = await superAdminLoginRequest(email.trim(), password);
      if (res?.success && res.token) {
        if (res.admin?.role !== "SUPER_ADMIN") {
          toast.error("This account does not have Super Admin privileges.");
          return;
        }
        sessionStorage.setItem(SUPER_ADMIN_TOKEN_KEY, res.token);
        setToken(res.token);
        setPassword("");
        toast.success("Signed in as Platform Super Admin");
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Invalid Super Admin credentials"));
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem(SUPER_ADMIN_TOKEN_KEY);
    setToken("");
    setVendors([]);
    setPlatformStats(null);
  };

  const handleCreateVendor = async (e) => {
    e.preventDefault();
    if (creating) return;
    try {
      setCreating(true);
      const res = await createVendorRequest(token, newVendor);
      if (res?.success) {
        toast.success(res.message || "Vendor created");
        setShowCreateModal(false);
        setNewVendor({
          shopName: "",
          shopSlug: "",
          ownerName: "",
          email: "",
          password: "",
          phone: "",
          address: "",
          maxCopies: 100
        });
        loadOverview(true);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not create vendor"));
    } finally {
      setCreating(false);
    }
  };

  const handleToggleVendorStatus = async (vendor) => {
    const nextStatus = vendor.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE";
    try {
      const res = await updateVendorStatusRequest(token, vendor.id, nextStatus);
      if (res?.success) {
        toast.success(res.message);
        loadOverview(true);
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Could not update vendor status"));
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    if (!resetModalVendor || !resetPasswordInput || resetting) return;
    try {
      setResetting(true);
      const res = await resetVendorPasswordRequest(
        token,
        resetModalVendor.id,
        resetPasswordInput
      );
      if (res?.success) {
        toast.success(res.message || "Password reset successfully");
        setResetModalVendor(null);
        setResetPasswordInput("");
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Failed to reset password"));
    } finally {
      setResetting(false);
    }
  };

  if (!token) {
    return (
      <div className="max-w-sm mx-auto pt-4 pb-12">
        <div className="bg-white rounded-2xl border border-zinc-200 p-6">
          <div className="w-10 h-10 rounded-xl bg-[#8D0100]/10 text-[#8D0100] flex items-center justify-center mb-3">
            <Shield className="w-5 h-5" />
          </div>
          <h1 className="text-lg font-bold text-zinc-900">
            Platform Super Admin
          </h1>
          <p className="text-xs text-zinc-500 mt-1">
            Sign in to create Xerox shop vendors, manage tenant status, and monitor connected desktop print agents.
          </p>

          <form onSubmit={handleLogin} className="mt-4 space-y-3.5">
            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">
                Super Admin Email
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@smartxerox.com"
                className="w-full min-h-[42px] px-3.5 py-2 rounded-lg border border-zinc-300 text-sm focus:border-[#8D0100] focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-zinc-700 mb-1">
                Password
              </label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                className="w-full min-h-[42px] px-3.5 py-2 rounded-lg border border-zinc-300 text-sm focus:border-[#8D0100] focus:outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={loggingIn}
              className="w-full min-h-[44px] rounded-xl bg-[#8D0100] hover:bg-[#730100] text-white text-sm font-semibold transition disabled:opacity-50"
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg sm:text-xl font-bold text-zinc-900">
            Smart Xerox — Super Admin Console
          </h1>
          <p className="text-xs text-zinc-500">
            Multi-vendor tenant management, desktop agent status, and platform statistics.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="min-h-[36px] px-3 py-1.5 rounded-lg bg-[#8D0100] hover:bg-[#730100] text-white text-xs font-semibold inline-flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Create Vendor</span>
          </button>

          <button
            type="button"
            onClick={() => loadOverview(false)}
            disabled={loading}
            className="min-h-[36px] px-3 py-1.5 rounded-lg border border-zinc-200 bg-white text-xs font-semibold text-zinc-700 inline-flex items-center gap-1.5 hover:bg-zinc-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
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

      {/* Platform Stats */}
      {platformStats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {[
            {
              label: "Active Vendors",
              value: `${platformStats.activeVendors} / ${platformStats.totalVendors}`
            },
            {
              label: "Online Agents",
              value: `${platformStats.onlineAgents} / ${platformStats.totalPairedAgents}`
            },
            {
              label: "Today's Jobs",
              value: platformStats.todaysJobs
            },
            {
              label: "Completed Jobs",
              value: platformStats.completedJobs
            }
          ].map((stat) => (
            <div
              key={stat.label}
              className="bg-white rounded-2xl border border-zinc-200 p-3.5"
            >
              <span className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                {stat.label}
              </span>
              <span className="block text-xl font-bold text-zinc-900 font-mono-code mt-1">
                {stat.value}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Vendors List */}
      <div className="space-y-3">
        {vendors.map((vendor) => {
          const primaryAdmin = vendor.admins?.[0];
          const isActive = vendor.status === "ACTIVE";

          return (
            <div
              key={vendor.id}
              className="bg-white rounded-2xl border border-zinc-200 p-4 space-y-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-sm sm:text-base font-bold text-zinc-900">
                      {vendor.shopName}
                    </h2>
                    <span
                      className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${
                        isActive
                          ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                          : "bg-red-50 text-red-700 border-red-200"
                      }`}
                    >
                      {vendor.status}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-500 font-mono-code mt-0.5">
                    Slug: /shop/{vendor.shopSlug} • Login:{" "}
                    {primaryAdmin?.email || "No admin"}
                  </p>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(vendor.publicUrl);
                      toast.success("Copied shop URL");
                    }}
                    className="px-2.5 py-1.5 rounded-lg border border-zinc-200 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 inline-flex items-center gap-1"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy Shop URL</span>
                  </button>
                  <a
                    href={`/shop/${vendor.shopSlug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-2.5 py-1.5 rounded-lg border border-zinc-200 text-xs font-semibold text-[#8D0100] hover:bg-zinc-50 inline-flex items-center gap-1"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Open Shop</span>
                  </a>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 p-2.5 rounded-xl bg-zinc-50 border border-zinc-100 text-xs">
                <div className="flex items-center gap-2">
                  <Cpu
                    className={`w-4 h-4 shrink-0 ${
                      vendor.agentOnline ? "text-emerald-600" : "text-zinc-400"
                    }`}
                  />
                  <div>
                    <span className="text-zinc-400 block text-[10px] uppercase">
                      Desktop Agent
                    </span>
                    <span className="font-semibold text-zinc-800">
                      {vendor.agentOnline
                        ? `Online (${vendor.agents?.length || 1} paired)`
                        : `Offline (${vendor.agents?.length || 0} paired)`}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Printer
                    className={`w-4 h-4 shrink-0 ${
                      vendor.printerAvailable ? "text-emerald-600" : "text-zinc-400"
                    }`}
                  />
                  <div className="min-w-0">
                    <span className="text-zinc-400 block text-[10px] uppercase">
                      Connected Printer
                    </span>
                    <span className="font-semibold text-zinc-800 truncate block">
                      {vendor.activePrinterName || "None selected"}
                    </span>
                  </div>
                </div>

                <div>
                  <span className="text-zinc-400 block text-[10px] uppercase">
                    Print Jobs
                  </span>
                  <span className="font-semibold text-zinc-800 font-mono-code">
                    {vendor.stats?.completedJobs || 0} done •{" "}
                    {vendor.stats?.pendingJobs || 0} pending •{" "}
                    {vendor.stats?.totalJobs || 0} total
                  </span>
                </div>
              </div>

              <div className="pt-1 flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setResetModalVendor(vendor);
                    setResetPasswordInput("");
                  }}
                  className="px-3 py-1.5 rounded-lg border border-zinc-200 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 inline-flex items-center gap-1.5"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>Reset Password</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleToggleVendorStatus(vendor)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 border ${
                    isActive
                      ? "border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                      : "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                  }`}
                >
                  {isActive ? (
                    <>
                      <Ban className="w-3.5 h-3.5" />
                      <span>Suspend Vendor</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Activate Vendor</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Create Vendor Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-zinc-200 p-5 max-w-md w-full space-y-4 shadow-lg max-h-[90vh] overflow-y-auto">
            <h3 className="text-base font-bold text-zinc-900">
              Create New Xerox Shop Vendor
            </h3>
            <form onSubmit={handleCreateVendor} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">
                  Shop Name *
                </label>
                <input
                  type="text"
                  required
                  value={newVendor.shopName}
                  onChange={(e) =>
                    setNewVendor({ ...newVendor, shopName: e.target.value })
                  }
                  placeholder="e.g. City Xerox & Stationery"
                  className="w-full px-3 py-2 rounded-lg border border-zinc-300 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">
                  Custom Shop Slug (optional)
                </label>
                <input
                  type="text"
                  value={newVendor.shopSlug}
                  onChange={(e) =>
                    setNewVendor({ ...newVendor, shopSlug: e.target.value })
                  }
                  placeholder="e.g. city-xerox"
                  className="w-full px-3 py-2 rounded-lg border border-zinc-300 text-sm font-mono-code"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">
                  Vendor Login Email *
                </label>
                <input
                  type="email"
                  required
                  value={newVendor.email}
                  onChange={(e) =>
                    setNewVendor({ ...newVendor, email: e.target.value })
                  }
                  placeholder="vendor@cityxerox.com"
                  className="w-full px-3 py-2 rounded-lg border border-zinc-300 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">
                  Initial Password * (min 6 chars)
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={newVendor.password}
                  onChange={(e) =>
                    setNewVendor({ ...newVendor, password: e.target.value })
                  }
                  placeholder="Enter vendor password"
                  className="w-full px-3 py-2 rounded-lg border border-zinc-300 text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-xs font-semibold text-zinc-700 mb-1">
                    Phone
                  </label>
                  <input
                    type="text"
                    value={newVendor.phone}
                    onChange={(e) =>
                      setNewVendor({ ...newVendor, phone: e.target.value })
                    }
                    placeholder="+91 ..."
                    className="w-full px-3 py-2 rounded-lg border border-zinc-300 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-zinc-700 mb-1">
                    Max Copies
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={newVendor.maxCopies}
                    onChange={(e) =>
                      setNewVendor({
                        ...newVendor,
                        maxCopies: Number(e.target.value) || 100
                      })
                    }
                    className="w-full px-3 py-2 rounded-lg border border-zinc-300 text-sm font-mono-code"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 rounded-xl border border-zinc-200 text-xs font-semibold text-zinc-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-4 py-2 rounded-xl bg-[#8D0100] text-white text-xs font-semibold disabled:opacity-50"
                >
                  {creating ? "Creating..." : "Create Vendor"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reset Vendor Password Modal */}
      {resetModalVendor && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-zinc-200 p-5 max-w-sm w-full space-y-4 shadow-lg">
            <h3 className="text-base font-bold text-zinc-900">
              Reset Password — {resetModalVendor.shopName}
            </h3>
            <form onSubmit={handleResetPassword} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-700 mb-1">
                  New Password (min 6 chars)
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={resetPasswordInput}
                  onChange={(e) => setResetPasswordInput(e.target.value)}
                  placeholder="Enter new password"
                  className="w-full px-3 py-2 rounded-lg border border-zinc-300 text-sm"
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setResetModalVendor(null)}
                  className="px-4 py-2 rounded-xl border border-zinc-200 text-xs font-semibold text-zinc-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={resetting}
                  className="px-4 py-2 rounded-xl bg-[#8D0100] text-white text-xs font-semibold disabled:opacity-50"
                >
                  {resetting ? "Saving..." : "Update Password"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
