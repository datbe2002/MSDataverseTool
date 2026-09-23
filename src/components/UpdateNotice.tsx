// Sidebar card shown once a newer version has been downloaded, like Claude
// Desktop's "Relaunch to update".
import { useUpdater } from "../lib/updater";
import { Download, Loader } from "./Icon";

export function UpdateNotice({ collapsed }: { collapsed: boolean }) {
  const status = useUpdater((s) => s.status);
  const version = useUpdater((s) => s.version);
  const error = useUpdater((s) => s.error);
  const install = useUpdater((s) => s.install);
  if (status !== "ready" && status !== "installing") return null;
  const installing = status === "installing";

  if (collapsed) {
    return (
      <div className="px-2.5 pb-2">
        <button
          onClick={install}
          disabled={installing}
          className="btn btn-primary btn-icon relative"
          title={`Hexa Studio ${version} is ready. Click to restart and update.`}
          aria-label={`Restart to update to ${version}`}
        >
          {installing ? <Loader size={14} /> : <Download size={14} />}
        </button>
      </div>
    );
  }

  return (
    <div className="px-2.5 pb-2">
      <div className="rounded-lg border border-brand/30 bg-brand/10 px-2.5 py-2" role="status">
        <div className="text-[12.5px] font-medium">Update ready</div>
        <div className="mt-0.5 text-[11px] leading-snug text-subtle">
          Version {version} is downloaded. Restart to use it — query tabs are kept, results need re-running.
        </div>
        {error && <div className="mt-1 text-[11px] leading-snug text-danger">Couldn't install: {error}</div>}
        <button onClick={install} disabled={installing} className="btn btn-primary btn-sm mt-2 w-full justify-center">
          {installing ? <Loader size={13} /> : null}
          {installing ? "Restarting…" : "Restart to update"}
        </button>
      </div>
    </div>
  );
}
