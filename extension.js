import Cairo from 'cairo';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const FRAME_INTERVAL_MS = 16;
const MIN_POINT_DISTANCE = 2.5;
const MAX_POINTS_PER_STROKE = 240;
const MAX_STROKES = 8;
const SMOOTHING_PASSES = 2;

const ACCENT_COLORS = Object.freeze({
    blue: '#3584e4',
    teal: '#2190a4',
    green: '#3a944a',
    yellow: '#c88800',
    orange: '#ed5b00',
    red: '#e62d42',
    pink: '#d56199',
    purple: '#9141ac',
    slate: '#6f8396',
});

const COLOR_CHOICES = Object.freeze([
    {value: 'accent', label: 'System accent'},
    {value: 'blue', label: 'Blue'},
    {value: 'teal', label: 'Teal'},
    {value: 'green', label: 'Green'},
    {value: 'yellow', label: 'Yellow'},
    {value: 'orange', label: 'Orange'},
    {value: 'red', label: 'Red'},
    {value: 'pink', label: 'Pink'},
    {value: 'purple', label: 'Purple'},
    {value: 'slate', label: 'Slate'},
]);

const SIZE_CHOICES = Object.freeze([
    {value: 'thin', label: 'Thin'},
    {value: 'medium', label: 'Medium'},
    {value: 'bold', label: 'Bold'},
]);

const STYLE_CHOICES = Object.freeze([
    {value: 'fruit', label: 'Fruit blade'},
    {value: 'clean', label: 'Clean'},
    {value: 'neon', label: 'Neon'},
    {value: 'shadow', label: 'Shadow'},
]);

const TIMING_CHOICES = Object.freeze([
    {value: 'quick', label: 'Quick'},
    {value: 'balanced', label: 'Balanced'},
    {value: 'lingering', label: 'Lingering'},
]);

const SPEED_CHOICES = Object.freeze([
    {value: 'steady', label: 'Steady width'},
    {value: 'responsive', label: 'Responsive'},
    {value: 'dynamic', label: 'Dynamic'},
]);

const SIZE_PRESETS = Object.freeze({
    thin: {
        minWidth: 3.5,
        maxWidth: 11.5,
        speedWidth: 5.2,
        headTaper: 42,
        tailTaper: 58,
    },
    medium: {
        minWidth: 5.5,
        maxWidth: 17.5,
        speedWidth: 7.5,
        headTaper: 50,
        tailTaper: 68,
    },
    bold: {
        minWidth: 8,
        maxWidth: 25,
        speedWidth: 10,
        headTaper: 58,
        tailTaper: 78,
    },
});

const TIMING_PRESETS = Object.freeze({
    quick: {
        bodyLifetime: 170,
        shadowLifetime: 300,
    },
    balanced: {
        bodyLifetime: 260,
        shadowLifetime: 470,
    },
    lingering: {
        bodyLifetime: 390,
        shadowLifetime: 720,
    },
});

const SPEED_PRESETS = Object.freeze({
    steady: 0,
    responsive: 1,
    dynamic: 1.75,
});

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function lerp(start, end, progress) {
    return start + (end - start) * progress;
}

function smoothStep(progress) {
    const value = clamp(progress, 0, 1);

    return value * value * (3 - 2 * value);
}

function easeOutCubic(progress) {
    const value = clamp(progress, 0, 1);

    return 1 - Math.pow(1 - value, 3);
}

function monotonicMilliseconds() {
    return GLib.get_monotonic_time() / 1000;
}

function hexToRgb(hex) {
    const value = Number.parseInt(hex.slice(1), 16);

    return [
        ((value >> 16) & 0xff) / 255,
        ((value >> 8) & 0xff) / 255,
        (value & 0xff) / 255,
    ];
}

function mixColor(first, second, amount) {
    return [
        lerp(first[0], second[0], amount),
        lerp(first[1], second[1], amount),
        lerp(first[2], second[2], amount),
    ];
}

function getParent(actor) {
    if (!actor)
        return null;

    try {
        return actor.get_parent();
    } catch {
        return null;
    }
}

function actorIsInside(actor, possibleAncestor) {
    if (!actor || !possibleAncestor)
        return false;

    let current = actor;

    for (let depth = 0; current && depth < 64; depth++) {
        if (current === possibleAncestor)
            return true;

        current = getParent(current);
    }

    return false;
}

function interpolatePoint(first, second, progress) {
    return {
        x: lerp(first.x, second.x, progress),
        y: lerp(first.y, second.y, progress),
        width: lerp(first.width, second.width, progress),
        time: lerp(first.time, second.time, progress),
    };
}

function smoothPointsOnce(points) {
    if (points.length < 2)
        return points.slice();

    const result = [{...points[0]}];

    for (let index = 0; index < points.length - 1; index++) {
        const first = points[index];
        const second = points[index + 1];

        result.push(interpolatePoint(first, second, 0.25));
        result.push(interpolatePoint(first, second, 0.75));
    }

    result.push({...points[points.length - 1]});

    return result;
}

function smoothPoints(points, passes) {
    let result = points.map(point => ({...point}));

    for (let pass = 0; pass < passes; pass++)
        result = smoothPointsOnce(result);

    return result;
}

function pointAtDistance(points, distances, targetDistance) {
    if (targetDistance <= 0)
        return {...points[0]};

    const totalLength = distances[distances.length - 1];

    if (targetDistance >= totalLength)
        return {...points[points.length - 1]};

    for (let index = 1; index < distances.length; index++) {
        if (distances[index] < targetDistance)
            continue;

        const previousDistance = distances[index - 1];
        const segmentLength = Math.max(
            0.001,
            distances[index] - previousDistance
        );

        const progress =
            (targetDistance - previousDistance) /
            segmentLength;

        return interpolatePoint(
            points[index - 1],
            points[index],
            progress
        );
    }

    return {...points[points.length - 1]};
}

function pointsFromLengthFraction(points, startFraction) {
    if (points.length < 2)
        return [];

    const distances = new Array(points.length).fill(0);

    for (let index = 1; index < points.length; index++) {
        distances[index] =
            distances[index - 1] +
            Math.hypot(
                points[index].x - points[index - 1].x,
                points[index].y - points[index - 1].y
            );
    }

    const totalLength = distances[distances.length - 1];

    if (totalLength < 1)
        return points.map(point => ({...point}));

    const startDistance =
        totalLength *
        clamp(startFraction, 0, 0.99);

    const result = [
        pointAtDistance(points, distances, startDistance),
    ];

    for (let index = 0; index < points.length; index++) {
        if (distances[index] > startDistance)
            result.push({...points[index]});
    }

    return result;
}

export default class RaySlashExtension extends Extension {
    enable() {
        this._strokes = [];
        this._activeStroke = null;
        this._dragging = false;

        this._animationSourceId = 0;
        this._capturedEventId = 0;
        this._repaintId = 0;
        this._accentChangedId = 0;
        this._settingsChangedId = 0;
        this._monitorsChangedId = 0;

        this._choiceItems = new Map();
        this._choiceSubmenus = new Map();

        this._backgroundGroup =
            Main.layoutManager?._backgroundGroup ?? null;

        this._windowGroup =
            global.window_group ?? null;

        if (!this._backgroundGroup || !this._windowGroup) {
            throw new Error(
                'RaySlash could not find the GNOME Shell ' +
                'background/window groups'
            );
        }

        this._settings = this.getSettings();

        this._interfaceSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });

        this._reloadConfiguration();

        this._settingsChangedId = this._settings.connect(
            'changed',
            () => {
                this._reloadConfiguration();
                this._syncMenu();
                this._drawingArea?.queue_repaint();
            }
        );

        this._accentChangedId =
            this._interfaceSettings.connect(
                'changed::accent-color',
                () => {
                    if (this._colorMode !== 'accent')
                        return;

                    this._updateColors();
                    this._drawingArea?.queue_repaint();
                }
            );

        this._drawingArea = new St.DrawingArea({
            name: 'rayslashDrawingArea',
            reactive: false,
            can_focus: false,
        });

        this._repaintId = this._drawingArea.connect(
            'repaint',
            area => this._onRepaint(area)
        );

        this._windowGroup.add_child(this._drawingArea);

        this._windowGroup.set_child_above_sibling(
            this._drawingArea,
            this._backgroundGroup
        );

        this._resizeDrawingArea();

        this._monitorsChangedId =
            Main.layoutManager.connect(
                'monitors-changed',
                () => this._resizeDrawingArea()
            );

        this._capturedEventId = global.stage.connect(
            'captured-event',
            (_stage, event) =>
                this._onCapturedEvent(event)
        );

        this._createIndicator();

        console.log(
            `[${this.uuid}] configurable ribbon enabled ` +
            `color=${this._colorMode} ` +
            `size=${this._sizeName} ` +
            `style=${this._styleName} ` +
            `timing=${this._timingName} ` +
            'stack=above-background-below-windows'
        );

        Main.notify(
            this.metadata.name,
            'Configurable ribbon enabled. ' +
            'Use the top-bar menu to tune it.'
        );
    }

    disable() {
        if (this._capturedEventId) {
            global.stage.disconnect(
                this._capturedEventId
            );

            this._capturedEventId = 0;
        }

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(
                this._monitorsChangedId
            );

            this._monitorsChangedId = 0;
        }

        if (
            this._settingsChangedId &&
            this._settings
        ) {
            this._settings.disconnect(
                this._settingsChangedId
            );

            this._settingsChangedId = 0;
        }

        if (
            this._accentChangedId &&
            this._interfaceSettings
        ) {
            this._interfaceSettings.disconnect(
                this._accentChangedId
            );

            this._accentChangedId = 0;
        }

        if (this._animationSourceId) {
            GLib.Source.remove(
                this._animationSourceId
            );

            this._animationSourceId = 0;
        }

        this._indicator?.destroy();
        this._indicator = null;
        this._indicatorIcon = null;
        this._enabledMenuItem = null;

        this._choiceItems.clear();
        this._choiceSubmenus.clear();

        if (this._drawingArea) {
            if (this._repaintId) {
                this._drawingArea.disconnect(
                    this._repaintId
                );

                this._repaintId = 0;
            }

            this._drawingArea.destroy();
            this._drawingArea = null;
        }

        this._strokes = [];
        this._activeStroke = null;
        this._dragging = false;

        this._backgroundGroup = null;
        this._windowGroup = null;
        this._settings = null;
        this._interfaceSettings = null;

        console.log(
            `[${this.uuid}] configurable ribbon disabled`
        );
    }

    _reloadConfiguration() {
        this._featureEnabled =
            this._settings.get_boolean('enabled');

        this._colorMode =
            this._settings.get_string('color-mode');

        this._sizeName =
            this._settings.get_string('size-preset');

        this._styleName =
            this._settings.get_string('style');

        this._timingName =
            this._settings.get_string('timing-preset');

        this._speedName =
            this._settings.get_string('speed-response');

        this._size =
            SIZE_PRESETS[this._sizeName] ??
            SIZE_PRESETS.thin;

        this._timing =
            TIMING_PRESETS[this._timingName] ??
            TIMING_PRESETS.balanced;

        this._speedResponse =
            SPEED_PRESETS[this._speedName] ??
            SPEED_PRESETS.responsive;

        this._updateColors();

        if (!this._featureEnabled)
            this._clearStrokes();
    }

    _updateColors() {
        let colorName = this._colorMode;

        if (colorName === 'accent') {
            try {
                colorName =
                    this._interfaceSettings.get_string(
                        'accent-color'
                    );
            } catch (error) {
                console.error(
                    `[${this.uuid}] could not read ` +
                    `accent color: ${error.message}`
                );

                colorName = 'blue';
            }
        }

        const hex =
            ACCENT_COLORS[colorName] ??
            ACCENT_COLORS.blue;

        const accent = hexToRgb(hex);

        this._accentName = colorName;
        this._accentColor = accent;

        this._accentBrightColor = mixColor(
            accent,
            [1, 1, 1],
            0.23
        );

        this._accentCoreColor = mixColor(
            accent,
            [1, 1, 1],
            0.72
        );

        this._tailColor = mixColor(
            accent,
            [0.008, 0.010, 0.018],
            0.87
        );
    }

    _createIndicator() {
        this._indicator = new PanelMenu.Button(
            0,
            this.metadata.name,
            false
        );

        this._indicatorIcon = new St.Icon({
            icon_name: 'selection-mode-symbolic',
            style_class: 'system-status-icon',
        });

        this._indicator.add_child(
            this._indicatorIcon
        );

        Main.panel.addToStatusArea(
            this.uuid,
            this._indicator
        );

        this._enabledMenuItem =
            new PopupMenu.PopupSwitchMenuItem(
                'Drawing enabled',
                this._featureEnabled
            );

        this._enabledMenuItem.connect(
            'toggled',
            (_item, state) => {
                this._settings.set_boolean(
                    'enabled',
                    state
                );
            }
        );

        this._indicator.menu.addMenuItem(
            this._enabledMenuItem
        );

        this._indicator.menu.addMenuItem(
            new PopupMenu.PopupSeparatorMenuItem()
        );

        this._addChoiceSubmenu(
            'Color',
            'preferences-color-symbolic',
            'color-mode',
            COLOR_CHOICES
        );

        this._addChoiceSubmenu(
            'Thickness',
            'format-line-spacing-symbolic',
            'size-preset',
            SIZE_CHOICES
        );

        this._addChoiceSubmenu(
            'Style',
            'applications-graphics-symbolic',
            'style',
            STYLE_CHOICES
        );

        this._addChoiceSubmenu(
            'Fade timing',
            'preferences-system-time-symbolic',
            'timing-preset',
            TIMING_CHOICES
        );

        this._addChoiceSubmenu(
            'Speed response',
            'speedometer-symbolic',
            'speed-response',
            SPEED_CHOICES
        );

        this._indicator.menu.addMenuItem(
            new PopupMenu.PopupSeparatorMenuItem()
        );

        this._indicator.menu.addAction(
            'Clear trails',
            () => this._clearStrokes(),
            'edit-clear-all-symbolic'
        );

        this._indicator.menu.addAction(
            'Reset presets',
            () => {
                for (const key of [
                    'enabled',
                    'color-mode',
                    'size-preset',
                    'style',
                    'timing-preset',
                    'speed-response',
                ]) {
                    this._settings.reset(key);
                }
            },
            'edit-undo-symbolic'
        );

        this._syncMenu();
    }

    _addChoiceSubmenu(
        title,
        iconName,
        settingKey,
        choices
    ) {
        const submenu =
            new PopupMenu.PopupSubMenuMenuItem(
                title,
                true
            );

        submenu.icon.icon_name = iconName;

        this._choiceSubmenus.set(settingKey, {
            submenu,
            title,
            choices,
        });

        const items = new Map();

        for (const choice of choices) {
            const item =
                new PopupMenu.PopupMenuItem(
                    choice.label
                );

            item.connect('activate', () => {
                this._settings.set_string(
                    settingKey,
                    choice.value
                );
            });

            submenu.menu.addMenuItem(item);
            items.set(choice.value, item);
        }

        this._choiceItems.set(settingKey, items);

        this._indicator.menu.addMenuItem(
            submenu
        );
    }

    _syncMenu() {
        if (!this._indicator)
            return;

        if (
            this._enabledMenuItem?.state !==
            this._featureEnabled
        ) {
            this._enabledMenuItem?.setToggleState(
                this._featureEnabled
            );
        }

        this._indicatorIcon.opacity =
            this._featureEnabled ? 255 : 110;

        const currentValues = new Map([
            ['color-mode', this._colorMode],
            ['size-preset', this._sizeName],
            ['style', this._styleName],
            ['timing-preset', this._timingName],
            ['speed-response', this._speedName],
        ]);

        for (
            const [key, details]
            of this._choiceSubmenus
        ) {
            const selectedValue =
                currentValues.get(key);

            const selectedChoice =
                details.choices.find(
                    choice =>
                        choice.value ===
                        selectedValue
                );

            details.submenu.label.text =
                selectedChoice
                    ? `${details.title}: ` +
                      selectedChoice.label
                    : details.title;

            for (
                const [value, item]
                of this._choiceItems.get(key)
            ) {
                item.setOrnament(
                    value === selectedValue
                        ? PopupMenu.Ornament.DOT
                        : PopupMenu.Ornament.NONE
                );
            }
        }
    }

    _clearStrokes() {
        this._strokes = [];
        this._activeStroke = null;
        this._dragging = false;

        this._drawingArea?.queue_repaint();
    }

    _resizeDrawingArea() {
        if (!this._drawingArea)
            return;

        const [width, height] =
            global.stage.get_size();

        this._drawingArea.set_position(0, 0);
        this._drawingArea.set_size(width, height);
        this._drawingArea.queue_repaint();
    }

    _isEmptyDesktopAt(x, y) {
        if (!this._featureEnabled)
            return false;

        if (Main.overview.visible)
            return false;

        if (Main.sessionMode?.isLocked ?? false)
            return false;

        let actor = null;

        try {
            actor =
                global.stage.get_actor_at_pos(
                    Clutter.PickMode.REACTIVE,
                    Math.floor(x),
                    Math.floor(y)
                );
        } catch (error) {
            console.error(
                `[${this.uuid}] desktop actor ` +
                `pick failed: ${error.message}`
            );

            return false;
        }

        return actorIsInside(
            actor,
            this._backgroundGroup
        );
    }

    _onCapturedEvent(event) {
        const eventType = event.type();

        if (
            eventType ===
            Clutter.EventType.BUTTON_PRESS
        ) {
            if (event.get_button() !== 1)
                return false;

            const [x, y] = event.get_coords();

            if (this._isEmptyDesktopAt(x, y))
                this._startStroke(x, y);
            else
                this._cancelActiveStroke();
        } else if (
            eventType ===
                Clutter.EventType.MOTION &&
            this._dragging
        ) {
            const [x, y] = event.get_coords();

            if (
                Main.overview.visible ||
                (Main.sessionMode?.isLocked ?? false)
            ) {
                this._finishStroke(
                    'shell mode changed'
                );

                return false;
            }

            this._appendPoint(x, y);
        } else if (
            eventType ===
            Clutter.EventType.BUTTON_RELEASE
        ) {
            if (event.get_button() !== 1)
                return false;

            if (this._dragging) {
                const [x, y] =
                    event.get_coords();

                this._appendPoint(x, y);

                this._finishStroke(
                    'button release'
                );
            }
        }

        return false;
    }

    _startStroke(x, y) {
        const now = monotonicMilliseconds();

        const stroke = {
            points: [{
                x,
                y,
                width: this._size.minWidth,
                time: now,
            }],
            endedAt: null,
        };

        this._strokes.push(stroke);

        if (
            this._strokes.length >
            MAX_STROKES
        ) {
            this._strokes.splice(
                0,
                this._strokes.length -
                    MAX_STROKES
            );
        }

        this._activeStroke = stroke;
        this._dragging = true;
    }

    _cancelActiveStroke() {
        this._activeStroke = null;
        this._dragging = false;
    }

    _finishStroke(reason) {
        const stroke = this._activeStroke;

        if (!stroke) {
            this._dragging = false;
            return;
        }

        if (stroke.points.length < 2) {
            const index =
                this._strokes.indexOf(stroke);

            if (index >= 0)
                this._strokes.splice(index, 1);
        } else {
            stroke.endedAt =
                monotonicMilliseconds();

            this._ensureAnimationSource();
        }

        console.log(
            `[${this.uuid}] ribbon ended ` +
            `reason=${JSON.stringify(reason)} ` +
            `points=${stroke.points.length}`
        );

        this._activeStroke = null;
        this._dragging = false;

        this._drawingArea?.queue_repaint();
    }

    _appendPoint(x, y) {
        const stroke = this._activeStroke;

        if (!stroke)
            return;

        const points = stroke.points;
        const previous =
            points[points.length - 1];

        const now = monotonicMilliseconds();

        const dx = x - previous.x;
        const dy = y - previous.y;
        const distance = Math.hypot(dx, dy);

        if (distance < MIN_POINT_DISTANCE)
            return;

        const elapsed =
            Math.max(
                1,
                now - previous.time
            );

        const speed = distance / elapsed;

        const speedContribution =
            speed *
            this._size.speedWidth *
            this._speedResponse;

        const targetWidth = clamp(
            this._size.minWidth +
                speedContribution,
            this._size.minWidth,
            this._size.maxWidth
        );

        const width = lerp(
            previous.width,
            targetWidth,
            0.28
        );

        points.push({
            x,
            y,
            width,
            time: now,
        });

        if (
            points.length >
            MAX_POINTS_PER_STROKE
        ) {
            this._decimateStroke(stroke);
        }

        this._drawingArea?.queue_repaint();
    }

    _decimateStroke(stroke) {
        const points = stroke.points;
        const reduced = [points[0]];

        for (
            let index = 2;
            index < points.length - 1;
            index += 2
        ) {
            reduced.push(points[index]);
        }

        reduced.push(
            points[points.length - 1]
        );

        stroke.points = reduced;
    }

    _ensureAnimationSource() {
        if (this._animationSourceId)
            return;

        this._animationSourceId =
            GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                FRAME_INTERVAL_MS,
                () => {
                    const now =
                        monotonicMilliseconds();

                    this._pruneStrokes(now);

                    this._drawingArea
                        ?.queue_repaint();

                    if (
                        this._strokes.every(
                            stroke =>
                                stroke.endedAt ===
                                null
                        ) ||
                        this._strokes.length === 0
                    ) {
                        this._animationSourceId = 0;

                        return GLib.SOURCE_REMOVE;
                    }

                    return GLib.SOURCE_CONTINUE;
                }
            );
    }

    _pruneStrokes(now) {
        const maximumLifetime = Math.max(
            this._timing.bodyLifetime,
            this._timing.shadowLifetime
        );

        this._strokes =
            this._strokes.filter(stroke => {
                if (
                    stroke === this._activeStroke ||
                    stroke.endedAt === null
                ) {
                    return true;
                }

                return (
                    now - stroke.endedAt <
                    maximumLifetime
                );
            });
    }

    _fadeForStroke(stroke, now, lifetime) {
        if (stroke.endedAt === null)
            return 1;

        const elapsed =
            now - stroke.endedAt;

        if (elapsed >= lifetime)
            return 0;

        const progress = elapsed / lifetime;

        return 1 - easeOutCubic(progress);
    }

    _onRepaint(area) {
        const cr = area.get_context();

        try {
            cr.setOperator(
                Cairo.Operator.CLEAR
            );

            cr.paint();

            cr.setOperator(
                Cairo.Operator.OVER
            );

            cr.setAntialias(
                Cairo.Antialias.BEST
            );

            const now =
                monotonicMilliseconds();

            for (const stroke of this._strokes) {
                if (stroke.points.length < 2)
                    continue;

                const smoothed = smoothPoints(
                    stroke.points,
                    SMOOTHING_PASSES
                );

                this._drawConfiguredStyle(
                    cr,
                    smoothed,
                    stroke,
                    now
                );
            }
        } finally {
            cr.$dispose();
        }
    }

    _drawConfiguredStyle(
        cr,
        points,
        stroke,
        now
    ) {
        const bodyFade =
            this._fadeForStroke(
                stroke,
                now,
                this._timing.bodyLifetime
            );

        const shadowFade =
            this._fadeForStroke(
                stroke,
                now,
                this._timing.shadowLifetime
            );

        switch (this._styleName) {
        case 'clean':
            this._drawCleanStyle(
                cr,
                points,
                bodyFade
            );

            break;

        case 'neon':
            this._drawNeonStyle(
                cr,
                points,
                bodyFade
            );

            break;

        case 'shadow':
            this._drawShadowStyle(
                cr,
                points,
                bodyFade,
                shadowFade
            );

            break;

        case 'fruit':
        default:
            this._drawFruitStyle(
                cr,
                points,
                bodyFade,
                shadowFade
            );

            break;
        }
    }

    _drawFruitStyle(
        cr,
        points,
        bodyFade,
        shadowFade
    ) {
        this._drawRibbon(
            cr,
            points,
            1.30,
            this._tailColor,
            0.22 * shadowFade
        );

        this._drawRibbon(
            cr,
            points,
            1.16,
            this._accentBrightColor,
            0.18 * bodyFade
        );

        this._drawRibbon(
            cr,
            points,
            1,
            this._accentColor,
            0.82 * bodyFade
        );

        this._drawRibbon(
            cr,
            pointsFromLengthFraction(
                points,
                0.28
            ),
            0.72,
            this._accentBrightColor,
            0.52 * bodyFade
        );

        this._drawRibbon(
            cr,
            pointsFromLengthFraction(
                points,
                0.58
            ),
            0.19,
            this._accentCoreColor,
            0.76 * bodyFade
        );
    }

    _drawCleanStyle(
        cr,
        points,
        bodyFade
    ) {
        this._drawRibbon(
            cr,
            points,
            1,
            this._accentColor,
            0.88 * bodyFade
        );

        this._drawRibbon(
            cr,
            pointsFromLengthFraction(
                points,
                0.46
            ),
            0.18,
            this._accentCoreColor,
            0.48 * bodyFade
        );
    }

    _drawNeonStyle(
        cr,
        points,
        bodyFade
    ) {
        this._drawRibbon(
            cr,
            points,
            1.70,
            this._accentColor,
            0.13 * bodyFade
        );

        this._drawRibbon(
            cr,
            points,
            1.30,
            this._accentBrightColor,
            0.21 * bodyFade
        );

        this._drawRibbon(
            cr,
            points,
            0.72,
            this._accentColor,
            0.88 * bodyFade
        );

        this._drawRibbon(
            cr,
            pointsFromLengthFraction(
                points,
                0.38
            ),
            0.16,
            [1, 1, 1],
            0.72 * bodyFade
        );
    }

    _drawShadowStyle(
        cr,
        points,
        bodyFade,
        shadowFade
    ) {
        this._drawRibbon(
            cr,
            points,
            1.55,
            this._tailColor,
            0.30 * shadowFade
        );

        this._drawRibbon(
            cr,
            points,
            0.90,
            this._accentColor,
            0.80 * bodyFade
        );

        this._drawRibbon(
            cr,
            pointsFromLengthFraction(
                points,
                0.55
            ),
            0.13,
            this._accentCoreColor,
            0.38 * bodyFade
        );
    }

    _drawRibbon(
        cr,
        points,
        widthMultiplier,
        color,
        alpha
    ) {
        if (
            points.length < 2 ||
            alpha <= 0
        ) {
            return;
        }

        const count = points.length;

        const distances =
            new Array(count).fill(0);

        for (
            let index = 1;
            index < count;
            index++
        ) {
            distances[index] =
                distances[index - 1] +
                Math.hypot(
                    points[index].x -
                        points[index - 1].x,
                    points[index].y -
                        points[index - 1].y
                );
        }

        const totalLength =
            distances[count - 1];

        if (totalLength < 1)
            return;

        const headTaperLength = Math.min(
            this._size.headTaper,
            totalLength * 0.48
        );

        const tailTaperLength = Math.min(
            this._size.tailTaper,
            totalLength * 0.48
        );

        const leftEdge = [];
        const rightEdge = [];

        let previousNormalX = 0;
        let previousNormalY = 1;

        for (
            let index = 0;
            index < count;
            index++
        ) {
            const previous =
                points[
                    Math.max(0, index - 1)
                ];

            const next =
                points[
                    Math.min(
                        count - 1,
                        index + 1
                    )
                ];

            const tangentX =
                next.x - previous.x;

            const tangentY =
                next.y - previous.y;

            const tangentLength =
                Math.hypot(
                    tangentX,
                    tangentY
                );

            let normalX = previousNormalX;
            let normalY = previousNormalY;

            if (tangentLength > 0.001) {
                normalX =
                    -tangentY /
                    tangentLength;

                normalY =
                    tangentX /
                    tangentLength;

                previousNormalX = normalX;
                previousNormalY = normalY;
            }

            const distanceFromTail =
                distances[index];

            const distanceFromHead =
                totalLength -
                distances[index];

            const tailTaper = smoothStep(
                distanceFromTail /
                    Math.max(
                        1,
                        tailTaperLength
                    )
            );

            const headTaper = smoothStep(
                distanceFromHead /
                    Math.max(
                        1,
                        headTaperLength
                    )
            );

            const halfWidth =
                points[index].width *
                widthMultiplier *
                Math.min(
                    tailTaper,
                    headTaper
                ) /
                2;

            leftEdge.push({
                x:
                    points[index].x +
                    normalX * halfWidth,
                y:
                    points[index].y +
                    normalY * halfWidth,
            });

            rightEdge.push({
                x:
                    points[index].x -
                    normalX * halfWidth,
                y:
                    points[index].y -
                    normalY * halfWidth,
            });
        }

        cr.newPath();

        cr.moveTo(
            leftEdge[0].x,
            leftEdge[0].y
        );

        for (
            let index = 1;
            index < leftEdge.length;
            index++
        ) {
            cr.lineTo(
                leftEdge[index].x,
                leftEdge[index].y
            );
        }

        for (
            let index =
                rightEdge.length - 1;
            index >= 0;
            index--
        ) {
            cr.lineTo(
                rightEdge[index].x,
                rightEdge[index].y
            );
        }

        cr.closePath();

        cr.setSourceRGBA(
            color[0],
            color[1],
            color[2],
            alpha
        );

        cr.fill();
    }
}
