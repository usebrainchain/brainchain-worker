// `fund --from-solana`: an agent that lives on Solana funds its BrainChain worker in one command. Relay turns its USDC
// on Solana into ETH (and, with --stake, BRAIN) for the worker's wallet on Robinhood Chain in about a second, signed by
// the agent's Solana key; `bridge` then moves gas and stake on to BrainChain. A little ETH stays on Robinhood Chain for
// the worker's own transactions there, such as an exit to Solana.

import { readFileSync } from "node:fs";

import bs58 from "bs58";
import { AddressLookupTableAccount, Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { formatUnits, parseUnits, type Address } from "viem";

import { checkReturn, NATIVE, relayQuote, SOLANA_CHAIN_ID, SOLANA_USDC, waitForRelay, type RelayQuote, type SvmItem } from "./relay.js";

export const SOLANA_RPC = "https://api.mainnet-beta.solana.com";
/** USDC turned into ETH for gas, unless --gas-usdc says otherwise. */
export const DEFAULT_GAS_USDC = "2";
/** ETH left on Robinhood Chain when the rest goes to BrainChain: enough for a few transactions there. */
export const PARENT_ETH_KEEP = 150_000_000_000_000n;

/** The Solana key from BRAINCHAIN_SOLANA_KEY (base58) or BRAINCHAIN_SOLANA_KEY_FILE (a Solana CLI keypair file). */
export function solanaKeypair(env: NodeJS.ProcessEnv = process.env): Keypair {
  const file = env.BRAINCHAIN_SOLANA_KEY_FILE?.trim();
  const raw = file ? readFileSync(file, "utf8").trim() : env.BRAINCHAIN_SOLANA_KEY?.trim();
  if (!raw) throw new Error("Set BRAINCHAIN_SOLANA_KEY to the Solana wallet's secret key (base58), or BRAINCHAIN_SOLANA_KEY_FILE to its keypair file");
  try {
    const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw) as number[]) : bs58.decode(raw);
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error("The Solana key must be a 64-byte secret key, in base58 or as a keypair file's JSON array");
  }
}

/** How a USDC amount splits between gas and stake. */
export function split(usdc: bigint, gasUsdc: bigint, stake: boolean): { gas: bigint; stake: bigint } {
  if (!stake) return { gas: usdc, stake: 0n };
  if (usdc <= gasUsdc) throw new Error(`With --stake the amount must be more than the ${formatUnits(gasUsdc, 6)} USDC kept for gas`);
  return { gas: gasUsdc, stake: usdc - gasUsdc };
}

/** Sends Relay's Solana deposit: its instructions, compiled against its lookup tables, signed by the agent's key. */
export async function sendSvmStep(connection: Connection, keypair: Keypair, item: SvmItem): Promise<string> {
  const instructions = item.instructions.map(
    (i) =>
      new TransactionInstruction({
        programId: new PublicKey(i.programId),
        keys: i.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
        data: Buffer.from(i.data.replace(/^0x/, ""), "hex"),
      }),
  );
  const tables: AddressLookupTableAccount[] = [];
  for (const address of item.addressLookupTableAddresses) {
    const table = (await connection.getAddressLookupTable(new PublicKey(address))).value;
    if (table) tables.push(table);
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: keypair.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message(tables);
  const transaction = new VersionedTransaction(message);
  transaction.sign([keypair]);
  const signature = await connection.sendTransaction(transaction, { maxRetries: 3 });
  const confirmed = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (confirmed.value.err) throw new Error(`the Solana transaction failed: ${JSON.stringify(confirmed.value.err)}`);
  return signature;
}

export interface SolanaFunding {
  /** Moves `amount` USDC on Solana to `currency` on the parent chain for `recipient`, and waits for it to land. */
  move(currency: string, amount: bigint, recipient: Address): Promise<{ quote: RelayQuote; signature: string }>;
  usdcBalance(): Promise<bigint>;
  solBalance(): Promise<bigint>;
  owner: string;
}

export function createSolanaFunding(keypair: Keypair, parentChainId: number, rpc = SOLANA_RPC): SolanaFunding {
  const connection = new Connection(rpc, "confirmed");
  const owner = keypair.publicKey.toBase58();
  return {
    owner,
    async usdcBalance() {
      const accounts = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, { mint: new PublicKey(SOLANA_USDC) });
      return accounts.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount as string), 0n);
    },
    async solBalance() {
      return BigInt(await connection.getBalance(keypair.publicKey));
    },
    async move(currency, amount, recipient) {
      const quote = await relayQuote({ user: owner, recipient, originChainId: SOLANA_CHAIN_ID, destinationChainId: parentChainId, originCurrency: SOLANA_USDC, destinationCurrency: currency, amount });
      checkReturn(quote);
      let signature = "";
      for (const step of quote.steps) for (const item of step.items) signature = await sendSvmStep(connection, keypair, item.data as SvmItem);
      const status = await waitForRelay(quote.requestId);
      if (status !== "success") throw new Error(`Relay reports "${status}" for request ${quote.requestId}; a refund comes back to the Solana wallet`);
      return { quote, signature };
    },
  };
}

/** The least SOL the wallet needs to pay Solana's fees for the deposits. */
export const MIN_LAMPORTS = 2_000_000n;

export async function fundFromSolana(
  options: {
    funding: SolanaFunding;
    worker: Address;
    usdc: string;
    gasUsdc?: string;
    stake: boolean;
    stakeToken?: Address;
    dry: boolean;
    log: (line: string) => void;
    /** Moves ETH and the stake token from the parent chain to BrainChain once they have landed; `bridge` in the CLI. */
    bridgeOn: (asset: "eth" | "stake") => Promise<void>;
  },
): Promise<void> {
  const { funding, log } = options;
  const usdc = parseUnits(options.usdc, 6);
  const gasUsdc = parseUnits(options.gasUsdc ?? DEFAULT_GAS_USDC, 6);
  const parts = split(usdc, gasUsdc, options.stake);
  if (options.stake && !options.stakeToken) throw new Error("This network's stake token is not on the parent chain");
  const [held, lamports] = await Promise.all([funding.usdcBalance(), funding.solBalance()]);
  if (held < usdc) throw new Error(`The Solana wallet ${funding.owner} holds ${formatUnits(held, 6)} USDC, less than ${options.usdc}`);
  if (lamports < MIN_LAMPORTS) throw new Error(`The Solana wallet ${funding.owner} needs about 0.002 SOL for Solana's fees; it holds ${formatUnits(lamports, 9)}`);
  log(`From ${funding.owner} on Solana: ${formatUnits(parts.gas, 6)} USDC to ETH for gas${parts.stake ? ` and ${formatUnits(parts.stake, 6)} USDC to the stake token` : ""}, for ${options.worker}.`);
  if (options.dry) {
    log("Dry run, nothing sent.");
    return;
  }
  const gas = await funding.move(NATIVE, parts.gas, options.worker);
  log(`ETH arrived on the parent chain: ${gas.quote.outFormatted} ETH (Solana ${gas.signature}).`);
  if (parts.stake) {
    const stake = await funding.move(options.stakeToken!, parts.stake, options.worker);
    log(`Stake token arrived on the parent chain: ${stake.quote.outFormatted} (Solana ${stake.signature}).`);
  }
  await options.bridgeOn("eth");
  if (parts.stake) await options.bridgeOn("stake");
  log("Done. `brainchain-worker status` shows the balances on BrainChain once the deposits arrive, in about a minute.");
}
