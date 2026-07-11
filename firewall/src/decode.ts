/**
 * Ward — Firewall decode pre-pass (PRD §7.1 hardening).
 *
 * An injection can hide under an encoding (base64 / hex / \uXXXX escapes /
 * zero-width breaks) so the pattern layer only half-sees it AND so the raw blob,
 * if forwarded to the Claude judge, trips the platform safety filter and degrades
 * the judge to an error. This pre-pass strips/decodes the obfuscation so the
 * scanner can (a) re-scan the DECODED content for injection signatures and
 * (b) hand the judge a DEFANGED view that never contains the live payload.
 *
 * Detection is conservative: a decoded region only counts as a "payload" if it
 * decodes to readable text. Addresses / hashes / random tokens decode to mostly
 * non-printable bytes and are ignored — so they neither trip a rescan nor get
 * defanged out of the judge's view.
 */

export type Encoding = "base64" | "hex" | "unicode-escape";

export interface DecodedBlob {
  encoding: Encoding;
  /** the exact substring as it appears in the (zero-width-stripped) text */
  raw: string;
  /** the decoded, readable payload */
  decoded: string;
}

export interface Prepass {
  /** input with zero-width characters removed */
  strippedText: string;
  hadZeroWidth: boolean;
  /** decoded payload-like blobs (readable text only) */
  blobs: DecodedBlob[];
}

const ZERO_WIDTH_G = /[\u200B-\u200D\u2060\uFEFF]/g;
const ZERO_WIDTH_T = /[\u200B-\u200D\u2060\uFEFF]/;

const PAYLOAD_MIN_LEN = 8;
const PRINTABLE_MIN = 0.85;

function printableRatio(s: string): number {
  const chars = [...s];
  if (chars.length === 0) return 0;
  let printable = 0;
  for (const ch of chars) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126)) printable++;
  }
  return printable / chars.length;
}

/** A decoded region is a real hidden message (not an address/hash) only if readable. */
function isPayload(s: string): boolean {
  return s.length >= PAYLOAD_MIN_LEN && printableRatio(s) >= PRINTABLE_MIN;
}

function decodeBase64(raw: string): string | null {
  try {
    return Buffer.from(raw, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function decodeHex(raw: string): string | null {
  let hex = raw.replace(/^0x/i, "");
  if (hex.length % 2 !== 0) hex = hex.slice(0, -1);
  if (hex.length === 0) return null;
  try {
    return Buffer.from(hex, "hex").toString("utf8");
  } catch {
    return null;
  }
}

function decodeUnicodeEscapes(raw: string): string {
  return raw.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

export function prepass(text: string): Prepass {
  const hadZeroWidth = ZERO_WIDTH_T.test(text);
  const strippedText = text.replace(ZERO_WIDTH_G, "");

  const blobs: DecodedBlob[] = [];
  const seen = new Set<string>();
  const add = (encoding: Encoding, raw: string, decoded: string | null): void => {
    if (decoded === null || !isPayload(decoded)) return;
    const key = `${encoding}:${raw}`;
    if (seen.has(key)) return;
    seen.add(key);
    blobs.push({ encoding, raw, decoded });
  };

  for (const m of strippedText.matchAll(/[A-Za-z0-9+/]{24,}={0,2}/g)) add("base64", m[0], decodeBase64(m[0]));
  for (const m of strippedText.matchAll(/(?:0x)?[0-9a-fA-F]{16,}/g)) add("hex", m[0], decodeHex(m[0]));
  for (const m of strippedText.matchAll(/(?:\\u[0-9a-fA-F]{4}){4,}/g)) add("unicode-escape", m[0], decodeUnicodeEscapes(m[0]));

  return { strippedText, hadZeroWidth, blobs };
}
