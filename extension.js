import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { MonitorController } from './src/controller.js';
import { MonitorControlIndicator } from './src/indicator.js';

export default class MonitorControlExtension extends Extension {
    enable() {
        try {
            // Non-graphical core: detects DDC/CI displays and restores saved settings as
            // soon as the i2c bus answers (with retries).
            this._controller = new MonitorController(this.path);
            this._controller.start();

            this._indicator = new MonitorControlIndicator(this._controller);
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        } catch (e) {
            // Never leave a partial state if init fails halfway through.
            console.error(`monitor-control: enable() failed, cleaning up: ${e}`);
            this.disable();
            throw e;
        }
    }

    // session-modes declares unlock-dialog: without it the shell disables the extension on
    // lock and re-enables it on return, which destroys and recreates the dimming overlay,
    // hence a flash of full brightness on every unlock. No keyboard signal is connected, the
    // extension only keeps its actors in place.
    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        // Disconnects hotplug, cancels timers and in-flight ddcutil calls, removes the
        // overlay, writes the pending state.
        this._controller?.stop();
        this._controller = null;
    }
}
