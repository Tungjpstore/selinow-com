export function parseCookies(header: string | null): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  if (header === null) {
    return cookies;
  }

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) {
      continue;
    }

    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      cookies.set(name, value);
    }
  }

  return cookies;
}

type CookieOptions = {
  httpOnly: boolean;
  maxAge: number;
  sameSite: "Lax" | "Strict";
  secure: boolean;
};

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${String(options.maxAge)}`,
    `SameSite=${options.sameSite}`,
  ];

  if (options.httpOnly) {
    attributes.push("HttpOnly");
  }
  if (options.secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

export function clearCookie(name: string, secure: boolean, httpOnly: boolean): string {
  return serializeCookie(name, "", { httpOnly, maxAge: 0, sameSite: "Lax", secure });
}
