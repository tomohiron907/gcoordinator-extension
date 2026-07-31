# Change Log

All notable changes to the gcoordinator extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2] - 2026-07-31

### Changed

- Requirements now recommend setting up the Python environment with
  [uv](https://docs.astral.sh/uv/), including the `gcoordinator.pythonPath`
  value to use with a uv-managed `.venv`.

## [0.1.1] - 2026-07-31

### Fixed

- The 3D preview now opens in the VS Code window you ran your script from.
  Every window activates the extension and races for the same port, and only the
  winner received a script's output — so with more than one window open, a
  preview could appear in a window you weren't working in. The focused window
  now takes the port, which also makes `python script.py` from a terminal
  preview where you ran it.
- A preview dragged into a floating window and closed no longer keeps sending
  later previews to that vanished editor group.

### Added

- Extension icon and a screenshot on the Marketplace listing.

## [0.1.0] - 2026-07-31

First public release.

### Added

- **Live Preview** — watch a Python script and re-run it on every save, streaming
  the resulting toolpath into a 3D view (`gcoordinator: Start Preview` /
  `gcoordinator: Stop Preview`).
- **G-code preview** — render an open `.gcode` file directly
  (`gcoordinator: Preview G-code`).
- Extrusion paths drawn as swept geometry sized from the configured nozzle
  diameter, with travel moves drawn as separate lines.
- **SpaceMouse support** for navigating the 3D view, coexisting with the
  3Dconnexion driver so the puck keeps working in other applications:
  - macOS via a bundled `3DconnexionClient.framework` helper
  - Windows via raw HID (`node-hid`)
- Status bar indicator showing the watched file and script execution state.
- Output channels for diagnostics: `gcoordinator Live Preview` and
  `gcoordinator SpaceMouse`.
- Settings: `port`, `nozzleSize`, `pathColor`, `travelColor`, `pythonPath`,
  `livePreviewTimeout`.
