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

        const track = { readyState: "live" };
        const errors = [];
        const profile = defaultProfile();
        profile.bands[5] = 6;
        const other = defaultProfile();
        const manager = createEqualizer(id => id === "123456789012345678" ? profile : other, error => errors.push(String(error)));
        const ctx = new AudioContext();
        const oscillator = ctx.createOscillator();
        const destination = ctx.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        const sources = [];
        const gains = [];
        const createSource = ctx.createMediaStreamSource.bind(ctx);
        ctx.createMediaStreamSource = stream => { const source = createSource(stream); sources.push(source); return source; };
        const createGain = ctx.createGain.bind(ctx);
        ctx.createGain = () => { const gain = createGain(); gains.push(gain); return gain; };
        let running = true;
        const makeData = id => ({ id, audioContext: ctx, stream: destination.stream, audioElement: document.createElement("audio"), sinkId: "default", _volume: 50, _mute: false,
            updateAudioElement() {
                if (running && manager.observe(this, this.id)) return;
                this.audioElement.volume = Math.min(1, this._volume / 100);
                this.audioElement.muted = this._mute;
            }
        });
        const data = makeData("123456789012345678");
        data.updateAudioElement();
        assert(sources.length === 1 && !data.gainNode && data.audioElement.volume === 0, "Standalone EQ owns playback without VolumeBooster");
        data.updateAudioElement();
        assert(sources.length === 1, "Repeated updates reuse the same source");
        assert(gains[0].gain.value === 0.5, "Standalone user volume is preserved");
        data._mute = true;
        data.updateAudioElement();
        assert(gains[0].gain.value === 0, "Mute and deafen silence the independent route");
        data._mute = false;
        data._volume = 250;
        data.updateAudioElement();
        assert(gains[0].gain.value === 2.5, "Boosted volume is respected when VolumeBooster is present");
        assert(manager.status(data.id).headroom > 6 && manager.status(data.id).headroom < 6.4, "Auto headroom compensates the combined filter response");
        const second = makeData("999999999999999999");
        second.updateAudioElement();
        assert(second.audioElement.volume === 0.5 && sources.length === 1, "Another user's flat profile stays on native playback");
        profile.enabled = false;
        data.updateAudioElement();
        assert(data.audioElement.volume === 1, "Bypass restores the native audio element");
        profile.enabled = true;

        const nativeGain = data.gainNode = ctx.createGain();
        nativeGain.gain.value = 2.5;
        nativeGain.connect(ctx.destination);
        const edges = new Set([ctx.destination]);
        const connect = nativeGain.connect.bind(nativeGain);
        const disconnect = nativeGain.disconnect.bind(nativeGain);
        nativeGain.connect = target => { const result = connect(target); edges.add(target); return result; };
        nativeGain.disconnect = target => { disconnect(target); edges.delete(target); };
        data.updateAudioElement();
        assert(edges.size === 0 && nativeGain.gain.value === 2.5, "Existing VolumeBooster playback is suspended without changing its gain");
        profile.enabled = false;
        data.updateAudioElement();
        assert(edges.has(ctx.destination), "Bypass restores VolumeBooster's output edge");
        profile.enabled = true;
        data.updateAudioElement();
        running = false;
        manager.stop();
        assert(edges.size === 1 && edges.has(ctx.destination) && data.audioElement.volume === 1, "Stop releases own route and restores native playback");
        assert(manager.status(data.id).streams === 0, "Stop drops observed streams");
        assert(errors.length === 0, "Standalone and optional-VolumeBooster lifecycles have no audio errors");
        oscillator.stop();
        destination.stream.getTracks().forEach(track => track.stop());
        await ctx.close();

        // OfflineAudioContext cannot accept MediaStreams; adapt only its source factory.
        const rms = buffer => Math.sqrt(buffer.slice(16000).reduce((sum, value) => sum + value * value, 0) / (buffer.length - 16000));
        async function render(profile, volume = 100, muted = false) {
            const ctx = new OfflineAudioContext(1, 24000, 48000);
            const input = ctx.createOscillator();
            input.frequency.value = 1000;
            const native = ctx.createGain();
            native.gain.value = muted ? 0 : volume / 100;
            input.connect(native);
            native.connect(ctx.destination);
            ctx.createMediaStreamSource = stream => {
                const source = ctx.createGain();
                Object.defineProperty(source, "mediaStream", { value: stream });
                input.connect(source);
                return source;
            };
            const eq = createEqualizer(() => profile, error => { throw error; });
            const active = eq.observe({ id: data.id, audioContext: ctx, audioElement: { volume: 1 }, sinkId: "default", _volume: volume, _mute: muted, stream: { active: true, getAudioTracks: () => [track] } }, data.id);
            if (active) native.disconnect();
            input.start();
            return rms((await ctx.startRendering()).getChannelData(0));
        }
        const flat = await render(defaultProfile());
        const boost = defaultProfile();
        boost.autoHeadroom = false;
        boost.bands[5] = 6;
        assert(Math.abs(20 * Math.log10(await render(boost) / flat) - 6) < 0.05, "Rendered standalone audio confirms +6 dB EQ boost");
        boost.autoHeadroom = true;
        assert(await render(boost) <= flat, "Auto headroom prevents EQ-added peak gain in rendered audio");
        boost.enabled = false;
        assert(Math.abs(await render(boost) / flat - 1) < 0.001, "Rendered bypass is transparent");
        boost.enabled = true;
        assert(await render(boost, 100, true) === 0, "Rendered EQ audio stays silent when muted");
        assert(Math.abs(await render(boost, 50) / await render(boost) - 0.5) < 0.001, "Rendered EQ retains per-person volume");

        const deviceContext = new OfflineAudioContext(1, 24000, 48000);
        const deviceGains = [];
        const deviceGain = deviceContext.createGain.bind(deviceContext);
        deviceContext.createGain = () => { const node = deviceGain(); deviceGains.push(node); return node; };
        deviceContext.createMediaStreamSource = stream => {
            const node = deviceGain();
            Object.defineProperty(node, "mediaStream", { value: stream });
            return node;
        };
        const selections = [];
        const deviceErrors = [];
        let release;
        deviceContext.sinkId = "";
        deviceContext.setSinkId = id => new Promise((resolve, reject) => {
            selections.push(id);
            release = success => { if (success) { deviceContext.sinkId = id; resolve(); } else reject(new Error("Device denied")); };
        });
        const devices = createEqualizer(() => boost, error => deviceErrors.push(String(error)));
        const makeDevice = id => ({ id, audioContext: deviceContext, audioElement: { volume: 1 }, sinkId: "headphones", _volume: 100, _mute: false, stream: { active: true, getAudioTracks: () => [track] },
            updateAudioElement() { if (!devices.observe(this, this.id)) this.audioElement.volume = 1; }
        });
        const firstDevice = makeDevice(data.id);
        const secondDevice = makeDevice(second.id);
        firstDevice.updateAudioElement();
        secondDevice.updateAudioElement();
        await new Promise(resolve => setTimeout(resolve, 0));
        assert(deviceGains[0].gain.value === 0 && deviceGains[2].gain.value === 0 && selections.length === 1, "Shared output-device changes stay silent until selection completes");
        release(true);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert(deviceGains[0].gain.value === 1 && deviceGains[2].gain.value === 1, "Device selection resumes every EQ on the shared context");
        firstDevice.sinkId = secondDevice.sinkId = "older-device";
        firstDevice.updateAudioElement();
        secondDevice.updateAudioElement();
        await new Promise(resolve => setTimeout(resolve, 0));
        firstDevice.sinkId = secondDevice.sinkId = "newer-device";
        firstDevice.updateAudioElement();
        secondDevice.updateAudioElement();
        release(true);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert(deviceGains[0].gain.value === 0 && selections.at(-1) === "newer-device", "A superseded output-device request cannot resume playback on the old device");
        release(true);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert(deviceContext.sinkId === "newer-device" && deviceGains[0].gain.value === 1 && deviceGains[2].gain.value === 1, "The newest output-device request wins for all EQ routes");
        firstDevice.sinkId = secondDevice.sinkId = "missing-device";
        firstDevice.updateAudioElement();
        secondDevice.updateAudioElement();
        await new Promise(resolve => setTimeout(resolve, 0));
        release(false);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert(firstDevice.audioElement.volume === 1 && secondDevice.audioElement.volume === 1 && deviceErrors.length === 1, "Rejected output-device selection falls back to native playback without unhandled rejection");
        devices.forget(firstDevice);
        devices.forget(secondDevice);

        delete deviceContext.setSinkId;
        deviceContext.sinkId = "";
        const unsupported = createEqualizer(() => boost, error => deviceErrors.push(String(error)));
        assert(unsupported.observe(firstDevice, firstDevice.id) === false, "Unsupported non-default output-device selection retains native playback");
        unsupported.stop();

        const lifecycleErrors = [];
        const lifecycle = createEqualizer(() => boost, error => lifecycleErrors.push(String(error)));
        const lifecycleGain = deviceGain();
        lifecycleGain.connect(deviceContext.destination);
        let restored = 0;
        const restore = lifecycleGain.connect.bind(lifecycleGain);
        lifecycleGain.connect = target => { restored++; return restore(target); };
        const inactive = { ...firstDevice, sinkId: "default", gainNode: lifecycleGain, stream: { active: true, getAudioTracks: () => [track] } };
        lifecycle.observe(inactive, inactive.id);
        inactive.stream.active = false;
        lifecycle.prune(() => true);
        assert(restored === 1 && lifecycle.status(inactive.id).streams === 0, "Pruning an inactive but reusable output restores its optional native gain");
        inactive.stream.active = true;
        lifecycle.observe(inactive, inactive.id);
        lifecycle.forget(inactive);
        assert(restored === 1, "Destroyed outputs are disconnected without reviving native playback");
        deviceContext.createMediaStreamSource = () => { throw new Error("Simulated source failure"); };
        assert(lifecycle.observe(inactive, inactive.id) === false && lifecycleErrors.length === 1, "Audio-source failures return control to Discord instead of throwing through its update method");
        lifecycle.stop();
        return passed;
    });
    result.forEach(name => console.log(`PASS ${name}`));
    console.log(`${result.length} audio checks passed.`);
} finally {
    await browser.close();
}
