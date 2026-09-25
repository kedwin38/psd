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

/** Creates an active member account, as signing up does, without enrolling any sign-in credential. */
export async function createMember(email: string, displayName: string): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://psdstudio:psdstudio_dev_pw@localhost:5432/psdstudio" });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (id, email, "displayName", status, "createdAt", "updatedAt") VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', now(), now()) RETURNING id`,
      [email, displayName],
    );
    await client.query('INSERT INTO user_role_assignments (id, "userId", role, "createdAt") VALUES (gen_random_uuid(), $1, $2, now())', [rows[0]!.id, "END_USER"]);
  } finally {
    await client.end();
  }
}

/** [layer path, field type, label] of every field on the template's published version, in the order end users see them. */
export async function publishedFields(template: string): Promise<[string, string, string][]> {
  const client = new Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://psdstudio:psdstudio_dev_pw@localhost:5432/psdstudio" });
  await client.connect();
  try {
    const { rows } = await client.query<{ layerPath: string; fieldType: string; label: string }>(
      `SELECT f."layerPath", f."fieldType", f.label FROM template_fields f JOIN templates t ON t."currentVersionId" = f."templateVersionId" WHERE t.name = $1 ORDER BY f."order"`,
      [template],
    );
    return rows.map((r) => [r.layerPath, r.fieldType, r.label]);
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
      refresh_tokens, webauthn_credentials, totp_credentials, user_role_assignments, app_settings, messages
      RESTART IDENTITY CASCADE`);
  } finally {
    await client.end();
  }
}
