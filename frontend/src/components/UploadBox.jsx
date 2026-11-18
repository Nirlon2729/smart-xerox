import React, { useRef, useState } from "react";
import { FileUp, AlertCircle, FileText, Image as ImageIcon } from "lucide-react";

export default function UploadBox({
  onSelectFile,
  maxUploadMb = 20,
  uploading = false,
  uploadProgress = 0,
  error = null
}) {
  const fileInputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleTriggerPicker = () => {
    if (uploading) return;
    fileInputRef.current?.click();
  };

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      onSelectFile(file);
    }
    e.target.value = "";
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!uploading) setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (uploading) return;

    const file = e.dataTransfer?.files?.[0];
    if (file) {
      onSelectFile(file);
    }
  };

  return (
    <div className="w-full">
      <div
        role="button"
        tabIndex={0}
        onClick={handleTriggerPicker}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleTriggerPicker();
          }
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`rounded-2xl border p-6 sm:p-7 text-center transition select-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#8D0100] focus:ring-offset-2 ${
          isDragging
            ? "border-[#8D0100] bg-[#8D0100]/5"
            : error
              ? "border-red-300 bg-white"
              : "border-zinc-200 bg-white hover:border-zinc-300"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
          onChange={handleFileChange}
          className="hidden"
          disabled={uploading}
        />

        <div className="mx-auto flex items-center justify-center gap-2 mb-3.5">
          <div className="w-11 h-11 rounded-xl bg-[#8D0100]/10 text-[#8D0100] flex items-center justify-center">
            <FileText className="w-5.5 h-5.5" />
          </div>
          <div className="w-11 h-11 rounded-xl bg-zinc-100 text-zinc-700 flex items-center justify-center">
            <ImageIcon className="w-5.5 h-5.5" />
          </div>
        </div>

        <h2 className="text-base sm:text-lg font-semibold text-zinc-900">
          {uploading ? "Uploading to MongoDB GridFS..." : "Upload Document or Image"}
        </h2>

        <p className="text-xs sm:text-sm text-zinc-500 mt-1 max-w-xs mx-auto">
          {uploading
            ? "Validating file contents and preparing print preview."
            : `Supports PDF, JPG, JPEG, PNG • Max ${maxUploadMb} MB`}
        </p>

        {uploading ? (
          <div className="mt-5 max-w-xs mx-auto">
            <div className="flex items-center justify-between text-xs font-semibold text-zinc-700 mb-1.5">
              <span>Uploading</span>
              <span className="font-mono-code text-[#8D0100]">{uploadProgress}%</span>
            </div>
            <div className="w-full h-2 bg-zinc-100 rounded-full overflow-hidden border border-zinc-200">
              <div
                className="h-full bg-[#8D0100] transition-all duration-200"
                style={{ width: `${Math.max(8, uploadProgress)}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="mt-5">
            <span className="inline-flex items-center justify-center gap-2 w-full sm:w-auto min-h-[50px] px-7 py-3 rounded-xl bg-[#8D0100] text-white font-semibold text-sm sm:text-base hover:bg-[#730100] active:bg-[#5e0100] transition">
              <FileUp className="w-4.5 h-4.5" />
              <span>Upload Document</span>
            </span>
          </div>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="mt-3 p-3.5 rounded-xl bg-red-50 border border-red-200 flex items-start gap-2.5 text-left"
        >
          <AlertCircle className="w-4.5 h-4.5 text-red-600 shrink-0 mt-0.5" />
          <p className="text-xs sm:text-sm font-medium text-red-700 leading-snug">{error}</p>
        </div>
      )}
    </div>
  );
}
