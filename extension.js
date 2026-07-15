import Cairo from 'cairo';

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/*
 * Animation and geometry parameters.
 *
 * These are constants for now. Once the visual effect is working reliably,
 * they can become user-adjustable GSettings preferences.
 */
const FRAME_INTERVAL_MS = 16;

const MAIN_LIFETIME_MS = 220;
const TAIL_LIFETIME_MS = 620;

const MIN_POINT_DISTANCE = 2.5;
const MIN_BLADE_WIDTH = 7;
const MAX_BLADE_WIDTH = 24;
const MAX_SEGMENTS = 160;

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

function monotonicMilliseconds() {
    /*
     * GLib returns monotonic time in microseconds.
     *
     * Monotonic time is preferable to wall-clock time for animation because
     * changing the system clock cannot make an animation jump backward.
     */
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

export default class RaySlashExtension extends Extension {
    enable() {
        this._segments = [];
        this._dragging = false;
        this._lastPoint = null;

        this._animationSourceId = 0;
        this._capturedEventId = 0;
        this._repaintId = 0;
        this._accentChangedId = 0;
        this._monitorsChangedId = 0;

        /*
         * This private Shell actor was confirmed by the diagnostic probe on
         * GNOME Shell 50.3. It contains the reactive Meta_BackgroundActor.
         */
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
         * The DrawingArea is transparent except where Cairo paints a slash.
         *
         * reactive=false is essential: the overlay must never receive or
         * intercept pointer input.
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

        this._resizeDrawingArea();

        /*
         * Place the transparent visual surface at the top of the Shell scene.
         * Because it is non-reactive, PickMode.REACTIVE ignores it.
         */
        Main.uiGroup.add_child(this._drawingArea);
        Main.uiGroup.set_child_above_sibling(
            this._drawingArea,
            null
        );

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed',
            () => this._resizeDrawingArea()
        );

        this._capturedEventId = global.stage.connect(
            'captured-event',
            (_stage, event) => this._onCapturedEvent(event)
        );

        console.log(
            `[${this.uuid}] visual prototype enabled ` +
            `accent=${this._accentName} ` +
            `backgroundGroup=${this._backgroundGroup !== null}`
        );

        Main.notify(
            this.metadata.name,
            'Visual prototype enabled. Drag across the empty desktop.'
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

        this._segments = [];
        this._dragging = false;
        this._lastPoint = null;

        this._backgroundGroup = null;
        this._interfaceSettings = null;
        this._accentColor = null;
        this._accentName = null;

        console.log(`[${this.uuid}] visual prototype disabled`);
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
            `width=${Math.round(width)} height=${Math.round(height)}`
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
            /*
             * REACTIVE is intentional.
             *
             * PickMode.ALL can return transparent visual layers such as the
             * message tray. REACTIVE returns the actor that can actually
             * interact with the pointer at this position.
             */
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

            this._dragging = this._isEmptyDesktopAt(x, y);

            if (this._dragging) {
                this._lastPoint = {
                    x,
                    y,
                    time: monotonicMilliseconds(),
                };

                console.log(
                    `[${this.uuid}] slash started ` +
                    `x=${Math.round(x)} y=${Math.round(y)}`
                );
            } else {
                this._lastPoint = null;
            }
        } else if (
            eventType === Clutter.EventType.MOTION &&
            this._dragging
        ) {
            const [x, y] = event.get_coords();

            /*
             * Stop collecting points when the pointer leaves the desktop.
             * Existing segments continue fading normally.
             */
            if (!this._isEmptyDesktopAt(x, y)) {
                this._dragging = false;
                this._lastPoint = null;

                console.log(
                    `[${this.uuid}] slash stopped at desktop boundary`
                );

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

                /*
                 * Include the release location when it remains on the desktop.
                 */
                if (this._isEmptyDesktopAt(x, y))
                    this._appendPoint(x, y);

                console.log(
                    `[${this.uuid}] slash ended ` +
                    `segments=${this._segments.length}`
                );
            }

            this._dragging = false;
            this._lastPoint = null;
        }

        /*
         * RaySlash observes pointer events but never consumes them.
         */
        return false;
    }

    _appendPoint(x, y) {
        if (!this._lastPoint)
            return;

        const now = monotonicMilliseconds();

        const dx = x - this._lastPoint.x;
        const dy = y - this._lastPoint.y;
        const distance = Math.hypot(dx, dy);

        if (distance < MIN_POINT_DISTANCE)
            return;

        const elapsed =
            Math.max(1, now - this._lastPoint.time);

        /*
         * Pixels per millisecond. Faster pointer movement creates a wider,
         * more dramatic blade while retaining a sensible minimum width.
         */
        const speed = distance / elapsed;

        const width = clamp(
            MIN_BLADE_WIDTH + speed * 12,
            MIN_BLADE_WIDTH,
            MAX_BLADE_WIDTH
        );

        this._segments.push({
            x1: this._lastPoint.x,
            y1: this._lastPoint.y,
            x2: x,
            y2: y,
            width,
            created: now,
        });

        if (this._segments.length > MAX_SEGMENTS) {
            this._segments.splice(
                0,
                this._segments.length - MAX_SEGMENTS
            );
        }

        this._lastPoint = {
            x,
            y,
            time: now,
        };

        this._drawingArea?.queue_repaint();
        this._ensureAnimationSource();
    }

    _ensureAnimationSource() {
        if (this._animationSourceId)
            return;

        /*
         * This timer exists only while visible trail segments exist.
         * It removes itself when the last dark-tail segment expires.
         */
        this._animationSourceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            FRAME_INTERVAL_MS,
            () => {
                const now = monotonicMilliseconds();

                this._segments = this._segments.filter(
                    segment =>
                        now - segment.created <
                        TAIL_LIFETIME_MS
                );

                this._drawingArea?.queue_repaint();

                if (this._segments.length === 0) {
                    this._animationSourceId = 0;
                    return GLib.SOURCE_REMOVE;
                }

                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _onRepaint(area) {
        const cr = area.get_context();

        try {
            /*
             * Clear the previous Cairo frame completely.
             */
            cr.setOperator(Cairo.Operator.CLEAR);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);

            const now = monotonicMilliseconds();

            /*
             * Draw the dark afterimage first. It is wider and lasts longer.
             */
            for (const segment of this._segments) {
                const age = now - segment.created;

                if (age < 0 || age >= TAIL_LIFETIME_MS)
                    continue;

                const tailProgress =
                    age / TAIL_LIFETIME_MS;

                const tailFade =
                    1 - tailProgress;

                /*
                 * Initially the dark layer is subtle under the bright blade.
                 * It becomes more visible as the bright blade ages.
                 */
                const revealProgress = clamp(
                    age / MAIN_LIFETIME_MS,
                    0,
                    1
                );

                const tailAlpha =
                    (0.10 + revealProgress * 0.32) *
                    tailFade;

                this._drawDiamond(
                    cr,
                    segment,
                    segment.width * 1.45,
                    [0.015, 0.018, 0.025],
                    tailAlpha
                );
            }

            /*
             * Draw the accent-colored blade over the dark afterimage.
             */
            for (const segment of this._segments) {
                const age = now - segment.created;

                if (age < 0 || age >= MAIN_LIFETIME_MS)
                    continue;

                const mainProgress =
                    age / MAIN_LIFETIME_MS;

                const mainFade =
                    1 - mainProgress;

                this._drawDiamond(
                    cr,
                    segment,
                    segment.width,
                    this._accentColor,
                    0.96 * mainFade
                );
            }
        } finally {
            /*
             * Explicitly release the native Cairo context wrapper.
             */
            cr.$dispose();
        }
    }

    _drawDiamond(cr, segment, width, color, alpha) {
        const dx = segment.x2 - segment.x1;
        const dy = segment.y2 - segment.y1;
        const length = Math.hypot(dx, dy);

        if (length < 0.001 || alpha <= 0)
            return;

        const midpointX =
            (segment.x1 + segment.x2) / 2;

        const midpointY =
            (segment.y1 + segment.y2) / 2;

        const halfWidth = width / 2;

        /*
         * A perpendicular unit vector, scaled to half the blade width.
         */
        const normalX =
            (-dy / length) * halfWidth;

        const normalY =
            (dx / length) * halfWidth;

        /*
         * Four points form a stretched rhombus:
         *
         *     midpoint + normal
         *            /\
         *     start <    > end
         *            \/
         *     midpoint - normal
         */
        cr.moveTo(segment.x1, segment.y1);

        cr.lineTo(
            midpointX + normalX,
            midpointY + normalY
        );

        cr.lineTo(segment.x2, segment.y2);

        cr.lineTo(
            midpointX - normalX,
            midpointY - normalY
        );

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
