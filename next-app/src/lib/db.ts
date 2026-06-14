import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let _sql: NeonQueryFunction<any, any> | null = null;
let _initialized = false;

function getSql() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL environment variable is not set");
    _sql = neon(url);
  }
  return _sql;
}

async function ensureTables() {
  if (_initialized) return;
  _initialized = true;
  const sql = getSql();
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        image_hash TEXT,
        hazard_detected INTEGER DEFAULT 0,
        risk_level TEXT,
        confidence REAL,
        possible_location TEXT,
        country TEXT, state TEXT, district TEXT, area TEXT,
        latitude REAL, longitude REAL,
        formatted_address TEXT,
        entities TEXT,
        recommended_actions TEXT,
        whatsapp_attempted INTEGER DEFAULT 0,
        whatsapp_sent INTEGER DEFAULT 0,
        whatsapp_reason TEXT DEFAULT 'not_requested',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS locations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        collection_frequency TEXT NOT NULL DEFAULT 'weekly',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS dataset_images (
        id TEXT PRIMARY KEY,
        location_id TEXT NOT NULL REFERENCES locations(id),
        r2_key TEXT NOT NULL DEFAULT '',
        street_view_url TEXT,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        collected_at TIMESTAMPTZ DEFAULT NOW(),
        analyzed_at TIMESTAMPTZ,
        gemini_response JSONB,
        error TEXT
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_incidents_session ON incidents(session_id, created_at)
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_dataset_images_location ON dataset_images(location_id, collected_at)
    `;
  } catch (err) {
    _initialized = false;
    throw err;
  }
}

export function sql(strings: TemplateStringsArray, ...params: any[]) {
  return (async () => {
    await ensureTables();
    return getSql()(strings, ...params) as Promise<any[]>;
  })();
}
