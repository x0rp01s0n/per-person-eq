/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 PerPersonEQ contributors
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
    videoStreamId?: string | null;
    audioContext: AudioContext;
    gainNode?: GainNode;
    stream: MediaStream;
}

interface Route {
    data: VoiceStream;
    userId: string;
    gain: GainNode;
    preamp: GainNode;
    filters: BiquadFilterNode[];
    meters: BiquadFilterNode[];
    headroom: number;
    signature: string;
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

    function detach(data: VoiceStream) {
        const route = routes.get(data);
        if (!route) return;
        routes.delete(data);
        try {
            route.gain.disconnect(route.preamp);
            route.preamp.disconnect();
            route.filters.forEach(filter => filter.disconnect());
            if (data.audioContext.state !== "closed") route.gain.connect(data.audioContext.destination);
        } catch (error) {
            reportError(error);
        }
    }

    function update(data: VoiceStream, userId: string) {
        const profile = normalizeProfile(getProfile(userId));
        const context = data.audioContext;
        if (!profile.enabled || (profile.preamp === 0 && profile.bands.every(gain => gain === 0))) {
            detach(data);
            return;
        }
        if (!data.gainNode || context.state === "closed") return;

        let route = routes.get(data);
        if (route && route.gain !== data.gainNode) {
            detach(data);
            route = undefined;
        }
        if (!route) {
            const preamp = context.createGain();
            const filters = createFilters(context);
            const meters = createFilters(context);
            preamp.gain.value = 0;
            preamp.connect(filters[0]);
            filters.forEach((filter, i) => filter.connect(filters[i + 1] ?? context.destination));
            // Only replace VolumeBooster's output edge; leave Discord's analyser and other paths alone.
            data.gainNode.connect(preamp);
            try {
                data.gainNode.disconnect(context.destination);
            } catch (error) {
                data.gainNode.disconnect(preamp);
                preamp.disconnect();
                filters.forEach(filter => filter.disconnect());
                throw error;
            }
            route = { data, userId, gain: data.gainNode, preamp, filters, meters, headroom: 0, signature: "" };
            routes.set(data, route);
        }

        const signature = JSON.stringify(profile);
        if (route.signature === signature) return;
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
    }

    function observe(data: VoiceStream, userId: string) {
        streams.set(data, userId);
        try {
            update(data, userId);
        } catch (error) {
            detach(data);
            reportError(error);
        }
    }

    function refresh(userId?: string) {
        for (const [data, id] of streams) {
            if (userId == null || userId === id) observe(data, id);
        }
    }

    function prune(isCurrent: (data: VoiceStream) => boolean = () => true) {
        for (const data of streams.keys()) {
            if (data.audioContext.state === "closed" || !data.stream.active || !isCurrent(data)) {
                detach(data);
                streams.delete(data);
            }
        }
    }

    return {
        observe,
        refresh,
        prune,
        status(userId: string) {
            const active = [...streams].filter(([data, id]) => id === userId && data.audioContext.state !== "closed" && data.stream.active);
            return { streams: active.length, headroom: Math.max(0, ...active.map(([data]) => routes.get(data)?.headroom ?? 0)) };
        },
        stop() {
            for (const data of routes.keys()) detach(data);
            streams.clear();
        }
    };
}
