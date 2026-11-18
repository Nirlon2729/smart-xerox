import React, { useRef } from "react";
import { FileText, Image as ImageIcon, Trash2, RefreshCw } from "lucide-react";
import { formatFileSize } from "../utils/formatters";

export default function FileCard({
  originalName,
  fileSize,
  pageCount,
  documentType = "pdf",
  width = null,
  height = null,
  onRemove,
  onReplace,
  disabled = false
}) {
  const replaceInputRef = useRef(null);

  const handleReplaceChange = (e) => {
    const file = e.target.files?.[0];
    if (file && onReplace) {
      onReplace(file);
    }
    e.target.value = "";
  };

  const isImage = documentType === "image";

  return (
    <div className="bg-white rounded-2xl border border-zinc-200 p-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-[#8D0100]/10 text-[#8D0100] flex items-center justify-center shrink-0">
          {isImage ? (
            <ImageIcon className="w-5 h-5" />
          ) : (
            <FileText className="w-5 h-5" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <h3
            title={originalName}
            className="text-sm font-semibold text-zinc-900 truncate"
          >
            {originalName}
          </h3>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 mt-1 font-mono-code">
            <span>{formatFileSize(fileSize)}</span>
            <span>•</span>
            {isImage ? (
              <span className="font-semibold text-zinc-800">
                Image {width && height ? `(${width}×${height}px)` : "(1 page)"}
              </span>
            ) : (
              <span className="font-semibold text-zinc-800">
                {pageCount || 1} {pageCount === 1 ? "page" : "pages"} PDF
              </span>
            )}
          </div>
        </div>
      </div>

      {(onReplace || onRemove) && (
        <div className="mt-3.5 pt-3 border-t border-zinc-100 flex items-center gap-2">
          {onReplace && (
            <>
              <input
                ref={replaceInputRef}
                type="file"
                accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
                onChange={handleReplaceChange}
                className="hidden"
                disabled={disabled}
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => replaceInputRef.current?.click()}
                className="flex-1 min-h-[40px] px-3 py-2 rounded-lg border border-zinc-200 bg-zinc-50 hover:bg-zinc-100 text-zinc-800 text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition disabled:opacity-50"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Replace File</span>
              </button>
            </>
          )}

          {onRemove && (
            <button
              type="button"
              disabled={disabled}
              onClick={onRemove}
              className="min-h-[40px] px-3 py-2 rounded-lg border border-red-200 bg-red-50/60 hover:bg-red-100/70 text-red-700 text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Remove</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
