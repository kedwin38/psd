import { Client } from "pg";

/**
 * Grants a role directly via SQL. There is no API endpoint for this on
 * purpose (spec §12 RBAC) — the very first platform admin has to be
 * bootstrapped out-of-band by whoever operates the database, same as this
 * test does.
 */
export async function grantRole(email: string, role: string): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://psdstudio:psdstudio_dev_pw@localhost:5432/psdstudio" });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    if (rows.length === 0) throw new Error(`No user found for ${email}`);
    await client.query(
      'INSERT INTO user_role_assignments (id, "userId", role, "createdAt") VALUES (gen_random_uuid(), $1, $2, now())',
      [rows[0]!.id, role],
    );
  } finally {
    await client.end();
  }
}

export async function resetDatabase(): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://psdstudio:psdstudio_dev_pw@localhost:5432/psdstudio" });
  await client.connect();
  try {
    await client.query(`TRUNCATE TABLE
      users, organizations, template_categories, templates, template_versions,
      template_fields, assets, projects, export_jobs, audit_log_entries,
      refresh_tokens, webauthn_credentials, totp_credentials, user_role_assignments
      RESTART IDENTITY CASCADE`);
  } finally {
    await client.end();
  }
}
