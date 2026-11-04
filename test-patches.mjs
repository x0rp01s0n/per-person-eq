#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repo = process.env.PER_PERSON_EQ_VENCORD ?? resolve(root, ".vencord");
const require = createRequire(resolve(repo, "package.json"));
const { build } = require("esbuild");
const puppeteer = require("puppeteer-core");
const mocks = {
    "@api/ContextMenu": "export const findGroupChildrenByChildId=()=>[];",
    "@api/Settings": "export const definePluginSettings=()=>({store:{multiplier:2}});",
    "@utils/constants": "export const Devs={Nuckyz:{},sadan:{}};",
    "@utils/Logger": "export class Logger{error(...args){globalThis.__errors.push(args.map(String).join(' '))}}",
    "@utils/types": "export default x=>x;export const makeRange=()=>[];export const OptionType={SLIDER:0};",
    "@webpack/common": "export const Menu={};export const MediaEngineStore={getMediaEngine:()=>({connections:globalThis.__connections})};",
    "./profiles": "export const profileStore={get:id=>globalThis.__profiles[id],load:async cb=>{globalThis.__refresh=cb}};",
    "./Equalizer": "export const openEqualizer=()=>{};export const SavedEqualizers=()=>null;",
    "./style.css?managed": "export default '';"
};
const bundle = await build({
    stdin: { contents: `export {default as plugin} from ${JSON.stringify(resolve(root, "plugin/index.tsx"))};export {default as booster} from ${JSON.stringify(resolve(repo, "src/plugins/volumeBooster/index.ts"))};export * from ${JSON.stringify(resolve(root, "plugin/audio.ts"))};`, resolveDir: root },
    bundle: true, write: false, format: "iife", globalName: "Harness", platform: "browser", define: { IS_DISCORD_DESKTOP: "false" },
    plugins: [{ name: "isolated-discord", setup(build) {
        build.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: "mock" } : null);
        build.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: mocks[args.path] }));
    } }]
});

// A synthetic media output with the property anchors used by both plugins.
const fixture = `class Output{
constructor(id,context){this.id=id;this.audioContext=context;this.stream=new MediaStream;this.audioElement=null;this.streamSourceNode=null;this.levelNode=null;this._volume=100;this._mute=false;this.sinkId=null;this.videoStreamId=null}
destroy(){this.audioElement?.pause();this.streamSourceNode?.disconnect();this.levelNode?.disconnect()}
addTrack(track){if(this.stream.getTracks().includes(track))return 0;this.stream.addTrack(track);if(!this.audioElement){this.audioElement=document.createElement("audio");this.updateAudioElement()}if(!this.levelNode&&this.stream.getAudioTracks().length){this.streamSourceNode=this.audioContext.createMediaStreamSource(this.stream);this.levelNode=this.audioContext.createGain();this.streamSourceNode.connect(this.levelNode);}return"video"===track.kind?this.videoStreamId="camera":this.stream.getAudioTracks().forEach(other=>{if(other!==track)this.stream.removeTrack(other)})}
removeTrack(track){this.stream.removeTrack(track);return this.stream.getTracks().length}
set volume(v){this._volume=Math.max(0,Math.min(Math.round(v),100));this.updateAudioElement()}
updateAudioElement(){let element=this.audioElement;if(element){element.muted=this._mute;element.volume=this._volume/100;}}
};Output`;

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox", "--mute-audio", "--autoplay-policy=no-user-gesture-required"] });
try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.evaluate(() => { globalThis.__errors = []; globalThis.__profiles = {}; globalThis.__connections = []; });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(async fixture => {
        const passed = [];
        const assert = (condition, message) => { if (!condition) throw new Error(message); passed.push(message); };
        const { plugin, booster, defaultProfile } = Harness;
        globalThis.Vencord = { Plugins: { plugins: { PerPersonEQ: plugin, VolumeBooster: booster } } };
        const apply = (source, patch, name) => {
            for (const replacement of patch.replacement) {
                const match = new RegExp(replacement.match.source.replaceAll("\\i", "(?:[A-Za-z_$][\\w$]*)"), replacement.match.flags);
                if ([...source.matchAll(new RegExp(match.source, "g"))].length !== 1) throw new Error(`Nonunique patch: ${match}`);
                source = source.replace(match, replacement.replace.replaceAll("$self", `Vencord.Plugins.plugins.${name}`));
            }
            return source;
        };
        const eqPatch = plugin.patches[0];
        const vbPatch = booster.patches.find(patch => patch.find === "streamSourceNode");
        for (const order of ["standalone", "eq-first", "booster-first"]) {
            let source = fixture;
            if (order === "booster-first") source = apply(source, vbPatch, "VolumeBooster");
            source = apply(source, eqPatch, "PerPersonEQ");
            if (order === "eq-first") source = apply(source, vbPatch, "VolumeBooster");
            const Output = (0, eval)(source);
            const ctx = new AudioContext();
            const input = ctx.createOscillator();
            const destination = ctx.createMediaStreamDestination();
            const replacement = ctx.createMediaStreamDestination();
            input.connect(destination);
            input.connect(replacement);
            input.start();
            let sources = 0;
            let lastSource;
            const createSource = ctx.createMediaStreamSource.bind(ctx);
            ctx.createMediaStreamSource = stream => { sources++; return lastSource = createSource(stream); };
            const data = new Output("123456789012345678", ctx);
            const screen = new Output(data.id, ctx);
            globalThis.__connections = [{ context: "default", outputs: { [data.id]: data } }, { context: "stream", outputs: { [screen.id]: screen } }];
            const profile = globalThis.__profiles[data.id] = defaultProfile();
            plugin.start();
            data.addTrack(destination.stream.getAudioTracks()[0]);
            await Promise.resolve();
            assert(!data.gainNode === (order === "standalone"), `${order}: flat profile follows native or optional VolumeBooster routing`);
            profile.bands[5] = 6;
            globalThis.__refresh(data.id);
            await Promise.resolve();
            assert(plugin.onAudioUpdate(data) && data.audioElement.volume === 0, `${order}: independent EQ takes over voice playback`);
            data.videoStreamId = "camera";
            assert(plugin.onAudioUpdate(data), `${order}: webcam voice is still equalized`);
            assert(plugin.onAudioUpdate(screen) === false, `${order}: screen-share audio is excluded`);
            const count = sources;
            data.updateAudioElement();
            assert(sources === count, `${order}: repeated updates do not duplicate sources`);
            data._mute = true;
            data.updateAudioElement();
            assert(data.audioElement.muted, `${order}: mute reaches the output hook`);
            data._mute = false;
            data.volume = 250;
            assert(data._volume === (order === "standalone" ? 100 : 250), `${order}: VolumeBooster retains its slider-unclamping patch`);
            data.addTrack(replacement.stream.getAudioTracks()[0]);
            await Promise.resolve();
            assert(sources === count + 1, `${order}: replacing an audio track recreates only the EQ source`);
            data.removeTrack(replacement.stream.getAudioTracks()[0]);
            await Promise.resolve();
            assert(data.audioElement.volume === (order === "standalone" ? 1 : 0), `${order}: removing audio releases EQ to the original route`);
            data.addTrack(replacement.stream.getAudioTracks()[0]);
            await Promise.resolve();
            let disconnected = false;
            const disconnect = lastSource.disconnect.bind(lastSource);
            lastSource.disconnect = () => { disconnected = true; disconnect(); };
            data.destroy();
            assert(disconnected && !plugin.onAudioUpdate(data), `${order}: destroy disconnects the EQ source immediately`);
            const destroyedCount = sources;
            await Promise.resolve();
            assert(sources === destroyedCount, `${order}: queued track updates cannot revive destroyed outputs`);
            plugin.stop();
            input.stop();
            destination.stream.getTracks().forEach(track => track.stop());
            replacement.stream.getTracks().forEach(track => track.stop());
            await ctx.close();
        }
        assert(globalThis.__errors.length === 0, `No patch callback errors: ${globalThis.__errors.join(", ")}`);
        assert(plugin.authors[0].name === "null234" && !plugin.dependencies, "Author is null234 and no plugin dependency remains");
        return passed;
    }, fixture);
    result.forEach(name => console.log(`PASS ${name}`));
    // Optionally verify patch uniqueness against a locally captured current Discord factory.
    if (process.env.DISCORD_AUDIO_FIXTURE) {
        const captured = JSON.parse(await readFile(process.env.DISCORD_AUDIO_FIXTURE, "utf8"));
        const factories = Object.values(captured);
        const checks = await page.evaluate(factories => {
            const eqPatch = Harness.plugin.patches[0];
            const vbPatch = Harness.booster.patches.find(patch => patch.find === "streamSourceNode");
            const apply = (source, patch) => patch.replacement.reduce((source, replacement) => {
                const match = new RegExp(replacement.match.source.replaceAll("\\i", "(?:[A-Za-z_$][\\w$]*)"), replacement.match.flags);
                const count = [...source.matchAll(new RegExp(match.source, "g"))].length;
                if (count === 0 || (patch === eqPatch && count !== 1)) throw new Error(`Missing or nonunique current factory anchor: ${match}`);
                return source.replace(match, replacement.replace.replaceAll("$self", "Harness.plugin"));
            }, source);
            const matches = factories.filter(factory => factory.includes(eqPatch.find));
            if (matches.length !== 1) throw new Error("Audio module find is not unique");
            const source = matches[0];
            for (const patches of [[eqPatch], [eqPatch, vbPatch], [vbPatch, eqPatch]]) {
                const patched = patches.reduce(apply, source);
                new Function(`return ({${patched}})`);
            }
            return 3;
        }, factories);
        assert.equal(checks, 3);
        console.log("PASS Current captured Discord factory: all hooks unique and both VolumeBooster patch orders compile");
    }
    console.log(`${result.length} isolated integration checks passed.`);
} finally {
    await browser.close();
}
