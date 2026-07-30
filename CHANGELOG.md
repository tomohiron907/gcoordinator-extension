# Change Log

All notable changes to the gcoordinator extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
