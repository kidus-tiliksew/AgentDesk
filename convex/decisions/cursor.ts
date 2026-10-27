// The public HTTP API's opaque list cursor: base64url of a JSON value.
// `listForApi` and component-agent-presence's agent list both use it. The
// module imports nothing, so another domain reads it without a module cycle.

export function encodeCursorJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

// The JSON value inside a cursor, or undefined when the text is not one.
export function decodeCursorJson(cursor: string): unknown {
  const bytes = fromBase64url(cursor);
  if (bytes === null) {
    return undefined;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

// base64url without padding.
export function base64url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// The bytes of base64url text, or null when the text is not base64url. A
// length of 1 modulo 4 encodes no whole byte, and `atob` refuses it, so it is
// null like any other invalid encoding and never throws.
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) {
    return null;
  }
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  let binary: string;
  try {
    binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  } catch {
    return null;
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
