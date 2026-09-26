import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Black software overlay laid down by the compositor, per display. It serves below the
// hardware floor of the brightness VCP: at 0% DDC brightness, the display still has light
// to give.

// Mutter bypasses the compositor for a fullscreen window (unredirect) and scans the window
// straight onto the display plane: the overlay, which is a compositor layer, then
// disappears, and comes back on leaving fullscreen. This is the main cause of flicker. The
// unredirect counter is global to Mutter and shared with the rest of the shell, so we only
// touch it on 0 <-> 1 transitions and never twice.
const Unredirect = {
    _holders: 0,

    acquire() {
        if (this._holders++ === 0)
            global.compositor.disable_unredirect();
    },

    release() {
        if (this._holders === 0)
            return;
        if (--this._holders === 0)
            global.compositor.enable_unredirect();
    },
};

// reactive: false is enough to let clicks through, but the shell's drag-and-drop queries the
// scene with Clutter.PickMode.ALL, which also picks up non-reactive actors. A fullscreen
// overlay then becomes the target of every drop, and a window dragged to another workspace
// never reaches its thumbnail. A pick that paints nothing makes the overlay unpickable
// without changing what's displayed.
const DimActor = GObject.registerClass(
class DimActor extends St.Widget {
    vfunc_pick(_pickContext) {
    }
});

// get_monitors() does not follow the logical monitor order used by layoutManager, so an
// index into one cannot be read from the other: ask Mutter for each connector's index.
function monitorIndexByConnector() {
    const manager = global.backend.get_monitor_manager();
    const indexes = new Map();
    for (const monitor of manager.get_monitors()) {
        const connector = monitor.get_connector();
        const index = manager.get_monitor_for_connector(connector);
        if (index >= 0)
            indexes.set(normalize(connector), index);
    }
    return indexes;
}

// ddcutil's raw DRM connector name ("HDMI-A-1") vs the name exposed by Mutter ("HDMI-1").
function normalize(name) {
    return name ? name.replace(/^(HDMI|DVI)-[A-Z]-(\d+)$/, '$1-$2') : null;
}

class Overlay {
    constructor(connector) {
        this.connector = connector;
        this.level = 0;
        this._holding = false;

        this._actor = new DimActor({
            name: 'monitor-control-dim',
            reactive: false,
            opacity: 0,
        });
        // addTopChrome places the overlay above the other UI layers. trackFullscreen: false
        // is required: at true, the layout manager hides the actor as soon as a window goes
        // fullscreen, which produces exactly the flicker we're trying to remove. The shell
        // only accepts trackFullscreen and affectsStruts here; it's reactive: false that lets
        // clicks pass through the overlay.
        Main.layoutManager.addTopChrome(this._actor, { trackFullscreen: false });
        // Style is set after insertion: St requires the theme node and warns when the actor
        // isn't attached to the stage yet.
        this._actor.set_style('background-color: black;');
    }

    place(geometry) {
        this._actor.set_position(geometry.x, geometry.y);
        this._actor.set_size(geometry.width, geometry.height);
    }

    setLevel(level) {
        this.level = Math.max(0, Math.min(1, level));
        this._actor.opacity = Math.round(this.level * 255);

        // Unredirect is held only while an overlay is visible: keeping it permanently would
        // force full compositing and cost frames per second in games and videos for nothing.
        const wanted = this.level > 0;
        if (wanted && !this._holding) {
            Unredirect.acquire();
            this._holding = true;
        } else if (!wanted && this._holding) {
            Unredirect.release();
            this._holding = false;
        }
    }

    setVisible(visible) {
        this._actor.visible = visible;
    }

    raise() {
        this._actor.get_parent()?.set_child_above_sibling(this._actor, null);
    }

    destroy() {
        if (this._holding) {
            Unredirect.release();
            this._holding = false;
        }
        this._actor.hide();
        Main.layoutManager.removeChrome(this._actor);
        this._actor.destroy();
        this._actor = null;
    }
}

export class DimManager {
    constructor() {
        this._overlays = new Map();   // display key -> Overlay
        this._connectors = new Map(); // display key -> normalized connector

        // Mutter re-stacks actors on every window state change: we raise the overlay back
        // to the top right away, without delay, otherwise a window being resized shows
        // through for a frame.
        this._sizeChangeId = global.window_manager.connect('size-change', () => this._raiseAll());
        this._mapId = global.window_manager.connect('map', () => this._raiseAll());
        this._fullscreenId = global.display.connect('in-fullscreen-changed', () => this._raiseAll());

        // Lock screen: the overlay hides, the actor stays in place. It's already there on
        // unlock, so nothing to recreate and nothing that flickers.
        this._sessionId = Main.sessionMode.connect('updated', () => this._syncVisibility());
        this._syncVisibility();
    }

    _raiseAll() {
        for (const overlay of this._overlays.values())
            overlay.raise();
    }

    _syncVisibility() {
        const locked = Main.sessionMode.currentMode === 'unlock-dialog';
        for (const overlay of this._overlays.values())
            overlay.setVisible(!locked);
    }

    // Maps DDC displays to Mutter monitors and repositions overlays. Call again on every
    // detection and every layout change.
    syncMonitors(monitors) {
        const geometries = new Map();
        for (const [connector, index] of monitorIndexByConnector()) {
            const geometry = Main.layoutManager.monitors[index];
            if (geometry)
                geometries.set(connector, geometry);
        }

        this._connectors = new Map(monitors.map(m => [m.key, normalize(m.connector)]));

        for (const [key, overlay] of [...this._overlays]) {
            if (!this._connectors.has(key)) {
                overlay.destroy();
                this._overlays.delete(key);
            }
        }

        for (const [key, connector] of this._connectors) {
            const geometry = geometries.get(connector);
            if (!geometry) {
                // Display seen by ddcutil but absent on Mutter's side: no surface to place
                // the overlay on, so we remove the existing one rather than leave it on a
                // display that's no longer there.
                this._overlays.get(key)?.destroy();
                this._overlays.delete(key);
                continue;
            }
            let overlay = this._overlays.get(key);
            if (!overlay) {
                overlay = new Overlay(connector);
                this._overlays.set(key, overlay);
            }
            overlay.place(geometry);
            overlay.raise();
        }
        this._syncVisibility();
    }

    // True if this display actually has a surface to place the overlay on.
    has(key) {
        return this._overlays.has(key);
    }

    getLevel(key) {
        return this._overlays.get(key)?.level ?? 0;
    }

    setLevel(key, level) {
        this._overlays.get(key)?.setLevel(level);
    }

    destroy() {
        if (this._sizeChangeId) {
            global.window_manager.disconnect(this._sizeChangeId);
            this._sizeChangeId = 0;
        }
        if (this._mapId) {
            global.window_manager.disconnect(this._mapId);
            this._mapId = 0;
        }
        if (this._fullscreenId) {
            global.display.disconnect(this._fullscreenId);
            this._fullscreenId = 0;
        }
        if (this._sessionId) {
            Main.sessionMode.disconnect(this._sessionId);
            this._sessionId = 0;
        }
        for (const overlay of this._overlays.values())
            overlay.destroy();
        this._overlays.clear();
        this._connectors.clear();
    }
}
