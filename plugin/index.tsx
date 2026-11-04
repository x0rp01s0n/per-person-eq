/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 PerPersonEQ contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import VolumeBooster from "@plugins/volumeBooster";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import type { User } from "@vencord/discord-types";
import { MediaEngineStore, Menu } from "@webpack/common";

import { createEqualizer, VoiceStream } from "./audio";
import { openEqualizer, SavedEqualizers } from "./Equalizer";
import { profileStore } from "./profiles";
import style from "./style.css?managed";

const logger = new Logger("PerPersonEQ");
const equalizer = createEqualizer(profileStore.get, error => logger.error("Could not apply equalizer", error));
let original: typeof VolumeBooster.patchVolume | undefined;
let wrapped: typeof VolumeBooster.patchVolume | undefined;
let cleanup: ReturnType<typeof setInterval> | undefined;

function voiceOutputs() {
    return [...MediaEngineStore.getMediaEngine().connections]
        .filter(connection => connection.context === "default")
        .flatMap(connection => Object.values((connection as typeof connection & { outputs?: Record<string, VoiceStream>; }).outputs ?? {}));
}

const userContext: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user) return;
    const group = findGroupChildrenByChildId("user-volume", children) ?? children;
    group.push(<Menu.MenuItem id="vc-per-person-eq" label="Equalizer" action={() => openEqualizer(user.id, user.globalName || user.username, equalizer.status)} />);
};

export default definePlugin({
    name: "PerPersonEQ",
    description: "A saved 12-band voice equalizer for each person, using VolumeBooster's audio path.",
    authors: [{ name: "Local", id: 0n }],
    tags: ["Voice", "Accessibility"],
    enabledByDefault: true,
    requiresRestart: true,
    dependencies: ["VolumeBooster"],
    managedStyle: style,
    contextMenus: { "user-context": userContext },
    settingsAboutComponent: () => <SavedEqualizers status={equalizer.status} />,

    start() {
        original = VolumeBooster.patchVolume;
        const booster = original;
        wrapped = function (data) {
            booster.call(VolumeBooster, data);
            try {
                if (/^\d{17,20}$/.test(data.id) && voiceOutputs().includes(data)) equalizer.observe(data, data.id);
            } catch (error) {
                logger.error("Could not inspect voice stream", error);
            }
        };
        VolumeBooster.patchVolume = wrapped;
        void profileStore.load(userId => equalizer.refresh(userId)).then(() => {
            try {
                for (const data of voiceOutputs()) wrapped?.(data as Parameters<typeof VolumeBooster.patchVolume>[0]);
            } catch (error) {
                logger.error("Could not inspect existing voice streams", error);
            }
        });
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
        if (VolumeBooster.patchVolume === wrapped && original) VolumeBooster.patchVolume = original;
        if (cleanup) clearInterval(cleanup);
        equalizer.stop();
        original = wrapped = undefined;
    }
});
