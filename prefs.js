import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const COLORS = [
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
];

const SIZES = [
    ['thin', 'Thin'],
    ['medium', 'Medium'],
    ['bold', 'Bold'],
];

const STYLES = [
    ['fruit', 'Fruit blade'],
    ['clean', 'Clean'],
    ['neon', 'Neon'],
    ['shadow', 'Shadow'],
];

const TIMINGS = [
    ['quick', 'Quick'],
    ['balanced', 'Balanced'],
    ['lingering', 'Lingering'],
];

const TRAILS = [
    ['short', 'Short'],
    ['balanced', 'Balanced'],
    ['long', 'Long'],
];

const SPEEDS = [
    ['steady', 'Steady width'],
    ['responsive', 'Responsive'],
    ['dynamic', 'Dynamic'],
];

const KEYS = [
    'enabled',
    'color-mode',
    'custom-color',
    'size-preset',
    'style',
    'timing-preset',
    'trail-preset',
    'speed-response',
];

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
    const channel = value =>
        Math.round(
            Math.min(
                1,
                Math.max(0, value)
            ) * 255
        )
            .toString(16)
            .padStart(2, '0');

    return `#${channel(rgba.red)}` +
        `${channel(rgba.green)}` +
        `${channel(rgba.blue)}`;
}

export default class RaySlashPreferences
    extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window._rayslashSettings = settings;
        window.set_default_size(620, 720);

        const page =
            new Adw.PreferencesPage({
                title: 'RaySlash',
                icon_name:
                    'applications-graphics-symbolic',
            });

        window.add(page);

        const behavior =
            new Adw.PreferencesGroup({
                title: 'Behavior',
                description:
                    'Control when RaySlash draws and how much recent path stays visible.',
            });

        page.add(behavior);

        const enabled =
            new Adw.SwitchRow({
                title: 'Drawing enabled',
                subtitle:
                    'Respond to primary-button drags that begin on empty desktop space.',
            });

        behavior.add(enabled);

        settings.bind(
            'enabled',
            enabled,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        behavior.add(
            this._combo(
                settings,
                'trail-preset',
                'Active trail length',
                'Limits the path while the button is held. Older path fades away continuously.',
                TRAILS
            )
        );

        behavior.add(
            this._combo(
                settings,
                'timing-preset',
                'Release fade timing',
                'How quickly the frozen ribbon disappears after release.',
                TIMINGS
            )
        );

        const appearance =
            new Adw.PreferencesGroup({
                title: 'Appearance',
                description:
                    'Choose the ribbon color, size, and effect.',
            });

        page.add(appearance);

        appearance.add(
            this._combo(
                settings,
                'color-mode',
                'Color source',
                'Use the GNOME accent, a preset color, or a custom color.',
                COLORS
            )
        );

        const customRow =
            new Adw.ActionRow({
                title: 'Custom color',
                subtitle:
                    'Used when Color source is Custom color.',
            });

        const dialog =
            new Gtk.ColorDialog({
                title:
                    'Choose RaySlash color',
                with_alpha: false,
            });

        const colorButton =
            new Gtk.ColorDialogButton({
                dialog,
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
                settings.set_string(
                    'custom-color',
                    rgbaToHex(
                        colorButton.get_rgba()
                    )
                );
            }
        );

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
        );

        const updateColorSensitivity =
            () => {
                customRow.sensitive =
                    settings.get_string(
                        'color-mode'
                    ) === 'custom';
            };

        settings.connect(
            'changed::color-mode',
            updateColorSensitivity
        );

        updateColorSensitivity();

        customRow.add_suffix(
            colorButton
        );

        customRow.activatable_widget =
            colorButton;

        appearance.add(customRow);

        appearance.add(
            this._combo(
                settings,
                'size-preset',
                'Thickness',
                'Thin is considerably smaller than the earlier prototype.',
                SIZES
            )
        );

        appearance.add(
            this._combo(
                settings,
                'style',
                'Effect style',
                'Fruit blade is layered; Clean is simple; Neon glows; Shadow emphasizes the afterimage.',
                STYLES
            )
        );

        const motion =
            new Adw.PreferencesGroup({
                title: 'Motion',
                description:
                    'Tune how pointer movement changes the blade.',
            });

        page.add(motion);

        motion.add(
            this._combo(
                settings,
                'speed-response',
                'Speed response',
                'Controls how strongly faster movement increases thickness.',
                SPEEDS
            )
        );

        const maintenance =
            new Adw.PreferencesGroup({
                title: 'Maintenance',
            });

        page.add(maintenance);

        const resetRow =
            new Adw.ActionRow({
                title: 'Reset all settings',
                subtitle:
                    'Restore the RaySlash defaults.',
            });

        const resetButton =
            new Gtk.Button({
                label: 'Reset',
                valign: Gtk.Align.CENTER,
                css_classes: [
                    'destructive-action',
                ],
            });

        resetButton.connect(
            'clicked',
            () => {
                for (const key of KEYS)
                    settings.reset(key);
            }
        );

        resetRow.add_suffix(
            resetButton
        );

        resetRow.activatable_widget =
            resetButton;

        maintenance.add(resetRow);
    }

    _combo(
        settings,
        key,
        title,
        subtitle,
        choices
    ) {
        const row =
            new Adw.ComboRow({
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
                const value =
                    (
                        choices[row.selected] ??
                        choices[0]
                    )[0];

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
        );

        return row;
    }
}
