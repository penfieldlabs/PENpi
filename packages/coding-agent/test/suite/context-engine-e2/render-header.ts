/**
 * D26 probe tool: render the window header the engine in this tree makes for a recorded cut of a session.
 *
 *   node render-header.ts <session.jsonl> <cut seq> [--window W] [--ratio R] [--tools a,b,...] [--old]
 *
 * Reads the session file (never writes it), takes the branch from the root to that cut's entry, and runs the
 * engine's own header and pin code (header.ts, pin.ts) at the cut's firstKeptEntryId and seq, with the pin
 * defaults (PIN_DEFAULTS) and the input sources the session recorded. The cap is min(capFraction x W,
 * capMaxTokens), compared at calibration ratio R, as the engine does (D9).
 *   --window  the planning window (default 200000, Chief's: the 200k ceiling)
 *   --ratio   the calibrated ratio of the model (default 1; it matters only when the pin is near its cap)
 *   --tools   the active tools the header and pointers may name (default: the four recovery tools)
 *   --old     also print the header recorded in the cut entry (the engine that made the cut), for a diff
 * The cut position is the recorded one: an engine whose header is larger could have chosen a slightly later cut.
 */
import { readFileSync } from "node:fs";
import { installHeader } from "../../../../../.pi/extensions/penpi/engine/header.ts";
import { resolveOptions, STATE_TYPE } from "../../../../../.pi/extensions/penpi/engine/options.ts";
import { installPin } from "../../../../../.pi/extensions/penpi/engine/pin.ts";

type Entry = {
	type: string;
	id: string;
	parentId?: string | null;
	customType?: string;
	data?: Record<string, unknown>;
};

const args = process.argv.slice(2);
const flag = (name: string) => {
	const at = args.indexOf(name);
	return at < 0 ? undefined : args[at + 1];
};
const [file, seqArg] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.match(/^--(window|ratio|tools)$/));
if (!file || !seqArg) {
	console.error(
		"usage: node render-header.ts <session.jsonl> <cut seq> [--window W] [--ratio R] [--tools a,b] [--old]",
	);
	process.exit(2);
}
const window = Number(flag("--window") ?? 200_000);
const ratio = Number(flag("--ratio") ?? 1);
const tools = (flag("--tools") ?? "context_notes,context_recall,context_search,search_transcript").split(",");

const entries = readFileSync(file, "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l) as Entry)
	.filter((e) => typeof e.id === "string");
const cutEntry = entries.find(
	(e) =>
		e.type === "custom" && e.customType === STATE_TYPE && e.data?.kind === "cut" && e.data?.seq === Number(seqArg),
);
if (!cutEntry) {
	console.error(`no cut #${seqArg} in ${file}`);
	process.exit(1);
}
// The branch: the path from the root to the cut entry (the cut entry itself is not part of what it saw).
const byId = new Map(entries.map((e) => [e.id, e]));
const branch: Entry[] = [];
for (let e = byId.get(cutEntry.parentId ?? ""); e; e = e.parentId ? byId.get(e.parentId) : undefined) branch.unshift(e);

const opts = resolveOptions({});
const sources = new Map<number, string>();
for (const e of branch)
	if (e.type === "custom" && e.customType === STATE_TYPE && e.data?.kind === "source" && typeof e.data.at === "number")
		sources.set(e.data.at, e.data.source as string);
const st = {
	sources,
	lastWindow: window,
	lastKey: "render",
	pinReports: new Map(),
	pinSizes: new Map(),
	pendingInputs: [],
};
const pi = { on: () => {}, appendEntry: () => {}, getActiveTools: () => tools };
const stats = { pinDecisions: [], inputSources: {} };
// Only what header.ts and pin.ts use of the engine core.
const core = { pi, opts, stats, log: () => {}, pinOpts: opts.pinUserMessages, st, ratioFor: () => ratio } as never;
installHeader(core);
installPin(core);
const { makeHeader } = core as { makeHeader: (seq: number, firstKept: string, branch: Entry[]) => string };
const firstKept = cutEntry.data?.firstKeptEntryId as string;
const header = makeHeader(Number(seqArg), firstKept, branch);
if (args.includes("--old")) {
	console.log(`=== recorded header, cut #${seqArg} (${cutEntry.id}) ===`);
	console.log(cutEntry.data?.header ?? "");
	console.log(`=== this tree's header, cut #${seqArg} ===`);
}
console.log(header);
