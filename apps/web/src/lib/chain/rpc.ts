import { createSolanaRpc, type Rpc, type SolanaRpcApi } from "@solana/kit";

export type AppRpc = Rpc<SolanaRpcApi>;

const clients = new Map<string, AppRpc>();

/** One HTTP RPC client per URL. No WebSocket subscriptions: confirmation is by polling. */
export function getRpc(rpcUrl: string): AppRpc {
  let client = clients.get(rpcUrl);
  if (!client) {
    client = createSolanaRpc(rpcUrl);
    clients.set(rpcUrl, client);
  }
  return client;
}
