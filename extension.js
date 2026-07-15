import Cairo from 'cairo';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const FRAME_INTERVAL_MS = 16;
const MAIN_LIFETIME_MS = 270;
const TAIL_LIFETIME_MS = 760;

const MIN_POINT_DISTANCE = 3;
const MAX_POINTS_PER_STROKE = 112;
const MAX_STROKES = 6;
const SMOOTHING_PASSES = 2;

const MIN_BLADE_WIDTH = 8;
const MAX_BLADE_WIDTH = 30;
const WIDTH_SPEED_MULTIPLIER = 12;
const WIDTH_SMOOTHING = 0.32;

const HEAD_TAPER_LENGTH = 58;
const TAIL_TAPER_LENGTH = 72;

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

const DARK_TAIL_WINDOWS = Object.freeze([
    {minAge: 35, maxAge: 760, width: 1.70, alpha: 0.070},
    {minAge: 65, maxAge: 600, width: 1.58, alpha: 0.080},
    {minAge: 100, maxAge: 470, width: 1.48, alpha: 0.090},
    {minAge: 145, maxAge: 350, width: 1.38, alpha: 0.105},
]);

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

function pointsInTimeWindow(points, startTime, endTime) {
    if (points.length < 2 || endTime <= startTime)
        return [];

    const firstTime = points[0].time;
    const lastTime = points[points.length - 1].time;

    if (lastTime < startTime || firstTime > endTime)
        return [];

    const result = [];

    for (let index = 0; index < points.length - 1; index++) {
        const first = points[index];
        const second = points[index + 1];

        if (second.time < startTime)
            continue;

        if (first.time > endTime)
            break;

        if (result.length === 0) {
            if (startTime > first.time && startTime < second.time) {
                const duration = Math.max(1, second.time - first.time);

                result.push(interpolatePoint(
                    first,
                    second,
                    (startTime - first.time) / duration
                ));
            } else if (first.time >= startTime) {
                result.push({...first});
            }
        }

        if (second.time <= endTime) {
            result.push({...second});
            continue;
        }

        if (endTime > first.time && endTime < second.time) {
            const duration = Math.max(1, second.time - first.time);

            result.push(interpolatePoint(
                first,
                second,
                (endTime - first.time) / duration
            ));
        }

        break;
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
        this._monitorsChangedId = 0;

        this._backgroundGroup =
            Main.layoutManager?._backgroundGroup ?? null;

        this._windowGroup = global.window_group ?? null;

        if (!this._backgroundGroup || !this._windowGroup) {
            throw new Error(
                'RaySlash could not find the GNOME Shell background/window groups'
            );
        }

        this._interfaceSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });

        this._updateAccentColors();

        this._accentChangedId = this._interfaceSettings.connect(
            'changed::accent-color',
            () => {
                this._updateAccentColors();
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

        /*
         * Put RaySlash immediately above the desktop backgrounds, inside
         * Mutter's window group. Normal windows remain above this actor, so
         * the blade is visible on wallpaper but is naturally occluded by apps.
         */
        this._windowGroup.add_child(this._drawingArea);
        this._windowGroup.set_child_above_sibling(
            this._drawingArea,
            this._backgroundGroup
        );

        this._resizeDrawingArea();

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed',
            () => this._resizeDrawingArea()
        );

        this._capturedEventId = global.stage.connect(
            'captured-event',
            (_stage, event) => this._onCapturedEvent(event)
        );

        console.log(
            `[${this.uuid}] layered ribbon enabled ` +
            `accent=${this._accentName} ` +
            'stack=above-background-below-windows'
        );

        Main.notify(
            this.metadata.name,
            'Layered ribbon enabled. Windows now occlude the blade.'
        );
    }

    disable() {
        if (this._capturedEventId) {
            global.stage.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        if (this._accentChangedId && this._interfaceSettings) {
            this._interfaceSettings.disconnect(this._accentChangedId);
            this._accentChangedId = 0;
        }

        if (this._animationSourceId) {
            GLib.Source.remove(this._animationSourceId);
            this._animationSourceId = 0;
        }

        if (this._drawingArea) {
            if (this._repaintId) {
                this._drawingArea.disconnect(this._repaintId);
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
        this._interfaceSettings = null;
        this._accentColor = null;
        this._accentGlowColor = null;
        this._accentCoreColor = null;
        this._tailColor = null;
        this._accentName = null;

        console.log(`[${this.uuid}] layered ribbon disabled`);
    }

    _updateAccentColors() {
        let accentName = 'blue';

        try {
            accentName =
                this._interfaceSettings.get_string('accent-color');
        } catch (error) {
            console.error(
                `[${this.uuid}] could not read accent color: ` +
                `${error.message}`
            );
        }

        const hex =
            ACCENT_COLORS[accentName] ??
            ACCENT_COLORS.blue;

        const accent = hexToRgb(hex);

        this._accentName = accentName;
        this._accentColor = accent;
        this._accentGlowColor = mixColor(accent, [1, 1, 1], 0.16);
        this._accentCoreColor = mixColor(accent, [1, 1, 1], 0.70);
        this._tailColor = mixColor(accent, [0.006, 0.008, 0.014], 0.88);

        console.log(
            `[${this.uuid}] accent updated ` +
            `name=${accentName} color=${hex}`
        );
    }

    _resizeDrawingArea() {
        if (!this._drawingArea)
            return;

        const [width, height] = global.stage.get_size();

        this._drawingArea.set_position(0, 0);
        this._drawingArea.set_size(width, height);
        this._drawingArea.queue_repaint();

        console.log(
            `[${this.uuid}] drawing area resized ` +
            `width=${Math.round(width)} ` +
            `height=${Math.round(height)}`
        );
    }

    _isEmptyDesktopAt(x, y) {
        if (Main.overview.visible)
            return false;

        if (Main.sessionMode?.isLocked ?? false)
            return false;

        let actor = null;

        try {
            actor = global.stage.get_actor_at_pos(
                Clutter.PickMode.REACTIVE,
                Math.floor(x),
                Math.floor(y)
            );
        } catch (error) {
            console.error(
                `[${this.uuid}] desktop actor pick failed: ` +
                `${error.message}`
            );

            return false;
        }

        return actorIsInside(actor, this._backgroundGroup);
    }

    _onCapturedEvent(event) {
        const eventType = event.type();

        if (eventType === Clutter.EventType.BUTTON_PRESS) {
            if (event.get_button() !== 1)
                return false;

            const [x, y] = event.get_coords();

            if (this._isEmptyDesktopAt(x, y))
                this._startStroke(x, y);
            else
                this._cancelActiveStroke();
        } else if (
            eventType === Clutter.EventType.MOTION &&
            this._dragging
        ) {
            const [x, y] = event.get_coords();

            /*
             * Once a stroke starts on empty desktop, keep following it until
             * release. The drawing actor is below windows and Shell chrome,
             * so those objects naturally hide the portion passing beneath
             * them while the ribbon can reappear on exposed desktop.
             */
            if (
                Main.overview.visible ||
                (Main.sessionMode?.isLocked ?? false)
            ) {
                this._finishStroke('shell mode changed');
                return false;
            }

            this._appendPoint(x, y);
        } else if (
            eventType === Clutter.EventType.BUTTON_RELEASE
        ) {
            if (event.get_button() !== 1)
                return false;

            if (this._dragging) {
                const [x, y] = event.get_coords();

                this._appendPoint(x, y);
                this._finishStroke('button release');
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
                width: MIN_BLADE_WIDTH,
                time: now,
            }],
        };

        this._strokes.push(stroke);

        if (this._strokes.length > MAX_STROKES) {
            this._strokes.splice(
                0,
                this._strokes.length - MAX_STROKES
            );
        }

        this._activeStroke = stroke;
        this._dragging = true;

        console.log(
            `[${this.uuid}] ribbon started ` +
            `x=${Math.round(x)} y=${Math.round(y)}`
        );
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
            const index = this._strokes.indexOf(stroke);

            if (index >= 0)
                this._strokes.splice(index, 1);
        } else {
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
        const previous = points[points.length - 1];
        const now = monotonicMilliseconds();

        const dx = x - previous.x;
        const dy = y - previous.y;
        const distance = Math.hypot(dx, dy);

        if (distance < MIN_POINT_DISTANCE)
            return;

        const elapsed = Math.max(1, now - previous.time);
        const speed = distance / elapsed;

        const targetWidth = clamp(
            MIN_BLADE_WIDTH +
                speed * WIDTH_SPEED_MULTIPLIER,
            MIN_BLADE_WIDTH,
            MAX_BLADE_WIDTH
        );

        const width = lerp(
            previous.width,
            targetWidth,
            WIDTH_SMOOTHING
        );

        points.push({
            x,
            y,
            width,
            time: now,
        });

        if (points.length > MAX_POINTS_PER_STROKE) {
            points.splice(
                0,
                points.length - MAX_POINTS_PER_STROKE
            );
        }

        this._drawingArea?.queue_repaint();
        this._ensureAnimationSource();
    }

    _ensureAnimationSource() {
        if (this._animationSourceId)
            return;

        this._animationSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            FRAME_INTERVAL_MS,
            () => {
                const now = monotonicMilliseconds();

                this._pruneStrokes(now);
                this._drawingArea?.queue_repaint();

                if (
                    this._strokes.length === 0 &&
                    !this._dragging
                ) {
                    this._animationSourceId = 0;
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _pruneStrokes(now) {
        const cutoff = now - TAIL_LIFETIME_MS;

        for (const stroke of this._strokes) {
            while (
                stroke.points.length > 2 &&
                stroke.points[1].time < cutoff
            ) {
                stroke.points.shift();
            }
        }

        this._strokes = this._strokes.filter(stroke => {
            if (stroke === this._activeStroke)
                return true;

            if (stroke.points.length === 0)
                return false;

            const newest =
                stroke.points[stroke.points.length - 1];

            return now - newest.time < TAIL_LIFETIME_MS;
        });
    }

    _onRepaint(area) {
        const cr = area.get_context();

        try {
            cr.setOperator(Cairo.Operator.CLEAR);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);
            cr.setAntialias(Cairo.Antialias.BEST);

            const now = monotonicMilliseconds();

            for (const stroke of this._strokes) {
                if (stroke.points.length < 2)
                    continue;

                const smoothed = smoothPoints(
                    stroke.points,
                    SMOOTHING_PASSES
                );

                this._drawDarkAfterimage(
                    cr,
                    smoothed,
                    now
                );

                this._drawHeadWeightedLayer(
                    cr,
                    smoothed,
                    now,
                    MAIN_LIFETIME_MS,
                    1.46,
                    this._accentGlowColor,
                    0.30,
                    5
                );

                this._drawHeadWeightedLayer(
                    cr,
                    smoothed,
                    now,
                    MAIN_LIFETIME_MS,
                    1.00,
                    this._accentColor,
                    0.82,
                    6
                );

                this._drawHeadWeightedLayer(
                    cr,
                    smoothed,
                    now,
                    MAIN_LIFETIME_MS * 0.82,
                    0.36,
                    this._accentCoreColor,
                    0.74,
                    5
                );

                this._drawHeadWeightedLayer(
                    cr,
                    smoothed,
                    now,
                    MAIN_LIFETIME_MS * 0.58,
                    0.12,
                    [1, 1, 1],
                    0.34,
                    4
                );
            }
        } finally {
            cr.$dispose();
        }
    }

    _drawDarkAfterimage(cr, points, now) {
        for (const window of DARK_TAIL_WINDOWS) {
            const visible = pointsInTimeWindow(
                points,
                now - window.maxAge,
                now - window.minAge
            );

            if (visible.length < 2)
                continue;

            this._drawRibbon(
                cr,
                visible,
                window.width,
                this._tailColor,
                window.alpha
            );
        }
    }

    _drawHeadWeightedLayer(
        cr,
        points,
        now,
        lifetime,
        widthMultiplier,
        color,
        totalAlpha,
        steps
    ) {
        /*
         * Draw nested versions of the same connected ribbon. The longest is
         * faint and reaches furthest into the old tail; progressively shorter
         * ribbons overlap toward the cursor, producing a smooth longitudinal
         * fade without turning the stroke back into separate diamonds.
         */
        for (let step = steps; step >= 1; step--) {
            const fraction = step / steps;
            const windowLifetime =
                lifetime * Math.pow(fraction, 1.35);

            const visible = pointsInTimeWindow(
                points,
                now - windowLifetime,
                now + 1
            );

            if (visible.length < 2)
                continue;

            const alpha =
                totalAlpha / steps;

            this._drawRibbon(
                cr,
                visible,
                widthMultiplier,
                color,
                alpha
            );
        }
    }

    _drawRibbon(
        cr,
        points,
        widthMultiplier,
        color,
        alpha
    ) {
        const count = points.length;
        const distances = new Array(count).fill(0);

        for (let index = 1; index < count; index++) {
            const dx = points[index].x - points[index - 1].x;
            const dy = points[index].y - points[index - 1].y;

            distances[index] =
                distances[index - 1] +
                Math.hypot(dx, dy);
        }

        const totalLength = distances[count - 1];

        if (totalLength < 1 || alpha <= 0)
            return;

        const headTaperLength = Math.min(
            HEAD_TAPER_LENGTH,
            totalLength * 0.48
        );

        const tailTaperLength = Math.min(
            TAIL_TAPER_LENGTH,
            totalLength * 0.48
        );

        const leftEdge = [];
        const rightEdge = [];

        let previousNormalX = 0;
        let previousNormalY = 1;

        for (let index = 0; index < count; index++) {
            const previous =
                points[Math.max(0, index - 1)];

            const next =
                points[Math.min(count - 1, index + 1)];

            const tangentX = next.x - previous.x;
            const tangentY = next.y - previous.y;
            const tangentLength =
                Math.hypot(tangentX, tangentY);

            let normalX = previousNormalX;
            let normalY = previousNormalY;

            if (tangentLength > 0.001) {
                normalX = -tangentY / tangentLength;
                normalY = tangentX / tangentLength;

                previousNormalX = normalX;
                previousNormalY = normalY;
            }

            const distanceFromTail = distances[index];
            const distanceFromHead =
                totalLength - distances[index];

            const tailTaper = smoothStep(
                distanceFromTail /
                    Math.max(1, tailTaperLength)
            );

            const headTaper = smoothStep(
                distanceFromHead /
                    Math.max(1, headTaperLength)
            );

            const taper = Math.min(
                tailTaper,
                headTaper
            );

            const halfWidth =
                points[index].width *
                widthMultiplier *
                taper /
                2;

            leftEdge.push({
                x: points[index].x +
                    normalX * halfWidth,
                y: points[index].y +
                    normalY * halfWidth,
            });

            rightEdge.push({
                x: points[index].x -
                    normalX * halfWidth,
                y: points[index].y -
                    normalY * halfWidth,
            });
        }

        cr.newPath();
        cr.moveTo(leftEdge[0].x, leftEdge[0].y);

        for (let index = 1; index < leftEdge.length; index++) {
            cr.lineTo(
                leftEdge[index].x,
                leftEdge[index].y
            );
        }

        for (
            let index = rightEdge.length - 1;
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
