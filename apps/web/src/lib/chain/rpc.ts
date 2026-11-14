import { createRetryingRpc } from "@outcome/relayer/rpc";
import type { Rpc, SolanaRpcApi } from "@solana/kit";

export type AppRpc = Rpc<SolanaRpcApi>;

const clients = new Map<string, AppRpc>();

/**
 * One HTTP RPC client per URL. No WebSocket subscriptions: confirmation is by polling. The client
 * waits and retries when the endpoint rate-limits, which the public devnet endpoint does.
 */
export function getRpc(rpcUrl: string): AppRpc {
  let client = clients.get(rpcUrl);
  if (!client) {
    client = createRetryingRpc(rpcUrl);
    clients.set(rpcUrl, client);
  }
  return client;
}
