import React, { useRef, useState } from "react";
import { FileUp, AlertCircle, FileText, Image as ImageIcon } from "lucide-react";

export default function UploadBox({
  onSelectFile,
  onSelectFiles,
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

  const dispatchFiles = (fileList) => {
    const files = Array.from(fileList || []).filter(Boolean);
    if (files.length === 0) return;
    if (typeof onSelectFiles === "function") {
      onSelectFiles(files);
    } else if (typeof onSelectFile === "function") {
      onSelectFile(files[0]);
    }
  };

  const handleFileChange = (e) => {
    dispatchFiles(e.target.files);
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
    dispatchFiles(e.dataTransfer?.files);
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
        className={`rounded-2xl border-2 border-dashed p-6 sm:p-7 text-center transition select-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#8D0100] focus:ring-offset-2 ${
          isDragging
            ? "border-[#8D0100] bg-[#8D0100]/5"
            : error
              ? "border-red-300 bg-white"
              : "border-zinc-300 bg-white hover:border-[#8D0100]/60 shadow-2xs"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
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

        <h2 className="text-base sm:text-lg font-bold text-zinc-900">
          {uploading ? "Uploading & Inspecting Document..." : "Upload PDF or Image Documents"}
        </h2>

        <p className="text-xs sm:text-sm text-zinc-500 mt-1 max-w-xs mx-auto">
          {uploading
            ? "Verifying pages and preparing live print preview."
            : `Select one or multiple PDF, JPG, JPEG, or PNG files • Max ${maxUploadMb} MB per file`}
        </p>

        {uploading ? (
          <div className="mt-5 max-w-xs mx-auto">
            <div className="flex items-center justify-between text-xs font-semibold text-zinc-700 mb-1.5">
              <span>Uploading Document</span>
              <span className="font-mono-code text-[#8D0100]">{uploadProgress}%</span>
            </div>
            <div className="w-full h-2.5 bg-zinc-100 rounded-full overflow-hidden border border-zinc-200">
              <div
                className="h-full bg-[#8D0100] transition-all duration-200"
                style={{ width: `${Math.max(8, uploadProgress)}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="mt-5">
            <span className="inline-flex items-center justify-center gap-2 w-full sm:w-auto min-h-[50px] px-7 py-3 rounded-xl bg-[#8D0100] text-white font-semibold text-sm sm:text-base hover:bg-[#730100] active:bg-[#5e0100] transition shadow-xs">
              <FileUp className="w-4.5 h-4.5" />
              <span>Select Document(s) to Print</span>
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
