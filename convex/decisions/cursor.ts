// The public HTTP API's opaque list cursor: base64url of a JSON value.
// `listForApi` and component-agent-presence's agent list both use it. The
// module imports nothing, so another domain reads it without a module cycle.

export function encodeCursorJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

// The JSON value inside a cursor, or undefined when the text is not one.
export function decodeCursorJson(cursor: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64url(cursor)));
  } catch {
    return undefined;
  }
}

function base64url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error("not base64url");
  }
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (c) =>
    c.charCodeAt(0),
  );
}
