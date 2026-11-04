#!/usr/bin/env node
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repo = process.env.PER_PERSON_EQ_VENCORD ?? join(root, ".vencord");
const config = process.env.PER_PERSON_EQ_CONFIG ?? join(homedir(), ".config/vesktop");
const stateFile = join(config, "state.json");
const dist = join(root, "dist");
const run = (command, args, cwd = repo) => execFileSync(command, args, { cwd, stdio: "inherit" });
const json = async file => JSON.parse(await readFile(file, "utf8"));

async function build(update) {
    if (!existsSync(join(repo, ".git"))) run("git", ["clone", "--depth", "1", "https://github.com/Vencord/Vencord.git", repo], root);
    else if (update) run("git", ["pull", "--ff-only"]);
    const pluginDir = join(repo, "src/userplugins/perPersonEQ.vesktop");
    await mkdir(pluginDir, { recursive: true });
    await cp(join(root, "plugin"), pluginDir, { recursive: true });
    run("pnpm", ["install", "--frozen-lockfile"]);
    run("pnpm", ["test:ts"]);
    run("pnpm", ["exec", "eslint", pluginDir]);
    run("pnpm", ["build", "--dev", "--disable-updater"]);
    const staging = join(root, "dist.staging");
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging);
    for (const file of await readdir(join(repo, "dist"))) {
        if (file.startsWith("vencordDesktop")) await cp(join(repo, "dist", file), join(staging, file));
    }
    await writeFile(join(staging, "package.json"), "{}\n");
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    await writeFile(join(staging, "build-info.json"), JSON.stringify({ builtAt: new Date().toISOString(), vencordCommit: commit, plugin: "PerPersonEQ", version: "0.1.0", updaterDisabled: true }, null, 2) + "\n");
    await rm(join(root, "dist.previous"), { recursive: true, force: true });
    try { await rename(dist, join(root, "dist.previous")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(staging, dist);
    console.log("Build ready. Fully restart Vesktop to use it.");
}

function requireClosed() {
    const running = execFileSync("flatpak", ["ps", "--columns=application"], { encoding: "utf8" });
    if (running.split("\n").includes("dev.vencord.Vesktop")) throw new Error("Fully quit Vesktop before changing its build location.");
}

async function activate() {
    requireClosed();
    for (const file of ["vencordDesktopMain.js", "vencordDesktopPreload.js", "vencordDesktopRenderer.js", "vencordDesktopRenderer.css"]) await readFile(join(dist, file));
    const state = await json(stateFile);
    const backup = join(root, "previous-location.json");
    try {
        await writeFile(backup, JSON.stringify({ config, vencordDir: state.vencordDir ?? null }, null, 2) + "\n", { flag: "wx" });
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    run("flatpak", ["override", "--user", `--filesystem=${root}:ro`, "dev.vencord.Vesktop"], root);
    state.vencordDir = dist;
    await writeFile(stateFile, JSON.stringify(state, null, 4) + "\n");
    console.log("Custom build activated. Start Vesktop normally.");
}

async function restore() {
    requireClosed();
    const previous = await json(join(root, "previous-location.json"));
    if (previous.config !== config) throw new Error("Backup belongs to another config directory.");
    const state = await json(stateFile);
    if (previous.vencordDir == null) delete state.vencordDir;
    else state.vencordDir = previous.vencordDir;
    await writeFile(stateFile, JSON.stringify(state, null, 4) + "\n");
    console.log("Previous Vencord location restored. Start Vesktop normally. EQ profiles were retained.");
}

try {
    switch (process.argv[2]) {
        case "build": await build(false); break;
        case "update": await build(true); break;
        case "activate": await activate(); break;
        case "restore": await restore(); break;
        default: console.log("Usage: node manage.mjs build|update|activate|restore");
    }
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
