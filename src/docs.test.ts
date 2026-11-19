import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BOND_LEAD_SEC } from "./bond.js";
import { MAX_OVER_WORTH } from "./buy.js";
import { MAX_WORK_BYTES } from "./exam.js";
import { usage } from "./cli.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const json = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;
const { version } = json("package.json") as { version: string };
const readme = read("README.md");
const skill = read("examples/openclaw/brainchain-worker/SKILL.md");
const help = usage(undefined);
const flat = (text: string) => text.replace(/\s+/g, " ");

/** Every file of the repository but what is installed or built, and the tests, which name made-up releases. */
function files(dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", "node_modules", "dist"].includes(entry.name) || entry.name.endsWith(".test.ts")) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [relative(root, path).split(sep).join("/")];
  });
}

describe("the release each file names", () => {
  it("is this package's in the lockfile", () => {
    const lock = json("package-lock.json") as { version: string; packages: Record<string, { version: string }> };
    expect([lock.version, lock.packages[""]!.version]).toEqual([version, version]);
  });

  it("is this package's wherever a file pins brainchain-worker to a version", () => {
    const pins = files().flatMap((file) => [...read(file).matchAll(/brainchain-worker@(\d+\.\d+\.\d+[\w.-]*)/g)].map(([, pinned]) => ({ file, pinned })));
    expect(pins.filter(({ pinned }) => pinned !== version)).toEqual([]);
  });
});

describe("what --help and the README list", () => {
  const table = readme.split("\n## Commands\n")[1]!.split("\n## ")[0]!;
  const environment = readme.split("\n## Environment\n")[1]!.split("\n## ")[0]!;

  it("is the same commands", () => {
    const helped = [...help.matchAll(/^ {2}brainchain-worker (-*[a-z-]+)/gm)].map(([, command]) => command!);
    const listed = table.split("\n").flatMap((row) => /^\| `(-*[a-z-]+)/.exec(row)?.[1] ?? []);
    expect([...new Set(listed)].sort()).toEqual([...new Set(helped)].sort());
  });

  it("is the same settings", () => {
    const helped = help.split("\nEnvironment:\n")[1]!.split("\n\n")[0]!;
    const names = (text: string) => [...new Set(text.match(/\bBRAINCHAIN_[A-Z_]+/g) ?? [])].sort();
    expect(names(environment)).toEqual(names(helped));
  });
});

describe("the model behind BrainChain's decisions in the README", () => {
  it("is named where the decisions are introduced", () => {
    expect(readme).toContain("BrainChain decides who may work, who is hired, how a result is graded and how a dispute is ruled. Its decision model is Jev, served by TypeSafe.");
  });
});

describe("mainnet's figures in the README", () => {
  it("are the stake and the bond the contracts ask for, on every line", () => {
    expect(readme).toContain("`join` stakes 250,000 BRAIN, the minimum, and applies with a 62,500 BRAIN bond, so a new worker needs 312,500 BRAIN");
    expect(readme).toContain("bridge --stake 312500 ");
    expect(readme).toContain("62,500 BRAIN on mainnet, 100 tBRAIN on testnet");
    expect(readme).not.toMatch(/1,?250,?000|1,000,000 BRAIN|250,000 BRAIN on mainnet/);
  });

  it("names the desk's fee with its floor, and a gas figure that is true", () => {
    expect(flat(readme)).toContain("less a 0.5% fee of at least 0.01 USDG");
    expect(readme).not.toContain("under a cent");
    expect(flat(help)).toContain("less a 0.5% fee, at least 0.01 tUSDG");
  });
});

describe("watch in the README and --help", () => {
  it("say how long an unreadable record holds the place, and what comes after", () => {
    expect(flat(readme)).toContain("A record still unreadable a day after its decision's block time is a finding, reported once, and the place moves on");
    expect(flat(help)).toContain("A record that cannot be read holds the place until a day after its decision's block time; past that it is a finding, reported once, and the place moves on");
  });
});

describe("bonds in the README and --help", () => {
  it("are placed after the hire, and read by BrainChain once settled, at later hires", () => {
    expect(readme).toContain("BrainChain reads a worker's settled bonds, delivered and missed, at later hires");
    expect(readme).toContain("After BrainChain hires this worker for the task");
    expect(readme).not.toMatch(/offered first|While the task is open|Not open yet|(?:Jev|BrainChain) reads the bond when it hires/);
    expect(flat(help)).toContain("behind a task BrainChain hired this worker for");
  });

  it("give the deadline the bond is created with", () => {
    const hours = BOND_LEAD_SEC / 3_600n;
    expect(flat(help)).toContain(`the bond's deadline, the task's plus ${hours} hours`);
    expect(readme).toContain(`The bond's deadline is the task's plus ${hours} hours`);
  });

  it("name who a missed bond pays in one sentence", () => {
    const missed = "the agent that paid BrainChain's desk for the task, or to the poster for a task posted on the board directly";
    expect(flat(readme)).toContain(missed);
    expect(flat(help)).toContain(missed);
  });
});

describe("exits in the README, --help and the skill", () => {
  it("promise no working exit on mainnet, and do not call it coming", () => {
    for (const text of [readme, help, skill]) {
      expect(flat(text)).toMatch(/Fast exits are off,? (?:and `exit` says so|on mainnet, where `?exit`? says so)/);
      expect(text).not.toMatch(/BRAINCHAIN_NETWORK=mainnet npx(?: -y)? brainchain-worker exit/);
      expect(text).not.toMatch(/coming soon|for now.*exit|exit.*for now/i);
    }
  });

  it("keep the 'stops before anything is signed' sentence to fund", () => {
    expect(flat(readme)).toContain("Each Relay move `fund` makes is priced before anything is signed");
    expect(flat(readme)).toContain("The desk would price that move after the transfer arrives");
    expect(readme).not.toContain("Every Relay move is priced before anything is signed");
  });
});

describe("fund in the README and --help", () => {
  it("say what happens to the rest without --stake, and that only what the run brought is bridged", () => {
    expect(flat(readme)).toContain("Without `--stake` it spends only that gas amount and the rest stays on Solana");
    expect(flat(help)).toContain("without it, the rest stays on Solana");
    expect(flat(readme)).toContain("What the wallet already held on Robinhood Chain stays there");
    expect(flat(help)).toContain("what the wallet already held stays");
  });

  it("use no example amount the price guard or the join would refuse", () => {
    expect(readme).toContain("fund --from-solana --usdc 120 --stake --dry");
    expect(readme).not.toContain("--usdc 20");
    expect(skill).not.toContain("--usdc 20");
  });
});

describe("buy-stake in the README, --help and the skill", () => {
  it("give what a run costs and the most it spends, measured over the BRAIN's worth", () => {
    const cap = `${Math.round(MAX_OVER_WORTH * 100)}%`;
    const section = flat(readme.split("\n## Buy the stake\n")[1]!.split("\n## ")[0]!).trim();
    expect(section.startsWith("Each run pays 0x 0.02 USDC on Base (0.01 for the price, 0.01 for the quote), `--dry` and refused quotes included")).toBe(true);
    expect(section).toContain("The amount sold is fixed, so a run costs at most that amount, the gas and 0.02 USDC on Base.");
    expect(section).toContain(`That amount may be at most ${cap} over the worth, at Relay's price, of the BRAIN \`join\` needs`);
    expect(section).toContain("A dry run needs only some of the token sold and the gas: it still pays for the price and quote, then reports the shortfall and exits 1.");
    expect(section).toContain("`bridge --stake` moves BRAIN the wallet already holds, so it says so and checks the token on chain alone.");
    expect(section.endsWith('Once it arrives on BrainChain, about a minute later, run `npx brainchain-worker join --name <name> --about "<what it does>"`, or plain `join` to top up a stake.')).toBe(true);
    expect(flat(help)).toContain(`a sale over ${cap} above the BRAIN's worth at Relay's price is refused`);
    expect(flat(skill)).toContain(`would spend more than ${cap} over that worth`);
  });
});

describe("the licence exam in the README and --help", () => {
  const section = readme.split("\n## Licence exam\n")[1]!.split("\n## ")[0]!;

  it("say that sit pays only when --max-price covers the price, and when a sitting's payment goes back, in the service's words", () => {
    expect(flat(section)).toContain("`exam sit` pays only when `--max-price` covers the price it reads from the service");
    expect(flat(help)).toContain("it pays only when --max-price covers the price");
    const refunds = "A sitting buys the judgments, whatever they say. One BrainChain cannot open after it is paid for, or cannot judge enough of to decide, is void: it does not count against the agent, and the payment goes back to the paying wallet.";
    for (const text of [section, help]) expect(flat(text)).toContain(refunds);
    expect(flat(section)).toContain("If its payment has not come back, write to hello@usebrainchain.com with the sitting's id.");
    for (const text of [section, help]) expect(flat(text)).not.toContain("not refunded");
  });

  it("say that an item takes one delivery, and that a paid sitting is asked for again with the same payment", () => {
    for (const text of [section, help]) expect(flat(text)).toContain("An item takes one delivery, so send finished work");
    expect(readme).toContain(`An item takes one delivery, of at most ${MAX_WORK_BYTES.toLocaleString("en-US")} bytes.`);
    expect(flat(section)).toContain("the next `sit` for the same agent sends the same request with the same payment, which the service does not charge twice");
    expect(flat(help)).toContain("is asked for by the same sit command, with the same payment and no new one");
  });

  it("say that the service refuses a sitting before anything is approved or paid, and that an opening sitting reads as opening", () => {
    expect(flat(section)).toContain("`sit` first sends the request without a payment, and the service refuses there a sitting it cannot open");
    expect(flat(section)).toContain("`sit` prints the service's reason and stops before it approves or pays anything");
    expect(flat(help)).toContain("sends the request without a payment first: the service refuses there a sitting it cannot open, and otherwise states the price");
    expect(flat(section)).toContain("`exam status` shows the sitting as paid for and opening, with the service's reason when it gives one");
    expect(flat(help)).toContain("Before a sitting opens, status says whether its payment is being settled, it is paid for and opening, or its payment did not settle");
    expect(flat(section)).toContain("The price in answer means the service would open the sitting.");
    expect(flat(section)).toContain("past that, `sit` says to run it again a minute later");
  });

  it("say that the judges' bar is printed, and that a judged item shows how sure they were", () => {
    expect(flat(usage("exam"))).toContain("with the levels each item is graded against and how sure the judges must be to accept one");
    expect(readme).toContain("how sure the judges must be to accept an item");
    expect(readme).toContain("the judges' answer and how sure they were of it, so an item refused with every case right explains itself");
  });

  it("give a licence's states in the order the service reads them, an expiry first", () => {
    const order = "A licence past its expiry reads expired, whatever else was true of it. Before that it reads suspended after two failed audits in the last three, lapsed while the id has another controller or build than the licence was earned with, and valid otherwise.";
    expect(flat(usage("licence"))).toContain(order);
    expect(readme).toContain(order);
    expect(flat(usage("licence"))).toContain("with the controller and the build BrainChain reads for the id now, which the states are held to");
    expect(readme).toContain("with the controller and the declared build BrainChain reads for the id now, which the states are held to");
    expect(flat(usage("licence"))).toContain("When the registry cannot be read it says so, and the states are up to ten minutes old.");
    expect(readme).toContain("When the registry cannot be read it says so, and the states are then up to ten minutes old.");
  });

  it("say who holds an agent whose id is bound to an NFT", () => {
    expect(flat(section)).toContain("The wallet holds the agent when it owns the id, is its registered wallet or, for an id bound to an NFT, holds that NFT.");
    expect(readme).toContain("or hold the NFT the agent's id is bound to");
    expect(flat(section)).toContain("A build that starts with `house:` is read without that prefix.");
  });

  it("pause with no dash", () => {
    for (const text of [section, usage("exam"), usage("licence"), usage("papers")]) expect(text).not.toContain("—");
    for (const row of readme.split("\n").filter((line) => /^\| `(exam|licence|papers) /.test(line))) expect(row).not.toContain("—");
  });
});

describe("native Windows in the README", () => {
  it("says the worker cannot find or stop what a command leaves running there", () => {
    expect(flat(readme)).toContain("Native Windows has no process groups, so anything it left running there keeps running");
    expect(flat(readme)).toContain("On native Windows the next run can neither find nor stop it");
  });
});
