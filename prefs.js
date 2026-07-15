// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Rayan (rayan6ms)

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const COLORS = Object.freeze([
    ['accent', 'System accent'],
    ['custom', 'Custom color'],
    ['blue', 'Blue'],
    ['teal', 'Teal'],
    ['green', 'Green'],
    ['yellow', 'Yellow'],
    ['orange', 'Orange'],
    ['red', 'Red'],
    ['pink', 'Pink'],
    ['purple', 'Purple'],
    ['slate', 'Slate'],
]);

const PRESET_COLORS = Object.freeze([
    ['blue', 'Blue', '#3584e4'],
    ['teal', 'Teal', '#2190a4'],
    ['green', 'Green', '#3a944a'],
    ['yellow', 'Yellow', '#c88800'],
    ['orange', 'Orange', '#ed5b00'],
    ['red', 'Red', '#e62d42'],
    ['pink', 'Pink', '#d56199'],
    ['purple', 'Purple', '#9141ac'],
    ['slate', 'Slate', '#6f8396'],
]);

const SIZES = Object.freeze([
    ['thin', 'Thin'],
    ['medium', 'Medium'],
    ['bold', 'Bold'],
]);

const STYLES = Object.freeze([
    ['fruit', 'Fruit blade'],
    ['clean', 'Clean'],
    ['neon', 'Neon'],
    ['shadow', 'Shadow'],
]);

const TIMINGS = Object.freeze([
    ['quick', 'Quick'],
    ['balanced', 'Balanced'],
    ['lingering', 'Lingering'],
]);

const TRAILS = Object.freeze([
    ['short', 'Short'],
    ['balanced', 'Balanced'],
    ['long', 'Long'],
]);

const SPEEDS = Object.freeze([
    ['steady', 'Steady width'],
    ['responsive', 'Responsive'],
    ['dynamic', 'Dynamic'],
]);

const RESET_KEYS = Object.freeze([
    'enabled',
    'color-mode',
    'custom-color',
    'size-preset',
    'style',
    'timing-preset',
    'trail-preset',
    'speed-response',
]);

function indexOfValue(choices, value) {
    const index = choices.findIndex(
        ([choice]) => choice === value
    );

    return index >= 0 ? index : 0;
}

function rgbaFromHex(hex) {
    const rgba = new Gdk.RGBA();

    if (!rgba.parse(hex))
        rgba.parse('#3584e4');

    return rgba;
}

function rgbaToHex(rgba) {
    const channelToHex = value =>
        Math.round(
            Math.min(1, Math.max(0, value)) * 255
        )
            .toString(16)
            .padStart(2, '0');

    return (
        `#${channelToHex(rgba.red)}` +
        `${channelToHex(rgba.green)}` +
        `${channelToHex(rgba.blue)}`
    );
}

function rgbFromHex(hex) {
    const value = Number.parseInt(
        hex.replace('#', ''),
        16
    );

    return [
        ((value >> 16) & 0xff) / 255,
        ((value >> 8) & 0xff) / 255,
        (value & 0xff) / 255,
    ];
}

export default class RaySlashPreferences
    extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const settingsSignalIds = [];

        /*
         * Keeping the settings object on the window follows the standard
         * GNOME extension-preferences lifetime pattern.
         */
        window._settings = settings;
        window._rayslashSettingsSignalIds =
            settingsSignalIds;

        window.set_default_size(640, 720);

        const page = new Adw.PreferencesPage({
            title: 'RaySlash',
            icon_name:
                'applications-graphics-symbolic',
        });

        window.add(page);

        this._addBehaviorGroup(
            page,
            settings,
            settingsSignalIds
        );

        this._addAppearanceGroup(
            page,
            settings,
            settingsSignalIds
        );

        this._addMotionGroup(
            page,
            settings,
            settingsSignalIds
        );

        this._addMaintenanceGroup(
            page,
            settings
        );

        window.connect('close-request', () => {
            for (
                const signalId of
                window._rayslashSettingsSignalIds
            ) {
                if (signalId)
                    settings.disconnect(signalId);
            }

            window._rayslashSettingsSignalIds = [];
            window._settings = null;

            return false;
        });
    }

    _addBehaviorGroup(
        page,
        settings,
        settingsSignalIds
    ) {
        const group = new Adw.PreferencesGroup({
            title: 'Behavior',
            description:
                'Control when RaySlash draws and how much recent path remains visible.',
        });

        page.add(group);

        const enabledRow = new Adw.SwitchRow({
            title: 'Drawing enabled',
            subtitle:
                'Respond to primary-button drags that begin on exposed desktop space.',
        });

        group.add(enabledRow);

        settings.bind(
            'enabled',
            enabledRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        group.add(
            this._createComboRow(
                settings,
                settingsSignalIds,
                'trail-preset',
                'Active trail length',
                'Limits the visible path while the pointer button remains held.',
                TRAILS
            )
        );

        group.add(
            this._createComboRow(
                settings,
                settingsSignalIds,
                'timing-preset',
                'Release fade timing',
                'Controls how quickly the remaining ribbon disappears after release.',
                TIMINGS
            )
        );
    }

    _addAppearanceGroup(
        page,
        settings,
        settingsSignalIds
    ) {
        const group = new Adw.PreferencesGroup({
            title: 'Appearance',
            description:
                'Choose the ribbon color, thickness, and rendering effect.',
        });

        page.add(group);

        group.add(
            this._createComboRow(
                settings,
                settingsSignalIds,
                'color-mode',
                'Color source',
                'Use the GNOME accent color, a preset, or a custom color.',
                COLORS
            )
        );

        const presetRow = new Adw.ActionRow({
            title: 'Preset colors',
            subtitle:
                'Select a color from the GNOME accent palette.',
        });

        const presetBox = new Gtk.Box({
            orientation:
                Gtk.Orientation.HORIZONTAL,
            spacing: 3,
            valign: Gtk.Align.CENTER,
        });

        const presetButtons = new Map();

        for (
            const [value, label, hex] of
            PRESET_COLORS
        ) {
            const button =
                this._createColorSwatchButton(
                    settings,
                    value,
                    label,
                    hex
                );

            presetButtons.set(value, button);
            presetBox.append(button);
        }

        const updatePresetSelection = () => {
            const selected =
                settings.get_string(
                    'color-mode'
                );

            for (
                const [value, button] of
                presetButtons
            ) {
                if (value === selected) {
                    button.add_css_class(
                        'suggested-action'
                    );
                } else {
                    button.remove_css_class(
                        'suggested-action'
                    );
                }
            }
        };

        settingsSignalIds.push(
            settings.connect(
                'changed::color-mode',
                updatePresetSelection
            )
        );

        updatePresetSelection();

        presetRow.add_suffix(presetBox);
        group.add(presetRow);

        const customRow = new Adw.ActionRow({
            title: 'Custom color',
            subtitle:
                'Used when Color source is set to Custom color.',
        });

        const colorDialog =
            new Gtk.ColorDialog({
                title:
                    'Choose RaySlash color',
                with_alpha: false,
            });

        const colorButton =
            new Gtk.ColorDialogButton({
                dialog: colorDialog,
                valign: Gtk.Align.CENTER,
                tooltip_text:
                    'Choose a custom ribbon color',
            });

        colorButton.set_rgba(
            rgbaFromHex(
                settings.get_string(
                    'custom-color'
                )
            )
        );

        colorButton.connect(
            'notify::rgba',
            () => {
                const selectedHex =
                    rgbaToHex(
                        colorButton.get_rgba()
                    );

                if (
                    settings.get_string(
                        'custom-color'
                    ) !== selectedHex
                ) {
                    settings.set_string(
                        'custom-color',
                        selectedHex
                    );
                }
            }
        );

        settingsSignalIds.push(
            settings.connect(
                'changed::custom-color',
                () => {
                    const configured =
                        rgbaFromHex(
                            settings.get_string(
                                'custom-color'
                            )
                        );

                    if (
                        rgbaToHex(
                            colorButton.get_rgba()
                        ) !==
                        rgbaToHex(configured)
                    ) {
                        colorButton.set_rgba(
                            configured
                        );
                    }
                }
            )
        );

        const updateCustomSensitivity = () => {
            customRow.sensitive =
                settings.get_string(
                    'color-mode'
                ) === 'custom';
        };

        settingsSignalIds.push(
            settings.connect(
                'changed::color-mode',
                updateCustomSensitivity
            )
        );

        updateCustomSensitivity();

        customRow.add_suffix(colorButton);
        customRow.set_activatable_widget(
            colorButton
        );

        group.add(customRow);

        group.add(
            this._createComboRow(
                settings,
                settingsSignalIds,
                'size-preset',
                'Thickness',
                'Controls the minimum and maximum width of the slash.',
                SIZES
            )
        );

        group.add(
            this._createComboRow(
                settings,
                settingsSignalIds,
                'style',
                'Effect style',
                'Choose a layered blade, clean ribbon, neon glow, or dark shadow.',
                STYLES
            )
        );
    }

    _addMotionGroup(
        page,
        settings,
        settingsSignalIds
    ) {
        const group = new Adw.PreferencesGroup({
            title: 'Motion',
            description:
                'Tune how pointer movement changes the ribbon.',
        });

        page.add(group);

        group.add(
            this._createComboRow(
                settings,
                settingsSignalIds,
                'speed-response',
                'Speed response',
                'Controls how strongly faster pointer movement increases ribbon thickness.',
                SPEEDS
            )
        );
    }

    _addMaintenanceGroup(
        page,
        settings
    ) {
        const group = new Adw.PreferencesGroup({
            title: 'Maintenance',
        });

        page.add(group);

        const resetRow = new Adw.ActionRow({
            title: 'Reset all settings',
            subtitle:
                'Restore the default RaySlash configuration.',
        });

        const resetButton = new Gtk.Button({
            label: 'Reset',
            valign: Gtk.Align.CENTER,
            css_classes: [
                'destructive-action',
            ],
        });

        resetButton.connect(
            'clicked',
            () => {
                for (const key of RESET_KEYS)
                    settings.reset(key);
            }
        );

        resetRow.add_suffix(resetButton);

        resetRow.set_activatable_widget(
            resetButton
        );

        group.add(resetRow);
    }

    _createComboRow(
        settings,
        settingsSignalIds,
        key,
        title,
        subtitle,
        choices
    ) {
        const row = new Adw.ComboRow({
            title,
            subtitle,
            model: Gtk.StringList.new(
                choices.map(
                    ([, label]) => label
                )
            ),
            selected: indexOfValue(
                choices,
                settings.get_string(key)
            ),
        });

        row.connect(
            'notify::selected',
            () => {
                const [value] =
                    choices[row.selected] ??
                    choices[0];

                if (
                    settings.get_string(key) !==
                    value
                ) {
                    settings.set_string(
                        key,
                        value
                    );
                }
            }
        );

        settingsSignalIds.push(
            settings.connect(
                `changed::${key}`,
                () => {
                    const selected =
                        indexOfValue(
                            choices,
                            settings.get_string(key)
                        );

                    if (
                        row.selected !== selected
                    ) {
                        row.selected = selected;
                    }
                }
            )
        );

        return row;
    }

    _createColorSwatchButton(
        settings,
        value,
        label,
        hex
    ) {
        const swatch =
            new Gtk.DrawingArea({
                content_width: 18,
                content_height: 18,
            });

        const [red, green, blue] =
            rgbFromHex(hex);

        swatch.set_draw_func(
            (
                _area,
                context,
                width,
                height
            ) => {
                const radius =
                    Math.max(
                        1,
                        Math.min(
                            width,
                            height
                        ) / 2 - 1
                    );

                context.arc(
                    width / 2,
                    height / 2,
                    radius,
                    0,
                    Math.PI * 2
                );

                context.setSourceRGB(
                    red,
                    green,
                    blue
                );

                context.fillPreserve();

                context.setSourceRGBA(
                    0,
                    0,
                    0,
                    0.35
                );

                context.setLineWidth(1);
                context.stroke();
            }
        );

        const button = new Gtk.Button({
            child: swatch,
            width_request: 32,
            height_request: 32,
            valign: Gtk.Align.CENTER,
            tooltip_text: label,
            css_classes: [
                'flat',
                'circular',
            ],
        });

        button.connect(
            'clicked',
            () => {
                settings.set_string(
                    'color-mode',
                    value
                );
            }
        );

        return button;
    }
}
