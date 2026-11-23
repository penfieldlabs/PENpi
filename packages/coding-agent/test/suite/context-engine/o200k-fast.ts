/**
 * o200k_base counts for long texts: js-tiktoken's own ranks, pattern and special tokens, with its byte-pair merge
 * (the lowest-ranked adjacent pair first, the leftmost on a tie) kept in a heap instead of rescanning every pair after
 * each merge, which is quadratic in a piece's length (a 30,000-character run takes minutes). Same tokens; the sweep
 * test checks them against js-tiktoken on every text short enough for it.
 */
import { verifiedRequire } from "../context-engine-e2/tokenizer-cache.ts";

interface Encoder {
	rankMap: Map<string, number>;
	patStr: string;
	specialTokens: Record<string, number>;
	encode(text: string, allowed: "all"): number[];
}
const require = verifiedRequire();
const { Tiktoken } = require("js-tiktoken/lite") as { Tiktoken: new (ranks: unknown) => Encoder };
const ranks = require("js-tiktoken/ranks/o200k_base") as { default?: unknown };
export const reference = new Tiktoken(ranks.default ?? ranks);
const rankMap = reference.rankMap;
const pattern = new RegExp(reference.patStr, "gu");
const special = Object.keys(reference.specialTokens).sort((a, b) => b.length - a.length);
const specialRe = special.length
	? new RegExp(special.map((s) => s.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&")).join("|"), "g")
	: null;
const encoder = new TextEncoder();

/** Min-heap of [rank, start, version] for the pair that starts at `start`. */
class Heap {
	a: number[][] = [];
	push(x: number[]) {
		const a = this.a;
		a.push(x);
		let i = a.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (less(a[i], a[p])) [a[i], a[p]] = [a[p], a[i]];
			else break;
			i = p;
		}
	}
	pop(): number[] | undefined {
		const a = this.a;
		if (!a.length) return undefined;
		const top = a[0];
		const last = a.pop()!;
		if (a.length) {
			a[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1,
					r = l + 1;
				let m = i;
				if (l < a.length && less(a[l], a[m])) m = l;
				if (r < a.length && less(a[r], a[m])) m = r;
				if (m === i) break;
				[a[i], a[m]] = [a[m], a[i]];
				i = m;
			}
		}
		return top;
	}
}
const less = (x: number[], y: number[]) => x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);

/** Tokens of one piece (bytes), as js-tiktoken's bytePairEncode gives them. */
function pieceTokens(piece: Uint8Array): number {
	const n = piece.length;
	if (rankMap.has(Array.prototype.join.call(piece, ","))) return 1;
	if (n === 1) return 1;
	// Parts as a linked list over start offsets; end[i] is the end of the part starting at i.
	const end = new Int32Array(n),
		next = new Int32Array(n),
		prev = new Int32Array(n),
		ver = new Int32Array(n);
	for (let i = 0; i < n; i++) {
		end[i] = i + 1;
		next[i] = i + 1 < n ? i + 1 : -1;
		prev[i] = i - 1;
	}
	const key = (s: number, e: number) => Array.prototype.join.call(piece.subarray(s, e), ",");
	const heap = new Heap();
	const pairRank = (i: number) => {
		const j = next[i];
		return j < 0 ? undefined : rankMap.get(key(i, end[j]));
	};
	for (let i = 0; i < n - 1; i++) {
		const r = pairRank(i);
		if (r !== undefined) heap.push([r, i, 0]);
	}
	let parts = n;
	for (;;) {
		const top = heap.pop();
		if (!top) break;
		const [, i, v] = top;
		if (v !== ver[i] || next[i] < 0 || end[i] < 0) continue;
		const r = pairRank(i);
		if (r === undefined || r !== top[0]) continue;
		const j = next[i];
		end[i] = end[j];
		next[i] = next[j];
		if (next[j] >= 0) prev[next[j]] = i;
		end[j] = -1;
		ver[j]++;
		parts--;
		ver[i]++;
		const ri = pairRank(i);
		if (ri !== undefined) heap.push([ri, i, ver[i]]);
		const p = prev[i];
		if (p >= 0) {
			ver[p]++;
			const rp = pairRank(p);
			if (rp !== undefined) heap.push([rp, p, ver[p]]);
		}
	}
	return parts;
}

/** o200k_base tokens of a text, special tokens allowed (as E2 counts them). */
export function fastO200k(text: string): number {
	let count = 0;
	const segments: string[] = [];
	if (specialRe) {
		let last = 0;
		for (const m of text.matchAll(specialRe)) {
			segments.push(text.slice(last, m.index));
			count++;
			last = m.index! + m[0].length;
		}
		segments.push(text.slice(last));
	} else segments.push(text);
	for (const seg of segments) for (const m of seg.matchAll(pattern)) count += pieceTokens(encoder.encode(m[0]));
	return count;
}
