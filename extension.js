import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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

function getActorTypeName(actor) {
    if (!actor)
        return '<none>';

    try {
        return actor.constructor?.name ?? 'UnknownActor';
    } catch {
        return 'UnknownActor';
    }
}

function describeActor(actor) {
    if (!actor)
        return '<none>';

    const parts = [getActorTypeName(actor)];

    try {
        const name = actor.get_name();

        if (name)
            parts.push(`name=${JSON.stringify(name)}`);
    } catch {
        // Actor names are optional.
    }

    try {
        const styleClass = actor.get_style_class_name();

        if (styleClass)
            parts.push(`style=${JSON.stringify(styleClass)}`);
    } catch {
        // Only St actors normally expose a style class.
    }

    try {
        parts.push(`reactive=${actor.reactive}`);
    } catch {
        // Leave it out when unavailable.
    }

    try {
        parts.push(`visible=${actor.visible}`);
    } catch {
        // Leave it out when unavailable.
    }

    if (actor === global.stage)
        parts.push('ROLE=stage');

    if (actor === Main.uiGroup)
        parts.push('ROLE=ui-group');

    if (actor === Main.panel)
        parts.push('ROLE=panel');

    if (actor === Main.layoutManager?._backgroundGroup)
        parts.push('ROLE=background-group');

    return parts.join(' ');
}

function describeActorPath(actor) {
    if (!actor)
        return '<none>';

    const parts = [];
    let current = actor;

    for (let depth = 0; current && depth < 16; depth++) {
        parts.push(describeActor(current));
        current = getParent(current);
    }

    if (current)
        parts.push('<more parents>');

    return parts.join(' <- ');
}

function getWindowActors() {
    try {
        return global.get_window_actors();
    } catch {
        return [];
    }
}

function findWindowActor(actor) {
    if (!actor)
        return null;

    for (const windowActor of getWindowActors()) {
        if (actorIsInside(actor, windowActor))
            return windowActor;
    }

    return null;
}

function describeWindow(windowActor) {
    if (!windowActor)
        return '<none>';

    try {
        const metaWindow = windowActor.meta_window;

        if (!metaWindow)
            return '<window actor without Meta.Window>';

        const parts = [];

        try {
            const title = metaWindow.get_title();

            if (title)
                parts.push(`title=${JSON.stringify(title)}`);
        } catch {
            // Window title unavailable.
        }

        try {
            const wmClass = metaWindow.get_wm_class();

            if (wmClass)
                parts.push(`class=${JSON.stringify(wmClass)}`);
        } catch {
            // WM class unavailable.
        }

        try {
            parts.push(`type=${metaWindow.get_window_type()}`);
        } catch {
            // Window type unavailable.
        }

        return parts.length > 0 ? parts.join(' ') : '<window>';
    } catch (error) {
        return `<window inspection failed: ${error.message}>`;
    }
}

export default class RaySlashExtension extends Extension {
    enable() {
        this._primaryButtonPressed = false;
        this._lastMotionLogTime = 0;

        this._backgroundGroup =
            Main.layoutManager?._backgroundGroup ?? null;

        this._canPickActors =
            typeof global.stage.get_actor_at_pos === 'function';

        this._capturedEventId = global.stage.connect(
            'captured-event',
            (_stage, event) => this._onCapturedEvent(event)
        );

        console.log(
            `[${this.uuid}] enabled actor-picking probe ` +
            `canPick=${this._canPickActors} ` +
            `hasBackgroundGroup=${this._backgroundGroup !== null}`
        );

        Main.notify(
            this.metadata.name,
            'Actor-picking probe enabled. Input is not being intercepted.'
        );
    }

    disable() {
        if (this._capturedEventId) {
            global.stage.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }

        this._primaryButtonPressed = false;
        this._lastMotionLogTime = 0;
        this._backgroundGroup = null;
        this._canPickActors = false;

        console.log(`[${this.uuid}] disabled actor-picking probe`);
    }

    _pickActor(mode, x, y) {
        if (!this._canPickActors)
            return null;

        try {
            return global.stage.get_actor_at_pos(
                mode,
                Math.floor(x),
                Math.floor(y)
            );
        } catch (error) {
            console.error(
                `[${this.uuid}] actor picking failed: ${error.message}`
            );

            return null;
        }
    }

    _inspectPoint(x, y) {
        const allActor = this._pickActor(
            Clutter.PickMode.ALL,
            x,
            y
        );

        const reactiveActor = this._pickActor(
            Clutter.PickMode.REACTIVE,
            x,
            y
        );

        const windowActor =
            findWindowActor(allActor) ??
            findWindowActor(reactiveActor);

        const onBackground =
            actorIsInside(allActor, this._backgroundGroup) ||
            actorIsInside(reactiveActor, this._backgroundGroup);

        const onPanel =
            actorIsInside(allActor, Main.panel) ||
            actorIsInside(reactiveActor, Main.panel);

        return {
            allActor,
            reactiveActor,
            windowActor,
            onBackground,
            onPanel,
        };
    }

    _logDetailedPoint(kind, x, y) {
        const point = this._inspectPoint(x, y);

        console.log(
            `[${this.uuid}] POINT ${kind} ` +
            `x=${Math.round(x)} y=${Math.round(y)} ` +
            `overview=${Main.overview.visible} ` +
            `background=${point.onBackground} ` +
            `panel=${point.onPanel} ` +
            `window=${describeWindow(point.windowActor)}`
        );

        console.log(
            `[${this.uuid}] PICK ${kind} all-path=` +
            describeActorPath(point.allActor)
        );

        console.log(
            `[${this.uuid}] PICK ${kind} reactive-path=` +
            describeActorPath(point.reactiveActor)
        );
    }

    _logMotionPoint(x, y) {
        const point = this._inspectPoint(x, y);

        console.log(
            `[${this.uuid}] MOTION ` +
            `x=${Math.round(x)} y=${Math.round(y)} ` +
            `background=${point.onBackground} ` +
            `panel=${point.onPanel} ` +
            `window=${point.windowActor !== null}`
        );
    }

    _onCapturedEvent(event) {
        const eventType = event.type();

        if (eventType === Clutter.EventType.BUTTON_PRESS) {
            if (event.get_button() !== 1)
                return false;

            const [x, y] = event.get_coords();

            this._primaryButtonPressed = true;
            this._lastMotionLogTime = 0;

            this._logDetailedPoint('press', x, y);
        } else if (
            eventType === Clutter.EventType.MOTION &&
            this._primaryButtonPressed
        ) {
            const now = Date.now();

            if (now - this._lastMotionLogTime >= 150) {
                const [x, y] = event.get_coords();

                this._lastMotionLogTime = now;
                this._logMotionPoint(x, y);
            }
        } else if (
            eventType === Clutter.EventType.BUTTON_RELEASE
        ) {
            if (event.get_button() !== 1)
                return false;

            const [x, y] = event.get_coords();

            this._logDetailedPoint('release', x, y);

            this._primaryButtonPressed = false;
            this._lastMotionLogTime = 0;
        }

        /*
         * RaySlash is observing the event, not handling it.
         * The original click or drag continues normally.
         */
        return false;
    }
}
