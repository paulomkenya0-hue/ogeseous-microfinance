#!/usr/bin/env node
/**
 * Run a multi-statement .sql file against a Postgres database.
 *
 *   SUPABASE_DB_URL=postgresql://... node scripts/run-sql.cjs path/to/file.sql
 *
 * or, when the password contains URL-reserved characters:
 *
 *   SUPABASE_DB_HOST=... SUPABASE_DB_USER=... SUPABASE_DB_PASSWORD=... \
 *     node scripts/run-sql.cjs path/to/file.sql
 *
 * Used for supabase/verify_migrations.sql, which the Supabase CLI's `db query`
 * cannot execute because it sends the file as one prepared statement.
 */
const fs = require('node:fs')
const { Client } = require('pg')

const file = process.argv[2]
const url = process.env.SUPABASE_DB_URL
const host = process.env.SUPABASE_DB_HOST
const hasParts = host && process.env.SUPABASE_DB_USER

if (!file || (!url && !hasParts)) {
  console.error(
    'Usage: SUPABASE_DB_URL=postgresql://... node scripts/run-sql.cjs <file.sql>\n' +
      '   or: SUPABASE_DB_HOST=... SUPABASE_DB_USER=... SUPABASE_DB_PASSWORD=... node scripts/run-sql.cjs <file.sql>',
  )
  process.exit(2)
}

const client = new Client(
  hasParts
    ? {
        host,
        port: Number(process.env.SUPABASE_DB_PORT ?? 5432),
        user: process.env.SUPABASE_DB_USER,
        password: process.env.SUPABASE_DB_PASSWORD,
        database: process.env.SUPABASE_DB_NAME ?? 'postgres',
        ssl: { rejectUnauthorized: false },
      }
    : {
        connectionString: url,
        ssl: { rejectUnauthorized: false },
      },
)

/**
 * Split on top-level semicolons, ignoring semicolons inside strings, quoted
 * identifiers, comments and dollar-quoted function bodies.
 */
function splitSql(sql) {
  const statements = []
  let start = 0
  let i = 0
  let state = 'normal'
  let dollarTag = ''

  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (state === 'normal') {
      if (ch === '-' && next === '-') {
        state = 'lineComment'
        i += 2
      } else if (ch === '/' && next === '*') {
        state = 'blockComment'
        i += 2
      } else if (ch === "'") {
        state = 'single'
        i += 1
      } else if (ch === '"') {
        state = 'double'
        i += 1
      } else if (ch === '$') {
        const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)
        if (match) {
          dollarTag = match[0]
          state = 'dollar'
          i += dollarTag.length
        } else {
          i += 1
        }
      } else if (ch === ';') {
        statements.push(sql.slice(start, i + 1))
        start = i + 1
        i += 1
      } else {
        i += 1
      }
    } else if (state === 'lineComment') {
      if (ch === '\n') state = 'normal'
      i += 1
    } else if (state === 'blockComment') {
      if (ch === '*' && next === '/') {
        state = 'normal'
        i += 2
      } else {
        i += 1
      }
    } else if (state === 'single') {
      if (ch === "'" && next === "'") i += 2
      else {
        if (ch === "'") state = 'normal'
        i += 1
      }
    } else if (state === 'double') {
      if (ch === '"' && next === '"') i += 2
      else {
        if (ch === '"') state = 'normal'
        i += 1
      }
    } else if (state === 'dollar') {
      if (sql.startsWith(dollarTag, i)) {
        state = 'normal'
        i += dollarTag.length
      } else {
        i += 1
      }
    }
  }

  if (start < sql.length) statements.push(sql.slice(start))
  return statements.map((s) => s.trim()).filter(Boolean)
}

function hasSql(sql) {
  // Remove comments and whitespace; a statement that is only comments is a no-op.
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim().length > 0
}

;(async () => {
  await client.connect()
  const sql = fs.readFileSync(file, 'utf8')
  const statements = splitSql(sql).filter(hasSql)
  let failed = 0

  try {
    for (let index = 0; index < statements.length; index += 1) {
      const statement = statements[index]
      try {
        const result = await client.query(statement)
        const sets = Array.isArray(result) ? result : [result]
        for (const set of sets) {
          if (set.rows?.length) {
            console.table(set.rows)
          } else if (set.command) {
            console.log(`${set.command}${set.rowCount == null ? '' : ` ${set.rowCount}`}`)
          }
        }
      } catch (err) {
        failed += 1
        const preview = statement.replace(/\s+/g, ' ').slice(0, 180)
        console.error(`\nFAILED statement ${index + 1}/${statements.length}: ${err.message}`)
        console.error(`  ${preview}`)
        if (process.env.RUN_SQL_STOP !== '0') break
      }
    }
  } finally {
    await client.end()
  }

  if (failed) process.exit(1)
})().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
