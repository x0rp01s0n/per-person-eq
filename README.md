# PerPersonEQ

A local Vencord plugin for Vesktop: a saved 12-band equalizer for each person's
incoming voice audio, based on
[Vencord's VolumeBooster plugin](https://github.com/Vencord/Vencord/tree/main/src/plugins/volumeBooster)
and its Web Audio routing. PerPersonEQ extends VolumeBooster's existing playback
path rather than creating a separate one. **VolumeBooster must remain enabled.**

## Credits

This project builds on the audio-routing approach in **VolumeBooster**, with
credit to its authors and the Vencord contributors. VolumeBooster provides the
incoming stream source, volume gain, mute handling, and output-device selection;
PerPersonEQ adds per-user EQ filters, controls, and saved profiles on that path.
This is an independent custom plugin, not an official Vencord or Vesktop release.

## Use

Keep **VolumeBooster** and **PerPersonEQ** enabled. Right-click a person and select
**Equalizer**. Changes apply immediately and save automatically. Saved profiles
are also available in PerPersonEQ's plugin settings.

- 12 fixed bands, from 31.5 Hz to 16 kHz, with +/-12 dB adjustment.
- Preamp attenuation, bypass, reset, and automatic EQ headroom.
- Profiles keyed by Discord user ID and stored locally in Vencord's IndexedDB.
- Voice calls with or without webcams. Screen-share audio is left unchanged.
- VolumeBooster retains control of volume, mute/deafen, and output devices.

Auto headroom compensates the combined EQ response. It is not a limiter and does
not prevent clipping introduced by VolumeBooster or other processing. Stable and
Canary use separate browser storage, so their profiles are separate.

## Build

Requires Git, Node.js 22 or newer, and pnpm. Run commands from this repository.

```sh
node manage.mjs build
```

This clones Vencord into the ignored `.vencord` directory when needed, copies
`plugin/` into `src/userplugins/perPersonEQ.vesktop`, installs upstream's locked
dependencies, checks types and lint, and builds a development version. The
Vesktop files are published to `dist/`. Existing builds are retained in
`dist.previous/` until the next successful build.

Set `PER_PERSON_EQ_VENCORD` to use an existing Vencord checkout instead. This
installation's ignored `.vencord` symlink reuses its original build checkout.
Vencord itself is a separate dependency, not vendored into this repository.

## Install

For the Linux Flatpak installation this was developed on, fully quit Vesktop:

```sh
node manage.mjs activate
```

Start Vesktop normally. The script saves its previous custom-build location,
grants the Flatpak read-only access to this directory, and sets `vencordDir` in
Vesktop's `state.json`. It does not replace the bundled Vencord files or change
your other plugin settings.

The default config directory is `~/.config/vesktop`. If your Flatpak uses the
older layout, set `PER_PERSON_EQ_CONFIG` to
`~/.var/app/dev.vencord.Vesktop/config/vesktop` for both activation and restore.
Do not move this repository after activation without updating the build location.

On other Vesktop installations, build as above and select this repository's
`dist` folder under **Vesktop Settings > Developer Settings > Vencord Location**,
then fully restart Vesktop. The activation/restore scripts are Flatpak-specific.

## Update

```sh
node manage.mjs update
```

This fast-forwards the Vencord checkout and rebuilds with the plugin. Fully restart
Vesktop afterward. Pull this plugin repository separately when its source changes.

The generated build disables Vencord's built-in updater so it cannot silently
replace this custom build. Vesktop updates are separate. Updates are manual;
Discord changes can still require compatibility fixes.

## Test

`build` runs the upstream TypeScript check and plugin lint. The audio tests use
real Chromium Web Audio nodes and offline audio rendering:

```sh
node test-audio.mjs
```

The default browser is `/usr/bin/google-chrome-stable`; set `CHROME_PATH` for a
different Chromium binary. Tests cover EQ response, profile validation, gain and
mute preservation, bypass, headroom, duplicate-route prevention, and teardown.

## Restore

Fully quit Vesktop, then:

```sh
node manage.mjs restore
```

This restores the previous Vencord location without deleting EQ profiles or
changing other settings. Start Vesktop normally. For manual installs, reset
**Vencord Location** in Developer Settings instead.

## Implementation

`plugin/index.tsx` wraps VolumeBooster's `patchVolume` method. It matches streams
against the media engine's default voice connections, including webcam calls,
and inserts filters into VolumeBooster's existing output route. It does not add
its own Discord source patches. Unchanged and bypassed profiles retain the direct
VolumeBooster route. Stale routes are pruned and stopping the plugin restores
the original output routing.

This is an unofficial custom plugin, not supported by the Vencord or Vesktop
maintainers. It depends on Discord and VolumeBooster internals remaining compatible.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
