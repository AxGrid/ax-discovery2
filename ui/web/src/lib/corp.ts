// Corp-ui SDK integration. discovery2 runs in two modes:
//
//   • Standalone — opened directly at its own domain. The user logs in
//     through our /v1/auth/login form which calls corp-ui's
//     verify-password server-to-server, and we mint our own cookie
//     session. The SDK is not loaded.
//
//   • Iframe — discovery is rendered inside corp-ui's iframe wrapper.
//     The parent posts an iframe JWT to us via the SDK; every API call
//     attaches it as a Bearer header. Our backend introspects the token
//     against corp-ui per-request (with a 30s SDK-level cache).
//
// Detection is intentionally simple: if window.parent !== window AND we
// have a document.referrer pointing somewhere, we ask the SDK to do the
// real handshake. If it fails (no parent, wrong origin, token expired)
// we fall back to standalone mode.

declare global {
  interface Window {
    CorpSDK?: {
      ready: () => Promise<{
        token: string;
        perms: Record<string, string>;
        locale?: string;
        theme?: string;
        corpUrl?: string;
        user?: {
          id: number;
          email?: string;
          username?: string;
          display_name?: string;
          is_admin?: boolean;
          account_id?: string;
        };
      }>;
      token: () => string | null;
      can: (key: string, level: string) => boolean;
      corpUrl: () => string;
      onTokenRefresh: (fn: (token: string) => void) => void;
      onTheme: (fn: (theme: string) => void) => void;
      onLocale: (fn: (locale: string) => void) => void;
    };
  }
}

export type CorpReadyResult = {
  token: string;
  perms: Record<string, string>;
  corpUrl: string;
  locale?: string;
  theme?: string;
  user?: NonNullable<NonNullable<Window["CorpSDK"]>["ready"] extends () => Promise<infer R> ? R : never>["user"];
};

export function isIframe(): boolean {
  try {
    return window.parent !== window;
  } catch {
    // Cross-origin access on `parent` throws — that itself is proof we're embedded.
    return true;
  }
}

// detectCorpOrigin parses document.referrer to find the host's origin.
// We can't read window.parent.location (cross-origin), but the referrer
// header is set when the parent navigates to our iframe URL.
export function detectCorpOrigin(): string | null {
  const ref = document.referrer;
  if (!ref) return null;
  try {
    const u = new URL(ref);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

let sdkPromise: Promise<CorpReadyResult> | null = null;

// injectCorpStyles pulls corp-ui.css from the host so our chrome (top
// bar, badges, button hovers) inherits the same tokens — backgrounds,
// borders, accent — as everything else the user sees in corp-ui. The
// link is appended AFTER our static stylesheets so its tokens win where
// they're defined; for tokens corp-ui doesn't ship, ax-styler keeps
// providing them.
//
// Safe to call multiple times — guarded by a data attribute.
function injectCorpStyles(origin: string) {
  if (document.querySelector('link[data-corp-styles]')) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `${origin}/design-kit/corp-ui.css`;
  link.dataset.corpStyles = "1";
  document.head.appendChild(link);
}

// loadCorpSDK injects the SDK <script> from the host and resolves once
// CorpSDK.ready() returns. Memoised so repeated calls share one promise.
//
// On any failure (no parent, no referrer, SDK never loads, ready()
// rejects) the returned promise rejects — callers should treat that as
// "fall back to standalone mode".
export function loadCorpSDK(): Promise<CorpReadyResult> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<CorpReadyResult>((resolve, reject) => {
    const origin = detectCorpOrigin();
    if (!origin) {
      reject(new Error("corp host origin not detectable from document.referrer"));
      return;
    }
    // Fire-and-forget; CSS doesn't gate JS readiness. If corp-ui.css 404s
    // we just keep ax-styler tokens — no error path matters here.
    injectCorpStyles(origin);
    const existing = document.querySelector<HTMLScriptElement>(`script[data-corp-sdk]`);
    const onReady = async () => {
      if (!window.CorpSDK) {
        reject(new Error("CorpSDK global missing after script load"));
        return;
      }
      try {
        const r = await window.CorpSDK.ready();
        resolve({
          token: r.token,
          perms: r.perms || {},
          corpUrl: r.corpUrl || origin,
          locale: r.locale,
          theme: r.theme,
          user: r.user,
        });
      } catch (e) {
        reject(e);
      }
    };
    if (existing) {
      if (window.CorpSDK) onReady();
      else existing.addEventListener("load", onReady, { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = `${origin}/design-kit/corp-sdk.js`;
    s.async = true;
    s.dataset.corpSdk = "1";
    s.addEventListener("load", onReady, { once: true });
    s.addEventListener("error", () => reject(new Error("corp-sdk.js failed to load")), { once: true });
    document.head.appendChild(s);
  });
  return sdkPromise;
}

