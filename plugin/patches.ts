/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 null234
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const audioPatches = [{
    find: "streamSourceNode",
    group: true,
    replacement: [
        {
            match: /(?<=updateAudioElement\(\)\{)/,
            replace: "if($self.onAudioUpdate(this))return;"
        },
        {
            match: /(?<=addTrack\(\i\)\{)/,
            replace: "$self.scheduleAudioUpdate(this);"
        },
        {
            match: /(?<=removeTrack\(\i\)\{)/,
            replace: "$self.scheduleAudioUpdate(this);"
        },
        {
            match: /(?<=destroy\(\)\{)(?=this\.audioElement\?\.pause\(\))/,
            replace: "$self.onAudioDestroy(this);"
        }
    ]
}];
