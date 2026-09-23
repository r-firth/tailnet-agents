import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import "./update-notice.css";

const reloadPage = () => window.location.reload();

export function UpdateNotice({
  buildId = import.meta.env.VITE_HUB_BUILD_ID,
  canReload = true,
  onReload = reloadPage,
}: {
  buildId?: string;
  canReload?: boolean;
  onReload?: () => void;
}) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!buildId || available) return;
    let stopped = false;
    let pending: AbortController | undefined;
    const check = async () => {
      if (stopped || pending || document.visibilityState === "hidden") return;
      const controller = new AbortController();
      pending = controller;
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch("/build.json", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        const manifest = await response.json();
        if (
          !stopped &&
          typeof manifest?.build_id === "string" &&
          manifest.build_id.trim() &&
          manifest.build_id !== buildId
        ) {
          setAvailable(true);
        }
      } catch {
        // Offline, or a deployment is still being copied. Retry on return/poll.
      } finally {
        window.clearTimeout(timeout);
        pending = undefined;
      }
    };
    void check();
    const interval = window.setInterval(check, 60_000);
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      stopped = true;
      pending?.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [buildId, available]);

  if (!available) return null;
  return (
    <div className="update-notice" role="status">
      <span>
        <strong>Update ready</strong>
        {!canReload && <small>Finish your draft to reload.</small>}
      </span>
      <button onClick={onReload} disabled={!canReload}>
        <RefreshCw size={14} /> Reload
      </button>
    </div>
  );
}
