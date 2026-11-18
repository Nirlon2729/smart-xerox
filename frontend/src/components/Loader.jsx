import React from "react";
import { Loader2 } from "lucide-react";

export default function Loader({ label = "Loading...", fullScreen = false, size = "md" }) {
  const iconSize = size === "sm" ? "w-4 h-4" : size === "lg" ? "w-8 h-8" : "w-6 h-6";

  const content = (
    <div className="flex flex-col items-center justify-center gap-2.5 py-6 text-center">
      <Loader2 className={`${iconSize} animate-spin text-[#8D0100]`} />
      {label && <p className="text-sm font-medium text-zinc-600">{label}</p>}
    </div>
  );

  if (fullScreen) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-4">
        {content}
      </div>
    );
  }

  return content;
}
