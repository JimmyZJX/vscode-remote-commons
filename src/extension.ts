import { ChildProcess, ExecException, spawn, SpawnOptions } from "child_process";
import { randomUUID } from "crypto";
import EventEmitter, { once } from "events";
import { mkdir, readdir, stat, writeFile } from "fs/promises";
import { platform } from "os";
import { dirname } from "path";
import { text } from "stream/consumers";
import { commands, ExtensionContext, extensions, Uri, window } from "vscode";
import fetch, { RequestInfo, RequestInit } from "node-fetch";
import pty from "node-pty";

function normalizeExecInput(
  prog: string | undefined,
  args: string | string[] | undefined,
):
  | { succeed: false; error: ExecException }
  | { succeed: true; prog: string; args: string[] } {
  if (!prog) {
    return {
      succeed: false,
      error: {
        name: "invalid argument 'process'",
        message: `Unexpected empty process: ${prog}`,
      },
    };
  }
  const normalizedArgs =
    typeof args === "string"
      ? [args]
      : Array.isArray(args) && args.every((e) => typeof e === "string")
        ? args
        : [];
  return { succeed: true, prog, args: normalizedArgs };
}

type RunProcessOptions = SpawnOptions & { pty?: boolean };

async function runProcess(
  prog?: string,
  args?: string | string[],
  options?: RunProcessOptions | null,
): Promise<{
  error: ExecException | null;
  stdout: string | undefined;
  stderr: string | undefined;
}> {
  const normalized = normalizeExecInput(prog, args);
  switch (normalized.succeed) {
    case false: {
      return { error: normalized.error, stdout: "", stderr: "" };
    }
    case true:
      const process = options?.pty
        ? pty.spawn(normalized.prog, normalized.args, {
            cwd: options?.cwd?.toString(),
            env: options?.env,
          })
        : spawn(normalized.prog, normalized.args, {
            stdio: ["ignore", "pipe", "pipe"],
            ...(options || {}),
          });

      const errorPromise = new Promise<ExecException | null>((resolve) => {
        const onExit = (code: number, signal: any) => {
          if (code !== null) {
            if (code === 0) {
              resolve(null);
            } else {
              resolve({
                name: "runProcess",
                message: "non-zero return code",
                code,
              });
            }
          } else if (signal) {
            resolve({
              name: "runProcess",
              message: "killed by signal",
              signal,
            });
          } else {
            resolve({
              name: "runProcess",
              message: `unexpected exit status with neither code nor signal`,
            });
          }
        };
        if ("on" in process) {
          process.on("exit", onExit);
        } else {
          process.onExit(({ exitCode, signal }) => onExit(exitCode, signal));
        }
      });

      let stdout: string | undefined,
        stderr: string | undefined,
        error: ExecException | null;
      if (process instanceof ChildProcess) {
        const processErrorPromise = new Promise<Error>((resolve) => {
          process.on("error", (err: Error) => resolve(err));
        });
        [stdout, stderr, error] = await Promise.all([
          process.stdout ? text(process.stdout) : undefined,
          process.stderr ? text(process.stderr) : undefined,
          Promise.race([errorPromise, processErrorPromise]),
        ]);
      } else {
        process.onData((_) => {}); // ignore data
        error = await errorPromise;
        stdout = undefined;
        stderr = undefined;
      }

      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        error.cmd = JSON.stringify({ prog, args });
      }
      return { error, stdout, stderr };
  }
}

type ProcessLineStreamerSpawnResult =
  | { succeed: false; error: ExecException }
  | { succeed: true; id: string };
type ProcessLineStreamerStatus = {
  stdout: string[];
  stderr: string[];
  exit: number | string | undefined;
};
type Instance = ProcessLineStreamerStatus & { proc: ChildProcess };

class ProcessLineStreamer {
  private instances: {
    [id: string]: Instance;
  } = {};

  private event: EventEmitter = new EventEmitter();

  public async readLines(id: string): Promise<ProcessLineStreamerStatus | undefined> {
    const instance = this.instances[id];
    if (!instance) {
      return undefined;
    } else {
      const { stdout, stderr, exit } = instance;
      if (exit !== undefined) {
        delete this.instances[id];
        return { stdout, stderr, exit };
      } else {
        if (stdout.length === 0 && stderr.length === 0) {
          // no updates, waiting
          await once(this.event, id);
          return await this.readLines(id);
        } else {
          this.instances[id].stdout = [];
          this.instances[id].stderr = [];
          this.event.emit(id); // potentially resume consuming output data
          return { stdout, stderr, exit };
        }
      }
    }
  }

  public async kill(id: string, signal?: NodeJS.Signals | number) {
    const instance = this.instances[id];
    if (instance !== undefined) {
      delete this.instances[id];
      this.event.emit(id);
      return instance.proc.kill(signal);
    }
    return undefined;
  }

  readonly OUTPUT_BUFFER_NLINES = 10_000;

  public async spawn(
    prog?: string,
    args?: string | string[],
    options?: SpawnOptions | null,
  ): Promise<ProcessLineStreamerSpawnResult> {
    const normalized = normalizeExecInput(prog, args);
    switch (normalized.succeed) {
      case false: {
        return normalized;
      }
      case true:
        const proc = spawn(normalized.prog, normalized.args, {
          ...(options || {}),
          stdio: ["ignore", "pipe", "pipe"],
        });
        const id = randomUUID();
        const instance: Instance = { stdout: [], stderr: [], exit: undefined, proc };
        this.instances[id] = instance;

        let stdoutBuffer = "",
          stderrBuffer = "";
        proc.stdout.on("data", async (data) => {
          stdoutBuffer += data.toString();
          const lines = stdoutBuffer.split("\n");
          if (lines.length > 0) {
            stdoutBuffer = lines.pop()!;
            instance.stdout.push(...lines);
            this.event.emit(id);

            // pause when buffer lines exceeded
            let paused = false;
            while (instance.stdout.length > this.OUTPUT_BUFFER_NLINES) {
              paused = true;
              proc.stdout.pause();
              await once(this.event, id);
            }
            if (paused) proc.stdout.resume();
          }
        });
        proc.stderr.on("data", async (data) => {
          stderrBuffer += data.toString();
          const lines = stderrBuffer.split("\n");
          if (lines.length > 0) {
            stderrBuffer = lines.pop()!;
            instance.stderr.push(...lines);
            this.event.emit(id);

            // pause when buffer lines exceeded
            let paused = false;
            while (instance.stderr.length > this.OUTPUT_BUFFER_NLINES) {
              paused = true;
              proc.stderr.pause();
              await once(this.event, id);
            }
            if (paused) proc.stderr.resume();
          }
        });

        proc.on("close", (code, signal) => {
          if (stdoutBuffer) instance.stdout.push(stdoutBuffer);
          if (stderrBuffer) instance.stderr.push(stderrBuffer);
          instance.exit =
            code !== null
              ? code
              : signal !== null
                ? signal
                : "Unexpected: no code or signal on exit";
          this.event.emit(id);
        });

        return { succeed: true, id };
    }
  }
}

async function readDirFilesAndDirs(dir: string) {
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: false });
    const files: string[] = [],
      dirs: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        dirs.push(entry.name);
      } else {
        files.push(entry.name);
      }
    }
    return { files, dirs };
  } catch (e) {
    return { files: [], dirs: [], error: JSON.stringify(e) };
  }
}

async function createFile(path: string) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await stat(path);
    return;
  } catch (exn) {
    try {
      await writeFile(path, "");
    } catch {}
  }
}

async function fileExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (exn) {
    return false;
  }
}

export async function activate(context: ExtensionContext) {
  const processLineStreamer = new ProcessLineStreamer();
  context.subscriptions.push(
    commands.registerCommand("remote-commons.platform", () => platform()),
    commands.registerCommand("remote-commons.extensions.getAll", () =>
      extensions.all.map((extension) => ({
        id: extension.id,
        version: extension.packageJSON.version,
      })),
    ),
    commands.registerCommand(
      "remote-commons.fs.readDirFilesAndDirs",
      async (dir: string) => readDirFilesAndDirs(dir),
    ),
    commands.registerCommand("remote-commons.fs.createFile", async (path: string) =>
      createFile(path),
    ),
    commands.registerCommand("remote-commons.fs.fileExists", async (path: string) =>
      fileExists(path),
    ),
    commands.registerCommand("remote-commons.openFile", async (file: string, options) => {
      await window.showTextDocument(Uri.file(file), options);
    }),
    commands.registerCommand("remote-commons.process.run", runProcess),
    commands.registerCommand(
      "remote-commons.process.lineStreamer.spawn",
      async (...args) =>
        await processLineStreamer.spawn.apply(processLineStreamer, args as any),
    ),
    commands.registerCommand(
      "remote-commons.process.lineStreamer.read",
      async (id: string) => await processLineStreamer.readLines(id),
    ),
    commands.registerCommand(
      "remote-commons.process.lineStreamer.kill",
      async (id: string) => await processLineStreamer.kill(id),
    ),
    commands.registerCommand(
      "remote-commons.fetch.fetchText",
      async (url: RequestInfo, init: RequestInit | undefined) => {
        const resp = await fetch(url, init);
        return {
          ok: resp.ok,
          status: resp.status,
          statusText: resp.statusText,
          headers: [...resp.headers],
          bodyText: await resp.text(),
        };
      },
    ),
  );
}

export function deactivate() {}
