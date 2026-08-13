import { z } from "zod";

/**
 * Shared repository identity rules. A task is authorized for exactly one HTTPS repository and one
 * full immutable Git object name, so neither side of the runner boundary may resolve a moving ref.
 */

/** Full SHA-1 commit object names only; SHA-256 repositories need explicit object-format support. */
const immutableRevisionPattern = /^[0-9a-fA-F]{40}$/;

export const immutableRevisionSchema = z
  .string()
  .regex(
    immutableRevisionPattern,
    "revision must be a full immutable Git SHA-1 commit (40 hexadecimal characters)",
  )
  .transform((value) => value.toLowerCase());

export const repositoryUrlSchema = z
  .string()
  .max(2_048)
  .transform((value, context) => {
    try {
      return parseRepositoryUrl(value).toString();
    } catch (error: unknown) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "repositoryUrl is invalid",
      });
      return z.NEVER;
    }
  });

/**
 * Parses a repository URL that a runner may fetch, refusing anything that is not a plain HTTPS
 * remote. Embedded credentials, queries, and fragments are rejected so a repository URL can never
 * smuggle a secret or a transport option into Git.
 */
export function parseRepositoryUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("repositoryUrl must be an absolute URL");
  }
  if (url.protocol !== "https:") throw new Error("repositoryUrl must use HTTPS");
  if (url.username !== "" || url.password !== "") {
    throw new Error("repositoryUrl must not embed credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error("repositoryUrl must not carry a query or fragment");
  }
  if (url.hostname === "") throw new Error("repositoryUrl must include a host");
  return url;
}
