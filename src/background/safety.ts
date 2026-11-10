/**
 * Site risk classification.
 *
 * The agent drives a real logged-in browser, so the blast radius of a wrong
 * click depends entirely on which site it is clicking in. This module maps a
 * hostname to a risk tier and the agent loop uses that tier to decide whether
 * `auto` approval mode may be honoured.
 *
 * The important property is that classification **fails closed**: a host we do
 * not recognise is treated as `restricted`, not `safe`. A new site therefore
 * gets a human in the loop by default, and only sites we can positively
 * identify as low-risk skip the prompt.
 */

import type { RiskTier, SiteAssessment } from "../shared/types";

interface Rule {
  tier: RiskTier;
  reason: string;
  /** Matched against the hostname with `===` or a leading-dot suffix test. */
  hosts: string[];
}

/**
 * Ordered most-restrictive first. The first matching rule wins, so a specific
 * `mail.google.com` rule can sit above the broader `google.com` rule.
 */
const RULES: Rule[] = [
  {
    tier: "blocked",
    reason: "banking and payments",
    hosts: [
      "chase.com",
      "bankofamerica.com",
      "wellsfargo.com",
      "citi.com",
      "hsbc.com",
      "barclays.co.uk",
      "santander.com",
      "revolut.com",
      "monzo.com",
      "wise.com",
      "paypal.com",
      "stripe.com",
      "venmo.com",
      "cash.app",
      "coinbase.com",
      "binance.com",
      "kraken.com",
      "crypto.com",
      "metamask.io",
    ],
  },
  {
    tier: "blocked",
    reason: "government and tax filing",
    hosts: [
      "irs.gov",
      "gov.uk",
      "ssa.gov",
      "uscis.gov",
      "dmv.ca.gov",
      "canada.ca",
      "australia.gov.au",
    ],
  },
  {
    tier: "blocked",
    reason: "health records",
    hosts: ["mychart.com", "patient.info", "epic.com"],
  },
  {
    tier: "blocked",
    reason: "password managers and secrets",
    hosts: [
      "1password.com",
      "lastpass.com",
      "bitwarden.com",
      "dashlane.com",
      "keepersecurity.com",
      "vault.bitwarden.com",
    ],
  },
  {
    tier: "restricted",
    reason: "email and messaging",
    hosts: [
      "mail.google.com",
      "outlook.live.com",
      "outlook.office.com",
      "outlook.office365.com",
      "mail.yahoo.com",
      "proton.me",
      "mail.proton.me",
      "fastmail.com",
      "slack.com",
      "discord.com",
      "teams.microsoft.com",
      "web.whatsapp.com",
      "web.telegram.org",
      "messenger.com",
    ],
  },
  {
    tier: "restricted",
    reason: "cloud infrastructure consoles",
    hosts: [
      "console.aws.amazon.com",
      "console.cloud.google.com",
      "portal.azure.com",
      "cloudflare.com",
      "dash.cloudflare.com",
      "vercel.com",
      "netlify.com",
      "heroku.com",
      "digitalocean.com",
      "linode.com",
      "runpod.io",
      "console.runpod.io",
    ],
  },
  {
    tier: "restricted",
    reason: "source control and code hosting",
    hosts: ["github.com", "gitlab.com", "bitbucket.org"],
  },
  {
    tier: "restricted",
    reason: "social accounts",
    hosts: [
      "twitter.com",
      "x.com",
      "facebook.com",
      "instagram.com",
      "linkedin.com",
      "reddit.com",
      "tiktok.com",
      "threads.net",
      "bsky.app",
    ],
  },
  {
    tier: "restricted",
    reason: "account settings and identity",
    hosts: [
      "accounts.google.com",
      "myaccount.google.com",
      "login.microsoftonline.com",
      "account.microsoft.com",
      "appleid.apple.com",
      "auth0.com",
      "okta.com",
    ],
  },
  {
    tier: "caution",
    reason: "shopping and checkout",
    hosts: [
      "amazon.com",
      "ebay.com",
      "etsy.com",
      "shopify.com",
      "walmart.com",
      "target.com",
      "aliexpress.com",
      "alibaba.com",
      "temu.com",
    ],
  },
  {
    tier: "caution",
    reason: "travel and bookings",
    hosts: [
      "booking.com",
      "airbnb.com",
      "expedia.com",
      "hotels.com",
      "kayak.com",
      "delta.com",
      "united.com",
      "aa.com",
    ],
  },
  {
    tier: "safe",
    reason: "documentation and reference",
    hosts: [
      "developer.mozilla.org",
      "docs.python.org",
      "nodejs.org",
      "typescriptlang.org",
      "react.dev",
      "vuejs.org",
      "wikipedia.org",
      "stackoverflow.com",
      "stackexchange.com",
      "readthedocs.io",
      "arxiv.org",
      "npmjs.com",
      "pypi.org",
      "crates.io",
    ],
  },
  {
    tier: "safe",
    reason: "search and general browsing",
    hosts: [
      "google.com",
      "bing.com",
      "duckduckgo.com",
      "search.brave.com",
      "startpage.com",
      "ecosia.org",
      "news.ycombinator.com",
      "lobste.rs",
    ],
  },
];

/** Local development hosts are always safe — they are the user's own machine. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

function matches(host: string, pattern: string): boolean {
  return host === pattern || host.endsWith(`.${pattern}`);
}

/**
 * Classify a URL. Returns `restricted` with `unknown: true` for anything that
 * does not match a rule, so unrecognised sites never run unattended.
 */
export function assess(url: string | undefined): SiteAssessment {
  if (!url) {
    return { tier: "restricted", reason: "no page loaded", unknown: true };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { tier: "restricted", reason: "unparseable URL", unknown: true };
  }

  if (parsed.protocol === "file:" || parsed.protocol === "data:" || parsed.protocol === "blob:") {
    return { tier: "restricted", reason: "local file", unknown: false };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { tier: "blocked", reason: `unsupported scheme ${parsed.protocol}`, unknown: false };
  }

  const host = parsed.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) {
    return { tier: "safe", reason: "local development server", unknown: false };
  }

  for (const rule of RULES) {
    if (rule.hosts.some((pattern) => matches(host, pattern))) {
      return { tier: rule.tier, reason: rule.reason, unknown: false };
    }
  }

  return { tier: "restricted", reason: "unrecognised site", unknown: true };
}

/**
 * Whether `auto` approval mode may skip the prompt for this site.
 *
 * `blocked` never runs. `restricted` and unknown sites always prompt, even in
 * auto mode — that is the fail-closed behaviour.
 */
export function autoAllowed(assessment: SiteAssessment, safetyMode: "standard" | "permissive"): boolean {
  if (assessment.tier === "blocked") return false;
  if (safetyMode === "permissive") return true;
  return assessment.tier === "safe" || assessment.tier === "caution";
}

/** Human-readable one-liner for the approval prompt and the tool result. */
export function describe(assessment: SiteAssessment): string {
  const suffix = assessment.unknown ? " (unrecognised — treated as restricted)" : "";
  return `${assessment.tier}: ${assessment.reason}${suffix}`;
}
