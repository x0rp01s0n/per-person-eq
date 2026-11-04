/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 null234
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const FREQUENCIES = [31.5, 63, 125, 250, 500, 1000, 2000, 3000, 4000, 6000, 8000, 16000] as const;

export interface Profile {
    enabled: boolean;
    preamp: number;
    autoHeadroom: boolean;
    bands: number[];
}

export interface VoiceStream {
    id: string;
    audioContext: AudioContext;
    audioElement: HTMLAudioElement | null;
    gainNode?: GainNode;
    sinkId: string | null;
    stream: MediaStream;
    _mute: boolean;
    _volume: number;
    updateAudioElement(): void;
}

interface Route {
    source: MediaStreamAudioSourceNode;
    track: MediaStreamTrack;
    nativeGain?: GainNode;
    gain: GainNode;
    preamp: GainNode;
    filters: BiquadFilterNode[];
    meters: BiquadFilterNode[];
    headroom: number;
    signature: string;
}

interface OutputContext extends AudioContext {
    sinkId?: string;
    setSinkId?(sinkId: string): Promise<void>;
}

export function defaultProfile(): Profile {
    return { enabled: true, preamp: 0, autoHeadroom: true, bands: FREQUENCIES.map(() => 0) };
}

function bounded(value: unknown, min: number, max: number) {
    return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : 0;
}

export function normalizeProfile(value: Partial<Profile> | null | undefined): Profile {
    return {
        enabled: value?.enabled !== false,
        preamp: bounded(value?.preamp, -24, 0),
        autoHeadroom: value?.autoHeadroom !== false,
        bands: FREQUENCIES.map((_, i) => bounded(value?.bands?.[i], -12, 12))
    };
}

export function createFilters(context: BaseAudioContext) {
    return FREQUENCIES.map((frequency, i) => {
        const filter = context.createBiquadFilter();
        filter.type = i === 0 ? "lowshelf" : i === FREQUENCIES.length - 1 ? "highshelf" : "peaking";
        filter.frequency.value = Math.min(frequency, context.sampleRate * 0.49);
        const lower = Math.sqrt(FREQUENCIES[i - 1] * frequency);
        const upper = Math.sqrt(frequency * FREQUENCIES[i + 1]);
        if (filter.type === "peaking") filter.Q.value = frequency / (upper - lower);
        return filter;
    });
}

export function responseDb(filters: BiquadFilterNode[], sampleRate: number, count = 512) {
    const frequencies = Float32Array.from({ length: count }, (_, i) => 20 * (Math.min(24000, sampleRate * 0.499) / 20) ** (i / (count - 1)));
    const magnitude = new Float32Array(count);
    const phase = new Float32Array(count);
    const db = new Float32Array(count);
    for (const filter of filters) {
        filter.getFrequencyResponse(frequencies, magnitude, phase);
        for (let i = 0; i < count; i++) db[i] += 20 * Math.log10(Math.max(1e-12, magnitude[i]));
    }
    return db;
}

function smooth(parameter: AudioParam, value: number, context: BaseAudioContext) {
    parameter.cancelScheduledValues(context.currentTime);
    parameter.setTargetAtTime(value, context.currentTime, 0.015);
}

export function createEqualizer(getProfile: (userId: string) => Profile, reportError: (error: unknown) => void) {
    const streams = new Map<VoiceStream, string>();
    const routes = new Map<VoiceStream, Route>();
    const sinks = new WeakMap<AudioContext, { id: string; failed: boolean; pending?: Promise<void>; }>();

    function detach(data: VoiceStream, restore = true) {
        const route = routes.get(data);
        if (!route) return;
        routes.delete(data);
        try {
            route.source.disconnect();
            route.gain.disconnect();
            route.preamp.disconnect();
            route.filters.forEach(filter => filter.disconnect());
            if (restore && route.nativeGain && data.audioContext.state !== "closed") route.nativeGain.connect(data.audioContext.destination);
        } catch (error) {
            reportError(error);
        }
    }

    function outputReady(data: VoiceStream) {
        const context = data.audioContext as OutputContext;
        const id = data.sinkId === "default" || data.sinkId == null ? "" : data.sinkId;
        let sink = sinks.get(context);
        if (!sink?.pending && (context.sinkId === id || (!context.setSinkId && id === ""))) return "ready";
        if (!sink || sink.id !== id) {
            const previous = sink?.pending;
            sink = { id, failed: false };
            sinks.set(context, sink);
            if (!context.setSinkId) {
                sink.failed = true;
                reportError(new Error("Web Audio output-device selection is unavailable; leaving this stream on native playback."));
            } else {
                const selection = sink;
                // Serialize shared-context changes so an older request cannot win a device switch.
                selection.pending = (previous ?? Promise.resolve()).then(() => context.setSinkId!(id)).then(() => {
                    selection.pending = undefined;
                }).catch(error => {
                    selection.failed = true;
                    selection.pending = undefined;
                    reportError(error);
                }).then(() => {
                    if (sinks.get(context) !== selection) return;
                    for (const output of routes.keys()) {
                        if (output.audioContext !== context) continue;
                        try { output.updateAudioElement(); } catch (error) { reportError(error); }
                    }
                });
            }
        }
        return sink.failed ? "failed" : sink.pending ? "pending" : "ready";
    }

    function update(data: VoiceStream, userId: string) {
        const profile = normalizeProfile(getProfile(userId));
        const context = data.audioContext;
        const track = data.stream.getAudioTracks().find(track => track.readyState !== "ended");
        if (!profile.enabled || (profile.preamp === 0 && profile.bands.every(gain => gain === 0)) || !track || !data.audioElement || context.state === "closed") {
            detach(data);
            return false;
        }

        let route = routes.get(data);
        if (route && (route.track !== track || route.source.mediaStream !== data.stream)) {
            detach(data);
            route = undefined;
        }
        if (!route) {
            const source = context.createMediaStreamSource(data.stream);
            const gain = context.createGain();
            const preamp = context.createGain();
            const filters = createFilters(context);
            const meters = createFilters(context);
            gain.gain.value = 0;
            preamp.gain.value = 0;
            route = { source, track, gain, preamp, filters, meters, headroom: 0, signature: "" };
            routes.set(data, route);
            source.connect(gain);
            gain.connect(preamp);
            preamp.connect(filters[0]);
            filters.forEach((filter, i) => filter.connect(filters[i + 1] ?? context.destination));
            // VolumeBooster is optional. Suspend only its playback edge, never Discord's analyser.
            if (data.gainNode) {
                data.gainNode.disconnect(context.destination);
                route.nativeGain = data.gainNode;
            }
        }

        const output = outputReady(data);
        if (output === "failed") {
            detach(data);
            return false;
        }
        data.audioElement.volume = 0;
        data.audioElement.muted = data._mute;
        route.gain.gain.value = output === "ready" && !data._mute ? Math.max(0, data._volume) / 100 : 0;
        const signature = JSON.stringify(profile);
        if (route.signature === signature) return true;
        route.signature = signature;
        route.meters.forEach((filter, i) => filter.gain.value = profile.bands[i]);
        const peak = Math.max(0, ...responseDb(route.meters, context.sampleRate));
        route.headroom = profile.autoHeadroom && peak > 0 ? peak + 0.25 : 0;
        // Attenuate immediately before boosting filters, then ease toward the final gain.
        const gain = 10 ** ((profile.preamp - route.headroom) / 20);
        if (gain < route.preamp.gain.value) {
            route.preamp.gain.cancelScheduledValues(context.currentTime);
            route.preamp.gain.setValueAtTime(gain, context.currentTime);
        }
        route.filters.forEach((filter, i) => smooth(filter.gain, profile.bands[i], context));
        smooth(route.preamp.gain, gain, context);
        return true;
    }

    function observe(data: VoiceStream, userId: string) {
        streams.set(data, userId);
        try {
            return update(data, userId);
        } catch (error) {
            detach(data);
            reportError(error);
            return false;
        }
    }

    function forget(data: VoiceStream) {
        detach(data, false);
        streams.delete(data);
    }

    function prune(isCurrent: (data: VoiceStream) => boolean = () => true) {
        for (const data of streams.keys()) {
            if (!isCurrent(data)) {
                forget(data);
            } else if (data.audioContext.state === "closed" || !data.stream.active) {
                detach(data);
                streams.delete(data);
            }
        }
    }

    return {
        observe,
        forget,
        prune,
        status(userId: string) {
            const active = [...streams].filter(([data, id]) => id === userId && data.audioContext.state !== "closed" && data.stream.active);
            return { streams: active.length, headroom: Math.max(0, ...active.map(([data]) => routes.get(data)?.headroom ?? 0)) };
        },
        stop() {
            const active = [...routes.keys()];
            active.forEach(data => detach(data));
            streams.clear();
            for (const data of active) {
                try { data.updateAudioElement(); } catch (error) { reportError(error); }
            }
        }
    };
}
