import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// Standard DDC/CI VCP codes.
export const VCP_BRIGHTNESS = '10';
export const VCP_CONTRAST = '12';

// A silent display (asleep, cable pulled between two commands) leaves ddcutil waiting out
// its own i2c timeouts: without a limit, the whole queue stays stuck behind it.
const COMMAND_TIMEOUT_MS = 8000;

// ddcutil locks the i2c bus with a zero-timeout flock(): two concurrent calls always get
// rejected rather than waiting. So we serialize all commands into a single queue, and
// disable the flock (only this extension drives the bus here).
let _queue = Promise.resolve();

// Global cancellation: on the extension's disable(), we abandon every in-flight call so
// no callback touches an already-destroyed UI.
// Created on first use, not at import: nothing may be built before enable().
let _cancellable = null;

// Per-command timeouts, removed on disable() without waiting for the cancelled calls to
// finish.
const _timeouts = new Set();

export function cancelAll() {
    _cancellable?.cancel();
    _cancellable = null;
    for (const id of _timeouts)
        GLib.source_remove(id);
    _timeouts.clear();
    // The queue is NOT reset: it still points at the end of the command still in flight.
    // Resetting it to Promise.resolve() would let the next command start in parallel with
    // this one, two ddcutil processes on the same i2c bus while flock is disabled. Commands
    // already queued carry the cancelled cancellable and reject themselves.
}

function spawn(args, cancellable) {
    return new Promise((resolve, reject) => {
        // A command queued before a cancelAll() carries the cancelled cancellable: it must
        // not spawn a real ddcutil process after disable().
        if (cancellable.is_cancelled()) {
            reject(new Error('cancelled'));
            return;
        }
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['ddcutil', '--disable-flock', ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            if (e.matches?.(GLib.SpawnError, GLib.SpawnError.NOENT)) {
                const error = new Error('ddcutil is not installed');
                error.missing = true;
                reject(error);
            } else {
                reject(e);
            }
            return;
        }

        let done = false;
        let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COMMAND_TIMEOUT_MS, () => {
            _timeouts.delete(timeoutId);
            timeoutId = 0;
            if (!done)
                proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        _timeouts.add(timeoutId);

        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            done = true;
            if (timeoutId && _timeouts.delete(timeoutId)) {
                GLib.source_remove(timeoutId);
                timeoutId = 0;
            }
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                if (!p.get_successful()) {
                    // ddcutil exits with an error as soon as a single VCP code is refused,
                    // without writing anything to stderr, while still printing to stdout the
                    // codes it did manage to read. So the output travels with the error, so
                    // the caller can recover what is usable.
                    const error = new Error(stderr?.trim() || 'ddcutil refused the command');
                    error.stdout = stdout ?? '';
                    reject(error);
                    return;
                }
                resolve(stdout);
            } catch (e) {
                // Cancellation or timeout: the process may still be running, we kill it so
                // no orphan ddcutil keeps holding the bus. get_identifier() is null once the
                // process has been reaped, unlike get_if_exited() which requires a prior
                // wait() and complains otherwise.
                if (p.get_identifier() !== null)
                    p.force_exit();
                reject(e);
            }
        });
    });
}

export function runDdcutil(args) {
    // Cancellable captured at ENQUEUE time (not at execution time): otherwise a pending
    // command would read a fresh cancellable after a cancelAll() and run anyway.
    _cancellable ??= new Gio.Cancellable();
    const cancellable = _cancellable;
    const result = _queue.then(() => spawn(args, cancellable), () => spawn(args, cancellable));
    // The queue keeps going even if this call fails.
    _queue = result.then(() => {}, () => {});
    return result;
}

// Addressing by i2c bus ("--bus 9") rather than display number ("-d 2"): with -d, ddcutil
// re-enumerates every bus on each command to find the requested display. Measured on this
// machine: 0.273 s versus 0.057 s for the same read.
function busArgs(bus) {
    return ['--bus', String(bus)];
}

function normalizeMonitorField(field) {
    // ddcutil "Monitor:" field = "<vendor>:<model>:<serial>". The model can contain spaces
    // ("LG ULTRAGEAR") but never ":", so this split is safe: first = vendor, last = serial,
    // the rest (joined) = model.
    const parts = field.split(':');
    const vendor = parts[0] ?? '';
    const serial = parts.length > 1 ? parts[parts.length - 1] : '';
    const product = parts.slice(1, -1).join(':');
    return { vendor, product, serial, key: field };
}

// ddcutil's raw DRM connector name ("HDMI-A-1") vs the name exposed by Mutter ("HDMI-1"):
// the subtype ("-A-", "-B-"...) is absent on Mutter's side for HDMI/DVI, DP/VGA are identical.
export function normalizeConnector(name) {
    return name.replace(/^(HDMI|DVI)-[A-Z]-(\d+)$/, '$1-$2');
}

function newBlock(ddcIndex) {
    return { ddcIndex, bus: null, connector: null, vendor: '', product: '', serial: '', key: null };
}

export async function detect() {
    const out = await runDdcutil(['detect', '--brief']);
    const monitors = [];
    let current = null;
    for (const line of out.split('\n')) {
        const disp = line.match(/^Display (\d+)/);
        if (disp) {
            current = newBlock(disp[1]);
            monitors.push(current);
            continue;
        }
        // "Invalid display" block (display asleep/DPMS or without working DDC/CI): ddcutil
        // still lists connector + Monitor but WITHOUT a display number. We open a block with
        // ddcIndex=null, needed so its lines aren't attached to the previous valid block
        // (contamination) and to distinguish "not DDC-controllable" from "absent".
        if (/^Invalid display/i.test(line)) {
            current = newBlock(null);
            monitors.push(current);
            continue;
        }
        if (!current)
            continue;
        const bus = line.match(/^\s*I2C bus:\s*\/dev\/i2c-(\d+)\s*$/);
        if (bus) {
            current.bus = bus[1];
            continue;
        }
        const conn = line.match(/^\s*DRM connector:\s*card\d+-(.+)$/);
        if (conn) {
            current.connector = normalizeConnector(conn[1].trim());
            continue;
        }
        const mon = line.match(/^\s*Monitor:\s*(.+?)\s*$/);
        if (mon)
            Object.assign(current, normalizeMonitorField(mon[1]));
    }
    // Keep only displays that are actually identifiable.
    return monitors.filter(m => m.connector || m.key);
}

// Batched read: ddcutil accepts several VCP codes per invocation and only pays for opening
// the bus once. Brightness and contrast together cost the time of a single read. A code
// refused by the display doesn't lose the others: we return what was read and only throw if
// nothing is usable.
export async function getVcpMulti(bus, codes) {
    let out;
    try {
        out = await runDdcutil([...busArgs(bus), 'getvcp', ...codes]);
    } catch (e) {
        if (typeof e.stdout !== 'string')
            throw e;
        out = e.stdout;
    }
    const values = new Map();
    for (const line of out.split('\n')) {
        const m = line.match(
            /^VCP code 0x([0-9a-fA-F]{2})\s*\([^)]*\):\s*current value\s*=\s*(\d+),\s*max value\s*=\s*(\d+)/);
        if (m)
            values.set(m[1].toLowerCase(), { value: parseInt(m[2], 10), max: parseInt(m[3], 10) });
    }
    if (values.size === 0)
        throw new Error(`no VCP code readable among ${codes.join(', ')}`);
    return values;
}

export function setVcp(bus, code, value) {
    return runDdcutil([...busArgs(bus), 'setvcp', code, String(value)]);
}
