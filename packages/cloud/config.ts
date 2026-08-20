import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  cloudClientConfigSchema,
  type CloudClientConfig,
} from "@pi-cloud/contracts";

const maxConfigBytes = 64 * 1_024;

/** Returns the sole per-user connection file used by the Pi Cloud extension. */
export function defaultCloudConfigPath(): string {
  return join(homedir(), ".config", "pi-cloud", "config.json");
}

/** Reads and validates a private client configuration, returning undefined before first-run setup. */
export async function readCloudConfig(path = defaultCloudConfigPath()): Promise<CloudClientConfig | undefined> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Pi Cloud configuration is not a regular file: ${path}`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`Pi Cloud configuration permissions must be 0600: ${path}`);
  }
  if (metadata.size > maxConfigBytes) {
    throw new Error(`Pi Cloud configuration exceeds ${maxConfigBytes} bytes: ${path}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new Error(`Pi Cloud configuration is not valid JSON: ${path}`, { cause: error });
  }
  return cloudClientConfigSchema.parse(value);
}

/** Atomically persists a validated connection with private file and directory permissions. */
export async function writeCloudConfig(
  config: CloudClientConfig,
  path = defaultCloudConfigPath(),
): Promise<void> {
  const parsed = cloudClientConfigSchema.parse(config);
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporaryPath = join(directory, `.config-${randomUUID()}.tmp`);
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error: unknown) {
    await file.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Pi Cloud configuration directory is not a regular directory: ${path}`);
  }
  await chmod(path, 0o700);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
