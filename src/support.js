/**
 * Quran Trivia / Islamic Trivia — Support Developer + SGSS link openers.
 *
 * Proven pattern from Brick Breaker (2026-08-08): tapping "Support
 * Developer" (or the SGSS Quran link) opens the real page in the user's
 * browser. In Discord we use the ONLY sanctioned external-link API:
 * discordSdk.commands.openExternalLink({url}) → one-time "Trust this
 * domain" prompt → real browser. In a plain browser the native
 * target="_blank" works.
 *
 * Resilient: even if the OAuth/authorize flow failed earlier (leaving
 * discordSdk null), we construct a bare SDK — openExternalLink needs no
 * auth, only the handshake. We attempt the SDK path in ANY iframe (not
 * just when frame_id is present) so links work even for launches that
 * Discord didn't fully parameterize; window.open remains the fallback.
 */

import { discordSdk, inDiscordFrame } from "./discord.js";
import { DiscordSDK } from "./vendor/discord-sdk.mjs";

const SUPPORT_URL = "https://walusimbi-leon1.github.io/voice-support/";
const SGSS_URL = "https://walusimbi-leon1.github.io/sgss-quran/";

// Two Discord apps can launch this game — the iframe URL carries the
// client_id, so prefer it; fall back to Quran Trivia's ID for direct links.
function currentClientId() {
  try {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("client_id");
    if (id) return id;
  } catch { /* ignore */ }
  return "1535569391931101224"; // Quran Trivia app
}

function isIframe() {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

async function openExternalUrl(url) {
  // Top-level browser window: native target="_blank" is exactly right.
  if (!isIframe()) return;
  // Inside ANY frame (Discord sandbox blocks window.open): use the SDK.
  let sdk = discordSdk;
  if (!sdk || typeof sdk.commands.openExternalLink !== "function") {
    sdk = new DiscordSDK(currentClientId());
    await sdk.ready();
  }
  await sdk.commands.openExternalLink({ url });
}

function wireLinks() {
  const links = document.querySelectorAll(
    "a.support-link, a.sgss-link, a[href='" + SUPPORT_URL + "'], a[href='" + SGSS_URL + "']",
  );
  links.forEach((a) => {
    a.addEventListener("click", (e) => {
      if (!isIframe()) return; // native target="_blank" handles top-level
      e.preventDefault();
      const url = a.href && a.href.indexOf("voice-support") !== -1 ? SUPPORT_URL : SGSS_URL;
      openExternalUrl(url).catch((err) => {
        console.error("[support] openExternalLink failed:", err);
        try {
          window.open(url, "_blank");
        } catch { /* sandboxed — nothing else we can do */ }
      });
    });
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireLinks);
} else {
  wireLinks();
}
