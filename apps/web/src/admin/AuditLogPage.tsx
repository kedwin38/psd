import { useEffect, useState } from "react";
import { api } from "../lib/api";

interface AuditEntry {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorId: string | null;
  createdAt: string;
  ip: string | null;
}

export function AuditLogPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [verifyResult, setVerifyResult] = useState<{ valid: boolean; brokenAtId?: string } | null>(null);

  useEffect(() => {
    api.get<{ entries: AuditEntry[] }>("/admin/audit-log").then((r) => setEntries(r.entries));
  }, []);

  const verify = async () => {
    const result = await api.get<{ valid: boolean; brokenAtId?: string }>("/admin/audit-log/verify");
    setVerifyResult(result);
  };

  return (
    <div>
      <div className="row between">
        <div>
          <h1>Audit log</h1>
          <p className="subtitle">Append-only, hash-chained record of security- and business-relevant events (spec §12).</p>
        </div>
        <button onClick={verify}>Verify chain integrity</button>
      </div>
      {verifyResult && (
        <div className={verifyResult.valid ? "success-box" : "error-box"}>
          {verifyResult.valid ? "Chain verified — no tampering detected." : `Chain broken at entry ${verifyResult.brokenAtId}.`}
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Action</th>
            <th>Resource</th>
            <th>Actor</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.createdAt).toLocaleString()}</td>
              <td>{e.action}</td>
              <td className="hint">
                {e.resourceType} {e.resourceId ? `#${e.resourceId.slice(0, 8)}` : ""}
              </td>
              <td className="hint">{e.actorId ? e.actorId.slice(0, 8) : "—"}</td>
              <td className="hint">{e.ip ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
