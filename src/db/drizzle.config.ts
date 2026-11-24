import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './migrations/drizzle',
  dialect: 'postgresql',
  schemaFilter: ['public'],
  dbCredentials: {
    host: process.env.SQL_HOST || '127.0.0.1',
    port: Number(process.env.SQL_PORT) || 5432,
    user: process.env.SQL_ADMIN_USER || process.env.SQL_USER || 'postgres',
    password: process.env.SQL_ADMIN_PASSWORD || process.env.SQL_PASSWORD || '',
    database: process.env.SQL_DB_NAME || 'aicliper',
    ssl: false,
  },
  verbose: true,
});
