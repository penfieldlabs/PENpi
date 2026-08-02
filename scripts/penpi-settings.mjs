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

const [action, settingsPath, adapter] = process.argv.slice(2);

if (!settingsPath || !adapter || !["install", "uninstall"].includes(action)) {
	console.error("usage: penpi-settings.mjs <install|uninstall> <settings-path> <adapter>");
	process.exit(2);
}

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
		settings.packages = Array.from(new Set([...(settings.packages ?? []), adapter]));
		settings.compaction = { ...(settings.compaction ?? {}), enabled: false };
		writeSettings(settings, exists);
	} else if (exists) {
		settings.packages = (settings.packages ?? []).filter((x) => x !== adapter);
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
