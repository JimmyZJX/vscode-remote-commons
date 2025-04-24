# VSCode Remote Commons Extension

Provides useful workspace APIs for UI extensions to work smoothly while being
able to interact with remote machine.

It's currently required by the
[Leaderkey](https://github.com/JimmyZJX/leaderkey) extension.

This extension is under active development. We'll bump major version when
breaking changes are made, and minor versions when new APIs are introduced.

## APIs

We plan to provide sample typescript code to interact with this extension, but
for now you can refer to the Leaderkey implementation (https://github.com/JimmyZJX/leaderkey/blob/feature-ripgrep/src/common/remote.ts).

Currently, we support the following APIs

### Process

- run process and get stderr + stdout + exit status
- run process and pipe stdout/stderr line by line

### Filesystem

- Read dir
- Create file
- Open remote file in VSCode

### Environment/VSCode

- Get remote platform
- Get a list of workspace extensions
