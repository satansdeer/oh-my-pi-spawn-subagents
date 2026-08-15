import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import extension, { buildPiArgs, loadConfig, resolveAgent } from "../src/index.ts";

interface RegisteredTool {
	name: string;
	execute: (...args: any[]) => Promise<any>;
}

const tempDirs: string[] = [];

function tempProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "omp-spawn-test-"));
	tempDirs.push(dir);
	return dir;
}

function registerExtension(): RegisteredTool {
	let tool: RegisteredTool | undefined;
	const fakePi = {
		on() {},
		registerTool(def: RegisteredTool) {
			if (def.name === "oh_my_pi_spawn_subagent") tool = def;
		},
	} as any;
	extension(fakePi);
	if (!tool) throw new Error("tool was not registered");
	return tool;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	delete process.env.OH_MY_PI_SPAWN_PI_BIN;
	delete process.env.FAKE_PI_LOG;
	delete process.env.FAKE_PI_EXIT;
});

describe("config loading", () => {
	it("loads project .oh-my-pi.jsonc and resolves spawn config for a built-in agent", () => {
		const cwd = tempProject();
		writeFileSync(
			join(cwd, ".oh-my-pi.jsonc"),
			`{
        // comments and trailing commas are accepted
        "agents": {
          "oracle": {
            "model": "openrouter/qwen/qwen3.8-max",
            "spawn": {
              "enabled": true,
              "provider": "openrouter",
              "model": "qwen/qwen3.8-max",
            },
          },
        },
      }`,
		);

		const config = loadConfig(cwd, join(cwd, "no-home"));
		const oracle = resolveAgent(config, "oracle");

		expect(oracle?.description.toLowerCase()).toContain("architecture");
		expect(oracle?.model).toBe("openrouter/qwen/qwen3.8-max");
		expect(oracle?.spawn?.enabled).toBe(true);
		expect(oracle?.spawn?.provider).toBe("openrouter");
	});
});

describe("argument construction", () => {
	it("builds isolated pi print args from spawn settings", () => {
		const args = buildPiArgs(
			{
				includeContextFiles: false,
				includeSkills: false,
				includeOhMyPiPrompt: false,
				tools: ["read", "grep"],
				excludeTools: ["bash"],
				extraArgs: ["--append-system-prompt", "extra"],
			},
			"openrouter",
			"qwen/qwen3.8-max",
			"high",
			"Task body",
		);

		expect(args).toEqual([
			"-p",
			"--no-session",
			"--no-context-files",
			"--no-skills",
			"--no-extensions",
			"--provider",
			"openrouter",
			"--model",
			"qwen/qwen3.8-max",
			"--thinking",
			"high",
			"--tools",
			"read,grep",
			"--exclude-tools",
			"bash",
			"--append-system-prompt",
			"extra",
			"Task body",
		]);
	});
});

describe("integration: spawned subagent subprocess", () => {
	it("executes fake pi with configured provider/model/tools/cwd/env", async () => {
		const cwd = tempProject();
		const childCwd = join(cwd, "child");
		const logPath = join(cwd, "fake-pi.log");
		writeFileSync(join(cwd, ".oh-my-pi.jsonc"), JSON.stringify({
			agents: {
				explore: {
					spawn: {
						enabled: true,
						piCommand: join(process.cwd(), "test/fixtures/fake-bin/pi"),
						provider: "openrouter",
						model: "qwen/qwen3.8-max",
						thinking: "low",
						tools: ["read", "grep", "glob"],
						cwd: "child",
						includeOhMyPiPrompt: false,
						env: { FAKE_PI_LOG: logPath, SPAWN_TEST_VALUE: "present" },
					},
				},
			},
		}, null, 2));
		// create child cwd after config write
		await import("node:fs").then((fs) => fs.mkdirSync(childCwd));

		const tool = registerExtension();
		const result = await tool.execute("tool-call", { agent: "explore", task: "Find routing code" }, undefined, undefined, {
			cwd,
		} as any);

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("fake pi ran");
		const log = JSON.parse(readFileSync(logPath, "utf8").trim());
		expect(realpathSync(log.cwd)).toBe(realpathSync(childCwd));
		expect(log.childFlag).toBe("1");
		expect(log.customEnv).toBe("present");
		expect(log.args).toContain("--provider");
		expect(log.args).toContain("openrouter");
		expect(log.args).toContain("--model");
		expect(log.args).toContain("qwen/qwen3.8-max");
		expect(log.args).toContain("--tools");
		expect(log.args).toContain("read,grep,glob");
		expect(log.args).toContain("--no-extensions");
	});

	it("falls back to persona mode when spawn is disabled", async () => {
		const cwd = tempProject();
		const tool = registerExtension();
		const result = await tool.execute("tool-call", { agent: "oracle", task: "Assess this plan" }, undefined, undefined, {
			cwd,
		} as any);

		expect(result.details.spawned).toBe(false);
		expect(result.details.fallback).toBe("persona");
		expect(result.content[0].text).toContain("Activated Specialist: oracle");
	});

	it("returns an error result when child pi exits non-zero", async () => {
		const cwd = tempProject();
		writeFileSync(join(cwd, ".oh-my-pi.jsonc"), JSON.stringify({
			agents: {
				oracle: {
					spawn: {
						enabled: true,
						piCommand: join(process.cwd(), "test/fixtures/fake-bin/pi"),
						env: { FAKE_PI_EXIT: "42" },
					},
				},
			},
		}));

		const tool = registerExtension();
		const result = await tool.execute("tool-call", { agent: "oracle", task: "Fail" }, undefined, undefined, { cwd } as any);

		expect(result.isError).toBe(true);
		expect(result.details.exitCode).toBe(42);
	});
});
