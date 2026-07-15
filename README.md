# RaySlash

RaySlash is a GNOME Shell extension that draws a temporary, curved slash trail when the primary mouse button is dragged across exposed desktop space.

The ribbon follows the pointer, uses the current GNOME accent color by default, and remains underneath application windows.

## Features

* Curved, tapered ribbon rendering
* GNOME system accent color support
* Custom and preset colors
* Multiple thickness presets
* Fruit blade, clean, neon, and shadow styles
* Configurable active trail length
* Configurable release fade timing
* Configurable pointer-speed response
* Bounded trail length and memory usage
* Application windows remain above the effect
* No permanent animation loop while idle
* GTK4 and Libadwaita preferences page
* Wayland support

## Requirements

* GNOME Shell 50
* Wayland
* GJS
* GTK4
* Libadwaita

RaySlash was developed and tested on Fedora 44 with GNOME Shell 50.

## How it works

A slash begins only when the primary-button press originates on exposed desktop background.

The extension observes pointer motion without consuming the original input event. It renders the visual effect using a non-reactive `St.DrawingArea` positioned above GNOME’s background layer and below application windows.

While the button remains held, RaySlash retains only a bounded recent portion of the pointer path. After release, the remaining ribbon fades away and the animation timer stops when nothing remains visible.

## Preferences

Open the RaySlash preferences through GNOME Extensions or Extension Manager.

Available settings include:

* Drawing enabled
* Color source
* Custom color
* Thickness
* Effect style
* Active trail length
* Release fade timing
* Speed response

The default configuration uses the GNOME system accent color, thin thickness, the Fruit blade style, balanced trail length, balanced fade timing, and responsive speed behavior.

## Manual installation

Download the extension ZIP and install it with:

```sh
gnome-extensions install --force rayslash@rayan6ms.github.io.shell-extension.zip
```

Log out and back in if GNOME Shell does not discover the newly installed extension immediately.

Enable it with:

```sh
gnome-extensions enable rayslash@rayan6ms.github.io
```

Open its preferences with:

```sh
gnome-extensions prefs rayslash@rayan6ms.github.io
```

## Development

The extension source contains:

```text
extension.js
prefs.js
metadata.json
schemas/org.gnome.shell.extensions.rayslash.gschema.xml
LICENSE
```

After changing the settings schema, compile it with:

```sh
glib-compile-schemas schemas
```

For safe testing on GNOME 50, run a nested GNOME Shell:

```sh
G_MESSAGES_DEBUG=all \
SHELL_DEBUG=all \
dbus-run-session \
    gnome-shell --devkit --wayland
```

## License

RaySlash is licensed under the GNU General Public License, version 2 or later.

See [LICENSE](LICENSE).
