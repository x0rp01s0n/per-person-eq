/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 null234
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import type { User } from "@vencord/discord-types";
import { MediaEngineStore, Menu } from "@webpack/common";

import { createEqualizer, VoiceStream } from "./audio";
import { openEqualizer, SavedEqualizers } from "./Equalizer";
import { audioPatches } from "./patches";
import { profileStore } from "./profiles";
import style from "./style.css?managed";

const logger = new Logger("PerPersonEQ");
const equalizer = createEqualizer(profileStore.get, error => logger.error("Could not apply equalizer", error));
let running = false;
const scheduled = new WeakSet<VoiceStream>();
const destroyed = new WeakSet<VoiceStream>();
let cleanup: ReturnType<typeof setInterval> | undefined;

function voiceOutputs() {
    return [...MediaEngineStore.getMediaEngine().connections]
        .filter(connection => connection.context === "default")
        .flatMap(connection => Object.values((connection as typeof connection & { outputs?: Record<string, VoiceStream>; }).outputs ?? {}));
}

function refresh(userId?: string) {
    if (!running) return;
    try {
        for (const data of voiceOutputs()) {
            if (!destroyed.has(data) && (userId == null || data.id === userId)) data.updateAudioElement();
        }
    } catch (error) {
        logger.error("Could not update voice streams", error);
    }
}

const userContext: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user) return;
    const group = findGroupChildrenByChildId("user-volume", children) ?? children;
    group.push(<Menu.MenuItem id="vc-per-person-eq" label="Equalizer" action={() => openEqualizer(user.id, user.globalName || user.username, equalizer.status)} />);
};

export default definePlugin({
    name: "PerPersonEQ",
    description: "A saved 12-band equalizer for each person's incoming voice audio.",
    authors: [{ name: "null234", id: 0n }],
    tags: ["Voice", "Accessibility"],
    enabledByDefault: true,
    requiresRestart: true,
    patches: audioPatches,
    managedStyle: style,
    contextMenus: { "user-context": userContext },
    settingsAboutComponent: () => <SavedEqualizers status={equalizer.status} />,

    onAudioUpdate(data: VoiceStream) {
        if (!running || destroyed.has(data)) return false;
        try {
            if (/^\d{17,20}$/.test(data.id) && voiceOutputs().includes(data)) return equalizer.observe(data, data.id);
        } catch (error) {
            logger.error("Could not inspect voice stream", error);
        }
        return false;
    },

    scheduleAudioUpdate(data: VoiceStream) {
        if (!running || scheduled.has(data)) return;
        scheduled.add(data);
        queueMicrotask(() => {
            scheduled.delete(data);
            if (!running || destroyed.has(data)) return;
            try { data.updateAudioElement(); } catch (error) { logger.error("Could not update audio tracks", error); }
        });
    },

    onAudioDestroy(data: VoiceStream) {
        destroyed.add(data);
        equalizer.forget(data);
    },

    start() {
        running = true;
        void profileStore.load(refresh).then(() => refresh());
        cleanup = setInterval(() => {
            try {
                const active = new Set(voiceOutputs());
                equalizer.prune(data => active.has(data));
            } catch (error) {
                logger.error("Could not clean up voice streams", error);
            }
        }, 10000);
    },

    stop() {
        running = false;
        if (cleanup) clearInterval(cleanup);
        equalizer.stop();
    }
});
