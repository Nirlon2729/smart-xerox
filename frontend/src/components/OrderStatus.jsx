import React from "react";
import {
  UploadCloud,
  Send,
  Download,
  Cpu,
  Printer,
  CheckCircle2,
  XCircle
} from "lucide-react";

/**
 * Maps print-job status to user-facing display messages:
 * - UPLOADING
 * - QUEUED ("Sending to printer...")
 * - DOWNLOADING ("Sending to printer...")
 * - PROCESSING ("Sending to printer...")
 * - PRINTING ("Printer is printing...")
 * - COMPLETED
 * - FAILED
 * - CANCELLED
 */
export function getOrderStatusMeta(status) {
  switch (status) {
    case "UPLOADING":
      return {
        label: "Uploading...",
        headline: "Uploading document to GridFS...",
        description: "Streaming your file securely to MongoDB Atlas GridFS.",
        badgeClass: "bg-zinc-100 text-zinc-800 border-zinc-200",
        stepIndex: 0,
        icon: UploadCloud
      };
    case "QUEUED":
      return {
        label: "Queued",
        headline: "Sending to printer...",
        description: "Job is queued and waiting for your Windows 11 print agent to claim it.",
        badgeClass: "bg-amber-50 text-amber-800 border-amber-200",
        stepIndex: 1,
        icon: Send
      };
    case "DOWNLOADING":
      return {
        label: "Downloading",
        headline: "Sending to printer...",
        description: "Your Windows 11 laptop is downloading the document from MongoDB GridFS.",
        badgeClass: "bg-blue-50 text-blue-800 border-blue-200",
        stepIndex: 2,
        icon: Download
      };
    case "PROCESSING":
      return {
        label: "Processing",
        headline: "Sending to printer...",
        description: "Preparing selected pages, orientation, and printer layout on your laptop.",
        badgeClass: "bg-indigo-50 text-indigo-800 border-indigo-200",
        stepIndex: 3,
        icon: Cpu
      };
    case "PRINTING":
      return {
        label: "Printing",
        headline: "Printer is printing...",
        description: "Your USB HP printer is actively printing the document.",
        badgeClass: "bg-[#8D0100]/10 text-[#8D0100] border-[#8D0100]/25",
        stepIndex: 4,
        icon: Printer
      };
    case "COMPLETED":
      return {
        label: "Completed",
        headline: "Printing completed",
        description: "The Windows print spooler confirmed your document finished printing.",
        badgeClass: "bg-emerald-50 text-emerald-800 border-emerald-200",
        stepIndex: 5,
        icon: CheckCircle2
      };
    case "CANCELLED":
      return {
        label: "Cancelled",
        headline: "Print job cancelled",
        description: "This print job was cancelled before printing.",
        badgeClass: "bg-zinc-100 text-zinc-600 border-zinc-200",
        stepIndex: -1,
        icon: XCircle
      };
    case "FAILED":
    default:
      return {
        label: "Failed",
        headline: "Printing failed",
        description: "The printer reported an error. Check that your HP printer is powered on and connected via USB.",
        badgeClass: "bg-red-50 text-red-700 border-red-200",
        stepIndex: -1,
        icon: XCircle
      };
  }
}

const TIMELINE_STEPS = [
  { key: "QUEUED", title: "Queued in MongoDB GridFS" },
  { key: "DOWNLOADING", title: "Downloaded by Windows 11 Agent" },
  { key: "PROCESSING", title: "Formatted for HP Printer" },
  { key: "PRINTING", title: "Printer is printing..." },
  { key: "COMPLETED", title: "Completed" }
];

export default function OrderStatus({ status, failureReason = null }) {
  const meta = getOrderStatusMeta(status);
  const StatusIcon = meta.icon;
  const isError = status === "FAILED" || status === "CANCELLED";

  return (
    <div className="bg-white rounded-2xl border border-zinc-200 p-4 sm:p-5">
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

      {!isError && (
        <div className="mt-4 pt-3.5 border-t border-zinc-100 space-y-2">
          {TIMELINE_STEPS.map((step, idx) => {
            const stepNum = idx + 1;
            const isDone = meta.stepIndex > stepNum || (meta.stepIndex === 5 && stepNum === 5);
            const isCurrent = meta.stepIndex === stepNum && stepNum !== 5;

            return (
              <div key={step.key} className="flex items-center gap-2.5">
                <div
                  className={`w-5 h-5 rounded-md flex items-center justify-center text-[11px] font-bold shrink-0 ${
                    isDone
                      ? "bg-emerald-600 text-white"
                      : isCurrent
                        ? "bg-[#8D0100] text-white"
                        : "bg-zinc-100 text-zinc-400"
                  }`}
                >
                  {isDone ? "✓" : stepNum}
                </div>
                <span
                  className={`text-xs sm:text-sm ${
                    isCurrent
                      ? "font-semibold text-[#8D0100]"
                      : isDone
                        ? "font-medium text-zinc-800"
                        : "text-zinc-400"
                  }`}
                >
                  {step.title}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
