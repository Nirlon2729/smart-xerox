import React from "react";
import {
  UploadCloud,
  Send,
  Download,
  Cpu,
  Printer,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock
} from "lucide-react";

/**
 * Maps real backend print-job status to the 6-step customer progress pipeline:
 * 1. Uploading document
 * 2. Processing document
 * 3. Sending print request to the shop
 * 4. Waiting for the vendor's computer
 * 5. Printing
 * 6. Completed
 */
export function getOrderStatusMeta(status, printerState = null) {
  const agentOnline = printerState?.agentOnline !== false;
  const printerAvailable = printerState?.printerAvailable !== false;
  const printerName = printerState?.printerName || "Shop Printer";

  switch (status) {
    case "UPLOADING":
      return {
        label: "Uploading",
        headline: "Uploading document...",
        description: "Streaming your document securely to the Smart Xerox cloud server.",
        badgeClass: "bg-zinc-100 text-zinc-800 border-zinc-200",
        completedSteps: 1,
        activeStep: 2,
        icon: UploadCloud
      };
    case "QUEUED":
      return {
        label: !agentOnline ? "Waiting for Shop PC" : "Queued at Shop",
        headline: !agentOnline
          ? "Waiting for the vendor's computer to reconnect..."
          : !printerAvailable
            ? `Waiting for ${printerName} to come online...`
            : "Waiting for the vendor's computer...",
        description: !agentOnline
          ? "Your print request has been sent to the shop and is safely queued. It will begin printing automatically as soon as the shop computer reconnects."
          : !printerAvailable
            ? `Your print request is queued at the shop. Waiting for the shopkeeper's printer (${printerName}) to be ready.`
            : "Your print request is in the shop's print queue and waiting for the shop computer to claim it.",
        badgeClass: "bg-amber-50 text-amber-800 border-amber-200",
        completedSteps: 3,
        activeStep: 4,
        icon: !agentOnline ? Clock : Send
      };
    case "DOWNLOADING":
      return {
        label: "Received by Shop PC",
        headline: "Vendor's computer is receiving your document...",
        description: "The shop computer has claimed your job and is downloading the verified document.",
        badgeClass: "bg-blue-50 text-blue-800 border-blue-200",
        completedSteps: 4,
        activeStep: 5,
        icon: Download
      };
    case "PROCESSING":
      return {
        label: "Preparing Print",
        headline: `Formatting pages for ${printerName}...`,
        description: "Rendering selected pages, paper size, and orientation on the shop computer.",
        badgeClass: "bg-indigo-50 text-indigo-800 border-indigo-200",
        completedSteps: 4,
        activeStep: 5,
        icon: Cpu
      };
    case "PRINTING":
      return {
        label: "Printing",
        headline: "Printing in progress...",
        description: `The shop printer (${printerName}) is actively printing your document.`,
        badgeClass: "bg-[#8D0100]/10 text-[#8D0100] border-[#8D0100]/25",
        completedSteps: 4,
        activeStep: 5,
        icon: Printer
      };
    case "COMPLETED":
      return {
        label: "Completed",
        headline: "Printing completed",
        description: "The shop's Windows Print Spooler confirmed your document finished printing.",
        badgeClass: "bg-emerald-50 text-emerald-800 border-emerald-200",
        completedSteps: 6,
        activeStep: 6,
        icon: CheckCircle2
      };
    case "CANCELLED":
      return {
        label: "Cancelled",
        headline: "Print job cancelled",
        description: "This print job was cancelled before printing.",
        badgeClass: "bg-zinc-100 text-zinc-600 border-zinc-200",
        completedSteps: 0,
        activeStep: -1,
        icon: XCircle
      };
    case "FAILED":
    default:
      return {
        label: "Failed",
        headline: "Printing could not be completed",
        description: "The shop printer reported an error while processing this job. Please check with the shop counter.",
        badgeClass: "bg-red-50 text-red-700 border-red-200",
        completedSteps: 0,
        activeStep: -1,
        icon: XCircle
      };
  }
}

const SIX_PROGRESS_STEPS = [
  { step: 1, title: "Uploading document" },
  { step: 2, title: "Processing document" },
  { step: 3, title: "Sending print request to the shop" },
  { step: 4, title: "Waiting for the vendor's computer" },
  { step: 5, title: "Printing" },
  { step: 6, title: "Completed" }
];

export default function OrderStatus({
  status,
  failureReason = null,
  printerState = null
}) {
  const meta = getOrderStatusMeta(status, printerState);
  const StatusIcon = meta.icon;
  const isError = status === "FAILED" || status === "CANCELLED";
  const isWaitingOffline =
    status === "QUEUED" &&
    printerState &&
    (printerState.agentOnline === false || printerState.printerAvailable === false);

  return (
    <div className="bg-white rounded-2xl border border-zinc-200 p-4 sm:p-5 space-y-4 shadow-2xs">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-semibold border ${meta.badgeClass}`}
          >
            {meta.label}
          </span>
          <h2 className="text-base sm:text-lg font-bold text-zinc-900 mt-2">
            {meta.headline}
          </h2>
          <p className="text-xs sm:text-sm text-zinc-600 mt-1 leading-relaxed">
            {failureReason || meta.description}
          </p>
        </div>

        <div className="w-11 h-11 rounded-xl bg-[#8D0100]/10 flex items-center justify-center shrink-0">
          <StatusIcon className="w-5.5 h-5.5 text-[#8D0100]" />
        </div>
      </div>

      {isWaitingOffline && (
        <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-2.5 text-xs text-amber-900">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="leading-relaxed">
            {printerState.agentOnline === false ? (
              <span>
                <strong>Shop Computer Offline:</strong> Your print request is waiting for the shop computer to reconnect. You do not need to re-upload your file.
              </span>
            ) : (
              <span>
                <strong>Shop Printer Offline:</strong> The shop computer is online, and your job is waiting for the connected printer ({printerState.printerName || "Shop Printer"}) to be turned on or ready.
              </span>
            )}
          </div>
        </div>
      )}

      {!isError && (
        <div className="pt-3.5 border-t border-zinc-100 space-y-2.5">
          {SIX_PROGRESS_STEPS.map((item) => {
            const isDone = meta.completedSteps >= item.step;
            const isCurrent = meta.activeStep === item.step && status !== "COMPLETED";

            return (
              <div key={item.step} className="flex items-center gap-3">
                <div
                  className={`w-6 h-6 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 transition ${
                    isDone
                      ? "bg-emerald-600 text-white"
                      : isCurrent
                        ? "bg-[#8D0100] text-white ring-2 ring-[#8D0100]/20"
                        : "bg-zinc-100 text-zinc-400"
                  }`}
                >
                  {isDone ? "✓" : item.step}
                </div>
                <div className="flex-1 flex items-center justify-between gap-2">
                  <span
                    className={`text-xs sm:text-sm ${
                      isCurrent
                        ? "font-bold text-[#8D0100]"
                        : isDone
                          ? "font-medium text-zinc-800"
                          : "text-zinc-400"
                    }`}
                  >
                    {item.step}. {item.title}
                  </span>
                  {isCurrent && (
                    <span className="text-[11px] font-semibold text-[#8D0100] animate-pulse">
                      In Progress...
                    </span>
                  )}
                  {isDone && (
                    <span className="text-[11px] font-medium text-emerald-700">
                      Done
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
