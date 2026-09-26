import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { VCP_BRIGHTNESS, VCP_CONTRAST } from './ddcutil.js';
import { SliderMenuItem } from './menuItems.js';

export const MonitorControlIndicator = GObject.registerClass(
class MonitorControlIndicator extends PanelMenu.Button {
    _init(controller) {
        super._init(0.5, 'Monitor Control');
        this._controller = controller;
        this._epoch = 0;
        this._dirty = false;
        this._sliders = new Map();   // display key -> { [VCP code]: SliderMenuItem }

        this.add_child(new St.Icon({
            icon_name: 'display-brightness-symbolic',
            style_class: 'system-status-icon',
        }));

        // Rebuilds the menu when the display list changes, but never while it's open (we
        // defer to close so an ongoing adjustment isn't interrupted).
        controller.onChanged = () => {
            if (this.menu.isOpen)
                this._dirty = true;
            else
                this._build();
        };
        controller.onValues = key => this._applyValues(key);
        controller.onError = message => this._showError(message);

        this.menu.connect('open-state-changed', (_m, open) => {
            if (!open && this._dirty) {
                this._dirty = false;
                this._build();
            }
        });

        // Reads still in flight at destruction time must no longer touch destroyed widgets.
        this.connect('destroy', () => { this._epoch++; });

        this._build();
    }

    _build() {
        this._epoch++;
        this.menu.removeAll();
        this._sliders.clear();

        this._errorItem = new PopupMenu.PopupMenuItem('', { reactive: false });
        this._errorItem.label.style_class = 'monitor-control-error';
        this._errorItem.visible = false;
        this.menu.addMenuItem(this._errorItem);

        const monitors = this._controller.getMonitors();
        if (monitors.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'No DDC/CI display detected', { reactive: false }));
        } else {
            monitors.forEach(mon => this._buildMonitor(mon));
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const refresh = new PopupMenu.PopupMenuItem('Refresh displays');
        refresh.connect('activate', () => this._controller.refreshDetect());
        this.menu.addMenuItem(refresh);
    }

    _buildMonitor(mon) {
        const sub = new PopupMenu.PopupSubMenuMenuItem(mon.displayName, true);
        sub.icon.icon_name = 'video-display-symbolic';
        this.menu.addMenuItem(sub);

        const sliders = {
            [VCP_BRIGHTNESS]: this._addVcpSlider(sub.menu, mon, 'Brightness',
                VCP_BRIGHTNESS, 'display-brightness-symbolic'),
            [VCP_CONTRAST]: this._addVcpSlider(sub.menu, mon, 'Contrast',
                VCP_CONTRAST, 'view-reveal-symbolic'),
        };
        this._sliders.set(mon.key, sliders);

        if (this._controller.hasDim(mon.key))
            this._addDimSlider(sub.menu, mon);

        // The cache already fills the sliders; this re-read only catches up on an adjustment
        // made in the meantime through the display's own buttons.
        sub.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refresh(mon);
            else
                Object.values(sliders).forEach(s => s.clearBusy());
        });
    }

    _addVcpSlider(menu, mon, label, code, iconName) {
        menu.addMenuItem(new PopupMenu.PopupMenuItem(label, { reactive: false }));
        const known = this._controller.getCached(mon.key, code);
        const slider = new SliderMenuItem({
            iconName,
            min: 0,
            max: known?.max || 100,
            value: known?.value ?? 0,
            format: (_v, t) => `${Math.round(t * 100)}%`,
            debounce: 250,
            onChange: v => this._controller.setVcp(mon.key, code, Math.round(v))
                .catch(e => this._showError(`setting refused by ${mon.displayName}: ${e.message}`)),
        });
        menu.addMenuItem(slider);
        return slider;
    }

    // The overlay is local compositing: no debounce, it follows the cursor live.
    _addDimSlider(menu, mon) {
        menu.addMenuItem(new PopupMenu.PopupMenuItem('Dimming', { reactive: false }));
        menu.addMenuItem(new SliderMenuItem({
            iconName: 'weather-clear-night-symbolic',
            min: 0,
            max: 1,
            value: this._controller.getDim(mon.key),
            format: (_v, t) => `${Math.round(t * 100)}%`,
            onChange: v => this._controller.setDim(mon.key, v),
        }));
    }

    _refresh(mon) {
        const epoch = this._epoch;
        this._controller.readValues(mon.key)
            .catch(e => {
                if (epoch === this._epoch)
                    this._showError(`${mon.displayName} not responding: ${e.message}`);
            });
    }

    _applyValues(key) {
        this._hideError();
        const sliders = this._sliders.get(key);
        if (!sliders)
            return;
        for (const [code, slider] of Object.entries(sliders)) {
            // Slider being manipulated: its position is authoritative, not the read value.
            if (slider.isBusy())
                continue;
            const known = this._controller.getCached(key, code);
            if (known)
                slider.setScale(known.value, known.max);
        }
    }

    _showError(message) {
        if (!this._errorItem)
            return;
        this._errorItem.label.text = message;
        this._errorItem.visible = true;
    }

    _hideError() {
        if (this._errorItem)
            this._errorItem.visible = false;
    }
});
