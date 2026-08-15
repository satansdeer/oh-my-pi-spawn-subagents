import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const CONFIG_FILENAMES = [".oh-my-pi.jsonc", ".oh-my-pi.json"] as const;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const SPAWN_ENV_FLAG = "OH_MY_PI_SPAWN_SUBAGENT_CHILD";
const PI_BIN_ENV = "OH_MY_PI_SPAWN_PI_BIN";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

type SpawnMode = "pi-print";

interface SpawnConfig {
	enabled?: boolean;
	mode?: SpawnMode;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
	tools?: string[];
	excludeTools?: string[];
	cwd?: "inherit" | string;
	timeoutMs?: number;
	includeContextFiles?: boolean;
	includeSkills?: boolean;
	includeExtensions?: boolean;
	includeOhMyPiPrompt?: boolean;
	extraArgs?: string[];
	env?: Record<string, string>;
	piCommand?: string;
	noSession?: boolean;
}

interface AgentConfig {
	name?: string;
	description?: string;
	model?: string;
	variant?: "max" | "high" | "medium" | "low";
	thinking?: number;
	skills?: string[];
	temperature?: number;
	systemPrompt?: string;
	systemPromptAppend?: string;
	enabled?: boolean;
	spawn?: SpawnConfig;
}

interface CategoryConfig {
	name?: string;
	description?: string;
	model?: string;
	variant?: "max" | "high" | "medium" | "low";
	thinking?: number;
	skills?: string[];
	spawn?: SpawnConfig;
}

interface OhMyPiConfig {
	agents?: Record<string, AgentConfig>;
	categories?: Record<string, CategoryConfig>;
	orchestrator?: {
		agentName?: string;
		defaultModel?: string;
		promptTemplate?: "sisyphus" | "minimal";
		disabledAgents?: string[];
		disabledSkills?: string[];
	};
	logging?: { level?: "debug" | "info" | "warn" | "error" };
}

interface ResolvedAgent {
	name: string;
	description: string;
	model?: string | undefined;
	variant?: "max" | "high" | "medium" | "low" | undefined;
	thinking?: number | undefined;
	skills?: string[] | undefined;
	systemPrompt?: string | undefined;
	systemPromptAppend?: string | undefined;
	enabled: boolean;
	spawn?: SpawnConfig | undefined;
}

interface SpawnResultDetails {
	agent: string;
	spawned: boolean;
	command?: string;
	args?: string[];
	cwd?: string;
	exitCode?: number | null;
	timedOut?: boolean;
	stdout?: string;
	stderr?: string;
	fallback?: "persona";
}

const BuiltinAgents: Record<string, ResolvedAgent> = {
	oracle: {
		name: "oracle",
		description:
			"Read-only high-IQ consultant for architecture design, hard debugging, and multi-system tradeoffs. Use when stuck on complex decisions.",
		variant: "max",
		thinking: 0.9,
		enabled: true,
	},
	librarian: {
		name: "librarian",
		description:
			"Multi-repository research specialist. Finds documentation, usage examples, and open-source implementations. Use for unfamiliar libraries and APIs.",
		variant: "medium",
		enabled: true,
	},
	explore: {
		name: "explore",
		description:
			"Fast contextual grep specialist for codebase exploration. Answers 'Where is X?' and 'Which file has Y?' questions.",
		variant: "low",
		enabled: true,
	},
	"sisyphus-junior": {
		name: "sisyphus-junior",
		description:
			"Focused task executor. Same discipline, no delegation. Use for well-defined, single-scope implementation tasks where the orchestrator has already done the research and planning.",
		variant: "medium",
		thinking: 0.3,
		enabled: true,
	},
	metis: {
		name: "metis",
		description:
			"Pre-planning consultant that analyzes requests to identify hidden intentions, ambiguities, and AI failure points. Use before complex tasks where scope is unclear.",
		variant: "max",
		thinking: 0.8,
		enabled: true,
	},
	momus: {
		name: "momus",
		description:
			"Expert reviewer for evaluating work plans against rigorous clarity, verifiability, and completeness standards. Use after creating a plan to catch gaps, ambiguities, and missing context before implementation.",
		variant: "max",
		thinking: 0.8,
		enabled: true,
	},
	"multimodal-looker": {
		name: "multimodal-looker",
		description:
			"Analyze media files (PDFs, images, diagrams) that require interpretation beyond raw text. Extracts specific information or summaries from documents, describes visual content.",
		variant: "medium",
		thinking: 0.2,
		enabled: true,
	},
};

const SpawnSubagentParams = Type.Object({
	agent: Type.String({ description: "Configured oh-my-pi agent to run" }),
	task: Type.String({ description: "Task for the spawned subagent" }),
	model: Type.Optional(Type.String({ description: "One-off model override for this invocation" })),
	provider: Type.Optional(Type.String({ description: "One-off provider override" })),
	thinking: Type.Optional(
		Type.Union([
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("xhigh"),
			Type.Literal("max"),
		]),
	),
});

type SpawnSubagentParams = Static<typeof SpawnSubagentParams>;

export default function ohMyPiSpawnSubagents(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		if (process.env[SPAWN_ENV_FLAG] === "1") return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n<oh-my-pi-spawn-subagents>\nWhen an oh-my-pi agent has spawn.enabled=true, prefer the oh_my_pi_spawn_subagent tool over oh_my_pi_subagent so the specialist runs in a real isolated Pi subprocess with its configured provider/model. Use oh_my_pi_subagent only as a fallback for persona-only agents.\n</oh-my-pi-spawn-subagents>`,
		};
	});

	pi.registerTool({
		name: "oh_my_pi_spawn_subagent",
		label: "Spawn oh-my-pi Subagent",
		description:
			"Run an oh-my-pi configured specialist agent in a real nested `pi -p` subprocess using spawn settings from .oh-my-pi.jsonc. Falls back to persona text when spawn is disabled.",
		promptSnippet: "Run configured oh-my-pi agents as real subprocess subagents",
		promptGuidelines: [
			"Use oh_my_pi_spawn_subagent when an oh-my-pi agent has spawn.enabled=true",
			"The tool reads the same ~/.pi/oh-my-pi.jsonc and project .oh-my-pi.jsonc files as oh-my-pi",
			"Set agents.<name>.spawn.provider/model/thinking/tools in .oh-my-pi.jsonc to control the child Pi process",
		],
		parameters: SpawnSubagentParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const config = loadConfig(ctx.cwd);
			const agent = resolveAgent(config, params.agent);
			if (!agent) {
				return {
					content: [{ type: "text", text: `Unknown agent "${params.agent}".` }],
					details: { agent: params.agent, spawned: false } satisfies SpawnResultDetails,
					isError: true,
				};
			}
			if (!agent.enabled) {
				return {
					content: [{ type: "text", text: `Agent "${params.agent}" is disabled.` }],
					details: { agent: params.agent, spawned: false } satisfies SpawnResultDetails,
					isError: true,
				};
			}

			const spawnConfig = agent.spawn;
			if (!spawnConfig?.enabled) {
				const persona = buildPersona(agent, params.task);
				return {
					content: [{ type: "text", text: persona }],
					details: { agent: agent.name, spawned: false, fallback: "persona" } satisfies SpawnResultDetails,
				};
			}

			const run = await runSpawnedAgent(ctx, agent, params, signal);
			return {
				content: [{ type: "text", text: run.stdout || run.stderr || "(no output)" }],
				details: run,
				isError: run.exitCode !== 0 || run.timedOut,
			};
		},
	});
}

export function loadConfig(cwd: string, home = homedir()): OhMyPiConfig {
	let config: OhMyPiConfig = {};
	for (const file of [join(home, ".pi", "oh-my-pi.jsonc"), join(home, ".pi", "oh-my-pi.json")]) {
		config = mergeConfig(config, readConfigIfExists(file));
	}
	for (const name of CONFIG_FILENAMES) {
		config = mergeConfig(config, readConfigIfExists(join(cwd, name)));
	}
	return config;
}

function readConfigIfExists(file: string): OhMyPiConfig {
	if (!existsSync(file)) return {};
	const text = readFileSync(file, "utf8");
	return JSON.parse(stripJsonc(text)) as OhMyPiConfig;
}

export function resolveAgent(config: OhMyPiConfig, name: string): ResolvedAgent | undefined {
	const disabled = new Set(config.orchestrator?.disabledAgents ?? []);
	const builtin = BuiltinAgents[name];
	const override = config.agents?.[name];
	if (!builtin && !override) return undefined;
	const merged: ResolvedAgent = {
		name,
		description: override?.description ?? builtin?.description ?? "",
		model: override?.model ?? builtin?.model,
		variant: override?.variant ?? builtin?.variant,
		thinking: override?.thinking ?? builtin?.thinking,
		skills: override?.skills ?? builtin?.skills,
		systemPrompt: override?.systemPrompt ?? builtin?.systemPrompt,
		systemPromptAppend: override?.systemPromptAppend ?? builtin?.systemPromptAppend,
		enabled: (override?.enabled ?? builtin?.enabled ?? true) && !disabled.has(name),
		spawn: mergeSpawnConfig(builtin?.spawn, override?.spawn),
	};
	return merged;
}

async function runSpawnedAgent(
	ctx: ExtensionContext,
	agent: ResolvedAgent,
	params: SpawnSubagentParams,
	signal: AbortSignal | undefined,
): Promise<SpawnResultDetails> {
	const spawnConfig = agent.spawn ?? {};
	const piCommand = spawnConfig.piCommand ?? process.env[PI_BIN_ENV] ?? "pi";
	const provider = params.provider ?? spawnConfig.provider;
	const model = params.model ?? spawnConfig.model ?? agent.model;
	const thinking = params.thinking ?? spawnConfig.thinking;
	const cwd = resolveSpawnCwd(ctx.cwd, spawnConfig.cwd);
	const args = buildPiArgs(spawnConfig, provider, model, thinking, buildSpawnPrompt(agent, params.task));
	const env = {
		...process.env,
		...spawnConfig.env,
		[SPAWN_ENV_FLAG]: "1",
	};
	const timeoutMs = spawnConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return new Promise<SpawnResultDetails>((resolveResult) => {
		const child = spawn(piCommand, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveResult({
				agent: agent.name,
				spawned: true,
				command: piCommand,
				args,
				cwd,
				exitCode,
				timedOut,
				stdout: truncate(stdout),
				stderr: truncate(stderr),
			});
		};

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!child.killed) child.kill("SIGKILL");
			}, 5_000).unref();
		}, timeoutMs);
		timer.unref();

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			stderr += error instanceof Error ? error.message : String(error);
			finish(1);
		});
		child.on("close", (code) => finish(timedOut ? 124 : code));

		if (signal) {
			const abort = () => {
				timedOut = false;
				child.kill("SIGTERM");
			};
			if (signal.aborted) abort();
			else signal.addEventListener("abort", abort, { once: true });
		}
	});
}

export function buildPiArgs(
	spawnConfig: SpawnConfig,
	provider: string | undefined,
	model: string | undefined,
	thinking: ThinkingLevel | undefined,
	prompt: string,
): string[] {
	const args = ["-p"];
	if (spawnConfig.noSession !== false) args.push("--no-session");
	if (spawnConfig.includeContextFiles === false) args.push("--no-context-files");
	if (spawnConfig.includeSkills === false) args.push("--no-skills");
	if (spawnConfig.includeExtensions === false || spawnConfig.includeOhMyPiPrompt === false) args.push("--no-extensions");
	if (provider) args.push("--provider", provider);
	if (model) args.push("--model", model);
	if (thinking) args.push("--thinking", thinking);
	if (spawnConfig.tools && spawnConfig.tools.length > 0) args.push("--tools", spawnConfig.tools.join(","));
	if (spawnConfig.excludeTools && spawnConfig.excludeTools.length > 0) {
		args.push("--exclude-tools", spawnConfig.excludeTools.join(","));
	}
	if (spawnConfig.extraArgs) args.push(...spawnConfig.extraArgs);
	args.push(prompt);
	return args;
}

function buildSpawnPrompt(agent: ResolvedAgent, task: string): string {
	return [
		`You are the oh-my-pi ${agent.name} specialist.`,
		`Role: ${agent.description}`,
		agent.variant ? `Variant: ${agent.variant}` : "",
		agent.thinking !== undefined ? `Thinking depth hint: ${agent.thinking}` : "",
		agent.skills?.length ? `Skills: ${agent.skills.join(", ")}` : "",
		agent.systemPrompt ? `\nSystem instructions:\n${agent.systemPrompt}` : "",
		agent.systemPromptAppend ? `\nAdditional instructions:\n${agent.systemPromptAppend}` : "",
		"",
		"Return only the specialist result. Be concise, concrete, and cite files or commands when relevant.",
		"",
		`Task:\n${task}`,
	]
		.filter(Boolean)
		.join("\n");
}

function buildPersona(agent: ResolvedAgent, task: string): string {
	const variant = agent.variant ?? "medium";
	const thinking = agent.thinking !== undefined ? ` (thinking depth: ${agent.thinking})` : "";
	return [
		`## Activated Specialist: ${agent.name} [${variant}${thinking}]`,
		"",
		`**Role**: ${agent.description}`,
		agent.skills?.length ? `**Skills**: ${agent.skills.join(", ")}` : "",
		"",
		"---",
		"",
		`**Task**: ${task}`,
	].filter(Boolean).join("\n");
}

function resolveSpawnCwd(currentCwd: string, configured: SpawnConfig["cwd"]): string {
	if (!configured || configured === "inherit") return currentCwd;
	return isAbsolute(configured) ? configured : resolve(currentCwd, configured);
}

function mergeConfig(base: OhMyPiConfig, override: OhMyPiConfig): OhMyPiConfig {
	return deepMerge(base, override) as OhMyPiConfig;
}

function mergeSpawnConfig(base: SpawnConfig | undefined, override: SpawnConfig | undefined): SpawnConfig | undefined {
	if (!base) return override;
	if (!override) return base;
	return deepMerge(base, override) as SpawnConfig;
}

function deepMerge(base: unknown, override: unknown): unknown {
	if (override === undefined) return base;
	if (Array.isArray(base) && Array.isArray(override)) return override;
	if (isPlainObject(base) && isPlainObject(override)) {
		const result: Record<string, unknown> = { ...base };
		for (const [key, value] of Object.entries(override)) {
			result[key] = deepMerge(result[key], value);
		}
		return result;
	}
	return override;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripJsonc(text: string): string {
	let output = "";
	let inString = false;
	let quote = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		const next = text[i + 1];
		if (inString) {
			output += ch;
			if (ch === "\\") {
				if (next !== undefined) output += next;
				i++;
			} else if (ch === quote) {
				inString = false;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			inString = true;
			quote = ch;
			output += ch;
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			output += "\n";
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++;
			continue;
		}
		output += ch;
	}
	return output.replace(/,\s*([}\]])/g, "$1");
}

function truncate(value: string): string {
	if (Buffer.byteLength(value, "utf8") <= MAX_OUTPUT_BYTES) return value;
	let sliced = value.slice(0, MAX_OUTPUT_BYTES);
	while (Buffer.byteLength(sliced, "utf8") > MAX_OUTPUT_BYTES) sliced = sliced.slice(0, -1);
	return `${sliced}\n\n[truncated to ${MAX_OUTPUT_BYTES} bytes]`;
}
