### What's new in 0.8.0
**REST builder** replaces the FetchXML Builder (Web API › REST builder) — build Dataverse Web API requests with pickers that know your tables, columns, choices and relationships.
- Retrieve, Retrieve multiple (`$select`, `$filter`, `$orderby`, `$expand`, `$top`, `$count`), FetchXML (editor with autocomplete and checks) and functions run in the app: Next page / Load all, grid or JSON, export to CSV / JSON.
- Create, Update, Delete, Associate, Disassociate and actions are generated as code only for now.
- Copy any request as **Xrm.WebApi, fetch, XMLHttpRequest, raw HTTP, C# (HttpClient)** or the Power Automate Dataverse action to use. Old FetchXML tabs open in the REST builder.

**Desktop flows** (Power Automate › Desktop flows, read only) — the RPA flows of an environment (drafts too) with their inputs and outputs, their runs with the error, inputs and outputs of each, and the machines and machine groups that run them (last heartbeat, agent version).

**Flows**
- **Analysis** — a new tab that grades the flow A–F (speed, resources, reliability, security), estimates the actions per run and lists findings with how to fix them. A finding's step opens in the Designer. Rules from Cloud Flow Analyzer (MIT).
- Drag the edge of the flow list to resize it; fold the flow details down to the title row; **full screen** designer (Esc leaves). Expand all / Collapse all fit the view again.
- Flow runs: the app now says when your account can't read every run.

**Flow tasks**
- **Deploy** a reviewed version — or an earlier one, to revert — back to the environment. Only to connections tagged **DEV**, only unmanaged flows in a solution, and only when the cloud still holds the baseline; what was there is kept as an earlier baseline.
- Compare: step details below the canvases; the JSON diff ignores key order.

**Also**
- Web resources: Client API IntelliSense (`Xrm.*`) when editing JavaScript.
- A setup guide on first start; round checkboxes across the app.

### What's new in 0.7.0
**Flow tasks** (Power Automate › Tasks) — keep only the flows of an assigned task in a folder of their own, let someone (or Claude) edit them there, and see exactly what changed before anything goes back.
- **New task** — pick where its folder goes; add flows from the task or with **Add to task** on any flow in Flows. Each flow is read from the environment as its baseline. The folder gets a CLAUDE.md with the task and the rules for editing flow definitions, and a git history when git is installed.
- **Compare** the original, the edited file, the cloud now and earlier versions — as a JSON diff, or **Visual**: both versions drawn like the designer with added, removed, changed and moved steps marked. Pick a step to see what changed in it value by value, or its Parameters / Settings / Data as in the designer.
- **Checks** on the edited file: actions or variables that don't exist, broken runAfter, connection references, child flows.
- Warns when the flow was changed in the cloud meanwhile; **Update baseline from cloud** keeps your edits or takes the cloud version.
- **Mark reviewed** — cleared again when the file changes.
- Fixed: steps of flows saved by the new designer ("SUCCEEDED") no longer show a "runs if" warning edge.

### What's new in 0.6.0
**Flow run history** (cloud flows in a solution, from Dataverse — kept 28 days by default)
- **Flows › Runs** — a new tab on every flow: its runs newest first, filtered by time range and status. Open a run to see when it ran, how long it took and its full error.
  - **Find the parent of a failed child flow**: a child flow's run shows the run that started it — **Go to parent run** opens it, and you can keep climbing when the parent is a child too. A parent run lists the child runs it started.
- **Monitoring › Flow runs** — how many runs failed in the last hour, 24 hours, 7 days or 28 days: runs, failures, success rate and failing flows, runs per hour / day, flows ranked by failures, and the most recent failures.
- The flow list shows each flow's failure count once Flow runs has counted them.
- Needs read access to the Flow Run table (prvReadflowrun); without it the app says so.

### What's new in 0.5.0
**Customization** (new sidebar group)
- **Web resources** — every JavaScript, HTML, CSS, image… web resource in the environment, as a folder tree (Microsoft's are hidden unless you ask). See the published and the unpublished content, and where each one is used (forms, ribbons, other web resources).
  - Press **Edit** to change it in the editor. Before anything is written you **review the changes as a diff**; then **Save** (Ctrl+S) or **Save & publish** (Ctrl+Shift+S), or **Publish all** at once.
  - **Compare** your edit with the latest saved version, or the unpublished version with the published one, **replace from a file**, **download**, open it in the browser, create a **new** one, or **delete** it (after checking what still uses it).
  - If someone else saved the same web resource meanwhile, saving stops and shows you both versions. Web resources that can't be customized open read only, with a warning.
- Jump to a web resource from the command palette (Ctrl+K) or from Dependencies.

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
