### What's new in 0.4.0
**Monitoring** (new sidebar group, read only)
- **Plug-in traces** — the plug-in trace log, newest first: filter by time, class, message, table, sync/async, exceptions only, text in the trace, slow runs. Read the trace and the exception side by side, and follow one execution chain.
- **System jobs** — async plug-ins, workflows, bulk deletes, imports…: filter by status and type, see why a job failed or what it's waiting for, open the record it was about, and jump between a job and its plug-in traces.

**Configuration** (new sidebar group, read only)
- **Plug-in steps** — assemblies, classes, steps and images, by assembly or by table in the order the steps run. Opens fast and loads the rest as you open it; Microsoft's assemblies are hidden unless you ask.
- **Dependencies** — what uses a table or a column before you delete it: forms, views, processes, apps… plus the plug-in steps and cloud flows that mention it.
- **Security** — a user's roles (their own and their teams'), what they can do on each table, and why they can or can't open a given record. Compare two roles side by side.

**Everywhere**
- **Command palette** — press **Ctrl+K** (or Ctrl+P) to jump to any view, table, flow or past query, switch environment, or run an action.
- **Settings** are now a proper settings page: theme, shortcuts, query engine, sign-in and accounts, updates.

### What's new in 0.3.1
- **Updates download much faster.** The app used to pass every few kilobytes of the installer to the window one by one, so a download of about 15 MB took far longer than it should. Updating *to* 0.3.1 still uses the old way; the updates after it will be fast.

### What's new in 0.3.0
- **FetchXML Builder** — a new tool in the sidebar (FetchXML → Builder):
  - Write FetchXML with autocomplete for tables, columns, operators and choice values — or build it with a **tree + properties panel** (column pickers, joins from the table's relationships, conditions with operators that fit the column).
  - **Checks** the query against the environment's tables and columns before it runs (missing columns, wrong operators, aggregate rules, …).
  - Results grid with **Formatted / Raw / JSON** values, **Next page / Load all**, **Count rows** (without reading them), and **Export** to CSV / JSON.
  - Open **system and personal views** (read only) and **.xml files**; several tabs per environment.
- An expired sign-in now asks once to sign in again and then retries what you were doing.

### Download
Download **`Hexa.Studio_*_x64-setup.exe`** below and run it — it installs for your user only, no admin rights needed.

Windows may show **"Windows protected your PC"** because the app isn't code-signed yet: click **More info → Run anyway**.

Already on 0.2.0 or later? The app updates itself — look for **Restart to update** in the sidebar.

### Requirements
- Windows 10/11 (64-bit). WebView2 is installed automatically if missing.
- A Dataverse account for the environments you want to open.
- Only for the TDS endpoint and for INSERT / UPDATE / DELETE: [ODBC Driver 17 for SQL Server](https://learn.microsoft.com/sql/connect/odbc/download-odbc-driver-for-sql-server).
