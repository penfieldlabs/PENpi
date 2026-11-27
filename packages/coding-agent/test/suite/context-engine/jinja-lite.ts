/**
 * 0.9.0: a small Jinja renderer for the reasoning-rule tests: enough of Jinja2 to render a model's chat template, as
 * transformers does (trim_blocks and lstrip_blocks on), so a test can see what a template keeps of a conversation.
 *
 * It renders statements (if/elif/else, for with `loop`, else and a filter, set, block set, macro, break, continue,
 * generation, raw), expressions (literals, lists, dicts, tuples, attribute and item access, slices, calls, filters,
 * tests, `in`, comparisons, arithmetic, `~`, `and`/`or`/`not`, the conditional), Python's string, dict and list methods,
 * and the globals templates use (namespace, range, dict, raise_exception, strftime_now). What it doesn't know throws,
 * so a template it can't render fails its test rather than passing it.
 */

type Value = unknown;
type Scope = Map<string, Value>;

class JinjaError extends Error {}
class Break {}
class Continue {}

// ------------------------------------------------------------------------------------------------ lexing

interface Piece {
	kind: "text" | "var" | "tag";
	body: string;
	trimLeft: boolean;
	trimRight: boolean;
}

function lex(source: string): Piece[] {
	const out: Piece[] = [];
	let i = 0;
	while (i < source.length) {
		const at = source.slice(i).search(/\{[{%#]/);
		if (at < 0) {
			out.push({ kind: "text", body: source.slice(i), trimLeft: false, trimRight: false });
			break;
		}
		if (at > 0) out.push({ kind: "text", body: source.slice(i, i + at), trimLeft: false, trimRight: false });
		i += at;
		const open = source[i + 1];
		const close = open === "{" ? "}}" : open === "%" ? "%}" : "#}";
		// The tag's end, outside any quoted string in it ("}}" can be in a string literal).
		let end = -1;
		let quote = "";
		for (let k = i + 2; k < source.length - 1; k++) {
			const ch = source[k];
			if (open === "#") {
				if (source.startsWith(close, k)) {
					end = k;
					break;
				}
				continue;
			}
			if (quote) {
				if (ch === "\\") k++;
				else if (ch === quote) quote = "";
			} else if (ch === '"' || ch === "'") quote = ch;
			else if (source.startsWith(close, k)) {
				end = k;
				break;
			}
		}
		if (end < 0) throw new JinjaError("unclosed tag");
		let body = source.slice(i + 2, end);
		const trimLeft = body.startsWith("-");
		const trimRight = body.endsWith("-");
		if (trimLeft || body.startsWith("+")) body = body.slice(1);
		if (trimRight || body.endsWith("+")) body = body.slice(0, -1);
		if (open !== "#") out.push({ kind: open === "{" ? "var" : "tag", body: body.trim(), trimLeft, trimRight });
		else out.push({ kind: "tag", body: "#comment", trimLeft, trimRight });
		i = end + 2;
		// {% raw %}: everything up to {% endraw %} is text.
		if (open === "%" && /^raw$/.test(body.trim())) {
			const m = /\{%-?\s*endraw\s*-?%\}/.exec(source.slice(i));
			if (!m) throw new JinjaError("unclosed raw");
			out.push({ kind: "text", body: source.slice(i, i + m.index), trimLeft: false, trimRight: false });
			out.push({ kind: "tag", body: "endraw", trimLeft: false, trimRight: false });
			i += m.index + m[0].length;
		}
	}
	// Whitespace control, trim_blocks and lstrip_blocks.
	for (let k = 0; k < out.length; k++) {
		const p = out[k];
		if (p.kind !== "text") continue;
		const prev = out[k - 1];
		const next = out[k + 1];
		if (prev?.trimRight) p.body = p.body.replace(/^\s+/, "");
		else if (prev?.kind === "tag") p.body = p.body.replace(/^\n/, "");
		if (next?.trimLeft) p.body = p.body.replace(/\s+$/, "");
		else if (next?.kind === "tag") p.body = p.body.replace(/(^|\n)[ \t]+$/, "$1");
	}
	return out.filter((p) => !(p.kind === "tag" && p.body === "#comment"));
}

// ------------------------------------------------------------------------------------------------ expressions

type Tok = { t: "name" | "str" | "num" | "op"; v: string };

function tokens(src: string): Tok[] {
	const out: Tok[] = [];
	const re =
		/\s*(?:([A-Za-z_][A-Za-z0-9_]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\d+\.\d+|\d+)|(\*\*|\/\/|==|!=|<=|>=|[-+*/%~<>=()[\]{}.,:|?!]))/y;
	let m: RegExpExecArray | null;
	re.lastIndex = 0;
	while (re.lastIndex < src.length) {
		if (/^\s*$/.test(src.slice(re.lastIndex))) break;
		m = re.exec(src);
		if (!m)
			throw new JinjaError(
				`can't read expression at: ${src.slice(re.lastIndex, re.lastIndex + 30)} in: ${src.slice(0, 160)}`,
			);
		if (m[1] !== undefined) out.push({ t: "name", v: m[1] });
		else if (m[2] !== undefined) out.push({ t: "str", v: unquote(m[2]) });
		else if (m[3] !== undefined) out.push({ t: "num", v: m[3] });
		else out.push({ t: "op", v: m[4] });
	}
	return out;
}

function unquote(s: string): string {
	const body = s.slice(1, -1);
	return body.replace(/\\(.)/g, (_, c: string) =>
		c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c === "0" ? "\0" : c,
	);
}

type Expr = (scope: Scope) => Value;

class ExprParser {
	private i = 0;
	private readonly toks: Tok[];
	constructor(toks: Tok[]) {
		this.toks = toks;
	}
	done(): boolean {
		return this.i >= this.toks.length;
	}
	private peek(v?: string): Tok | undefined {
		const t = this.toks[this.i];
		if (v === undefined) return t;
		return t && (t.t === "op" || t.t === "name") && t.v === v ? t : undefined;
	}
	private take(v?: string): Tok {
		const t = this.toks[this.i];
		if (!t) throw new JinjaError(`expected ${v ?? "more"}`);
		if (v !== undefined && t.v !== v) throw new JinjaError(`expected ${v}, got ${t.v}`);
		this.i++;
		return t;
	}
	private accept(v: string): boolean {
		if (this.peek(v)) {
			this.i++;
			return true;
		}
		return false;
	}
	expr(): Expr {
		const value = this.or();
		if (this.peek("if")) {
			this.take("if");
			const cond = this.or();
			const other = this.accept("else") ? this.expr() : () => undefined;
			return (s) => (truthy(cond(s)) ? value(s) : other(s));
		}
		return value;
	}
	private or(): Expr {
		let left = this.and();
		while (this.accept("or")) {
			const a = left;
			const b = this.and();
			left = (s) => {
				const x = a(s);
				return truthy(x) ? x : b(s);
			};
		}
		return left;
	}
	private and(): Expr {
		let left = this.not();
		while (this.accept("and")) {
			const a = left;
			const b = this.not();
			left = (s) => {
				const x = a(s);
				return truthy(x) ? b(s) : x;
			};
		}
		return left;
	}
	private not(): Expr {
		if (this.accept("not")) {
			const e = this.not();
			return (s) => !truthy(e(s));
		}
		return this.compare();
	}
	private compare(): Expr {
		let left = this.concat();
		for (;;) {
			const t = this.peek();
			if (!t) return left;
			if (t.t === "op" && ["==", "!=", "<", ">", "<=", ">="].includes(t.v)) {
				this.i++;
				const op = t.v;
				const a = left;
				const b = this.concat();
				left = (s) => compareOp(op, a(s), b(s));
			} else if (t.t === "name" && t.v === "in") {
				this.i++;
				const a = left;
				const b = this.concat();
				left = (s) => contains(b(s), a(s));
			} else if (t.t === "name" && t.v === "not" && this.toks[this.i + 1]?.v === "in") {
				this.i += 2;
				const a = left;
				const b = this.concat();
				left = (s) => !contains(b(s), a(s));
			} else if (t.t === "name" && t.v === "is") {
				this.i++;
				const negate = this.accept("not");
				const name = this.take().v;
				let arg: Expr | undefined;
				if (this.peek("(")) {
					this.take("(");
					arg = this.expr();
					this.take(")");
				} else if (this.peek() && ["str", "num"].includes(this.peek()!.t)) arg = this.primary();
				const a = left;
				left = (s) => {
					const r = applyTest(name, a(s), arg?.(s));
					return negate ? !r : r;
				};
			} else return left;
		}
	}
	private concat(): Expr {
		let left = this.add();
		while (this.accept("~")) {
			const a = left;
			const b = this.add();
			left = (s) => str(a(s)) + str(b(s));
		}
		return left;
	}
	private add(): Expr {
		let left = this.mul();
		for (;;) {
			if (this.accept("+")) {
				const a = left;
				const b = this.mul();
				left = (s) => plus(a(s), b(s));
			} else if (this.accept("-")) {
				const a = left;
				const b = this.mul();
				left = (s) => (a(s) as number) - (b(s) as number);
			} else return left;
		}
	}
	private mul(): Expr {
		let left = this.unary();
		for (;;) {
			const t = this.peek();
			if (t?.t === "op" && ["*", "/", "//", "%", "**"].includes(t.v)) {
				this.i++;
				const a = left;
				const b = this.unary();
				const op = t.v;
				left = (s) => {
					const x = a(s) as number;
					const y = b(s) as number;
					if (op === "**") return x ** y;
					return op === "*" ? x * y : op === "/" ? x / y : op === "//" ? Math.floor(x / y) : ((x % y) + y) % y;
				};
			} else return left;
		}
	}
	private unary(): Expr {
		if (this.accept("-")) {
			const e = this.unary();
			return (s) => -(e(s) as number);
		}
		return this.postfix();
	}
	private args(): { pos: Expr[]; kw: Array<[string, Expr]> } {
		const pos: Expr[] = [];
		const kw: Array<[string, Expr]> = [];
		if (this.accept(")")) return { pos, kw };
		for (;;) {
			const t = this.peek();
			if (this.accept("**")) kw.push(["**", this.expr()]);
			else if (t?.t === "name" && this.toks[this.i + 1]?.v === "=" && this.toks[this.i + 2]?.v !== "=") {
				this.i += 2;
				kw.push([t.v, this.expr()]);
			} else pos.push(this.expr());
			if (this.accept(")")) return { pos, kw };
			this.take(",");
		}
	}
	private postfix(): Expr {
		let e = this.primary();
		for (;;) {
			if (this.accept(".")) {
				const name = this.take().v;
				const base = e;
				e = (s) => getAttr(base(s), name);
			} else if (this.accept("[")) {
				const base = e;
				const parts: Array<Expr | undefined> = [undefined, undefined, undefined];
				let k = 0;
				let slice = false;
				while (!this.peek("]")) {
					if (this.accept(":")) {
						slice = true;
						k++;
						continue;
					}
					parts[k] = this.expr();
				}
				this.take("]");
				e = slice
					? (s) => sliceOf(base(s), parts[0]?.(s), parts[1]?.(s), parts[2]?.(s))
					: (s) => getItem(base(s), parts[0]!(s));
			} else if (this.accept("(")) {
				const base = e;
				const { pos, kw } = this.args();
				e = (s) => {
					const f = base(s);
					if (typeof f !== "function") throw new JinjaError("not callable");
					const kwargs: Record<string, Value> = {};
					for (const [k, v] of kw)
						if (k === "**") Object.assign(kwargs, v(s) as Record<string, Value>);
						else kwargs[k] = v(s);
					return (f as (...a: Value[]) => Value)(
						...pos.map((p) => p(s)),
						...(kw.length ? [new Kwargs(kwargs)] : []),
					);
				};
			} else if (this.accept("|")) {
				const name = this.take().v;
				let args: { pos: Expr[]; kw: Array<[string, Expr]> } = { pos: [], kw: [] };
				if (this.accept("(")) args = this.args();
				const base = e;
				e = (s) =>
					applyFilter(
						name,
						base(s),
						args.pos.map((p) => p(s)),
						Object.fromEntries(args.kw.map(([k, v]) => [k, v(s)])),
					);
			} else return e;
		}
	}
	private primary(): Expr {
		const t = this.take();
		if (t.t === "str") {
			let v = t.v;
			while (this.peek()?.t === "str") v += this.take().v;
			return () => v;
		}
		if (t.t === "num") {
			const n = Number(t.v);
			return () => n;
		}
		if (t.t === "name") {
			if (t.v === "true" || t.v === "True") return () => true;
			if (t.v === "false" || t.v === "False") return () => false;
			if (t.v === "none" || t.v === "None") return () => null;
			const name = t.v;
			return (s) => lookup(s, name);
		}
		if (t.v === "(") {
			if (this.accept(")")) return () => [];
			const first = this.expr();
			if (this.accept(")")) return first;
			const items = [first];
			while (this.accept(",")) {
				if (this.peek(")")) break;
				items.push(this.expr());
			}
			this.take(")");
			return (s) => items.map((x) => x(s));
		}
		if (t.v === "[") {
			const items: Expr[] = [];
			while (!this.accept("]")) {
				items.push(this.expr());
				this.accept(",");
			}
			return (s) => items.map((x) => x(s));
		}
		if (t.v === "{") {
			const items: Array<[Expr, Expr]> = [];
			while (!this.accept("}")) {
				const k = this.expr();
				this.take(":");
				items.push([k, this.expr()]);
				this.accept(",");
			}
			return (s) => Object.fromEntries(items.map(([k, v]) => [str(k(s)), v(s)]));
		}
		throw new JinjaError(`unexpected ${t.v}`);
	}
	/** A target list for for/set: `a` or `a, b`. */
	targets(): string[] {
		const out = [this.take().v];
		while (this.accept(",")) out.push(this.take().v);
		return out;
	}
	expectName(v: string): void {
		this.take(v);
	}
	peekName(v: string): boolean {
		return !!this.peek(v);
	}
}

class Kwargs {
	readonly values: Record<string, Value>;
	constructor(values: Record<string, Value>) {
		this.values = values;
	}
}

function parseExpr(src: string): Expr {
	const p = new ExprParser(tokens(src));
	const e = p.expr();
	if (!p.done()) throw new JinjaError(`trailing input in: ${src}`);
	return e;
}

// ------------------------------------------------------------------------------------------------ values

function truthy(v: Value): boolean {
	if (Array.isArray(v)) return v.length > 0;
	if (v && typeof v === "object" && !(v instanceof Namespace)) return Object.keys(v).length > 0;
	return !!v;
}

function str(v: Value): string {
	if (v === undefined) return "";
	if (v === null) return "None";
	if (v === true) return "True";
	if (v === false) return "False";
	if (typeof v === "string") return v;
	if (typeof v === "number") return String(v);
	return pyJson(v);
}

/** Python json.dumps with the default separators. */
export function pyJson(v: Value, indent?: number, level = 0): string {
	if (v === null || v === undefined) return "null";
	if (typeof v === "string") return JSON.stringify(v);
	if (typeof v !== "object") return JSON.stringify(v);
	const pad = indent !== undefined ? `\n${" ".repeat(indent * (level + 1))}` : "";
	const end = indent !== undefined ? `\n${" ".repeat(indent * level)}` : "";
	const sep = indent !== undefined ? "," : ", ";
	if (Array.isArray(v)) {
		if (v.length === 0) return "[]";
		return `[${pad}${v.map((x) => pyJson(x, indent, level + 1)).join(sep + pad)}${end}]`;
	}
	const entries = Object.entries(v as Record<string, Value>);
	if (entries.length === 0) return "{}";
	return `{${pad}${entries.map(([k, x]) => `${JSON.stringify(k)}: ${pyJson(x, indent, level + 1)}`).join(sep + pad)}${end}}`;
}

function plus(a: Value, b: Value): Value {
	if (typeof a === "string" || typeof b === "string") return str(a) + str(b);
	if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
	return (a as number) + (b as number);
}

function compareOp(op: string, a: Value, b: Value): boolean {
	const eq = (x: Value, y: Value): boolean => {
		if ((x === undefined || x === null) && (y === undefined || y === null))
			return x === y || (x == null && y == null);
		if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => eq(v, y[i]));
		return x === y;
	};
	if (op === "==") return eq(a, b);
	if (op === "!=") return !eq(a, b);
	const x = a as number;
	const y = b as number;
	return op === "<" ? x < y : op === ">" ? x > y : op === "<=" ? x <= y : x >= y;
}

function contains(container: Value, item: Value): boolean {
	if (typeof container === "string") return container.includes(str(item));
	if (Array.isArray(container)) return container.some((x) => compareOp("==", x, item));
	if (container && typeof container === "object") return Object.hasOwn(container, str(item));
	return false;
}

class Namespace {
	[key: string]: Value;
}

function lookup(scope: Scope, name: string): Value {
	if (scope.has(name)) return scope.get(name);
	return GLOBALS[name];
}

function getItem(obj: Value, key: Value): Value {
	if (obj === undefined || obj === null) return undefined;
	if (Array.isArray(obj) || typeof obj === "string") {
		const n = key as number;
		return (obj as ArrayLike<Value>)[n < 0 ? obj.length + n : n];
	}
	if (typeof obj === "object") return (obj as Record<string, Value>)[str(key)];
	return undefined;
}

function sliceOf(obj: Value, start?: Value, stop?: Value, step?: Value): Value {
	const items = typeof obj === "string" ? [...obj] : ((obj as Value[]) ?? []);
	const n = items.length;
	const st = (step as number | undefined) ?? 1;
	const norm = (v: Value, d: number) => {
		if (v === undefined || v === null) return d;
		const x = v as number;
		return x < 0 ? Math.max(0, n + x) : Math.min(x, n);
	};
	const out: Value[] = [];
	if (st > 0) for (let i = norm(start, 0); i < norm(stop, n); i += st) out.push(items[i]);
	else {
		const from = start === undefined || start === null ? n - 1 : norm(start, n - 1);
		const to = stop === undefined || stop === null ? -1 : norm(stop, -1);
		for (let i = Math.min(from, n - 1); i > to; i += st) out.push(items[i]);
	}
	return typeof obj === "string" ? out.join("") : out;
}

function kw(args: Value[]): Record<string, Value> {
	const last = args.at(-1);
	return last instanceof Kwargs ? last.values : {};
}
function pos(args: Value[]): Value[] {
	return args.at(-1) instanceof Kwargs ? args.slice(0, -1) : args;
}

function stripChars(s: string, chars: Value, left: boolean, right: boolean): string {
	if (chars === undefined || chars === null) return left && right ? s.trim() : left ? s.trimStart() : s.trimEnd();
	const set = new Set([...str(chars)]);
	let a = 0;
	let b = s.length;
	if (left) while (a < b && set.has(s[a])) a++;
	if (right) while (b > a && set.has(s[b - 1])) b--;
	return s.slice(a, b);
}

function getAttr(obj: Value, name: string): Value {
	if (obj === undefined || obj === null) return undefined;
	if (typeof obj === "string") {
		const s = obj;
		const methods: Record<string, (...a: Value[]) => Value> = {
			startswith: (p) => (Array.isArray(p) ? p.some((x) => s.startsWith(str(x))) : s.startsWith(str(p))),
			endswith: (p) => (Array.isArray(p) ? p.some((x) => s.endsWith(str(x))) : s.endsWith(str(p))),
			strip: (c) => stripChars(s, c, true, true),
			lstrip: (c) => stripChars(s, c, true, false),
			rstrip: (c) => stripChars(s, c, false, true),
			split: (sep, max) => {
				if (sep === undefined || sep === null) return s.trim().split(/\s+/).filter(Boolean);
				const parts = s.split(str(sep));
				if (max === undefined || (max as number) < 0) return parts;
				return [...parts.slice(0, max as number), parts.slice(max as number).join(str(sep))];
			},
			rsplit: (sep, max) => {
				const parts = s.split(str(sep));
				if (max === undefined || (max as number) < 0) return parts;
				const keep = parts.length - (max as number);
				return keep <= 1 ? parts : [parts.slice(0, keep).join(str(sep)), ...parts.slice(keep)];
			},
			replace: (a, b) => s.split(str(a)).join(str(b)),
			lower: () => s.toLowerCase(),
			upper: () => s.toUpperCase(),
			title: () => s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),
			capitalize: () => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
			find: (p) => s.indexOf(str(p)),
			rfind: (p) => s.lastIndexOf(str(p)),
			index: (p) => {
				const i = s.indexOf(str(p));
				if (i < 0) throw new JinjaError("substring not found");
				return i;
			},
			count: (p) => s.split(str(p)).length - 1,
			join: (items) => ((items as Value[]) ?? []).map(str).join(s),
			splitlines: () => s.split(/\r?\n/),
			isdigit: () => /^\d+$/.test(s),
			format: (...a) => {
				let k = 0;
				return s.replace(/\{\}/g, () => str(a[k++]));
			},
		};
		return methods[name];
	}
	if (Array.isArray(obj)) {
		const list = obj;
		const methods: Record<string, (...a: Value[]) => Value> = {
			append: (x) => {
				list.push(x);
				return null;
			},
			extend: (x) => {
				list.push(...((x as Value[]) ?? []));
				return null;
			},
			pop: (i) => (i === undefined ? list.pop() : list.splice(i as number, 1)[0]),
			index: (x) => list.findIndex((v) => compareOp("==", v, x)),
			count: (x) => list.filter((v) => compareOp("==", v, x)).length,
		};
		return methods[name];
	}
	if (typeof obj === "object") {
		const o = obj as Record<string, Value>;
		if (Object.hasOwn(o, name)) return o[name];
		if (obj instanceof Namespace) return undefined;
		const methods: Record<string, (...a: Value[]) => Value> = {
			items: () => Object.entries(o),
			keys: () => Object.keys(o),
			values: () => Object.values(o),
			get: (k, d) => (Object.hasOwn(o, str(k)) ? o[str(k)] : (d ?? null)),
		};
		return methods[name];
	}
	return undefined;
}

function applyTest(name: string, v: Value, arg: Value): boolean {
	switch (name) {
		case "defined":
			return v !== undefined;
		case "undefined":
			return v === undefined;
		case "none":
			return v === null;
		case "string":
			return typeof v === "string";
		case "number":
			return typeof v === "number";
		case "integer":
			return Number.isInteger(v);
		case "boolean":
			return typeof v === "boolean";
		case "true":
			return v === true;
		case "false":
			return v === false;
		case "mapping":
			return !!v && typeof v === "object" && !Array.isArray(v);
		case "sequence":
		case "iterable":
			return Array.isArray(v) || typeof v === "string" || (!!v && typeof v === "object");
		case "equalto":
		case "eq":
			return compareOp("==", v, arg);
		case "in":
			return contains(arg, v);
		case "odd":
			return (v as number) % 2 === 1;
		case "even":
			return (v as number) % 2 === 0;
		case "divisibleby":
			return (v as number) % (arg as number) === 0;
		default:
			throw new JinjaError(`no test ${name}`);
	}
}

/** What Jinja iterates: a list, a string's characters, a mapping's keys. */
function toList(v: Value): Value[] {
	if (Array.isArray(v)) return v;
	if (typeof v === "string") return [...v];
	if (v && typeof v === "object") return Object.keys(v);
	return [];
}

function applyFilter(name: string, v: Value, args: Value[], kwargs: Record<string, Value>): Value {
	switch (name) {
		case "length":
		case "count":
			return typeof v === "string" || Array.isArray(v)
				? v.length
				: v && typeof v === "object"
					? Object.keys(v).length
					: 0;
		case "string":
			return str(v);
		case "lower":
			return str(v).toLowerCase();
		case "upper":
			return str(v).toUpperCase();
		case "trim":
		case "strip":
			return str(v).trim();
		case "default":
		case "d":
			return v === undefined || (args[1] && !truthy(v)) ? args[0] : v;
		case "join":
			return ((v as Value[]) ?? []).map(str).join(args[0] === undefined ? "" : str(args[0]));
		case "first":
			return Array.isArray(v) ? v[0] : typeof v === "string" ? v[0] : undefined;
		case "last":
			return Array.isArray(v) ? v.at(-1) : typeof v === "string" ? v.at(-1) : undefined;
		case "list":
			return typeof v === "string"
				? [...v]
				: Array.isArray(v)
					? [...v]
					: v && typeof v === "object"
						? Object.keys(v)
						: [];
		case "reverse":
			return typeof v === "string" ? [...v].reverse().join("") : [...((v as Value[]) ?? [])].reverse();
		case "replace":
			return str(v).split(str(args[0])).join(str(args[1]));
		case "tojson":
			return pyJson(v, (kwargs.indent as number | undefined) ?? (args[0] as number | undefined));
		case "int":
			return Number.parseInt(str(v), 10) || 0;
		case "float":
			return Number.parseFloat(str(v)) || 0;
		case "abs":
			return Math.abs(v as number);
		case "round":
			return Math.round(v as number);
		case "items":
			return v && typeof v === "object" ? Object.entries(v) : [];
		case "safe":
		case "e":
		case "escape":
			return v;
		case "capitalize":
			return str(v).charAt(0).toUpperCase() + str(v).slice(1).toLowerCase();
		case "title":
			return str(v).replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
		case "indent": {
			const width = (args[0] as number) ?? 4;
			const lines = str(v).split("\n");
			return [lines[0], ...lines.slice(1).map((l) => (l ? " ".repeat(width) + l : l))].join("\n");
		}
		case "unique":
			return [...new Set((v as Value[]) ?? [])];
		case "sort":
			return [...((v as Value[]) ?? [])].sort();
		case "sum":
			return ((v as number[]) ?? []).reduce((a, b) => a + b, 0);
		case "max":
			return Math.max(...((v as number[]) ?? []));
		case "min":
			return Math.min(...((v as number[]) ?? []));
		case "wordcount":
			return str(v).split(/\s+/).filter(Boolean).length;
		case "dictsort":
			return Object.entries((v as Record<string, Value>) ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
		case "map": {
			const list = toList(v);
			if (kwargs.attribute !== undefined) return list.map((x) => getAttr(x, str(kwargs.attribute)));
			return list.map((x) => applyFilter(str(args[0]), x, args.slice(1), {}));
		}
		case "selectattr":
		case "rejectattr": {
			const list = toList(v);
			const keep = (x: Value) => {
				const a = getAttr(x, str(args[0]));
				return args[1] === undefined ? truthy(a) : applyTest(str(args[1]), a, args[2]);
			};
			return list.filter((x) => (name === "selectattr" ? keep(x) : !keep(x)));
		}
		case "select":
		case "reject": {
			const list = toList(v);
			const keep = (x: Value) => (args[0] === undefined ? truthy(x) : applyTest(str(args[0]), x, args[1]));
			return list.filter((x) => (name === "select" ? keep(x) : !keep(x)));
		}
		default:
			throw new JinjaError(`no filter ${name}`);
	}
}

const GLOBALS: Record<string, Value> = {
	namespace: (...args: Value[]) => Object.assign(new Namespace(), kw(args)),
	range: (...args: Value[]) => {
		const a = pos(args) as number[];
		const [start, stop, step] = a.length === 1 ? [0, a[0], 1] : [a[0], a[1], a[2] ?? 1];
		const out: number[] = [];
		for (let i = start; step > 0 ? i < stop : i > stop; i += step) out.push(i);
		return out;
	},
	dict: (...args: Value[]) => Object.assign({}, ...(pos(args) as Array<Record<string, Value>>), kw(args)),
	raise_exception: (message: Value) => {
		throw new JinjaError(`template raised: ${str(message)}`);
	},
	strftime_now: () => "26 Nov 2026",
};

// ------------------------------------------------------------------------------------------------ statements

type Node = (scope: Scope, out: string[]) => void;

class Parser {
	private i = 0;
	private readonly pieces: Piece[];
	constructor(pieces: Piece[]) {
		this.pieces = pieces;
	}

	/** Nodes up to one of `ends` (a tag's first word); returns the nodes and the tag that ended them. */
	block(ends: string[]): { nodes: Node[]; end?: string } {
		const nodes: Node[] = [];
		while (this.i < this.pieces.length) {
			const p = this.pieces[this.i];
			if (p.kind === "text") {
				const text = p.body;
				nodes.push((_s, out) => out.push(text));
				this.i++;
			} else if (p.kind === "var") {
				const e = parseExpr(p.body);
				nodes.push((s, out) => out.push(str(e(s))));
				this.i++;
			} else {
				const word = /^\w+/.exec(p.body)?.[0] ?? "";
				if (ends.includes(word)) return { nodes, end: p.body };
				this.i++;
				nodes.push(this.statement(word, p.body.slice(word.length).trim()));
			}
		}
		if (ends.length > 0) throw new JinjaError(`missing ${ends.join("/")}`);
		return { nodes };
	}

	private statement(word: string, rest: string): Node {
		switch (word) {
			case "if":
				return this.ifNode(rest);
			case "for":
				return this.forNode(rest);
			case "set":
				return this.setNode(rest);
			case "macro":
				return this.macroNode(rest);
			case "break":
				return () => {
					throw new Break();
				};
			case "continue":
				return () => {
					throw new Continue();
				};
			case "generation": {
				const { nodes } = this.block(["endgeneration"]);
				this.i++;
				return (s, out) => run(nodes, s, out);
			}
			case "raw": {
				const { nodes } = this.block(["endraw"]);
				this.i++;
				return (s, out) => run(nodes, s, out);
			}
			case "filter": {
				const name = rest.trim();
				const { nodes } = this.block(["endfilter"]);
				this.i++;
				return (s, out) => {
					const inner: string[] = [];
					run(nodes, s, inner);
					out.push(str(applyFilter(name, inner.join(""), [], {})));
				};
			}
			default:
				throw new JinjaError(`no statement ${word}`);
		}
	}

	private ifNode(cond: string): Node {
		const branches: Array<{ cond: Expr | undefined; nodes: Node[] }> = [];
		let c: Expr | undefined = parseExpr(cond);
		for (;;) {
			const { nodes, end } = this.block(["elif", "else", "endif"]);
			branches.push({ cond: c, nodes });
			this.i++;
			const word = /^\w+/.exec(end!)?.[0];
			if (word === "endif") break;
			c = word === "elif" ? parseExpr(end!.slice(4)) : undefined;
		}
		return (s, out) => {
			for (const b of branches)
				if (!b.cond || truthy(b.cond(s))) {
					run(b.nodes, s, out);
					return;
				}
		};
	}

	private forNode(header: string): Node {
		const p = new ExprParser(tokens(header));
		const names = p.targets();
		p.expectName("in");
		const iter = p.expr();
		// `for x in y if cond`: the conditional expression parser took `if`; split it off from the source instead.
		const m = /^(.*?)\s+in\s+(.+?)(?:\s+if\s+(.+))?$/s.exec(header);
		const iterExpr = m?.[3] ? parseExpr(m[2]) : iter;
		const filter = m?.[3] ? parseExpr(m[3]) : undefined;
		const { nodes, end } = this.block(["else", "endfor"]);
		this.i++;
		let elseNodes: Node[] = [];
		if (/^else/.test(end!)) {
			elseNodes = this.block(["endfor"]).nodes;
			this.i++;
		}
		return (s, out) => {
			const value = iterExpr(s);
			let items: Value[] = Array.isArray(value)
				? value
				: typeof value === "string"
					? [...value]
					: value && typeof value === "object"
						? Object.keys(value)
						: [];
			if (filter)
				items = items.filter((item) => {
					const inner = new Map(s);
					bind(inner, names, item);
					return truthy(filter(inner));
				});
			if (items.length === 0) {
				run(elseNodes, s, out);
				return;
			}
			const scope = new Map(s);
			for (let k = 0; k < items.length; k++) {
				bind(scope, names, items[k]);
				scope.set("loop", {
					index: k + 1,
					index0: k,
					first: k === 0,
					last: k === items.length - 1,
					length: items.length,
					revindex: items.length - k,
					revindex0: items.length - k - 1,
					previtem: items[k - 1],
					nextitem: items[k + 1],
					cycle: (...a: Value[]) => a[k % a.length],
				});
				try {
					run(nodes, scope, out);
				} catch (e) {
					if (e instanceof Break) break;
					if (e instanceof Continue) continue;
					throw e;
				}
			}
			// Assignments in the loop's body to names that existed outside stay inside it, as in Jinja.
		};
	}

	private setNode(rest: string): Node {
		const eq = rest.search(/(?<![=!<>])=(?!=)/);
		if (eq < 0) {
			// {% set name %}...{% endset %}
			const name = rest.trim();
			const { nodes } = this.block(["endset"]);
			this.i++;
			return (s, _out) => {
				const inner: string[] = [];
				run(nodes, s, inner);
				s.set(name, inner.join(""));
			};
		}
		const target = rest.slice(0, eq).trim();
		const value = parseExpr(rest.slice(eq + 1));
		if (target.includes(".")) {
			const [obj, attr] = target.split(".").map((x) => x.trim());
			return (s) => {
				const ns = lookup(s, obj) as Record<string, Value>;
				ns[attr] = value(s);
			};
		}
		const names = target.split(",").map((x) => x.trim());
		return (s) => bind(s, names, value(s));
	}

	private macroNode(rest: string): Node {
		const m = /^(\w+)\s*\((.*)\)$/s.exec(rest);
		if (!m) throw new JinjaError("bad macro");
		const params = m[2]
			.split(",")
			.map((x) => x.trim())
			.filter(Boolean)
			.map((x) => {
				const [n, d] = x.split("=").map((y) => y.trim());
				return { name: n, def: d !== undefined ? parseExpr(d) : undefined };
			});
		const { nodes } = this.block(["endmacro"]);
		this.i++;
		return (s) => {
			s.set(m[1], (...args: Value[]) => {
				const k = kw(args);
				const p = pos(args);
				const scope = new Map(s);
				params.forEach((param, i) => {
					scope.set(param.name, i < p.length ? p[i] : param.name in k ? k[param.name] : param.def?.(s));
				});
				const out: string[] = [];
				run(nodes, scope, out);
				return out.join("");
			});
		};
	}
}

function bind(scope: Scope, names: string[], value: Value): void {
	if (names.length === 1) scope.set(names[0], value);
	else
		names.forEach((n, i) => {
			scope.set(n, (value as Value[])[i]);
		});
}

function run(nodes: Node[], scope: Scope, out: string[]): void {
	for (const node of nodes) node(scope, out);
}

/** Render `template` with `context`'s values. */
export function renderTemplate(template: string, context: Record<string, Value>): string {
	const parser = new Parser(lex(template));
	const { nodes } = parser.block([]);
	const scope: Scope = new Map(Object.entries(context));
	const out: string[] = [];
	run(nodes, scope, out);
	return out.join("");
}
