/**
 * Quran Trivia — Discord SDK integration
 *
 * Proven pattern from Arrow Blast / Trivia Rumble Elite (2026-08-06), which
 * runs smoothly in Discord:
 *  - Vendored same-origin SDK (@discord/embedded-app-sdk@2.5.0) — Discord's
 *    Activity sandbox blocks external hosts (jsDelivr/gstatic fetch failed).
 *  - authorize() handles BOTH result shapes:
 *      { access_token } → Public Client / PKCE → authenticate() directly
 *      { code }         → confidential → /api/exchange → authenticate()
 *  - authenticate({ access_token }) returns { user } — getUser() requires
 *    an explicit id in SDK 2.5.0 and fails with "child id is required".
 *  - channelId comes free from sdk.channelId (URL params Discord adds).
 *
 * TWO Discord apps launch this game: Quran Trivia (1535569391931101224)
 * and Islamic Trivia (1536204473582489650). Discord injects ?client_id=
 * into the Activity iframe URL, so the URL param carries whichever app
 * launched. The worker picks the right secret from that id.
 *
 * DIAGNOSTICS: a small pill appears briefly at the bottom when running
 * inside an iframe — it shows which params Discord supplied and whether
 * the SDK handshake + authorize succeeded. This exists to debug launches
 * where the SDK params are missing (an app launched outside a proper
 * embedded-Activity session).
 */

import { DiscordSDK } from "./vendor/discord-sdk.mjs";

// Discord Application Client ID — Discord injects ?client_id= into the
// Activity iframe URL, so the URL param wins (it carries whichever app
// launched: Quran Trivia OR Islamic Trivia). This constant is the
// fallback for direct links — Quran Trivia is the original app.
const CLIENT_ID = "1535569391931101224"; // Quran Trivia app

export let discordSdk = null;
export let isDiscord = false;
export let channelId = "lobby";

function isIframe() {
  if (typeof window === "undefined") return false;
  try {
    return window.top !== window.self;
  } catch {
    return true; // cross-origin access blocked → we're inside a frame
  }
}

export const inDiscordFrame = (() => {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  // Discord's embedded-app SDK requires frame_id + instance_id + platform.
  // Treat "any iframe that carries a client_id" as a Discord launch too, so
  // we attempt the SDK instead of silently giving up.
  return (
    params.has("frame_id") ||
    params.has("instance_id") ||
    (isIframe() && params.has("client_id"))
  );
})();

// ── Diagnostic pill (auto-hides) ────────────────────────────────────────────
let pillEl = null;
function debugPill(msg) {
  try {
    if (!pillEl) {
      pillEl = document.createElement("div");
      pillEl.id = "wf-debug-pill";
      pillEl.style.cssText =
        "position:fixed;left:8px;bottom:8px;z-index:9999;background:rgba(20,20,30,.92);" +
        "color:#7ee787;font:11px/1.4 monospace;padding:6px 9px;border-radius:6px;" +
        "max-width:92vw;pointer-events:none;white-space:pre-wrap;";
      document.body.appendChild(pillEl);
    }
    pillEl.textContent = msg;
    clearTimeout(pillEl._t);
    pillEl._t = setTimeout(() => {
      if (pillEl) pillEl.remove();
      pillEl = null;
    }, 9000);
  } catch { /* ignore */ }
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("[discord] " + label + " timed out after " + ms + "ms")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function initDiscord() {
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("client_id") || CLIENT_ID;
  const frameId = params.get("frame_id");
  const instanceId = params.get("instance_id");
  const platform = params.get("platform");

  console.debug("[discord] launch context", {
    clientId, frameId, instanceId, platform, inIframe: isIframe(), search: window.location.search,
  });

  if (!inDiscordFrame) {
    isDiscord = false;
    channelId = params.get("channel_id") || "lobby";
    return { isDiscord: false, channelId, user: null };
  }

  try {
    if (!clientId) {
      console.warn("[discord] no client_id in URL — running as guest");
      return { isDiscord: true, channelId: params.get("channel_id") || "lobby", user: null };
    }
    discordSdk = new DiscordSDK(clientId);
    await withTimeout(discordSdk.ready(), 8000, "sdk.ready");
    isDiscord = true;
    channelId = discordSdk.channelId || "lobby";
    debugPill(
      "Discord SDK: OK\nclient_id=" + clientId +
      "\nframe_id=" + (frameId || "MISSING") +
      " instance_id=" + (instanceId || "MISSING"),
    );

    const user = await runAuthorize(clientId);
    if (!user) debugPill("SDK OK · authorize FAILED — consent didn't complete");
    return { isDiscord: true, channelId, user };
  } catch (err) {
    console.error("[Discord] init failed:", err);
    isDiscord = false;
    debugPill(
      "Discord SDK FAILED: " + (err && err.message ? err.message : String(err)) +
      "\nclient_id=" + (clientId || "none") +
      "\nframe_id=" + (frameId || "MISSING") +
      "\ninstance_id=" + (instanceId || "MISSING") +
      "\nplatform=" + (platform || "MISSING"),
    );
    return { isDiscord: false, channelId: "lobby", user: null };
  }
}

async function runAuthorize(clientId) {
  if (!discordSdk) return null;

  const result = await withTimeout(
    discordSdk.commands.authorize({ client_id: clientId, scope: ["identify"] }),
    12000,
    "authorize",
  );
  if (!result) return null;

  // Public client (PKCE): the SDK returns an access_token directly.
  if (result.access_token) {
    const auth = await withTimeout(
      discordSdk.commands.authenticate({ access_token: result.access_token }),
      5000,
      "authenticate",
    );
    return auth?.user ?? null;
  }

  // Confidential client: returns a code → exchange via our worker.
  // Send our client_id too — the worker hosts TWO Discord apps (Quran
  // Trivia + Islamic Trivia) and needs it to pick the right secret.
  if (result.code) {
    const tokenResp = await fetch("/api/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: result.code, client_id: clientId }),
    });
    if (!tokenResp.ok) {
      const bodyText = await tokenResp.text().catch(() => "");
      console.error("[discord] exchange failed", tokenResp.status, bodyText);
      return null;
    }
    const { access_token } = await tokenResp.json();
    if (!access_token) return null;
    const auth = await withTimeout(
      discordSdk.commands.authenticate({ access_token }),
      5000,
      "authenticate",
    );
    return auth?.user ?? null;
  }

  return null;
}
