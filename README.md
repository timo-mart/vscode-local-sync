# local-sync

sync your settings to a local directory

## Features

- sync settings, extensions, keybindings and snippets in a local folder
- sync VSCodium profiles, including profile metadata and profile-specific files under `User/profiles`
- show a built-in status bar indicator for the resolved current profile name

> share this local folder using [.dotfiles](https://www.atlassian.com/git/tutorials/dotfiles) between machines

## Setup

- set setting `local-sync.backupPath` to your sync folder


## commands

- `local-sync.backup`: backup your settings to sync folder
- `local-sync.restore`: restore your settings from sync folder
- `local-sync.refreshProfileStatus`: refresh the local-sync profile status bar indicator


## License
[MIT License](LICENSE)
