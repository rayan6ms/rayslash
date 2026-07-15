import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class RaySlashExtension extends Extension {
    enable() {
        console.log(`[${this.uuid}] enabled`);

        Main.notify(
            this.metadata.name,
            'The development scaffold loaded successfully.'
        );
    }

    disable() {
        console.log(`[${this.uuid}] disabled`);
    }
}
