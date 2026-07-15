// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Rayan (rayan6ms)

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FRAME_MS = 16;
const MIN_DISTANCE = 2.5;
const MAX_POINTS = 180;
const MAX_STROKES = 6;
const SMOOTH_PASSES = 2;

const PALETTE = Object.freeze({
    blue: '#3584e4', teal: '#2190a4', green: '#3a944a',
    yellow: '#c88800', orange: '#ed5b00', red: '#e62d42',
    pink: '#d56199', purple: '#9141ac', slate: '#6f8396',
});

const SIZES = Object.freeze({
    thin: {min: 2.75, max: 8.5, speed: 4, head: 38, tail: 50},
    medium: {min: 4.25, max: 13.5, speed: 6, head: 46, tail: 60},
    bold: {min: 6.5, max: 20, speed: 8.5, head: 54, tail: 72},
});

const TIMINGS = Object.freeze({
    quick: {body: 150, shadow: 270},
    balanced: {body: 240, shadow: 430},
    lingering: {body: 380, shadow: 680},
});

const TRAILS = Object.freeze({
    short: 240,
    balanced: 420,
    long: 650,
});

const SPEEDS = Object.freeze({
    steady: 0,
    responsive: 1,
    dynamic: 1.75,
});

const ACTIVE_LAYERS = Object.freeze({
    fruit: [
        ['full', 1.32, 'tail', 0.09, 'shadow'],
        ['middle', 1.17, 'bright', 0.11, 'body'],
        ['full', 1, 'accent', 0.18, 'body'],
        ['middle', 1, 'accent', 0.22, 'body'],
        ['recent', 0.96, 'accent', 0.34, 'body'],
        ['head', 0.62, 'bright', 0.42, 'body'],
        ['tip', 0.15, 'core', 0.72, 'body'],
    ],
    clean: [
        ['full', 1, 'accent', 0.22, 'body'],
        ['middle', 1, 'accent', 0.30, 'body'],
        ['recent', 1, 'accent', 0.38, 'body'],
        ['tip', 0.16, 'core', 0.58, 'body'],
    ],
    neon: [
        ['full', 1.55, 'accent', 0.07, 'body'],
        ['middle', 1.28, 'bright', 0.11, 'body'],
        ['recent', 0.76, 'accent', 0.72, 'body'],
        ['tip', 0.15, 'white', 0.72, 'body'],
    ],
    shadow: [
        ['full', 1.42, 'tail', 0.12, 'shadow'],
        ['middle', 1.20, 'tail', 0.13, 'shadow'],
        ['recent', 0.92, 'accent', 0.70, 'body'],
        ['tip', 0.12, 'core', 0.34, 'body'],
    ],
});

const COMPLETED_LAYERS = Object.freeze({
    fruit: [
        ['full', 1.28, 'tail', 0.20, 'shadow'],
        ['full', 1.14, 'bright', 0.16, 'body'],
        ['full', 1, 'accent', 0.80, 'body'],
        ['middle', 0.68, 'bright', 0.48, 'body'],
        ['head', 0.16, 'core', 0.72, 'body'],
    ],
    clean: [
        ['full', 1, 'accent', 0.88, 'body'],
        ['head', 0.18, 'core', 0.48, 'body'],
    ],
    neon: [
        ['full', 1.60, 'accent', 0.12, 'body'],
        ['full', 1.25, 'bright', 0.19, 'body'],
        ['full', 0.72, 'accent', 0.86, 'body'],
        ['head', 0.16, 'white', 0.70, 'body'],
    ],
    shadow: [
        ['full', 1.45, 'tail', 0.28, 'shadow'],
        ['full', 0.90, 'accent', 0.78, 'body'],
        ['head', 0.13, 'core', 0.36, 'body'],
    ],
});

const clamp = (value, minimum, maximum) =>
    Math.min(maximum, Math.max(minimum, value));

const lerp = (start, end, progress) =>
    start + (end - start) * progress;

const nowMs = () =>
    GLib.get_monotonic_time() / 1000;

const smoothStep = progress => {
    const value = clamp(progress, 0, 1);

    return value * value * (3 - 2 * value);
};

const easeOutCubic = progress =>
    1 - Math.pow(1 - clamp(progress, 0, 1), 3);

function hexToRgb(text) {
    const hex = /^#[0-9a-f]{6}$/i.test(text)
        ? text
        : '#3584e4';

    const value = Number.parseInt(hex.slice(1), 16);

    return [
        ((value >> 16) & 255) / 255,
        ((value >> 8) & 255) / 255,
        (value & 255) / 255,
    ];
}

function mixColor(first, second, amount) {
    return [
        lerp(first[0], second[0], amount),
        lerp(first[1], second[1], amount),
        lerp(first[2], second[2], amount),
    ];
}

function actorIsInside(actor, ancestor) {
    for (
        let depth = 0;
        actor && depth < 64;
        depth++
    ) {
        if (actor === ancestor)
            return true;

        try {
            actor = actor.get_parent();
        } catch {
            actor = null;
        }
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

function smoothOnce(points) {
    if (points.length < 2)
        return points.slice();

    const result = [{...points[0]}];

    for (
        let index = 0;
        index < points.length - 1;
        index++
    ) {
        result.push(
            interpolatePoint(
                points[index],
                points[index + 1],
                0.25
            )
        );

        result.push(
            interpolatePoint(
                points[index],
                points[index + 1],
                0.75
            )
        );
    }

    result.push({...points.at(-1)});

    return result;
}

function smoothPoints(points) {
    let result = points.map(point => ({
        ...point,
    }));

    for (
        let pass = 0;
        pass < SMOOTH_PASSES;
        pass++
    ) {
        result = smoothOnce(result);
    }

    return result;
}

function pointsSince(points, cutoff) {
    if (points.length < 2)
        return [];

    const index = points.findIndex(
        point => point.time >= cutoff
    );

    if (index < 0)
        return [];

    const result = [];

    if (index > 0) {
        const first = points[index - 1];
        const second = points[index];

        result.push(
            interpolatePoint(
                first,
                second,
                clamp(
                    (cutoff - first.time) /
                        Math.max(
                            1,
                            second.time - first.time
                        ),
                    0,
                    1
                )
            )
        );
    }

    for (
        let pointIndex = index;
        pointIndex < points.length;
        pointIndex++
    ) {
        result.push({
            ...points[pointIndex],
        });
    }

    return result;
}

function suffixByLength(points, fraction) {
    if (
        points.length < 2 ||
        fraction <= 0
    ) {
        return points.map(point => ({
            ...point,
        }));
    }

    const distances =
        new Array(points.length).fill(0);

    for (
        let index = 1;
        index < points.length;
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

    const total = distances.at(-1);

    if (total < 1) {
        return points.map(point => ({
            ...point,
        }));
    }

    const target =
        total * clamp(fraction, 0, 0.99);

    let index = 1;

    while (
        index < distances.length &&
        distances[index] < target
    ) {
        index++;
    }

    const first = points[index - 1];
    const second =
        points[Math.min(index, points.length - 1)];

    const segment = Math.max(
        0.001,
        distances[index] -
            distances[index - 1]
    );

    const result = [
        interpolatePoint(
            first,
            second,
            (target - distances[index - 1]) /
                segment
        ),
    ];

    for (
        let pointIndex = index;
        pointIndex < points.length;
        pointIndex++
    ) {
        result.push({
            ...points[pointIndex],
        });
    }

    return result;
}

export default class RaySlashExtension extends Extension {
    enable() {
        this._strokes = [];
        this._active = null;
        this._dragging = false;

        this._animationId = 0;
        this._eventId = 0;
        this._repaintId = 0;
        this._settingsId = 0;
        this._accentId = 0;
        this._monitorsId = 0;
        this._restackedId = 0;

        this._backgroundGroup =
            Main.layoutManager?._backgroundGroup ??
            null;

        this._windowGroup =
            global.window_group ?? null;

        if (
            !this._backgroundGroup ||
            !this._windowGroup
        ) {
            throw new Error(
                'RaySlash could not find the GNOME Shell background/window groups'
            );
        }

        this._settings = this.getSettings();

        this._interfaceSettings =
            new Gio.Settings({
                schema_id:
                    'org.gnome.desktop.interface',
            });

        this._reloadSettings();

        this._settingsId =
            this._settings.connect(
                'changed',
                () => {
                    this._reloadSettings();
                    this._drawing?.queue_repaint();
                }
            );

        this._accentId =
            this._interfaceSettings.connect(
                'changed::accent-color',
                () => {
                    if (
                        this._colorMode ===
                        'accent'
                    ) {
                        this._updateColors();
                        this._drawing
                            ?.queue_repaint();
                    }
                }
            );

        this._drawing =
            new St.DrawingArea({
                name: 'rayslashDrawingArea',
                reactive: false,
                can_focus: false,
            });

        this._repaintId =
            this._drawing.connect(
                'repaint',
                area => this._onRepaint(area)
            );

        this._windowGroup.add_child(
            this._drawing
        );

        this._restackDrawing();

        this._restackedId =
            global.display.connect(
                'restacked',
                () => this._restackDrawing()
            );

        this._resize();

        this._monitorsId =
            Main.layoutManager.connect(
                'monitors-changed',
                () => this._resize()
            );

        this._eventId =
            global.stage.connect(
                'captured-event',
                (_stage, event) =>
                    this._onEvent(event)
            );
    }

    disable() {
        if (this._eventId) {
            global.stage.disconnect(
                this._eventId
            );

            this._eventId = 0;
        }

        if (this._monitorsId) {
            Main.layoutManager.disconnect(
                this._monitorsId
            );

            this._monitorsId = 0;
        }

        if (this._restackedId) {
            global.display.disconnect(
                this._restackedId
            );

            this._restackedId = 0;
        }

        if (this._settingsId) {
            this._settings.disconnect(
                this._settingsId
            );

            this._settingsId = 0;
        }

        if (this._accentId) {
            this._interfaceSettings.disconnect(
                this._accentId
            );

            this._accentId = 0;
        }

        if (this._animationId) {
            GLib.Source.remove(
                this._animationId
            );

            this._animationId = 0;
        }

        if (this._drawing) {
            if (this._repaintId) {
                this._drawing.disconnect(
                    this._repaintId
                );

                this._repaintId = 0;
            }

            this._drawing.destroy();
        }

        this._strokes = [];
        this._active = null;
        this._dragging = false;

        this._drawing = null;
        this._settings = null;
        this._interfaceSettings = null;
        this._backgroundGroup = null;
        this._windowGroup = null;
    }

    _reloadSettings() {
        this._enabled =
            this._settings.get_boolean(
                'enabled'
            );

        this._colorMode =
            this._settings.get_string(
                'color-mode'
            );

        this._customColor =
            this._settings.get_string(
                'custom-color'
            );

        this._sizeName =
            this._settings.get_string(
                'size-preset'
            );

        this._styleName =
            this._settings.get_string(
                'style'
            );

        this._timingName =
            this._settings.get_string(
                'timing-preset'
            );

        this._trailName =
            this._settings.get_string(
                'trail-preset'
            );

        this._speedName =
            this._settings.get_string(
                'speed-response'
            );

        this._size =
            SIZES[this._sizeName] ??
            SIZES.thin;

        this._timing =
            TIMINGS[this._timingName] ??
            TIMINGS.balanced;

        this._trailMs =
            TRAILS[this._trailName] ??
            TRAILS.balanced;

        this._speedFactor =
            SPEEDS[this._speedName] ??
            SPEEDS.responsive;

        this._updateColors();

        if (!this._enabled)
            this._clear();
    }

    _updateColors() {
        let hex;

        if (this._colorMode === 'accent') {
            let name = 'blue';

            try {
                name =
                    this._interfaceSettings
                        .get_string(
                            'accent-color'
                        );
            } catch (error) {
                console.error(
                    `[${this.uuid}] could not read accent color: ` +
                    `${error.message}`
                );
            }

            hex =
                PALETTE[name] ??
                PALETTE.blue;
        } else if (
            this._colorMode === 'custom'
        ) {
            hex = this._customColor;
        } else {
            hex =
                PALETTE[this._colorMode] ??
                PALETTE.blue;
        }

        const accent = hexToRgb(hex);

        this._colors = {
            accent,
            bright: mixColor(
                accent,
                [1, 1, 1],
                0.24
            ),
            core: mixColor(
                accent,
                [1, 1, 1],
                0.72
            ),
            tail: mixColor(
                accent,
                [0.008, 0.010, 0.018],
                0.87
            ),
            white: [1, 1, 1],
        };
    }

    _clear() {
        this._strokes = [];
        this._active = null;
        this._dragging = false;
        this._drawing?.queue_repaint();
    }

    _restackDrawing() {
        if (
            !this._drawing ||
            !this._windowGroup ||
            !this._backgroundGroup ||
            this._drawing.get_parent() !==
                this._windowGroup
        ) {
            return;
        }

        this._windowGroup.set_child_above_sibling(
            this._drawing,
            this._backgroundGroup
        );
    }

    _resize() {
        if (!this._drawing)
            return;

        const [width, height] =
            global.stage.get_size();

        this._drawing.set_position(0, 0);
        this._drawing.set_size(
            width,
            height
        );

        this._drawing.queue_repaint();
        this._restackDrawing();
    }

    _isDesktop(x, y) {
        if (
            !this._enabled ||
            Main.overview.visible ||
            (
                Main.sessionMode?.isLocked ??
                false
            )
        ) {
            return false;
        }

        try {
            const actor =
                global.stage
                    .get_actor_at_pos(
                        Clutter.PickMode.REACTIVE,
                        Math.floor(x),
                        Math.floor(y)
                    );

            return actorIsInside(
                actor,
                this._backgroundGroup
            );
        } catch (error) {
            console.error(
                `[${this.uuid}] desktop actor pick failed: ` +
                `${error.message}`
            );

            return false;
        }
    }

    _onEvent(event) {
        const type = event.type();

        if (
            type ===
                Clutter.EventType.BUTTON_PRESS &&
            event.get_button() === 1
        ) {
            const [x, y] =
                event.get_coords();

            if (this._isDesktop(x, y))
                this._start(x, y);
            else
                this._cancel();
        } else if (
            type ===
                Clutter.EventType.MOTION &&
            this._dragging
        ) {
            const [x, y] =
                event.get_coords();

            if (
                Main.overview.visible ||
                (
                    Main.sessionMode?.isLocked ??
                    false
                )
            ) {
                this._finish();
            } else {
                this._append(x, y);
            }
        } else if (
            type ===
                Clutter.EventType.BUTTON_RELEASE &&
            event.get_button() === 1 &&
            this._dragging
        ) {
            const [x, y] =
                event.get_coords();

            this._append(x, y);
            this._finish();
        }

        return false;
    }

    _start(x, y) {
        const stroke = {
            points: [{
                x,
                y,
                width: this._size.min,
                time: nowMs(),
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

        this._active = stroke;
        this._dragging = true;
        this._ensureAnimation();
    }

    _cancel() {
        if (this._active) {
            const index =
                this._strokes.indexOf(
                    this._active
                );

            if (index >= 0)
                this._strokes.splice(index, 1);
        }

        this._active = null;
        this._dragging = false;
    }

    _finish() {
        if (!this._active)
            return;

        const time = nowMs();

        const points = pointsSince(
            this._active.points,
            time - this._trailMs
        );

        if (points.length < 2) {
            const index =
                this._strokes.indexOf(
                    this._active
                );

            if (index >= 0)
                this._strokes.splice(index, 1);
        } else {
            this._active.points = points;
            this._active.endedAt = time;
        }

        this._active = null;
        this._dragging = false;

        this._drawing?.queue_repaint();
        this._ensureAnimation();
    }

    _append(x, y) {
        if (!this._active)
            return;

        const points =
            this._active.points;

        const previous =
            points.at(-1);

        const time = nowMs();

        const elapsed = Math.max(
            1,
            time - previous.time
        );

        if (elapsed > this._trailMs) {
            this._active.points = [{
                x,
                y,
                width: this._size.min,
                time,
            }];

            this._drawing?.queue_repaint();
            return;
        }

        const distance = Math.hypot(
            x - previous.x,
            y - previous.y
        );

        if (distance < MIN_DISTANCE)
            return;

        const target = clamp(
            this._size.min +
                distance /
                    elapsed *
                    this._size.speed *
                    this._speedFactor,
            this._size.min,
            this._size.max
        );

        points.push({
            x,
            y,
            width: lerp(
                previous.width,
                target,
                0.28
            ),
            time,
        });

        this._trimActive(time);
        this._drawing?.queue_repaint();
        this._ensureAnimation();
    }

    _trimActive(time) {
        if (!this._active)
            return;

        const points =
            this._active.points;

        const cutoff =
            time - this._trailMs;

        while (
            points.length > 2 &&
            points[1].time < cutoff
        ) {
            points.shift();
        }

        if (points.length > MAX_POINTS) {
            const reduced = [points[0]];

            for (
                let index = 2;
                index < points.length - 1;
                index += 2
            ) {
                reduced.push(points[index]);
            }

            reduced.push(points.at(-1));
            this._active.points = reduced;
        }
    }

    _ensureAnimation() {
        if (this._animationId)
            return;

        this._animationId =
            GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                FRAME_MS,
                () => {
                    const time = nowMs();

                    this._trimActive(time);

                    const maxLifetime =
                        Math.max(
                            this._timing.body,
                            this._timing.shadow
                        );

                    this._strokes =
                        this._strokes.filter(
                            stroke =>
                                stroke ===
                                    this._active ||
                                (
                                    stroke.endedAt !==
                                        null &&
                                    time -
                                        stroke.endedAt <
                                        maxLifetime
                                )
                        );

                    this._drawing?.queue_repaint();

                    const activeVisible =
                        this._active &&
                        pointsSince(
                            this._active.points,
                            time -
                                this._trailMs
                        ).length >= 2;

                    const completedVisible =
                        this._strokes.some(
                            stroke =>
                                stroke !==
                                this._active
                        );

                    if (
                        !activeVisible &&
                        !completedVisible
                    ) {
                        this._animationId = 0;
                        return GLib.SOURCE_REMOVE;
                    }

                    return GLib.SOURCE_CONTINUE;
                }
            );
    }

    _fade(stroke, time, lifetime) {
        if (stroke.endedAt === null)
            return 1;

        const elapsed =
            time - stroke.endedAt;

        return elapsed >= lifetime
            ? 0
            : 1 -
                easeOutCubic(
                    elapsed / lifetime
                );
    }

    _sourcesForActive(stroke, time) {
        const source = fraction =>
            smoothPoints(
                pointsSince(
                    stroke.points,
                    time -
                        this._trailMs *
                            fraction
                )
            );

        const head = source(0.18);

        return {
            full: source(1),
            middle: source(0.68),
            recent: source(0.38),
            head,
            tip: suffixByLength(
                head,
                0.48
            ),
        };
    }

    _sourcesForCompleted(points) {
        return {
            full: points,
            middle: suffixByLength(
                points,
                0.30
            ),
            recent: suffixByLength(
                points,
                0.58
            ),
            head: suffixByLength(
                points,
                0.60
            ),
            tip: suffixByLength(
                points,
                0.78
            ),
        };
    }

    _onRepaint(area) {
        /*
         * Window creation and focus changes can reorder the window group.
         * Reassert the wallpaper-adjacent position before every visible
         * frame so application windows always remain above RaySlash.
         */
        this._restackDrawing();

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

            const time = nowMs();

            for (
                const stroke of this._strokes
            ) {
                if (stroke.points.length < 2)
                    continue;

                const active =
                    stroke === this._active;

                const sources = active
                    ? this._sourcesForActive(
                        stroke,
                        time
                    )
                    : this._sourcesForCompleted(
                        smoothPoints(
                            stroke.points
                        )
                    );

                const layers =
                    (
                        active
                            ? ACTIVE_LAYERS
                            : COMPLETED_LAYERS
                    )[this._styleName] ??
                    (
                        active
                            ? ACTIVE_LAYERS.fruit
                            : COMPLETED_LAYERS.fruit
                    );

                const bodyFade = active
                    ? 1
                    : this._fade(
                        stroke,
                        time,
                        this._timing.body
                    );

                const shadowFade = active
                    ? 1
                    : this._fade(
                        stroke,
                        time,
                        this._timing.shadow
                    );

                for (
                    const [
                        sourceName,
                        width,
                        colorName,
                        alpha,
                        fadeName,
                    ] of layers
                ) {
                    this._drawRibbon(
                        cr,
                        sources[sourceName] ?? [],
                        width,
                        this._colors[colorName],
                        alpha *
                            (
                                fadeName ===
                                    'shadow'
                                    ? shadowFade
                                    : bodyFade
                            )
                    );
                }
            }
        } finally {
            cr.$dispose();
        }
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

        const distances =
            new Array(points.length).fill(0);

        for (
            let index = 1;
            index < points.length;
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

        const total = distances.at(-1);

        if (total < 1)
            return;

        const headLength = Math.min(
            this._size.head,
            total * 0.48
        );

        const tailLength = Math.min(
            this._size.tail,
            total * 0.48
        );

        const left = [];
        const right = [];

        let normalX = 0;
        let normalY = 1;

        for (
            let index = 0;
            index < points.length;
            index++
        ) {
            const previous =
                points[
                    Math.max(0, index - 1)
                ];

            const next =
                points[
                    Math.min(
                        points.length - 1,
                        index + 1
                    )
                ];

            const tangentX =
                next.x - previous.x;

            const tangentY =
                next.y - previous.y;

            const length = Math.hypot(
                tangentX,
                tangentY
            );

            if (length > 0.001) {
                normalX =
                    -tangentY / length;

                normalY =
                    tangentX / length;
            }

            const taper = Math.min(
                smoothStep(
                    distances[index] /
                        Math.max(
                            1,
                            tailLength
                        )
                ),
                smoothStep(
                    (
                        total -
                        distances[index]
                    ) /
                        Math.max(
                            1,
                            headLength
                        )
                )
            );

            const half =
                points[index].width *
                widthMultiplier *
                taper /
                2;

            left.push({
                x:
                    points[index].x +
                    normalX * half,
                y:
                    points[index].y +
                    normalY * half,
            });

            right.push({
                x:
                    points[index].x -
                    normalX * half,
                y:
                    points[index].y -
                    normalY * half,
            });
        }

        cr.newPath();

        cr.moveTo(
            left[0].x,
            left[0].y
        );

        for (
            let index = 1;
            index < left.length;
            index++
        ) {
            cr.lineTo(
                left[index].x,
                left[index].y
            );
        }

        for (
            let index =
                right.length - 1;
            index >= 0;
            index--
        ) {
            cr.lineTo(
                right[index].x,
                right[index].y
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
