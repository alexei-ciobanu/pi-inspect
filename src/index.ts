import { spawn } from "node:child_process";
import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

type UnknownRecord = Record<string, unknown>;

export interface ToolExchange {
	toolCallId: string;
	toolName: string;
	arguments: unknown;
	content: unknown;
	isError: boolean;
	details?: unknown;
}

export interface ClipboardCommand {
	command: string;
	args: string[];
}

const POWERSHELL_UTF8_CLIPBOARD_ARGS = [
	"-NoProfile",
	"-NonInteractive",
	"-Command",
	"[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd())",
];

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function getMessage(entry: unknown): UnknownRecord | undefined {
	if (!isRecord(entry) || entry["type"] !== "message" || !isRecord(entry["message"])) return undefined;
	return entry["message"];
}

/** Pair persisted assistant tool-call blocks with their finalized tool-result messages. */
export function extractToolExchanges(entries: readonly unknown[]): ToolExchange[] {
	const calls = new Map<string, { toolCallId: string; toolName: string; arguments: unknown; order: number }>();
	const results = new Map<
		string,
		{ toolName?: string; content: unknown; isError: boolean; detailsPresent: boolean; details: unknown }
	>();
	let order = 0;

	for (const entry of entries) {
		const message = getMessage(entry);
		if (!message) continue;

		if (message["role"] === "assistant") {
			for (const block of asArray(message["content"])) {
				if (!isRecord(block) || block["type"] !== "toolCall") continue;
				if (typeof block["id"] !== "string" || typeof block["name"] !== "string") continue;
				calls.set(block["id"], {
					toolCallId: block["id"],
					toolName: block["name"],
					arguments: block["arguments"],
					order,
				});
				order += 1;
			}
			continue;
		}

		if (message["role"] !== "toolResult" || typeof message["toolCallId"] !== "string") continue;
		results.set(message["toolCallId"], {
			...(typeof message["toolName"] === "string" ? { toolName: message["toolName"] } : {}),
			content: message["content"],
			isError: message["isError"] === true,
			detailsPresent: Object.hasOwn(message, "details"),
			details: message["details"],
		});
	}

	return [...calls.values()]
		.sort((left, right) => left.order - right.order)
		.flatMap((call): ToolExchange[] => {
			const result = results.get(call.toolCallId);
			if (!result) return [];
			return [
				{
					toolCallId: call.toolCallId,
					toolName: result.toolName ?? call.toolName,
					arguments: call.arguments,
					content: result.content,
					isError: result.isError,
					...(result.detailsPresent ? { details: result.details } : {}),
				},
			];
		});
}

function stringify(value: unknown, indentation?: number): string {
	if (value === undefined) return "undefined";
	try {
		return JSON.stringify(value, null, indentation) ?? String(value);
	} catch {
		return String(value);
	}
}

export function toolResultText(content: unknown): string {
	return asArray(content)
		.filter((block): block is UnknownRecord => isRecord(block) && block["type"] === "text")
		.map((block) => (typeof block["text"] === "string" ? block["text"] : ""))
		.join("\n");
}

export function formatToolExchange(exchange: ToolExchange): string {
	const modelResult = {
		role: "toolResult",
		toolCallId: exchange.toolCallId,
		toolName: exchange.toolName,
		content: exchange.content,
		isError: exchange.isError,
	};
	const sections = [
		"# Tool exchange",
		"",
		"## Tool call",
		"",
		`Tool: ${exchange.toolName}`,
		`Call ID: ${exchange.toolCallId}`,
		"",
		"### Arguments — parsed representation Pi executed",
		"",
		"```json",
		stringify(exchange.arguments, 2),
		"```",
		"",
		"### Arguments JSON string",
		"",
		"```text",
		stringify(exchange.arguments),
		"```",
		"",
		"## Final Pi model-context tool-result message",
		"",
		"This is the finalized persisted message after tool-result hooks and message-end replacements.",
		"",
		"```json",
		stringify(modelResult, 2),
		"```",
		"",
		"### Text result string",
		"",
		"Pi's standard provider serializers join text blocks with a single newline. Image handling and ID fields are provider-specific.",
		"",
		"```text",
		toolResultText(exchange.content),
		"```",
	];

	if (Object.hasOwn(exchange, "details")) {
		sections.push(
			"",
			"## Tool details — Pi metadata, not sent to the model",
			"",
			"```json",
			stringify(exchange.details, 2),
			"```",
		);
	}

	return sections.join("\n");
}

export function formatToolInfo(tool: ToolInfo, active: boolean): string {
	return [
		`# ${tool.name}`,
		"",
		`Active: ${active}`,
		`Source: ${tool.sourceInfo.source}`,
		`Scope: ${tool.sourceInfo.scope}`,
		`Path: ${tool.sourceInfo.path}`,
		"",
		"## Description",
		"",
		tool.description,
		"",
		"## Parameter schema",
		"",
		"```json",
		stringify(tool.parameters, 2),
		"```",
		...(tool.promptGuidelines?.length
			? ["", "## Prompt guidelines", "", ...tool.promptGuidelines.map((guideline) => `- ${guideline}`)]
			: []),
	].join("\n");
}

export function clipboardCommands(
	platform: NodeJS.Platform = process.platform,
	environment: NodeJS.ProcessEnv = process.env,
): ClipboardCommand[] {
	if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
	if (platform === "win32") return [{ command: "powershell.exe", args: POWERSHELL_UTF8_CLIPBOARD_ARGS }];
	if (platform === "android" || environment["TERMUX_VERSION"]) {
		return [{ command: "termux-clipboard-set", args: [] }];
	}

	const commands: ClipboardCommand[] = [];
	if (environment["WSL_DISTRO_NAME"] || environment["WSL_INTEROP"]) {
		commands.push({ command: "powershell.exe", args: POWERSHELL_UTF8_CLIPBOARD_ARGS });
	}
	if (environment["WAYLAND_DISPLAY"]) commands.push({ command: "wl-copy", args: [] });
	commands.push(
		{ command: "xclip", args: ["-selection", "clipboard"] },
		{ command: "xsel", args: ["--clipboard", "--input"] },
		{ command: "wl-copy", args: [] },
	);
	return commands;
}

async function pipeToCommand(candidate: ClipboardCommand, text: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(candidate.command, candidate.args, { stdio: ["pipe", "ignore", "pipe"] });
		let stderr = "";
		let settled = false;
		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", fail);
		child.stdin?.on("error", fail);
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `${candidate.command} exited with code ${String(code)}`));
		});
		child.stdin?.end(text);
	});
}

export async function copyToClipboard(text: string): Promise<string> {
	const errors: string[] = [];
	for (const candidate of clipboardCommands()) {
		try {
			await pipeToCommand(candidate, text);
			return candidate.command;
		} catch (error) {
			errors.push(`${candidate.command}: ${String(error)}`);
		}
	}
	throw new Error(`No clipboard command succeeded. ${errors.join("; ")}`);
}

function parseArguments(raw: string): { subject: string; action: string } {
	const [subject = "help", action = "show"] = raw.trim().toLowerCase().split(/\s+/);
	return { subject, action };
}

async function showOrCopy(text: string, title: string, action: string, ctx: ExtensionCommandContext): Promise<void> {
	if (action === "copy") {
		try {
			const command = await copyToClipboard(text);
			ctx.ui.notify(`Copied ${text.length.toLocaleString()} characters with ${command}`, "info");
		} catch (error) {
			ctx.ui.notify(`Could not copy to clipboard: ${String(error)}`, "error");
		}
		return;
	}

	if (action !== "show") {
		ctx.ui.notify(`Unknown action: ${action}. Use show or copy.`, "error");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify(`${title} requires UI mode; use the copy action instead.`, "error");
		return;
	}
	await ctx.ui.editor(`${title} — edits are discarded`, text);
}

function exchangesFromContext(ctx: ExtensionCommandContext): ToolExchange[] {
	return extractToolExchanges(ctx.sessionManager.getBranch());
}

async function inspectResult(action: string, ctx: ExtensionCommandContext): Promise<void> {
	await ctx.waitForIdle();
	const exchanges = exchangesFromContext(ctx);
	const exchange = exchanges.at(-1);
	if (!exchange) {
		ctx.ui.notify("No completed tool exchanges exist on the active session branch.", "warning");
		return;
	}
	await showOrCopy(formatToolExchange(exchange), `Tool result: ${exchange.toolName}`, action, ctx);
}

async function inspectResults(ctx: ExtensionCommandContext): Promise<void> {
	await ctx.waitForIdle();
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Selecting tool results requires TUI mode.", "error");
		return;
	}
	const exchanges = exchangesFromContext(ctx);
	if (exchanges.length === 0) {
		ctx.ui.notify("No completed tool exchanges exist on the active session branch.", "warning");
		return;
	}
	const recent = [...exchanges].reverse();
	const items: SelectItem[] = recent.map((exchange, index) => ({
		value: String(index),
		label: exchange.toolName,
		description: `${stringify(exchange.arguments).replace(/\s+/g, " ")} · ${exchange.toolCallId}`,
	}));
	const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Completed tool exchanges")), 1, 0));
		const list = new SelectList(items, Math.min(items.length, 14), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter inspect • c copy • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (data === "c") {
					const item = list.getSelectedItem();
					const exchange = item ? recent[Number(item.value)] : undefined;
					if (exchange) {
						void copyToClipboard(formatToolExchange(exchange))
							.then((command) => ctx.ui.notify(`Copied ${exchange.toolName} exchange with ${command}`, "info"))
							.catch((error) => ctx.ui.notify(`Could not copy to clipboard: ${String(error)}`, "error"));
					}
					return;
				}
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
	if (selected === null || selected === undefined) return;
	const exchange = recent[Number(selected)];
	if (!exchange) return;
	await showOrCopy(formatToolExchange(exchange), `Tool result: ${exchange.toolName}`, "show", ctx);
}

async function inspectTools(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Selecting tools requires UI mode.", "error");
		return;
	}
	const active = new Set(pi.getActiveTools());
	const tools = pi.getAllTools().sort((left, right) => left.name.localeCompare(right.name));
	if (tools.length === 0) {
		ctx.ui.notify("No tools are configured.", "warning");
		return;
	}
	const labels = tools.map((tool) => `${active.has(tool.name) ? "●" : "○"} ${tool.name}`);
	const selected = await ctx.ui.select("Select a tool", labels);
	if (!selected) return;
	const index = labels.indexOf(selected);
	const tool = index >= 0 ? tools[index] : undefined;
	if (!tool) return;
	await showOrCopy(formatToolInfo(tool, active.has(tool.name)), `Tool: ${tool.name}`, "show", ctx);
}

const HELP = `pi-inspect commands:
/inspect prompt [show|copy]  Inspect the current effective system prompt
/inspect result [show|copy]  Inspect the most recent finalized tool exchange
/inspect results             Select from recent finalized tool exchanges
/inspect tools               Inspect configured tool metadata and schemas`;

export function registerInspectExtension(pi: ExtensionAPI): void {
	let latestAssembledPrompt: string | undefined;

	pi.on("session_start", () => {
		latestAssembledPrompt = undefined;
	});

	// agent_start runs after every before_agent_start handler, so this captures the final chained Pi prompt.
	pi.on("agent_start", (_event, ctx) => {
		latestAssembledPrompt = ctx.getSystemPrompt();
	});

	pi.registerCommand("inspect", {
		description: "Inspect the system prompt, tools, or finalized tool exchanges",
		getArgumentCompletions: (prefix) => {
			const choices = ["prompt", "prompt copy", "result", "result copy", "results", "tools"];
			const matches = choices.filter((choice) => choice.startsWith(prefix));
			return matches.length > 0 ? matches.map((choice) => ({ value: choice, label: choice })) : null;
		},
		handler: async (rawArguments, ctx) => {
			const { subject, action } = parseArguments(rawArguments);
			switch (subject) {
				case "prompt":
					await ctx.waitForIdle();
					if (!latestAssembledPrompt) {
						ctx.ui.notify(
							"No agent turn has assembled the prompt since this session started; showing Pi's base prompt.",
							"warning",
						);
					}
					await showOrCopy(latestAssembledPrompt ?? ctx.getSystemPrompt(), "Current system prompt", action, ctx);
					return;
				case "result":
					await inspectResult(action, ctx);
					return;
				case "results":
					await inspectResults(ctx);
					return;
				case "tools":
					await inspectTools(pi, ctx);
					return;
				default:
					ctx.ui.notify(HELP, "info");
			}
		},
	});

	pi.registerCommand("system-prompt", {
		description: "Inspect or copy the current effective system prompt",
		handler: async (action, ctx) => {
			await ctx.waitForIdle();
			if (!latestAssembledPrompt) {
				ctx.ui.notify(
					"No agent turn has assembled the prompt since this session started; showing Pi's base prompt.",
					"warning",
				);
			}
			await showOrCopy(
				latestAssembledPrompt ?? ctx.getSystemPrompt(),
				"Current system prompt",
				action.trim().toLowerCase() || "show",
				ctx,
			);
		},
	});

	pi.registerCommand("tool-result", {
		description: "Inspect or copy the most recent finalized tool exchange",
		handler: async (action, ctx) => {
			await inspectResult(action.trim().toLowerCase() || "show", ctx);
		},
	});
}

export default function inspectExtension(pi: ExtensionAPI): void {
	registerInspectExtension(pi);
}
