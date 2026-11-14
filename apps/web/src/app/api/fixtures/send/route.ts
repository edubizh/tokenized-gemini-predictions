import { address, AccountRole, type Instruction } from "@solana/kit";
import {
  identifyOutcomeTokensInstruction,
  OutcomeTokensInstruction,
  parseCancelOrderInstruction,
  parsePlaceBuyInstruction,
  parsePlaceSellInstruction,
  parseRedeemInstruction,
  Side,
} from "@outcome/program-client";
import { fixturesMode, loadConfig } from "@/lib/config.server";
import type { FixtureInstruction } from "@/lib/fixtures/chain-types";
import { fixtureWorld } from "@/lib/fixtures/world";

export const dynamic = "force-dynamic";

/**
 * The simulated chain's `sendTransaction`: reads the program's instructions as the program would
 * and applies them to the fixture world. Exists only in fixtures mode; nothing reaches Solana.
 */
export async function POST(request: Request): Promise<Response> {
  if (!fixturesMode()) return Response.json({ error: "not_found" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { instructions?: FixtureInstruction[] } | null;
  if (!body || !Array.isArray(body.instructions)) return Response.json({ error: "bad_request" }, { status: 400 });

  const world = fixtureWorld();
  const programId = loadConfig().public.programId;
  const now = Date.now();
  try {
    for (const raw of body.instructions) {
      if (raw.programAddress !== programId) continue;
      const instruction = {
        programAddress: address(raw.programAddress),
        accounts: raw.accounts.map((account) => ({ address: address(account.address), role: account.role as AccountRole })),
        data: new Uint8Array(Buffer.from(raw.data, "base64")),
      } satisfies Instruction;
      switch (identifyOutcomeTokensInstruction(instruction)) {
        case OutcomeTokensInstruction.PlaceBuy: {
          const { accounts, data } = parsePlaceBuyInstruction(instruction);
          world.place(
            {
              user: accounts.user.address,
              market: accounts.market.address,
              order: accounts.order.address,
              side: data.side === Side.Yes ? "YES" : "NO",
              units: data.qtyUnits,
              limitPx: BigInt(data.limitPx),
              maxFeeMicros: data.maxFee,
            },
            now,
          );
          break;
        }
        case OutcomeTokensInstruction.PlaceSell: {
          const { accounts, data } = parsePlaceSellInstruction(instruction);
          world.placeSell(
            {
              user: accounts.user.address,
              market: accounts.market.address,
              order: accounts.order.address,
              outcomeMint: accounts.outcomeMint.address,
              side: data.side === Side.Yes ? "YES" : "NO",
              units: data.qtyUnits,
              limitPx: BigInt(data.minPx),
              maxFeeMicros: data.maxFee,
            },
            now,
          );
          break;
        }
        case OutcomeTokensInstruction.CancelOrder:
          world.cancel(parseCancelOrderInstruction(instruction).accounts.order.address, now);
          break;
        case OutcomeTokensInstruction.Redeem: {
          const { accounts, data } = parseRedeemInstruction(instruction);
          world.redeem({ holder: accounts.holder.address, market: accounts.market.address, outcomeMint: accounts.outcomeMint.address, amount: data.amount }, now);
          break;
        }
        default:
          break;
      }
    }
  } catch (error) {
    return Response.json({ error: "transaction_failed", programError: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
  return Response.json({ signature: world.nextSignature() });
}
