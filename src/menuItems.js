import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';

// Generic slider: maps the [0,1] cursor position to an arbitrary [min,max] range, with a
// formattable label, a callback (optionally debounced), and programmatic updates that don't
// re-emit the signal.
export const SliderMenuItem = GObject.registerClass(
class SliderMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init({ iconName, min, max, value, format, onChange, debounce = 0 }) {
        super._init({ activate: false, hover: false });

        this._min = min;
        this._max = max;
        this._format = format ?? (v => `${Math.round(v)}`);
        this._onChange = onChange;
        this._debounce = debounce;
        this._debounceId = 0;
        this._dragging = false;

        this.add_child(new St.Icon({ icon_name: iconName, style_class: 'popup-menu-icon' }));

        this._slider = new Slider(this._toSlider(value ?? min));
        this._slider.x_expand = true;
        this._changedId = this._slider.connect('notify::value', () => this._onSlider());
        this._slider.connect('drag-begin', () => { this._dragging = true; });
        this._slider.connect('drag-end', () => { this._dragging = false; });
        this.add_child(new St.Bin({ x_expand: true, child: this._slider }));

        this._label = new St.Label({
            style_class: 'monitor-control-value-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);
        this._updateLabel(value ?? min);

        this.connect('destroy', () => this._clearDebounce());
    }

    // The formatter receives (mapped value, [0,1] fraction): the fraction is used e.g. to
    // show a correct percentage when the range isn't [0,1] (VCP with an arbitrary max).
    _updateLabel(value) {
        this._label.set_text(this._format(value, this._toSlider(value)));
    }

    _toSlider(value) {
        if (this._max === this._min)
            return 0;
        return Math.max(0, Math.min(1, (value - this._min) / (this._max - this._min)));
    }

    _fromSlider() {
        return this._min + this._slider.value * (this._max - this._min);
    }

    // True while the user is holding the slider or a write is still pending: a background
    // refresh must not move the slider under their fingers.
    isBusy() {
        return this._dragging || this._debounceId !== 0;
    }

    // Clutter distinguishes "end" and "cancel", and the shell's Slider only connects "end":
    // an interrupted gesture would leave the slider marked busy forever, so never refreshed
    // again. Call this when no drag can possibly still be in progress.
    clearBusy() {
        this._dragging = false;
    }

    // Range and value set together: setting them in two calls left the slider displayed on
    // the old scale in between.
    setScale(value, max) {
        this._min = 0;
        this._max = max || 100;
        this._slider.block_signal_handler(this._changedId);
        this._slider.value = this._toSlider(value);
        this._slider.unblock_signal_handler(this._changedId);
        this._updateLabel(value);
    }

    _onSlider() {
        const value = this._fromSlider();
        this._label.set_text(this._format(value, this._slider.value));
        if (this._debounce > 0) {
            this._clearDebounce();
            this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._debounce, () => {
                this._debounceId = 0;
                this._onChange?.(value);
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._onChange?.(value);
        }
    }

    _clearDebounce() {
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
    }
});
