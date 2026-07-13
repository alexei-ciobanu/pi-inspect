import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { clipboardCommands, extractToolExchanges, formatToolExchange, registerInspectExtension } from "../src/index.js";

describe("tool exchange extraction", () => {
	it("pairs assistant calls with finalized results and keeps details separate", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "Looking." },
						{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: "final transformed output" }],
					isError: false,
					details: { hidden: true },
				},
			},
		];

		const exchanges = extractToolExchanges(entries);
		expect(exchanges).toEqual([
			{
				toolCallId: "call-1",
				toolName: "read",
				arguments: { path: "README.md" },
				content: [{ type: "text", text: "final transformed output" }],
				isError: false,
				details: { hidden: true },
			},
		]);

		const report = formatToolExchange(exchanges[0] as NonNullable<(typeof exchanges)[0]>);
		expect(report).toContain('{"path":"README.md"}');
		expect(report).toContain("Final Pi model-context tool-result message");
		expect(report).toContain("final transformed output");
		expect(report).toContain("Text result string");
		expect(report).toContain("Pi metadata, not sent to the model");
	});

	it("returns only completed calls in assistant call order", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
						{ type: "toolCall", id: "b", name: "read", arguments: { path: "b" } },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "b",
					toolName: "read",
					content: [{ type: "text", text: "B" }],
					isError: true,
				},
			},
		];

		expect(extractToolExchanges(entries)).toEqual([
			{
				toolCallId: "b",
				toolName: "read",
				arguments: { path: "b" },
				content: [{ type: "text", text: "B" }],
				isError: true,
			},
		]);
	});
});

describe("clipboard selection", () => {
	it("prefers Termux on Android", () => {
		expect(clipboardCommands("android", {})).toEqual([{ command: "termux-clipboard-set", args: [] }]);
	});

	it("prefers clip.exe under WSL and retains Linux fallbacks", () => {
		const commands = clipboardCommands("linux", { WSL_DISTRO_NAME: "Ubuntu" });
		expect(commands[0]).toEqual({ command: "clip.exe", args: [] });
		expect(commands).toContainEqual({ command: "xsel", args: ["--clipboard", "--input"] });
	});
});

describe("extension registration", () => {
	it("registers inspect commands without adding tools or prompt hooks", () => {
		const commands: string[] = [];
		const events: string[] = [];
		const api = {
			on(name: string) {
				events.push(name);
			},
			registerCommand(name: string) {
				commands.push(name);
			},
		} as unknown as ExtensionAPI;

		registerInspectExtension(api);
		expect(commands).toEqual(["inspect", "system-prompt", "tool-result"]);
		expect(events).toEqual(["session_start", "agent_start"]);
	});

	it("uses the prompt captured after before-agent-start extensions", async () => {
		type Handler = (event: unknown, context: unknown) => unknown;
		const events = new Map<string, Handler>();
		const commands = new Map<string, { handler: (arguments_: string, context: unknown) => Promise<void> }>();
		const api = {
			on(name: string, handler: Handler) {
				events.set(name, handler);
			},
			registerCommand(name: string, options: { handler: (arguments_: string, context: unknown) => Promise<void> }) {
				commands.set(name, options);
			},
		} as unknown as ExtensionAPI;
		let viewed = "";
		const baseContext = {
			waitForIdle: async () => undefined,
			getSystemPrompt: () => "BASE",
			hasUI: true,
			ui: {
				notify: () => undefined,
				editor: async (_title: string, text: string) => {
					viewed = text;
					return undefined;
				},
			},
		};

		registerInspectExtension(api);
		events.get("session_start")?.({}, baseContext);
		events.get("agent_start")?.({}, { ...baseContext, getSystemPrompt: () => "BASE\n\nAUTO MEMORY" });
		await commands.get("inspect")?.handler("prompt", baseContext);

		expect(viewed).toBe("BASE\n\nAUTO MEMORY");
	});
});
