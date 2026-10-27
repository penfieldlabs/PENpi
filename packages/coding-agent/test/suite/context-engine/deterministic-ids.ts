/**
 * D13: deterministic session entry ids for the engine suite and E2 (a setup file of both vitest configs). Pi
 * takes entry ids from randomUUID(); the window header and cap notices name them, so random ids moved the
 * estimate by a token or so between runs, and a cut planned at the edge moved with it. Here ids count from
 * zero, reset before every test; resetEntryIds() starts again within one (for example per run).
 */
import { beforeEach, vi } from "vitest";

const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock("crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return {
		...actual,
		randomUUID: () => `${(ids.next++).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
	};
});

export function resetEntryIds(): void {
	ids.next = 0;
}

beforeEach(() => resetEntryIds());
