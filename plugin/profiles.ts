/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 null234
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";

import { defaultProfile, normalizeProfile, Profile } from "./audio";

const KEY = "PerPersonEQ.profiles.v1";
const listeners = new Set<() => void>();
let profiles: Record<string, Profile> = {};
let revision = 0;
let ready = false;
let error = "";
let pending = Promise.resolve();
let onChange: (userId: string) => void = () => {};

function emit() {
    revision++;
    listeners.forEach(listener => listener());
}

export const profileStore = {
    subscribe(listener: () => void) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    },
    snapshot: () => revision,
    get ready() { return ready; },
    get error() { return error; },
    ids: () => Object.keys(profiles),
    get: (userId: string) => profiles[userId] ?? defaultProfile(),
    async load(change: (userId: string) => void) {
        onChange = change;
        if (ready) return;
        try {
            const saved = await DataStore.get<Record<string, Profile>>(KEY);
            profiles = Object.fromEntries(Object.entries(saved ?? {}).map(([id, profile]) => [id, normalizeProfile(profile)]));
            ready = true;
        } catch {
            error = "Could not load saved equalizers. Reload Vesktop to retry.";
        }
        emit();
    },
    set(userId: string, profile: Profile) {
        if (!ready) return;
        profiles[userId] = normalizeProfile(profile);
        onChange(userId);
        emit();
        const snapshot = structuredClone(profiles);
        pending = pending.then(() => DataStore.set(KEY, snapshot)).then(() => {
            if (error) {
                error = "";
                emit();
            }
        }).catch(() => {
            error = "Could not save this equalizer. Changes currently apply only to this session.";
            emit();
        });
    }
};
