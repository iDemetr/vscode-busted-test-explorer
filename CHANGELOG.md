# Change Log

## [0.2.5] - 2025-09-17
### Added
- **Profile support** for running Busted:
  - `local` (default, runs on host system)
  - `wsl` (runs inside Windows Subsystem for Linux)
  - `docker` (runs inside Docker container)
- New configuration options:
  - `busted-test-explorer.profile`
  - `busted-test-explorer.executable`
  - `busted-test-explorer.wslExecutable`
  - `busted-test-explorer.dockerExecutable`
  - `busted-test-explorer.args`

### Changed
- Runner now respects selected profile and executable.
- Improved **watchdog**: detects idle processes (no output for N seconds) and terminates them with error.
- More detailed **logging** in Output panel with emojis for readability.
- Enhanced **error reporting**:
  - Displays stderr and watchdog timeout in Test Explorer.

### Fixed
- Hanging processes no longer block Test Explorer (watchdog kill).
- Duplicate controller ID error removed (activation refactor).

## [0.2.2]

- Fix issue where tests removed from file stay forever in explorer view

## [0.2.1]

- Fix path issue on Windows
- Display an error message when we failed to spawn busted

## [0.2.0]

- Substitute variable in extension settings

## [0.1.1]

- Add extension icon

## [0.1.0]

- Initial release
