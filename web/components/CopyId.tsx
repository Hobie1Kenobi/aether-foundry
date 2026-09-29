"use client";

import { useState } from "react";

export function CopyId({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="copy-id"
      aria-label={copied ? "Copied" : "Copy identifier"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
