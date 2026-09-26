import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { MonitorController } from './src/controller.js';
import { MonitorControlIndicator } from './src/indicator.js';

export default class MonitorControlExtension extends Extension {
    enable() {
        try {
            // Non-graphical core: detects DDC/CI displays and restores saved settings as
            // soon as the i2c bus answers (with retries).
            this._controller = new MonitorController();
            this._controller.start();

            // The menu stays off the lock screen: nobody should adjust displays or drive its
            // sliders from the keyboard without unlocking first.
            this._sessionId = Main.sessionMode.connect('updated', () => this._syncIndicator());
            this._syncIndicator();
        } catch (e) {
            // Never leave a partial state if init fails halfway through.
            console.error(`monitor-control: enable() failed, cleaning up: ${e}`);
            this.disable();
            throw e;
        }
    }

    _syncIndicator() {
        const locked = Main.sessionMode.isLocked;
        if (locked && this._indicator) {
            this._destroyIndicator();
        } else if (!locked && !this._indicator) {
            this._indicator = new MonitorControlIndicator(this._controller);
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        }
    }

    _destroyIndicator() {
        if (this._controller) {
            this._controller.onChanged = null;
            this._controller.onValues = null;
            this._controller.onError = null;
        }
        this._indicator?.destroy();
        this._indicator = null;
    }

    disable() {
        // session-modes declares unlock-dialog: without it the shell disables the extension on
        // lock and re-enables it on return, which destroys and recreates the dimming overlay,
        // hence a flash of full brightness on every unlock. While locked, the panel menu is
        // destroyed so no keyboard input reaches it; only the overlay actors stay in place.
        if (this._sessionId) {
            Main.sessionMode.disconnect(this._sessionId);
            this._sessionId = 0;
        }
        this._destroyIndicator();
        // Disconnects hotplug, cancels timers and in-flight ddcutil calls, removes the
        // overlay, writes the pending state.
        this._controller?.stop();
        this._controller = null;
    }
}
