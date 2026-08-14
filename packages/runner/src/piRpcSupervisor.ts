import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { HostedRuntimeLaunch, PiRpcClientCommand, PiRpcRecord } from "@pi-cloud/contracts";
import { StrictJsonlParser } from "./jsonl.js";
import { nativeSessionDirectory } from "./pathAuthorization.js";
import { BoundedStderrDiagnostic, redactRecord } from "./redaction.js";

export type PiRpcSupervisorOptions = {
  launch: HostedRuntimeLaunch;
  piExecutable?: string;
  environment?: NodeJS.ProcessEnv;
  credentialEnvironment?: Readonly<Record<string, string>>;
  configuredSecrets?: readonly string[];
  stderrMaxBytes?: number;
  onRecord: (record: PiRpcRecord) => void;
  onEnvironmentScrubbed?: () => void;
};

export type PiRpcFailureKind =
  | "startup_failure"
  | "malformed_output"
  | "unexpected_exit"
  | "wall_timeout"
  | "idle_timeout";

export class PiRpcProcessError extends Error {
  constructor(
    readonly kind: PiRpcFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "PiRpcProcessError";
  }
}

/** Supervises one disposable Pi RPC process while leaving its cwd and native session files intact. */
export class PiRpcSupervisor {
  readonly started: Promise<void>;
  readonly completed: Promise<void>;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly parser: StrictJsonlParser;
  private readonly stderr: BoundedStderrDiagnostic;
  private readonly childEnvironment: NodeJS.ProcessEnv;
  private readonly startedAt = Date.now();
  private resolveStarted!: () => void;
  private rejectStarted!: (error: Error) => void;
  private resolveCompleted!: () => void;
  private rejectCompleted!: (error: Error) => void;
  private failure: PiRpcProcessError | undefined;
  private cancellationRequested = false;
  private sawSpawn = false;
  private sawRecord = false;
  private sentCommand = false;
  private closed = false;
  private killTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private wallTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: PiRpcSupervisorOptions) {
    this.started = new Promise<void>((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
    });
    this.completed = new Promise<void>((resolve, reject) => {
      this.resolveCompleted = resolve;
      this.rejectCompleted = reject;
    });

    const secrets = options.configuredSecrets ?? Object.values(options.credentialEnvironment ?? {});
    this.childEnvironment = {
      ...(options.environment ?? allowlistedProcessEnvironment(process.env)),
      ...(options.credentialEnvironment ?? {}),
      PI_CODING_AGENT_DIR: options.launch.piAgentDirectory,
    };
    this.stderr = new BoundedStderrDiagnostic(secrets, options.stderrMaxBytes ?? options.launch.limits.maxRecordBytes);
    this.parser = new StrictJsonlParser(
      {
        maxPartialBytes: options.launch.limits.maxRecordBytes + 1,
        maxRecordBytes: options.launch.limits.maxRecordBytes,
        maxCumulativeBytes: options.launch.limits.maxCumulativeBytes,
      },
      (record) => {
        this.sawRecord = true;
        this.touchIdleTimer();
        options.onRecord(redactRecord(record, secrets));
      },
    );

    try {
      this.child = spawn(options.piExecutable ?? "pi", buildPiRpcArguments(options.launch), {
        cwd: options.launch.workspaceRoot,
        env: this.childEnvironment,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      this.scrubEnvironment();
      const failure = new PiRpcProcessError("startup_failure", errorMessage("Failed to spawn Pi RPC", error));
      this.rejectStarted(failure);
      this.rejectCompleted(failure);
      throw failure;
    }

    this.child.once("spawn", () => {
      this.sawSpawn = true;
      this.resolveStarted();
      this.touchIdleTimer();
    });
    this.child.once("error", (error) => {
      this.fail(new PiRpcProcessError("startup_failure", errorMessage("Pi RPC startup failed", error)));
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.parser.push(chunk);
      } catch (error: unknown) {
        this.fail(new PiRpcProcessError("malformed_output", errorMessage("Invalid Pi RPC output", error)));
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => this.stderr.push(chunk));
    this.child.stdin.on("error", () => undefined);
    this.child.once("close", (code, signal) => this.handleClose(code, signal));

    this.wallTimer = setTimeout(() => {
      this.fail(new PiRpcProcessError("wall_timeout", "Pi RPC exceeded its wall-time limit"));
    }, options.launch.limits.wallTimeSeconds * 1_000);
    this.wallTimer.unref();
  }

  /** Writes one validated native command as an LF-terminated JSON record. */
  send(command: PiRpcClientCommand): void {
    if (this.closed || this.cancellationRequested || this.failure) throw new Error("Pi RPC process is not accepting commands");
    this.sentCommand = true;
    this.touchIdleTimer();
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  /** Gracefully cancels Pi, escalating to process-group SIGKILL after the configured grace. */
  async cancel(): Promise<void> {
    if (this.closed) return this.completed;
    this.cancellationRequested = true;
    this.terminate();
    return this.completed;
  }

  private fail(failure: PiRpcProcessError): void {
    if (this.failure || this.closed || this.cancellationRequested) return;
    this.failure = failure;
    if (!this.sawSpawn) this.rejectStarted(failure);
    this.terminate();
  }

  private terminate(): void {
    signalProcessTree(this.child, "SIGTERM");
    if (this.killTimer || this.closed) return;
    this.killTimer = setTimeout(() => signalProcessTree(this.child, "SIGKILL"), this.options.launch.limits.terminationGraceSeconds * 1_000);
    this.killTimer.unref();
  }

  private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.wallTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.killTimer);

    try {
      this.parser.finish();
    } catch (error: unknown) {
      this.failure ??= new PiRpcProcessError("malformed_output", errorMessage("Invalid Pi RPC output", error));
    }
    const diagnostic = this.stderr.finish().trim();
    this.scrubEnvironment();

    if (this.cancellationRequested && !this.failure) {
      this.resolveCompleted();
      return;
    }
    const failure = this.failure ?? new PiRpcProcessError(
      this.sawRecord || this.sentCommand ? "unexpected_exit" : "startup_failure",
      `Pi RPC exited unexpectedly (code=${String(code)}, signal=${String(signal)})${diagnostic ? `: ${diagnostic}` : ""}`,
    );
    this.rejectCompleted(failure);
  }

  private touchIdleTimer(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.fail(new PiRpcProcessError("idle_timeout", `Pi RPC was idle for ${Date.now() - this.startedAt}ms`));
    }, this.options.launch.limits.idleTimeSeconds * 1_000);
    this.idleTimer.unref();
  }

  private scrubEnvironment(): void {
    for (const key of Object.keys(this.childEnvironment)) {
      this.childEnvironment[key] = "";
      delete this.childEnvironment[key];
    }
    this.options.onEnvironmentScrubbed?.();
  }
}

/** Constructs the exact supported Pi CLI argv for a new or resumed native session. */
export function buildPiRpcArguments(launch: HostedRuntimeLaunch): string[] {
  const args = [
    "--mode",
    "rpc",
    "--session-dir",
    nativeSessionDirectory(launch),
    launch.projectTrust === "trusted" ? "--approve" : "--no-approve",
  ];
  if (launch.nativeSession.kind === "resume") args.push("--session", launch.nativeSession.sessionFile);
  return args;
}

function allowlistedProcessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowedNames = [
    "HOME",
    "LANG",
    "LC_ALL",
    "LOGNAME",
    "NO_PROXY",
    "PATH",
    "SHELL",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "TZ",
    "USER",
  ];
  return Object.fromEntries(
    allowedNames.flatMap((name) => environment[name] === undefined ? [] : [[name, environment[name]]]),
  );
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when it exited between the state check and signal.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Close/error handlers own final settlement.
  }
}

function errorMessage(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
}
