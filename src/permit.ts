// Relay's way out of an EVM chain without gas: the wallet signs one EIP-3009 authorization for exactly the USDC or USDG
// a move takes, which only Relay's approval proxy can use, and Relay submits it and fills the move. The wallet sends
// nothing, so it needs no ETH on that chain, and an authorization Relay does not use lapses within the hour. Every
// field of the quote's authorization is checked, and what is signed is rebuilt here from the checked values.

import { formatUnits, type Address, type Hex, type LocalAccount } from "viem";

import { reason } from "./chain.js";
import { checkReturn, RELAY_API, RelayError, relayQuote, waitForRelay, type RelayQuote, type RelayStatus } from "./relay.js";
import { printable } from "./work.js";

/** Relay's approval proxies, at the same addresses on every EVM chain it serves: the only payees an authorization signed here names. */
export const RELAY_APPROVAL_PROXIES = ["0xccc88a9d1b4ed6b0eaba998850414b24f1c315be", "0x5567954cd026cebfe486062cb75848e0f1c12e58"];
/** The longest an authorization may stay usable; Relay asks for about seven minutes. */
const MAX_VALID_S = 3_600n;

const RECEIVE = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

export interface Origin {
  chainId: number;
  name: string;
  token: Address;
  symbol: string;
}

export interface Authorization {
  requestId: string;
  api?: string;
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  message: { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex };
}

export interface PermitWanted {
  owner: Address;
  origin: Origin;
  amount: bigint;
  recipient: string;
  currency: string;
  destination: { chainId: number; name: string };
  /** Seconds since the epoch. */
  now: number;
}

interface PermitStep {
  kind?: string;
  requestId?: string;
  items?: {
    data: {
      sign?: { signatureKind?: string; primaryType?: string; types?: Record<string, { name: string; type: string }[]>; domain?: Record<string, unknown>; value?: Record<string, unknown> };
      post?: { endpoint?: string; method?: string; body?: Record<string, unknown> };
    };
  }[];
}

const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const uint = (value: unknown) => {
  if (!/^\d{1,78}$/.test(String(value))) throw new Error("not a number");
  return BigInt(String(value));
};
const text = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 64 && printable(value) === value;

/** The authorization in a quote, or what is wrong with it: anything but USDC or USDG this wallet authorizes Relay's proxy to take, for this move, is refused. */
export function readPermit(quote: RelayQuote, want: PermitWanted): Authorization | string {
  try {
    return read(quote, want);
  } catch {
    return "it is in a form this command cannot read";
  }
}

function read(quote: RelayQuote, want: PermitWanted): Authorization | string {
  const { origin } = want;
  const [step, ...others] = quote.steps as PermitStep[];
  if (step === undefined || others.length > 0 || step.kind !== "signature" || step.items?.length !== 1) return "it is not one signature";
  const { sign, post } = step.items[0]!.data;
  if (sign?.signatureKind !== "eip712" || sign.primaryType !== "ReceiveWithAuthorization") return "it asks for a signature other than a token authorization";
  const types = Object.keys(sign.types ?? {}).filter((name) => name !== "EIP712Domain");
  const fields = (sign.types?.ReceiveWithAuthorization ?? []).map((f) => `${f.name} ${f.type}`).join(",");
  if (types.join() !== "ReceiveWithAuthorization" || fields !== RECEIVE.map((f) => `${f.name} ${f.type}`).join(",")) return "its authorization has fields a token authorization does not";
  const domain = sign.domain!;
  if (domain.chainId !== origin.chainId || !same(domain.verifyingContract, origin.token) || !text(domain.name) || !text(domain.version)) {
    return `it authorizes something other than ${origin.symbol} on ${origin.name}`;
  }
  const v = sign.value!;
  if (!same(v.from, want.owner)) return `it spends from ${String(v.from)}, not ${want.owner}`;
  if (!RELAY_APPROVAL_PROXIES.some((proxy) => same(v.to, proxy))) return `it pays ${String(v.to)}, not Relay's approval proxy`;
  const value = uint(v.value);
  if (value !== want.amount) return `it authorizes ${formatUnits(value, 6)} ${origin.symbol}, not the ${formatUnits(want.amount, 6)} asked for`;
  const now = BigInt(want.now);
  const validAfter = uint(v.validAfter);
  const validBefore = uint(v.validBefore);
  if (validAfter > now) return "it is not usable yet";
  if (validBefore <= now) return "it has lapsed";
  if (validBefore > now + MAX_VALID_S) return "it stays usable for more than an hour";
  if (typeof v.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v.nonce)) return "its nonce is not 32 bytes";
  if (post?.endpoint !== "/execute/permits" || post.method !== "POST" || post.body?.kind !== "eip3009" || post.body.requestId !== quote.requestId || step.requestId !== quote.requestId) {
    return "it is not handed to Relay the way an authorization is";
  }
  if (quote.inAmount !== want.amount || !same(quote.inCurrency, origin.token) || quote.inChainId !== origin.chainId) return "its move takes something other than what it authorizes";
  if (!same(quote.recipient, want.recipient)) return `it pays ${quote.recipient ?? "no named recipient"}, not ${want.recipient}`;
  if (!same(quote.outCurrency, want.currency) || quote.outChainId !== want.destination.chainId) return `it does not pay the currency asked for on ${want.destination.name}`;
  const api = post.body.api;
  return {
    requestId: quote.requestId,
    ...(text(api) ? { api: api as string } : {}),
    domain: { name: domain.name as string, version: domain.version as string, chainId: origin.chainId, verifyingContract: origin.token },
    message: { from: want.owner, to: v.to as Address, value, validAfter, validBefore, nonce: v.nonce as Hex },
  };
}

export function signPermit(account: LocalAccount, authorization: Authorization): Promise<Hex> {
  const { domain, message } = authorization;
  return account.signTypedData({ domain, types: { ReceiveWithAuthorization: RECEIVE }, primaryType: "ReceiveWithAuthorization", message });
}

/** Relay answered and did not take the authorization. */
export class PermitRefused extends Error {}

/** Hands Relay the signed authorization. Throws PermitRefused when Relay turns it down, and a plain error when its answer cannot be told. */
export async function postPermit(authorization: Authorization, signature: Hex, fetchImpl: typeof fetch = fetch): Promise<void> {
  const body = { kind: "eip3009", requestId: authorization.requestId, ...(authorization.api ? { api: authorization.api } : {}) };
  const response = await fetchImpl(`${RELAY_API}/execute/permits?signature=${signature}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.ok) return;
  if (response.status >= 500) throw new Error(`Relay answered ${response.status}`);
  const answer = (await response.json().catch(() => ({}))) as { message?: unknown };
  throw new PermitRefused(printable(String(answer.message ?? `Relay answered ${response.status}`)));
}

const clock = (seconds: bigint) => `${new Date(Number(seconds) * 1000).toISOString().slice(11, 16)} UTC`;

export interface PermitMover {
  owner: Address;
  /** Quotes the move and checks its price and its authorization without signing anything. */
  preview(currency: string, amount: bigint, recipient: string): Promise<RelayQuote>;
  /** Checks a quote again, signs its authorization, hands it to Relay, waits for the fill, and returns the request to follow it by. */
  send(quote: RelayQuote): Promise<string>;
}

export function createPermitMover(options: {
  account: LocalAccount;
  origin: Origin;
  destination: { chainId: number; name: string };
  /** The command whose rerun moves more, named when a move cannot be told settled. */
  again: string;
  maxLoss: (currency: string) => number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  wait?: (requestId: string) => Promise<RelayStatus>;
}): PermitMover {
  const { account, origin, destination, again } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const wait = options.wait ?? ((requestId: string) => waitForRelay(requestId, undefined, fetchImpl));
  const owner = account.address;
  // What each quote was asked for, so it is checked against that again when it is signed.
  const asked = new WeakMap<RelayQuote, Omit<PermitWanted, "now">>();
  const check = (quote: RelayQuote) => {
    const want = asked.get(quote);
    if (!want) throw new RelayError("This quote was not checked before signing. Nothing was sent.");
    const authorization = readPermit(quote, { ...want, now: now() });
    if (typeof authorization === "string") throw new RelayError(`Relay's quote was refused before signing: ${authorization}. Nothing was sent.`);
    return authorization;
  };
  return {
    owner,
    async preview(currency, amount, recipient) {
      const quote = await relayQuote(
        { user: owner, recipient, refundTo: owner, originChainId: origin.chainId, destinationChainId: destination.chainId, originCurrency: origin.token, destinationCurrency: currency, amount, usePermit: true },
        fetchImpl,
      );
      checkReturn(quote, options.maxLoss(currency));
      asked.set(quote, { owner, origin, amount, recipient, currency, destination });
      check(quote);
      return quote;
    },
    async send(quote) {
      const authorization = check(quote);
      const amount = `${formatUnits(authorization.message.value, 6)} ${origin.symbol}`;
      const lapses = clock(authorization.message.validBefore);
      const follow = `${RELAY_API}/intents/status/v2?requestId=${quote.requestId}`;
      const signature = await signPermit(account, authorization);
      try {
        await postPermit(authorization, signature, fetchImpl);
      } catch (error) {
        if (error instanceof PermitRefused) throw new Error(`Relay did not take the authorization (${error.message.replace(/\.$/, "")}), so the ${amount} did not move. Unused, it lapses at ${lapses}.`);
        throw new Error(`Could not tell whether Relay took the authorization (${reason(error).replace(/\.$/, "")}). Check ${follow} before running ${again} again: Relay may take the ${amount} until ${lapses}, when the authorization lapses, and another run moves more.`);
      }
      const status = await wait(quote.requestId);
      if (status === "refund") throw new Error(`Relay reports a refund for request ${quote.requestId}: the ${amount} goes back to ${owner} on ${origin.name}. Check the wallet before running ${again} again.`);
      if (status !== "success") {
        throw new Error(`Relay has not settled request ${quote.requestId} (it reports "${status}"). Check ${follow} before running ${again} again: Relay may hold the ${amount} already, or take it until ${lapses}, and another run moves more.`);
      }
      return `Relay request ${quote.requestId}`;
    },
  };
}
