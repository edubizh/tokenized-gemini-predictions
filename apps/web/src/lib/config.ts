"use client";

import { createContext, useContext } from "react";

/** The part of the configuration that is safe to send to the browser. */
export interface PublicConfig {
  cluster: "devnet" | "localnet";
  rpcUrl: string;
  programId: string;
  /** Null until the deployment file exists. */
  stableMint: string | null;
  privyAppId: string;
  explorerBase: string;
  /** False while `deployments/<cluster>.json` is missing. */
  bootstrapped: boolean;
  /** True when `RELAYER_URL=fixtures`: the relayer and the chain are both simulated by the app server. */
  fixtures: boolean;
}

type ExplorerTarget = Pick<PublicConfig, "cluster" | "rpcUrl" | "explorerBase">;

function clusterQuery(config: ExplorerTarget): string {
  return config.cluster === "devnet" ? "cluster=devnet" : `cluster=custom&customUrl=${encodeURIComponent(config.rpcUrl)}`;
}

export function explorerTxUrl(config: ExplorerTarget, signature: string): string {
  return `${config.explorerBase}/tx/${signature}?${clusterQuery(config)}`;
}

export function explorerAddressUrl(config: ExplorerTarget, address: string): string {
  return `${config.explorerBase}/address/${address}?${clusterQuery(config)}`;
}

export const ConfigContext = createContext<PublicConfig | null>(null);

export function useConfig(): PublicConfig {
  const config = useContext(ConfigContext);
  if (!config) throw new Error("useConfig must be used inside the app providers");
  return config;
}
