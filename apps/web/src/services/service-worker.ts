/// <reference types="vite/client" />

export interface ServiceWorkerStatus {
  supported: boolean;
  registered: boolean;
  active: boolean;
  waiting: boolean;
  updateAvailable: boolean;
}

export interface CacheStatus {
  cacheNames: string[];
  totalEntries: number;
  version: string;
}

type ServiceWorkerEventType =
  | "registered"
  | "updated"
  | "offline"
  | "online"
  | "error";

type ServiceWorkerEventCallback = (data?: unknown) => void;

/**
 * Service Worker Manager
 * Handles registration, updates, and communication with the service worker
 */
class ServiceWorkerManager {
  private registration: ServiceWorkerRegistration | null = null;
  private listeners: Map<
    ServiceWorkerEventType,
    Set<ServiceWorkerEventCallback>
  > = new Map();
  private isOnline: boolean =
    typeof navigator !== "undefined" ? navigator.onLine : true;

  constructor() {
    // Set up online/offline listeners
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.handleOnline);
      window.addEventListener("offline", this.handleOffline);
    }
  }

  /**
   * Check if service workers are supported
   */
  isSupported(): boolean {
    return typeof navigator !== "undefined" && "serviceWorker" in navigator;
  }

  /**
   * Register the service worker
   */
  async register(): Promise<ServiceWorkerRegistration | null> {
    if (!this.isSupported()) {
      console.warn("[SW Manager] Service workers not supported");
      return null;
    }

    try {
      const registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
      });

      this.registration = registration;

      // Set up update handlers
      registration.addEventListener("updatefound", () => {
        this.handleUpdateFound(registration);
      });

      // Check for updates periodically (every hour)
      setInterval(
        () => {
          this.checkForUpdates();
        },
        60 * 60 * 1000,
      );

      // Emit registered event
      this.emit("registered", { registration });

      return registration;
    } catch (error) {
      console.error("[SW Manager] Registration failed:", error);
      this.emit("error", { error });
      return null;
    }
  }

  /**
   * Unregister the service worker
   */
  async unregister(): Promise<boolean> {
    if (!this.registration) {
      return false;
    }

    try {
      const success = await this.registration.unregister();
      if (success) {
        this.registration = null;
      }
      return success;
    } catch (error) {
      console.error("[SW Manager] Unregistration failed:", error);
      return false;
    }
  }

  /**
   * Check for service worker updates
   */
  async checkForUpdates(): Promise<void> {
    if (!this.registration) {
      return;
    }

    try {
      await this.registration.update();
    } catch (error) {
      console.error("[SW Manager] Update check failed:", error);
    }
  }

  /**
   * Skip waiting and activate new service worker
   */
  async skipWaiting(): Promise<void> {
    if (!this.registration?.waiting) {
      return;
    }

    this.sendMessage({ type: "SKIP_WAITING" });
  }

  /**
   * Get current service worker status
   */
  getStatus(): ServiceWorkerStatus {
    return {
      supported: this.isSupported(),
      registered: !!this.registration,
      active: !!this.registration?.active,
      waiting: !!this.registration?.waiting,
      updateAvailable: !!this.registration?.waiting,
    };
  }

  /**
   * Get cache status from service worker
   */
  async getCacheStatus(): Promise<CacheStatus | null> {
    return this.sendMessageWithResponse<CacheStatus>({
      type: "GET_CACHE_STATUS",
    });
  }

  /**
   * Clear all caches
   */
  async clearCache(): Promise<void> {
    await this.sendMessageWithResponse({ type: "CLEAR_CACHE" });
  }

  /**
   * Check if currently online
   */
  getOnlineStatus(): boolean {
    return this.isOnline;
  }

  /**
   * Add event listener
   */
  on(
    event: ServiceWorkerEventType,
    callback: ServiceWorkerEventCallback,
  ): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  /**
   * Remove event listener
   */
  off(
    event: ServiceWorkerEventType,
    callback: ServiceWorkerEventCallback,
  ): void {
    this.listeners.get(event)?.delete(callback);
  }

  /**
   * Send message to service worker
   */
  private sendMessage(message: { type: string; payload?: unknown }): void {
    if (!this.registration?.active) {
      return;
    }
    this.registration.active.postMessage(message);
  }

  /**
   * Send message and wait for response
   */
  private sendMessageWithResponse<T>(message: {
    type: string;
    payload?: unknown;
  }): Promise<T | null> {
    return new Promise((resolve) => {
      if (!this.registration?.active) {
        resolve(null);
        return;
      }

      const messageChannel = new MessageChannel();
      messageChannel.port1.onmessage = (event) => {
        resolve(event.data?.payload || null);
      };

      this.registration.active.postMessage(message, [messageChannel.port2]);

      // Timeout after 5 seconds
      setTimeout(() => resolve(null), 5000);
    });
  }

  /**
   * Handle update found
   */
  private handleUpdateFound(registration: ServiceWorkerRegistration): void {
    const newWorker = registration.installing;
    if (!newWorker) {
      return;
    }

    newWorker.addEventListener("statechange", () => {
      if (
        newWorker.state === "installed" &&
        navigator.serviceWorker.controller
      ) {
        this.emit("updated", { registration });
      }
    });
  }

  /**
   * Handle online event
   */
  private handleOnline = (): void => {
    this.isOnline = true;
    this.emit("online");
  };

  /**
   * Handle offline event
   */
  private handleOffline = (): void => {
    this.isOnline = false;
    this.emit("offline");
  };

  /**
   * Emit event to listeners
   */
  private emit(event: ServiceWorkerEventType, data?: unknown): void {
    this.listeners.get(event)?.forEach((callback) => {
      try {
        callback(data);
      } catch (error) {
        console.error("[SW Manager] Event callback error:", error);
      }
    });
  }

  /**
   * Cleanup
   */
  destroy(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.handleOnline);
      window.removeEventListener("offline", this.handleOffline);
    }
    this.listeners.clear();
  }
}

// Singleton instance
export const serviceWorkerManager = new ServiceWorkerManager();

export async function cleanupStaleServiceWorkers(): Promise<void> {
  if (typeof window === "undefined" || typeof navigator === "undefined") return;

  try {
    const regs = await navigator.serviceWorker?.getRegistrations?.();
    if (regs && regs.length > 0) {
      await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
      console.info(`[SW] Unregistered ${regs.length} stale service worker(s)`);
    }
    if (typeof caches !== "undefined" && caches.keys) {
      const keys = await caches.keys();
      if (keys.length > 0) {
        await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
        console.info(`[SW] Cleared ${keys.length} stale CacheStorage bucket(s)`);
      }
    }
  } catch {
    /* best-effort cleanup */
  }
}

/**
 * Register service worker on app startup
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  // Only register in production or if explicitly enabled
  if (import.meta.env.DEV && !import.meta.env.VITE_ENABLE_SW) {
    return null;
  }

  // Skip SW registration when running embedded in another page (Voidspace
  // chat iframe). Two reasons:
  //   1. The SW caches with scope `/` and was historically registered at
  //      the openreel STANDALONE origin (e.g. localhost:5173). When the
  //      same browser later loads the embedded build under a different
  //      origin, the stale cached SW can intercept network requests and
  //      hand back responses that 404 or point at the dead localhost
  //      origin — manifesting as "localhost refused to connect" inside
  //      the iframe on the FIRST load of a project (a hard refresh
  //      reissues network requests and bypasses the stale SW, which is
  //      why the same project loads cleanly on refresh).
  //   2. Offline support inside an iframe is meaningless — the parent
  //      chat already needs network for Firestore writes, so caching
  //      the iframe's static assets adds no value here.
  // Active de-registration of any pre-existing SW also runs so the
  // stale install gets cleaned up the moment a user loads the embedded
  // bundle, without waiting for a scheduled hard refresh.
  if (typeof window !== "undefined") {
    const isEmbedded =
      window.self !== window.top ||
      new URLSearchParams(window.location.search).get("embed") === "1";
    const isVoidspaceStudio = window.location.pathname.startsWith("/studio");
    if (isEmbedded || isVoidspaceStudio) {
      // Aggressive cleanup: unregister AND nuke all CacheStorage
      // entries the stale SW populated. Without the cache wipe,
      // subsequent loads can still get tainted responses (the cache
      // outlives the SW). Two failure modes were observed:
      //   - First-load "localhost refused" inside the iframe (stale
      //     SW intercepted asset requests pointing at :5173).
      //   - Second-load 404s on hashed bundles (cache held an HTML
      //     fallback for what should have been a JS chunk).
      await cleanupStaleServiceWorkers();
      return null;
    }
  }

  return serviceWorkerManager.register();
}

/**
 * Check if AI features are available (requires online)
 */
export function isAIAvailable(): boolean {
  return serviceWorkerManager.getOnlineStatus();
}
