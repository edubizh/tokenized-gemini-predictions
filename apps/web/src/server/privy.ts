import { PrivyClient } from "@privy-io/node";
import { AuthError } from "./auth-error";

let client: PrivyClient | null = null;

function privy(): PrivyClient {
  if (!client) {
    const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
    const appSecret = process.env.PRIVY_APP_SECRET;
    if (!appId || !appSecret) throw new Error("NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET must be set on the server.");
    client = new PrivyClient({ appId, appSecret });
  }
  return client;
}

/** Verifies the Bearer login token and returns the user's linked Solana wallet addresses. */
export async function verifyLogin(request: Request): Promise<{ userId: string; wallets: string[] }> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new AuthError("missing token");

  let userId: string;
  try {
    ({ user_id: userId } = await privy().utils().auth().verifyAccessToken(token));
  } catch {
    throw new AuthError("invalid token");
  }
  const user = await privy().users()._get(userId);
  const wallets = user.linked_accounts.flatMap((account) =>
    account.type === "wallet" && "chain_type" in account && account.chain_type === "solana" && "address" in account ? [account.address] : [],
  );
  return { userId, wallets };
}
