#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repo = process.env.PER_PERSON_EQ_VENCORD ?? resolve(root, ".vencord");
const require = createRequire(resolve(repo, "package.json"));
const { build } = require("esbuild");
const puppeteer = require("puppeteer-core");
const bundle = await build({ entryPoints: [resolve(root, "plugin/audio.ts")], bundle: true, write: false, format: "iife", globalName: "EQ", platform: "browser" });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome-stable", headless: true, args: ["--no-sandbox", "--mute-audio", "--autoplay-policy=no-user-gesture-required"] });

try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(async () => {
        const passed = [];
        const assert = (condition, message) => { if (!condition) throw new Error(message); passed.push(message); };
        const { FREQUENCIES, defaultProfile, normalizeProfile, createFilters, responseDb, createEqualizer } = EQ;
        assert(FREQUENCIES.length === 12, "12 bands");
        const invalid = normalizeProfile({ bands: [Infinity, NaN, 99, -99], preamp: -100 });
        assert(invalid.bands[0] === 0 && invalid.bands[1] === 0 && invalid.bands[2] === 12 && invalid.bands[3] === -12 && invalid.bands.length === 12 && invalid.preamp === -24, "Profile validation and clamping");

        const context = new OfflineAudioContext(1, 24000, 48000);
        const filters = createFilters(context);
        assert(responseDb(filters, 48000).every(value => Math.abs(value) < 0.001), "Flat EQ has unity frequency response");
        filters[5].gain.value = 6;
        const magnitude = new Float32Array(1);
        filters[5].getFrequencyResponse(new Float32Array([1000]), magnitude, new Float32Array(1));
        assert(Math.abs(20 * Math.log10(magnitude[0]) - 6) < 0.01, "1 kHz band produces +6 dB at its centre");

        let profile = defaultProfile();
        profile.bands[5] = 6;
        let errors = [];
        const manager = createEqualizer(() => profile, error => errors.push(String(error)));
        const gain = context.createGain();
        gain.gain.value = 2;
        gain.connect(context.destination);
        const edges = new Set([context.destination]);
        const connect = gain.connect.bind(gain);
        const disconnect = gain.disconnect.bind(gain);
        gain.connect = destination => { const result = connect(destination); edges.add(destination); return result; };
        gain.disconnect = destination => { disconnect(destination); edges.delete(destination); };
        const data = { id: "123456789012345678", audioContext: context, gainNode: gain, stream: { active: true } };
        manager.observe(data, data.id);
        assert(edges.size === 1 && !edges.has(context.destination), "EQ replaces, rather than duplicates, the VolumeBooster output path");
        manager.observe(data, data.id);
        assert(edges.size === 1, "Repeated updates do not duplicate the audio path");
        assert(gain.gain.value === 2, "VolumeBooster gain remains untouched");
        assert(manager.status(data.id).headroom > 6 && manager.status(data.id).headroom < 6.4, "Auto headroom compensates the combined filter response");
        assert(manager.status("999999999999999999").streams === 0, "Profiles are isolated by user ID");
        profile.enabled = false;
        manager.refresh(data.id);
        assert(edges.size === 1 && edges.has(context.destination), "Bypass restores the original direct route");
        profile.enabled = true;
        manager.refresh(data.id);
        manager.stop();
        assert(edges.size === 1 && edges.has(context.destination), "Stopping restores VolumeBooster routing");
        assert(errors.length === 0, "Lifecycle runs without audio errors");

        const rms = buffer => Math.sqrt(buffer.slice(16000).reduce((sum, value) => sum + value * value, 0) / (buffer.length - 16000));
        async function render(profile, volume = 1) {
            const ctx = new OfflineAudioContext(1, 24000, 48000);
            const input = ctx.createOscillator();
            input.frequency.value = 1000;
            const gain = ctx.createGain();
            gain.gain.value = volume;
            input.connect(gain);
            gain.connect(ctx.destination);
            const eq = createEqualizer(() => profile, error => { throw error; });
            eq.observe({ id: data.id, audioContext: ctx, gainNode: gain, stream: { active: true } }, data.id);
            input.start();
            return rms((await ctx.startRendering()).getChannelData(0));
        }
        const flat = await render(defaultProfile());
        const boost = defaultProfile();
        boost.autoHeadroom = false;
        boost.bands[5] = 6;
        assert(Math.abs(20 * Math.log10(await render(boost) / flat) - 6) < 0.05, "Rendered audio confirms the EQ boost");
        boost.autoHeadroom = true;
        assert(await render(boost) <= flat, "Auto headroom prevents EQ-added peak gain in rendered audio");
        boost.enabled = false;
        assert(Math.abs(await render(boost) / flat - 1) < 0.001, "Rendered bypass is transparent");
        assert(await render(boost, 0) === 0, "VolumeBooster mute remains silent");
        return passed;
    });
    result.forEach(name => console.log(`PASS ${name}`));
    console.log(`${result.length} audio checks passed.`);
} finally {
    await browser.close();
}
