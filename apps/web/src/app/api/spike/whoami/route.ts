import { PrivyClient } from "@privy-io/node";

// Spike route: verify the login token on the server and list the user's Solana wallets.
export async function GET(request: Request) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) return Response.json({ error: "server not configured" }, { status: 500 });

  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return Response.json({ error: "missing token" }, { status: 401 });

  const privy = new PrivyClient({ appId, appSecret });
  try {
    const claims = await privy.utils().auth().verifyAccessToken(token);
    const user = await privy.users()._get(claims.user_id);
    const solanaWallets = user.linked_accounts
      .filter((account) => account.type === "wallet" && "chain_type" in account && account.chain_type === "solana")
      .map((account) => ({
        address: "address" in account ? account.address : null,
        embedded: "connector_type" in account && account.connector_type === "embedded",
      }));
    return Response.json({ userId: claims.user_id, solanaWallets });
  } catch {
    return Response.json({ error: "invalid token" }, { status: 401 });
  }
}
