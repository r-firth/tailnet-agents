import { useEffect, useState } from "react";
import { Bell, BellOff, X } from "lucide-react";
import { api, randomId } from "./api";
const browserId = () => {
  let id = localStorage.getItem("tailnet-push-client");
  if (!id) {
    id = randomId();
    localStorage.setItem("tailnet-push-client", id);
  }
  return id;
};
export function Notifications({
  chatId,
  installUrl,
}: {
  chatId: string;
  installUrl?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const supported =
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  useEffect(() => {
    if (!supported) return;
    let disposed = false;
    navigator.serviceWorker
      .getRegistration()
      .then((r) => r?.pushManager.getSubscription())
      .then((subscription) => {
        if (!disposed) setEnabled(!!subscription);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [supported]);
  useEffect(() => {
    if (!enabled) return;
    const tab = randomId();
    const update = () => {
      void api<{ subscribed: boolean }>("/push/presence", {
        client_id: browserId(),
        tab_id: tab,
        chat_id:
          document.visibilityState === "visible" && document.hasFocus()
            ? chatId
            : null,
      })
        .then((r) => {
          if (!r.subscribed) setEnabled(false);
        })
        .catch(() => {});
    };
    update();
    const interval = setInterval(update, 20000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      void api("/push/presence", {
        client_id: browserId(),
        tab_id: tab,
        chat_id: null,
      }).catch(() => {});
    };
  }, [enabled, chatId]);
  async function toggle() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (enabled) {
        await api("/push/unsubscribe", { client_id: browserId() });
        const registration = await navigator.serviceWorker.getRegistration();
        await (
          await registration?.pushManager.getSubscription()
        )?.unsubscribe();
        setEnabled(false);
        return;
      }
      // Browsers require this prompt to happen directly after a user gesture.
      if ((await Notification.requestPermission()) !== "granted")
        throw new Error(
          "Notifications are blocked. Allow them in this site’s browser settings to enable push.",
        );
      await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none",
      });
      const registration = await navigator.serviceWorker.ready;
      const { public_key } = await api<{ public_key: string }>("/push/config");
      const bytes = Uint8Array.from(
        atob(public_key.replace(/-/g, "+").replace(/_/g, "/")),
        (c) => c.charCodeAt(0),
      );
      let subscription = await registration.pushManager.getSubscription();
      if (
        subscription &&
        String(new Uint8Array(subscription.options.applicationServerKey!)) !==
          String(bytes)
      ) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes,
      });
      await api("/push/subscribe", {
        client_id: browserId(),
        subscription: subscription.toJSON(),
      });
      setEnabled(true);
      setNotice("You’ll hear when work finishes, fails, or needs you.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="notification-settings">
      <button
        className="text-button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Bell size={15} />
        {enabled ? "Notifications on" : "Notifications"}
      </button>
      {open && (
        <section className="notification-panel">
          <header>
            <span className="instrument-label">STAY IN THE LOOP</span>
            <button
              className="icon-button"
              aria-label="Close notification settings"
              onClick={() => setOpen(false)}
            >
              <X size={15} />
            </button>
          </header>
          <p>
            Finished, failed, or waiting for you. Quiet while you’re watching
            the session.
          </p>
          {supported ? (
            <>
              <button className="button" disabled={busy} onClick={toggle}>
                {enabled ? <BellOff size={15} /> : <Bell size={15} />}{" "}
                {busy
                  ? "Connecting…"
                  : enabled
                    ? "Turn off on this device"
                    : "Enable notifications"}
              </button>
              {enabled && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await api("/push/test", {
                        client_id: browserId(),
                        chat_id: chatId,
                      });
                      setNotice("Test notification sent.");
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Send a test
                </button>
              )}
            </>
          ) : (
            <p className="notification-help">
              {!window.isSecureContext
                ? "Open the HTTPS address to enable notifications."
                : "Install the app on your Home Screen, then enable notifications here."}
              {installUrl?.startsWith("https://") && (
                <a href={installUrl}>Open secure app ↗</a>
              )}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
