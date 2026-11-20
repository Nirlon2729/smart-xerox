import React from "react";
import { Loader2 } from "lucide-react";

/**
 * Compact animated inline spinner for use inside action buttons only.
 */
export function InlineSpinner({ className = "w-4 h-4" }) {
  return (
    <Loader2
      className={`${className} animate-spin shrink-0`}
      aria-hidden="true"
    />
  );
}

/**
 * Reusable button with built-in button-level loading state, animated spinner,
 * accessible aria-busy attribute, and immediate click locking.
 * Never introduces full-page overlays or blocks unrelated buttons.
 */
export default function LoadingButton({
  loading = false,
  loadingText = "Processing...",
  disabled = false,
  icon: Icon = null,
  iconPosition = "left",
  spinnerClassName = "w-4 h-4",
  className = "",
  type = "button",
  onClick,
  children,
  ...rest
}) {
  const isDisabled = Boolean(disabled || loading);

  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={loading}
      onClick={(e) => {
        if (isDisabled) {
          e.preventDefault();
          return;
        }
        if (onClick) onClick(e);
      }}
      className={`inline-flex items-center justify-center gap-2 transition disabled:opacity-60 disabled:cursor-not-allowed ${className}`}
      {...rest}
    >
      {loading ? (
        <>
          <InlineSpinner className={spinnerClassName} />
          <span>{loadingText}</span>
        </>
      ) : (
        <>
          {Icon && iconPosition === "left" && (
            <Icon className={spinnerClassName} aria-hidden="true" />
          )}
          <span>{children}</span>
          {Icon && iconPosition === "right" && (
            <Icon className={spinnerClassName} aria-hidden="true" />
          )}
        </>
      )}
    </button>
  );
}
