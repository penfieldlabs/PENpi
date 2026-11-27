/**
 * 0.9.0: the chat templates the reasoning rules were read from (engine/tokenizers/reasoning.ts), fetched by
 * `npm run setup:tokenizers` into this directory's git-ignored .cache/templates (E2_TEMPLATES_DIR moves it), each
 * checked by the SHA-256 the rule pins. reasoning-rules.test.ts renders them. They are the model owners' files, so they
 * are fetched, not committed.
 *
 *   node fetch-templates.ts        fetch what is missing, check every file, print the count
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REASONING_RULES, type RuleTemplate } from "../../../../../.pi/extensions/penpi/engine/tokenizers/reasoning.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = resolve(process.env.E2_TEMPLATES_DIR ?? join(HERE, ".cache", "templates"));

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Every pinned template, once. */
export function pinnedTemplates(): RuleTemplate[] {
	const all = new Map<string, RuleTemplate>();
	for (const rule of REASONING_RULES) for (const t of rule.templates) all.set(t.sha256, t);
	return [...all.values()];
}

/** A pinned template's text from the cache, checked against its hash; undefined when it isn't there. */
export function cachedTemplate(t: RuleTemplate): string | undefined {
	const file = join(TEMPLATES_DIR, `${t.sha256}.jinja`);
	if (!existsSync(file)) return undefined;
	const text = readFileSync(file, "utf8");
	if (sha256(text) !== t.sha256) throw new Error(`${file}: does not match its pinned SHA-256`);
	return text;
}

/** The template text a file holds: chat_template.jinja as it is, or tokenizer_config.json's (default) chat_template. */
function templateOf(file: RuleTemplate["file"], body: string): string {
	if (file === "chat_template.jinja") return body;
	const template = (JSON.parse(body) as { chat_template?: string | Array<{ name: string; template: string }> })
		.chat_template;
	if (Array.isArray(template)) return (template.find((x) => x.name === "default") ?? template[0]).template;
	return template ?? "";
}

async function fetchAll(): Promise<void> {
	mkdirSync(TEMPLATES_DIR, { recursive: true });
	let fetched = 0;
	for (const t of pinnedTemplates()) {
		if (cachedTemplate(t) !== undefined) continue;
		const url = `https://huggingface.co/${t.repo}/resolve/${t.revision}/${t.file}`;
		const response = await fetch(url, { headers: { "accept-encoding": "identity" } });
		if (!response.ok) throw new Error(`${url}: ${response.status}`);
		const text = templateOf(t.file, await response.text());
		if (sha256(text) !== t.sha256)
			throw new Error(`${t.repo}@${t.revision}: the template does not match its pinned SHA-256`);
		writeFileSync(join(TEMPLATES_DIR, `${t.sha256}.jinja`), text);
		fetched++;
	}
	console.log(`chat templates ready: ${pinnedTemplates().length} in ${TEMPLATES_DIR} (${fetched} fetched)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await fetchAll();
