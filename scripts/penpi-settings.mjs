#!/usr/bin/env node

import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const [action, settingsPath] = process.argv.slice(2);

if (!settingsPath || !["install", "uninstall"].includes(action)) {
	console.error("usage: penpi-settings.mjs <install|uninstall> <settings-path>");
	process.exit(2);
}

// PENpi embeds pi-mcp-adapter with a global-only config (ADR 0026). A separately
// installed stock adapter package reads project MCP config, so both install and
// uninstall remove it; earlier PENpi versions added it here.
const STOCK_ADAPTER = /(^|[:/])pi-mcp-adapter(@|$)/;

// Pi's built-in MCP extension reads the same global mcp.json where PENpi writes its
// penfield entry. It steps aside when the embedded adapter registers /mcp, but would run in
// its place if the adapter failed to load, so install disables it outright.
const DISABLE_BUILTIN_MCP = "-builtin:mcp";
const BUILTIN_MCP_TOGGLE = /^[-+!]?builtin:mcp$/;

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readSettings() {
	if (!existsSync(settingsPath)) return { exists: false, value: {} };
	if (lstatSync(settingsPath).isSymbolicLink()) {
		throw new Error(`refusing to read or replace symbolic-link settings file: ${settingsPath}`);
	}

	let value;
	try {
		value = JSON.parse(readFileSync(settingsPath, "utf8"));
	} catch (error) {
		throw new Error(`refusing to rewrite malformed settings file ${settingsPath}: ${error.message}`);
	}
	if (!isRecord(value)) {
		throw new Error(`refusing to rewrite settings file ${settingsPath}: JSON root must be an object`);
	}
	if (value.packages !== undefined && (!Array.isArray(value.packages) || !value.packages.every((x) => typeof x === "string"))) {
		throw new Error(`refusing to rewrite settings file ${settingsPath}: packages must be an array of strings`);
	}
	if (value.extensions !== undefined && (!Array.isArray(value.extensions) || !value.extensions.every((x) => typeof x === "string"))) {
		throw new Error(`refusing to rewrite settings file ${settingsPath}: extensions must be an array of strings`);
	}
	if (value.compaction !== undefined && !isRecord(value.compaction)) {
		throw new Error(`refusing to rewrite settings file ${settingsPath}: compaction must be an object`);
	}
	return { exists: true, value };
}

function writeSettings(value, existed) {
	mkdirSync(dirname(settingsPath), { recursive: true });
	const mode = existed ? statSync(settingsPath).mode & 0o777 : 0o600;
	const tmp = `${settingsPath}.penpi-${process.pid}-${Date.now()}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode, flag: "wx" });
		renameSync(tmp, settingsPath);
		chmodSync(settingsPath, mode);
	} finally {
		if (existsSync(tmp)) unlinkSync(tmp);
	}
}

try {
	const { exists, value: settings } = readSettings();
	if (action === "install") {
		if (settings.packages !== undefined) settings.packages = settings.packages.filter((x) => !STOCK_ADAPTER.test(x));
		settings.compaction = { ...(settings.compaction ?? {}), enabled: false };
		settings.extensions = [...(settings.extensions ?? []).filter((x) => !BUILTIN_MCP_TOGGLE.test(x)), DISABLE_BUILTIN_MCP];
		writeSettings(settings, exists);
	} else if (exists) {
		if (settings.packages !== undefined) settings.packages = settings.packages.filter((x) => !STOCK_ADAPTER.test(x));
		if (settings.extensions !== undefined) {
			settings.extensions = settings.extensions.filter((x) => x !== DISABLE_BUILTIN_MCP);
			if (settings.extensions.length === 0) delete settings.extensions;
		}
		if (settings.compaction?.enabled === false) {
			delete settings.compaction.enabled;
			if (Object.keys(settings.compaction).length === 0) delete settings.compaction;
		}
		writeSettings(settings, true);
	}
} catch (error) {
	console.error(`PENpi settings error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
