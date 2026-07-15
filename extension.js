import Cairo from 'cairo';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/*
 * Animation timing.
 */
const FRAME_INTERVAL_MS = 16;
const MAIN_LIFETIME_MS = 240;
const TAIL_LIFETIME_MS = 680;

/*
 * Pointer sampling and smoothing.
 */
const MIN_POINT_DISTANCE = 3;
const MAX_POINTS_PER_STROKE = 128;
const MAX_STROKES = 8;
const SMOOTHING_PASSES = 2;

/*
 * Ribbon geometry.
 */
const MIN_BLADE_WIDTH = 8;
const MAX_BLADE_WIDTH = 30;
const WIDTH_SPEED_MULTIPLIER = 12;
const WIDTH_SMOOTHING = 0.35;

const HEAD_TAPER_LENGTH = 62;
const TAIL_TAPER_LENGTH = 52;

/*
 * The dark afterimage is slightly wider than the accent blade.
 */
const TAIL_WIDTH_MULTIPLIER = 1.4;

/*
 * Official GNOME/libadwaita system accent colors.
 */
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

/*
 * Interpolate every property needed by the ribbon renderer.
 */
function interpolatePoint(first, second, progress) {
    return {
        x: lerp(first.x, second.x, progress),
        y: lerp(first.y, second.y, progress),
        width: lerp(first.width, second.width, progress),
        time: lerp(first.time, second.time, progress),
    };
}

/*
 * One Chaikin pass replaces each line segment with two points located at
 * one-quarter and three-quarters of the segment.
 *
 * Repeating this operation creates a smooth curve while preserving the first
 * and last positions of the stroke.
 */
function smoothPointsOnce(points) {
    if (points.length < 2)
        return points.slice();

    const result = [{
        ...points[0],
    }];

    for (let index = 0; index < points.length - 1; index++) {
        const first = points[index];
        const second = points[index + 1];

        result.push(interpolatePoint(first, second, 0.25));
        result.push(interpolatePoint(first, second, 0.75));
    }

    result.push({
        ...points[points.length - 1],
    });

    return result;
}

function smoothPoints(points, passes) {
    let result = points.map(point => ({
        ...point,
    }));

    for (let pass = 0; pass < passes; pass++)
        result = smoothPointsOnce(result);

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

        this._interfaceSettings = new Gio.Settings({
            schema_id: 'org.gnome.desktop.interface',
        });

        this._updateAccentColor();

        this._accentChangedId = this._interfaceSettings.connect(
            'changed::accent-color',
            () => {
                this._updateAccentColor();
                this._drawingArea?.queue_repaint();
            }
        );

        /*
         * This surface is purely visual. Because it is non-reactive, it
         * cannot become the pointer target or block normal desktop input.
         */
        this._drawingArea = new St.DrawingArea({
            name: 'rayslashDrawingArea',
            reactive: false,
            can_focus: false,
        });

        this._repaintId = this._drawingArea.connect(
            'repaint',
            area => this._onRepaint(area)
        );

        Main.uiGroup.add_child(this._drawingArea);
        Main.uiGroup.set_child_above_sibling(
            this._drawingArea,
            null
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
            `[${this.uuid}] curved ribbon prototype enabled ` +
            `accent=${this._accentName} ` +
            `backgroundGroup=${this._backgroundGroup !== null}`
        );

        Main.notify(
            this.metadata.name,
            'Curved ribbon prototype enabled. Drag across the desktop.'
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
        this._interfaceSettings = null;
        this._accentColor = null;
        this._accentName = null;

        console.log(`[${this.uuid}] curved ribbon prototype disabled`);
    }

    _updateAccentColor() {
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

        this._accentName = accentName;
        this._accentColor = hexToRgb(hex);

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
        if (!this._backgroundGroup)
            return false;

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

            if (!this._isEmptyDesktopAt(x, y)) {
                this._finishStroke('desktop boundary');
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

                if (this._isEmptyDesktopAt(x, y))
                    this._appendPoint(x, y);

                this._finishStroke('button release');
            }
        }

        /*
         * Returning false leaves the original event unconsumed.
         */
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
            endedAt: null,
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

        stroke.endedAt = monotonicMilliseconds();

        /*
         * A click without enough movement has no visible blade, so discard it.
         */
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

        /*
         * Smooth width separately from position so small timing variations do
         * not make the blade pulse between thin and thick.
         */
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
            /*
             * Retain one point just before the cutoff. It is used to
             * interpolate the exact tapered beginning of the visible ribbon.
             */
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

    _getVisiblePoints(stroke, now, lifetime) {
        const points = stroke.points;

        if (points.length < 2)
            return [];

        const cutoff = now - lifetime;

        let firstVisibleIndex = points.findIndex(
            point => point.time >= cutoff
        );

        if (firstVisibleIndex < 0)
            return [];

        const visible = [];

        /*
         * Insert a point exactly at the age boundary. This makes the tail
         * retreat continuously instead of dropping an entire sampled segment
         * at once.
         */
        if (firstVisibleIndex > 0) {
            const previous = points[firstVisibleIndex - 1];
            const current = points[firstVisibleIndex];

            const duration =
                Math.max(1, current.time - previous.time);

            const progress = clamp(
                (cutoff - previous.time) / duration,
                0,
                1
            );

            visible.push(
                interpolatePoint(previous, current, progress)
            );
        }

        for (
            let index = firstVisibleIndex;
            index < points.length;
            index++
        ) {
            visible.push({
                ...points[index],
            });
        }

        return visible;
    }

    _onRepaint(area) {
        const cr = area.get_context();

        try {
            cr.setOperator(Cairo.Operator.CLEAR);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);

            const now = monotonicMilliseconds();

            /*
             * Draw every dark ribbon first so all accent ribbons remain above
             * their respective afterimages.
             */
            for (const stroke of this._strokes) {
                this._drawStrokeLayer(
                    cr,
                    stroke,
                    now,
                    TAIL_LIFETIME_MS,
                    TAIL_WIDTH_MULTIPLIER,
                    [0.012, 0.014, 0.020],
                    0.40
                );
            }

            for (const stroke of this._strokes) {
                this._drawStrokeLayer(
                    cr,
                    stroke,
                    now,
                    MAIN_LIFETIME_MS,
                    1,
                    this._accentColor,
                    0.96
                );
            }
        } finally {
            cr.$dispose();
        }
    }

    _drawStrokeLayer(
        cr,
        stroke,
        now,
        lifetime,
        widthMultiplier,
        color,
        baseAlpha
    ) {
        const visiblePoints = this._getVisiblePoints(
            stroke,
            now,
            lifetime
        );

        if (visiblePoints.length < 2)
            return;

        const smoothed = smoothPoints(
            visiblePoints,
            SMOOTHING_PASSES
        );

        if (smoothed.length < 2)
            return;

        let alpha = baseAlpha;

        /*
         * While drawing, the ribbon remains fully visible. Once released, the
         * whole layer also fades while its aged beginning retreats.
         */
        if (stroke.endedAt !== null) {
            const elapsedSinceRelease =
                now - stroke.endedAt;

            alpha *= clamp(
                1 - elapsedSinceRelease / lifetime,
                0,
                1
            );
        }

        if (alpha <= 0)
            return;

        this._drawRibbon(
            cr,
            smoothed,
            widthMultiplier,
            color,
            alpha
        );
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

        if (totalLength < 1)
            return;

        const headTaperLength = Math.min(
            HEAD_TAPER_LENGTH,
            totalLength * 0.46
        );

        const tailTaperLength = Math.min(
            TAIL_TAPER_LENGTH,
            totalLength * 0.46
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

            /*
             * These two factors produce pointed ends. The curved center of
             * the slash retains the width calculated from pointer speed.
             */
            const tailTaper = smoothStep(
                distanceFromTail /
                    Math.max(1, tailTaperLength)
            );

            const headTaper = smoothStep(
                distanceFromHead /
                    Math.max(1, headTaperLength)
            );

            const taper =
                Math.min(tailTaper, headTaper);

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

        /*
         * One Cairo path forms the entire blade:
         *
         * tail -> left edge -> pointed head -> reversed right edge -> tail
         *
         * There are no individual diamonds or segment fills.
         */
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
