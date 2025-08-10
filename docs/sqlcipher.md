# SQLCipher Integration (better-sqlite3 + Electron)

The app detects SQLCipher at runtime. When linked, it opens the DB in encrypted mode if RECALLOS_PASSPHRASE is set; otherwise it uses plain SQLite with WAL.

## macOS

Optional commands you can run:

- brew install sqlcipher
- pnpm dlx electron-rebuild -f -w better-sqlite3
- pnpm rebuild better-sqlite3 --build-from-source --sqlite=/opt/homebrew/opt/sqlcipher

On Intel macOS Homebrew, use /usr/local/opt/sqlcipher.

## Linux

- Install SQLCipher (e.g., apt install sqlcipher libsqlcipher-dev)
- pnpm rebuild better-sqlite3 --build-from-source --sqlite=/usr
- pnpm dlx electron-rebuild -f -w better-sqlite3

## Windows

- Install/build SQLCipher; make headers/libs available to the build environment.
- Rebuild better-sqlite3 in a MSVC Developer Prompt pointing to SQLCipher include/lib dirs.

## Verify

Launch the app and look for: SQLite features shows sqlcipher: true and a cipherVersion.
