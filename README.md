# Hexa Studio

A modern, friendly desktop toolkit for **Power Platform / Dataverse**:

- **SQL** — run SQL against your environments (think of a cleaner, lighter take
  on the "SQL 4 CDS" tool from XrmToolBox).
- **Flows** — browse the Power Automate cloud flows of an environment, read
  their definition as JSON or as a designer-style diagram, see child flows and
  where each variable is set and read.

## Download

Download page: **https://datbe2002.github.io/MSDataverseTool/**

Or get the latest **`Hexa.Studio_*_x64-setup.exe`** from the
[Releases page](https://github.com/datbe2002/MSDataverseTool/releases/latest)
and run it. It installs for your Windows user only (no admin rights).

> The app isn't code-signed yet, so Windows may show **"Windows protected your
> PC"**: click **More info → Run anyway**.

Needs Windows 10/11 (64-bit); WebView2 is installed automatically if missing.
The [ODBC Driver 17 for SQL Server](https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server)
is only needed for the TDS endpoint and for INSERT / UPDATE / DELETE.

## Features

- ⚡ **Tauri + React** — a small, fast native desktop app (not an Electron
  behemoth).
- 🔐 **Sign in with Microsoft** — interactive OAuth2 (authorization code + PKCE)
  via the system browser. No passwords are stored; the refresh token lives in
  the Windows Credential Manager.
- 🗂️ **Projects** — one project per tenant/customer (Contoso, Fabrikam, …). Each keeps
  its own Microsoft sign-in and its own environments, so several tenants stay
  connected at the same time; switch between them from the top bar.
- 🌐 **Environment discovery** — lists every Power Platform environment the
  project's account can reach (Global Discovery Service), or add one by URL.
- 🧮 **SQL editor** — Monaco editor (the VS Code engine) with a results grid,
  row/column inspection, and copy-as-CSV / copy-as-JSON.
- 🗄️ **SQL engine** — `SELECT` runs through a built-in FetchXML engine by
  default (reads every table, in parallel for large ones); statements it can't
  plan fall back to the Dataverse **TDS endpoint** (`<org>.crm.dynamics.com:5558`),
  which can also be forced in Settings.
- 🔁 **Flows** — every cloud flow of an environment with filters by owner,
  solution and status; a JSON view with an outline, and a read-only designer
  with a step panel (inputs, expressions, variables, child flows) and search.

## Prerequisites

- **Node.js** 18+
- **Rust** (stable, MSVC toolchain) + **Visual Studio C++ build tools**
- **WebView2** runtime (ships with Windows 11)
- For TDS queries, the target environment must have the **TDS (SQL) endpoint
  enabled** (Power Platform Admin Center → Environment → Settings → Product →
  Features → *Enable TDS endpoint*).

## Develop

```bash
npm install
npm run tauri dev
```

## Build a release bundle

```bash
npm run tauri build
```

The installer / executable lands in `src-tauri/target/release/`.

## Release

Pushing a version tag builds the Windows installer on GitHub Actions and
publishes it on the Releases page (`.github/workflows/release.yml`):

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and
   `src-tauri/tauri.conf.json`, and commit.
2. `git tag v0.2.0 && git push origin v0.2.0`

## How it works

1. **Sign in** acquires a token for the Global Discovery Service and lists your
   environments.
2. Picking an environment (or adding one by URL) saves a **connection**.
3. Running a query acquires a Dataverse access token for that org (silently via
   the refresh token, or interactively the first time) and opens a TDS
   connection with that token as the credential.

### Authentication notes

The default Azure AD client is a well-known public client that supports the
loopback sign-in flow. If your tenant blocks it, register your own **public
client** app registration with redirect URI `http://localhost` and paste its
client ID under **Settings**.

### Writing data (INSERT / UPDATE / DELETE)

The TDS endpoint itself is read-only, so write statements are translated the
way SQL 4 CDS does it:

1. A `SELECT` over TDS finds the affected rows and evaluates the new values
   (so `SET fullname = firstname + ' ' + lastname` works).
2. The app shows how many records will change and asks for confirmation.
3. Each row becomes a Web API request (`PATCH` / `DELETE` / `POST`), 8 in
   parallel. Plugins and workflows run as usual.

Supported: `UPDATE t SET ... [FROM ... JOIN ...] [WHERE ...]`,
`DELETE [FROM] t [WHERE ...]`, `INSERT INTO t (cols) VALUES (...), (...)` and
`INSERT INTO t (cols) SELECT ...`. Lookups accept a GUID, including customer and
owner lookups. Not supported yet: `TOP (n)` in writes, multi-select choices,
file/image columns, more than 100,000 rows.

### Limitations

- `SELECT` results are capped at 50,000 rows per query.
