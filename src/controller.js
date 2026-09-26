import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Ddc from './ddcutil.js';
import { DimManager } from './dimmer.js';
import { StateStore, defaultStateFile } from './state.js';

// ddcutil detection at startup: the i2c bus isn't always ready at login (displays still
// asleep, slow enumeration). We retry over ~1 min rather than giving up (source of the old
// "settings not applied at login" bug).
const DETECT_RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000]; // ms

// A hotplug or a wakeup fires "monitors-changed" several times in a row. Without this
// delay, each emission would trigger its own detection and its own restoration.
const HOTPLUG_DEBOUNCE_MS = 300;

const READ_CODES = [Ddc.VCP_BRIGHTNESS, Ddc.VCP_CONTRAST];

// Non-graphical core: detects DDC/CI-capable displays, restores saved values, keeps a cache
// of read values up to date, drives the software overlay, reacts to hotplug.
export class MonitorController {
    constructor() {
        this._stopped = false;
        this._monitors = [];           // controllable displays: { bus, key, connector, displayName }
        this._busByKey = new Map();    // key -> i2c bus number
        this._values = new Map();      // key -> Map code -> { value, max }
        this._writeSeq = new Map();    // key -> number of writes issued, to age out stale reads
        this._restored = new Set();    // displays whose saved setting was reapplied successfully
        this._restoring = new Set();   // restorations in progress, guards against two concurrent passes
        this._retryId = 0;
        this._hotplugId = 0;
        this.onChanged = null;         // the display list changed
        this.onValues = null;          // (key) this display's cached values changed
        this.onError = null;           // (message) a ddcutil command failed

        this._state = new StateStore(defaultStateFile());
        this._dim = new DimManager();

        // Hotplug / wakeup: re-detect when the display layout changes.
        this._monitorsChangedId =
            Main.layoutManager.connect('monitors-changed', () => this._scheduleHotplug());
    }

    start() {
        this._detectAndApply(0);
    }

    _scheduleHotplug() {
        if (this._hotplugId)
            GLib.source_remove(this._hotplugId);
        this._hotplugId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, HOTPLUG_DEBOUNCE_MS, () => {
                this._hotplugId = 0;
                this._detectAndApply(0);
                return GLib.SOURCE_REMOVE;
            });
    }

    _detectAndApply(attempt) {
        if (this._stopped)
            return;
        Ddc.detect().then(detected => {
            if (this._stopped)
                return;
            // Only displays with a known i2c bus are controllable (we discard "Invalid
            // display" blocks: asleep / without working DDC/CI). The connector is used as a
            // fallback key: a display without a "Monitor:" line would otherwise get a null
            // key that breaks state reconciliation and overwrites the neighboring display.
            const usable = detected
                .filter(d => d.ddcIndex != null && d.bus != null && (d.key || d.connector))
                .map(d => ({ ...d, key: d.key || d.connector }));
            if (usable.length === 0 && attempt < DETECT_RETRY_DELAYS.length) {
                this._scheduleDetect(attempt);
                return;
            }
            this._state.migrateLegacyKeys(usable.map(d => d.key));
            this._monitors = usable.map(d => ({
                bus: d.bus,
                key: d.key,
                connector: d.connector,
                displayName: d.product || d.key || d.connector || 'Display',
            }));
            this._busByKey = new Map(usable.map(d => [d.key, d.bus]));

            // An unplugged display must not keep its place in the cache nor count as already
            // restored: on reconnection it becomes a new display again.
            for (const map of [this._values, this._writeSeq]) {
                for (const key of [...map.keys()])
                    if (!this._busByKey.has(key))
                        map.delete(key);
            }
            for (const set of [this._restored, this._restoring]) {
                for (const key of [...set])
                    if (!this._busByKey.has(key))
                        set.delete(key);
            }

            this._dim.syncMonitors(this._monitors);
            this._applySavedDim();

            this._applySavedDdc()
                .then(() => this._readAll())
                .catch(e => console.warn(`monitor-control: restoration interrupted: ${e}`));
            this.onChanged?.();
        }).catch(e => {
            if (this._stopped)
                return;
            // A missing binary will not appear by retrying: report it once and stop.
            if (e.missing) {
                this.onError?.(e.message);
                return;
            }
            console.warn(`monitor-control: ddcutil detection failed: ${e}`);
            if (attempt < DETECT_RETRY_DELAYS.length)
                this._scheduleDetect(attempt);
            else
                this.onError?.('unable to detect displays');
        });
    }

    _scheduleDetect(attempt) {
        if (this._retryId)
            GLib.source_remove(this._retryId);
        this._retryId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, DETECT_RETRY_DELAYS[attempt], () => {
                this._retryId = 0;
                this._detectAndApply(attempt + 1);
                return GLib.SOURCE_REMOVE;
            });
    }

    // Restoration is reserved for displays that just appeared. Reapplying it on every
    // re-detection would overwrite an ongoing adjustment as soon as a hotplug signal fired.
    // A failed write (display still waking up at login) does not mark the display as
    // restored: the next detection retries.
    async _applySavedDdc() {
        for (const [key, bus] of this._busByKey) {
            if (this._stopped)
                return;
            if (this._restored.has(key) || this._restoring.has(key))
                continue;
            this._restoring.add(key);
            let complete = true;
            for (const [code, value] of Object.entries(this._state.get(key).ddc)) {
                try {
                    await Ddc.setVcp(bus, code, value);
                } catch (e) {
                    complete = false;
                    console.warn(`monitor-control: VCP ${code} restore on display ${key}: ${e}`);
                }
            }
            this._restoring.delete(key);
            if (complete)
                this._restored.add(key);
        }
    }

    // The overlay is local compositing: nothing to retry, it applies immediately.
    _applySavedDim() {
        for (const key of this._busByKey.keys()) {
            if (this._dim.has(key))
                this._dim.setLevel(key, this._state.get(key).dim);
        }
    }

    // Fills the cache right at detection: the first time the menu opens, sliders are already
    // at the right value, instead of showing 0 for the duration of a DDC read.
    async _readAll() {
        for (const key of this._busByKey.keys()) {
            if (this._stopped)
                return;
            await this.readValues(key).catch(() => {});
        }
    }

    // -- UI API -------------------------------------------------------------------
    getMonitors() {
        return this._monitors;
    }

    // Known values without any ddcutil call: null until something has been read.
    getCached(key, code) {
        return this._values.get(key)?.get(code) ?? null;
    }

    async readValues(key) {
        const bus = this._busByKey.get(key);
        if (bus == null)
            throw new Error('display not available over DDC');
        const seq = this._writeSeq.get(key) ?? 0;
        const values = await Ddc.getVcpMulti(bus, READ_CODES);
        if (this._stopped)
            return values;
        // A write that started during this read makes the result stale: publishing it would
        // move the slider back to the value from before the adjustment.
        if ((this._writeSeq.get(key) ?? 0) !== seq)
            return values;
        // Merge, not replace: a code the display refused this time must not erase the known
        // value of the others.
        const known = this._values.get(key) ?? new Map();
        for (const [code, entry] of values)
            known.set(code, entry);
        this._values.set(key, known);
        this.onValues?.(key);
        return values;
    }

    async setVcp(key, code, value) {
        this._state.setDdc(key, code, value);
        const bus = this._busByKey.get(key);
        if (bus == null)
            throw new Error('display not available over DDC');
        this._writeSeq.set(key, (this._writeSeq.get(key) ?? 0) + 1);
        await Ddc.setVcp(bus, code, value);
        // The cache follows the write without re-reading: an immediate re-read would cost one
        // more i2c round trip per slider notch.
        const known = this._values.get(key) ?? new Map();
        known.set(code, { ...(known.get(code) ?? { max: 100 }), value });
        this._values.set(key, known);
    }

    // -- Software overlay -----------------------------------------------------------
    hasDim(key) {
        return this._dim.has(key);
    }

    getDim(key) {
        return this._dim.getLevel(key);
    }

    setDim(key, level) {
        this._dim.setLevel(key, level);
        this._state.setDim(key, this._dim.getLevel(key));
    }

    // "Refresh displays" re-detects and re-reads the real state. It does not reapply saved
    // values: an adjustment made in the meantime through the display's own buttons would be
    // overwritten by a button whose label doesn't suggest that.
    refreshDetect() {
        this._detectAndApply(0);
    }

    // -- Lifecycle ---------------------------------------------------------------
    stop() {
        this._stopped = true;
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
        if (this._hotplugId) {
            GLib.source_remove(this._hotplugId);
            this._hotplugId = 0;
        }
        Ddc.cancelAll();
        this._dim.destroy();
        this._state.flush();
        this._busByKey.clear();
        this._values.clear();
        this._writeSeq.clear();
        this._restored.clear();
        this._restoring.clear();
        this._monitors = [];
        this.onChanged = null;
        this.onValues = null;
        this.onError = null;
    }
}
