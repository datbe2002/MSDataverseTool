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
