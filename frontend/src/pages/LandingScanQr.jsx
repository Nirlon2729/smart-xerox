import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { QrCode, ArrowRight, Printer, ShieldCheck, Smartphone } from "lucide-react";

export default function LandingScanQr() {
  const navigate = useNavigate();
  const [slugInput, setSlugInput] = useState("");

  const handleOpenShop = (e) => {
    e.preventDefault();
    const cleaned = slugInput
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\/[^/]+\/shop\//i, "")
      .replace(/[^a-z0-9-]/g, "");
    if (!cleaned) return;
    navigate(`/shop/${cleaned}`);
  };

  return (
    <div className="space-y-5 pb-12 pt-2">
      <div className="bg-white rounded-2xl border border-zinc-200 p-6 text-center space-y-4">
        <div className="w-14 h-14 rounded-2xl bg-[#8D0100]/10 text-[#8D0100] flex items-center justify-center mx-auto">
          <QrCode className="w-7 h-7" />
        </div>

        <div>
          <h1 className="text-lg sm:text-xl font-bold text-zinc-900">
            Scan Shop QR Code to Print
          </h1>
          <p className="text-xs sm:text-sm text-zinc-600 mt-1.5 max-w-sm mx-auto leading-relaxed">
            Scan the Smart Xerox QR code displayed at the Xerox shop counter with your phone camera to upload and print your documents directly.
          </p>
        </div>

        <form onSubmit={handleOpenShop} className="pt-2 max-w-xs mx-auto space-y-2.5">
          <label
            htmlFor="shop-slug-input"
            className="block text-xs font-semibold text-zinc-700 text-left"
          >
            Or enter shop code manually
          </label>
          <div className="flex items-center gap-2">
            <input
              id="shop-slug-input"
              type="text"
              value={slugInput}
              onChange={(e) => setSlugInput(e.target.value)}
              placeholder="e.g. smart-xerox-main"
              className="flex-1 min-h-[44px] px-3.5 py-2 rounded-xl border border-zinc-300 text-sm font-mono-code focus:border-[#8D0100] focus:outline-none"
            />
            <button
              type="submit"
              disabled={!slugInput.trim()}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-[#8D0100] hover:bg-[#730100] text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-40 transition"
            >
              <span>Open</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </form>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          {
            icon: Smartphone,
            title: "1. Scan Shop QR",
            desc: "Open the shop's dedicated printing page in your mobile browser."
          },
          {
            icon: Printer,
            title: "2. Upload & Configure",
            desc: "Upload PDF, JPG, or PNG and select pages, copies, and paper size."
          },
          {
            icon: ShieldCheck,
            title: "3. Instant Print",
            desc: "Your document prints directly on the shop's connected printer."
          }
        ].map((step) => {
          const Icon = step.icon;
          return (
            <div
              key={step.title}
              className="bg-white rounded-2xl border border-zinc-200 p-4 space-y-1.5"
            >
              <div className="w-8 h-8 rounded-lg bg-zinc-100 text-[#8D0100] flex items-center justify-center">
                <Icon className="w-4 h-4" />
              </div>
              <h2 className="text-xs font-bold text-zinc-900">{step.title}</h2>
              <p className="text-xs text-zinc-500 leading-relaxed">{step.desc}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
