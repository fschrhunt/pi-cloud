import { createHash, timingSafeEqual } from "node:crypto";
import type { ApiCredential } from "./config.js";
import type { Principal } from "./domain.js";
import { unauthorized } from "./errors.js";

/** Resolves configured user/service bearer credentials without exposing tokens to domain code. */
export class Authenticator {
  private readonly credentials = new Map<string, { digest: Buffer; principal: Principal }>();

  constructor(credentials: ApiCredential[]) {
    for (const credential of credentials) {
      const digest = hash(credential.token);
      this.credentials.set(digest.toString("hex"), {
        digest,
        principal: {
          id: credential.subjectId,
          type: credential.type,
          displayName: credential.displayName,
        },
      });
    }
  }

  authenticate(authorization: string | undefined): Principal {
    const token = bearerToken(authorization);
    if (!token) throw unauthorized();

    const digest = hash(token);
    const match = this.credentials.get(digest.toString("hex"));
    if (!match || !timingSafeEqual(digest, match.digest)) throw unauthorized();
    return match.principal;
  }
}

/** Compares a bearer credential in constant time and never returns its value. */
export function hasBearerToken(authorization: string | undefined, expectedToken: string): boolean {
  const token = bearerToken(authorization);
  if (!token) return false;
  return timingSafeEqual(hash(token), hash(expectedToken));
}

export function bearerToken(authorization: string | undefined): string | undefined {
  const prefix = "Bearer ";
  return authorization?.startsWith(prefix) ? authorization.slice(prefix.length) : undefined;
}

export function tokenDigest(token: string): string {
  return hash(token).toString("hex");
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
