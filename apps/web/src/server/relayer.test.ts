import { describe, expect, it } from "vitest";
import type { RelayerRoute } from "@/lib/relayer/proxy";
import { AuthError } from "./auth-error";
import { handleRelayer, type RelayerProxyDeps } from "./relayer";

const SYMBOL = "GEMI-BTC2611142300-HI64500";

function setup(verify: RelayerProxyDeps["verify"] = async () => ({ userId: "did:privy:test" })) {
  const answered: RelayerRoute[] = [];
  const verified: Request[] = [];
  const deps: RelayerProxyDeps = {
    verify: async (request) => {
      verified.push(request);
      return verify(request);
    },
    answer: async (route) => {
      answered.push(route);
      return Response.json({ route: route.kind });
    },
  };
  const call = (method: string, path: string, headers: Record<string, string> = {}) =>
    handleRelayer(new Request(`http://app.test/api/relayer/${path}`, { method, headers }), path.split("?")[0]!.split("/"), deps);
  return { answered, verified, call };
}

describe("the relayer proxy", () => {
  it("answers 404 for anything outside the allow-list, without asking the relayer", async () => {
    const { answered, call } = setup();
    const response = await call("GET", "admin/keys");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect((await call("DELETE", `markets/${SYMBOL}`)).status).toBe(404);
    expect(answered).toEqual([]);
  });

  it("passes every read on to the relayer without asking for a login", async () => {
    const { answered, verified, call } = setup(async () => {
      throw new AuthError("missing token");
    });
    for (const path of ["health", "status", "events", "events/BTC2611142300", "markets", `markets/${SYMBOL}`, `markets/${SYMBOL}/depth`, `markets/${SYMBOL}/trades`, `markets/${SYMBOL}/history`]) {
      expect((await call("GET", path)).status).toBe(200);
    }
    expect(answered.map((route) => route.kind)).toEqual(["health", "status", "events", "event", "markets", "market", "depth", "trades", "history"]);
    expect(verified).toEqual([]);
  });

  it("refuses to create a market on-chain without a verified login, and does not ask the relayer", async () => {
    const { answered, call } = setup(async () => {
      throw new AuthError("invalid token");
    });
    const response = await call("POST", `markets/${SYMBOL}/ensure`, { authorization: "Bearer forged" });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(answered).toEqual([]);
  });

  it("creates a market on-chain for a verified login", async () => {
    const { answered, verified, call } = setup();
    const response = await call("POST", `markets/${SYMBOL}/ensure`, { authorization: "Bearer good" });
    expect(response.status).toBe(200);
    expect(answered).toEqual([{ kind: "ensure", symbol: SYMBOL, upstream: `/markets/${SYMBOL}/ensure` }]);
    expect(verified.map((request) => request.headers.get("authorization"))).toEqual(["Bearer good"]);
  });

  it("does not mistake a failing login provider for a missing login", async () => {
    const { answered, call } = setup(async () => {
      throw new Error("login provider unreachable");
    });
    await expect(call("POST", `markets/${SYMBOL}/ensure`, { authorization: "Bearer good" })).rejects.toThrow("login provider unreachable");
    expect(answered).toEqual([]);
  });
});
