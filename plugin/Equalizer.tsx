/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 PerPersonEQ contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Heading } from "@components/Heading";
import { Text } from "@components/Text";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, React, UserStore } from "@webpack/common";

import { defaultProfile, FREQUENCIES, Profile } from "./audio";
import { profileStore } from "./profiles";

export type StreamStatus = (userId: string) => { streams: number; headroom: number; };

function db(value: number) {
    return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

function frequencyLabel(frequency: number) {
    return frequency >= 1000 ? `${frequency / 1000}k` : String(frequency);
}

function Equalizer({ userId, name, status, ...modalProps }: RenderModalProps & { userId: string; name: string; status: StreamStatus; }) {
    React.useSyncExternalStore(profileStore.subscribe, profileStore.snapshot);
    const profile = profileStore.get(userId);
    const [active, setActive] = React.useState(status(userId));
    React.useEffect(() => {
        const timer = setInterval(() => setActive(status(userId)), 1000);
        return () => clearInterval(timer);
    }, [userId, status]);

    function update(patch: Partial<Profile>) {
        profileStore.set(userId, { ...profile, ...patch });
        setActive(status(userId));
    }

    return (
        <Modal {...modalProps} size="lg" title="Equalizer" subtitle={name} actions={[{ text: "Done", variant: "primary", onClick: modalProps.onClose }]}>
            <div className="vc-ppeq">
                {profileStore.error && <div className="vc-ppeq-error" role="alert">{profileStore.error}</div>}
                <div className="vc-ppeq-toolbar">
                    <label className="vc-ppeq-check">
                        <input type="checkbox" checked={profile.enabled} disabled={!profileStore.ready} onChange={event => update({ enabled: event.currentTarget.checked })} />
                        Enabled
                    </label>
                    <span className="vc-ppeq-status" role="status">{!profileStore.ready ? "Loading..." : !profile.enabled ? "Bypassed" : active.streams ? "Voice connected" : "No active voice stream"}</span>
                    <Button size="small" variant="secondary" disabled={!profileStore.ready} onClick={() => update(defaultProfile())}>Reset</Button>
                </div>
                <fieldset className="vc-ppeq-controls" disabled={!profileStore.ready || !profile.enabled}>
                    <div className="vc-ppeq-bands">
                        {FREQUENCIES.map((frequency, i) => (
                            <label className="vc-ppeq-band" key={frequency}>
                                <output>{db(profile.bands[i])}</output>
                                <input
                                    type="range"
                                    min={-12}
                                    max={12}
                                    step={0.5}
                                    value={profile.bands[i]}
                                    aria-label={`${frequency} Hz`}
                                    aria-valuetext={`${db(profile.bands[i])} dB`}
                                    onDoubleClick={() => update({ bands: profile.bands.map((value, index) => index === i ? 0 : value) })}
                                    onChange={event => update({ bands: profile.bands.map((value, index) => index === i ? Number(event.currentTarget.value) : value) })}
                                />
                                <span>{frequencyLabel(frequency)}</span>
                            </label>
                        ))}
                    </div>
                    <div className="vc-ppeq-scale"><span>-12 dB</span><span>Hz</span><span>+12 dB</span></div>
                    <div className="vc-ppeq-preamp">
                        <label htmlFor={`vc-ppeq-preamp-${userId}`}>Preamp</label>
                        <input id={`vc-ppeq-preamp-${userId}`} type="range" min={-24} max={0} step={0.5} value={profile.preamp} onChange={event => update({ preamp: Number(event.currentTarget.value) })} />
                        <output>{db(profile.preamp)} dB</output>
                    </div>
                    <div className="vc-ppeq-headroom">
                        <label className="vc-ppeq-check">
                            <input type="checkbox" checked={profile.autoHeadroom} onChange={event => update({ autoHeadroom: event.currentTarget.checked })} />
                            Auto headroom
                        </label>
                        <output>{profile.autoHeadroom ? `-${active.headroom.toFixed(1)} dB` : "Off"}</output>
                    </div>
                </fieldset>
            </div>
        </Modal>
    );
}

const SafeEqualizer = ErrorBoundary.wrap(Equalizer, { noop: false });

export function openEqualizer(userId: string, name: string, status: StreamStatus) {
    openModal(props => <SafeEqualizer {...props} userId={userId} name={name} status={status} />, { modalKey: `vc-ppeq-${userId}` });
}

export const SavedEqualizers = ErrorBoundary.wrap(({ status }: { status: StreamStatus; }) => {
    React.useSyncExternalStore(profileStore.subscribe, profileStore.snapshot);
    return (
        <section className="vc-ppeq-saved">
            <Heading>Saved Equalizers</Heading>
            {profileStore.error && <Text>{profileStore.error}</Text>}
            {!profileStore.ids().length && <Text color="text-muted">No saved equalizers.</Text>}
            {profileStore.ids().map(id => {
                const user = UserStore.getUser(id);
                const name = user?.globalName || user?.username || id;
                return (
                    <div className="vc-ppeq-saved-row" key={id}>
                        <Text>{name}</Text>
                        <Button size="small" variant="secondary" onClick={() => openEqualizer(id, name, status)}>Edit</Button>
                    </div>
                );
            })}
        </section>
    );
}, { noop: false });
