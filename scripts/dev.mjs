// Starts the relayer and the web app together and stops both on Ctrl-C.
//
//   pnpm dev            relayer against the exchange sandbox, web app on http://localhost:3000
//   pnpm dev:mock       the same with the simulated venue (no exchange account needed)
//
// Each line of output is prefixed with the process it came from.
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const mock = process.argv.includes("--mock");

const processes = [
  { name: "relayer", args: ["--filter", "@outcome/relayer", "start"], env: mock ? { VENUE: "mock" } : {} },
  { name: "web", args: ["--filter", "@outcome/web", "dev"], env: {} },
];

let stopping = false;
const children = processes.map(({ name, args, env }) => {
  const child = spawn("pnpm", args, { cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = `[${name}] `;
  for (const stream of [child.stdout, child.stderr]) {
    let rest = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) console.log(prefix + line);
    });
    stream.on("end", () => {
      if (rest) console.log(prefix + rest);
    });
  }
  child.on("exit", (code, signal) => {
    console.log(`${prefix}stopped (${signal ?? `exit ${code}`})`);
    if (!stopping) stop(code ?? 1);
  });
  return child;
});

function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  // Give both a moment to close their servers and the database, then leave.
  setTimeout(() => process.exit(exitCode), 12_000).unref();
  Promise.all(children.map((child) => (child.exitCode === null ? new Promise((resolve) => child.once("exit", resolve)) : null))).then(() => process.exit(exitCode));
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
