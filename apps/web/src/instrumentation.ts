// Runs once when the server starts. Loading the configuration here makes an unsafe setting (an RPC
// URL that is not devnet or a local validator, an unknown cluster) stop the server immediately
// instead of on the first request.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { loadConfig } = await import("@/lib/config.server");
  loadConfig();
}
