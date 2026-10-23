"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { PRODUCT } from "@/lib/product";

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "dev";
const UPDATE_CHECK_MS = 30 * 60 * 1000;

/**
 * Registers the service worker (production builds only) and offers "New version available" when a deploy lands.
 * The new worker only takes over when the person clicks Reload, so nobody loses a half-filled form.
 */
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    let reloading = false;
    let prompted = false;
    // Set only when the person clicks Reload. The first install also fires controllerchange (clients.claim), and
    // that must not reload the page.
    let accepted = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const offerUpdate = (worker: ServiceWorker) => {
      if (prompted) return;
      prompted = true;
      toast("New version available", {
        description: `Reload to get the latest ${PRODUCT.name}.`,
        duration: Infinity,
        action: { label: "Reload", onClick: () => { accepted = true; worker.postMessage({ type: "SKIP_WAITING" }); } },
      });
    };

    const onControllerChange = () => {
      if (!accepted || reloading) return;
      reloading = true;
      window.location.reload();
    };

    // Ask a waiting worker which deploy it belongs to. A page that already runs that deploy (the first load after
    // it went out) needs no prompt; an older open tab does.
    const versionOf = (worker: ServiceWorker) =>
      new Promise<string | null>((resolve) => {
        const channel = new MessageChannel();
        const timeout = setTimeout(() => resolve(null), 3000);
        channel.port1.onmessage = (event) => { clearTimeout(timeout); resolve(typeof event.data === "string" ? event.data : null); };
        worker.postMessage({ type: "VERSION" }, [channel.port2]);
      });

    const consider = async (worker: ServiceWorker) => {
      // Only an update when a worker already controls this page; the very first install needs no prompt.
      if (!navigator.serviceWorker.controller) return;
      if ((await versionOf(worker)) !== APP_VERSION) offerUpdate(worker);
    };

    const watch = (registration: ServiceWorkerRegistration) => {
      if (registration.waiting) void consider(registration.waiting);
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        installing?.addEventListener("statechange", () => {
          if (installing.state === "installed") void consider(installing);
        });
      });
    };

    const onVisible = (registration: ServiceWorkerRegistration) => () => {
      if (document.visibilityState === "visible") void registration.update().catch(() => undefined);
    };

    let visibilityHandler: (() => void) | undefined;
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => {
        watch(registration);
        visibilityHandler = onVisible(registration);
        document.addEventListener("visibilitychange", visibilityHandler);
        timer = setInterval(() => void registration.update().catch(() => undefined), UPDATE_CHECK_MS);
      })
      .catch(() => undefined);

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
      if (timer) clearInterval(timer);
    };
  }, []);

  return null;
}
