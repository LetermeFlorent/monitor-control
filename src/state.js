import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// Per-display settings persistence, shaped as:
//   { version: 2, monitors: { "<vendor:model:serial>": { ddc: { "10": n, "12": n }, dim: f } } }
// "ddc" holds the VCP values sent to the display, "dim" the software overlay level between
// 0 and 1.

// The file used to live inside the extension's own folder, so it got wiped on every update
// or reinstall. It now lives alongside the other user configuration files.
function clampLevel(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.min(1, value))
        : 0;
}

export function defaultStateFile() {
    return Gio.File.new_for_path(GLib.build_filenamev(
        [GLib.get_user_config_dir(), 'monitor-control', 'state.json']));
}

export class StateStore {
    constructor(file) {
        this._file = file;
        this._saveId = 0;
        this._data = this._load();
    }

    _readJson(file) {
        try {
            const [ok, contents] = file.load_contents(null);
            if (ok)
                return JSON.parse(new TextDecoder().decode(contents));
        } catch {
            // File missing or unreadable: start from an empty state.
        }
        return null;
    }

    _load() {
        const raw = this._readJson(this._file);
        return this._migrate(raw ?? {});
    }

    // Old v1 format = flat object { "<key>": { "10": n, "12": n, contrastPlus: x } }.
    // contrastPlus was already the software overlay level: it becomes dim.
    _migrate(raw) {
        if (raw && raw.version === 2 && raw.monitors)
            return this._normalize(raw);

        const monitors = {};
        for (const [key, entry] of Object.entries(raw ?? {})) {
            if (!entry || typeof entry !== 'object')
                continue;
            const ddc = {};
            for (const [k, v] of Object.entries(entry)) {
                if (/^[0-9a-fA-F]{1,2}$/.test(k) && typeof v === 'number')
                    ddc[k] = v;
            }
            monitors[key] = { ddc, dim: clampLevel(entry.contrastPlus) };
        }
        return { version: 2, monitors };
    }

    _normalize(data) {
        for (const entry of Object.values(data.monitors)) {
            entry.ddc ??= {};
            entry.dim = clampLevel(entry.dim);
            delete entry.filter;
        }
        return data;
    }

    // Reconciles legacy keys (truncated by the old detection, e.g. "GSM:LG") with the
    // canonical keys of the displays present, ONCE. Migrates only when the match is unique
    // (never on ambiguity, e.g. two LG displays) to avoid mixing up settings.
    migrateLegacyKeys(currentKeys) {
        let changed = false;
        for (const stored of Object.keys(this._data.monitors)) {
            if (currentKeys.includes(stored))
                continue;
            const matches = currentKeys.filter(k =>
                !this._data.monitors[k] && (k.startsWith(stored) || stored.startsWith(k)));
            if (matches.length === 1) {
                this._data.monitors[matches[0]] = this._data.monitors[stored];
                delete this._data.monitors[stored];
                changed = true;
            }
        }
        if (changed)
            this._scheduleSave();
    }

    get(key) {
        const entry = this._data.monitors[key] ?? null;
        return { ddc: { ...(entry?.ddc ?? {}) }, dim: clampLevel(entry?.dim) };
    }

    _ensure(key) {
        let entry = this._data.monitors[key];
        if (!entry) {
            entry = { ddc: {}, dim: 0 };
            this._data.monitors[key] = entry;
        }
        entry.ddc ??= {};
        return entry;
    }

    setDdc(key, code, value) {
        this._ensure(key).ddc[code] = value;
        this._scheduleSave();
    }

    setDim(key, level) {
        this._ensure(key).dim = clampLevel(level);
        this._scheduleSave();
    }

    _scheduleSave() {
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._saveId = 0;
            this._writeNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _writeNow() {
        try {
            const parent = this._file.get_parent();
            if (parent && !parent.query_exists(null))
                parent.make_directory_with_parents(null);
            this._file.replace_contents(
                new TextEncoder().encode(JSON.stringify(this._data, null, 2)),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`monitor-control: could not write state: ${e}`);
        }
    }

    // Call on disable(): clears the timer and forces the last changes to be written.
    flush() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            this._writeNow();
        }
    }
}
